#[cfg(unix)]
mod native {
    #[cfg(test)]
    use std::cell::RefCell;
    use std::{
        ffi::{CString, OsStr},
        fs::{self, File},
        io::{ErrorKind, Read, Write},
        os::{
            fd::{AsRawFd, FromRawFd, OwnedFd},
            unix::ffi::OsStrExt,
        },
        path::Path,
        sync::atomic::{AtomicU64, Ordering},
    };

    static TEMPORARY_SEQUENCE: AtomicU64 = AtomicU64::new(1);

    #[cfg(test)]
    thread_local! {
        static INJECTED_SYNC_FAILURES: RefCell<Vec<((u64, u64), &'static str)>> =
            const { RefCell::new(Vec::new()) };
    }

    #[cfg(test)]
    pub(crate) fn inject_sync_failures(failures: Vec<((u64, u64), &'static str)>) {
        INJECTED_SYNC_FAILURES.with(|configured| *configured.borrow_mut() = failures);
    }

    #[cfg(test)]
    pub(crate) fn clear_sync_failures() {
        INJECTED_SYNC_FAILURES.with(|configured| configured.borrow_mut().clear());
    }

    pub(crate) struct RootDirectory {
        descriptor: OwnedFd,
    }

    struct ParentDirectory {
        chain: Vec<OwnedFd>,
        name: CString,
    }

    impl ParentDirectory {
        fn leaf(&self) -> &OwnedFd {
            self.chain.last().expect("directory chain contains root")
        }

        fn sync_chain(&self) -> Result<(), String> {
            for directory in self.chain.iter().rev() {
                sync_directory(directory)?;
            }
            Ok(())
        }
    }

    impl RootDirectory {
        pub(crate) fn open(path: &Path) -> Result<Self, String> {
            let canonical = fs::canonicalize(path)
                .map_err(|error| format!("Result root does not exist: {error}"))?;
            let name = CString::new(canonical.as_os_str().as_bytes())
                .map_err(|_| "Result root contains a null byte".to_string())?;
            // SAFETY: name is nul-terminated. A successful call returns a new descriptor.
            let fd = unsafe {
                libc::open(
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                )
            };
            if fd < 0 {
                return Err(format!(
                    "Result root cannot be opened safely: {}",
                    std::io::Error::last_os_error()
                ));
            }
            // SAFETY: fd was freshly returned and is uniquely owned.
            let descriptor = unsafe { OwnedFd::from_raw_fd(fd) };
            Ok(Self { descriptor })
        }

        pub(crate) fn read(&self, components: &[&str], limit: usize) -> Result<Vec<u8>, String> {
            let parent = self.parent_directory(components, false)?;
            let bytes = read_file_at(parent.leaf(), &parent.name, limit)?;
            parent.sync_chain()?;
            Ok(bytes)
        }

        /// Only ENOENT means absence. Unsafe paths and other I/O failures must
        /// remain errors, including a dangling symlink at the final component.
        pub(crate) fn contains_regular_file(&self, components: &[&str]) -> Result<bool, String> {
            let (name, parents) = components.split_last().ok_or("Result path is empty")?;
            let mut directory = self.descriptor.try_clone().map_err(|e| e.to_string())?;
            for component in parents {
                directory = match open_directory_at(&directory, &component_name(component)?) {
                    Ok(next) => next,
                    Err(e) if e.kind() == ErrorKind::NotFound => return Ok(false),
                    Err(e) => {
                        return Err(format!("Result directory cannot be inspected safely: {e}"))
                    }
                };
            }
            let name = component_name(name)?;
            let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
            // SAFETY: parent descriptor is held, name is validated and output
            // storage is valid. AT_SYMLINK_NOFOLLOW never follows the leaf.
            if unsafe {
                libc::fstatat(
                    directory.as_raw_fd(),
                    name.as_ptr(),
                    metadata.as_mut_ptr(),
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            } != 0
            {
                let e = std::io::Error::last_os_error();
                return if e.kind() == ErrorKind::NotFound {
                    Ok(false)
                } else {
                    Err(format!("Result manifest cannot be inspected: {e}"))
                };
            }
            // SAFETY: successful fstatat initialized metadata.
            if unsafe { metadata.assume_init() }.st_mode & libc::S_IFMT != libc::S_IFREG {
                return Err("Result manifest is not a regular file".into());
            }
            Ok(true)
        }

        pub(crate) fn write_immutable(
            &self,
            components: &[&str],
            contents: &[u8],
        ) -> Result<(), String> {
            let parent = self.parent_directory(components, true)?;
            let directory = parent.leaf();
            let temporary_name = CString::new(format!(
                ".result-{}-{}.tmp",
                std::process::id(),
                TEMPORARY_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ))
            .expect("generated temporary name is valid");
            // SAFETY: directory and temporary_name are valid. O_EXCL creates a new inode.
            let temporary_fd = unsafe {
                libc::openat(
                    directory.as_raw_fd(),
                    temporary_name.as_ptr(),
                    libc::O_WRONLY
                        | libc::O_CREAT
                        | libc::O_EXCL
                        | libc::O_CLOEXEC
                        | libc::O_NOFOLLOW,
                    0o600,
                )
            };
            if temporary_fd < 0 {
                return Err(format!(
                    "Result temporary file cannot be created: {}",
                    std::io::Error::last_os_error()
                ));
            }
            // SAFETY: temporary_fd was freshly returned and is uniquely owned by File.
            let mut temporary = unsafe { File::from_raw_fd(temporary_fd) };

            let result = (|| {
                temporary
                    .write_all(contents)
                    .map_err(|error| format!("Result file write failed: {error}"))?;
                sync_descriptor(temporary.as_raw_fd(), "Result file")?;
                // SAFETY: both names are valid and relative to the held parent descriptor.
                if unsafe {
                    libc::linkat(
                        directory.as_raw_fd(),
                        temporary_name.as_ptr(),
                        directory.as_raw_fd(),
                        parent.name.as_ptr(),
                        0,
                    )
                } != 0
                {
                    let error = std::io::Error::last_os_error();
                    if error.kind() != ErrorKind::AlreadyExists {
                        return Err(format!("Immutable result commit failed: {error}"));
                    }
                    let existing = read_file_at(directory, &parent.name, contents.len())?;
                    if existing != contents {
                        return Err(
                            "Immutable result already exists with different contents".into()
                        );
                    }
                }
                // SAFETY: remove only the uniquely named temporary link created by this call.
                if unsafe { libc::unlinkat(directory.as_raw_fd(), temporary_name.as_ptr(), 0) } != 0
                {
                    return Err(format!(
                        "Result temporary link cleanup failed: {}",
                        std::io::Error::last_os_error()
                    ));
                }
                parent.sync_chain()
            })();

            if result.is_err() {
                // SAFETY: best-effort cleanup targets only this call's unique temporary name.
                unsafe {
                    libc::unlinkat(directory.as_raw_fd(), temporary_name.as_ptr(), 0);
                }
            }
            result
        }

        fn parent_directory(
            &self,
            components: &[&str],
            create: bool,
        ) -> Result<ParentDirectory, String> {
            let (final_name, parents) = components
                .split_last()
                .ok_or_else(|| "Result path is empty".to_string())?;
            let root = self
                .descriptor
                .try_clone()
                .map_err(|error| format!("Result root descriptor cannot be cloned: {error}"))?;
            let mut chain = vec![root];
            for component in parents {
                let name = component_name(component)?;
                let directory = chain.last().expect("directory chain contains root");
                let next = match open_directory_at(directory, &name) {
                    Ok(next) => next,
                    Err(error) if create && error.kind() == ErrorKind::NotFound => {
                        // SAFETY: mkdirat creates one component and never follows its final name.
                        let created =
                            unsafe { libc::mkdirat(directory.as_raw_fd(), name.as_ptr(), 0o700) };
                        if created != 0 {
                            let create_error = std::io::Error::last_os_error();
                            if create_error.kind() != ErrorKind::AlreadyExists {
                                return Err(format!(
                                    "Result directory cannot be created: {create_error}"
                                ));
                            }
                        } else {
                            sync_directory(&directory)?;
                        }
                        open_directory_at(directory, &name).map_err(|error| {
                            format!("Result directory cannot be opened safely: {error}")
                        })?
                    }
                    Err(error) => {
                        return Err(format!(
                            "Result path contains a symbolic link or non-directory: {error}"
                        ))
                    }
                };
                chain.push(next);
            }
            Ok(ParentDirectory {
                chain,
                name: component_name(final_name)?,
            })
        }
    }

    fn component_name(value: impl AsRef<OsStr>) -> Result<CString, String> {
        let value = value.as_ref();
        if value.is_empty() || value.as_bytes().contains(&b'/') {
            return Err("Invalid result path component".into());
        }
        CString::new(value.as_bytes()).map_err(|_| "Invalid result path component".into())
    }

    fn open_directory_at(directory: &OwnedFd, name: &CString) -> std::io::Result<OwnedFd> {
        // SAFETY: directory is held and name is nul-terminated. A success returns a new fd.
        let fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if fd < 0 {
            Err(std::io::Error::last_os_error())
        } else {
            // SAFETY: fd was freshly returned and is uniquely owned.
            Ok(unsafe { OwnedFd::from_raw_fd(fd) })
        }
    }

    fn read_file_at(directory: &OwnedFd, name: &CString, limit: usize) -> Result<Vec<u8>, String> {
        // SAFETY: directory is held and name is nul-terminated. O_NONBLOCK prevents FIFO hangs.
        let fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
            )
        };
        if fd < 0 {
            return Err(format!(
                "Result file cannot be opened safely: {}",
                std::io::Error::last_os_error()
            ));
        }
        // SAFETY: fd was freshly returned and is uniquely owned by File.
        let file = unsafe { File::from_raw_fd(fd) };
        let metadata = file
            .metadata()
            .map_err(|error| format!("Result file metadata cannot be read: {error}"))?;
        if !metadata.is_file() {
            return Err("Result path is not a regular file".into());
        }
        if metadata.len() > limit as u64 {
            return Err(format!("Result file exceeds {limit} bytes"));
        }
        let expected = usize::try_from(metadata.len())
            .map_err(|_| "Result file length cannot be represented".to_string())?;
        let mut bytes = Vec::with_capacity(expected);
        (&file)
            .take(limit as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("Result file cannot be read: {error}"))?;
        if bytes.len() > limit || bytes.len() != expected {
            return Err("Result file changed while it was read".into());
        }
        sync_descriptor(file.as_raw_fd(), "Result file")?;
        Ok(bytes)
    }

    fn sync_directory(directory: &OwnedFd) -> Result<(), String> {
        sync_descriptor(directory.as_raw_fd(), "Result directory")
    }

    fn sync_descriptor(descriptor: i32, subject: &str) -> Result<(), String> {
        #[cfg(test)]
        {
            let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
            // SAFETY: descriptor is held live and successful fstat initializes metadata.
            if unsafe { libc::fstat(descriptor, metadata.as_mut_ptr()) } == 0 {
                // SAFETY: successful fstat initialized metadata.
                let metadata = unsafe { metadata.assume_init() };
                let identity = (metadata.st_dev as u64, metadata.st_ino as u64);
                if let Some(label) = INJECTED_SYNC_FAILURES.with(|configured| {
                    configured
                        .borrow()
                        .iter()
                        .find_map(|(candidate, label)| (*candidate == identity).then_some(*label))
                }) {
                    return Err(format!("Injected sync failure for {label}"));
                }
            }
        }
        // SAFETY: fsync accepts this live directory descriptor.
        if unsafe { libc::fsync(descriptor) } == 0 {
            Ok(())
        } else {
            Err(format!(
                "{subject} sync failed: {}",
                std::io::Error::last_os_error()
            ))
        }
    }
}

#[cfg(unix)]
pub(super) use native::RootDirectory;

#[cfg(all(test, unix))]
pub(super) use native::{clear_sync_failures, inject_sync_failures};

#[cfg(not(unix))]
pub(super) struct RootDirectory;

#[cfg(not(unix))]
impl RootDirectory {
    pub(super) fn open(_path: &std::path::Path) -> Result<Self, String> {
        Err("Result vault requires descriptor-relative filesystem support".into())
    }

    pub(super) fn read(&self, _components: &[&str], _limit: usize) -> Result<Vec<u8>, String> {
        Err("Result vault requires descriptor-relative filesystem support".into())
    }

    pub(super) fn contains_regular_file(&self, _components: &[&str]) -> Result<bool, String> {
        Err("Result vault requires descriptor-relative filesystem support".into())
    }

    pub(super) fn write_immutable(
        &self,
        _components: &[&str],
        _contents: &[u8],
    ) -> Result<(), String> {
        Err("Result vault requires descriptor-relative filesystem support".into())
    }
}

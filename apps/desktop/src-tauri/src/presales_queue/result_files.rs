#[cfg(unix)]
mod native {
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

    pub(crate) struct RootDirectory {
        descriptor: OwnedFd,
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
            let (directory, name) = self.parent_directory(components, false)?;
            read_file_at(&directory, &name, limit)
        }

        pub(crate) fn write_immutable(
            &self,
            components: &[&str],
            contents: &[u8],
        ) -> Result<(), String> {
            let (directory, name) = self.parent_directory(components, true)?;
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
                temporary
                    .sync_all()
                    .map_err(|error| format!("Result file sync failed: {error}"))?;
                // SAFETY: both names are valid and relative to the held parent descriptor.
                if unsafe {
                    libc::linkat(
                        directory.as_raw_fd(),
                        temporary_name.as_ptr(),
                        directory.as_raw_fd(),
                        name.as_ptr(),
                        0,
                    )
                } != 0
                {
                    let error = std::io::Error::last_os_error();
                    if error.kind() != ErrorKind::AlreadyExists {
                        return Err(format!("Immutable result commit failed: {error}"));
                    }
                    let existing = read_file_at(&directory, &name, contents.len())?;
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
                sync_directory(&directory)
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
        ) -> Result<(OwnedFd, CString), String> {
            let (final_name, parents) = components
                .split_last()
                .ok_or_else(|| "Result path is empty".to_string())?;
            let mut directory = self
                .descriptor
                .try_clone()
                .map_err(|error| format!("Result root descriptor cannot be cloned: {error}"))?;
            for component in parents {
                let name = component_name(component)?;
                match open_directory_at(&directory, &name) {
                    Ok(next) => directory = next,
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
                        directory = open_directory_at(&directory, &name).map_err(|error| {
                            format!("Result directory cannot be opened safely: {error}")
                        })?;
                    }
                    Err(error) => {
                        return Err(format!(
                            "Result path contains a symbolic link or non-directory: {error}"
                        ))
                    }
                }
            }
            Ok((directory, component_name(final_name)?))
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
        file.sync_all()
            .map_err(|error| format!("Result file sync failed: {error}"))?;
        Ok(bytes)
    }

    fn sync_directory(directory: &OwnedFd) -> Result<(), String> {
        // SAFETY: fsync accepts this live directory descriptor.
        if unsafe { libc::fsync(directory.as_raw_fd()) } == 0 {
            Ok(())
        } else {
            Err(format!(
                "Result directory sync failed: {}",
                std::io::Error::last_os_error()
            ))
        }
    }
}

#[cfg(unix)]
pub(super) use native::RootDirectory;

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

    pub(super) fn write_immutable(
        &self,
        _components: &[&str],
        _contents: &[u8],
    ) -> Result<(), String> {
        Err("Result vault requires descriptor-relative filesystem support".into())
    }
}

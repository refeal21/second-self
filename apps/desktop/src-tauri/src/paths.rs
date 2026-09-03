use std::{
    fs,
    io::ErrorKind,
    path::{Component, Path, PathBuf},
};

pub fn default_workspace(home_directory: &Path) -> PathBuf {
    home_directory
        .join("Documents")
        .join("DigitalTwinWorkspace")
}

pub fn resolve_workspace_write_path(
    workspace_root: &Path,
    candidate: &Path,
) -> Result<PathBuf, String> {
    let workspace = fs::canonicalize(workspace_root)
        .map_err(|_| "Workspace root does not exist".to_string())?;
    let mut current = if candidate.is_absolute() {
        PathBuf::new()
    } else {
        workspace.clone()
    };
    let mut entered_workspace = !candidate.is_absolute();

    for component in candidate.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                current.pop();
            }
            Component::RootDir => current.push(component.as_os_str()),
            Component::Prefix(prefix) => current.push(prefix.as_os_str()),
            Component::Normal(name) => {
                current.push(name);
                current = resolve_existing_symlink(current)?;
            }
        }

        if current.starts_with(&workspace) {
            entered_workspace = true;
        }

        if entered_workspace && !current.starts_with(&workspace) {
            return Err("Write path is outside the workspace".to_string());
        }
    }

    current
        .starts_with(&workspace)
        .then_some(current)
        .ok_or_else(|| "Write path is outside the workspace".to_string())
}

fn resolve_existing_symlink(path: PathBuf) -> Result<PathBuf, String> {
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            fs::canonicalize(&path).map_err(|_| "Write path cannot be resolved".to_string())
        }
        Ok(_) => Ok(path),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(path),
        Err(_) => Err("Write path cannot be resolved".to_string()),
    }
}

/// Atomically writes a relative workspace artifact while holding directory file
/// descriptors for every parent. A concurrent symlink replacement therefore
/// cannot redirect the final write outside the selected workspace.
pub fn atomic_write_workspace_file(
    workspace_root: &Path,
    candidate: &Path,
    contents: &[u8],
) -> Result<PathBuf, String> {
    let components = strict_relative_components(candidate)?;
    let workspace = fs::canonicalize(workspace_root)
        .map_err(|_| "Workspace root does not exist".to_string())?;

    #[cfg(unix)]
    write_at_workspace_fd(&workspace, &components, contents)?;

    #[cfg(not(unix))]
    {
        use std::io::Write;
        let target = resolve_workspace_write_path(&workspace, candidate)?;
        let parent = target
            .parent()
            .ok_or_else(|| "Write path has no parent".to_string())?;
        fs::create_dir_all(parent).map_err(|error| format!("Write parent failed: {error}"))?;
        let temporary = parent.join(format!(".{}.tmp", std::process::id()));
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("Temporary artifact write failed: {error}"))?;
        file.write_all(contents)
            .map_err(|error| format!("Artifact write failed: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("Artifact sync failed: {error}"))?;
        fs::rename(&temporary, &target)
            .map_err(|error| format!("Artifact commit failed: {error}"))?;
    }

    Ok(workspace.join(candidate))
}

fn strict_relative_components(candidate: &Path) -> Result<Vec<std::ffi::OsString>, String> {
    if candidate.is_absolute() {
        return Err("Write path is outside the workspace".to_string());
    }
    let mut result = Vec::new();
    for component in candidate.components() {
        match component {
            Component::Normal(value) => result.push(value.to_os_string()),
            _ => return Err("Write path is outside the workspace".to_string()),
        }
    }
    if result.is_empty() {
        return Err("Write path is empty".to_string());
    }
    Ok(result)
}

#[cfg(unix)]
fn write_at_workspace_fd(
    workspace: &Path,
    components: &[std::ffi::OsString],
    contents: &[u8],
) -> Result<(), String> {
    use std::{
        ffi::CString,
        io::Write,
        os::{
            fd::{AsRawFd, FromRawFd, OwnedFd},
            unix::ffi::OsStrExt,
        },
        sync::atomic::{AtomicU64, Ordering},
    };

    static TEMPORARY_SEQUENCE: AtomicU64 = AtomicU64::new(1);

    fn c_name(value: &std::ffi::OsStr) -> Result<CString, String> {
        CString::new(value.as_bytes())
            .map_err(|_| "Write path contains an invalid null byte".to_string())
    }

    fn open_directory_at(parent: i32, name: &CString) -> Result<OwnedFd, std::io::Error> {
        // SAFETY: name is a valid nul-terminated string and the returned fd is
        // immediately transferred into OwnedFd.
        let fd = unsafe {
            libc::openat(
                parent,
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if fd < 0 {
            Err(std::io::Error::last_os_error())
        } else {
            // SAFETY: fd was freshly returned by openat and is uniquely owned.
            Ok(unsafe { OwnedFd::from_raw_fd(fd) })
        }
    }

    let workspace_name = CString::new(workspace.as_os_str().as_bytes())
        .map_err(|_| "Workspace path contains an invalid null byte".to_string())?;
    // SAFETY: workspace_name is a valid nul-terminated string.
    let root_fd = unsafe {
        libc::open(
            workspace_name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if root_fd < 0 {
        return Err(format!(
            "Workspace root cannot be opened safely: {}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: root_fd is freshly opened and uniquely owned.
    let mut directory = unsafe { OwnedFd::from_raw_fd(root_fd) };

    for component in &components[..components.len() - 1] {
        let name = c_name(component)?;
        match open_directory_at(directory.as_raw_fd(), &name) {
            Ok(next) => directory = next,
            Err(error) if error.kind() == ErrorKind::NotFound => {
                // SAFETY: directory fd and name are valid. mkdirat never follows
                // a final symlink and creates only this single path component.
                let created = unsafe { libc::mkdirat(directory.as_raw_fd(), name.as_ptr(), 0o700) };
                if created != 0 {
                    return Err(format!(
                        "Workspace directory creation failed: {}",
                        std::io::Error::last_os_error()
                    ));
                }
                directory = open_directory_at(directory.as_raw_fd(), &name).map_err(|error| {
                    format!("Workspace directory cannot be opened safely: {error}")
                })?;
            }
            Err(error) => {
                return Err(format!(
                    "Workspace path contains a symbolic link or non-directory: {error}"
                ))
            }
        }
    }

    let target_name = c_name(components.last().expect("non-empty components"))?;
    let temporary_name = CString::new(format!(
        ".digital-twin-{}-{}.tmp",
        std::process::id(),
        TEMPORARY_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ))
    .expect("generated temporary name is valid");
    // SAFETY: the directory fd and temporary name are valid and O_EXCL creates
    // a fresh file owned by this process.
    let temporary_fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            temporary_name.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            0o600,
        )
    };
    if temporary_fd < 0 {
        return Err(format!(
            "Temporary artifact cannot be created: {}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: temporary_fd is freshly opened and uniquely owned by File.
    let mut temporary_file = unsafe { fs::File::from_raw_fd(temporary_fd) };
    let result = (|| {
        temporary_file
            .write_all(contents)
            .map_err(|error| format!("Artifact write failed: {error}"))?;
        temporary_file
            .sync_all()
            .map_err(|error| format!("Artifact sync failed: {error}"))?;
        // SAFETY: both names are valid and relative to the held directory fd.
        let committed = unsafe {
            libc::renameat(
                directory.as_raw_fd(),
                temporary_name.as_ptr(),
                directory.as_raw_fd(),
                target_name.as_ptr(),
            )
        };
        if committed != 0 {
            return Err(format!(
                "Artifact commit failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        // SAFETY: fsync accepts this live directory descriptor.
        if unsafe { libc::fsync(directory.as_raw_fd()) } != 0 {
            return Err(format!(
                "Workspace directory sync failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    })();
    if result.is_err() {
        // SAFETY: best-effort removal of our uniquely named temporary file.
        unsafe {
            libc::unlinkat(directory.as_raw_fd(), temporary_name.as_ptr(), 0);
        }
    }
    result
}

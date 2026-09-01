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

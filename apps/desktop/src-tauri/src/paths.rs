use std::{
    ffi::OsString,
    fs,
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
    let target = if candidate.is_absolute() {
        normalize(candidate)
    } else {
        normalize(&workspace.join(candidate))
    };

    let (existing_ancestor, missing_path) = nearest_existing_ancestor(&target)?;
    let resolved_ancestor = fs::canonicalize(existing_ancestor)
        .map_err(|_| "Write path cannot be resolved".to_string())?;

    if !resolved_ancestor.starts_with(&workspace) {
        return Err("Write path is outside the workspace".to_string());
    }

    let resolved_target = missing_path
        .iter()
        .rev()
        .fold(resolved_ancestor, |path, component| path.join(component));

    if resolved_target.starts_with(&workspace) {
        Ok(resolved_target)
    } else {
        Err("Write path is outside the workspace".to_string())
    }
}

fn nearest_existing_ancestor(path: &Path) -> Result<(&Path, Vec<OsString>), String> {
    let mut current = path;
    let mut missing_path = Vec::new();

    while !current.exists() {
        let name = current
            .file_name()
            .ok_or_else(|| "Write path cannot be resolved".to_string())?;
        missing_path.push(name.to_os_string());
        current = current
            .parent()
            .ok_or_else(|| "Write path cannot be resolved".to_string())?;
    }

    Ok((current, missing_path))
}

fn normalize(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            _ => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

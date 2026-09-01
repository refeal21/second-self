use std::path::{Component, Path, PathBuf};

pub fn default_workspace(home_directory: &Path) -> PathBuf {
    home_directory
        .join("Documents")
        .join("DigitalTwinWorkspace")
}

pub fn resolve_workspace_write_path(
    workspace_root: &Path,
    candidate: &Path,
) -> Result<PathBuf, String> {
    let workspace = normalize(workspace_root);
    let target = if candidate.is_absolute() {
        normalize(candidate)
    } else {
        normalize(&workspace.join(candidate))
    };

    if target.starts_with(&workspace) {
        Ok(target)
    } else {
        Err("Write path is outside the workspace".to_string())
    }
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

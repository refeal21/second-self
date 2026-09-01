use std::{
    fs,
    time::{SystemTime, UNIX_EPOCH},
};

use digital_twin_desktop_lib::paths::resolve_workspace_write_path;

fn temporary_directory(name: &str) -> std::path::PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock is after epoch")
        .as_nanos();
    std::env::temp_dir().join(format!("digital-twin-{name}-{nonce}"))
}

#[test]
fn permits_a_not_yet_existing_nested_artifact_inside_workspace() {
    let root = temporary_directory("nested");
    let workspace = root.join("workspace");
    fs::create_dir_all(&workspace).expect("workspace created");

    let result =
        resolve_workspace_write_path(&workspace, std::path::Path::new("projects/a/slide.png"));

    assert_eq!(
        result.expect("nested write accepted"),
        fs::canonicalize(&workspace)
            .expect("workspace canonicalized")
            .join("projects/a/slide.png")
    );
    fs::remove_dir_all(root).expect("temporary directory removed");
}

#[test]
fn rejects_traversal_outside_workspace() {
    let root = temporary_directory("traversal");
    let workspace = root.join("workspace");
    fs::create_dir_all(&workspace).expect("workspace created");

    let result = resolve_workspace_write_path(&workspace, std::path::Path::new("../secret.txt"));

    assert_eq!(
        result.expect_err("traversal rejected"),
        "Write path is outside the workspace"
    );
    fs::remove_dir_all(root).expect("temporary directory removed");
}

#[cfg(unix)]
#[test]
fn rejects_a_symlink_inside_workspace_that_targets_outside() {
    use std::os::unix::fs::symlink;

    let root = temporary_directory("symlink");
    let workspace = root.join("workspace");
    let outside = root.join("outside");
    fs::create_dir_all(&workspace).expect("workspace created");
    fs::create_dir_all(&outside).expect("outside directory created");
    symlink(&outside, workspace.join("escaped")).expect("symlink created");

    let result =
        resolve_workspace_write_path(&workspace, std::path::Path::new("escaped/stolen.txt"));

    assert_eq!(
        result.expect_err("symlink escape rejected"),
        "Write path is outside the workspace"
    );
    fs::remove_dir_all(root).expect("temporary directory removed");
}

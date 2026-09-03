use std::{
    fs,
    time::{SystemTime, UNIX_EPOCH},
};

use digital_twin_desktop_lib::paths::{
    atomic_write_workspace_file, atomic_write_workspace_file_with_observer,
    create_workspace_project_tree, resolve_workspace_write_path,
};

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

#[cfg(unix)]
#[test]
fn rejects_parent_traversal_after_an_external_symlink() {
    use std::os::unix::fs::symlink;

    let root = temporary_directory("symlink-parent");
    let workspace = root.join("workspace");
    let outside = root.join("outside");
    fs::create_dir_all(&workspace).expect("workspace created");
    fs::create_dir_all(&outside).expect("outside directory created");
    symlink(&outside, workspace.join("escaped")).expect("symlink created");

    let result =
        resolve_workspace_write_path(&workspace, std::path::Path::new("escaped/../secret.txt"));

    assert_eq!(
        result.expect_err("symlink parent escape rejected"),
        "Write path is outside the workspace"
    );
    fs::remove_dir_all(root).expect("temporary directory removed");
}

#[cfg(unix)]
#[test]
fn rejects_a_broken_symlink_write_target() {
    use std::os::unix::fs::symlink;

    let root = temporary_directory("broken-symlink");
    let workspace = root.join("workspace");
    fs::create_dir_all(&workspace).expect("workspace created");
    symlink(root.join("outside-missing"), workspace.join("broken"))
        .expect("broken symlink created");

    let result =
        resolve_workspace_write_path(&workspace, std::path::Path::new("broken/stolen.txt"));

    assert!(result.is_err(), "broken symlink write target rejected");
    fs::remove_dir_all(root).expect("temporary directory removed");
}

#[cfg(unix)]
#[test]
fn actual_write_boundary_rejects_parent_symlink_and_writes_atomically_inside_workspace() {
    use std::os::unix::fs::symlink;

    let root = temporary_directory("atomic-boundary");
    let workspace = root.join("workspace");
    let outside = root.join("outside");
    fs::create_dir_all(workspace.join("project/exports")).expect("workspace created");
    fs::create_dir_all(&outside).expect("outside created");

    atomic_write_workspace_file(
        &workspace,
        std::path::Path::new("project/exports/deck.pptx"),
        b"pptx-bytes",
    )
    .expect("inside write succeeds");
    assert_eq!(
        fs::read(workspace.join("project/exports/deck.pptx")).expect("artifact reads"),
        b"pptx-bytes"
    );

    symlink(&outside, workspace.join("escaped")).expect("symlink created");
    let error = atomic_write_workspace_file(
        &workspace,
        std::path::Path::new("escaped/stolen.txt"),
        b"secret",
    )
    .expect_err("symlink parent rejected");
    assert!(error.contains("symbolic link") || error.contains("workspace"));
    assert!(!outside.join("stolen.txt").exists());
    fs::remove_dir_all(root).expect("temporary directory removed");
}

#[cfg(unix)]
#[test]
fn held_parent_fd_prevents_a_concurrent_directory_replacement_from_redirecting_a_write() {
    use std::os::unix::fs::symlink;

    let root = temporary_directory("concurrent-parent-replacement");
    let workspace = root.join("workspace");
    let outside = root.join("outside");
    fs::create_dir_all(&workspace).expect("workspace created");
    fs::create_dir_all(&outside).expect("outside created");
    create_workspace_project_tree(&workspace, "project-1", &["exports"])
        .expect("project tree created through held fds");

    atomic_write_workspace_file_with_observer(
        &workspace,
        std::path::Path::new("project-1/exports/deck.pptx"),
        b"held-fd-bytes",
        || {
            fs::rename(
                workspace.join("project-1"),
                workspace.join("project-original"),
            )
            .expect("attacker replaces parent");
            symlink(&outside, workspace.join("project-1")).expect("attacker installs symlink");
        },
    )
    .expect("write commits to the already-held directory");

    assert!(!outside.join("exports/deck.pptx").exists());
    assert_eq!(
        fs::read(workspace.join("project-original/exports/deck.pptx"))
            .expect("artifact remains in held directory"),
        b"held-fd-bytes"
    );
    fs::remove_dir_all(root).expect("temporary directory removed");
}

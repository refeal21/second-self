//! Test-owned directories reserved with exclusive mkdir before SQLite opens.
pub struct TempDir(std::path::PathBuf);

pub fn tempdir() -> std::io::Result<TempDir> {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    tempdir_at(&std::env::temp_dir(), nonce)
}

pub fn tempdir_at(parent: &std::path::Path, nonce: u128) -> std::io::Result<TempDir> {
    // Clock values can repeat. Like the visual_style test helper, claim a
    // directory exclusively and retry collisions, including stale directories.
    for attempt in 0u64.. {
        let path = parent.join(format!("v3-store-{}-{nonce}-{attempt}", std::process::id()));
        match std::fs::create_dir(&path) {
            Ok(()) => return Ok(TempDir(path)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(std::io::Error::other(
        "test directory collision counter exhausted",
    ))
}

impl TempDir {
    pub fn path(&self) -> &std::path::Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

//! SQLite sees only a read-only in-memory image derived from captured bytes.
use crate::paths::{read_bounded_workspace_file, FileReadEvidence, VerifiedFileRead};
use crate::presales::ProjectCheckpoint;
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

pub(super) const DATABASE_FILE_LIMIT: usize = 64 * 1024 * 1024;
pub(super) const PIPELINE_BYTE_LIMIT: usize = 4 * 1024 * 1024;
const CAPTURE_ATTEMPTS: usize = 3;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LegacySourceEvidence {
    main: FileReadEvidence,
    wal: Option<FileReadEvidence>,
}

/// Non-Deserialize and privately constructed. This is stable source evidence,
/// not an activity lease, not artifact validation, and not publication authority.
pub(crate) struct CapturedLegacySnapshot {
    source_root: PathBuf,
    database_relative: PathBuf,
    project_id: String,
    revision: i64,
    pipeline_json: String,
    checkpoint: ProjectCheckpoint,
    evidence: LegacySourceEvidence,
    snapshot_sha256: String,
    original_main: Vec<u8>,
    original_wal: Option<Vec<u8>>,
}

impl CapturedLegacySnapshot {
    pub(crate) fn capture(
        root: &Path,
        relative: &Path,
        project_id: &str,
        temporary_parent: &Path,
    ) -> Result<Self, String> {
        Self::capture_with_observer(root, relative, project_id, temporary_parent, |_| {})
    }

    fn capture_with_observer(
        root: &Path,
        relative: &Path,
        project_id: &str,
        temporary_parent: &Path,
        copied: impl FnMut(usize),
    ) -> Result<Self, String> {
        Self::capture_with_observers(root, relative, project_id, temporary_parent, copied, || {})
    }

    fn capture_with_observers(
        root: &Path,
        relative: &Path,
        project_id: &str,
        temporary_parent: &Path,
        mut copied: impl FnMut(usize),
        mut verified: impl FnMut(),
    ) -> Result<Self, String> {
        if project_id.is_empty() || project_id.len() > 160 {
            return Err("invalid source project id".into());
        }
        let root = fs::canonicalize(root).map_err(message)?;
        for attempt in 0..CAPTURE_ATTEMPTS {
            let result: Result<Self, String> = (|| {
                let files = read_source(&root, relative)?;
                let directory = PrivateSnapshotDirectory::create(temporary_parent)?;
                directory.write("snapshot.sqlite3", &files.0.bytes)?;
                if let Some(wal) = &files.1 {
                    directory.write("snapshot.sqlite3-wal", &wal.bytes)?;
                }
                copied(attempt);
                directory.verify_copied_files(&files)?;
                verified();
                let evidence = evidence(&files);
                check_source(&root, relative, &evidence)?;
                let image = super::wal_snapshot::materialize(
                    &files.0.bytes,
                    files.1.as_ref().map(|w| w.bytes.as_slice()),
                    DATABASE_FILE_LIMIT,
                )?;
                let (pipeline_json, checkpoint) = read_memory_checkpoint(&image, project_id)?;
                check_source(&root, relative, &evidence)?;
                let revision = checkpoint.pipeline["revision"]
                    .as_i64()
                    .filter(|r| *r >= 1)
                    .ok_or("invalid source revision")?;
                if checkpoint
                    .pipeline
                    .pointer("/project/id")
                    .and_then(Value::as_str)
                    != Some(project_id)
                    || !matches!(checkpoint.pipeline["schemaVersion"].as_i64(), Some(1 | 2))
                {
                    return Err("source pipeline identity/schema is invalid".into());
                }
                // Separate from the raw pipeline SHA-256 used by Worker replay.
                // File evidence binds every row and raw original DB/WAL byte.
                let digest =
                    serde_json::to_vec(&(1, project_id, revision, &evidence)).map_err(message)?;
                Ok(Self {
                    source_root: root.clone(),
                    database_relative: relative.into(),
                    project_id: project_id.into(),
                    revision,
                    pipeline_json,
                    checkpoint,
                    evidence,
                    snapshot_sha256: format!("{:x}", Sha256::digest(digest)),
                    original_main: files.0.bytes,
                    original_wal: files.1.map(|w| w.bytes),
                })
            })();
            match result {
                Err(e) if e.contains("source_changed") && attempt + 1 < CAPTURE_ATTEMPTS => {
                    continue
                }
                result => return result,
            }
        }
        unreachable!("bounded capture loop returns")
    }

    pub(crate) fn recheck(&self) -> Result<(), String> {
        // Identical descriptor identity and full raw DB/WAL digests imply the
        // exact captured revision. No source SQLite connection is required.
        check_source(&self.source_root, &self.database_relative, &self.evidence)
    }
    pub(crate) fn project_id(&self) -> &str {
        &self.project_id
    }
    pub(crate) fn revision(&self) -> i64 {
        self.revision
    }
    pub(crate) fn pipeline_json(&self) -> &str {
        &self.pipeline_json
    }
    pub(crate) fn checkpoint(&self) -> &ProjectCheckpoint {
        &self.checkpoint
    }
    pub(crate) fn source_evidence(&self) -> &LegacySourceEvidence {
        &self.evidence
    }
    pub(crate) fn snapshot_sha256(&self) -> &str {
        &self.snapshot_sha256
    }
    /// Original bounded database/WAL bytes, retained before private SQLite recovery.
    /// Later native envelope extraction can preserve exact companion/style rows
    /// without reopening the source or trusting reserialized caller evidence.
    pub(crate) fn raw_database_bytes(&self) -> (&[u8], Option<&[u8]>) {
        (&self.original_main, self.original_wal.as_deref())
    }
}

type SourceFiles = (VerifiedFileRead, Option<VerifiedFileRead>);
fn side_path(relative: &Path, suffix: &str) -> PathBuf {
    let mut name = relative.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}
fn read_source(root: &Path, relative: &Path) -> Result<SourceFiles, String> {
    // A hot rollback journal needs a different protocol; do not silently ignore it.
    if read_bounded_workspace_file(root, &side_path(relative, "-journal"), DATABASE_FILE_LIMIT)?
        .is_some()
    {
        return Err("source_rollback_journal_present".into());
    }
    let main = read_bounded_workspace_file(root, relative, DATABASE_FILE_LIMIT)?
        .ok_or("source database is missing")?;
    let wal = read_bounded_workspace_file(root, &side_path(relative, "-wal"), DATABASE_FILE_LIMIT)?;
    Ok((main, wal))
}
fn evidence(files: &SourceFiles) -> LegacySourceEvidence {
    LegacySourceEvidence {
        main: files.0.evidence.clone(),
        wal: files.1.as_ref().map(|w| w.evidence.clone()),
    }
}
fn check_source(
    root: &Path,
    relative: &Path,
    expected: &LegacySourceEvidence,
) -> Result<(), String> {
    let actual = read_source(root, relative).map_err(|e| format!("source_changed: {e}"))?;
    if evidence(&actual) != *expected {
        return Err("source_changed: database identity, bytes or WAL changed".into());
    }
    Ok(())
}

fn read_memory_checkpoint(
    image: &[u8],
    project_id: &str,
) -> Result<(String, ProjectCheckpoint), String> {
    let connection = open_read_image(image)?;
    connection
        .busy_timeout(std::time::Duration::from_millis(50))
        .map_err(message)?;
    connection
        .execute_batch("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY;")
        .map_err(message)?;
    let check: String = connection
        .query_row("PRAGMA quick_check", [], |r| r.get(0))
        .map_err(message)?;
    if check != "ok" {
        return Err("private source snapshot is inconsistent".into());
    }
    let transaction = connection.unchecked_transaction().map_err(message)?;
    require_table(&transaction, "projects")?;
    let length: i64 = transaction
        .query_row(
            "SELECT length(CAST(pipeline_json AS BLOB)) FROM projects WHERE id=?1",
            [project_id],
            |r| r.get(0),
        )
        .map_err(message)?;
    if length < 1 || length > PIPELINE_BYTE_LIMIT as i64 {
        return Err("pipeline exceeds snapshot byte limit".into());
    }
    let raw: String = transaction
        .query_row(
            "SELECT pipeline_json FROM projects WHERE id=?1",
            [project_id],
            |r| r.get(0),
        )
        .map_err(message)?;
    let paired = [
        "presales_projects",
        "presales_checkpoints",
        "presales_approval_bindings",
    ];
    let mut count = 0;
    for name in paired {
        if table_exists(&transaction, name)? {
            count += 1;
        }
    }
    if count != 0 && count != paired.len() {
        return Err("partial presales companion schema".into());
    }
    let checkpoint = if count == 0 {
        ProjectCheckpoint {
            pipeline: serde_json::from_str(&raw).map_err(message)?,
            presales: None,
        }
    } else {
        let marked =
            crate::presales::storage::enabled(&transaction, project_id).map_err(message)?;
        if !marked {
            let orphan: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM presales_checkpoints WHERE project_id=?1) OR EXISTS(SELECT 1 FROM presales_approval_bindings WHERE project_id=?1)",
                [project_id], |r| r.get(0)).map_err(message)?;
            if orphan {
                return Err("unmarked presales companion evidence".into());
            }
        }
        crate::presales::storage::load_on(&transaction, project_id).map_err(message)?
    };
    transaction.commit().map_err(message)?;
    Ok((raw, checkpoint))
}

fn open_read_image(image: &[u8]) -> Result<Connection, String> {
    if image.is_empty() || image.len() > DATABASE_FILE_LIMIT {
        return Err("snapshot_image_limit: invalid deserialize allocation length".into());
    }
    let mut connection = Connection::open_in_memory().map_err(message)?;
    // The slice length equals the requested exact read, so rusqlite's allocated
    // buffer cannot encounter a short read. SQLite owns/frees it on close or
    // deserialize failure (FREEONCLOSE); READONLY prevents mutation/growth.
    connection
        .deserialize_read_exact("main", image, image.len(), true)
        .map_err(message)?;
    Ok(connection)
}
fn table_exists(connection: &Connection, name: &str) -> Result<bool, String> {
    let kind: Option<String> = connection
        .query_row(
            "SELECT type FROM sqlite_schema WHERE name=?1",
            [name],
            |r| r.get(0),
        )
        .optional()
        .map_err(message)?;
    match kind.as_deref() {
        None => Ok(false),
        Some("table") => Ok(true),
        _ => Err(format!("invalid source schema object {name}")),
    }
}
fn require_table(connection: &Connection, name: &str) -> Result<(), String> {
    if !table_exists(connection, name)? {
        return Err(format!("missing source table {name}"));
    }
    Ok(())
}
fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}

struct PrivateSnapshotDirectory(PathBuf, fs::File);
impl PrivateSnapshotDirectory {
    fn verify_copied_files(&self, source: &SourceFiles) -> Result<(), String> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let held = self.1.metadata().map_err(message)?;
            let linked = fs::symlink_metadata(&self.0).map_err(message)?;
            if !linked.is_dir() || held.dev() != linked.dev() || held.ino() != linked.ino() {
                return Err("private snapshot directory identity changed".into());
            }
        }
        let copied = read_source(&self.0, Path::new("snapshot.sqlite3"))?;
        if copied.0.bytes != source.0.bytes
            || copied.1.as_ref().map(|w| &w.bytes) != source.1.as_ref().map(|w| &w.bytes)
        {
            return Err("private snapshot bytes do not match captured source".into());
        }
        Ok(())
    }

    fn create(parent: &Path) -> Result<Self, String> {
        static SEQUENCE: AtomicU64 = AtomicU64::new(1);
        let parent = fs::canonicalize(parent).map_err(message)?;
        let clock = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(message)?
            .as_nanos();
        for _ in 0..32 {
            let path = parent.join(format!(
                ".legacy-snapshot-{}-{clock}-{}",
                std::process::id(),
                SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            let mut builder = fs::DirBuilder::new();
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            match builder.create(&path) {
                Ok(()) => {
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::OpenOptionsExt;
                        let directory = fs::OpenOptions::new()
                            .read(true)
                            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
                            .open(&path)
                            .map_err(message)?;
                        return Ok(Self(path, directory));
                    }
                    #[cfg(not(unix))]
                    {
                        return Err(
                            "snapshot directories require descriptor-relative filesystem support"
                                .into(),
                        );
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(message(e)),
            }
        }
        Err("private snapshot directory reservation exhausted".into())
    }
    fn write(&self, name: &str, bytes: &[u8]) -> Result<(), String> {
        #[cfg(unix)]
        {
            use std::{
                ffi::CString,
                os::fd::{AsRawFd, FromRawFd},
            };
            let name = CString::new(name).map_err(message)?;
            // SAFETY: directory is held and name is one native-owned file component.
            let fd = unsafe {
                libc::openat(
                    self.1.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_WRONLY
                        | libc::O_CREAT
                        | libc::O_EXCL
                        | libc::O_NOFOLLOW
                        | libc::O_CLOEXEC,
                    0o600,
                )
            };
            if fd < 0 {
                return Err(message(std::io::Error::last_os_error()));
            }
            // SAFETY: newly created fd has one owner.
            let mut file = unsafe { fs::File::from_raw_fd(fd) };
            file.write_all(bytes).map_err(message)?;
            file.sync_all().map_err(message)
        }
        #[cfg(not(unix))]
        {
            let _ = (name, bytes);
            Err("snapshot writes require descriptor-relative filesystem support".into())
        }
    }
}
impl Drop for PrivateSnapshotDirectory {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            use std::{
                ffi::CString,
                os::{fd::AsRawFd, unix::fs::MetadataExt},
            };
            for name in [
                "snapshot.sqlite3-shm",
                "snapshot.sqlite3-wal",
                "snapshot.sqlite3-journal",
                "snapshot.sqlite3",
            ] {
                let name = CString::new(name).expect("literal file component");
                // SAFETY: cleanup uses the directory we created, even if its pathname
                // has since been renamed or replaced by a symlink to unrelated files.
                unsafe {
                    libc::unlinkat(self.1.as_raw_fd(), name.as_ptr(), 0);
                }
            }
            if let (Ok(owned), Ok(linked)) = (self.1.metadata(), fs::symlink_metadata(&self.0)) {
                if linked.is_dir() && owned.dev() == linked.dev() && owned.ino() == linked.ino() {
                    let _ = fs::remove_dir(&self.0);
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "legacy_snapshot_tests.rs"]
mod legacy_snapshot_tests;

#[cfg(test)]
#[path = "legacy_wal_tests.rs"]
mod legacy_wal_tests;

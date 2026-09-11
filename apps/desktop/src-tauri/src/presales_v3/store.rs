use super::*;
use crate::presales_queue::schema::{initialize, DatabaseProfile};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use std::path::Path;

pub struct V3Store {
    pub(crate) connection: Connection,
}

impl V3Store {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, String> {
        Self::initialize(Connection::open(path).map_err(message)?, true)
    }
    pub fn open_in_memory() -> Result<Self, String> {
        Self::initialize(Connection::open_in_memory().map_err(message)?, false)
    }

    fn initialize(connection: Connection, file_backed: bool) -> Result<Self, String> {
        let connection = initialize(connection, file_backed, DatabaseProfile::PresalesV3)?;
        // V3 events use at most three short local write attempts. QueueOnly's
        // existing timeout and transaction behavior remain independently owned.
        connection
            .busy_timeout(std::time::Duration::from_millis(25))
            .map_err(message)?;
        Ok(Self { connection })
    }

    pub(crate) fn insert_project(&mut self, seed: ValidatedV3ProjectSeed) -> Result<(), String> {
        let snapshot = seed.into_snapshot();
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(message)?;
        tx.execute(
            "INSERT INTO v3_catalog(project_id,kind,revision) VALUES (?1,'frozen',?2)",
            params![snapshot.summary.project_id, snapshot.summary.revision],
        )
        .map_err(message)?;
        tx.execute("INSERT INTO v3_projects (project_id, name, frozen_json, origin_json, palette_json, created_at, revision)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![snapshot.summary.project_id, snapshot.summary.name,
                encode(&snapshot.frozen_checkpoint)?, encode(&snapshot.origin)?, encode(&snapshot.palette)?,
                snapshot.summary.created_at, snapshot.summary.revision]).map_err(message)?;
        for page in &snapshot.pages {
            tx.execute("INSERT INTO v3_pages (project_id, slide_id, ordinal, spec_json, design_json, basis_json)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6)", params![
                    snapshot.summary.project_id, page.slide_id, page.ordinal as i64,
                    encode(&page.spec)?, page.design.as_ref().map(encode).transpose()?,
                    page.visual_basis.as_ref().map(encode).transpose()?]).map_err(message)?;
        }
        tx.commit().map_err(message)
    }

    pub fn list_projects(&self) -> Result<Vec<V3ProjectSummary>, String> {
        Ok(self
            .list_project_catalog()?
            .into_iter()
            .map(|entry| entry.summary)
            .collect())
    }

    pub fn list_project_catalog(&self) -> Result<Vec<V3CatalogEntry>, String> {
        let tx = self.connection.unchecked_transaction().map_err(message)?;
        let ids = {
            let mut stmt = tx
                .prepare("SELECT c.project_id FROM v3_catalog c LEFT JOIN v3_projects p ON p.project_id=c.project_id ORDER BY p.created_at, c.project_id")
                .map_err(message)?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(message)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(message)?;
            rows
        };
        let projects = ids
            .iter()
            .map(|id| {
                load_on(&tx, id).map(|snapshot| V3CatalogEntry {
                    kind: V3CatalogKind::Frozen,
                    summary: snapshot.summary,
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        tx.commit().map_err(message)?;
        Ok(projects)
    }

    pub fn load_project(&self, project_id: &str) -> Result<V3ProjectSnapshot, String> {
        let tx = self.connection.unchecked_transaction().map_err(message)?;
        let snapshot = load_on(&tx, project_id)?;
        tx.commit().map_err(message)?;
        Ok(snapshot)
    }
}

pub(super) fn load_on(
    connection: &Connection,
    project_id: &str,
) -> Result<V3ProjectSnapshot, String> {
    let (kind, revision): (String, i64) = connection
        .query_row(
            "SELECT kind,revision FROM v3_catalog WHERE project_id=?1",
            [project_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(message)?;
    if kind != "frozen" {
        return Err("project is not a frozen native catalog entry".into());
    }
    let mixed: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM v3_draft_projects WHERE project_id=?1) OR EXISTS(SELECT 1 FROM v3_history_projects WHERE project_id=?1)",[project_id],|r|r.get(0)).map_err(message)?;
    let snapshot = load_native_on(connection, project_id)?;
    if mixed || snapshot.summary.revision != revision {
        return Err("native catalog identity or revision mismatch".into());
    }
    Ok(snapshot)
}

/// Strict pre-import native evidence reader, also used only after exact v1
/// schema ownership has been verified for the catalog upgrade.
pub(super) fn load_native_on(
    connection: &Connection,
    project_id: &str,
) -> Result<V3ProjectSnapshot, String> {
    let stored = connection
        .query_row(
            "SELECT name, frozen_json, origin_json, palette_json, created_at, revision
         FROM v3_projects WHERE project_id = ?1",
            [project_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                ))
            },
        )
        .optional()
        .map_err(message)?
        .ok_or_else(|| format!("unknown v3 project: {project_id}"))?;
    let mut snapshot = super::basis::frozen_snapshot(decode(&stored.1)?, decode(&stored.3)?)?;
    let origin: V3Origin = decode(&stored.2)?;
    if snapshot.origin != origin
        || snapshot.summary.project_id != project_id
        || snapshot.summary.name != stored.0
        || snapshot.summary.created_at != stored.4
        || stored.5 < 1
    {
        return Err("v3 project metadata does not match frozen evidence".into());
    }
    snapshot.summary.revision = stored.5;
    let mut stmt = connection.prepare(
        "SELECT slide_id, ordinal, spec_json, design_json, basis_json, current_version_id, approved_version_id, revision, intent_request_id
         FROM v3_pages WHERE project_id = ?1 ORDER BY ordinal").map_err(message)?;
    let rows = stmt
        .query_map([project_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, Option<String>>(8)?,
            ))
        })
        .map_err(message)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(message)?;
    if rows.len() != snapshot.pages.len() {
        return Err("v3 frozen page set is incomplete".into());
    }
    for (page, row) in snapshot.pages.iter_mut().zip(rows) {
        if page.slide_id != row.0
            || page.ordinal as i64 != row.1
            || page.spec != decode::<serde_json::Value>(&row.2)?
            || page.design != row.3.as_deref().map(decode).transpose()?
            || page.visual_basis != row.4.as_deref().map(decode).transpose()?
        {
            return Err("v3 page does not match frozen evidence".into());
        }
        page.current_version_id = row.5;
        page.revision = row.7;
        page.intent_request_id = row.8;
        let mut versions = connection.prepare(
            "SELECT version_json FROM v3_versions WHERE project_id = ?1 AND slide_id = ?2 ORDER BY sequence").map_err(message)?;
        let encoded = versions
            .query_map(params![project_id, page.slide_id], |row| {
                row.get::<_, String>(0)
            })
            .map_err(message)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(message)?;
        page.versions = encoded
            .iter()
            .map(|v| decode(v))
            .collect::<Result<_, _>>()?;
        super::history::load_page_history(connection, project_id, page, row.6.as_deref())?;
    }
    super::history::load_delivery(connection, &mut snapshot)?;
    Ok(snapshot)
}

pub(super) fn encode(value: &impl serde::Serialize) -> Result<String, String> {
    serde_json::to_string(value).map_err(message)
}
pub(super) fn decode<T: serde::de::DeserializeOwned>(value: &str) -> Result<T, String> {
    serde_json::from_str(value).map_err(message)
}
pub(super) fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}

pub(super) fn write_on<T>(
    connection: &mut Connection,
    mut operation: impl FnMut(&rusqlite::Transaction<'_>) -> Result<T, String>,
) -> Result<T, String> {
    for attempt in 0..3 {
        let result: Result<T, String> = (|| {
            let tx = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(message)?;
            let result = operation(&tx)?;
            tx.commit().map_err(message)?;
            Ok(result)
        })();
        match result {
            Err(error)
                if attempt < 2
                    && (error.contains("database is locked")
                        || error.contains("database is busy")) =>
            {
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            other => return other,
        }
    }
    unreachable!("bounded local retry returns on final attempt")
}

pub(super) fn page_on<'a>(
    snapshot: &'a V3ProjectSnapshot,
    slide_id: &str,
) -> Result<&'a V3PageState, String> {
    snapshot
        .pages
        .iter()
        .find(|page| page.slide_id == slide_id)
        .ok_or_else(|| "unknown v3 page".into())
}

pub(super) fn bump_project(tx: &Connection, project_id: &str) -> Result<(), String> {
    if tx.execute("UPDATE v3_projects SET revision = revision + 1 WHERE project_id = ?1 AND revision < 9223372036854775807", [project_id]).map_err(message)? != 1 {
        return Err("project revision exhausted or project missing".into());
    }
    if tx.execute("UPDATE v3_catalog SET revision = revision + 1 WHERE project_id = ?1 AND revision < 9223372036854775807", [project_id]).map_err(message)? != 1 {
        return Err("catalog revision exhausted or project missing".into());
    }
    Ok(())
}

pub(super) fn now() -> Result<String, String> {
    chrono::DateTime::from_timestamp_millis(crate::presales_queue::store::epoch_milliseconds()?)
        .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .ok_or_else(|| "native timestamp is outside the RFC3339 range".into())
}

use super::*;
use crate::presales_queue::schema::{initialize, DatabaseProfile};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use std::path::Path;

pub struct V3Store {
    pub(crate) connection: Connection,
}

impl V3Store {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, String> {
        Ok(Self {
            connection: initialize(
                Connection::open(path).map_err(message)?,
                true,
                DatabaseProfile::PresalesV3,
            )?,
        })
    }
    pub fn open_in_memory() -> Result<Self, String> {
        Ok(Self {
            connection: initialize(
                Connection::open_in_memory().map_err(message)?,
                false,
                DatabaseProfile::PresalesV3,
            )?,
        })
    }

    pub(crate) fn insert_project(&mut self, seed: ValidatedV3ProjectSeed) -> Result<(), String> {
        let snapshot = seed.into_snapshot();
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
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
        let tx = self.connection.unchecked_transaction().map_err(message)?;
        let ids = {
            let mut stmt = tx
                .prepare("SELECT project_id FROM v3_projects ORDER BY created_at, project_id")
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
            .map(|id| load_on(&tx, id).map(|snapshot| snapshot.summary))
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

fn load_on(connection: &Connection, project_id: &str) -> Result<V3ProjectSnapshot, String> {
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
        "SELECT slide_id, ordinal, spec_json, design_json, basis_json, current_version_id, approved_version_id
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
        if let Some(version_id) = row.6 {
            let encoded: String = connection.query_row(
                "SELECT approval_json FROM v3_approvals WHERE project_id = ?1 AND slide_id = ?2 AND version_id = ?3",
                params![project_id, page.slide_id, version_id], |r| r.get(0)).map_err(message)?;
            page.approval = Some(decode(&encoded)?);
        }
        let feedback: Option<String> = connection.query_row(
            "SELECT draft_json FROM v3_feedback WHERE project_id = ?1 AND slide_id = ?2 AND base_version_id = COALESCE(?3, '')",
            params![project_id, page.slide_id, page.current_version_id], |r| r.get(0)).optional().map_err(message)?;
        page.feedback = feedback.as_deref().map(decode).transpose()?;
    }
    Ok(snapshot)
}

fn encode(value: &impl serde::Serialize) -> Result<String, String> {
    serde_json::to_string(value).map_err(message)
}
fn decode<T: serde::de::DeserializeOwned>(value: &str) -> Result<T, String> {
    serde_json::from_str(value).map_err(message)
}
fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}

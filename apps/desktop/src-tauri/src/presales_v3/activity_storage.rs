use super::{activity::Evidence, V3Store};
use rusqlite::params;

pub(super) fn load(store: &V3Store) -> Result<Vec<Evidence>, String> {
    let mut stmt = store
        .connection
        .prepare("SELECT evidence_id,evidence_json FROM v3_legacy_activity")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    rows.map(|row| {
        let (id, json) = row.map_err(|e| e.to_string())?;
        let e: Evidence =
            serde_json::from_str(&json).map_err(|_| "legacy_activity_evidence_invalid")?;
        if e.id != id || e.proof_version != 1 || (e.settled && e.resolution.is_none()) {
            return Err("legacy_activity_evidence_invalid".into());
        }
        Ok(e)
    })
    .collect()
}
pub(super) fn save(store: &V3Store, e: &Evidence) -> Result<(), String> {
    store.connection.execute("INSERT INTO v3_legacy_activity(evidence_id,evidence_json) VALUES (?1,?2) ON CONFLICT(evidence_id) DO UPDATE SET evidence_json=excluded.evidence_json",params![e.id,serde_json::to_string(e).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
    Ok(())
}

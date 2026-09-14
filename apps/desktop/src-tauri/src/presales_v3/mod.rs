pub(crate) mod activity;
mod activity_protocol;
mod activity_storage;
mod basis;
mod contracts;
mod delivery;
mod events;
mod feedback;
mod history;
mod import;
mod import_assets;
mod import_contracts;
mod import_evidence;
mod import_read;
mod legacy_envelope;
mod legacy_snapshot;
mod prompt;
mod publication;
mod review;
mod service;
mod store;
mod validator_process;
mod wal_snapshot;

pub(crate) use basis::ValidatedV3ProjectSeed;
pub use contracts::*;
pub use import_contracts::*;
pub use service::V3WorkbenchService;
pub use store::V3Store;

pub(crate) fn validate_native_upgrade(
    connection: &rusqlite::Connection,
) -> Result<Vec<(String, i64)>, String> {
    let mut statement = connection
        .prepare("SELECT project_id FROM v3_projects ORDER BY project_id")
        .map_err(store::message)?;
    let ids = statement
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(store::message)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(store::message)?;
    ids.into_iter()
        .map(|id| {
            let snapshot = store::load_native_on(connection, &id)?;
            Ok((id, snapshot.summary.revision))
        })
        .collect()
}

#[cfg(test)]
mod activity_tests;
#[cfg(test)]
mod events_tests;
#[cfg(test)]
mod import_tests;

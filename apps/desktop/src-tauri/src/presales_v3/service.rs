//! Native-owned workbench entrypoint. Frontends receive opaque preparation IDs,
//! never a replay token, filesystem mapping, or claimed approval authority.
use super::{
    activity::LegacyActivityTracker,
    import::PreparedCopy,
    store::{encode, message},
    validator_process::LegacyValidatorProcess,
    *,
};
use crate::workbench::WorkbenchService;
use rusqlite::OptionalExtension;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

pub struct V3WorkbenchService {
    store: Mutex<V3Store>,
    root: PathBuf,
    activity: Arc<LegacyActivityTracker>,
    validator: LegacyValidatorProcess,
    preparations: Mutex<HashMap<String, PreparedCopy>>,
}

impl V3WorkbenchService {
    pub(crate) fn bundled<R: tauri::Runtime>(
        app: &tauri::AppHandle<R>,
        legacy: &WorkbenchService,
        database: &Path,
    ) -> Result<Self, String> {
        let store = V3Store::open(database)?;
        let root = super::import_assets::root_on(&store.connection)?;
        Self::new(
            store,
            root,
            legacy.activity().clone(),
            LegacyValidatorProcess::bundled(app)?,
        )
    }
    pub(super) fn new(
        store: V3Store,
        root: PathBuf,
        activity: Arc<LegacyActivityTracker>,
        validator: LegacyValidatorProcess,
    ) -> Result<Self, String> {
        let root = std::fs::canonicalize(root.parent().ok_or("import root parent missing")?)
            .map_err(message)?
            .join(root.file_name().ok_or("import root name missing")?);
        if root != super::import_assets::root_on(&store.connection)? {
            return Err("import root must be the dedicated sibling v3 asset root".into());
        }
        match std::fs::symlink_metadata(&root) {
            Ok(m) if !m.file_type().is_dir() || m.file_type().is_symlink() => {
                return Err("v3 asset root must be a native directory".into())
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&root).map_err(message)?
            }
            Err(e) => return Err(message(e)),
        }
        let root = std::fs::canonicalize(root).map_err(message)?;
        Ok(Self {
            store: Mutex::new(store),
            root,
            activity,
            validator,
            preparations: Mutex::new(HashMap::new()),
        })
    }

    pub fn prepare_legacy_copy(
        &self,
        legacy: &WorkbenchService,
        input: PrepareLegacyCopy,
    ) -> Result<PreparedLegacyCopySummary, String> {
        if !Arc::ptr_eq(&self.activity, legacy.activity()) {
            return Err("legacy source activity owner mismatch".into());
        }
        if self
            .preparations
            .lock()
            .map_err(|_| "preparation lock poisoned")?
            .len()
            >= 2
        {
            return Err(
                "two preparations are already awaiting publication; discard one first".into(),
            );
        }
        let source = legacy.native_copy_source(&input.source_project_id)?;
        if self.root.starts_with(&source.root) || source.root.starts_with(&self.root) {
            return Err("v3 and legacy asset roots must be separate".into());
        }
        let (snapshot, epoch) = {
            let guard = self.activity.try_source_guard(&source)?;
            let parent = source
                .database
                .parent()
                .ok_or("source database parent missing")?;
            let relative = source
                .database
                .file_name()
                .ok_or("source database filename missing")?;
            let snapshot = super::legacy_snapshot::CapturedLegacySnapshot::capture(
                parent,
                Path::new(relative),
                &source.project,
                &self.root,
            )?;
            let (_, records) = super::import_evidence::style_and_records(
                snapshot.selected_rows(),
                &snapshot.checkpoint().pipeline,
            )?;
            guard.check_visual_records(&source, &records)?;
            (snapshot, guard.epoch())
        };
        // No activity lease spans offline replay, file staging or user review.
        let token = self.validator.validate(snapshot)?;
        let prepared = super::import::prepare(token, source, epoch, input.mode, &self.root)?;
        prepared.token.recheck()?;
        prepared.staging.recheck()?;
        let receipt = &prepared.receipt;
        let summary = PreparedLegacyCopySummary {
            preparation_id: receipt.import_id.clone(),
            source_project_id: receipt.origin.source_project_id.clone(),
            source_revision: receipt.origin.source_revision,
            kind: receipt.kind,
            destination: receipt.destination.clone(),
            reasons: receipt.reasons.clone(),
        };
        let mut preparations = self
            .preparations
            .lock()
            .map_err(|_| "preparation lock poisoned")?;
        if preparations.len() >= 2 {
            return Err("preparation capacity reached".into());
        }
        preparations.insert(summary.preparation_id.clone(), prepared);
        Ok(summary)
    }

    pub fn discard_legacy_copy(&self, preparation_id: &str) -> Result<(), String> {
        self.preparations
            .lock()
            .map_err(|_| "preparation lock poisoned")?
            .remove(preparation_id);
        Ok(())
    }

    pub fn publish_legacy_copy(&self, preparation_id: &str) -> Result<V3WorkbenchProject, String> {
        let prepared = self
            .preparations
            .lock()
            .map_err(|_| "preparation lock poisoned")?
            .remove(preparation_id);
        let Some(prepared) = prepared else {
            let store = self.store.lock().map_err(|_| "v3 store lock poisoned")?;
            let project: Option<String> = store
                .connection
                .query_row(
                    "SELECT project_id FROM v3_import_receipts WHERE import_id=?1",
                    [preparation_id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(message)?;
            return project
                .ok_or("unknown or expired native preparation".into())
                .and_then(|id| super::import_read::load_on(&store.connection, &id));
        };
        let guard = self.activity.try_source_guard(&prepared.source)?;
        if guard.epoch() != prepared.epoch {
            return Err("source_activity_changed_since_preparation".into());
        }
        let (_, records) = super::import_evidence::style_and_records(
            prepared.token.snapshot().selected_rows(),
            &prepared.receipt.pipeline,
        )?;
        guard.check_visual_records(&prepared.source, &records)?;
        prepared.token.recheck()?;
        prepared.staging.recheck()?;
        let project = prepared.receipt.destination.project_id.clone();
        let bytes = encode(&prepared.receipt)?;
        if bytes.len() > super::import_assets::FILE_LIMIT {
            return Err("import receipt exceeds byte limit".into());
        }
        let receipt_file = crate::paths::write_new_workspace_artifact(
            &self.root,
            Path::new(&format!("{project}/receipt.json")),
            bytes.as_bytes(),
        )?;
        let mut store = self.store.lock().map_err(|_| "v3 store lock poisoned")?;
        super::store::write_on(&mut store.connection, |tx| {
            super::import::publish_on(tx, &prepared.receipt)?;
            super::import_read::load_on(tx, &project)?;
            // Final descriptor/DB/WAL/asset checks occur inside publication's
            // transaction under the shared native mutation/activity fence.
            prepared.token.recheck()?;
            prepared.staging.recheck()?;
            Ok(())
        })?;
        receipt_file.commit();
        prepared.staging.commit();
        super::import_read::load_on(&store.connection, &project)
    }

    pub fn load_v3_project(&self, project_id: &str) -> Result<V3WorkbenchProject, String> {
        let store = self.store.lock().map_err(|_| "v3 store lock poisoned")?;
        let tx = store.connection.unchecked_transaction().map_err(message)?;
        let result = super::import_read::load_on(&tx, project_id)?;
        tx.commit().map_err(message)?;
        Ok(result)
    }
    pub fn list_project_catalog(&self) -> Result<Vec<V3CatalogEntry>, String> {
        self.store
            .lock()
            .map_err(|_| "v3 store lock poisoned")?
            .list_project_catalog()
    }
    pub fn create_delivery_snapshot(&self, project_id: &str) -> Result<V3DeliverySnapshot, String> {
        let vault = crate::presales_queue::ResultVault::open(&self.root)?;
        self.store
            .lock()
            .map_err(|_| "v3 store lock poisoned")?
            .create_delivery_snapshot(project_id, &vault)
    }
}

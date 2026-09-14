use super::store::{encode, load_review_on as load_on, message, now, write_on};
use super::*;
use crate::presales_queue::ResultVault;
use rusqlite::params;

impl V3Store {
    pub fn create_delivery_snapshot(
        &mut self,
        project_id: &str,
        vault: &ResultVault,
    ) -> Result<V3DeliverySnapshot, String> {
        let before = load_on(&self.connection, project_id)?;
        let mut pages = Vec::new();
        for page in &before.pages {
            let (approval_id, version_id) = match (&page.approval, &page.origin_approval) {
                (Some(a), None) => (&a.approval_id, &a.version_id),
                (None, Some(a)) => (&a.reference_id, &a.version_id),
                _ => return Err("every page needs exactly one effective approval authority".into()),
            };
            if page.current_version_id.as_ref() != Some(version_id) {
                return Err("delivery approval is not active".into());
            }
            let image =
                super::publication::verify_version(&self.connection, page, version_id, vault)?;
            pages.push(V3DeliveryPage {
                slide_id: page.slide_id.clone(),
                version_id: version_id.clone(),
                image,
                approval_id: approval_id.clone(),
                origin_approval_ref: page.origin_approval.clone(),
                content: Some(V3DeliveryContent {
                    spec: page.spec.clone(),
                    design: page.design.clone(),
                    basis: super::publication::version_on(page, version_id)?
                        .basis
                        .clone(),
                    approval: page.approval.clone(),
                }),
            });
        }
        if pages.is_empty() {
            return Err("delivery requires at least one page".into());
        }
        let snapshot = V3DeliverySnapshot {
            snapshot_id: format!("delivery-{}-{}", project_id, before.summary.revision),
            project_id: project_id.into(),
            revision: before.summary.revision,
            pages,
            created_at: now()?,
        };
        write_on(&mut self.connection, |tx| {
            let current = load_on(tx, project_id)?;
            if current.summary.revision != before.summary.revision || current.pages != before.pages
            {
                return Err("delivery selection changed".into());
            }
            if let Some(existing) = current.delivery_snapshot {
                return Ok(existing);
            }
            tx.execute("INSERT INTO v3_delivery_snapshots (snapshot_id,project_id,revision,snapshot_json) VALUES (?1,?2,?3,?4)",
                params![snapshot.snapshot_id, project_id, snapshot.revision, encode(&snapshot)?]).map_err(message)?;
            Ok(snapshot.clone())
        })
    }
}

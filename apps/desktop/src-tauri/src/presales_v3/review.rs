use super::store::{bump_project, encode, load_on, message, now, page_on, write_on};
use super::*;
use crate::presales_queue::ResultVault;
use rusqlite::{params, Connection};

impl V3Store {
    pub fn approve_version(
        &mut self,
        input: ApproveVersion,
        vault: &ResultVault,
    ) -> Result<V3Approval, String> {
        if !input.content_checked || !input.visual_checked {
            return Err("both manual content and visual checks are required".into());
        }
        let before = self.load_project(&input.project_id)?;
        let page = page_on(&before, &input.slide_id)?;
        let image =
            super::publication::verify_version(&self.connection, page, &input.version_id, vault)?;
        if input.basis != *page.visual_basis.as_ref().ok_or("missing basis")?
            || input.image_sha256 != image.sha256
        {
            return Err("approval does not match exact image and basis".into());
        }
        let decided_at = now()?;
        write_on(&mut self.connection, |tx| {
            let snapshot = load_on(tx, &input.project_id)?;
            let page = page_on(&snapshot, &input.slide_id)?;
            require_reviewable(tx, &input.project_id, page, input.expected_revision)?;
            if page.current_version_id.as_deref() != Some(&input.version_id)
                || page.visual_basis.as_ref() != Some(&input.basis)
                || super::publication::version_on(page, &input.version_id)?
                    .image
                    .as_ref()
                    != Some(&image)
            {
                return Err("approval evidence changed".into());
            }
            let approval = page
                .approvals
                .iter()
                .find(|a| a.version_id == input.version_id)
                .cloned()
                .unwrap_or(V3Approval {
                    approval_id: format!("approval-{}", input.version_id),
                    version_id: input.version_id.clone(),
                    image_sha256: image.sha256.clone(),
                    basis: input.basis.clone(),
                    decided_at: decided_at.clone(),
                });
            if !page
                .approvals
                .iter()
                .any(|a| a.approval_id == approval.approval_id)
            {
                tx.execute("INSERT INTO v3_approvals (approval_id,project_id,slide_id,version_id,approval_json) VALUES (?1,?2,?3,?4,?5)",
                    params![approval.approval_id, input.project_id, input.slide_id, input.version_id, encode(&approval)?]).map_err(message)?;
            }
            set_selection(tx, &input.project_id, page, &input.version_id, true)?;
            Ok(approval)
        })
    }

    pub fn adopt_version(
        &mut self,
        input: AdoptVersion,
        vault: &ResultVault,
    ) -> Result<V3PageState, String> {
        self.select_version(input, vault, false)
    }

    pub fn restore_approval(
        &mut self,
        input: AdoptVersion,
        vault: &ResultVault,
    ) -> Result<V3PageState, String> {
        self.select_version(input, vault, true)
    }

    fn select_version(
        &mut self,
        input: AdoptVersion,
        vault: &ResultVault,
        restore: bool,
    ) -> Result<V3PageState, String> {
        let before = self.load_project(&input.project_id)?;
        let image = super::publication::verify_version(
            &self.connection,
            page_on(&before, &input.slide_id)?,
            &input.version_id,
            vault,
        )?;
        write_on(&mut self.connection, |tx| {
            let snapshot = load_on(tx, &input.project_id)?;
            let page = page_on(&snapshot, &input.slide_id)?;
            require_reviewable(tx, &input.project_id, page, input.expected_revision)?;
            if super::publication::version_on(page, &input.version_id)?
                .image
                .as_ref()
                != Some(&image)
            {
                return Err("version evidence changed".into());
            }
            if restore
                && (!page
                    .approvals
                    .iter()
                    .any(|a| a.version_id == input.version_id)
                    || page.current_version_id.as_deref() != Some(&input.version_id))
            {
                return Err(
                    "restoration requires the adopted version's historical approval".into(),
                );
            }
            set_selection(tx, &input.project_id, page, &input.version_id, restore)?;
            Ok(page_on(&load_on(tx, &input.project_id)?, &input.slide_id)?.clone())
        })
    }
}

fn require_reviewable(
    connection: &Connection,
    project: &str,
    page: &V3PageState,
    revision: i64,
) -> Result<(), String> {
    if page.revision != revision {
        return Err("page revision conflict".into());
    }
    if super::events::active_job(connection, project, &page.slide_id)?.is_some() {
        return Err("page has an unfinished generation request".into());
    }
    Ok(())
}

fn set_selection(
    connection: &Connection,
    project: &str,
    page: &V3PageState,
    version: &str,
    approved: bool,
) -> Result<(), String> {
    let revision = page
        .revision
        .checked_add(1)
        .ok_or("page revision exhausted")?;
    connection.execute("UPDATE v3_pages SET current_version_id=?1, approved_version_id=?2, intent_request_id=NULL, revision=?3 WHERE project_id=?4 AND slide_id=?5",
        params![version, approved.then_some(version), revision, project, page.slide_id]).map_err(message)?;
    bump_project(connection, project)
}

//! Shared native asset authority for private inputs and lazy renderer previews.
use super::{
    store::{decode, message},
    supervisor::RuntimeWork,
    *,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImagePreview {
    pub mime_type: &'static str,
    pub base64: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProviderImage {
    pub asset_id: String,
    pub sha256: String,
    pub path: String,
    pub role: String,
}
#[derive(Serialize)]
pub(super) struct ProviderInputs {
    pub cwd: String,
    pub images: Vec<ProviderImage>,
}

impl V3WorkbenchService {
    pub(crate) fn read_verified_image(
        &self,
        project: &str,
        slide: &str,
        version: &str,
        asset: &str,
        hash: &str,
    ) -> Result<ImagePreview, String> {
        let store = self.store.lock().map_err(|_| "v3 store lock poisoned")?;
        let (_, bytes) = verified_visual(
            &store.connection,
            &self.root,
            project,
            slide,
            version,
            asset,
            hash,
        )?;
        Ok(ImagePreview {
            mime_type: "image/png",
            base64: STANDARD.encode(bytes),
        })
    }
    pub(super) fn resolve_provider_inputs(
        &self,
        work: &RuntimeWork,
    ) -> Result<ProviderInputs, String> {
        let store = self.store.lock().map_err(|_| "v3 store lock poisoned")?;
        let tx = &store.connection;
        let mut images = vec![];
        match work {
            RuntimeWork::Image(job) => {
                let project = super::store::load_on(tx, &job.target.project_id)?;
                let page = super::store::page_on(&project, &job.target.slide_id)?;
                if !super::publication::target_matches_basis(job, page) {
                    return Err("provider image basis mismatch".into());
                }
                if let Some(parent) = &job.target.parent_visual {
                    let version = page
                        .versions
                        .iter()
                        .find(|v| v.image.as_ref() == Some(parent))
                        .ok_or("parent image not owned by page history")?;
                    let (path, _) = verified_visual(
                        tx,
                        &self.root,
                        &job.target.project_id,
                        &page.slide_id,
                        &version.version_id,
                        &parent.asset_id,
                        &parent.sha256,
                    )?;
                    images.push(ProviderImage {
                        asset_id: parent.asset_id.clone(),
                        sha256: parent.sha256.clone(),
                        path,
                        role: "parent".into(),
                    });
                }
                if job
                    .target
                    .reference_context
                    .iter()
                    .map(|r| &r.image)
                    .ne(job.target.references.iter())
                {
                    return Err("reference context differs from target".into());
                }
                for reference in &job.target.reference_context {
                    super::reference_assets::verify(
                        tx,
                        &job.target.project_id,
                        &job.target.slide_id,
                        reference,
                    )?;
                    images.push(ProviderImage {
                        asset_id: reference.image.asset_id.clone(),
                        sha256: reference.image.sha256.clone(),
                        path: checked_path(&self.root, &reference.relative_path)?,
                        role: serde_json::to_value(&reference.purpose)
                            .map_err(message)?
                            .as_str()
                            .ok_or("reference purpose missing")?
                            .into(),
                    });
                }
            }
            RuntimeWork::Text(op) => {
                let current = super::text_context::CheckedTextRequest::capture(
                    tx,
                    &op.target.project_id,
                    op.target.expected_revision,
                    op.target.stage,
                )?
                .target();
                if current != op.target {
                    return Err("provider text basis changed".into());
                }
                let receipt = super::import_read::receipt_on(tx, &op.target.project_id)?;
                for source in op
                    .target
                    .sources
                    .iter()
                    .chain(std::iter::once(&op.target.analysis))
                {
                    let a = receipt
                        .assets
                        .iter()
                        .find(|a| a.asset_id == source.asset.asset_id)
                        .ok_or("source authority missing")?;
                    if a.relative_path != source.asset.relative_path
                        || a.sha256 != source.asset.sha256
                        || a.byte_length != source.asset.byte_length
                    {
                        return Err("source evidence mismatch".into());
                    }
                    super::import_assets::check_index(tx, &op.target.project_id, a)?;
                    super::import_assets::verify_asset(&self.root, a)?;
                    checked_path(&self.root, &a.relative_path)?;
                }
            }
        }
        Ok(ProviderInputs {
            cwd: self.root.to_str().ok_or("provider root not UTF-8")?.into(),
            images,
        })
    }
}

fn checked_path(root: &Path, relative: &str) -> Result<String, String> {
    // The descriptor-checked read happens first at each caller; canonical path
    // equality also rejects replacement symlinks before handoff to localImage.
    let path = root.join(relative);
    if std::fs::canonicalize(&path).map_err(message)? != path || !path.starts_with(root) {
        return Err("provider artifact path changed".into());
    }
    Ok(path.to_str().ok_or("provider path not UTF-8")?.into())
}

fn verified_visual(
    tx: &rusqlite::Connection,
    root: &Path,
    project: &str,
    slide: &str,
    version: &str,
    asset: &str,
    hash: &str,
) -> Result<(String, Vec<u8>), String> {
    let snapshot = super::store::load_on(tx, project)?;
    let page = super::store::page_on(&snapshot, slide)?;
    let image = super::publication::verify_version(
        tx,
        page,
        version,
        &crate::presales_queue::ResultVault::open(root)?,
    )?;
    if image.asset_id != asset || image.sha256 != hash {
        return Err("preview immutable image identity mismatch".into());
    }
    let (owner,version_owner,path,sha,raw):(String,Option<String>,String,String,String)=tx.query_row("SELECT project_id,version_id,relative_path,sha256,metadata_json FROM v3_artifacts WHERE artifact_id=?1",[asset],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).map_err(message)?;
    // Imported artifacts can predate a v3 version binding; verified import
    // receipt + exact page/version above supplies their immutable ownership.
    if owner != project || version_owner.as_deref().is_some_and(|v| v != version) || sha != hash {
        return Err("preview artifact ownership mismatch".into());
    }
    let metadata: serde_json::Value = decode(&raw)?;
    let file = crate::paths::read_bounded_workspace_file(
        root,
        Path::new(&path),
        super::import_assets::FILE_LIMIT,
    )?
    .ok_or("preview image missing")?;
    if file.evidence.sha256 != hash
        || metadata["relativePath"] != path
        || metadata["sha256"] != hash
        || metadata["byteLength"] != file.evidence.byte_length
    {
        return Err("preview image evidence mismatch".into());
    }
    crate::presales_queue::validate_png(&file.bytes)?;
    Ok((checked_path(root, &path)?, file.bytes))
}

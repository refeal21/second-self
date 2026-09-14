//! Native selection authority. Task 4's picker callback is the only intended
//! production constructor; frontend paths and booleans are not capabilities.
use super::store::{decode, encode, message};
use crate::presales_queue::{ImageReference, ImageReferenceContext};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;

pub struct NativeSelectedReference {
    pub(super) bytes: Vec<u8>,
}

pub(crate) fn native_selected_file(path: &Path) -> Result<NativeSelectedReference, String> {
    if !path.is_absolute()
        || path.components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
    {
        return Err("native selected path must be absolute and normalized".into());
    }
    if std::fs::canonicalize(path).map_err(message)? != path {
        return Err("native selected path must not traverse symlinks".into());
    }
    let parent = path.parent().ok_or("selected file parent missing")?;
    let file = crate::paths::read_bounded_workspace_file(
        parent,
        Path::new(path.file_name().ok_or("selected filename missing")?),
        super::import_assets::FILE_LIMIT,
    )?
    .ok_or("selected file missing")?;
    crate::presales_queue::validate_png(&file.bytes)?;
    Ok(NativeSelectedReference { bytes: file.bytes })
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ReferenceAsset {
    pub kind: String,
    pub project_id: String,
    pub slide_id: String,
    pub image: ImageReference,
    pub relative_path: String,
    pub byte_length: u64,
}

pub(super) fn verify(
    tx: &Connection,
    project: &str,
    slide: &str,
    reference: &ImageReferenceContext,
) -> Result<(), String> {
    let (p,v,path,sha,raw):(String,Option<String>,String,String,String) = tx.query_row("SELECT project_id,version_id,relative_path,sha256,metadata_json FROM v3_artifacts WHERE artifact_id=?1",[&reference.image.asset_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).map_err(message)?;
    let a: ReferenceAsset = decode(&raw)?;
    if a.kind != "page_reference"
        || p != project
        || a.project_id != project
        || a.slide_id != slide
        || v.is_some()
        || a.image != reference.image
        || path != reference.relative_path
        || path != a.relative_path
        || sha != a.image.sha256
        || a.byte_length != reference.byte_length
        || !path.starts_with(&format!("{project}/assets/"))
    {
        return Err("reference asset page/byte identity mismatch".into());
    }
    let root = super::import_assets::root_on(tx)?;
    let file = crate::paths::read_bounded_workspace_file(
        &root,
        Path::new(&path),
        super::import_assets::FILE_LIMIT,
    )?
    .ok_or("reference bytes missing")?;
    if file.evidence.sha256 != sha || file.evidence.byte_length != a.byte_length {
        return Err("immutable reference bytes mismatch".into());
    }
    crate::presales_queue::validate_png(&file.bytes)?;
    Ok(())
}

pub(super) fn insert(tx: &Connection, a: &ReferenceAsset) -> Result<(), String> {
    tx.execute("INSERT INTO v3_artifacts(artifact_id,project_id,version_id,relative_path,sha256,metadata_json) VALUES(?1,?2,NULL,?3,?4,?5)",params![a.image.asset_id,a.project_id,a.relative_path,a.image.sha256,encode(a)?]).map_err(message)?;
    Ok(())
}

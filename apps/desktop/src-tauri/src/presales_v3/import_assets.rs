//! Descriptor-checked selected assets and exclusively owned immutable copies.
use super::store::{decode, message};
use crate::paths::{
    read_bounded_workspace_file, write_new_workspace_artifact, FileReadEvidence,
    NewWorkspaceArtifact,
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub(super) const FILE_LIMIT: usize = 64 * 1024 * 1024;
pub(super) const TOTAL_LIMIT: u64 = 256 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ImportedAsset {
    pub asset_id: String,
    pub original_path: String,
    pub relative_path: String,
    pub sha256: String,
    pub byte_length: u64,
    pub kind: String,
}

pub(super) struct SourceFile {
    pub relative: String,
    pub evidence: Option<FileReadEvidence>,
}

pub(super) struct AssetStaging {
    pub assets: Vec<ImportedAsset>,
    pub source_files: Vec<SourceFile>,
    pub owned: Vec<NewWorkspaceArtifact>,
    root: PathBuf,
    source_root: PathBuf,
    project: String,
    total: u64,
}

impl AssetStaging {
    pub(super) fn new(root: &Path, source_root: &Path, project: &str) -> Result<Self, String> {
        crate::paths::create_workspace_project_tree(root, project, &["assets"])?;
        Ok(Self {
            assets: vec![],
            source_files: vec![],
            owned: vec![],
            root: root.into(),
            source_root: source_root.into(),
            project: project.into(),
            total: 0,
        })
    }
    pub(super) fn copy(
        &mut self,
        path: &str,
        sha: &str,
        length: Option<u64>,
        kind: &str,
        required: bool,
    ) -> Result<Option<ImportedAsset>, String> {
        if let Some(existing) = self.assets.iter().find(|a| a.original_path == path) {
            if existing.sha256 != sha
                || length.is_some_and(|n| n != existing.byte_length)
                || existing.kind != kind
            {
                return Err("conflicting selected asset metadata".into());
            }
            return Ok(Some(existing.clone()));
        }
        if self.source_files.len() >= 4096 {
            return Err("selected asset count exceeds limit".into());
        }
        let file = read_bounded_workspace_file(&self.source_root, Path::new(path), FILE_LIMIT)?;
        self.source_files.push(SourceFile {
            relative: path.into(),
            evidence: file.as_ref().map(|f| f.evidence.clone()),
        });
        let Some(file) = file else {
            return if required {
                Err(format!("required_source_asset_missing: {path}"))
            } else {
                Ok(None)
            };
        };
        if file.evidence.sha256 != sha || length.is_some_and(|n| n != file.evidence.byte_length) {
            return Err(format!("source_asset_bytes_mismatch: {path}"));
        }
        if kind == "visual" {
            validate_png(&file.bytes)?;
        }
        self.total = self
            .total
            .checked_add(file.evidence.byte_length)
            .ok_or("selected asset size overflow")?;
        if self.total > TOTAL_LIMIT {
            return Err("selected assets exceed total byte limit".into());
        }
        let asset_id = format!("asset-{}", uuid::Uuid::new_v4());
        let asset = ImportedAsset {
            relative_path: format!(
                "{}/assets/{}.{}",
                self.project,
                asset_id,
                if kind == "visual" { "png" } else { "bin" }
            ),
            asset_id,
            original_path: path.into(),
            sha256: sha.into(),
            byte_length: file.evidence.byte_length,
            kind: kind.into(),
        };
        self.owned.push(write_new_workspace_artifact(
            &self.root,
            Path::new(&asset.relative_path),
            &file.bytes,
        )?);
        verify_asset(&self.root, &asset)?;
        self.assets.push(asset.clone());
        Ok(Some(asset))
    }
    pub(super) fn stage_evidence(&mut self, bytes: &[u8]) -> Result<ImportedAsset, String> {
        let asset = ImportedAsset {
            asset_id: format!("evidence-{}", uuid::Uuid::new_v4()),
            original_path: String::new(),
            relative_path: format!("{}/evidence.json", self.project),
            sha256: hash(bytes),
            byte_length: bytes.len() as u64,
            kind: "selected_evidence".into(),
        };
        self.owned.push(write_new_workspace_artifact(
            &self.root,
            Path::new(&asset.relative_path),
            bytes,
        )?);
        self.assets.push(asset.clone());
        Ok(asset)
    }
    pub(super) fn recheck(&self) -> Result<(), String> {
        for source in &self.source_files {
            let now = read_bounded_workspace_file(
                &self.source_root,
                Path::new(&source.relative),
                FILE_LIMIT,
            )?;
            if now.as_ref().map(|f| &f.evidence) != source.evidence.as_ref() {
                return Err(format!("source_asset_changed: {}", source.relative));
            }
        }
        for asset in &self.assets {
            verify_asset(&self.root, asset)?;
        }
        Ok(())
    }
    pub(super) fn commit(self) {
        for artifact in self.owned {
            artifact.commit();
        }
    }
}

pub(super) fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(super) fn verify_asset(root: &Path, asset: &ImportedAsset) -> Result<Vec<u8>, String> {
    let file = read_bounded_workspace_file(root, Path::new(&asset.relative_path), FILE_LIMIT)?
        .ok_or("imported asset is missing")?;
    if file.evidence.byte_length != asset.byte_length || file.evidence.sha256 != asset.sha256 {
        return Err("imported asset byte evidence differs".into());
    }
    if asset.kind == "visual" {
        validate_png(&file.bytes)?;
    }
    Ok(file.bytes)
}

pub(super) fn root_on(connection: &Connection) -> Result<PathBuf, String> {
    let path: String = connection
        .query_row(
            "SELECT file FROM pragma_database_list WHERE name='main'",
            [],
            |r| r.get(0),
        )
        .map_err(message)?;
    if path.is_empty() {
        return Err("imported assets require a file-backed v3 store".into());
    }
    Ok(Path::new(&path)
        .parent()
        .ok_or("v3 store parent missing")?
        .join("presales-v3-assets"))
}

pub(super) fn check_index(
    connection: &Connection,
    project: &str,
    asset: &ImportedAsset,
) -> Result<(), String> {
    let (owner, path, sha, metadata): (String, String, String, String) = connection.query_row("SELECT project_id,relative_path,sha256,metadata_json FROM v3_artifacts WHERE artifact_id=?1", [&asset.asset_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(message)?;
    if owner != project
        || path != asset.relative_path
        || sha != asset.sha256
        || decode::<ImportedAsset>(&metadata)? != *asset
    {
        return Err("import asset index mismatch".into());
    }
    Ok(())
}

fn validate_png(bytes: &[u8]) -> Result<(), String> {
    let (w, h) = crate::presales_queue::validate_png(bytes)?;
    if w < 640 || h < 360 || (w as u64 * 9).abs_diff(h as u64 * 16) > 16 {
        return Err("import image must be bounded full-slide 16:9 PNG".into());
    }
    Ok(())
}

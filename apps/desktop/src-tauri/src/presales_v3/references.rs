use super::{
    store::{decode, encode, message},
    *,
};
use crate::presales_queue::{ImageReference, ImageReferenceContext, ReferencePurpose};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum PageBasis {
    PageBasisV1 {
        basis: V3VisualBasis,
        references: Vec<ImageReferenceContext>,
    },
}

pub(super) fn decode_basis(
    tx: &Connection,
    project: &str,
    slide: &str,
    raw: &str,
) -> Result<(V3VisualBasis, Vec<ImageReferenceContext>), String> {
    let value: serde_json::Value = decode(raw)?;
    if value.get("kind").is_none() {
        return Ok((serde_json::from_value(value).map_err(message)?, vec![]));
    }
    let PageBasis::PageBasisV1 { basis, references } =
        serde_json::from_value(value).map_err(message)?;
    validate_set(tx, project, slide, &references)?;
    Ok((basis, references))
}

fn validate_set(
    tx: &Connection,
    project: &str,
    slide: &str,
    references: &[ImageReferenceContext],
) -> Result<(), String> {
    let mut ids = std::collections::HashSet::new();
    if references.len() > 32 {
        return Err("page reference limit is 32".into());
    }
    for reference in references {
        if !ids.insert(&reference.image.asset_id) {
            return Err("duplicate page reference".into());
        }
        super::reference_assets::verify(tx, project, slide, reference)?;
    }
    Ok(())
}

fn set_on(
    tx: &Connection,
    project: &str,
    slide: &str,
    revision: i64,
    references: Vec<ImageReferenceContext>,
) -> Result<V3PageState, String> {
    let snapshot = super::store::load_on(tx, project)?;
    let page = super::store::page_on(&snapshot, slide)?;
    if page.revision != revision {
        return Err("page revision conflict".into());
    }
    if super::events::active_job(tx, project, slide)?.is_some() {
        return Err("reference change rejected while page work is unfinished".into());
    }
    validate_set(tx, project, slide, &references)?;
    if page.references == references {
        return Ok(page.clone());
    }
    let basis = page
        .visual_basis
        .clone()
        .ok_or("references require frozen visual page")?;
    let next = revision.checked_add(1).ok_or("page revision exhausted")?;
    tx.execute("UPDATE v3_pages SET basis_json=?1,revision=?2,approved_version_id=NULL,intent_request_id=NULL WHERE project_id=?3 AND slide_id=?4 AND revision=?5",params![encode(&PageBasis::PageBasisV1{basis,references})?,next,project,slide,revision]).map_err(message)?;
    super::store::bump_project(tx, project)?;
    Ok(super::store::page_on(&super::store::load_on(tx, project)?, slide)?.clone())
}

/// Current review eligibility is distinct from immutable historical validity.
pub(super) fn version_matches(page: &V3PageState, version: &V3VisualVersion) -> bool {
    match &version.provenance {
        Some(V3VisualProvenance::Presales {
            reference_context, ..
        }) => reference_context == &page.references,
        Some(V3VisualProvenance::LegacyImported { .. }) => page.references.is_empty(),
        None => false,
    }
}

impl V3WorkbenchService {
    pub fn attach_page_reference(
        &self,
        project: &str,
        slide: &str,
        revision: i64,
        selected: NativeSelectedReference,
        purpose: ReferencePurpose,
    ) -> Result<V3PageState, String> {
        let mut store = self.store.lock().map_err(|_| "v3 store lock poisoned")?;
        let snapshot = super::store::load_on(&store.connection, project)?;
        let page = super::store::page_on(&snapshot, slide)?;
        if page.revision != revision {
            return Err("page revision conflict".into());
        }
        let root = super::import_assets::root_on(&store.connection)?;
        let a = super::reference_assets::ReferenceAsset {
            kind: "page_reference".into(),
            project_id: project.into(),
            slide_id: slide.into(),
            image: ImageReference {
                asset_id: format!("reference-{}", uuid::Uuid::new_v4()),
                sha256: super::import_assets::hash(&selected.bytes),
            },
            relative_path: format!("{project}/assets/reference-{}.png", uuid::Uuid::new_v4()),
            byte_length: selected.bytes.len() as u64,
        };
        let mut references = page.references.clone();
        references.push(ImageReferenceContext {
            image: a.image.clone(),
            relative_path: a.relative_path.clone(),
            byte_length: a.byte_length,
            purpose,
        });
        let owned = crate::paths::write_new_workspace_artifact(
            &root,
            Path::new(&a.relative_path),
            &selected.bytes,
        )?;
        let result = super::store::write_on(&mut store.connection, |tx| {
            super::reference_assets::insert(tx, &a)?;
            set_on(tx, project, slide, revision, references.clone())
        })?;
        owned.commit();
        Ok(result)
    }
    pub fn set_page_references(
        &self,
        project: &str,
        slide: &str,
        expected_revision: i64,
        references: Vec<ImageReferenceContext>,
    ) -> Result<V3PageState, String> {
        let mut store = self.store.lock().map_err(|_| "v3 store lock poisoned")?;
        super::store::write_on(&mut store.connection, |tx| {
            set_on(tx, project, slide, expected_revision, references.clone())
        })
    }
}

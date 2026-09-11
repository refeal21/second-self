use super::*;
use crate::presales::{
    bundled_skill_metadata, native_value_hash, ProjectCheckpoint, SkillIdentity,
    NATIVE_VALUE_HASH_ALGORITHM,
};
use crate::presales_queue::VersionHash;
use crate::visual_style::{validate_profile, VisualStyleState};
use serde_json::Value;

/// Only this checked factory may construct an admission seed. In particular it
/// is deliberately neither Deserialize nor a frontend command argument.
pub(crate) struct ValidatedV3ProjectSeed {
    snapshot: V3ProjectSnapshot,
}

impl ValidatedV3ProjectSeed {
    pub(crate) fn from_checkpoint(
        checkpoint: ProjectCheckpoint,
        palette: VisualStyleState,
    ) -> Result<Self, String> {
        let current_skill: SkillIdentity =
            serde_json::from_value(bundled_skill_metadata()).map_err(message)?;
        let presales = checkpoint
            .presales
            .ok_or("v3 requires a paired native checkpoint")?;
        if presales.skill != current_skill {
            return Err("v3 admission requires the current bundled presales skill".into());
        }
        Ok(Self {
            snapshot: frozen_snapshot(
                V3FrozenCheckpoint {
                    pipeline: checkpoint.pipeline,
                    presales,
                },
                palette,
            )?,
        })
    }

    pub(super) fn into_snapshot(self) -> V3ProjectSnapshot {
        self.snapshot
    }
}

/// Recompute immutable evidence when reading as well as inserting. Historical
/// snapshots retain their saved skill identity across bundled skill upgrades.
pub(super) fn frozen_snapshot(
    frozen: V3FrozenCheckpoint,
    palette: VisualStyleState,
) -> Result<V3ProjectSnapshot, String> {
    if serde_json::to_vec(&frozen).map_err(message)?.len() > 4 * 1024 * 1024 {
        return Err("frozen checkpoint exceeds 4 MiB".into());
    }
    crate::presales::storage::validate_loaded(&frozen.pipeline, &frozen.presales)
        .map_err(message)?;
    if frozen.presales.approval_bindings.len() != 2
        || frozen
            .pipeline
            .pointer("/outline/version/status")
            .and_then(Value::as_str)
            != Some("frozen")
        || frozen
            .pipeline
            .pointer("/slideSpecs/version/status")
            .and_then(Value::as_str)
            != Some("frozen")
    {
        return Err("v3 requires frozen outline and details with matching joint approvals".into());
    }
    if palette.revision < 1 {
        return Err("v3 requires a saved palette revision".into());
    }
    let profile = palette
        .profile
        .as_ref()
        .ok_or("v3 requires a saved palette")?;
    validate_profile(profile)?;
    let palette_hash = VersionHash {
        version: palette.revision.to_string(),
        sha256: native_value_hash(&serde_json::to_value(profile).map_err(message)?)?,
    };
    let project_id = required_string(&frozen.pipeline, "/project/id")?;
    let name = required_string(&frozen.pipeline, "/project/name")?;
    let created_at = required_string(&frozen.pipeline, "/project/createdAt")?;
    let source_revision = frozen.pipeline["revision"]
        .as_i64()
        .filter(|n| *n >= 1)
        .ok_or("frozen checkpoint revision must be positive")?;
    let details = frozen
        .presales
        .draft
        .details
        .as_ref()
        .ok_or("missing paired details")?;
    let specs = details["specs"].as_array().ok_or("missing paired specs")?;
    let designs = details["designs"]
        .as_array()
        .ok_or("missing paired designs")?;
    let version = &frozen
        .presales
        .basis
        .details
        .as_ref()
        .ok_or("missing details basis")?
        .version_id;
    let skill = VersionHash {
        version: frozen.presales.skill.version.clone(),
        sha256: frozen.presales.skill.sha256.clone(),
    };
    let mut ids = std::collections::HashSet::new();
    let pages = specs
        .iter()
        .zip(designs)
        .enumerate()
        .map(|(ordinal, (spec, design))| {
            let slide_id = required_string(spec, "/id")?;
            if !ids.insert(slide_id.clone()) {
                return Err("duplicate frozen page id".into());
            }
            Ok(V3PageState {
                slide_id,
                ordinal,
                spec: spec.clone(),
                design: Some(design.clone()),
                visual_basis: Some(V3VisualBasis {
                    hash_algorithm: NATIVE_VALUE_HASH_ALGORITHM.into(),
                    spec: VersionHash {
                        version: version.clone(),
                        sha256: native_value_hash(spec)?,
                    },
                    design: VersionHash {
                        version: version.clone(),
                        sha256: native_value_hash(design)?,
                    },
                    skill: skill.clone(),
                    palette: palette_hash.clone(),
                }),
                current_version_id: None,
                versions: vec![],
                approval: None,
                feedback: None,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let origin = V3Origin {
        source_project_id: project_id.clone(),
        source_revision,
        hash_algorithm: NATIVE_VALUE_HASH_ALGORITHM.into(),
        snapshot_digest: native_value_hash(&serde_json::to_value(&frozen).map_err(message)?)?,
    };
    Ok(V3ProjectSnapshot {
        summary: V3ProjectSummary {
            project_id,
            name,
            page_count: pages.len(),
            revision: 1,
            created_at,
        },
        origin,
        frozen_checkpoint: frozen,
        palette,
        pages,
    })
}

fn required_string(value: &Value, pointer: &str) -> Result<String, String> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("missing frozen checkpoint field {pointer}"))
}

fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
#[path = "../../tests/support/v3_temp.rs"]
mod test_tempdir;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::{Database, NewProject};
    use crate::presales::{PresalesDraftPair, ProjectCheckpoint};
    use crate::presales_v3::V3Store;
    use crate::visual_style::{VisualCommitContext, VisualStyleProfile, VisualStyleState};
    use serde_json::{json, Value};

    // Exercise the actual native paired saves and freeze transitions. A status
    // string alone never stands in for native approval evidence.
    fn frozen_fixture() -> (ProjectCheckpoint, VisualStyleState) {
        let db = Database::open_in_memory().unwrap();
        let id = "frozen-project";
        let at = "2026-09-10T00:00:00Z";
        db.insert_project(&NewProject {
            id: id.into(),
            name: "Synthetic proposal".into(),
            goal: "Paired catalog test".into(),
            created_at: at.into(),
        })
        .unwrap();
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../../fixtures/presales/native-contract.json"
        ))
        .unwrap();
        let full: PresalesDraftPair = serde_json::from_value(fixture["pair"].clone()).unwrap();
        let mut pair = full.clone();
        pair.details = None;
        let mut p = db.get_project(id).unwrap().unwrap().pipeline;
        p["revision"] = json!(2);
        p["project"]["workflowStatus"] = json!("source_analysis");
        p["sources"] = json!([{"id":"source-a","fileName":"synthetic.txt","mediaType":"text/plain",
            "relativePath":"sources/source-a.bin","sha256":"a".repeat(64),"byteLength":9}]);
        p["analysis"] = json!({"requestId":"analysis-1","output":fixture["analysis"],
            "artifactRelativePath":"sources/analysis-1-analysis.json","sha256":"b".repeat(64)});
        assert!(db.replace_pipeline(id, 1, &p, &[]).unwrap());
        p["revision"] = json!(3);
        p["project"]["workflowStatus"] = json!("outline_review");
        p["outline"] = json!({"version":{"id":"outline-v1","projectId":id,"sequence":1,
            "status":"draft","createdAt":at,"frozenAt":null},"value":pair.outline["outline"]});
        db.replace_checkpoint_with_artifacts(
            id,
            2,
            &p,
            &pair,
            &[],
            VisualCommitContext::default(),
            || Ok(()),
        )
        .unwrap()
        .unwrap();
        p["revision"] = json!(4);
        p["project"]["workflowStatus"] = json!("detail_review");
        p["outline"]["version"]["status"] = json!("frozen");
        p["outline"]["version"]["frozenAt"] = json!(at);
        p["approvals"] = json!([{"id":"outline-approval","projectId":id,"versionId":"outline-v1",
            "stage":"outline_review","status":"approved","decidedAt":at}]);
        db.replace_checkpoint_with_artifacts(
            id,
            3,
            &p,
            &pair,
            &[],
            VisualCommitContext::default(),
            || Ok(()),
        )
        .unwrap()
        .unwrap();
        p["revision"] = json!(5);
        p["slideSpecs"] = json!({"version":{"id":"details-v1","projectId":id,"sequence":1,
            "status":"draft","createdAt":at,"frozenAt":null},"value":full.details.as_ref().unwrap()["specs"]});
        db.replace_checkpoint_with_artifacts(
            id,
            4,
            &p,
            &full,
            &[],
            VisualCommitContext::default(),
            || Ok(()),
        )
        .unwrap()
        .unwrap();
        p["revision"] = json!(6);
        p["project"]["workflowStatus"] = json!("visual_review");
        p["slideSpecs"]["version"]["status"] = json!("frozen");
        p["slideSpecs"]["version"]["frozenAt"] = json!(at);
        p["currentSlideId"] = json!("scenario-1");
        p["approvals"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":"details-approval","projectId":id,
            "versionId":"details-v1","stage":"detail_review","status":"approved","decidedAt":at}));
        let checkpoint = db
            .replace_checkpoint_with_artifacts(
                id,
                5,
                &p,
                &full,
                &[],
                VisualCommitContext::default(),
                || Ok(()),
            )
            .unwrap()
            .unwrap();
        let palette = VisualStyleState {
            revision: 2,
            locked: false,
            profile: Some(VisualStyleProfile {
                primary_color: "#112233".into(),
                background_color: "#ffffff".into(),
                text_color: "#000000".into(),
                accent_colors: vec!["#445566".into()],
                instructions: "Synthetic style".into(),
                template: None,
            }),
        };
        (checkpoint, palette)
    }

    #[test]
    fn frozen_seed_roundtrip_rejects_duplicate_without_overwrite() {
        let (checkpoint, palette) = frozen_fixture();
        let seed =
            ValidatedV3ProjectSeed::from_checkpoint(checkpoint.clone(), palette.clone()).unwrap();
        let mut store = V3Store::open_in_memory().unwrap();
        store.insert_project(seed).unwrap();
        let loaded = store.load_project("frozen-project").unwrap();
        assert_eq!(loaded.summary.page_count, 1);
        assert_eq!(loaded.frozen_checkpoint.pipeline, checkpoint.pipeline);
        assert_eq!(
            Some(loaded.frozen_checkpoint.presales.clone()),
            checkpoint.presales
        );
        assert_eq!(loaded.palette, palette);
        assert!(loaded.pages[0].versions.is_empty());
        assert!(loaded.pages[0].approval.is_none());
        assert!(store
            .insert_project(ValidatedV3ProjectSeed::from_checkpoint(checkpoint, palette).unwrap())
            .is_err());
        assert_eq!(store.load_project("frozen-project").unwrap(), loaded);
        assert_eq!(store.list_projects().unwrap(), vec![loaded.summary]);
    }

    #[test]
    fn frozen_seed_rejects_tampering_unapproved_pair_and_unsaved_palette() {
        let (checkpoint, palette) = frozen_fixture();
        let mutations: Vec<Box<dyn Fn(&mut ProjectCheckpoint)>> = vec![
            Box::new(|c| c.presales = None),
            Box::new(|c| c.pipeline["slideSpecs"]["version"]["status"] = json!("draft")),
            Box::new(|c| c.pipeline["outline"]["version"]["status"] = json!("draft")),
            Box::new(|c| c.pipeline["approvals"][1]["id"] = json!("forged")),
            Box::new(|c| c.pipeline["approvals"] = json!([])),
            Box::new(|c| c.presales.as_mut().unwrap().approval_bindings.clear()),
            Box::new(|c| {
                c.presales
                    .as_mut()
                    .unwrap()
                    .basis
                    .details
                    .as_mut()
                    .unwrap()
                    .design_hash = "a".repeat(64)
            }),
            Box::new(|c| {
                c.presales.as_mut().unwrap().draft.details.as_mut().unwrap()["designs"][0]
                    ["layout"] = json!("tampered")
            }),
            Box::new(|c| {
                let p = c.presales.as_mut().unwrap();
                p.skill.version = "old-version".into();
                for approval in &mut p.approval_bindings {
                    approval.skill = p.skill.clone();
                }
            }),
        ];
        for mutate in mutations {
            let mut bad = checkpoint.clone();
            mutate(&mut bad);
            assert!(ValidatedV3ProjectSeed::from_checkpoint(bad, palette.clone()).is_err());
        }
        for bad in [
            VisualStyleState {
                revision: 0,
                ..palette.clone()
            },
            VisualStyleState {
                profile: None,
                ..palette.clone()
            },
            VisualStyleState {
                profile: Some(VisualStyleProfile {
                    primary_color: "red".into(),
                    ..palette.profile.clone().unwrap()
                }),
                ..palette.clone()
            },
        ] {
            assert!(ValidatedV3ProjectSeed::from_checkpoint(checkpoint.clone(), bad).is_err());
        }
    }

    #[test]
    fn page_basis_is_deterministic_and_binds_saved_style_revision() {
        let (checkpoint, palette) = frozen_fixture();
        let first =
            ValidatedV3ProjectSeed::from_checkpoint(checkpoint.clone(), palette.clone()).unwrap();
        let second =
            ValidatedV3ProjectSeed::from_checkpoint(checkpoint.clone(), palette.clone()).unwrap();
        assert_eq!(first.snapshot, second.snapshot);
        let basis = first.snapshot.pages[0].visual_basis.as_ref().unwrap();
        assert_eq!(basis.hash_algorithm, "native-json-sha256-v1");
        assert_eq!(basis.spec.version, "details-v1");
        assert_eq!(basis.design.version, "details-v1");
        assert_eq!(basis.palette.version, "2");
        // Independently computed from the literal fixture using sorted JSON
        // object keys and raw SHA-256, not the production basis helper.
        assert_eq!(
            basis.spec.sha256,
            "19a4676c7083125ed3ba390dbd175153152df838edd68c60209f00d59bf531d2"
        );
        assert_eq!(
            basis.design.sha256,
            "837b5b9fa71c7aefe0951578903b117cfdc3716c8862cb485da659e6e9e8c713"
        );
        assert_ne!(
            basis.spec.sha256,
            checkpoint
                .presales
                .as_ref()
                .unwrap()
                .basis
                .details
                .as_ref()
                .unwrap()
                .content_hash
        );
        assert_ne!(
            basis.design.sha256,
            checkpoint
                .presales
                .as_ref()
                .unwrap()
                .basis
                .details
                .as_ref()
                .unwrap()
                .design_hash
        );
        let changed = ValidatedV3ProjectSeed::from_checkpoint(
            checkpoint,
            VisualStyleState {
                revision: 3,
                ..palette
            },
        )
        .unwrap();
        let changed_basis = changed.snapshot.pages[0].visual_basis.as_ref().unwrap();
        assert_eq!(basis.spec, changed_basis.spec);
        assert_eq!(basis.design, changed_basis.design);
        assert_ne!(basis.palette, changed_basis.palette);
        assert_eq!(basis.palette.sha256, changed_basis.palette.sha256);
    }

    #[test]
    fn populated_catalog_reopens_and_rejects_tampered_frozen_evidence() {
        let (checkpoint, palette) = frozen_fixture();
        let directory = test_tempdir::tempdir().unwrap();
        let path = directory.path().join("v3-frozen.sqlite3");
        let mut store = V3Store::open(&path).unwrap();
        store
            .insert_project(ValidatedV3ProjectSeed::from_checkpoint(checkpoint, palette).unwrap())
            .unwrap();
        let before = store.load_project("frozen-project").unwrap();
        assert_eq!(
            store
                .connection
                .pragma_query_value(None, "foreign_keys", |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        drop(store);
        let reopened = V3Store::open(&path).unwrap();
        assert_eq!(reopened.load_project("frozen-project").unwrap(), before);
        reopened
            .connection
            .execute(
                "UPDATE v3_pages SET basis_json = '{}' WHERE project_id = 'frozen-project'",
                [],
            )
            .unwrap();
        assert!(reopened.load_project("frozen-project").is_err());
        drop(reopened);
    }

    #[test]
    fn read_models_reject_unknown_fields_and_keep_legacy_provenance_absent() {
        let (checkpoint, palette) = frozen_fixture();
        let snapshot = ValidatedV3ProjectSeed::from_checkpoint(checkpoint, palette)
            .unwrap()
            .snapshot;
        let mut encoded = serde_json::to_value(&snapshot).unwrap();
        encoded["trusted"] = json!(true);
        assert!(serde_json::from_value::<V3ProjectSnapshot>(encoded).is_err());
        let mut encoded = serde_json::to_value(&snapshot).unwrap();
        encoded["pages"][0]["trusted"] = json!(true);
        assert!(serde_json::from_value::<V3ProjectSnapshot>(encoded).is_err());
        let version: V3VisualVersion = serde_json::from_value(json!({
            "versionId":"legacy-v1", "sequence":1, "requestId":null, "attemptId":null,
            "basis":null, "image":null, "provenance":null, "createdAt":"2026-09-10T00:00:00Z"
        }))
        .unwrap();
        assert!(version.image.is_none());
        assert!(version.provenance.is_none());
        assert!(version.basis.is_none());
        let tagged = json!({"kind":"legacyImported", "originDigest":"a".repeat(64), "sourceVersionId":"v1", "trusted":true});
        assert!(serde_json::from_value::<V3VisualProvenance>(tagged).is_err());
    }
}

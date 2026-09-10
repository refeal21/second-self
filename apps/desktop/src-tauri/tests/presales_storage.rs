use digital_twin_desktop_lib::{
    database::{
        Database, NewMemoryProposal, NewProject, PersistedArtifact, ProjectMutation, StoredApproval,
    },
    presales::PresalesDraftPair,
    visual_style::{
        SaveVisualStyleInput, VisualCommitContext, VisualGenerationRequest, VisualStyleProfile,
    },
    workbench::WorkbenchService,
};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::cell::Cell;
use std::time::{SystemTime, UNIX_EPOCH};

fn temporary_database(name: &str) -> std::path::PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock is after epoch")
        .as_nanos();
    std::env::temp_dir().join(format!("presales-storage-{name}-{nonce}.sqlite3"))
}

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../fixtures/presales/native-contract.json"
    ))
    .expect("synthetic fixture is valid JSON")
}

fn create_database(path: &std::path::Path, id: &str) -> Database {
    let database = Database::open(path).expect("database opens");
    database
        .insert_project(&NewProject {
            id: id.into(),
            name: "Synthetic proposal".into(),
            goal: "Verify paired persistence".into(),
            created_at: "2026-09-10T00:00:00Z".into(),
        })
        .expect("project is inserted");
    database
}

fn analysis_checkpoint(database: &Database, id: &str) -> Value {
    let source = fixture();
    let mut pipeline = database.get_project(id).unwrap().unwrap().pipeline;
    pipeline["revision"] = json!(2);
    pipeline["project"]["workflowStatus"] = json!("source_analysis");
    pipeline["project"]["updatedAt"] = json!("2026-09-10T00:01:00Z");
    pipeline["sources"] = json!([{
        "id": "source-a", "fileName": "synthetic.txt", "mediaType": "text/plain",
        "relativePath": "sources/source-a.bin", "sha256": "a".repeat(64), "byteLength": 9
    }]);
    pipeline["analysis"] = json!({
        "requestId": "analysis-1",
        "output": source["analysis"],
        "artifactRelativePath": "sources/analysis-1-analysis.json",
        "sha256": "b".repeat(64)
    });
    assert!(database
        .replace_pipeline(id, 1, &pipeline, &[])
        .expect("analysis checkpoint commits"));
    pipeline
}

fn outline_pair() -> PresalesDraftPair {
    let mut pair: PresalesDraftPair =
        serde_json::from_value(fixture()["pair"].clone()).expect("fixture pair is valid");
    pair.details = None;
    pair
}

fn first_paired_checkpoint(database: &Database, id: &str) -> (Value, PresalesDraftPair) {
    let current = analysis_checkpoint(database, id);
    let pair = outline_pair();
    let next = first_paired_checkpoint_from(&current, id, &pair, 3);
    (next, pair)
}

fn first_paired_checkpoint_from(
    current: &Value,
    id: &str,
    pair: &PresalesDraftPair,
    revision: i64,
) -> Value {
    let mut next = current.clone();
    next["revision"] = json!(revision);
    next["project"]["workflowStatus"] = json!("outline_review");
    next["project"]["updatedAt"] = json!("2026-09-10T00:02:00Z");
    next["outline"] = json!({
        "version": {
            "id": format!("{id}-outline-v1"), "projectId": id, "sequence": 1,
            "status": "draft", "createdAt": "2026-09-10T00:02:00Z", "frozenAt": null
        },
        "value": pair.outline["outline"]
    });
    next
}

fn save_first_pair(database: &Database, id: &str) -> (Value, PresalesDraftPair) {
    let (pipeline, pair) = first_paired_checkpoint(database, id);
    database
        .replace_checkpoint_with_artifacts(
            id,
            2,
            &pipeline,
            &pair,
            &[],
            VisualCommitContext::default(),
            || Ok(()),
        )
        .expect("paired save succeeds")
        .expect("paired save is not stale");
    (pipeline, pair)
}

fn outline_approval(current: &Value) -> Value {
    let mut next = current.clone();
    let id = current["project"]["id"].as_str().unwrap();
    let at = "2026-09-10T00:03:00Z";
    next["revision"] = json!(current["revision"].as_i64().unwrap() + 1);
    next["project"]["updatedAt"] = json!(at);
    next["project"]["workflowStatus"] = json!("detail_review");
    next["outline"]["version"]["status"] = json!("frozen");
    next["outline"]["version"]["frozenAt"] = json!(at);
    next["approvals"].as_array_mut().unwrap().push(json!({
        "id": format!("{id}-outline-approval"), "projectId": id,
        "versionId": current["outline"]["version"]["id"],
        "stage": "outline_review", "status": "approved", "decidedAt": at
    }));
    next
}

fn details_draft(current: &Value, pair: &PresalesDraftPair) -> Value {
    let mut next = current.clone();
    let id = current["project"]["id"].as_str().unwrap();
    next["revision"] = json!(current["revision"].as_i64().unwrap() + 1);
    next["project"]["updatedAt"] = json!("2026-09-10T00:04:00Z");
    next["slideSpecs"] = json!({
        "version": {
            "id": format!("{id}-specs-v1"), "projectId": id, "sequence": 1,
            "status": "draft", "createdAt": "2026-09-10T00:04:00Z", "frozenAt": null
        },
        "value": pair.details.as_ref().unwrap()["specs"]
    });
    next
}

fn detail_approval(current: &Value) -> Value {
    let mut next = current.clone();
    let id = current["project"]["id"].as_str().unwrap();
    let at = "2026-09-10T00:05:00Z";
    next["revision"] = json!(current["revision"].as_i64().unwrap() + 1);
    next["project"]["updatedAt"] = json!(at);
    next["project"]["workflowStatus"] = json!("visual_review");
    next["slideSpecs"]["version"]["status"] = json!("frozen");
    next["slideSpecs"]["version"]["frozenAt"] = json!(at);
    next["currentSlideId"] = current["slideSpecs"]["value"][0]["id"].clone();
    next["approvals"].as_array_mut().unwrap().push(json!({
        "id": format!("{id}-detail-approval"), "projectId": id,
        "versionId": current["slideSpecs"]["version"]["id"],
        "stage": "detail_review", "status": "approved", "decidedAt": at
    }));
    next
}

fn replace_raw_pipeline(path: &std::path::Path, id: &str, pipeline: &Value) {
    let raw = Connection::open(path).unwrap();
    raw.execute(
        "UPDATE projects SET pipeline_json=?2 WHERE id=?1",
        rusqlite::params![id, serde_json::to_string(pipeline).unwrap()],
    )
    .unwrap();
}

#[test]
fn paired_checkpoint_is_returned_and_reloaded_at_the_exact_revision() {
    let path = temporary_database("roundtrip");
    let id = "project-paired-roundtrip";
    let database = create_database(&path, id);
    let (pipeline, pair) = first_paired_checkpoint(&database, id);

    let saved = database
        .replace_checkpoint_with_artifacts(
            id,
            2,
            &pipeline,
            &pair,
            &[],
            VisualCommitContext::default(),
            || Ok(()),
        )
        .expect("paired save succeeds")
        .expect("paired save is not stale");
    let saved_presales = saved.presales.expect("companion is returned");
    assert_eq!(saved.pipeline, pipeline);
    assert_eq!(saved_presales.draft, pair);
    assert_eq!(saved_presales.basis.analysis.request_id, "analysis-1");
    assert_eq!(
        saved_presales.basis.outline.version_id,
        format!("{id}-outline-v1")
    );
    drop(database);

    let reopened = Database::open(&path).expect("database reopens");
    let loaded = reopened
        .load_project_checkpoint(id)
        .expect("paired checkpoint reloads");
    assert_eq!(loaded.pipeline, pipeline);
    assert_eq!(loaded.presales, Some(saved_presales));

    std::fs::remove_file(path).expect("temporary database is removed");
}

#[test]
fn paired_stale_cas_is_none_and_missing_or_corrupt_exact_snapshot_fails_closed() {
    for (name, replacement) in [("missing", None), ("corrupt", Some("{}"))] {
        let path = temporary_database(name);
        let id = format!("project-{name}");
        let database = create_database(&path, &id);
        let (pipeline, pair) = save_first_pair(&database, &id);
        let stale = pipeline.clone();
        assert!(database
            .replace_checkpoint_with_artifacts(
                &id,
                2,
                &stale,
                &pair,
                &[],
                VisualCommitContext::default(),
                || Ok(()),
            )
            .expect("stale paired CAS is observable")
            .is_none());
        assert_eq!(
            database.get_project(&id).unwrap().unwrap().pipeline,
            pipeline
        );
        drop(database);

        let raw = Connection::open(&path).unwrap();
        match replacement {
            None => {
                raw.execute(
                    "DELETE FROM presales_checkpoints WHERE project_id=?1 AND pipeline_revision=3",
                    [&id],
                )
                .unwrap();
            }
            Some(encoded) => {
                raw.execute(
                    "UPDATE presales_checkpoints SET snapshot_json=?2 WHERE project_id=?1 AND pipeline_revision=3",
                    rusqlite::params![id, encoded],
                )
                .unwrap();
            }
        }
        drop(raw);
        let reopened = Database::open(&path).unwrap();
        assert!(reopened.load_project_checkpoint(&id).is_err());
        drop(reopened);
        std::fs::remove_file(path).unwrap();
    }
}

#[test]
fn checkpoint_reload_preserves_a_valid_saved_skill_identity() {
    let path = temporary_database("saved-skill");
    let id = "project-saved-skill";
    let database = create_database(&path, id);
    save_first_pair(&database, id);
    drop(database);
    let raw = Connection::open(&path).unwrap();
    let encoded: String = raw
        .query_row(
            "SELECT snapshot_json FROM presales_checkpoints WHERE project_id=?1 AND pipeline_revision=3",
            [id],
            |row| row.get(0),
        )
        .unwrap();
    let mut snapshot: Value = serde_json::from_str(&encoded).unwrap();
    snapshot["skill"]["version"] = json!("0.9.0");
    snapshot["skill"]["sha256"] = json!("0".repeat(64));
    raw.execute(
        "UPDATE presales_checkpoints SET snapshot_json=?2 WHERE project_id=?1 AND pipeline_revision=3",
        rusqlite::params![id, serde_json::to_string(&snapshot).unwrap()],
    )
    .unwrap();
    drop(raw);
    let reopened = Database::open(&path).unwrap();
    let skill = reopened
        .load_project_checkpoint(id)
        .unwrap()
        .presales
        .unwrap()
        .skill;
    assert_eq!(skill.version, "0.9.0");
    assert_eq!(skill.sha256, "0".repeat(64));
    drop(reopened);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn first_enable_rejects_prior_freeze_and_inconsistent_submitted_draft_metadata() {
    let path = temporary_database("first-enable-freeze");
    let id = "project-first-enable-freeze";
    let database = create_database(&path, id);
    let current = analysis_checkpoint(&database, id);
    let pair = outline_pair();

    let mut inconsistent = first_paired_checkpoint_from(&current, id, &pair, 3);
    inconsistent["outline"]["version"]["frozenAt"] = json!("2026-09-10T00:02:00Z");
    assert!(database
        .replace_checkpoint_with_artifacts(
            id,
            2,
            &inconsistent,
            &pair,
            &[],
            VisualCommitContext::default(),
            || Ok(()),
        )
        .is_err());

    let mut frozen = first_paired_checkpoint_from(&current, id, &pair, 3);
    frozen["outline"]["version"]["status"] = json!("frozen");
    frozen["outline"]["version"]["frozenAt"] = json!("2026-09-10T00:02:00Z");
    assert!(database.replace_pipeline(id, 2, &frozen, &[]).unwrap());
    let mut attempted = frozen.clone();
    attempted["revision"] = json!(4);
    attempted["project"]["updatedAt"] = json!("2026-09-10T00:03:00Z");
    attempted["outline"]["version"]["status"] = json!("draft");
    attempted["outline"]["version"]["frozenAt"] = Value::Null;
    assert!(database
        .replace_checkpoint_with_artifacts(
            id,
            3,
            &attempted,
            &pair,
            &[],
            VisualCommitContext::default(),
            || Ok(()),
        )
        .is_err());
    drop(database);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn first_enable_rejects_relational_content_approval_history_atomically() {
    let path = temporary_database("relational-approval");
    let id = "project-relational-approval";
    let database = create_database(&path, id);
    let current = analysis_checkpoint(&database, id);
    database
        .insert_approval(&StoredApproval {
            id: "prior-content-approval".into(),
            project_id: id.into(),
            version_id: "legacy-outline".into(),
            stage: "outline_review".into(),
            slide_id: None,
            status: "pending".into(),
            title: "Prior content approval".into(),
            detail: "Must block opt-in".into(),
            author: "local".into(),
            created_at: "2026-09-10T00:01:30Z".into(),
            decided_at: None,
        })
        .unwrap();
    let pair = outline_pair();
    let next = first_paired_checkpoint_from(&current, id, &pair, 3);
    assert!(database
        .replace_checkpoint_with_artifacts(
            id,
            2,
            &next,
            &pair,
            &[],
            VisualCommitContext::default(),
            || Ok(()),
        )
        .is_err());
    assert_eq!(database.list_pending_approvals().unwrap().len(), 1);
    let raw = Connection::open(&path).unwrap();
    let markers: i64 = raw
        .query_row("SELECT COUNT(*) FROM presales_projects", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(markers, 0);
    drop(raw);
    drop(database);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn reload_and_next_commit_reject_divergent_paired_lifecycle_state() {
    let path = temporary_database("lifecycle-corruption");
    let id = "project-lifecycle-corruption";
    let database = create_database(&path, id);
    let (draft, pair) = save_first_pair(&database, id);

    let mut missing_slot = draft.clone();
    missing_slot.as_object_mut().unwrap().remove("slideSpecs");
    replace_raw_pipeline(&path, id, &missing_slot);
    assert!(database.load_project_checkpoint(id).is_err());

    let mut frozen_without_proof = draft.clone();
    frozen_without_proof["outline"]["version"]["status"] = json!("frozen");
    frozen_without_proof["outline"]["version"]["frozenAt"] = json!("2026-09-10T00:03:00Z");
    replace_raw_pipeline(&path, id, &frozen_without_proof);
    assert!(database.load_project_checkpoint(id).is_err());

    let mut wrong_workflow = draft.clone();
    wrong_workflow["project"]["workflowStatus"] = json!("detail_review");
    replace_raw_pipeline(&path, id, &wrong_workflow);
    assert!(database.load_project_checkpoint(id).is_err());
    replace_raw_pipeline(&path, id, &draft);

    let approved = outline_approval(&draft);
    database
        .replace_checkpoint_with_artifacts(
            id,
            3,
            &approved,
            &pair,
            &[],
            VisualCommitContext::default(),
            || Ok(()),
        )
        .unwrap()
        .unwrap();
    let mut wrong_time = approved.clone();
    wrong_time["outline"]["version"]["frozenAt"] = json!("2026-09-10T00:03:01Z");
    replace_raw_pipeline(&path, id, &wrong_time);
    assert!(database.load_project_checkpoint(id).is_err());
    let mut next = wrong_time.clone();
    next["revision"] = json!(5);
    next["project"]["updatedAt"] = json!("2026-09-10T00:04:00Z");
    assert!(database
        .replace_checkpoint_with_artifacts(
            id,
            4,
            &next,
            &pair,
            &[],
            VisualCommitContext::default(),
            || Ok(()),
        )
        .is_err());
    drop(database);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn reload_rejects_reordered_joint_approval_proofs() {
    let path = temporary_database("approval-order");
    let id = "project-approval-order";
    let database = create_database(&path, id);
    let (outline, outline_pair) = save_first_pair(&database, id);
    let approved_outline = outline_approval(&outline);
    database
        .replace_checkpoint_with_artifacts(
            id,
            3,
            &approved_outline,
            &outline_pair,
            &[],
            VisualCommitContext::default(),
            || Ok(()),
        )
        .unwrap()
        .unwrap();
    let full_pair: PresalesDraftPair = serde_json::from_value(fixture()["pair"].clone()).unwrap();
    let details = details_draft(&approved_outline, &full_pair);
    database
        .replace_checkpoint_with_artifacts(
            id,
            4,
            &details,
            &full_pair,
            &[],
            VisualCommitContext::default(),
            || Ok(()),
        )
        .unwrap()
        .unwrap();
    let approved_details = detail_approval(&details);
    database
        .replace_checkpoint_with_artifacts(
            id,
            5,
            &approved_details,
            &full_pair,
            &[],
            VisualCommitContext::default(),
            || Ok(()),
        )
        .unwrap()
        .unwrap();
    let mut reordered = approved_details;
    reordered["approvals"].as_array_mut().unwrap().reverse();
    replace_raw_pipeline(&path, id, &reordered);
    assert!(database.load_project_checkpoint(id).is_err());
    drop(database);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn reload_and_next_commit_reject_pipeline_proof_id_divergence() {
    let path = temporary_database("approval-id-divergence");
    let id = "project-approval-id-divergence";
    let database = create_database(&path, id);
    let (outline, pair) = save_first_pair(&database, id);
    let approved = outline_approval(&outline);
    database
        .replace_checkpoint_with_artifacts(
            id,
            3,
            &approved,
            &pair,
            &[],
            VisualCommitContext::default(),
            || Ok(()),
        )
        .unwrap()
        .unwrap();

    let mut corrupted = approved;
    corrupted["approvals"][0]["id"] = json!("different-pipeline-proof-id");
    replace_raw_pipeline(&path, id, &corrupted);
    let reload_rejected = database.load_project_checkpoint(id).is_err();
    let mut next = corrupted;
    next["revision"] = json!(5);
    next["project"]["updatedAt"] = json!("2026-09-10T00:04:00Z");
    let commit_rejected = database
        .replace_checkpoint_with_artifacts(
            id,
            4,
            &next,
            &pair,
            &[],
            VisualCommitContext::default(),
            || Ok(()),
        )
        .is_err();
    assert!(reload_rejected);
    assert!(commit_rejected);
    drop(database);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn invalid_half_and_callback_failure_leave_no_marker_or_relational_changes() {
    let path = temporary_database("rollback");
    let id = "project-rollback";
    let database = create_database(&path, id);
    let (pipeline, _) = first_paired_checkpoint(&database, id);
    let pair: PresalesDraftPair = serde_json::from_value(fixture()["pair"].clone()).unwrap();
    let called = Cell::new(false);
    assert!(database
        .replace_checkpoint_with_artifacts(
            id,
            2,
            &pipeline,
            &pair,
            &[],
            VisualCommitContext::default(),
            || {
                called.set(true);
                Ok(())
            },
        )
        .is_err());
    assert!(!called.get());

    let pair = outline_pair();
    let artifact = PersistedArtifact {
        id: "artifact-rollback".into(),
        version_id: format!("{id}-outline-v1"),
        path: "outline/outline-r3.json".into(),
        kind: "outline".into(),
        created_at: "2026-09-10T00:02:00Z".into(),
    };
    assert!(database
        .replace_checkpoint_with_artifacts(
            id,
            2,
            &pipeline,
            &pair,
            &[artifact],
            VisualCommitContext::default(),
            || Err("synthetic filesystem failure".into()),
        )
        .is_err());
    assert_eq!(
        database.get_project(id).unwrap().unwrap().pipeline["revision"],
        2
    );
    assert_eq!(database.persistence_counts(id).unwrap().artifacts, 0);
    let raw = Connection::open(&path).unwrap();
    let markers: i64 = raw
        .query_row("SELECT COUNT(*) FROM presales_projects", [], |row| {
            row.get(0)
        })
        .unwrap();
    let snapshots: i64 = raw
        .query_row("SELECT COUNT(*) FROM presales_checkpoints", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!((markers, snapshots), (0, 0));
    drop(raw);
    drop(database);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn exact_joint_approvals_freeze_the_bound_pair_and_reject_forgery() {
    let path = temporary_database("approvals");
    let id = "project-approvals";
    let database = create_database(&path, id);
    let (outline, outline_pair) = save_first_pair(&database, id);

    let mut forged = outline.clone();
    forged["revision"] = json!(4);
    forged["project"]["updatedAt"] = json!("2026-09-10T00:03:00Z");
    forged["project"]["workflowStatus"] = json!("detail_review");
    forged["outline"]["version"]["status"] = json!("frozen");
    forged["outline"]["version"]["frozenAt"] = json!("2026-09-10T00:03:00Z");
    assert!(database
        .replace_checkpoint_with_artifacts(
            id,
            3,
            &forged,
            &outline_pair,
            &[],
            VisualCommitContext::default(),
            || Ok(()),
        )
        .is_err());

    let approved_outline = outline_approval(&outline);
    let mut stale_plan = outline_pair.clone();
    stale_plan.outline["plan"]["pages"][0]["keyMessage"] = json!("Changed during approval");
    assert!(database
        .replace_checkpoint_with_artifacts(
            id,
            3,
            &approved_outline,
            &stale_plan,
            &[],
            VisualCommitContext::default(),
            || Ok(()),
        )
        .is_err());

    let saved = database
        .replace_checkpoint_with_artifacts(
            id,
            3,
            &approved_outline,
            &outline_pair,
            &[],
            VisualCommitContext::default(),
            || Ok(()),
        )
        .unwrap()
        .unwrap();
    assert_eq!(saved.presales.unwrap().approval_bindings.len(), 1);

    let full_pair: PresalesDraftPair = serde_json::from_value(fixture()["pair"].clone()).unwrap();
    let details = details_draft(&approved_outline, &full_pair);
    let mut pre_frozen_details = details.clone();
    pre_frozen_details["slideSpecs"]["version"]["status"] = json!("frozen");
    pre_frozen_details["slideSpecs"]["version"]["frozenAt"] = json!("2026-09-10T00:04:00Z");
    assert!(database
        .replace_checkpoint_with_artifacts(
            id,
            4,
            &pre_frozen_details,
            &full_pair,
            &[],
            VisualCommitContext::default(),
            || Ok(()),
        )
        .is_err());
    database
        .replace_checkpoint_with_artifacts(
            id,
            4,
            &details,
            &full_pair,
            &[],
            VisualCommitContext::default(),
            || Ok(()),
        )
        .unwrap()
        .unwrap();
    let approved_details = detail_approval(&details);
    let final_checkpoint = database
        .replace_checkpoint_with_artifacts(
            id,
            5,
            &approved_details,
            &full_pair,
            &[],
            VisualCommitContext::default(),
            || Ok(()),
        )
        .unwrap()
        .unwrap();
    let bindings = final_checkpoint.presales.unwrap().approval_bindings;
    assert_eq!(bindings.len(), 2);
    assert_eq!(bindings[0].stage, "outline_review");
    assert_eq!(bindings[1].stage, "detail_review");
    assert_eq!(
        database.load_project_checkpoint(id).unwrap().pipeline,
        approved_details
    );
    drop(database);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn enabled_projects_reject_bare_writers_while_unrelated_storage_remains_available() {
    let path = temporary_database("guards");
    let id = "project-guards";
    let database = create_database(&path, id);
    let (pipeline, _) = save_first_pair(&database, id);
    let mut next = pipeline.clone();
    next["revision"] = json!(4);
    next["project"]["updatedAt"] = json!("2026-09-10T00:03:00Z");
    assert!(database.replace_pipeline(id, 3, &next, &[]).is_err());
    assert!(database.rename_project(id, "forbidden", "now").is_err());
    assert!(database
        .mutate_project(
            id,
            &ProjectMutation {
                workflow_status: "outline_review".into(),
                progress: 30,
                selected_slide: 1,
                slide_statuses: vec!["waiting".into(); 5],
                export_ready: false,
                slide_notice: "forbidden".into(),
                updated_at: "now".into(),
            },
        )
        .is_err());
    assert!(database
        .insert_approval(&StoredApproval {
            id: "bare-approval".into(),
            project_id: id.into(),
            version_id: "v".into(),
            stage: "outline_review".into(),
            slide_id: None,
            status: "pending".into(),
            title: "bare".into(),
            detail: "bare".into(),
            author: "local".into(),
            created_at: "now".into(),
            decided_at: None,
        })
        .is_err());
    let raw = Connection::open(&path).unwrap();
    raw.execute(
        "INSERT INTO approvals
         (id,project_id,version_id,stage,status,title,detail,author,created_at)
         VALUES ('raw-pending',?1,'v','detail_review','pending','','','','now')",
        [id],
    )
    .unwrap();
    drop(raw);
    assert!(database
        .decide_approval("raw-pending", "rejected", "2026-09-10T00:06:00Z")
        .is_err());
    database.save_setting("presales-test", "allowed").unwrap();
    database
        .insert_memory_proposal(&NewMemoryProposal {
            id: "memory-allowed".into(),
            title: "Allowed".into(),
            content: "Allowed".into(),
            created_at: "2026-09-10T00:06:00Z".into(),
        })
        .unwrap();
    assert_eq!(
        database.setting("presales-test").unwrap().as_deref(),
        Some("allowed")
    );
    drop(database);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn legacy_checkpoint_roundtrip_still_has_no_companion() {
    let database = Database::open_in_memory().unwrap();
    let id = "project-legacy";
    database
        .insert_project(&NewProject {
            id: id.into(),
            name: "Legacy".into(),
            goal: "Unchanged".into(),
            created_at: "2026-09-10T00:00:00Z".into(),
        })
        .unwrap();
    let pipeline = analysis_checkpoint(&database, id);
    let checkpoint = database.load_project_checkpoint(id).unwrap();
    assert_eq!(checkpoint.pipeline, pipeline);
    assert!(checkpoint.presales.is_none());
}

#[test]
fn competing_paired_writers_publish_one_whole_checkpoint() {
    let path = temporary_database("concurrency");
    let id = "project-concurrency";
    let database = create_database(&path, id);
    let (current, pair) = save_first_pair(&database, id);
    drop(database);

    let mut next = current.clone();
    next["revision"] = json!(4);
    next["project"]["updatedAt"] = json!("2026-09-10T00:03:00Z");
    let mut first_pair = pair.clone();
    first_pair.outline["plan"]["pages"][0]["keyMessage"] = json!("First complete pair");
    let mut second_pair = pair;
    second_pair.outline["plan"]["pages"][0]["keyMessage"] = json!("Second complete pair");

    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let first_path = path.clone();
    let first_next = next.clone();
    let first_pair_for_thread = first_pair.clone();
    let first = std::thread::spawn(move || {
        let database = Database::open(first_path).unwrap();
        database.replace_checkpoint_with_artifacts(
            id,
            3,
            &first_next,
            &first_pair_for_thread,
            &[],
            VisualCommitContext::default(),
            || {
                entered_tx.send(()).unwrap();
                std::thread::sleep(std::time::Duration::from_millis(150));
                Ok(())
            },
        )
    });
    entered_rx.recv().unwrap();
    let second_path = path.clone();
    let second_next = next.clone();
    let second = std::thread::spawn(move || {
        let database = Database::open(second_path).unwrap();
        database.replace_checkpoint_with_artifacts(
            id,
            3,
            &second_next,
            &second_pair,
            &[],
            VisualCommitContext::default(),
            || Ok(()),
        )
    });
    assert!(first.join().unwrap().unwrap().is_some());
    match second.join().unwrap() {
        Ok(result) => assert!(result.is_none()),
        Err(error) => assert!(error.to_string().contains("locked")),
    }
    let reopened = Database::open(&path).unwrap();
    let loaded = reopened.load_project_checkpoint(id).unwrap();
    assert_eq!(loaded.presales.unwrap().draft, first_pair);
    let raw = Connection::open(&path).unwrap();
    let revision_four: i64 = raw
        .query_row(
            "SELECT COUNT(*) FROM presales_checkpoints WHERE project_id=?1 AND pipeline_revision=4",
            [id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(revision_four, 1);
    drop(raw);
    drop(reopened);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn visual_request_start_is_rejected_but_style_storage_remains_available() {
    let path = temporary_database("visual-guard");
    let workspace = std::env::temp_dir().join(format!(
        "presales-visual-workspace-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let id = "project-visual-guard";
    let database = create_database(&path, id);
    save_first_pair(&database, id);
    drop(database);
    let service = WorkbenchService::open(&path, &workspace).unwrap();
    service
        .save_visual_style(SaveVisualStyleInput {
            project_id: id.into(),
            expected_revision: 3,
            expected_style_revision: 0,
            profile: VisualStyleProfile {
                primary_color: "#112233".into(),
                background_color: "#ffffff".into(),
                text_color: "#000000".into(),
                accent_colors: vec!["#445566".into()],
                instructions: "Synthetic style".into(),
                template: None,
            },
            template_base64: None,
        })
        .unwrap();
    let error = service
        .begin_visual_request(VisualGenerationRequest {
            id: "request-blocked".into(),
            project_id: id.into(),
            expected_revision: 3,
            style_revision: 1,
            slide_id: "scenario-1".into(),
            kind: "imagegen".into(),
            prompt: "Synthetic prompt".into(),
            feedback: String::new(),
            prompt_version: "synthetic-v1".into(),
        })
        .unwrap_err();
    assert!(error.contains("Presales visual generation"));
    drop(service);
    std::fs::remove_dir_all(workspace).unwrap();
    std::fs::remove_file(path).unwrap();
}

#[test]
fn legacy_writer_cannot_replace_an_enabled_projects_artifact_identity() {
    let path = temporary_database("artifact-owner");
    let paired_id = "project-artifact-owner";
    let database = create_database(&path, paired_id);
    let (pipeline, pair) = first_paired_checkpoint(&database, paired_id);
    let artifact = PersistedArtifact {
        id: "paired-outline-r3".into(),
        version_id: format!("{paired_id}-outline-v1"),
        path: "outline/outline-r3.json".into(),
        kind: "outline".into(),
        created_at: "2026-09-10T00:02:00Z".into(),
    };
    database
        .replace_checkpoint_with_artifacts(
            paired_id,
            2,
            &pipeline,
            &pair,
            std::slice::from_ref(&artifact),
            VisualCommitContext::default(),
            || Ok(()),
        )
        .unwrap()
        .unwrap();

    let legacy_id = "project-artifact-attacker";
    database
        .insert_project(&NewProject {
            id: legacy_id.into(),
            name: "Legacy".into(),
            goal: "Collision".into(),
            created_at: "2026-09-10T01:00:00Z".into(),
        })
        .unwrap();
    let mut legacy = database.get_project(legacy_id).unwrap().unwrap().pipeline;
    legacy["revision"] = json!(2);
    legacy["project"]["updatedAt"] = json!("2026-09-10T01:01:00Z");
    let collision = PersistedArtifact {
        id: artifact.id.clone(),
        version_id: "legacy-v1".into(),
        path: "legacy/replacement.json".into(),
        kind: "legacy".into(),
        created_at: "2026-09-10T01:01:00Z".into(),
    };
    assert!(database
        .replace_pipeline(legacy_id, 1, &legacy, &[collision])
        .is_err());
    let raw = Connection::open(&path).unwrap();
    let owner: String = raw
        .query_row(
            "SELECT project_id FROM artifacts WHERE id='paired-outline-r3'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(owner, paired_id);
    drop(raw);
    drop(database);
    std::fs::remove_file(path).unwrap();
}

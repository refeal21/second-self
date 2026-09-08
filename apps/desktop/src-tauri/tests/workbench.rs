use std::time::{SystemTime, UNIX_EPOCH};

use digital_twin_desktop_lib::workbench::{
    ArtifactWriteInput, AttachSourceInput, CreateProjectInput, PipelineCommitInput,
    SlideMutationInput, WorkbenchService,
};

fn temporary_root(name: &str) -> std::path::PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock is after epoch")
        .as_nanos();
    std::env::temp_dir().join(format!("digital-twin-workbench-{name}-{nonce}"))
}

fn synthetic_revision_base(service: &WorkbenchService) -> serde_json::Value {
    let project = service
        .create_project(CreateProjectInput {
            name: "合成修订".into(),
            goal: "验证保存".into(),
        })
        .unwrap();
    let mut base = service.load_pipeline(&project.id).unwrap();
    base["revision"] = 2.into();
    base["project"]["workflowStatus"] = "detail_review".into();
    base["outline"] = serde_json::json!({"version": {"id": format!("{}-outline-v1", project.id), "projectId": project.id,
        "sequence": 1, "status": "frozen", "createdAt": "2026-09-08T01:00:00Z", "frozenAt": "2026-09-08T01:01:00Z"},
        "value": {"title": "合成大纲", "slides": [{"id": "page-one", "title": "第一页", "purpose": "介绍"}]}});
    base["slideSpecs"] = serde_json::json!({"version": {"id": format!("{}-slide-specs-v1", project.id), "projectId": project.id,
        "sequence": 1, "status": "draft", "createdAt": "2026-09-08T01:00:00Z", "frozenAt": null},
        "value": [{"id": "page-one", "title": "第一页", "body": ["合成正文"]}]});
    base["approvals"] = serde_json::json!([{"id": format!("{}-outline_review-1", project.id), "projectId": project.id,
        "versionId": format!("{}-outline-v1", project.id), "stage": "outline_review", "status": "approved", "decidedAt": "2026-09-08T01:01:00Z"}]);
    let writes = vec![
        json_artifact(
            "outline/outline-v1.json",
            "outline",
            base["outline"]["version"]["id"].as_str().unwrap(),
            &base["outline"]["value"],
        ),
        json_artifact(
            "slide-specs/slide-specs-v1.json",
            "slide-specs",
            base["slideSpecs"]["version"]["id"].as_str().unwrap(),
            &serde_json::json!({"outlineVersionId": base["outline"]["version"]["id"], "specs": base["slideSpecs"]["value"]}),
        ),
    ];
    service
        .commit_pipeline(PipelineCommitInput {
            project_id: project.id,
            expected_revision: 1,
            pipeline: base,
            writes,
        })
        .unwrap()
}

fn json_artifact(
    path: &str,
    kind: &str,
    version_id: &str,
    value: &serde_json::Value,
) -> ArtifactWriteInput {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    let bytes = serde_json::to_vec(value).unwrap();
    ArtifactWriteInput {
        relative_path: path.into(),
        contents_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        sha256: format!("{:x}", Sha256::digest(&bytes)),
        byte_length: bytes.len(),
        kind: kind.into(),
        version_id: version_id.into(),
        slide_id: None,
        metadata: None,
    }
}

fn origin_write(base: &serde_json::Value) -> ArtifactWriteInput {
    json_artifact(
        "history/checkpoint-v1-r2.json",
        "pipeline-origin",
        "checkpoint-r2",
        base,
    )
}

fn synthetic_pending(base: &serde_json::Value) -> serde_json::Value {
    let mut next = base.clone();
    next["schemaVersion"] = 2.into();
    next["revision"] = 3.into();
    next["project"]["updatedAt"] = "2026-09-08T02:00:00Z".into();
    next["revisionOrigin"] = base.clone();
    next["revisionHistory"] = serde_json::json!([]);
    let mut outline = base["outline"]["value"].clone();
    outline["slides"][0]["purpose"] = "人工修改目的".into();
    next["outlineRevisionDraft"] = serde_json::json!({"id": "revision-one", "baseOutlineVersionId": base["outline"]["version"]["id"],
        "outline": outline, "specs": base["slideSpecs"]["value"], "createdAt": "2026-09-08T02:00:00Z", "updatedAt": "2026-09-08T02:00:00Z"});
    next["revisionEvents"] = serde_json::json!([{"kind": "outline.revision.save", "at": "2026-09-08T02:00:00Z", "expectedRevision": 2,
        "revisionId": "revision-one", "baseOutlineVersionId": base["outline"]["version"]["id"], "outline": outline, "specs": base["slideSpecs"]["value"]}]);
    next
}

fn synthetic_confirmed(
    pending: &serde_json::Value,
) -> (serde_json::Value, Vec<ArtifactWriteInput>) {
    let mut next = pending.clone();
    let id = pending["project"]["id"].as_str().unwrap();
    let at = "2026-09-08T03:00:00Z";
    next["revision"] = 4.into();
    next["project"]["updatedAt"] = at.into();
    for (field, kind, status) in [
        ("outline", "outline", "frozen"),
        ("slideSpecs", "slide-specs", "draft"),
    ] {
        next[field]["version"] = serde_json::json!({"id": format!("{id}-{kind}-v2"), "projectId": id, "sequence": 2,
            "status": status, "createdAt": at, "frozenAt": if status == "frozen" { serde_json::json!(at) } else { serde_json::Value::Null }});
    }
    next["outline"]["value"] = pending["outlineRevisionDraft"]["outline"].clone();
    next["slideSpecs"]["value"] = pending["outlineRevisionDraft"]["specs"].clone();
    next["outlineRevisionDraft"] = serde_json::Value::Null;
    next["revisionHistory"] = serde_json::json!([{"id": "revision-one", "status": "confirmed", "baseOutline": pending["outline"],
        "baseSlideSpecs": pending["slideSpecs"], "draft": pending["outlineRevisionDraft"], "decidedAt": at, "newOutlineVersionId": format!("{id}-outline-v2")}]);
    next["approvals"].as_array_mut().unwrap().push(serde_json::json!({"id": format!("{id}-outline_review-2"), "projectId": id,
        "versionId": format!("{id}-outline-v2"), "stage": "outline_review", "status": "approved", "decidedAt": at}));
    next["revisionEvents"].as_array_mut().unwrap().push(serde_json::json!({"kind": "outline.revision.approve", "at": at,
        "expectedRevision": 3, "revisionId": "revision-one", "baseOutlineVersionId": format!("{id}-outline-v1")}));
    let writes = vec![
        json_artifact(
            "outline/outline-v2.json",
            "outline",
            &format!("{id}-outline-v2"),
            &next["outline"]["value"],
        ),
        json_artifact(
            "slide-specs/slide-specs-v2.json",
            "slide-specs",
            &format!("{id}-slide-specs-v2"),
            &serde_json::json!({"outlineVersionId": format!("{id}-outline-v2"), "specs": next["slideSpecs"]["value"]}),
        ),
        json_artifact(
            "history/revision-one.json",
            "outline-revision-history",
            "revision-one",
            &next["revisionHistory"][0],
        ),
    ];
    (next, writes)
}

#[test]
fn native_revision_origin_and_frozen_artifacts_are_immutable() {
    let root = temporary_root("revision-immutable");
    std::fs::create_dir_all(&root).unwrap();
    let workspace = root.join("workspace");
    let service = WorkbenchService::open(root.join("state.sqlite3"), &workspace).unwrap();
    let base = synthetic_revision_base(&service);
    let id = base["project"]["id"].as_str().unwrap();
    let pending = synthetic_pending(&base);
    service
        .commit_pipeline(PipelineCommitInput {
            project_id: id.into(),
            expected_revision: 2,
            pipeline: pending.clone(),
            writes: vec![origin_write(&base)],
        })
        .unwrap();
    let mut forged = pending.clone();
    assert!(
        service.approve_details(id).is_err(),
        "legacy summary transition must not bypass native pending revision"
    );
    forged["revision"] = 4.into();
    forged["revisionOrigin"]["slideSpecs"]["value"][0]["body"] = serde_json::json!(["篡改原文"]);
    assert!(
        service
            .commit_pipeline(PipelineCommitInput {
                project_id: id.into(),
                expected_revision: 3,
                pipeline: forged,
                writes: vec![]
            })
            .is_err(),
        "cannot rewrite immutable origin"
    );
    assert_eq!(service.load_pipeline(id).unwrap(), pending);
    assert!(
        service
            .commit_pipeline(PipelineCommitInput {
                project_id: id.into(),
                expected_revision: 2,
                pipeline: pending,
                writes: vec![]
            })
            .is_err(),
        "stale CAS must fail"
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn revision_upgrade_requires_its_exact_origin_artifact() {
    let root = temporary_root("revision-origin-write");
    std::fs::create_dir_all(&root).unwrap();
    let service =
        WorkbenchService::open(root.join("state.sqlite3"), root.join("workspace")).unwrap();
    let base = synthetic_revision_base(&service);
    let id = base["project"]["id"].as_str().unwrap();
    assert!(
        service
            .commit_pipeline(PipelineCommitInput {
                project_id: id.into(),
                expected_revision: 2,
                pipeline: synthetic_pending(&base),
                writes: vec![]
            })
            .is_err(),
        "upgrade must archive its v1 origin"
    );
    assert_eq!(service.load_pipeline(id).unwrap(), base);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn renaming_v2_changes_display_metadata_without_rewriting_workflow_time_or_origin() {
    let root = temporary_root("revision-rename");
    std::fs::create_dir_all(&root).unwrap();
    let db_path = root.join("state.sqlite3");
    let service = WorkbenchService::open(&db_path, root.join("workspace")).unwrap();
    let base = synthetic_revision_base(&service);
    let id = base["project"]["id"].as_str().unwrap();
    let pending = synthetic_pending(&base);
    service
        .commit_pipeline(PipelineCommitInput {
            project_id: id.into(),
            expected_revision: 2,
            pipeline: pending.clone(),
            writes: vec![origin_write(&base)],
        })
        .unwrap();
    service
        .rename_project(id, "重命名后的合成项目".into())
        .unwrap();
    let renamed = service.load_pipeline(id).unwrap();
    assert_eq!(renamed["project"]["name"], "重命名后的合成项目");
    assert_eq!(
        renamed["project"]["updatedAt"],
        pending["project"]["updatedAt"]
    );
    assert_eq!(renamed["revisionOrigin"], base);
    let stored = digital_twin_desktop_lib::database::Database::open(&db_path)
        .unwrap()
        .get_project(id)
        .unwrap()
        .unwrap();
    assert_eq!(stored.name, "重命名后的合成项目");
    assert!(stored.updated_at.starts_with("unix:"));
    let (confirmed, writes) = synthetic_confirmed(&renamed);
    service
        .commit_pipeline(PipelineCommitInput {
            project_id: id.into(),
            expected_revision: 3,
            pipeline: confirmed,
            writes,
        })
        .unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn revision_confirm_rolls_back_new_files_when_a_later_write_fails_then_restarts_with_history() {
    let root = temporary_root("revision-confirm-transaction");
    std::fs::create_dir_all(&root).unwrap();
    let workspace = root.join("workspace");
    let db_path = root.join("state.sqlite3");
    let service = WorkbenchService::open(&db_path, &workspace).unwrap();
    let base = synthetic_revision_base(&service);
    let id = base["project"]["id"].as_str().unwrap();
    let original_version_row = || {
        rusqlite::Connection::open(&db_path)
            .unwrap()
            .query_row(
                "SELECT sequence, status, created_at, frozen_at FROM versions WHERE id = ?1",
                [format!("{id}-outline-v1")],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                },
            )
            .unwrap()
    };
    let original_version = original_version_row();
    let old_bytes = std::fs::read(workspace.join(id).join("outline/outline-v1.json")).unwrap();
    let pending = synthetic_pending(&base);
    service
        .commit_pipeline(PipelineCommitInput {
            project_id: id.into(),
            expected_revision: 2,
            pipeline: pending.clone(),
            writes: vec![origin_write(&base)],
        })
        .unwrap();
    let (confirmed, writes) = synthetic_confirmed(&pending);
    let conflict = workspace.join(id).join("slide-specs/slide-specs-v2.json");
    std::fs::write(&conflict, b"existing file must survive").unwrap();
    assert!(service
        .commit_pipeline(PipelineCommitInput {
            project_id: id.into(),
            expected_revision: 3,
            pipeline: confirmed.clone(),
            writes
        })
        .is_err());
    assert_eq!(service.load_pipeline(id).unwrap(), pending);
    assert!(!workspace.join(id).join("outline/outline-v2.json").exists());
    assert!(!workspace
        .join(id)
        .join("history/revision-one.json")
        .exists());
    assert_eq!(
        std::fs::read(&conflict).unwrap(),
        b"existing file must survive"
    );
    assert_eq!(
        std::fs::read(workspace.join(id).join("outline/outline-v1.json")).unwrap(),
        old_bytes
    );
    std::fs::remove_file(conflict).unwrap();
    let (_, writes) = synthetic_confirmed(&pending);
    // A process could stop after syncing an immutable new artifact but before DB commit.
    // Exact orphan bytes can be reused on retry without overwriting or owning that file.
    use base64::Engine;
    std::fs::write(
        workspace.join(id).join("outline/outline-v2.json"),
        base64::engine::general_purpose::STANDARD
            .decode(&writes[0].contents_base64)
            .unwrap(),
    )
    .unwrap();
    service
        .commit_pipeline(PipelineCommitInput {
            project_id: id.into(),
            expected_revision: 3,
            pipeline: confirmed.clone(),
            writes,
        })
        .unwrap();
    assert_eq!(service.persistence_counts(id).unwrap().versions, 4);
    assert_eq!(service.persistence_counts(id).unwrap().approvals, 2);
    assert_eq!(
        original_version_row(),
        original_version,
        "historical frozen SQL version rows must not be rewritten"
    );
    drop(service);
    let reopened = WorkbenchService::open(&db_path, &workspace).unwrap();
    assert_eq!(reopened.load_pipeline(id).unwrap(), confirmed);
    assert_eq!(
        std::fs::read(workspace.join(id).join("outline/outline-v1.json")).unwrap(),
        old_bytes
    );
    let mut next = confirmed.clone();
    next["revision"] = 5.into();
    next["slideSpecs"]["version"]["status"] = "frozen".into();
    next["slideSpecs"]["version"]["frozenAt"] = next["project"]["updatedAt"].clone();
    next["project"]["workflowStatus"] = "visual_review".into();
    let overwrite = json_artifact(
        "outline/outline-v1.json",
        "outline",
        &format!("{id}-outline-v1"),
        &serde_json::json!({"corrupt": true}),
    );
    assert!(reopened
        .commit_pipeline(PipelineCommitInput {
            project_id: id.into(),
            expected_revision: 4,
            pipeline: next,
            writes: vec![overwrite]
        })
        .is_err());
    assert_eq!(
        std::fs::read(workspace.join(id).join("outline/outline-v1.json")).unwrap(),
        old_bytes
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn rejected_pipeline_commit_does_not_leave_new_artifacts() {
    let root = temporary_root("revision-failed-commit");
    std::fs::create_dir_all(&root).unwrap();
    let workspace = root.join("workspace");
    let service = WorkbenchService::open(root.join("state.sqlite3"), &workspace).unwrap();
    let base = synthetic_revision_base(&service);
    let id = base["project"]["id"].as_str().unwrap();
    let mut invalid = base.clone();
    invalid["revision"] = 4.into();
    let write = ArtifactWriteInput {
        relative_path: "outline/new-outline.json".into(),
        contents_base64: "e30K".into(),
        sha256: "ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356".into(),
        byte_length: 3,
        kind: "outline".into(),
        version_id: "new-version".into(),
        slide_id: None,
        metadata: None,
    };
    assert!(service
        .commit_pipeline(PipelineCommitInput {
            project_id: id.into(),
            expected_revision: 2,
            pipeline: invalid,
            writes: vec![write]
        })
        .is_err());
    assert!(
        !workspace.join(id).join("outline/new-outline.json").exists(),
        "failed commit must not produce partial artifacts"
    );
    assert_eq!(service.load_pipeline(id).unwrap(), base);
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn revision_artifact_rollback_holds_directory_and_never_removes_existing_files() {
    use digital_twin_desktop_lib::paths::write_new_workspace_artifact;
    use std::os::unix::fs::symlink;
    let root = temporary_root("revision-rollback-paths");
    std::fs::create_dir_all(root.join("workspace/project/history")).unwrap();
    std::fs::create_dir_all(root.join("outside")).unwrap();
    let workspace = root.join("workspace");
    std::fs::write(workspace.join("project/history/existing.json"), b"original").unwrap();
    assert!(write_new_workspace_artifact(
        &workspace,
        std::path::Path::new("project/history/existing.json"),
        b"changed"
    )
    .is_err());
    assert_eq!(
        std::fs::read(workspace.join("project/history/existing.json")).unwrap(),
        b"original"
    );
    let artifact = write_new_workspace_artifact(
        &workspace,
        std::path::Path::new("project/history/new.json"),
        b"new",
    )
    .unwrap();
    std::fs::rename(
        workspace.join("project/history"),
        workspace.join("project/held-history"),
    )
    .unwrap();
    std::fs::write(root.join("outside/new.json"), b"outside").unwrap();
    symlink(root.join("outside"), workspace.join("project/history")).unwrap();
    drop(artifact);
    assert!(!workspace.join("project/held-history/new.json").exists());
    assert_eq!(
        std::fs::read(root.join("outside/new.json")).unwrap(),
        b"outside"
    );
    assert!(write_new_workspace_artifact(
        &workspace,
        std::path::Path::new("project/history/escape.json"),
        b"bad"
    )
    .is_err());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn persisted_native_state_survives_restart_and_cannot_skip_visual_approvals() {
    let root = temporary_root("restart");
    let database_path = root.join("state.sqlite3");
    let workspace = root.join("workspace");
    std::fs::create_dir_all(&root).expect("root created");
    let project_id;
    {
        let service = WorkbenchService::open(&database_path, &workspace).expect("workbench opens");
        let project = service
            .create_project(CreateProjectInput {
                name: "五页经营复盘".into(),
                goal: "支持管理层决策".into(),
            })
            .expect("project created");
        project_id = project.id;
        service
            .record_source_analysis_completed(&project_id)
            .expect("source analysis checkpoint recorded");
        service
            .submit_outline_for_review(&project_id)
            .expect("outline submitted");
        service
            .approve_outline(&project_id)
            .expect("outline approved");
        service
            .approve_details(&project_id)
            .expect("details approved");
        let skip = service.approve_slide(SlideMutationInput {
            project_id: project_id.clone(),
            slide: 2,
            comment: String::new(),
        });
        assert_eq!(
            skip.expect_err("page two cannot skip page one"),
            "Only the current waiting slide can be approved"
        );
        service
            .approve_slide(SlideMutationInput {
                project_id: project_id.clone(),
                slide: 1,
                comment: "通过".into(),
            })
            .expect("page one approved");
    }

    let reopened = WorkbenchService::open(&database_path, &workspace).expect("workbench reopens");
    let initial = reopened.initial_state().expect("state loads");
    let project = initial
        .projects
        .iter()
        .find(|candidate| candidate.id == project_id)
        .expect("project restored");
    assert_eq!(project.selected_slide, 2);
    assert_eq!(project.slides[0].status, "approved");
    assert_eq!(project.slides[1].status, "waiting");
    assert_eq!(initial.collections.projects, "loaded");

    std::fs::remove_dir_all(root).expect("temporary root removed");
}

#[test]
fn production_collections_start_empty_and_loaded_instead_of_demo_or_fake_success() {
    let root = temporary_root("empty");
    std::fs::create_dir_all(&root).expect("root created");
    let service = WorkbenchService::open(root.join("state.sqlite3"), root.join("workspace"))
        .expect("workbench opens");
    let initial = service.initial_state().expect("state loads");

    assert!(initial.projects.is_empty());
    assert!(initial.approvals.is_empty());
    assert!(initial.memories.is_empty());
    assert_eq!(initial.collections.projects, "loaded");
    assert_eq!(initial.collections.approvals, "loaded");
    assert_eq!(initial.collections.memories, "loaded");
    assert_eq!(initial.account.status, "unavailable");

    std::fs::remove_dir_all(root).expect("temporary root removed");
}

#[test]
fn rust_owns_source_and_worker_write_intents_and_restores_the_complete_pipeline() {
    let root = temporary_root("complete-pipeline");
    let database_path = root.join("state.sqlite3");
    let workspace = root.join("workspace");
    std::fs::create_dir_all(&root).expect("root created");
    let project_id;
    let committed;
    {
        let service = WorkbenchService::open(&database_path, &workspace).expect("workbench opens");
        let project = service
            .create_project(CreateProjectInput {
                name: "经营复盘".into(),
                goal: "管理层决策".into(),
            })
            .expect("project created");
        project_id = project.id;
        let attached = service
            .attach_source(AttachSourceInput {
                project_id: project_id.clone(),
                file_name: "kpis.csv".into(),
                media_type: "text/csv".into(),
                contents_base64: "MjAyNywxNTAK".into(),
            })
            .expect("source attached through Rust");
        assert_eq!(attached["sources"][0]["fileName"], "kpis.csv");
        assert!(workspace
            .join(&project_id)
            .join(attached["sources"][0]["relativePath"].as_str().unwrap())
            .is_file());

        let mut pipeline = attached.clone();
        pipeline["revision"] = 3.into();
        pipeline["project"]["workflowStatus"] = "outline_review".into();
        pipeline["project"]["updatedAt"] = "2026-09-03T01:00:00Z".into();
        pipeline["outline"] = serde_json::json!({
            "version": {"id": format!("{project_id}-outline-v1"), "projectId": project_id,
                "sequence": 1, "status": "frozen", "createdAt": "now", "frozenAt": "now"},
            "value": {"title": "大纲", "slides": []}
        });
        pipeline["approvals"] = serde_json::json!([{
            "id": format!("{project_id}-approval-outline"), "projectId": project_id,
            "versionId": format!("{project_id}-outline-v1"), "stage": "outline_review",
            "status": "approved", "decidedAt": "now"
        }]);
        pipeline["tasks"] = serde_json::json!([{
            "id": format!("{project_id}-task-outline"), "kind": "outline_generation",
            "status": "completed", "createdAt": "now", "updatedAt": "now", "error": null
        }]);
        committed = service
            .commit_pipeline(PipelineCommitInput {
                project_id: project_id.clone(),
                expected_revision: 2,
                pipeline,
                writes: vec![ArtifactWriteInput {
                    relative_path: "outline/outline-v1.json".into(),
                    contents_base64: "e30K".into(),
                    sha256: "ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356"
                        .into(),
                    byte_length: 3,
                    kind: "outline".into(),
                    version_id: format!("{project_id}-outline-v1"),
                    slide_id: None,
                    metadata: None,
                }],
            })
            .expect("pipeline and artifacts committed");
        let stale = service.commit_pipeline(PipelineCommitInput {
            project_id: project_id.clone(),
            expected_revision: 2,
            pipeline: committed.clone(),
            writes: vec![ArtifactWriteInput {
                relative_path: "outline/outline-v1.json".into(),
                contents_base64: "ZXZpbAo=".into(),
                sha256: "886b67480dbe73b406ad83a1dd6d9596f93089d90c220ccfc91944c95f1c68c4".into(),
                byte_length: 5,
                kind: "outline".into(),
                version_id: format!("{project_id}-outline-v1"),
                slide_id: None,
                metadata: None,
            }],
        });
        assert!(stale
            .expect_err("stale Worker result rejected")
            .contains("stale"));
        assert_eq!(
            std::fs::read(workspace.join(&project_id).join("outline/outline-v1.json")).unwrap(),
            b"{}\n"
        );
        let counts = service
            .persistence_counts(&project_id)
            .expect("counts read");
        assert_eq!(
            (
                counts.versions,
                counts.approvals,
                counts.tasks,
                counts.artifacts
            ),
            (1, 1, 1, 2)
        );
    }

    let reopened = WorkbenchService::open(&database_path, &workspace).expect("workbench reopens");
    assert_eq!(
        reopened
            .load_pipeline(&project_id)
            .expect("pipeline restored"),
        committed
    );
    assert_eq!(
        std::fs::read(workspace.join(&project_id).join("outline/outline-v1.json")).unwrap(),
        b"{}\n"
    );
    std::fs::remove_dir_all(root).expect("temporary root removed");
}

#[test]
fn rust_accepts_only_the_conservative_prompt_context_transition_shape() {
    let root = temporary_root("prompt-context");
    std::fs::create_dir_all(&root).expect("root created");
    let workspace = root.join("workspace");
    let service =
        WorkbenchService::open(root.join("state.sqlite3"), &workspace).expect("workbench opens");
    let project = service
        .create_project(CreateProjectInput {
            name: "经营复盘".into(),
            goal: "管理层决策".into(),
        })
        .expect("project created");
    let current = service.load_pipeline(&project.id).expect("pipeline loads");

    let mut valid = current.clone();
    valid["revision"] = 2.into();
    valid["project"]["updatedAt"] = "2026-09-03T01:00:00Z".into();
    valid["promptContext"] = serde_json::json!({
        "taskBrief": "做一份董事会汇报",
        "sourceInstructions": {},
        "outlineRequirements": "先结论后证据"
    });
    valid["tasks"] = serde_json::json!([{
        "id": format!("{}-task-2-prompt_context_update", project.id),
        "kind": "prompt_context_update", "status": "completed",
        "createdAt": "2026-09-03T01:00:00Z", "updatedAt": "2026-09-03T01:00:00Z",
        "error": null
    }]);
    service
        .commit_pipeline(PipelineCommitInput {
            project_id: project.id.clone(),
            expected_revision: 1,
            pipeline: valid.clone(),
            writes: vec![],
        })
        .expect("valid context transition commits");

    let mut forged = valid.clone();
    forged["revision"] = 3.into();
    forged["project"]["goal"] = "伪造的目标".into();
    forged["project"]["updatedAt"] = "2026-09-03T01:01:00Z".into();
    forged["promptContext"]["taskBrief"] = "新任务".into();
    forged["tasks"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({
            "id": format!("{}-task-3-prompt_context_update", project.id),
            "kind": "prompt_context_update", "status": "completed",
            "createdAt": "2026-09-03T01:01:00Z", "updatedAt": "2026-09-03T01:01:00Z",
            "error": null
        }));
    let artifact_path = workspace.join(&project.id).join("outline/forged.json");
    let error = service
        .commit_pipeline(PipelineCommitInput {
            project_id: project.id.clone(),
            expected_revision: 2,
            pipeline: forged,
            writes: vec![ArtifactWriteInput {
                relative_path: "outline/forged.json".into(),
                contents_base64: "e30K".into(),
                sha256: "ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356".into(),
                byte_length: 3,
                kind: "outline".into(),
                version_id: "forged".into(),
                slide_id: None,
                metadata: None,
            }],
        })
        .expect_err("context update cannot smuggle immutable changes");
    assert!(error.contains("Prompt context transition"));
    assert!(
        !artifact_path.exists(),
        "rejected writes happen before no artifact IO"
    );

    std::fs::remove_dir_all(root).expect("temporary root removed");
}

#[test]
fn rust_rejects_prompt_context_updates_after_the_outline_is_frozen() {
    let root = temporary_root("frozen-prompt-context");
    std::fs::create_dir_all(&root).expect("root created");
    let service = WorkbenchService::open(root.join("state.sqlite3"), root.join("workspace"))
        .expect("workbench opens");
    let project = service
        .create_project(CreateProjectInput {
            name: "经营复盘".into(),
            goal: "管理层决策".into(),
        })
        .expect("project created");
    let mut frozen = service.load_pipeline(&project.id).expect("pipeline loads");
    frozen["revision"] = 2.into();
    frozen["project"]["workflowStatus"] = "detail_review".into();
    frozen["project"]["updatedAt"] = "one".into();
    service
        .commit_pipeline(PipelineCommitInput {
            project_id: project.id.clone(),
            expected_revision: 1,
            pipeline: frozen.clone(),
            writes: vec![],
        })
        .expect("legacy checkpoint fixture commits");

    let mut next = frozen;
    next["revision"] = 3.into();
    next["project"]["updatedAt"] = "two".into();
    next["promptContext"] = serde_json::json!({
        "taskBrief": "太晚", "sourceInstructions": {}, "outlineRequirements": ""
    });
    next["tasks"] = serde_json::json!([{
        "id": format!("{}-task-3-prompt_context_update", project.id),
        "kind": "prompt_context_update", "status": "completed",
        "createdAt": "two", "updatedAt": "two", "error": null
    }]);
    let error = service
        .commit_pipeline(PipelineCommitInput {
            project_id: project.id.clone(),
            expected_revision: 2,
            pipeline: next,
            writes: vec![],
        })
        .expect_err("frozen context cannot change");
    assert!(error.contains("before outline approval"));

    std::fs::remove_dir_all(root).expect("temporary root removed");
}

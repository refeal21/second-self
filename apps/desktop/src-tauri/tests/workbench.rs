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

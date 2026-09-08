use std::time::{SystemTime, UNIX_EPOCH};

use digital_twin_desktop_lib::database::{
    Database, NewMemoryProposal, NewProject, ProjectMutation,
};
use rusqlite::Connection;

#[test]
fn creates_all_workbench_domain_tables() {
    let database = Database::open_in_memory().expect("in-memory database opens");

    assert_eq!(
        database.table_names().expect("table names read"),
        vec![
            "approvals",
            "artifacts",
            "checkpoints",
            "memory_proposals",
            "projects",
            "settings",
            "tasks",
            "versions",
        ]
    );
}

fn temporary_database(name: &str) -> std::path::PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock is after epoch")
        .as_nanos();
    std::env::temp_dir().join(format!("digital-twin-{name}-{nonce}.sqlite3"))
}

#[test]
fn persists_checkpoint_and_project_preference_snapshot_across_reopen() {
    let path = temporary_database("recovery");
    {
        let database = Database::open(&path).expect("database opens");
        database
            .insert_memory_proposal(&NewMemoryProposal {
                id: "memory-1".into(),
                title: "图表优先".into(),
                content: "优先使用趋势图".into(),
                created_at: "2026-09-02T00:00:00Z".into(),
            })
            .expect("memory inserted");
        database
            .decide_memory("memory-1", "approved", "2026-09-02T00:01:00Z")
            .expect("memory approved");
        database
            .insert_project(&NewProject {
                id: "project-1".into(),
                name: "经营复盘".into(),
                goal: "管理层决策".into(),
                created_at: "2026-09-02T00:02:00Z".into(),
            })
            .expect("project inserted");
        database
            .mutate_project(
                "project-1",
                &ProjectMutation {
                    workflow_status: "visual_review".into(),
                    progress: 60,
                    selected_slide: 3,
                    slide_statuses: vec![
                        "approved".into(),
                        "approved".into(),
                        "waiting".into(),
                        "pending".into(),
                        "pending".into(),
                    ],
                    export_ready: false,
                    slide_notice: "等待审批".into(),
                    updated_at: "2026-09-02T00:03:00Z".into(),
                },
            )
            .expect("project mutated");
    }

    let reopened = Database::open(&path).expect("database reopens");
    let project = reopened
        .get_project("project-1")
        .expect("query succeeds")
        .expect("project exists");
    assert_eq!(project.workflow_status, "visual_review");
    assert_eq!(project.selected_slide, 3);
    assert_eq!(project.preference_snapshot.len(), 1);
    assert_eq!(project.preference_snapshot[0].content, "优先使用趋势图");
    assert_eq!(
        reopened
            .latest_checkpoint("project-1")
            .expect("checkpoint query succeeds")
            .expect("checkpoint exists")
            .workflow_status,
        "visual_review"
    );

    reopened
        .insert_memory_proposal(&NewMemoryProposal {
            id: "memory-2".into(),
            title: "深色背景".into(),
            content: "新偏好".into(),
            created_at: "2026-09-02T00:04:00Z".into(),
        })
        .expect("second memory inserted");
    reopened
        .decide_memory("memory-2", "approved", "2026-09-02T00:05:00Z")
        .expect("second memory approved");
    assert_eq!(
        reopened
            .get_project("project-1")
            .expect("query succeeds")
            .expect("project exists")
            .preference_snapshot
            .len(),
        1,
        "later preference changes must not mutate an existing project snapshot"
    );

    std::fs::remove_file(path).expect("temporary database removed");
}

#[test]
fn rename_keeps_the_relational_name_and_authoritative_pipeline_name_in_sync() {
    let database = Database::open_in_memory().expect("database opens");
    database
        .insert_project(&NewProject {
            id: "project-rename".into(),
            name: "旧名称".into(),
            goal: "验证重命名".into(),
            created_at: "2026-09-04T00:00:00Z".into(),
        })
        .expect("project inserted");

    assert!(database
        .rename_project("project-rename", "新名称", "2026-09-04T00:01:00Z")
        .expect("rename succeeds"));

    let project = database
        .get_project("project-rename")
        .expect("project queried")
        .expect("project exists");
    assert_eq!(project.name, "新名称");
    assert_eq!(project.pipeline["project"]["name"], "新名称");
    assert_eq!(
        project.pipeline["project"]["updatedAt"],
        "2026-09-04T00:01:00Z"
    );
}

#[test]
fn persists_superseded_visual_version_status_across_reopen() {
    let path = temporary_database("superseded-visual");
    let revision_three = {
        let database = Database::open(&path).expect("database opens");
        database
            .insert_project(&NewProject {
                id: "project-visual".into(),
                name: "视觉版本".into(),
                goal: "验证旧视觉草稿被替代".into(),
                created_at: "2026-09-08T00:00:00Z".into(),
            })
            .expect("project inserted");

        let revision_two = visual_pipeline(2, "draft", false);
        assert!(database
            .replace_pipeline("project-visual", 1, &revision_two, &[])
            .expect("revision two saved"));

        let revision_three = visual_pipeline(3, "superseded", true);
        assert!(database
            .replace_pipeline("project-visual", 2, &revision_three, &[])
            .expect("revision three saved"));
        revision_three
    };

    let reopened = Database::open(&path).expect("database reopens");
    assert_eq!(
        reopened
            .get_project("project-visual")
            .expect("project queried")
            .expect("project exists")
            .pipeline,
        revision_three
    );
    drop(reopened);

    let connection = Connection::open(&path).expect("relational database opens");
    let old_status: String = connection
        .query_row(
            "SELECT status FROM versions WHERE id = 'visual-v1'",
            [],
            |row| row.get(0),
        )
        .expect("old visual version queried");
    assert_eq!(old_status, "superseded");
    drop(connection);

    std::fs::remove_file(path).expect("temporary database removed");
}

#[test]
fn rejects_changes_to_superseded_visual_version_metadata() {
    let database = Database::open_in_memory().expect("database opens");
    database
        .insert_project(&NewProject {
            id: "project-visual".into(),
            name: "视觉版本".into(),
            goal: "验证被替代版本不可恢复".into(),
            created_at: "2026-09-08T00:00:00Z".into(),
        })
        .expect("project inserted");
    database
        .replace_pipeline(
            "project-visual",
            1,
            &visual_pipeline(2, "draft", false),
            &[],
        )
        .expect("revision two saved");

    let revision_three = visual_pipeline(3, "superseded", true);
    database
        .replace_pipeline("project-visual", 2, &revision_three, &[])
        .expect("revision three saved");

    for (forbidden_status, forged_frozen_at) in [
        ("draft", None),
        ("frozen", Some("2026-09-08T00:03:00Z")),
        ("superseded", Some("2026-09-08T00:03:00Z")),
    ] {
        let mut forbidden = revision_three.clone();
        forbidden["revision"] = 4.into();
        forbidden["visuals"]["slide-1"][0]["version"]["status"] = forbidden_status.into();
        if let Some(frozen_at) = forged_frozen_at {
            forbidden["visuals"]["slide-1"][0]["version"]["frozenAt"] = frozen_at.into();
        }

        let error = database
            .replace_pipeline("project-visual", 3, &forbidden, &[])
            .expect_err("superseded visual metadata is immutable");
        assert!(error
            .to_string()
            .contains("historical version metadata is immutable"));
        assert_eq!(
            database
                .get_project("project-visual")
                .expect("project queried")
                .expect("project exists")
                .pipeline,
            revision_three,
            "a rejected {forbidden_status} transition must roll back the pipeline"
        );
    }
}

#[test]
fn rejects_unknown_visual_version_status_from_draft() {
    let database = Database::open_in_memory().expect("database opens");
    database
        .insert_project(&NewProject {
            id: "project-visual".into(),
            name: "视觉版本".into(),
            goal: "验证未知版本状态被拒绝".into(),
            created_at: "2026-09-08T00:00:00Z".into(),
        })
        .expect("project inserted");
    let revision_two = visual_pipeline(2, "draft", false);
    database
        .replace_pipeline("project-visual", 1, &revision_two, &[])
        .expect("revision two saved");

    let unknown_status = visual_pipeline(3, "unknown", false);
    let error = database
        .replace_pipeline("project-visual", 2, &unknown_status, &[])
        .expect_err("draft visual accepts only known transitions");
    assert!(error
        .to_string()
        .contains("historical version metadata is immutable"));
    assert_eq!(
        database
            .get_project("project-visual")
            .expect("project queried")
            .expect("project exists")
            .pipeline,
        revision_two
    );
}

fn visual_pipeline(
    revision: i64,
    first_visual_status: &str,
    include_second_visual: bool,
) -> serde_json::Value {
    let mut visual_history = vec![serde_json::json!({
        "version": {
            "id": "visual-v1",
            "status": first_visual_status,
            "createdAt": "2026-09-08T00:01:00Z"
        }
    })];
    if include_second_visual {
        visual_history.push(serde_json::json!({
            "version": {
                "id": "visual-v2",
                "status": "draft",
                "createdAt": "2026-09-08T00:02:00Z"
            }
        }));
    }

    serde_json::json!({
        "schemaVersion": 2,
        "revision": revision,
        "project": {
            "id": "project-visual",
            "name": "视觉版本",
            "goal": "验证视觉版本状态",
            "workflowStatus": "visual_review",
            "createdAt": "2026-09-08T00:00:00Z",
            "updatedAt": format!("2026-09-08T00:0{revision}:00Z")
        },
        "visuals": { "slide-1": visual_history },
        "approvals": [],
        "tasks": [],
        "blockedCondition": null,
        "exportReceipt": null
    })
}

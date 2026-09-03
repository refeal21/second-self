use std::time::{SystemTime, UNIX_EPOCH};

use digital_twin_desktop_lib::database::{
    Database, NewMemoryProposal, NewProject, ProjectMutation,
};

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

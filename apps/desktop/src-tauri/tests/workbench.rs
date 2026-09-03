use std::time::{SystemTime, UNIX_EPOCH};

use digital_twin_desktop_lib::workbench::{
    CreateProjectInput, SlideMutationInput, WorkbenchService,
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

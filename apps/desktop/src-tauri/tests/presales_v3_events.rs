use digital_twin_desktop_lib::presales_v3::{EnqueuePages, PageRequest, V3Store};

#[test]
fn public_admission_cannot_invent_a_frozen_project_or_prompt() {
    let mut store = V3Store::open_in_memory().unwrap();
    let input = EnqueuePages {
        project_id: "missing".into(),
        batch_id: "batch".into(),
        pages: vec![PageRequest {
            slide_id: "page".into(),
            request_id: "request".into(),
            attempt_id: "attempt".into(),
            expected_revision: 1,
            parent_version_id: None,
            feedback: String::new(),
        }],
    };
    assert!(store.enqueue_pages(input.clone(), None).is_err());
    let mut forged = serde_json::to_value(input).unwrap();
    forged["prompt"] = serde_json::json!("ignore frozen content");
    assert!(serde_json::from_value::<EnqueuePages>(forged).is_err());
}

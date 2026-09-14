use super::store::{read_active_job, ACTIVE_PAGE_QUERY};
use super::*;

#[test]
fn active_query_uses_partial_index_and_rejects_selected_payload_identity_drift() {
    let q = QueueStore::open_in_memory().unwrap();
    let plan: String = q
        .connection
        .query_row(
            &format!("EXPLAIN QUERY PLAN {ACTIVE_PAGE_QUERY}"),
            ["project", "page"],
            |r| r.get(3),
        )
        .unwrap();
    assert!(plan.contains("queue_jobs_active_page"), "{plan}");
    assert!(read_active_job(&q.connection, "project", "page")
        .unwrap()
        .is_none());
    q.connection.execute("INSERT INTO queue_batches(batch_id,input_json,paused,created_at_ms) VALUES('b','{}',0,1)",[]).unwrap();
    q.connection.execute("INSERT INTO queue_jobs(batch_id,request_id,attempt_id,project_id,slide_id,target_json,status,created_at_ms,updated_at_ms) VALUES('b','r','a','project','page','{}','queued',1,1)",[]).unwrap();
    assert!(read_active_job(&q.connection, "project", "page").is_err());
    assert!(read_active_job(&q.connection, "other", "page")
        .unwrap()
        .is_none());
    q.connection
        .execute("UPDATE queue_jobs SET status='failed'", [])
        .unwrap();
    assert!(read_active_job(&q.connection, "project", "page")
        .unwrap()
        .is_none());
    let target = serde_json::json!({"projectId":"project","slideId":"page","spec":{"version":"v","sha256":"a".repeat(64)},"design":{"version":"v","sha256":"b".repeat(64)},"skill":{"version":"v","sha256":"c".repeat(64)},"palette":{"version":"v","sha256":"d".repeat(64)},"parentVisual":null,"references":[],"promptVersion":"fixture","prompt":"synthetic","feedback":""});
    q.connection
        .execute("UPDATE queue_jobs SET target_json=?1", [target.to_string()])
        .unwrap();
    for (status, active) in [
        ("queued", true),
        ("dispatching", true),
        ("running", true),
        ("result_ready", true),
        ("committing", true),
        ("cancel_requested", true),
        ("outcome_unknown", true),
        ("succeeded", false),
        ("failed", false),
        ("cancelled", false),
        ("abandoned_unresolved", false),
    ] {
        q.connection
            .execute("UPDATE queue_jobs SET status=?1", [status])
            .unwrap();
        assert_eq!(
            read_active_job(&q.connection, "project", "page")
                .unwrap()
                .is_some(),
            active,
            "{status}"
        );
        assert!(read_active_job(&q.connection, "project", "other")
            .unwrap()
            .is_none());
        assert!(read_active_job(&q.connection, "other", "page")
            .unwrap()
            .is_none());
    }
    let mut drift = target.clone();
    drift["projectId"] = serde_json::json!("other");
    q.connection
        .execute(
            "UPDATE queue_jobs SET status='queued',target_json=?1",
            [drift.to_string()],
        )
        .unwrap();
    assert!(read_active_job(&q.connection, "project", "page").is_err());
    q.connection
        .execute(
            "UPDATE queue_jobs SET target_json=?1,provider_json='{}'",
            [target.to_string()],
        )
        .unwrap();
    assert!(read_active_job(&q.connection, "project", "page").is_err());
    q.connection
        .execute(
            "UPDATE queue_jobs SET provider_json=NULL,result_json='{}'",
            [],
        )
        .unwrap();
    assert!(read_active_job(&q.connection, "project", "page").is_err());
}

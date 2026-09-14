use super::*;
#[path = "../../tests/support/v3_temp.rs"]
mod temp;

#[test]
fn cancellation_retries_full_private_stdin_and_ack_is_not_terminal() {
    let root = temp::tempdir().unwrap();
    let store = V3Store::open(root.path().join("presales-v3.sqlite3")).unwrap();
    let service = Arc::new(
        V3WorkbenchService::new(
            store,
            root.path().join("presales-v3-assets"),
            Arc::new(
                super::super::activity::LegacyActivityTracker::new(
                    V3Store::open_in_memory().unwrap(),
                )
                .unwrap(),
            ),
            super::super::validator_process::LegacyValidatorProcess::from_test_command(
                Command::new("unused-offline-validator"),
                Duration::from_secs(1),
            ),
        )
        .unwrap(),
    );
    {
        let mut store = service.store.lock().unwrap();
        let (checkpoint, palette) = super::super::basis::tests::frozen_fixture_pages(1);
        store
            .insert_project(ValidatedV3ProjectSeed::from_checkpoint(checkpoint, palette).unwrap())
            .unwrap();
        let page = store
            .load_project("frozen-project")
            .unwrap()
            .pages
            .remove(0);
        store
            .enqueue_pages(
                EnqueuePages {
                    project_id: "frozen-project".into(),
                    batch_id: "backpressure".into(),
                    pages: vec![PageRequest {
                        slide_id: page.slide_id,
                        expected_revision: page.revision,
                        request_id: "cancel-image".into(),
                        attempt_id: "cancel-attempt".into(),
                        parent_version_id: None,
                        feedback: String::new(),
                    }],
                },
                None,
            )
            .unwrap();
    }
    let epoch = service.begin_queue_runtime().unwrap();
    let work = service.claim_queue_work(epoch).unwrap().unwrap();
    service
        .image_lifecycle
        .lock()
        .unwrap()
        .request_cancel(work.id())
        .unwrap();
    let (outgoing, receiver) = mpsc::sync_channel(1);
    outgoing.send(vec![b'\n']).unwrap();
    let mut actor = Actor {
        service: service.clone(),
        epoch,
        generation: epoch,
        active: HashMap::from([(work.id().into(), work)]),
        outgoing,
        available: Arc::new(AtomicBool::new(true)),
        capabilities:Arc::new(std::sync::Mutex::new(ImageCapabilities::default())),
        provider_binary:None,
        provider:None,
        sequence: 0,
        pending: HashMap::new(),
        interrupted: HashSet::new(),
        revision: AtomicU64::new(0),
        changed: |_| {},
    };
    actor.flush_cancellations().unwrap();
    assert!(
        actor.pending.is_empty(),
        "unsent controls must not await an ACK"
    );
    receiver.recv().unwrap();
    actor.flush_cancellations().unwrap();
    let request: Value = serde_json::from_slice(
        &receiver
            .recv_timeout(Duration::from_millis(100))
            .expect("cancellation disappeared on full stdin"),
    )
    .unwrap();
    assert_eq!(request["method"], "presales/interrupt");
    assert_eq!(request["params"]["requestId"], "cancel-image");
    actor
        .handle(&json!({"id":request["id"],"result":{"acknowledged":true}}).to_string())
        .unwrap();
    assert_eq!(
        service.queue_snapshot().unwrap().jobs[0].status,
        "cancel_requested"
    );
    assert_eq!(service.queue_snapshot().unwrap().remote_active, 1);
    actor.flush_cancellations().unwrap();
    assert!(
        receiver.try_recv().is_err(),
        "an acknowledged interrupt should not be spammed"
    );
    drop(receiver);
    assert!(actor
        .send(json!({"id":"native:reply","result":{}}))
        .unwrap_err()
        .contains("disconnected"));
}

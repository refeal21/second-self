use super::*;

#[test]
fn rejected_thread_route_revokes_the_native_claim_lease() {
    let f=Fixture::new(5);
    let s=std::sync::Arc::new(f.service());
    super::supervisor_tests::enqueue_test_images(&s,2);
    s.set_queue_settings(1,false).unwrap();
    let (command,script)=production_commands(&f,json!({"threadProvider":"custom"}));
    let host=super::super::runtime_host::QueueSupervisor::start_with_provider(s.clone(),command,Some(script),|_|{}).unwrap();
    assert!(super::supervisor_tests::wait_until(||s.queue_snapshot().unwrap().jobs[0].status=="outcome_unknown"));
    // Free the uncertainty slot explicitly: a queued second job must still be
    // blocked by revoked readiness, not merely by first-job occupancy.
    s.image_lifecycle.lock().unwrap().abandon_unresolved("review-image-0",true).unwrap();
    host.wake();
    std::thread::sleep(Duration::from_millis(250));
    let snapshot=host.snapshot().unwrap();
    assert_eq!(snapshot.jobs[1].status,"queued","stale capability admitted another native claim");
    assert!(!snapshot.dispatch_available);
    assert!(!snapshot.capabilities.generation);
    let calls=std::fs::read_to_string(f.root.path().join("provider-log")).unwrap().lines().map(|line|serde_json::from_str::<Value>(line).unwrap()).collect::<Vec<_>>();
    assert_eq!(calls.iter().filter(|m|m["method"]=="thread/start").count(),1);
    assert!(!calls.iter().any(|m|m["method"]=="turn/start"));
    host.shutdown();
}

fn production_commands(f: &Fixture, options: Value) -> (Command, PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let script = f.root.path().join("synthetic-codex");
    let mut fixture = json!({"pidPath":f.root.path().join("provider-pid"),"logPath":f.root.path().join("provider-log"),"png":STANDARD.encode(png(23))});
    fixture
        .as_object_mut()
        .unwrap()
        .extend(options.as_object().unwrap().clone());
    std::fs::write(
        &script,
        format!(
            "#!/usr/bin/env node\nconst fixture={fixture};\n{}",
            include_str!("provider-fixture.cjs")
        ),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let worker = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../worker");
    let mut command = Command::new("node");
    command
        .arg("--import")
        .arg(worker.join("node_modules/tsx/dist/loader.mjs"))
        .arg(worker.join("src/sidecar-cli.ts"))
        .arg("--presales-runtime");
    (command, script)
}

#[test]
fn verified_preview_and_parent_share_exact_native_asset_authority() {
    let f = Fixture::paired(6);
    let s = f.service();
    let prepared = prepare(&s, &f, LegacyCopyMode::FormatCopy);
    let project = s.publish_legacy_copy(&prepared.preparation_id).unwrap();
    let id = &project.summary().project_id;
    let page = &project.pages()[0];
    let version = page.versions.iter().find(|v| v.image.is_some()).unwrap();
    let image = version.image.as_ref().unwrap();
    let preview = s
        .read_verified_image(
            id,
            &page.slide_id,
            &version.version_id,
            &image.asset_id,
            &image.sha256,
        )
        .unwrap();
    assert_eq!(preview.mime_type, "image/png");
    assert!(STANDARD
        .decode(&preview.base64)
        .unwrap()
        .starts_with(b"\x89PNG"));
    for (p, slide, v, a, h) in [
        (
            "other",
            page.slide_id.as_str(),
            version.version_id.as_str(),
            image.asset_id.as_str(),
            image.sha256.as_str(),
        ),
        (
            id.as_str(),
            "other",
            version.version_id.as_str(),
            image.asset_id.as_str(),
            image.sha256.as_str(),
        ),
        (
            id.as_str(),
            page.slide_id.as_str(),
            "other",
            image.asset_id.as_str(),
            image.sha256.as_str(),
        ),
        (
            id.as_str(),
            page.slide_id.as_str(),
            version.version_id.as_str(),
            "other",
            image.sha256.as_str(),
        ),
        (
            id.as_str(),
            page.slide_id.as_str(),
            version.version_id.as_str(),
            image.asset_id.as_str(),
            "bad",
        ),
    ] {
        assert!(s.read_verified_image(p, slide, v, a, h).is_err());
    }
    let mut store = s.store.lock().unwrap();
    store
        .enqueue_pages(
            EnqueuePages {
                project_id: id.clone(),
                batch_id: "provider-parent".into(),
                pages: vec![PageRequest {
                    slide_id: page.slide_id.clone(),
                    expected_revision: page.revision,
                    request_id: "provider-image".into(),
                    attempt_id: "provider-attempt".into(),
                    parent_version_id: Some(version.version_id.clone()),
                    feedback: "保持主视觉".into(),
                }],
            },
            Some(&crate::presales_queue::ResultVault::open(&s.root).unwrap()),
        )
        .unwrap();
    drop(store);
    let epoch = s.begin_queue_runtime().unwrap();
    let work = s.claim_queue_work(epoch).unwrap().unwrap();
    let resolved = s.resolve_provider_inputs(&work).unwrap();
    assert_eq!(resolved.images.len(), 1);
    assert_eq!(resolved.images[0].asset_id, image.asset_id);
    assert_eq!(resolved.images[0].role, "parent");
    assert_eq!(
        std::fs::read(&resolved.images[0].path).unwrap(),
        STANDARD.decode(&preview.base64).unwrap()
    );
    std::fs::write(&resolved.images[0].path, b"tampered").unwrap();
    assert!(s
        .read_verified_image(
            id,
            &page.slide_id,
            &version.version_id,
            &image.asset_id,
            &image.sha256
        )
        .is_err());
    assert!(s.resolve_provider_inputs(&work).is_err());
}

#[test]
fn private_codex_command_removes_only_fixed_overrides_and_pins_provider() {
    let command = crate::codex_process::build_private_codex_app_server_command(
        Path::new("/synthetic/codex"),
        Path::new("/synthetic/assets"),
    );
    let args = command
        .get_args()
        .map(|v| v.to_str().unwrap())
        .collect::<Vec<_>>();
    assert!(args.contains(&"model_provider=\"openai\""));
    let removed = command.get_envs().collect::<Vec<_>>();
    for name in [
        "OPENAI_API_KEY",
        "CODEX_API_KEY",
        "CODEX_ACCESS_TOKEN",
        "OPENAI_BASE_URL",
    ] {
        assert!(removed.iter().any(|(k, v)| *k == name && v.is_none()));
    }
    assert!(!removed.iter().any(|(k, _)| [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "SSL_CERT_FILE",
        "NODE_EXTRA_CA_CERTS",
        "CODEX_HOME"
    ]
    .contains(&k.to_str().unwrap())));
    assert!(!args
        .iter()
        .any(|v| v.contains("forced_login") || v.contains("credentials_store")));
}

#[test]
fn actual_production_private_proxy_publishes_image_and_text_and_owns_shutdown() {
    let f = Fixture::new(5);
    let s = std::sync::Arc::new(f.service());
    let draft = super::draft_tests::imported(&f, &s);
    let op = s
        .request_text_authoring(RequestTextAuthoring {
            project_id: draft.summary.project_id.clone(),
            expected_revision: draft.summary.revision,
            stage: V3TextStage::Outline,
            operation_id: "real-proxy-text".into(),
            attempt_id: "real-proxy-text-attempt".into(),
        })
        .unwrap();
    super::supervisor_tests::enqueue_test_images(&s, 1);
    let pid = f.root.path().join("provider-pid");
    let log = f.root.path().join("provider-log");
    let (command, script) = production_commands(
        &f,
        json!({"textPrompt":op.target.prompt,"outline":f.pair["outline"],"textAssets":op.target.sources.iter().chain(std::iter::once(&op.target.analysis)).map(|s|s.asset.clone()).collect::<Vec<_>>()}),
    );
    let host = super::super::runtime_host::QueueSupervisor::start_with_provider(
        s.clone(),
        command,
        Some(script),
        |_| {},
    )
    .unwrap();
    assert!(
        super::supervisor_tests::wait_until(|| s.queue_snapshot().unwrap().succeeded == 2),
        "{:?}",
        s.queue_snapshot().unwrap()
    );
    let snapshot = host.snapshot().unwrap();
    assert!(snapshot.dispatch_available);
    assert!(snapshot.capabilities.generation);
    assert!(snapshot.capabilities.reference_editing);
    let page = s.load_v3_project("frozen-project").unwrap().pages()[0].clone();
    let version = page.versions[0].clone();
    let image = version.image.clone().unwrap();
    assert!(s
        .read_verified_image(
            "frozen-project",
            &page.slide_id,
            &version.version_id,
            &image.asset_id,
            &image.sha256
        )
        .is_ok());
    let reference = f.root.path().join("reference.png");
    std::fs::write(&reference, png(77)).unwrap();
    let page = s
        .attach_page_reference(
            "frozen-project",
            &page.slide_id,
            page.revision,
            super::super::reference_assets::native_selected_file(
                &std::fs::canonicalize(reference).unwrap(),
            )
            .unwrap(),
            crate::presales_queue::ReferencePurpose::Composition,
        )
        .unwrap();
    s.store
        .lock()
        .unwrap()
        .enqueue_pages(
            EnqueuePages {
                project_id: "frozen-project".into(),
                batch_id: "real-proxy-edit".into(),
                pages: vec![PageRequest {
                    slide_id: page.slide_id.clone(),
                    expected_revision: page.revision,
                    request_id: "real-proxy-edit".into(),
                    attempt_id: "real-proxy-edit-attempt".into(),
                    parent_version_id: Some(version.version_id),
                    feedback: "保持中文内容与布局".into(),
                }],
            },
            Some(&crate::presales_queue::ResultVault::open(&s.root).unwrap()),
        )
        .unwrap();
    host.wake();
    assert!(
        super::supervisor_tests::wait_until(|| s.queue_snapshot().unwrap().succeeded == 3),
        "{:?}",
        s.queue_snapshot().unwrap()
    );
    let calls = std::fs::read_to_string(&log)
        .unwrap()
        .lines()
        .map(|s| serde_json::from_str::<Value>(s).unwrap())
        .collect::<Vec<_>>();
    let turns = calls
        .iter()
        .filter(|m| m["method"] == "turn/start")
        .collect::<Vec<_>>();
    assert_eq!(turns.len(), 3);
    assert_ne!(
        turns[0]["params"]["threadId"],
        turns[1]["params"]["threadId"]
    );
    assert!(turns
        .iter()
        .any(|m| m["params"]["input"][0]["text"] == op.target.prompt));
    let edit = &turns[2]["params"]["input"];
    assert_eq!(edit.as_array().unwrap().len(), 3);
    assert_eq!(edit[1]["type"], "localImage");
    assert_eq!(edit[2]["type"], "localImage");
    assert!(edit[1]["path"].as_str().unwrap().contains("review-image-0"));
    assert!(edit[2]["path"]
        .as_str()
        .unwrap()
        .ends_with(&page.references[0].relative_path));
    let child_pid = std::fs::read_to_string(pid)
        .unwrap()
        .parse::<i32>()
        .unwrap();
    assert_eq!(
        unsafe { libc::getpgid(child_pid) },
        child_pid,
        "private provider must own its tool process group"
    );
    host.shutdown();
    host.shutdown();
    assert_eq!(
        unsafe { libc::kill(child_pid, 0) },
        -1,
        "dedicated child outlived supervisor shutdown"
    );
    assert!(
        !host.snapshot().unwrap().capabilities.generation,
        "shutdown retained an image capability lease"
    );
}

#[test]
fn image_tool_unavailable_leaves_images_queued_and_claims_text_in_same_fifo() {
    let f = Fixture::new(5);
    let s = f.service();
    super::supervisor_tests::enqueue_test_images(&s, 1);
    let draft = super::draft_tests::imported(&f, &s);
    s.request_text_authoring(RequestTextAuthoring {
        project_id: draft.summary.project_id,
        expected_revision: 1,
        stage: V3TextStage::Outline,
        operation_id: "text-capability".into(),
        attempt_id: "text-capability-attempt".into(),
    })
    .unwrap();
    let epoch = s.begin_queue_runtime().unwrap();
    let work = s
        .claim_capable_queue_work(
            epoch,
            &super::super::runtime_callbacks::ImageCapabilities::default(),
        )
        .unwrap()
        .unwrap();
    assert_eq!(work.id(), "text-capability");
    assert_eq!(s.queue_snapshot().unwrap().jobs[0].status, "queued");
    assert_eq!(s.queue_snapshot().unwrap().remote_active, 1);
}

#[test]
fn private_cancel_ack_restart_and_legacy_lifetime_preserve_unknown_slot() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new(5);
    let s = std::sync::Arc::new(f.service());
    super::supervisor_tests::enqueue_test_images(&s, 1);
    let legacy_path = f.root.path().join("legacy-synthetic");
    std::fs::write(
        &legacy_path,
        "#!/bin/sh\nprintf '%s\\n' \"$$\"\nwhile IFS= read -r line; do :; done\n",
    )
    .unwrap();
    std::fs::set_permissions(&legacy_path, std::fs::Permissions::from_mode(0o755)).unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let legacy = crate::codex_process::CodexAppServerProcess::spawn(
        &legacy_path,
        move |line| {
            let _ = tx.send(line);
        },
        |_| {},
        |_| {},
    )
    .unwrap();
    let legacy_pid = rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap()
        .parse::<i32>()
        .unwrap();
    let (command, script) = production_commands(&f, json!({"hold":true}));
    let host = super::super::runtime_host::QueueSupervisor::start_with_provider(
        s.clone(),
        command,
        Some(script),
        |_| {},
    )
    .unwrap();
    assert!(super::supervisor_tests::wait_until(|| s
        .image_lifecycle
        .lock()
        .unwrap()
        .get_job("review-image-0")
        .unwrap()
        .unwrap()
        .provider
        .is_some_and(|p| p.turn_id.is_some())));
    s.image_lifecycle
        .lock()
        .unwrap()
        .request_cancel("review-image-0")
        .unwrap();
    host.interrupt("review-image-0".into());
    let log = f.root.path().join("provider-log");
    assert!(super::supervisor_tests::wait_until(|| {
        std::fs::read_to_string(&log)
            .unwrap()
            .contains("turn/interrupt")
    }));
    assert_eq!(s.queue_snapshot().unwrap().remote_active, 1);
    assert_eq!(
        s.queue_snapshot().unwrap().jobs[0].status,
        "cancel_requested"
    );
    host.shutdown();
    assert_eq!(
        unsafe { libc::kill(legacy_pid, 0) },
        0,
        "private shutdown addressed legacy child"
    );
    legacy.stop_and_wait();
    let (command, script) = production_commands(&f, json!({"hold":true}));
    let restarted = super::super::runtime_host::QueueSupervisor::start_with_provider(
        s.clone(),
        command,
        Some(script),
        |_| {},
    )
    .unwrap();
    assert!(super::supervisor_tests::wait_until(|| restarted
        .snapshot()
        .unwrap()
        .dispatch_available));
    let snapshot = s.queue_snapshot().unwrap();
    assert_eq!(snapshot.remote_active, 1);
    assert_eq!(snapshot.jobs[0].status, "outcome_unknown");
    assert_eq!(
        std::fs::read_to_string(log)
            .unwrap()
            .lines()
            .filter(|l| serde_json::from_str::<Value>(l).unwrap()["method"] == "turn/start")
            .count(),
        1
    );
    restarted.shutdown();
}

#[test]
fn private_exit_waits_for_the_last_complete_utf8_frame() {
    use std::os::unix::fs::PermissionsExt;
    let root = temp::tempdir().unwrap();
    let binary = root.path().join("final-frame");
    std::fs::write(&binary, "#!/bin/sh\nprintf '%s\\n' '中文完成'\n").unwrap();
    std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
    let (seen, read) = std::sync::mpsc::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let (exit, exited) = std::sync::mpsc::channel();
    let child = crate::codex_process::CodexAppServerProcess::spawn_private(
        &binary,
        root.path(),
        move |line| {
            seen.send(line).unwrap();
            wait.recv_timeout(Duration::from_secs(2)).unwrap();
        },
        || {},
        move |_| {
            let _ = exit.send(());
        },
    )
    .unwrap();
    assert_eq!(
        read.recv_timeout(Duration::from_secs(1)).unwrap(),
        "中文完成"
    );
    let early = exited.recv_timeout(Duration::from_millis(100)).is_ok();
    release.send(()).unwrap();
    if !early {
        exited.recv_timeout(Duration::from_secs(1)).unwrap();
    }
    child.stop_and_wait();
    assert!(!early, "exit overtook complete stdout evidence");
}

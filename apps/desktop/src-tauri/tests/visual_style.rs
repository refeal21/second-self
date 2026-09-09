use digital_twin_desktop_lib::{
    visual_style::*,
    workbench::{CreateProjectInput, WorkbenchService},
};
use serde_json::json;

fn setup() -> (std::path::PathBuf, WorkbenchService, String) {
    let root = std::env::temp_dir().join(format!(
        "visual-style-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let service =
        WorkbenchService::open(root.join("state.sqlite"), root.join("workspace")).unwrap();
    let id = service
        .create_project(CreateProjectInput {
            name: "Style test".into(),
            goal: "Synthetic".into(),
        })
        .unwrap()
        .id;
    (root, service, id)
}
fn save(id: &str, revision: i64) -> SaveVisualStyleInput {
    serde_json::from_value(json!({"projectId":id,"expectedRevision":1,"expectedStyleRevision":revision,"profile":{"primaryColor":"#9B1C31","backgroundColor":"#FFFFFF","textColor":"#222222","accentColors":["#C8A45C"],"instructions":"Warm brand palette","template":null}})).unwrap()
}

#[test]
fn style_is_durable_without_mutating_pipeline_or_sources() {
    let (root, service, id) = setup();
    let before = service.load_pipeline(&id).unwrap();
    assert_eq!(service.load_visual_style(&id).unwrap().revision, 0);
    let state = service.save_visual_style(save(&id, 0)).unwrap();
    assert_eq!(state.revision, 1);
    assert!(!state.locked);
    assert_eq!(service.load_pipeline(&id).unwrap(), before);
    drop(service);
    let service =
        WorkbenchService::open(root.join("state.sqlite"), root.join("workspace")).unwrap();
    assert_eq!(service.load_visual_style(&id).unwrap(), state);
    assert!(service
        .save_visual_style(save(&id, 0))
        .unwrap_err()
        .contains("stale"));
    let mut stale = save(&id, 1);
    stale.expected_revision = 2;
    assert!(service
        .save_visual_style(stale)
        .unwrap_err()
        .contains("stale"));
    assert!(service.load_visual_style("unknown").is_err());
    assert!(service.save_visual_style(save("../escape", 0)).is_err());
}

#[test]
fn role_colors_and_template_references_are_validated() {
    let (_, service, id) = setup();
    for color in ["red", "#fff", "#GG0000", "#11223344", " #112233"] {
        let mut input = save(&id, 0);
        input.profile.text_color = color.into();
        assert!(service.save_visual_style(input).is_err(), "{color}");
    }
    let mut input = save(&id, 0);
    input.profile.template = Some(VisualTemplate {
        file_name: "brand.pptx".into(),
        sha256: "a".repeat(64),
        relative_path: "sources/brand.pptx".into(),
    });
    assert!(service.save_visual_style(input.clone()).is_err());
    input.profile.template.as_mut().unwrap().relative_path =
        format!("visuals/style-templates/{}.pptx", "a".repeat(64));
    assert!(service.save_visual_style(input).is_err());
    assert_eq!(service.load_visual_style(&id).unwrap().revision, 0);
}

fn ready(service: &WorkbenchService, id: &str) -> serde_json::Value {
    let mut p = service.load_pipeline(id).unwrap();
    p["revision"] = 2.into();
    p["project"]["workflowStatus"] = "visual_review".into();
    p["slideSpecs"] = json!({"version":{"id":format!("{id}-specs"),"projectId":id,"sequence":1,"status":"frozen","createdAt":"2026-09-09T00:00:00Z","frozenAt":"2026-09-09T00:00:00Z"},"value":[{"id":"page-one","title":"Approved title","body":["Approved content"]}]});
    commit(service, id, 1, &p, json!([]), None).unwrap();
    p
}
fn commit(
    service: &WorkbenchService,
    id: &str,
    base: i64,
    p: &serde_json::Value,
    writes: serde_json::Value,
    request: Option<&str>,
) -> Result<serde_json::Value, String> {
    service.commit_pipeline(serde_json::from_value(json!({"projectId":id,"expectedRevision":base,"pipeline":p,"writes":writes,"visualRequestId":request,"visualProvider":{"threadId":"observed-thread"}})).unwrap())
}
fn request(id: &str, name: &str, style: i64, base: i64) -> VisualGenerationRequest {
    serde_json::from_value(json!({"id":name,"projectId":id,"expectedRevision":base,"styleRevision":style,"slideId":"page-one","kind":"imagegen","prompt":"Render Approved title and Approved content","feedback":"Warm colors","promptVersion":"full-slide-v1"})).unwrap()
}
fn candidate(p: &serde_json::Value) -> (serde_json::Value, serde_json::Value) {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    let bytes = b"synthetic-png";
    let sha = format!("{:x}", Sha256::digest(bytes));
    let mut next = p.clone();
    next["revision"] = (p["revision"].as_i64().unwrap() + 1).into();
    let id = p["project"]["id"].as_str().unwrap();
    next["visuals"] = json!({"page-one":[{"slideId":"page-one","relativePath":"visuals/page-one-v1.png","sha256":sha,"byteLength":bytes.len(),"version":{"id":format!("{id}-visual-1"),"projectId":id,"sequence":1,"status":"draft","createdAt":"2026-09-09T00:00:00Z","frozenAt":null}}]});
    let writes = json!([{"relativePath":"visuals/page-one-v1.png","sha256":sha,"byteLength":bytes.len(),"contentsBase64":base64::engine::general_purpose::STANDARD.encode(bytes),"kind":"approved-visual-candidate","versionId":format!("{id}-visual-1"),"slideId":"page-one"}]);
    (next, writes)
}
#[test]
fn request_and_atomic_receipt_survive_restart_and_reject_reuse() {
    let (root, service, id) = setup();
    service.save_visual_style(save(&id, 0)).unwrap();
    let p = ready(&service, &id);
    let r = service
        .begin_visual_request(request(&id, "request-one", 1, 2))
        .unwrap();
    assert_eq!(r.style.profile.unwrap().primary_color, "#9B1C31");
    assert!(r.receipt.is_none());
    assert_eq!(
        r.prompt_sha256,
        "0861a72e6a5c5388e22c2531a05b9fd3b79be437d541bb7c4e0279ab74df8720"
    );
    assert_eq!(
        r.spec_sha256,
        "38b9af4422c767c974901b9419a4b166d12b85ca78e27e6bacf436138c91301d"
    );
    let (next, writes) = candidate(&p);
    assert!(commit(&service, &id, 2, &next, writes.clone(), None).is_err());
    assert!(commit(
        &service,
        &id,
        2,
        &next,
        writes.clone(),
        Some("wrong-request")
    )
    .is_err());
    commit(&service, &id, 2, &next, writes.clone(), Some("request-one")).unwrap();
    let receipt = service.visual_records(&id).unwrap()[0]
        .receipt
        .clone()
        .unwrap();
    assert_eq!(receipt.committed_revision, 3);
    assert_eq!(
        receipt.sha256,
        "294ad7145322ec19f8250cca8480a933f1ce8c9e2ad1038e7ae8930d55a6598a"
    );
    assert_eq!(
        receipt.provider.thread_id.as_deref(),
        Some("observed-thread")
    );
    assert!(commit(&service, &id, 2, &next, writes, Some("request-one")).is_err());
    drop(service);
    let service =
        WorkbenchService::open(root.join("state.sqlite"), root.join("workspace")).unwrap();
    assert_eq!(
        service.visual_records(&id).unwrap()[0].receipt.as_ref(),
        Some(&receipt)
    );
}
#[test]
fn stale_palette_blocks_completion_and_old_candidate_approval() {
    let (_, service, id) = setup();
    service.save_visual_style(save(&id, 0)).unwrap();
    let p = ready(&service, &id);
    service
        .begin_visual_request(request(&id, "request-one", 1, 2))
        .unwrap();
    let (next, writes) = candidate(&p);
    commit(&service, &id, 2, &next, writes, Some("request-one")).unwrap();
    let mut input = save(&id, 1);
    input.expected_revision = 3;
    input.profile.primary_color = "#112233".into();
    service.save_visual_style(input).unwrap();
    let mut approved = next.clone();
    approved["revision"] = 4.into();
    approved["visuals"]["page-one"][0]["version"]["status"] = "frozen".into();
    assert!(commit(&service, &id, 3, &approved, json!([]), None)
        .unwrap_err()
        .contains("style"));
    assert!(!service.load_visual_style(&id).unwrap().locked);
    assert!(service
        .begin_visual_request(request(&id, "request-two", 1, 3))
        .unwrap_err()
        .contains("stale"));
}
#[test]
fn visual_receipt_and_artifacts_roll_back_on_partial_write_failure() {
    let (root, service, id) = setup();
    service.save_visual_style(save(&id, 0)).unwrap();
    let p = ready(&service, &id);
    service
        .begin_visual_request(request(&id, "request-one", 1, 2))
        .unwrap();
    let (next, mut writes) = candidate(&p);
    let mut bad = writes[0].clone();
    bad["relativePath"] = "visuals/blocked/file.png".into();
    bad["kind"] = "test".into();
    writes.as_array_mut().unwrap().push(bad);
    std::fs::write(
        root.join("workspace").join(&id).join("visuals/blocked"),
        b"not a directory",
    )
    .unwrap();
    assert!(commit(&service, &id, 2, &next, writes, Some("request-one")).is_err());
    assert_eq!(service.load_pipeline(&id).unwrap(), p);
    assert!(service.visual_records(&id).unwrap()[0].receipt.is_none());
    assert!(!root
        .join("workspace")
        .join(&id)
        .join("visuals/page-one-v1.png")
        .exists());
}
#[test]
fn palette_lock_survives_legacy_approval_and_reopen() {
    let (root, service, id) = setup();
    service.record_source_analysis_completed(&id).unwrap();
    service.submit_outline_for_review(&id).unwrap();
    service.approve_outline(&id).unwrap();
    service.approve_details(&id).unwrap();
    service
        .approve_slide(digital_twin_desktop_lib::workbench::SlideMutationInput {
            project_id: id.clone(),
            slide: 1,
            comment: String::new(),
        })
        .unwrap();
    service.reopen_slide(&id, 1).unwrap();
    assert!(service.load_visual_style(&id).unwrap().locked);
    assert!(service
        .save_visual_style(save(&id, 0))
        .unwrap_err()
        .contains("locked"));
    drop(service);
    let service =
        WorkbenchService::open(root.join("state.sqlite"), root.join("workspace")).unwrap();
    assert!(service.load_visual_style(&id).unwrap().locked);
}
#[test]
fn styled_projects_cannot_bypass_candidate_review_via_legacy_approve() {
    let (_, service, id) = setup();
    service.save_visual_style(save(&id, 0)).unwrap();
    service.record_source_analysis_completed(&id).unwrap();
    service.submit_outline_for_review(&id).unwrap();
    service.approve_outline(&id).unwrap();
    service.approve_details(&id).unwrap();
    assert!(service
        .approve_slide(digital_twin_desktop_lib::workbench::SlideMutationInput {
            project_id: id.clone(),
            slide: 1,
            comment: String::new()
        })
        .is_err());
    assert!(!service.load_visual_style(&id).unwrap().locked);
}
#[test]
fn style_guard_applies_to_nonvisual_generation_commits() {
    let (_, service, id) = setup();
    service.save_visual_style(save(&id, 0)).unwrap();
    let mut p = service.load_pipeline(&id).unwrap();
    p["revision"] = 2.into();
    let input=serde_json::from_value(json!({"projectId":id,"expectedRevision":1,"pipeline":p,"writes":[],"expectedStyleRevision":0})).unwrap();
    assert!(service
        .commit_pipeline(input)
        .unwrap_err()
        .contains("stale style"));
}
#[test]
fn inherited_approval_history_locks_palette_even_with_reordered_json_keys() {
    let (root, service, id) = setup();
    let db = rusqlite::Connection::open(root.join("state.sqlite")).unwrap();
    let old = json!({"approvals":[{"status":"approved","stage":"visual_review"}]});
    db.execute("INSERT INTO checkpoints(project_id,sequence,workflow_status,selected_slide,slide_statuses_json,export_ready,created_at,pipeline_json) VALUES (?1,2,'visual_review',1,'[]',0,'old',?2)",rusqlite::params![id,serde_json::to_string_pretty(&old).unwrap()]).unwrap();
    assert!(service.load_visual_style(&id).unwrap().locked);
    assert!(service.save_visual_style(save(&id, 0)).is_err());
}
#[test]
fn candidate_assets_cannot_be_overwritten_under_a_different_write_kind() {
    let (root, service, id) = setup();
    service.save_visual_style(save(&id, 0)).unwrap();
    let p = ready(&service, &id);
    service
        .begin_visual_request(request(&id, "request-one", 1, 2))
        .unwrap();
    let (mut next, mut writes) = candidate(&p);
    commit(&service, &id, 2, &next, writes.clone(), Some("request-one")).unwrap();
    next["revision"] = 4.into();
    use base64::Engine;
    use sha2::{Digest, Sha256};
    let bytes = b"replaced-without-request";
    writes[0]["contentsBase64"] = base64::engine::general_purpose::STANDARD
        .encode(bytes)
        .into();
    writes[0]["sha256"] = format!("{:x}", Sha256::digest(bytes)).into();
    writes[0]["byteLength"] = bytes.len().into();
    writes[0]["kind"] = "other".into();
    assert!(commit(&service, &id, 3, &next, writes, None).is_err());
    assert_eq!(
        std::fs::read(
            root.join("workspace")
                .join(&id)
                .join("visuals/page-one-v1.png")
        )
        .unwrap(),
        b"synthetic-png"
    );
}
#[test]
fn template_bytes_are_content_addressed_immutable_and_never_sources() {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    let (root, service, id) = setup();
    let bytes = b"PK\x03\x04synthetic-template";
    let sha = format!("{:x}", Sha256::digest(bytes));
    let path = format!("visuals/style-templates/{sha}.pptx");
    let mut input = save(&id, 0);
    input.profile.template = Some(VisualTemplate {
        file_name: "brand.pptx".into(),
        sha256: sha,
        relative_path: path.clone(),
    });
    input.template_base64 = Some(base64::engine::general_purpose::STANDARD.encode(bytes));
    service.save_visual_style(input.clone()).unwrap();
    assert_eq!(
        std::fs::read(root.join("workspace").join(&id).join(&path)).unwrap(),
        bytes
    );
    assert_eq!(service.load_pipeline(&id).unwrap()["sources"], json!([]));
    input.expected_style_revision = 1;
    input.template_base64 = None;
    service.save_visual_style(input.clone()).unwrap();
    input.expected_style_revision = 2;
    input.template_base64 =
        Some(base64::engine::general_purpose::STANDARD.encode(b"PK\x03\x04tampered"));
    assert!(service.save_visual_style(input).is_err());
    assert_eq!(service.load_visual_style(&id).unwrap().revision, 2);
}
#[test]
fn pending_requests_survive_restart_and_stale_style_or_base_cannot_commit() {
    let (root, service, id) = setup();
    service.save_visual_style(save(&id, 0)).unwrap();
    let p = ready(&service, &id);
    let r = service
        .begin_visual_request(request(&id, "request-one", 1, 2))
        .unwrap();
    drop(service);
    let service =
        WorkbenchService::open(root.join("state.sqlite"), root.join("workspace")).unwrap();
    assert_eq!(service.visual_records(&id).unwrap(), vec![r]);
    assert!(service
        .begin_visual_request(request(&id, "request-one", 1, 2))
        .is_err());
    let mut input = save(&id, 1);
    input.expected_revision = 2;
    service.save_visual_style(input).unwrap();
    let (next, writes) = candidate(&p);
    assert!(
        commit(&service, &id, 2, &next, writes.clone(), Some("request-one"))
            .unwrap_err()
            .contains("stale style")
    );
    service
        .begin_visual_request(request(&id, "request-two", 2, 2))
        .unwrap();
    let mut unrelated = p.clone();
    unrelated["revision"] = 3.into();
    commit(&service, &id, 2, &unrelated, json!([]), None).unwrap();
    let (next, _) = candidate(&unrelated);
    assert!(commit(&service, &id, 3, &next, writes, Some("request-two"))
        .unwrap_err()
        .contains("stale pipeline"));
    assert!(service
        .visual_records(&id)
        .unwrap()
        .iter()
        .all(|r| r.receipt.is_none()));
}
#[test]
fn candidate_hash_slide_and_provider_must_match_saved_request() {
    let (_, service, id) = setup();
    service.save_visual_style(save(&id, 0)).unwrap();
    let p = ready(&service, &id);
    let mut upload = request(&id, "request-upload", 1, 2);
    upload.kind = "upload".into();
    upload.prompt = String::new();
    upload.prompt_version = "upload-v1".into();
    service.begin_visual_request(upload).unwrap();
    let (next, writes) = candidate(&p);
    assert!(commit(
        &service,
        &id,
        2,
        &next,
        writes.clone(),
        Some("request-upload")
    )
    .unwrap_err()
    .contains("provider"));
    let mut malformed = next.clone();
    malformed["visuals"]["page-one"][0]["sha256"] = "a".repeat(64).into();
    assert!(commit(
        &service,
        &id,
        2,
        &malformed,
        writes.clone(),
        Some("request-upload")
    )
    .unwrap_err()
    .contains("SHA-256"));
    let input=serde_json::from_value(json!({"projectId":id,"expectedRevision":2,"pipeline":next,"writes":writes,"visualRequestId":"request-upload"})).unwrap();
    service.commit_pipeline(input).unwrap();
    assert_eq!(
        service.visual_records(&id).unwrap()[0]
            .receipt
            .as_ref()
            .unwrap()
            .provider,
        VisualProvider::default()
    );
}
#[test]
fn successful_candidate_approval_permanently_locks_palette_after_pipeline_reopen() {
    let (root, service, id) = setup();
    service.save_visual_style(save(&id, 0)).unwrap();
    let p = ready(&service, &id);
    service
        .begin_visual_request(request(&id, "request-one", 1, 2))
        .unwrap();
    let (mut next, writes) = candidate(&p);
    commit(&service, &id, 2, &next, writes, Some("request-one")).unwrap();
    next["revision"] = 4.into();
    next["visuals"]["page-one"][0]["version"]["status"] = "frozen".into();
    commit(&service, &id, 3, &next, json!([]), None).unwrap();
    assert!(service.load_visual_style(&id).unwrap().locked);
    next["revision"] = 5.into();
    next["visuals"] = json!({});
    commit(&service, &id, 4, &next, json!([]), None).unwrap();
    drop(service);
    let service =
        WorkbenchService::open(root.join("state.sqlite"), root.join("workspace")).unwrap();
    assert!(service.load_visual_style(&id).unwrap().locked);
    let mut input = save(&id, 1);
    input.expected_revision = 5;
    assert!(service
        .save_visual_style(input)
        .unwrap_err()
        .contains("locked"));
    assert_eq!(service.visual_records(&id).unwrap().len(), 1);
}
#[test]
fn approval_lock_is_rolled_back_if_artifact_commit_fails() {
    let (root, service, id) = setup();
    service.save_visual_style(save(&id, 0)).unwrap();
    let p = ready(&service, &id);
    service
        .begin_visual_request(request(&id, "request-one", 1, 2))
        .unwrap();
    let (mut next, mut writes) = candidate(&p);
    commit(&service, &id, 2, &next, writes.clone(), Some("request-one")).unwrap();
    next["revision"] = 4.into();
    next["visuals"]["page-one"][0]["version"]["status"] = "frozen".into();
    writes[0]["relativePath"] = "visuals/blocked/file.png".into();
    writes[0]["kind"] = "test".into();
    std::fs::write(
        root.join("workspace").join(&id).join("visuals/blocked"),
        b"not a directory",
    )
    .unwrap();
    assert!(commit(&service, &id, 3, &next, writes, None).is_err());
    assert!(!service.load_visual_style(&id).unwrap().locked);
    assert_eq!(
        service.load_pipeline(&id).unwrap()["visuals"]["page-one"][0]["version"]["status"],
        "draft"
    );
}
#[test]
fn adopting_palette_preserves_legacy_draft_but_requires_new_provenance_to_approve() {
    let (_, service, id) = setup();
    let p = ready(&service, &id);
    let (mut next, writes) = candidate(&p);
    commit(&service, &id, 2, &next, writes, None).unwrap();
    assert!(service.visual_records(&id).unwrap().is_empty());
    let mut input = save(&id, 0);
    input.expected_revision = 3;
    service.save_visual_style(input).unwrap();
    next["revision"] = 4.into();
    next["visuals"]["page-one"][0]["version"]["status"] = "frozen".into();
    assert!(commit(&service, &id, 3, &next, json!([]), None)
        .unwrap_err()
        .contains("provenance"));
    assert_eq!(
        service.load_pipeline(&id).unwrap()["visuals"]["page-one"][0]["relativePath"],
        "visuals/page-one-v1.png"
    );
}
#[cfg(unix)]
#[test]
fn template_references_reject_symlinks_and_oversized_existing_files() {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    let (root, service, id) = setup();
    let bytes = b"PK\x03\x04template";
    let sha = format!("{:x}", Sha256::digest(bytes));
    let path = format!("visuals/style-templates/{sha}.pptx");
    let target = root.join("workspace").join(&id).join(&path);
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    let external = root.join("external.pptx");
    std::fs::write(&external, bytes).unwrap();
    std::os::unix::fs::symlink(&external, &target).unwrap();
    let mut input = save(&id, 0);
    input.profile.template = Some(VisualTemplate {
        file_name: "brand.pptx".into(),
        sha256: sha,
        relative_path: path,
    });
    assert!(service.save_visual_style(input.clone()).is_err());
    std::fs::remove_file(&target).unwrap();
    std::fs::File::create(&target)
        .unwrap()
        .set_len(50 * 1024 * 1024 + 1)
        .unwrap();
    assert!(service
        .save_visual_style(input.clone())
        .unwrap_err()
        .contains("limit"));
    input.template_base64 = Some(base64::engine::general_purpose::STANDARD.encode(bytes));
    assert!(service.save_visual_style(input).is_err());
    assert_eq!(service.load_visual_style(&id).unwrap().revision, 0);
}
#[cfg(unix)]
#[test]
fn template_reference_rejects_fifo_without_blocking_or_reading_external_data() {
    let (root, service, id) = setup();
    let sha = "a".repeat(64);
    let path = format!("visuals/style-templates/{sha}.pptx");
    let target = root.join("workspace").join(&id).join(&path);
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    let cpath = std::ffi::CString::new(target.to_str().unwrap()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(cpath.as_ptr(), 0o600) }, 0);
    let mut input = save(&id, 0);
    input.profile.template = Some(VisualTemplate {
        file_name: "brand.pptx".into(),
        sha256: sha,
        relative_path: path,
    });
    let (send, receive) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        send.send(service.save_visual_style(input)).ok();
    });
    assert!(receive
        .recv_timeout(std::time::Duration::from_millis(500))
        .expect("template reads must not block on special files")
        .is_err());
}

#[test]
fn template_save_waits_for_database_write_ownership_before_creating_assets() {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    let (root, service, id) = setup();
    let bytes = b"PK\x03\x04concurrent-template";
    let sha = format!("{:x}", Sha256::digest(bytes));
    let path = format!("visuals/style-templates/{sha}.pptx");
    let target = root.join("workspace").join(&id).join(&path);
    let mut input = save(&id, 0);
    input.profile.template = Some(VisualTemplate {
        file_name: "brand.pptx".into(),
        sha256: sha,
        relative_path: path,
    });
    input.template_base64 = Some(base64::engine::general_purpose::STANDARD.encode(bytes));
    let blocker = rusqlite::Connection::open(root.join("state.sqlite")).unwrap();
    blocker.execute_batch("BEGIN IMMEDIATE").unwrap();
    let (send, receive) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        send.send(service.save_visual_style(input)).ok();
    });
    let early = receive.recv_timeout(std::time::Duration::from_millis(200));
    let created_early = target.exists();
    blocker.execute_batch("COMMIT").unwrap();
    assert!(
        early.is_err(),
        "save must wait for the database writer before mutating files: {early:?}"
    );
    assert!(
        !created_early,
        "template file appeared without SQLite write ownership"
    );
    assert!(receive
        .recv_timeout(std::time::Duration::from_secs(2))
        .unwrap()
        .is_ok());
    assert_eq!(std::fs::read(target).unwrap(), bytes);
}

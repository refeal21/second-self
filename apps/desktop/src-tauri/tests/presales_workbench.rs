use base64::Engine;
use digital_twin_desktop_lib::{
    database::Database,
    presales::{native_value_hash, PresalesDraftPair},
    tauri_workbench::{ppt_commit_checkpoint_service, ppt_load_checkpoint_service},
    workbench::{
        ArtifactWriteInput, CreateProjectInput, PairedCheckpointCommitInput, PipelineCommitInput,
        WorkbenchService,
    },
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

fn temporary_root(name: &str) -> std::path::PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock is after epoch")
        .as_nanos();
    std::env::temp_dir().join(format!("presales-workbench-{name}-{nonce}"))
}

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../fixtures/presales/native-contract.json"
    ))
    .expect("synthetic fixture is valid")
}

fn json_write(path: &str, kind: &str, version_id: &str, value: &Value) -> ArtifactWriteInput {
    let bytes = serde_json::to_vec(value).expect("fixture serializes");
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

fn prepared_service(name: &str) -> (std::path::PathBuf, std::path::PathBuf, String, Value) {
    let root = temporary_root(name);
    std::fs::create_dir_all(&root).expect("temporary root is created");
    let database_path = root.join("state.sqlite3");
    let workspace = root.join("workspace");
    let service = WorkbenchService::open(&database_path, &workspace).expect("workbench opens");
    let project = service
        .create_project(CreateProjectInput {
            name: "Synthetic paired proposal".into(),
            goal: "Verify the native paired boundary".into(),
        })
        .expect("project is created");
    let mut analysis = service.load_pipeline(&project.id).expect("pipeline loads");
    drop(service);

    let source = fixture();
    analysis["revision"] = json!(2);
    analysis["project"]["workflowStatus"] = json!("source_analysis");
    analysis["project"]["updatedAt"] = json!("2026-09-10T00:01:00Z");
    analysis["sources"] = json!([{
        "id": "source-a", "fileName": "synthetic.txt", "mediaType": "text/plain",
        "relativePath": "sources/source-a.bin", "sha256": "a".repeat(64), "byteLength": 9
    }]);
    analysis["analysis"] = json!({
        "requestId": "analysis-1", "output": source["analysis"],
        "artifactRelativePath": "sources/analysis-1-analysis.json", "sha256": "b".repeat(64)
    });
    let database = Database::open(&database_path).expect("database opens");
    assert!(database
        .replace_pipeline(&project.id, 1, &analysis, &[])
        .expect("analysis checkpoint commits"));
    drop(database);
    (root, workspace, project.id, analysis)
}

fn outline_commit(id: &str, current: &Value) -> (PipelineCommitInput, PresalesDraftPair) {
    let mut pair: PresalesDraftPair =
        serde_json::from_value(fixture()["pair"].clone()).expect("pair decodes");
    pair.details = None;
    let mut next = current.clone();
    next["revision"] = json!(3);
    next["project"]["workflowStatus"] = json!("outline_review");
    next["project"]["updatedAt"] = json!("2026-09-10T00:02:00Z");
    next["outline"] = json!({
        "version": {
            "id": format!("{id}-outline-v1"), "projectId": id, "sequence": 1,
            "status": "draft", "createdAt": "2026-09-10T00:02:00Z", "frozenAt": null
        },
        "value": pair.outline["outline"]
    });
    let write = json_write(
        "outline/outline-r3.json",
        "outline",
        next["outline"]["version"]["id"].as_str().unwrap(),
        &next["outline"]["value"],
    );
    (
        PipelineCommitInput {
            project_id: id.into(),
            expected_revision: 2,
            pipeline: next,
            writes: vec![write],
            visual_request_id: None,
            visual_provider: None,
            expected_style_revision: None,
        },
        pair,
    )
}

fn assert_unpublished(service: &WorkbenchService, id: &str, current: &Value) {
    let loaded = service.load_project_checkpoint(id).unwrap();
    assert_eq!(loaded.pipeline, *current);
    assert!(loaded.presales.is_none());
}

fn outline_approval(current: &Value) -> Value {
    let mut next = current.clone();
    let id = current["project"]["id"].as_str().unwrap();
    let at = "2026-09-10T00:03:00Z";
    next["revision"] = json!(current["revision"].as_i64().unwrap() + 1);
    next["project"]["updatedAt"] = json!(at);
    next["project"]["workflowStatus"] = json!("detail_review");
    next["outline"]["version"]["status"] = json!("frozen");
    next["outline"]["version"]["frozenAt"] = json!(at);
    next["approvals"].as_array_mut().unwrap().push(json!({
        "id": format!("{id}-outline-approval"), "projectId": id,
        "versionId": current["outline"]["version"]["id"],
        "stage": "outline_review", "status": "approved", "decidedAt": at
    }));
    next
}

fn details_commit(id: &str, current: &Value, pair: &PresalesDraftPair) -> PipelineCommitInput {
    let mut next = current.clone();
    let revision = current["revision"].as_i64().unwrap() + 1;
    next["revision"] = json!(revision);
    next["project"]["updatedAt"] = json!("2026-09-10T00:04:00Z");
    next["slideSpecs"] = json!({
        "version": {
            "id": format!("{id}-specs-v1"), "projectId": id, "sequence": 1,
            "status": "draft", "createdAt": "2026-09-10T00:04:00Z", "frozenAt": null
        },
        "value": pair.details.as_ref().unwrap()["specs"]
    });
    let write = json_write(
        &format!("slide-specs/slide-specs-r{revision}.json"),
        "slide-specs",
        next["slideSpecs"]["version"]["id"].as_str().unwrap(),
        &json!({
            "outlineVersionId": next["outline"]["version"]["id"],
            "specs": next["slideSpecs"]["value"]
        }),
    );
    PipelineCommitInput {
        project_id: id.into(),
        expected_revision: revision - 1,
        pipeline: next,
        writes: vec![write],
        visual_request_id: None,
        visual_provider: None,
        expected_style_revision: None,
    }
}

#[test]
fn paired_commit_returns_and_reopens_the_full_checkpoint_with_immutable_artifacts() {
    let (root, workspace, id, current) = prepared_service("roundtrip");
    let service = WorkbenchService::open(root.join("state.sqlite3"), &workspace).unwrap();
    let (commit, pair) = outline_commit(&id, &current);

    let saved = ppt_commit_checkpoint_service(
        &service,
        PairedCheckpointCommitInput {
            commit,
            presales: pair.clone(),
        },
    )
    .expect("paired checkpoint commits");
    assert_eq!(saved.presales.as_ref().unwrap().draft, pair);
    assert!(service.load_pipeline(&id).is_err());
    assert_eq!(
        service.project_directory(&id).unwrap(),
        std::fs::canonicalize(workspace.join(&id))
            .unwrap()
            .to_string_lossy()
    );

    let plan_hash = native_value_hash(&pair.outline["plan"]).unwrap();
    let plan_path = workspace
        .join(&id)
        .join(format!("outline/presales/plan-r3-{plan_hash}.json"));
    assert_eq!(
        serde_json::from_slice::<Value>(&std::fs::read(plan_path).unwrap()).unwrap(),
        pair.outline["plan"]
    );
    assert_eq!(
        serde_json::from_slice::<Value>(
            &std::fs::read(workspace.join(&id).join("outline/outline-r3.json")).unwrap()
        )
        .unwrap(),
        pair.outline["outline"]
    );

    drop(service);
    let reopened = WorkbenchService::open(root.join("state.sqlite3"), &workspace).unwrap();
    assert_eq!(ppt_load_checkpoint_service(&reopened, id).unwrap(), saved);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn legacy_load_keeps_the_unknown_project_error_contract() {
    let root = temporary_root("unknown-project");
    std::fs::create_dir_all(&root).unwrap();
    let service =
        WorkbenchService::open(root.join("state.sqlite3"), root.join("workspace")).unwrap();

    assert_eq!(
        service.load_pipeline("missing-project").unwrap_err(),
        "Unknown project"
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn approval_only_writes_no_duplicate_and_details_add_exact_spec_and_design_artifacts() {
    let (root, workspace, id, current) = prepared_service("details-artifacts");
    let service = WorkbenchService::open(root.join("state.sqlite3"), &workspace).unwrap();
    let (commit, outline_only) = outline_commit(&id, &current);
    let first = service
        .commit_project_checkpoint(PairedCheckpointCommitInput {
            commit,
            presales: outline_only.clone(),
        })
        .unwrap();
    let approved = service
        .commit_project_checkpoint(PairedCheckpointCommitInput {
            commit: PipelineCommitInput {
                project_id: id.clone(),
                expected_revision: 3,
                pipeline: outline_approval(&first.pipeline),
                writes: vec![],
                visual_request_id: None,
                visual_provider: None,
                expected_style_revision: None,
            },
            presales: outline_only,
        })
        .unwrap();
    assert_eq!(service.persistence_counts(&id).unwrap().artifacts, 2);

    let pair: PresalesDraftPair =
        serde_json::from_value(fixture()["pair"].clone()).expect("rich pair decodes");
    let committed = service
        .commit_project_checkpoint(PairedCheckpointCommitInput {
            commit: details_commit(&id, &approved.pipeline, &pair),
            presales: pair.clone(),
        })
        .unwrap();
    assert_eq!(committed.presales.as_ref().unwrap().draft, pair);
    assert_eq!(service.persistence_counts(&id).unwrap().artifacts, 4);
    let designs_hash = native_value_hash(&pair.details.as_ref().unwrap()["designs"]).unwrap();
    assert!(workspace
        .join(&id)
        .join(format!(
            "slide-specs/presales/designs-r5-{designs_hash}.json"
        ))
        .is_file());
    assert!(workspace
        .join(&id)
        .join("slide-specs/slide-specs-r5.json")
        .is_file());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn first_opt_in_of_an_existing_outline_still_publishes_a_revisioned_content_file() {
    let (root, workspace, id, mut current) = prepared_service("existing-outline-opt-in");
    let (commit, pair) = outline_commit(&id, &current);
    current["project"]["workflowStatus"] = json!("outline_review");
    current["outline"] = commit.pipeline["outline"].clone();
    let raw = rusqlite::Connection::open(root.join("state.sqlite3")).unwrap();
    raw.execute(
        "UPDATE projects SET workflow_status='outline_review', pipeline_json=?2 WHERE id=?1",
        rusqlite::params![id, serde_json::to_string(&current).unwrap()],
    )
    .unwrap();
    drop(raw);
    let service = WorkbenchService::open(root.join("state.sqlite3"), &workspace).unwrap();

    service
        .commit_project_checkpoint(PairedCheckpointCommitInput {
            commit,
            presales: pair,
        })
        .expect("first paired snapshot publishes its own immutable outline content");
    assert!(workspace
        .join(&id)
        .join("outline/outline-r3.json")
        .is_file());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn malformed_pair_and_invalid_caller_paths_leave_no_paired_state() {
    for case in ["malformed", "outside"] {
        let (root, workspace, id, current) = prepared_service(case);
        let service = WorkbenchService::open(root.join("state.sqlite3"), &workspace).unwrap();
        let (mut commit, mut pair) = outline_commit(&id, &current);
        if case == "malformed" {
            pair.schema_version = 2;
        } else {
            commit.writes[0].relative_path = "../outside.json".into();
        }
        assert!(service
            .commit_project_checkpoint(PairedCheckpointCommitInput {
                commit,
                presales: pair,
            })
            .is_err());
        assert_unpublished(&service, &id, &current);
        assert!(!root.join("outside.json").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn invalid_or_oversized_pair_is_validated_before_native_companion_derivation() {
    for case in ["missing-plan", "oversized"] {
        let (root, workspace, id, current) = prepared_service(case);
        let service = WorkbenchService::open(root.join("state.sqlite3"), &workspace).unwrap();
        let (commit, mut pair) = outline_commit(&id, &current);
        let expected = if case == "missing-plan" {
            pair.outline.as_object_mut().unwrap().remove("plan");
            "missing fields"
        } else {
            pair.outline["outline"]["title"] = json!("x".repeat(20_001));
            "exceeds 20,000"
        };

        let error = service
            .commit_project_checkpoint(PairedCheckpointCommitInput {
                commit,
                presales: pair,
            })
            .unwrap_err();
        assert!(error.contains(expected), "unexpected error: {error}");
        assert_unpublished(&service, &id, &current);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn paired_v1_rejects_sha_valid_content_that_is_not_the_checkpoint_value() {
    let (root, workspace, id, current) = prepared_service("forged-content");
    let service = WorkbenchService::open(root.join("state.sqlite3"), &workspace).unwrap();
    let (mut commit, pair) = outline_commit(&id, &current);
    let mut forged = commit.pipeline["outline"]["value"].clone();
    forged["title"] = json!("forged but internally hashed");
    commit.writes[0] = json_write(
        "outline/outline-r3.json",
        "outline",
        commit.pipeline["outline"]["version"]["id"]
            .as_str()
            .unwrap(),
        &forged,
    );

    let error = service
        .commit_project_checkpoint(PairedCheckpointCommitInput {
            commit,
            presales: pair,
        })
        .unwrap_err();
    assert!(error.contains("does not match"));
    assert_unpublished(&service, &id, &current);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn normalized_presales_alias_is_rejected_as_a_native_owned_path() {
    let (root, workspace, id, current) = prepared_service("reserved-alias");
    let service = WorkbenchService::open(root.join("state.sqlite3"), &workspace).unwrap();
    let (mut commit, pair) = outline_commit(&id, &current);
    commit.writes[0].relative_path = "outline//presales/forged.json".into();

    let error = service
        .commit_project_checkpoint(PairedCheckpointCommitInput {
            commit,
            presales: pair,
        })
        .unwrap_err();
    assert!(error.contains("native-owned"), "unexpected error: {error}");
    assert_unpublished(&service, &id, &current);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn stale_paired_commit_does_not_publish_a_second_checkpoint() {
    let (root, workspace, id, current) = prepared_service("stale");
    let service = WorkbenchService::open(root.join("state.sqlite3"), &workspace).unwrap();
    let (commit, pair) = outline_commit(&id, &current);
    let input = PairedCheckpointCommitInput {
        commit,
        presales: pair,
    };
    let saved = service
        .commit_project_checkpoint(input.clone())
        .expect("first writer commits");

    assert!(service
        .commit_project_checkpoint(input)
        .unwrap_err()
        .contains("stale"));
    assert_eq!(service.load_project_checkpoint(&id).unwrap(), saved);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_late_companion_write_failure_rolls_back_database_and_prior_new_file() {
    let (root, workspace, id, current) = prepared_service("callback-rollback");
    let service = WorkbenchService::open(root.join("state.sqlite3"), &workspace).unwrap();
    let (commit, pair) = outline_commit(&id, &current);
    let plan_hash = native_value_hash(&pair.outline["plan"]).unwrap();
    let blocked = workspace
        .join(&id)
        .join(format!("outline/presales/plan-r3-{plan_hash}.json"));
    std::fs::create_dir_all(&blocked).unwrap();

    assert!(service
        .commit_project_checkpoint(PairedCheckpointCommitInput {
            commit,
            presales: pair,
        })
        .is_err());
    assert_unpublished(&service, &id, &current);
    assert!(!workspace.join(&id).join("outline/outline-r3.json").exists());
    assert!(blocked.is_dir());
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn symlinked_paired_target_is_rejected_without_state_change() {
    use std::os::unix::fs::symlink;

    let (root, workspace, id, current) = prepared_service("symlink");
    let service = WorkbenchService::open(root.join("state.sqlite3"), &workspace).unwrap();
    let (commit, pair) = outline_commit(&id, &current);
    let outside = root.join("outside.json");
    std::fs::write(&outside, b"unchanged").unwrap();
    symlink(
        &outside,
        workspace.join(&id).join("outline/outline-r3.json"),
    )
    .unwrap();

    assert!(service
        .commit_project_checkpoint(PairedCheckpointCommitInput {
            commit,
            presales: pair,
        })
        .is_err());
    assert_unpublished(&service, &id, &current);
    assert_eq!(std::fs::read(outside).unwrap(), b"unchanged");
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(feature = "acceptance-harness")]
struct JsonLineHarness {
    child: std::process::Child,
    input: Option<std::process::ChildStdin>,
    output: std::io::BufReader<std::process::ChildStdout>,
    next_id: u64,
}

#[cfg(feature = "acceptance-harness")]
impl JsonLineHarness {
    fn start(database: &std::path::Path, workspace: &std::path::Path) -> Self {
        use std::process::{Command, Stdio};

        let mut child = Command::new(env!("CARGO_BIN_EXE_production-harness"))
            .args(["--database", database.to_str().unwrap()])
            .args(["--workspace", workspace.to_str().unwrap()])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("production harness starts");
        let input = child.stdin.take().expect("harness stdin is piped");
        let output = std::io::BufReader::new(child.stdout.take().expect("harness stdout is piped"));
        Self {
            child,
            input: Some(input),
            output,
            next_id: 1,
        }
    }

    fn call(&mut self, command: &str, args: Value) -> Result<Value, String> {
        use std::io::{BufRead, Write};

        let id = self.next_id;
        self.next_id += 1;
        serde_json::to_writer(
            self.input.as_mut().expect("harness stdin remains open"),
            &json!({ "id": id, "command": command, "args": args }),
        )
        .unwrap();
        self.input.as_mut().unwrap().write_all(b"\n").unwrap();
        self.input.as_mut().unwrap().flush().unwrap();
        let mut line = String::new();
        self.output.read_line(&mut line).unwrap();
        let response: Value = serde_json::from_str(&line).expect("harness response is JSON");
        assert_eq!(response["id"], id);
        match response.get("error") {
            Some(error) => Err(error.as_str().unwrap_or("unknown harness error").into()),
            None => Ok(response["result"].clone()),
        }
    }

    fn close(mut self) {
        self.call("harness.close", json!({})).unwrap();
        drop(self.input.take());
        assert!(self.child.wait().unwrap().success());
    }
}

#[cfg(feature = "acceptance-harness")]
impl Drop for JsonLineHarness {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

#[cfg(feature = "acceptance-harness")]
fn serialized_paired_input(commit: &PipelineCommitInput, pair: &PresalesDraftPair) -> Value {
    let writes: Vec<Value> = commit
        .writes
        .iter()
        .map(|write| {
            json!({
                "relativePath": write.relative_path,
                "contentsBase64": write.contents_base64,
                "sha256": write.sha256,
                "byteLength": write.byte_length,
                "kind": write.kind,
                "versionId": write.version_id,
                "slideId": write.slide_id,
                "metadata": write.metadata,
            })
        })
        .collect();
    json!({
        "commit": {
            "projectId": commit.project_id,
            "expectedRevision": commit.expected_revision,
            "pipeline": commit.pipeline,
            "writes": writes,
            "visualRequestId": null,
            "visualProvider": null,
            "expectedStyleRevision": null,
        },
        "presales": pair,
    })
}

#[cfg(feature = "acceptance-harness")]
#[test]
fn production_harness_jsonl_process_reopens_the_exact_paired_checkpoint() {
    let (root, workspace, id, current) = prepared_service("jsonl-process");
    let database = root.join("state.sqlite3");
    let (commit, pair) = outline_commit(&id, &current);
    let input = serialized_paired_input(&commit, &pair);
    let mut first = JsonLineHarness::start(&database, &workspace);

    let saved = first
        .call("ppt_commit_checkpoint", json!({ "input": input }))
        .expect("JSONL paired commit succeeds");
    first.call("harness.restart", json!({})).unwrap();
    assert_eq!(
        first
            .call("ppt_load_checkpoint", json!({ "projectId": id }))
            .unwrap(),
        saved
    );
    assert!(first
        .call("ppt_load_pipeline", json!({ "projectId": id }))
        .unwrap_err()
        .contains("paired checkpoint"));
    let inspection = first
        .call("harness.inspect", json!({ "projectId": id }))
        .unwrap();
    assert_eq!(inspection["pipeline"], saved["pipeline"]);
    assert_eq!(inspection["checkpoint"], saved);
    first.close();

    let mut reopened = JsonLineHarness::start(&database, &workspace);
    assert_eq!(
        reopened
            .call("ppt_load_checkpoint", json!({ "projectId": id }))
            .unwrap(),
        saved
    );
    reopened.close();
    std::fs::remove_dir_all(root).unwrap();
}

use std::{
    env,
    io::{self, BufRead, Write},
    path::PathBuf,
};

use digital_twin_desktop_lib::{
    tauri_workbench::{
        load_desktop_state_service, memory_propose_service, ppt_attach_source_service,
        ppt_begin_visual_request_service, ppt_commit_checkpoint_service,
        ppt_commit_pipeline_service, ppt_create_project_service, ppt_load_checkpoint_service,
        ppt_load_pipeline_service, ppt_load_visual_style_service, ppt_prepare_qa_service,
        ppt_project_directory_service, ppt_read_artifact_service, ppt_save_visual_style_service,
        ppt_visual_records_service,
    },
    workbench::{
        AttachSourceInput, PairedCheckpointCommitInput, PipelineCommitInput, WorkbenchService,
    },
};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
struct HarnessRequest {
    id: Value,
    command: String,
    #[serde(default)]
    args: Value,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("production harness failed: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let (database_path, workspace_path) = parse_paths()?;
    let mut service = WorkbenchService::open(&database_path, &workspace_path)?;
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line.map_err(|error| format!("stdin cannot be read: {error}"))?;
        if line.trim().is_empty() {
            continue;
        }
        let request = match serde_json::from_str::<HarnessRequest>(&line) {
            Ok(request) => request,
            Err(error) => {
                write_response(
                    &mut stdout,
                    &Value::Null,
                    Err(format!("invalid request: {error}")),
                )?;
                continue;
            }
        };
        let should_close = request.command == "harness.close";
        let result = dispatch(
            &mut service,
            &database_path,
            &workspace_path,
            &request.command,
            request.args,
        );
        write_response(&mut stdout, &request.id, result)?;
        if should_close {
            break;
        }
    }
    Ok(())
}

fn parse_paths() -> Result<(PathBuf, PathBuf), String> {
    let mut args = env::args().skip(1);
    let mut database = None;
    let mut workspace = None;
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--database" => database = args.next().map(PathBuf::from),
            "--workspace" => workspace = args.next().map(PathBuf::from),
            _ => return Err(format!("unknown harness argument: {argument}")),
        }
    }
    Ok((
        database.ok_or_else(|| "--database is required".to_string())?,
        workspace.ok_or_else(|| "--workspace is required".to_string())?,
    ))
}

fn dispatch(
    service: &mut WorkbenchService,
    database_path: &PathBuf,
    workspace_path: &PathBuf,
    command: &str,
    args: Value,
) -> Result<Value, String> {
    match command {
        "load_desktop_state" => serialize(load_desktop_state_service(service)?),
        "ppt_create_project" => {
            serialize(ppt_create_project_service(service, decode_input(&args)?)?)
        }
        "ppt_load_pipeline" => ppt_load_pipeline_service(service, string_arg(&args, "projectId")?),
        "ppt_load_checkpoint" => serialize(ppt_load_checkpoint_service(
            service,
            string_arg(&args, "projectId")?,
        )?),
        "ppt_load_visual_style" => serialize(ppt_load_visual_style_service(
            service,
            string_arg(&args, "projectId")?,
        )?),
        "ppt_save_visual_style" => serialize(ppt_save_visual_style_service(
            service,
            decode_input(&args)?,
        )?),
        "ppt_begin_visual_request" => serialize(ppt_begin_visual_request_service(
            service,
            decode_input(&args)?,
        )?),
        "ppt_visual_records" => serialize(ppt_visual_records_service(
            service,
            string_arg(&args, "projectId")?,
        )?),
        "ppt_project_directory" => serialize(ppt_project_directory_service(
            service,
            string_arg(&args, "projectId")?,
        )?),
        "ppt_read_artifact" => serialize(ppt_read_artifact_service(
            service,
            string_arg(&args, "projectId")?,
            string_arg(&args, "relativePath")?,
        )?),
        "ppt_prepare_qa" => ppt_prepare_qa_service(service, string_arg(&args, "projectId")?),
        "ppt_attach_source" => {
            ppt_attach_source_service(service, decode_input::<AttachSourceInput>(&args)?)
        }
        "ppt_commit_pipeline" => {
            ppt_commit_pipeline_service(service, decode_input::<PipelineCommitInput>(&args)?)
        }
        "ppt_commit_checkpoint" => serialize(ppt_commit_checkpoint_service(
            service,
            decode_input::<PairedCheckpointCommitInput>(&args)?,
        )?),
        "memory_propose" => serialize(memory_propose_service(
            service,
            string_arg(&args, "title")?,
            string_arg(&args, "content")?,
        )?),
        "harness.restart" => {
            *service = WorkbenchService::open(database_path, workspace_path)?;
            Ok(json!({ "restarted": true }))
        }
        "harness.inspect" => {
            let project_id = string_arg(&args, "projectId")?;
            let checkpoint = ppt_load_checkpoint_service(service, project_id.clone())?;
            let counts = service.persistence_counts(&project_id)?;
            let directory = ppt_project_directory_service(service, project_id)?;
            Ok(json!({
                "pipeline": checkpoint.pipeline,
                "checkpoint": checkpoint,
                "counts": {
                    "versions": counts.versions,
                    "approvals": counts.approvals,
                    "tasks": counts.tasks,
                    "artifacts": counts.artifacts,
                },
                "projectDirectory": directory,
                "databasePath": database_path,
                "workspacePath": workspace_path,
            }))
        }
        "harness.close" => Ok(json!({ "closed": true })),
        _ => Err(format!("unknown production command: {command}")),
    }
}

fn decode_input<T: for<'de> Deserialize<'de>>(args: &Value) -> Result<T, String> {
    let input = args
        .get("input")
        .cloned()
        .ok_or_else(|| "input is required".to_string())?;
    serde_json::from_value(input).map_err(|error| format!("input is invalid: {error}"))
}

fn string_arg(args: &Value, name: &str) -> Result<String, String> {
    args.get(name)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("{name} is required"))
}

fn serialize<T: serde::Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|error| format!("result cannot be serialized: {error}"))
}

fn write_response(
    output: &mut impl Write,
    id: &Value,
    result: Result<Value, String>,
) -> Result<(), String> {
    let response = match result {
        Ok(value) => json!({ "id": id, "result": value }),
        Err(error) => json!({ "id": id, "error": error }),
    };
    serde_json::to_writer(&mut *output, &response)
        .map_err(|error| format!("response cannot be encoded: {error}"))?;
    output
        .write_all(b"\n")
        .and_then(|_| output.flush())
        .map_err(|error| format!("response cannot be written: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use digital_twin_desktop_lib::{database::Database, workbench::CreateProjectInput};
    use sha2::{Digest, Sha256};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn paired_dispatch_values_survive_service_restart_and_guard_legacy_load() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("presales-production-harness-{nonce}"));
        std::fs::create_dir_all(&root).unwrap();
        let database_path = root.join("state.sqlite3");
        let workspace_path = root.join("workspace");
        let mut service = WorkbenchService::open(&database_path, &workspace_path).unwrap();
        let project = service
            .create_project(CreateProjectInput {
                name: "Serialized proposal".into(),
                goal: "Exercise the real command codec".into(),
            })
            .unwrap();
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../../fixtures/presales/native-contract.json"
        ))
        .unwrap();
        let mut current = service.load_pipeline(&project.id).unwrap();
        current["revision"] = json!(2);
        current["project"]["workflowStatus"] = json!("source_analysis");
        current["project"]["updatedAt"] = json!("2026-09-10T00:01:00Z");
        current["sources"] = json!([{
            "id": "source-a", "fileName": "synthetic.txt", "mediaType": "text/plain",
            "relativePath": "sources/source-a.bin", "sha256": "a".repeat(64), "byteLength": 9
        }]);
        current["analysis"] = json!({
            "requestId": "analysis-1", "output": fixture["analysis"],
            "artifactRelativePath": "sources/analysis-1-analysis.json", "sha256": "b".repeat(64)
        });
        let database = Database::open(&database_path).unwrap();
        assert!(database
            .replace_pipeline(&project.id, 1, &current, &[])
            .unwrap());
        drop(database);
        dispatch(
            &mut service,
            &database_path,
            &workspace_path,
            "harness.restart",
            json!({}),
        )
        .unwrap();

        let mut pair = fixture["pair"].clone();
        pair["details"] = Value::Null;
        let mut next = current;
        next["revision"] = json!(3);
        next["project"]["workflowStatus"] = json!("outline_review");
        next["project"]["updatedAt"] = json!("2026-09-10T00:02:00Z");
        next["outline"] = json!({
            "version": { "id": format!("{}-outline-v1", project.id), "projectId": project.id,
                "sequence": 1, "status": "draft", "createdAt": "2026-09-10T00:02:00Z", "frozenAt": null },
            "value": pair["outline"]["outline"]
        });
        let bytes = serde_json::to_vec(&next["outline"]["value"]).unwrap();
        let input = json!({
            "commit": {
                "projectId": project.id, "expectedRevision": 2, "pipeline": next,
                "writes": [{
                    "relativePath": "outline/outline-r3.json",
                    "contentsBase64": base64::engine::general_purpose::STANDARD.encode(&bytes),
                    "sha256": format!("{:x}", Sha256::digest(&bytes)), "byteLength": bytes.len(),
                    "kind": "outline", "versionId": format!("{}-outline-v1", project.id),
                    "slideId": null, "metadata": null
                }],
                "visualRequestId": null, "visualProvider": null, "expectedStyleRevision": null
            },
            "presales": pair
        });
        let saved = dispatch(
            &mut service,
            &database_path,
            &workspace_path,
            "ppt_commit_checkpoint",
            json!({ "input": input }),
        )
        .expect("serialized paired commit succeeds");
        dispatch(
            &mut service,
            &database_path,
            &workspace_path,
            "harness.restart",
            json!({}),
        )
        .unwrap();
        let loaded = dispatch(
            &mut service,
            &database_path,
            &workspace_path,
            "ppt_load_checkpoint",
            json!({ "projectId": project.id }),
        )
        .expect("serialized paired load succeeds after restart");
        assert_eq!(loaded, saved);
        assert!(dispatch(
            &mut service,
            &database_path,
            &workspace_path,
            "ppt_load_pipeline",
            json!({ "projectId": project.id }),
        )
        .is_err());
        let inspection = dispatch(
            &mut service,
            &database_path,
            &workspace_path,
            "harness.inspect",
            json!({ "projectId": project.id }),
        )
        .expect("paired-aware inspection succeeds");
        assert_eq!(inspection["pipeline"], saved["pipeline"]);
        assert_eq!(inspection["checkpoint"], saved);
        std::fs::remove_dir_all(root).unwrap();
    }
}

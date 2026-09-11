use super::{CapturedLegacySnapshot, LegacyValidatorProcess};
use rusqlite::{params, Connection};
use serde_json::json;
use std::{path::Path, process::Command, time::Duration};

#[path = "../../tests/support/v3_temp.rs"]
mod temp;

fn snapshot() -> (CapturedLegacySnapshot, temp::TempDir) {
    let root = temp::tempdir().unwrap();
    let staging = temp::tempdir().unwrap();
    let connection = Connection::open(root.path().join("source.sqlite3")).unwrap();
    connection
        .execute_batch("CREATE TABLE projects(id TEXT PRIMARY KEY, pipeline_json TEXT)")
        .unwrap();
    let pipeline = json!({"schemaVersion":1,"revision":1,"project":{"id":"source","name":"中文合成案例",
        "goal":"Only synthetic fixtures","workflowStatus":"intake","createdAt":"2026-09-11T00:00:00Z","updatedAt":"2026-09-11T00:00:00Z"},
        "preferenceSnapshot":[],"sources":[],"analysis":null,"outline":null,"slideSpecs":null,"visuals":{},
        "currentSlideId":null,"approvals":[],"tasks":[],"blockedCondition":null,"exportReceipt":null,"qaReport":null});
    connection
        .execute(
            "INSERT INTO projects VALUES (?1, ?2)",
            params!["source", pipeline.to_string()],
        )
        .unwrap();
    drop(connection);
    (
        CapturedLegacySnapshot::capture(
            root.path(),
            Path::new("source.sqlite3"),
            "source",
            staging.path(),
        )
        .unwrap(),
        root,
    )
}

fn scripted(script: &str) -> Command {
    let mut command = Command::new("node");
    command.args(["-e", script]);
    command
}

const RESPONSE: &str = r#"
let input=''; process.stdin.on('data', b => input += b); process.stdin.on('end', () => {
  const q=JSON.parse(input), s=JSON.parse(q.params.snapshot);
  const response={jsonrpc:'2.0',id:q.id,result:{generation:q.params.generation,validation:{
    schemaVersion:1,validator:'native-pipeline-checkpoint-v1',
    snapshotSha256:require('crypto').createHash('sha256').update(q.params.snapshot).digest('hex'),
    byteLength:Buffer.byteLength(q.params.snapshot),projectId:s.project.id,revision:s.revision,pipelineSchemaVersion:s.schemaVersion}}};
  MUTATION
});
"#;

#[test]
fn actual_offline_worker_produces_native_owned_digest_bound_replay_token() {
    let worker = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../worker");
    let mut command = Command::new("node");
    command
        .arg("--import")
        .arg(worker.join("node_modules/tsx/dist/loader.mjs"))
        .arg(worker.join("src/sidecar-cli.ts"))
        .arg("--presales-validate");
    let host = LegacyValidatorProcess::from_test_command(command, Duration::from_secs(10));
    let (snapshot, _root) = snapshot();
    let expected = snapshot.snapshot_sha256().to_string();
    let proven = host.validate(snapshot).unwrap();
    assert_eq!(proven.snapshot().project_id(), "source");
    assert_eq!(proven.snapshot().snapshot_sha256(), expected);
    proven.recheck().unwrap();
}

#[test]
fn actual_child_wrong_correlation_schema_digest_and_extra_fields_are_rejected() {
    for mutation in [
        "response.id='stale';",
        "response.result.generation++;",
        "response.result.validation.schemaVersion=2;",
        "response.result.validation.validator='fake';",
        "response.result.validation.snapshotSha256='a'.repeat(64);",
        "response.result.validation.revision++;",
        "response.result.validation.byteLength++;",
        "response.result.validation.projectId='other';",
        "response.result.validation.pipelineSchemaVersion=3;",
        "response.result.valid=true;",
    ] {
        let command = scripted(&RESPONSE.replace(
            "MUTATION",
            &format!("{mutation} process.stdout.write(JSON.stringify(response)+'\\n');"),
        ));
        let host = LegacyValidatorProcess::from_test_command(command, Duration::from_secs(3));
        let (snapshot, _root) = snapshot();
        assert!(host.validate(snapshot).is_err(), "accepted {mutation}");
    }
}

#[test]
fn complete_bounded_utf8_response_is_required_before_replay_authority() {
    for script in [
        "process.stdout.write('{broken\\n');",
        "process.stdout.write(Buffer.from([0xff,10]));",
        "process.stdout.write('x'.repeat(32769));",
        "process.stderr.write('x'.repeat(16385));",
        "process.exit(3)",
        "setInterval(()=>{},1000)",
    ] {
        let host =
            LegacyValidatorProcess::from_test_command(scripted(script), Duration::from_millis(200));
        let (snapshot, _root) = snapshot();
        assert!(host.validate(snapshot).is_err(), "accepted {script}");
    }
    for mutation in [
        "process.stdout.write(JSON.stringify(response));",
        "process.stdout.write(JSON.stringify(response)+'\\n'+JSON.stringify(response)+'\\n');",
        "process.stdout.write(JSON.stringify(response)+'\\n'); process.stderr.write('unexpected');",
    ] {
        let host = LegacyValidatorProcess::from_test_command(
            scripted(&RESPONSE.replace("MUTATION", mutation)),
            Duration::from_secs(3),
        );
        let (snapshot, _root) = snapshot();
        assert!(host.validate(snapshot).is_err());
    }
    let command = scripted(&RESPONSE.replace("MUTATION", "const b=Buffer.from(JSON.stringify(response)+'\\n'); for(const byte of b) process.stdout.write(Buffer.from([byte]));"));
    let host = LegacyValidatorProcess::from_test_command(command, Duration::from_secs(3));
    let (snapshot, _root) = snapshot();
    assert!(host.validate(snapshot).is_ok());
}

#[test]
fn native_child_reader_preserves_chinese_utf8_split_inside_a_codepoint() {
    let mut command = scripted("const b=Buffer.from('{\"error\":\"中文合成故障\"}\\n'); const i=b.indexOf(Buffer.from('中'))+1; process.stdout.write(b.subarray(0,i)); setTimeout(()=>process.stdout.write(b.subarray(i)),20);");
    let bytes = super::run_child(&mut command, b"{}\n".to_vec(), Duration::from_secs(3)).unwrap();
    assert_eq!(
        String::from_utf8(bytes).unwrap(),
        "{\"error\":\"中文合成故障\"}\n"
    );
}

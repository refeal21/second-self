use std::{
    collections::HashSet,
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::mpsc,
    time::Duration,
};

use digital_twin_desktop_lib::codex_process::{
    build_codex_app_server_command, resolve_codex_binary, CodexAppServerProcess, CodexBinaryProbe,
    SystemCodexBinaryProbe, CHATGPT_BUNDLED_CODEX_PATH,
};

#[derive(Default)]
struct FakeProbe {
    executable_paths: HashSet<PathBuf>,
    path_codex: Option<PathBuf>,
}

impl CodexBinaryProbe for FakeProbe {
    fn is_executable(&self, path: &Path) -> bool {
        self.executable_paths.contains(path)
    }

    fn find_on_path(&self, binary_name: &str) -> Option<PathBuf> {
        assert_eq!(binary_name, "codex");
        self.path_codex.clone()
    }
}

#[test]
fn configured_binary_wins_over_path_and_chatgpt_bundle() {
    let configured = PathBuf::from("/custom/codex");
    let path_codex = PathBuf::from("/usr/local/bin/codex");
    let bundled = PathBuf::from(CHATGPT_BUNDLED_CODEX_PATH);
    let probe = FakeProbe {
        executable_paths: HashSet::from([configured.clone(), path_codex.clone(), bundled]),
        path_codex: Some(path_codex),
    };

    let resolved = resolve_codex_binary(Some(&configured), &probe).unwrap();

    assert_eq!(resolved, configured);
}

#[test]
fn path_codex_wins_when_no_valid_configured_binary_exists() {
    let path_codex = PathBuf::from("/opt/homebrew/bin/codex");
    let probe = FakeProbe {
        executable_paths: HashSet::from([path_codex.clone()]),
        path_codex: Some(path_codex.clone()),
    };

    let resolved = resolve_codex_binary(Some(Path::new("/missing/codex")), &probe).unwrap();

    assert_eq!(resolved, path_codex);
}

#[test]
fn chatgpt_bundle_is_the_final_binary_fallback() {
    let bundled = PathBuf::from(CHATGPT_BUNDLED_CODEX_PATH);
    let probe = FakeProbe {
        executable_paths: HashSet::from([bundled.clone()]),
        path_codex: None,
    };

    let resolved = resolve_codex_binary(None, &probe).unwrap();

    assert_eq!(resolved, bundled);
}

#[test]
fn app_server_command_uses_stdio_jsonl_transport() {
    let command = build_codex_app_server_command(Path::new("/custom/codex"));

    assert_eq!(command.get_program(), "/custom/codex");
    assert_eq!(
        command.get_args().collect::<Vec<_>>(),
        ["app-server", "--listen", "stdio://"],
    );
}

#[test]
fn process_writes_and_streams_jsonl_and_reports_exit() {
    let fixture_directory =
        std::env::temp_dir().join(format!("digital-twin-codex-process-{}", std::process::id(),));
    fs::create_dir_all(&fixture_directory).unwrap();
    let fixture = fixture_directory.join("fake-codex");
    fs::write(&fixture, "#!/bin/sh\nread line\nprintf '%s\\n' \"$line\"\n").unwrap();
    fs::set_permissions(&fixture, fs::Permissions::from_mode(0o755)).unwrap();

    let (line_sender, line_receiver) = mpsc::channel();
    let (exit_sender, exit_receiver) = mpsc::channel();
    let process = CodexAppServerProcess::spawn(
        &fixture,
        move |line| line_sender.send(line).unwrap(),
        |_| {},
        move |exit| exit_sender.send(exit).unwrap(),
    )
    .unwrap();

    process
        .write_line(r#"{"id":1,"method":"initialize"}"#)
        .unwrap();

    assert_eq!(
        line_receiver.recv_timeout(Duration::from_secs(2)).unwrap(),
        r#"{"id":1,"method":"initialize"}"#,
    );
    let exit = exit_receiver.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(exit.code, Some(0));
    assert_eq!(exit.signal, None);

    drop(process);
    fs::remove_dir_all(fixture_directory).unwrap();
}

#[test]
fn system_probe_rejects_a_file_without_execute_permission() {
    let fixture = std::env::temp_dir().join(format!(
        "digital-twin-non-executable-codex-{}",
        std::process::id(),
    ));
    fs::write(&fixture, "not executable").unwrap();
    fs::set_permissions(&fixture, fs::Permissions::from_mode(0o644)).unwrap();

    assert!(!SystemCodexBinaryProbe.is_executable(&fixture));

    fs::remove_file(fixture).unwrap();
}

use std::{collections::BTreeMap, path::PathBuf};

use glob::Pattern;
use tauri_utils::{
    acl::{
        capability::{Capability, CapabilityFile},
        manifest::Manifest,
        resolved::Resolved,
        Value,
    },
    platform::Target,
};

fn project_file(path: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(path)
}

fn main_capability() -> Capability {
    match CapabilityFile::load(project_file("capabilities/main.json"))
        .expect("main capability parses")
    {
        CapabilityFile::Capability(capability) => capability,
        _ => panic!("main capability must remain a single capability"),
    }
}

fn resolved_main_acl() -> Resolved {
    let manifests: BTreeMap<String, Manifest> = serde_json::from_reader(
        std::fs::File::open(project_file("gen/schemas/acl-manifests.json"))
            .expect("generated Tauri ACL manifests exist"),
    )
    .expect("generated Tauri ACL manifests parse");
    let capability = main_capability();
    Resolved::resolve(
        &manifests,
        BTreeMap::from([(capability.identifier.clone(), capability)]),
        Target::MacOS,
    )
    .expect("Tauri resolves the main capability")
}

fn allowed_login_url(scope: &[Value], url: &str) -> bool {
    scope.iter().any(|entry| {
        let Value::Map(entry) = entry else {
            return false;
        };
        let Some(Value::String(pattern)) = entry.get("url") else {
            return false;
        };
        // Omitting `app` means the plugin may use only the system default
        // browser, which is how the frontend calls `openUrl`.
        if entry.contains_key("app") {
            return false;
        }
        Pattern::new(pattern)
            .expect("Tauri accepted opener URL glob")
            .matches(url)
    })
}

#[test]
fn only_main_window_can_complete_a_confirmed_native_close() {
    let resolved = resolved_main_acl();
    let commands = resolved
        .allowed_commands
        .get("plugin:window|destroy")
        .expect("native close listener needs window destroy after user confirmation");
    assert!(commands
        .iter()
        .any(|command| command.windows.iter().any(|window| window.matches("main"))));
    assert!(!commands.iter().any(|command| command
        .windows
        .iter()
        .any(|window| window.matches("secondary"))));
    for forbidden in [
        "plugin:window|create",
        "plugin:window|close",
        "plugin:window|set_title",
    ] {
        assert!(!resolved.allowed_commands.contains_key(forbidden));
    }
}

#[test]
fn main_window_can_open_only_official_https_login_urls() {
    let resolved = resolved_main_acl();
    for forbidden_command in [
        "plugin:opener|open_path",
        "plugin:opener|reveal_item_in_dir",
        "plugin:shell|open",
        "plugin:shell|execute",
        "plugin:shell|spawn",
    ] {
        assert!(
            !resolved.allowed_commands.contains_key(forbidden_command),
            "login capability must not grant {forbidden_command}",
        );
    }
    assert!(
        !resolved
            .allowed_commands
            .keys()
            .any(|command| command.starts_with("plugin:fs|")),
        "login capability must not grant filesystem access",
    );
    let commands = resolved
        .allowed_commands
        .get("plugin:opener|open_url")
        .expect("main window must receive the opener open_url command");
    let scope_id = commands
        .iter()
        .find(|command| command.windows.iter().any(|window| window.matches("main")))
        .and_then(|command| command.scope_id)
        .expect("main opener command must have a URL allow scope");
    let scope = &resolved
        .command_scope
        .get(&scope_id)
        .expect("main opener scope resolves")
        .allow;

    assert!(allowed_login_url(
        scope,
        "https://auth.openai.com/log-in?next=/"
    ));
    assert!(allowed_login_url(
        scope,
        "https://chatgpt.com/auth/callback?code=abc"
    ));
    assert!(allowed_login_url(
        scope,
        "https://chat.openai.com/auth/login"
    ));
    assert!(!allowed_login_url(scope, "http://auth.openai.com/log-in"));
    assert!(!allowed_login_url(
        scope,
        "file:///Users/example/login.html"
    ));
    assert!(!allowed_login_url(scope, "https://evil.example/login"));
    assert!(!allowed_login_url(
        scope,
        "https://auth.openai.com.evil.example/log-in"
    ));
}

#[test]
fn compiled_main_acl_reaches_opener_scope_without_launching_a_browser() {
    let app = tauri::test::mock_builder()
        .plugin(tauri_plugin_opener::init())
        .build(tauri::generate_context!())
        .expect("compiled desktop context builds with the opener plugin");
    let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("main window builds");
    let response = tauri::test::get_ipc_response(
        &window,
        tauri::webview::InvokeRequest {
            cmd: "plugin:opener|open_url".into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "tauri://localhost".parse().expect("local Tauri origin"),
            body: serde_json::json!({ "url": "file:///tmp/login.html", "with": null }).into(),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_string(),
        },
    )
    .expect_err("file URL must be rejected without launching a browser");

    let error = response.to_string();
    assert!(error.contains("Not allowed to open url file:///tmp/login.html"));
    assert!(
        !error.contains("plugin:opener|open_url not allowed"),
        "the compiled ACL must reach opener's URL scope instead of rejecting the command",
    );
}

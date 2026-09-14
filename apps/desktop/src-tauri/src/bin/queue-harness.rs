//! Synthetic acceptance transport, not an application daemon or Worker scheduler.
use digital_twin_desktop_lib::presales_queue::{handle_queue_rpc_line, QueueStore};
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

const MAX_LINE: usize = 262_144;

fn main() {
    if run().is_err() {
        eprintln!("Queue harness failed");
        std::process::exit(1);
    }
}

fn run() -> Result<(), ()> {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new("--database")) {
        return Err(());
    }
    let database = args.next().filter(|value| !value.is_empty()).ok_or(())?;
    if args.next().is_some() || database == ":memory:" {
        return Err(());
    }
    let mut store = QueueStore::open(database).map_err(|_| ())?;
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut input = stdin.lock();
    let mut output = stdout.lock();
    let mut line = Vec::new();
    let mut oversized = false;
    loop {
        let available = input.fill_buf().map_err(|_| ())?;
        if available.is_empty() {
            if !line.is_empty() || oversized {
                respond(&mut store, &line, oversized, &mut output)?;
            }
            return Ok(());
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let length = newline.unwrap_or(available.len());
        if !oversized {
            if length > MAX_LINE - line.len() {
                oversized = true;
                line.clear();
            } else {
                line.extend_from_slice(&available[..length]);
            }
        }
        // Discard all remaining chunks of an oversized frame until its newline.
        input.consume(length + usize::from(newline.is_some()));
        if newline.is_some() {
            if respond(&mut store, &line, oversized, &mut output)? {
                return Ok(());
            }
            line.clear();
            oversized = false;
        }
    }
}

fn respond(
    store: &mut QueueStore,
    line: &[u8],
    oversized: bool,
    output: &mut impl Write,
) -> Result<bool, ()> {
    let mut close = false;
    let response = if oversized {
        json!({"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Invalid Request"}})
            .to_string()
    } else if let Ok(line) = std::str::from_utf8(line) {
        let response = handle_queue_rpc_line(store, line);
        // The reusable dispatcher validates the complete strict envelope first.
        // Only this feature-gated executable owns the harness-only close command.
        let decoded: Value = serde_json::from_str(&response).map_err(|_| ())?;
        if decoded["error"]["code"] == -32601 {
            let request: Value = serde_json::from_str(line).map_err(|_| ())?;
            if request["method"] == "harness.close" {
                if request["params"]
                    .as_object()
                    .is_some_and(|params| params.is_empty())
                {
                    close = true;
                    json!({"jsonrpc":"2.0","id":decoded["id"],"result":null}).to_string()
                } else {
                    json!({"jsonrpc":"2.0","id":decoded["id"],"error":{"code":-32602,"message":"Invalid params"}}).to_string()
                }
            } else {
                response
            }
        } else {
            response
        }
    } else {
        json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}})
            .to_string()
    };
    writeln!(output, "{response}").map_err(|_| ())?;
    output.flush().map_err(|_| ())?;
    Ok(close)
}

use std::{
    env, fs,
    io::{self, BufRead},
    path::PathBuf,
    sync::mpsc,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SamplerEvent {
    operation: Option<String>,
    at: Option<String>,
    stop: Option<bool>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessRecord {
    pid: i32,
    ppid: i32,
    rss_kib: u64,
    command: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Sample {
    at: String,
    elapsed_ms: u128,
    operation: String,
    rss_kib: u64,
    processes: Vec<ProcessRecord>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OperationEvent {
    operation: String,
    at: String,
    elapsed_ms: u128,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("RSS sampler failed: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let (root_pid, output) = parse_args()?;
    let (sender, receiver) = mpsc::channel::<SamplerEvent>();
    thread::spawn(move || {
        for line in io::stdin().lock().lines().map_while(Result::ok) {
            if let Ok(event) = serde_json::from_str::<SamplerEvent>(&line) {
                if sender.send(event).is_err() {
                    break;
                }
            }
        }
        let _ = sender.send(SamplerEvent {
            operation: None,
            at: None,
            stop: Some(true),
        });
    });

    let started = Instant::now();
    let measured_at = now_string();
    let mut current_operation = "harness-start".to_string();
    let mut events = Vec::new();
    let mut samples = Vec::new();
    let mut stop = false;
    while !stop {
        while let Ok(event) = receiver.try_recv() {
            if event.stop == Some(true) {
                stop = true;
            }
            if let Some(operation) = event.operation {
                current_operation = operation.clone();
                events.push(OperationEvent {
                    operation,
                    at: event.at.unwrap_or_else(now_string),
                    elapsed_ms: started.elapsed().as_millis(),
                });
                samples.push(capture_sample(root_pid, &current_operation, &started)?);
            }
        }
        samples.push(capture_sample(root_pid, &current_operation, &started)?);
        if !stop {
            thread::sleep(Duration::from_millis(100));
        }
    }
    let peak = samples
        .iter()
        .max_by_key(|sample| sample.rss_kib)
        .ok_or_else(|| "RSS sampler produced no samples".to_string())?;
    let report = serde_json::json!({
        "schemaVersion": 3,
        "measuredAt": measured_at,
        "rootPid": root_pid,
        "sampleCount": samples.len(),
        "peakRssKiB": peak.rss_kib,
        "peakRssMiB": ((peak.rss_kib as f64 / 1024.0) * 10.0).round() / 10.0,
        "peakProcesses": peak.processes,
        "gateMiB": 4096,
        "passed": peak.rss_kib < 4096 * 1024,
        "operationEvents": events,
        "samples": samples,
    });
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("RSS evidence directory cannot be created: {error}"))?;
    }
    fs::write(
        &output,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&report)
                .map_err(|error| format!("RSS report cannot be encoded: {error}"))?
        ),
    )
    .map_err(|error| format!("RSS report cannot be written: {error}"))?;
    Ok(())
}

fn capture_sample(root_pid: i32, operation: &str, started: &Instant) -> Result<Sample, String> {
    let processes = process_tree(root_pid)?;
    Ok(Sample {
        at: now_string(),
        elapsed_ms: started.elapsed().as_millis(),
        operation: operation.to_string(),
        rss_kib: processes.iter().map(|process| process.rss_kib).sum(),
        processes,
    })
}

fn parse_args() -> Result<(i32, PathBuf), String> {
    let mut args = env::args().skip(1);
    let mut root_pid = None;
    let mut output = None;
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--root-pid" => root_pid = args.next().and_then(|value| value.parse::<i32>().ok()),
            "--output" => output = args.next().map(PathBuf::from),
            _ => return Err(format!("unknown RSS sampler argument: {argument}")),
        }
    }
    let root_pid = root_pid
        .filter(|pid| *pid > 0)
        .ok_or_else(|| "--root-pid is required".to_string())?;
    let output = output.ok_or_else(|| "--output is required".to_string())?;
    Ok((root_pid, output))
}

fn now_string() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("unix-ms:{millis}")
}

#[cfg(target_os = "macos")]
fn process_tree(root_pid: i32) -> Result<Vec<ProcessRecord>, String> {
    let mut pending = vec![(root_pid, 0)];
    let mut records = Vec::new();
    while let Some((pid, ppid)) = pending.pop() {
        if let Some((rss_kib, command)) = process_info(pid) {
            records.push(ProcessRecord {
                pid,
                ppid,
                rss_kib,
                command,
            });
            pending.extend(child_pids(pid).into_iter().map(|child| (child, pid)));
        }
    }
    records.sort_by_key(|record| record.pid);
    if records.is_empty() {
        return Err(format!("root process {root_pid} is unavailable"));
    }
    Ok(records)
}

#[cfg(target_os = "macos")]
fn child_pids(pid: i32) -> Vec<i32> {
    const CAPACITY: usize = 4096;
    let mut children = vec![0_i32; CAPACITY];
    let count = unsafe {
        proc_listchildpids(
            pid,
            children.as_mut_ptr().cast(),
            (children.len() * std::mem::size_of::<i32>()) as i32,
        )
    };
    if count <= 0 {
        return Vec::new();
    }
    children.truncate((count as usize).min(children.len()));
    children.retain(|child| *child > 0);
    children
}

#[cfg(target_os = "macos")]
fn process_info(pid: i32) -> Option<(u64, String)> {
    const PROC_PIDTASKINFO: i32 = 4;
    let mut task = ProcTaskInfo::default();
    let returned = unsafe {
        proc_pidinfo(
            pid,
            PROC_PIDTASKINFO,
            0,
            (&mut task as *mut ProcTaskInfo).cast(),
            std::mem::size_of::<ProcTaskInfo>() as i32,
        )
    };
    if returned != std::mem::size_of::<ProcTaskInfo>() as i32 {
        return None;
    }
    let mut path = vec![0_u8; 4096];
    let length = unsafe { proc_pidpath(pid, path.as_mut_ptr().cast(), path.len() as u32) };
    let command = if length > 0 {
        String::from_utf8_lossy(&path[..length as usize]).into_owned()
    } else {
        format!("pid:{pid}")
    };
    Some((task.resident_size / 1024, command))
}

#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Default)]
struct ProcTaskInfo {
    virtual_size: u64,
    resident_size: u64,
    total_user: u64,
    total_system: u64,
    threads_user: u64,
    threads_system: u64,
    policy: i32,
    faults: i32,
    pageins: i32,
    cow_faults: i32,
    messages_sent: i32,
    messages_received: i32,
    syscalls_mach: i32,
    syscalls_unix: i32,
    context_switches: i32,
    thread_count: i32,
    running_count: i32,
    priority: i32,
}

#[cfg(target_os = "macos")]
#[link(name = "proc")]
extern "C" {
    fn proc_listchildpids(ppid: i32, buffer: *mut std::ffi::c_void, buffersize: i32) -> i32;
    fn proc_pidinfo(
        pid: i32,
        flavor: i32,
        arg: u64,
        buffer: *mut std::ffi::c_void,
        buffersize: i32,
    ) -> i32;
    fn proc_pidpath(pid: i32, buffer: *mut std::ffi::c_void, buffersize: u32) -> i32;
}

#[cfg(not(target_os = "macos"))]
fn process_tree(_root_pid: i32) -> Result<Vec<ProcessRecord>, String> {
    Err("process RSS sampler currently supports macOS only".into())
}

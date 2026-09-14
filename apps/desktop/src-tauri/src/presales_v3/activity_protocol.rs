//! Only methods used by the existing desktop adapter have terminal semantics.
//! Unknown raw requests remain dispatchable and conservatively block copies.
use super::activity::*;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::{Component, PathBuf};

fn text(v: &Value) -> Option<String> {
    v.as_str()
        .filter(|s| !s.is_empty() && s.len() <= 512)
        .map(str::to_owned)
}
fn rpc(v: &Value) -> Option<String> {
    match v {
        Value::String(s) if s.len() <= 512 => Some(format!("s:{s}")),
        Value::Number(n) if n.is_i64() || n.is_u64() => Some(format!("n:{n}")),
        _ => None,
    }
}
fn workspace(v: &Value) -> Scope {
    let Some(s) = v.as_str().filter(|s| s.len() <= 4096) else {
        return Scope::Global;
    };
    let p = PathBuf::from(s);
    if !p.is_absolute()
        || p.components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Scope::Global;
    }
    // Existing paths must resolve canonically. An unresolvable scope cannot
    // establish a disjoint project; it is never an idle proof.
    std::fs::canonicalize(&p)
        .map(Scope::Workspace)
        .unwrap_or(Scope::Global)
}
pub(super) fn worker_project(v: &Value) -> Option<&str> {
    match v["method"].as_str()? {
        "ppt.project.create" => v.pointer("/params/id")?.as_str(),
        "ppt.project.restore" => v.pointer("/params/pipeline/project/id")?.as_str(),
        "ppt.project.execute" => v.pointer("/params/projectId")?.as_str(),
        _ => None,
    }
}
fn thread_scope(inner: &Inner, process: &ProcessKey, thread: &str) -> Scope {
    inner
        .evidence
        .iter()
        .rev()
        .find(|e| {
            e.process == *process
                && matches!(e.kind, Kind::ThreadStart | Kind::Resume)
                && e.settled
                && e.thread.as_deref() == Some(thread)
        })
        .map(|e| e.scope.clone())
        .unwrap_or(Scope::Global)
}
pub(super) fn register(
    inner: &mut Inner,
    process: &ProcessKey,
    v: &Value,
    source: Option<NativeSource>,
) -> Result<Option<String>, String> {
    let id = v.get("id").and_then(rpc);
    let method = v["method"].as_str();
    // Client replies have a separate direction. Only native-observed incoming
    // requests can authorize them as non-dispatch; frontend result JSON cannot
    // enter observe() or settle an outgoing request.
    if method.is_none() && (v.get("result").is_some() || v.get("error").is_some()) {
        if id
            .as_ref()
            .is_some_and(|id| inner.server_requests.remove(&(process.clone(), id.clone())))
        {
            return Ok(None);
        }
    }
    if id.is_some()
        && inner
            .evidence
            .iter()
            .any(|e| e.process == *process && e.rpc == id)
    {
        return Err("request_id_ambiguous".into());
    }
    let p = &v["params"];
    let mut thread = text(&p["threadId"]);
    let mut turn = text(&p["turnId"]);
    let (kind, scope) = match (process.transport, method) {
        (
            Transport::Worker,
            Some(
                "system.health"
                | "system.capabilities"
                | "ppt.template.inspect"
                | "ppt.project.snapshot"
                | "workflow.transition"
                | "checkpoint.recover",
            ),
        ) => return Ok(None),
        (
            Transport::Worker,
            Some("ppt.project.create" | "ppt.project.restore" | "ppt.project.execute"),
        ) => (
            Kind::Local,
            source.map(Scope::Source).unwrap_or(Scope::Global),
        ),
        (Transport::Worker, _) => (Kind::Local, Scope::Global),
        (
            Transport::Codex,
            Some(
                "initialize"
                | "initialized"
                | "account/read"
                | "account/login/start"
                | "modelProvider/capabilities/read"
                | "config/read"
                | "configRequirements/read",
            ),
        ) => return Ok(None),
        (Transport::Codex, Some("thread/start")) => (Kind::ThreadStart, workspace(&p["cwd"])),
        (Transport::Codex, Some("thread/resume")) => (
            Kind::Resume,
            thread
                .as_deref()
                .map(|t| thread_scope(inner, process, t))
                .unwrap_or(Scope::Global),
        ),
        (Transport::Codex, Some("turn/start" | "turn/interrupt")) => {
            let mut scope = thread
                .as_deref()
                .map(|t| thread_scope(inner, process, t))
                .unwrap_or(Scope::Global);
            // Raw overrides can widen the execution scope. The observed adapter
            // sends only threadId/input (or threadId/turnId for interrupt).
            if p.as_object().is_none_or(|p| {
                p.keys()
                    .any(|k| !matches!(k.as_str(), "threadId" | "input" | "turnId"))
            }) {
                scope = Scope::Global;
            }
            (
                if method == Some("turn/start") {
                    Kind::Turn
                } else {
                    Kind::Interrupt
                },
                scope,
            )
        }
        _ => (Kind::Unknown, Scope::Global),
    };
    if kind == Kind::ThreadStart {
        thread = None;
        turn = None;
    }
    let hash = if kind == Kind::Turn {
        p["input"]
            .as_array()
            .filter(|a| a.len() == 1)
            .and_then(|a| {
                (a[0]["type"] == "text")
                    .then(|| a[0]["text"].as_str())
                    .flatten()
            })
            .map(|s| format!("{:x}", Sha256::digest(s.as_bytes())))
    } else {
        None
    };
    let reason = if kind == Kind::Unknown {
        Some("unclassified_request".into())
    } else if matches!(scope, Scope::Global) {
        Some("unmapped_thread_scope".into())
    } else {
        None
    };
    let resume_targets = if kind == Kind::Resume {
        inner
            .evidence
            .iter()
            .filter(|old| old.kind == Kind::Turn && !old.settled && old.thread == thread)
            .map(|old| old.id.clone())
            .collect()
    } else {
        Vec::new()
    };
    let e = Evidence {
        proof_version: 1,
        id: uuid::Uuid::new_v4().to_string(),
        process: process.clone(),
        rpc: id,
        kind,
        scope,
        thread,
        turn,
        reason,
        settled: false,
        visual_id: None,
        prompt_hash: hash,
        linked: None,
        resolution: None,
        resume_targets,
    };
    // An uncorrelatable request remains unknown after a response. It must still
    // be registered before a potentially valid wire notification is written.
    let eid = inner.insert(e.clone())?;
    if kind == Kind::Turn {
        let candidates: Vec<_> = inner
            .evidence
            .iter()
            .enumerate()
            .filter(|(_, c)| {
                c.kind == Kind::Coverage
                    && c.process.boot == process.boot
                    && c.linked.is_none()
                    && c.prompt_hash.is_some()
                    && c.prompt_hash == e.prompt_hash
                    && match (&c.scope, &e.scope) {
                        (Scope::Source(s), Scope::Workspace(root)) => s.root == *root,
                        (a, b) => a == b,
                    }
            })
            .map(|(i, _)| i)
            .collect();
        for i in &candidates {
            let c = &mut inner.evidence[*i];
            if candidates.len() == 1 {
                c.linked = Some(eid.clone());
            } else {
                c.reason = Some("legacy_imagegen_outcome_unknown".into());
            }
            let c = c.clone();
            inner.persist(&c)?;
        }
    }
    Ok(Some(eid))
}
fn terminal(v: &Value) -> bool {
    matches!(
        v["status"].as_str(),
        Some("completed" | "failed" | "interrupted")
    )
}
fn settle(
    inner: &mut Inner,
    index: usize,
    kind: &str,
    process: &ProcessKey,
    request: Option<String>,
) -> Result<(), String> {
    let e = &mut inner.evidence[index];
    e.settled = true;
    e.reason = None;
    e.resolution = Some(Resolution {
        kind: kind.into(),
        process: process.clone(),
        request,
    });
    let e = e.clone();
    inner.persist(&e)
}
pub(super) fn observe(inner: &mut Inner, process: &ProcessKey, v: &Value) -> Result<(), String> {
    if let Some(method) = v["method"].as_str() {
        if let Some(id) = v.get("id").and_then(rpc) {
            if inner.server_requests.len() >= EARLY_LIMIT {
                return inner.lost(process, "protocol_evidence_lost", false);
            }
            inner.server_requests.insert((process.clone(), id));
        }
        if method == "turn/completed" && terminal(&v["params"]["turn"]) {
            let (Some(thread), Some(turn)) = (
                text(&v["params"]["threadId"]),
                text(&v["params"]["turn"]["id"]),
            ) else {
                return inner.lost(process, "protocol_evidence_lost", false);
            };
            let ids: Vec<_> = inner
                .evidence
                .iter()
                .enumerate()
                .filter(|(_, e)| {
                    e.process == *process
                        && e.kind == Kind::Turn
                        && e.thread.as_ref() == Some(&thread)
                        && e.turn.as_ref() == Some(&turn)
                })
                .map(|(i, _)| i)
                .collect();
            for i in &ids {
                let observation = inner.evidence[*i].clone();
                // A resumed observation belongs to this exact process. Only its
                // pre-send targets may inherit this terminal witness; IDs alone
                // never authorize settlement across generations or workspaces.
                let targets: Vec<_> = inner
                    .evidence
                    .iter()
                    .enumerate()
                    .filter(|(_, old)| {
                        observation.resume_targets.contains(&old.id)
                            && old.kind == Kind::Turn
                            && !old.settled
                            && old.scope == observation.scope
                            && old.thread == observation.thread
                            && old.turn == observation.turn
                    })
                    .map(|(index, _)| index)
                    .collect();
                for target in targets {
                    settle(
                        inner,
                        target,
                        "resume_turn_completed",
                        process,
                        observation.linked.clone(),
                    )?;
                }
                settle(inner, *i, "turn_completed", process, None)?;
            }
            if ids.is_empty()
                && inner.evidence.iter().any(|e| {
                    e.process == *process
                        && e.kind == Kind::Turn
                        && !e.settled
                        && e.thread.as_ref() == Some(&thread)
                        && e.turn.is_none()
                })
            {
                if inner.early.len() >= EARLY_LIMIT {
                    return inner.lost(process, "protocol_evidence_lost", false);
                }
                inner.early.insert((process.clone(), thread, turn));
            }
        }
        return Ok(());
    }
    if v.get("result").is_none() && v.get("error").is_none() {
        return inner.lost(process, "protocol_evidence_lost", false);
    }
    if v.get("result").is_some() && v.get("error").is_some() {
        return inner.lost(process, "protocol_evidence_lost", false);
    }
    let Some(id) = v.get("id").and_then(rpc) else {
        return Ok(());
    };
    let Some(i) = inner
        .evidence
        .iter()
        .position(|e| e.process == *process && e.rpc.as_ref() == Some(&id))
    else {
        return Ok(());
    };
    let e = inner.evidence[i].clone();
    if e.settled {
        return Ok(());
    }
    if v.get("error").is_some() {
        // A start error has no remote terminal identity. After an ACK it also
        // cannot contradict the already observed live turn. Setup/local errors
        // can settle their own request; interrupt errors never settle the turn.
        if e.kind == Kind::Turn {
            inner.evidence[i].reason = Some("remote_terminal_missing".into());
            let updated = inner.evidence[i].clone();
            inner.persist(&updated)?;
        } else if e.kind != Kind::Unknown && e.kind != Kind::Health {
            settle(inner, i, "request_rejected", process, Some(e.id.clone()))?;
        }
        return Ok(());
    }
    let result = &v["result"];
    match e.kind {
        Kind::Local | Kind::Interrupt => {
            settle(inner, i, "request_response", process, Some(e.id.clone()))?
        }
        Kind::ThreadStart | Kind::Resume => {
            let Some(thread) = text(&result["thread"]["id"]) else {
                return Ok(());
            };
            if e.kind == Kind::Resume && e.thread.as_ref() != Some(&thread) {
                return Ok(());
            }
            let effective = workspace(&result["thread"]["cwd"]);
            // Binding uses the child's effective cwd. Missing/invalid cwd may
            // leave an idle setup settled, but never grants a narrow turn scope.
            let scope = effective;
            if e.kind == Kind::Resume
                && !inner.evidence.iter().any(|old| {
                    old.id != e.id
                        && matches!(old.kind, Kind::ThreadStart | Kind::Resume)
                        && old.settled
                        && old.thread.as_ref() == Some(&thread)
                        && old.scope == scope
                        && !matches!(scope, Scope::Global)
                })
            {
                inner.evidence[i].reason = Some("unmapped_thread_scope".into());
                let unknown = inner.evidence[i].clone();
                inner.persist(&unknown)?;
                return Ok(());
            }
            inner.evidence[i].thread = Some(thread.clone());
            inner.evidence[i].scope = scope.clone();
            settle(inner, i, "thread_bound", process, Some(e.id.clone()))?;
            if e.kind == Kind::Resume
                && !matches!(scope, Scope::Global)
                && result["thread"].get("cwd").is_some()
            {
                if let Some(turns) = result["thread"]["turns"].as_array() {
                    let ids: Vec<_> = inner
                        .evidence
                        .iter()
                        .enumerate()
                        .filter(|(_, old)| {
                            old.kind == Kind::Turn
                                && !old.settled
                                && e.resume_targets.contains(&old.id)
                                && old.thread.as_ref() == Some(&thread)
                                && old.scope == scope
                                && turns.iter().any(|t| {
                                    terminal(t) && text(&t["id"]) == old.turn && old.turn.is_some()
                                })
                        })
                        .map(|(i, _)| i)
                        .collect();
                    for i in ids {
                        settle(
                            inner,
                            i,
                            "resume_terminal_history",
                            process,
                            Some(e.id.clone()),
                        )?;
                    }
                }
            }
            if let Some(turns) = result["thread"]["turns"].as_array() {
                for turn in turns.iter().filter(|turn| !terminal(turn)) {
                    if let Some(turn) = text(&turn["id"]) {
                        // Every successful setup response is a fresh native
                        // observation, even if historical settled/unresolved
                        // evidence happens to reuse the same thread/turn IDs.
                        let resume_targets = inner
                            .evidence
                            .iter()
                            .filter(|old| {
                                e.resume_targets.contains(&old.id)
                                    && old.kind == Kind::Turn
                                    && !old.settled
                                    && old.scope == scope
                                    && old.thread.as_ref() == Some(&thread)
                                    && old.turn.as_ref() == Some(&turn)
                            })
                            .map(|old| old.id.clone())
                            .collect();
                        inner.insert(Evidence {
                            proof_version: 1,
                            id: uuid::Uuid::new_v4().to_string(),
                            process: process.clone(),
                            rpc: None,
                            kind: Kind::Turn,
                            scope: scope.clone(),
                            thread: Some(thread.clone()),
                            turn: Some(turn),
                            reason: None,
                            settled: false,
                            visual_id: None,
                            prompt_hash: None,
                            linked: Some(e.id.clone()),
                            resolution: None,
                            resume_targets,
                        })?;
                    }
                }
            }
        }
        Kind::Turn => {
            let Some(turn) = text(&result["turn"]["id"]) else {
                return Ok(());
            };
            if e.turn.as_ref().is_some_and(|bound| bound != &turn) {
                return inner.lost(process, "protocol_evidence_lost", false);
            }
            inner.evidence[i].turn = Some(turn.clone());
            let updated = inner.evidence[i].clone();
            inner.persist(&updated)?;
            if e.thread
                .is_some_and(|thread| inner.early.remove(&(process.clone(), thread, turn)))
            {
                settle(inner, i, "turn_completed", process, None)?;
            }
        }
        _ => {}
    }
    Ok(())
}

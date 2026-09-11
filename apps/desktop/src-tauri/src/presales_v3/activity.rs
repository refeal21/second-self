//! Native admission lock. Lock order: process state -> activity -> v3 DB;
//! mutation/copy: activity -> legacy DB/workspace. Never acquire process state
//! from activity, or activity while holding legacy DB/workspace. Guards are
//! synchronous and short; no guard crosses a frontend round trip.
use super::{activity_protocol as protocol, activity_storage as storage, V3Store};
use crate::legacy_frames::{FrameDecoder, CODEX_FRAME_LIMIT, WORKER_FRAME_LIMIT};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Mutex, MutexGuard},
};

pub(super) const EARLY_LIMIT: usize = 128;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct NativeSource {
    pub(super) database: PathBuf,
    pub(super) project: String,
    pub(super) root: PathBuf,
}
impl NativeSource {
    // Only native checked workspace/project mappings call this constructor.
    pub(crate) fn new(database: PathBuf, project: String, root: PathBuf) -> Self {
        Self {
            database,
            project,
            root,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub(crate) enum Transport {
    Worker,
    Codex,
}
impl Transport {
    fn frame_limit(self) -> usize {
        match self {
            Self::Worker => WORKER_FRAME_LIMIT,
            Self::Codex => CODEX_FRAME_LIMIT,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProcessKey {
    pub(super) boot: String,
    pub(super) transport: Transport,
    pub(super) generation: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(super) enum Scope {
    Source(NativeSource),
    Workspace(PathBuf),
    Global,
}
impl Scope {
    fn overlaps(&self, source: &NativeSource) -> bool {
        match self {
            Self::Source(s) => {
                (s.database == source.database && s.project == source.project)
                    || s.root == source.root
            }
            Self::Workspace(root) => {
                source.root.starts_with(root) || root.starts_with(&source.root)
            }
            Self::Global => true,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(super) enum Kind {
    Local,
    ThreadStart,
    Resume,
    Turn,
    Interrupt,
    Unknown,
    Health,
    Coverage,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Resolution {
    pub kind: String,
    pub process: ProcessKey,
    pub request: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Evidence {
    pub proof_version: u8,
    pub id: String,
    pub process: ProcessKey,
    pub rpc: Option<String>,
    pub kind: Kind,
    pub scope: Scope,
    pub thread: Option<String>,
    pub turn: Option<String>,
    pub reason: Option<String>,
    pub settled: bool,
    pub visual_id: Option<String>,
    pub prompt_hash: Option<String>,
    pub linked: Option<String>,
    pub resolution: Option<Resolution>,
    pub resume_targets: Vec<String>,
}
impl Evidence {
    fn blocks(&self) -> bool {
        !self.settled && (self.kind != Kind::Coverage || self.reason.is_some())
    }
}
pub(super) struct Inner {
    pub boot: String,
    pub store: V3Store,
    pub evidence: Vec<Evidence>,
    pub epoch: u64,
    pub early: HashSet<(ProcessKey, String, String)>,
    pub buffers: HashMap<ProcessKey, FrameDecoder>,
    pub server_requests: HashSet<(ProcessKey, String)>,
    pub failure: Option<String>,
}
pub(crate) struct LegacyActivityTracker {
    boot: String,
    inner: Mutex<Inner>,
}
pub(crate) struct SourceGuard<'a> {
    inner: MutexGuard<'a, Inner>,
}

#[cfg(test)]
mod mixed_frame_tests {
    use super::*;

    #[test]
    fn worker_mixed_bad_frame_preserves_correlated_reply_and_loss() {
        for bad in [vec![b'x'; 65], vec![0xff]] {
            let t = LegacyActivityTracker::new(V3Store::open_in_memory().unwrap()).unwrap();
            let p = t.process_key(Transport::Worker, 1);
            t.send(
                &p,
                r#"{"id":1,"method":"ppt.project.execute"}"#,
                |_| None,
                || Ok(()),
            )
            .unwrap();
            t.inner
                .lock()
                .unwrap()
                .buffers
                .insert(p.clone(), FrameDecoder::new(64));
            let mut chunk = bad;
            chunk.extend_from_slice(b"\n{\"id\":1,\"result\":{}}\n");
            let events = t.observe_bytes(&p, &chunk).unwrap();
            assert_eq!(
                events,
                vec![
                    Err("protocol_evidence_lost".to_owned()),
                    Ok("{\"id\":1,\"result\":{}}\n".to_owned())
                ]
            );
            let source = NativeSource::new(
                PathBuf::from("/synthetic/db"),
                "a".into(),
                PathBuf::from("/synthetic/a"),
            );
            assert!(t.try_source_guard(&source).is_err());
            assert!(t
                .inner
                .lock()
                .unwrap()
                .evidence
                .iter()
                .any(|e| e.kind == Kind::Local && e.settled));
            t.transport_lost(&p, "remote_terminal_missing").unwrap();
            assert!(t.try_source_guard(&source).is_ok());
        }
    }
}

impl LegacyActivityTracker {
    pub(crate) fn new(store: V3Store) -> Result<Self, String> {
        let mut evidence = storage::load(&store)?;
        for e in &mut evidence {
            if !e.settled && e.kind != Kind::Coverage {
                // Restart is not an observed child termination, including for
                // local Worker work. Preserve stronger parser/raw-method reasons.
                if e.reason.is_none() {
                    e.reason = Some(
                        if e.kind == Kind::Local {
                            "local_terminal_missing"
                        } else {
                            "remote_terminal_missing"
                        }
                        .into(),
                    );
                }
                storage::save(&store, e)?;
            }
        }
        let boot = uuid::Uuid::new_v4().to_string();
        Ok(Self {
            boot: boot.clone(),
            inner: Mutex::new(Inner {
                boot,
                store,
                evidence,
                epoch: 0,
                early: HashSet::new(),
                buffers: HashMap::new(),
                server_requests: HashSet::new(),
                failure: None,
            }),
        })
    }
    pub(crate) fn process_key(&self, transport: Transport, generation: u64) -> ProcessKey {
        ProcessKey {
            boot: self.boot.clone(),
            transport,
            generation,
        }
    }
    fn lock(&self) -> Result<MutexGuard<'_, Inner>, String> {
        self.inner
            .lock()
            .map_err(|_| "legacy_activity_lock_poisoned".into())
    }
    pub(crate) fn try_source_guard(
        &self,
        source: &NativeSource,
    ) -> Result<SourceGuard<'_>, String> {
        let inner = self.lock()?;
        if let Some(error) = &inner.failure {
            return Err(error.clone());
        }
        if let Some(e) = inner
            .evidence
            .iter()
            .find(|e| e.blocks() && e.scope.overlaps(source))
        {
            return Err(e
                .reason
                .clone()
                .unwrap_or_else(|| "legacy_source_active".into()));
        }
        Ok(SourceGuard { inner })
    }
    /// Native mutation serializes with copy/dispatch, but does not wait for remote
    /// activity or require a frontend to complete an optional save.
    pub(crate) fn mutation_guard(&self) -> Result<SourceGuard<'_>, String> {
        let mut inner = self.lock()?;
        inner.epoch = inner
            .epoch
            .checked_add(1)
            .ok_or("legacy_activity_epoch_exhausted")?;
        Ok(SourceGuard { inner })
    }
    /// The closure is the first actual write. Preflight (child exists, current
    /// generation) belongs to the caller before this method. A write/flush error
    /// cannot establish zero delivered bytes. Persist intent BEFORE invoking it.
    pub(crate) fn send(
        &self,
        process: &ProcessKey,
        line: &str,
        resolve: impl Fn(&str) -> Option<NativeSource>,
        write: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        if line.len() > process.transport.frame_limit() {
            return Err("legacy_request_frame_too_large".into());
        }
        if process.boot != self.boot || line.contains(['\n', '\r']) {
            return Err("legacy_request_framing_or_generation_invalid".into());
        }
        let request: Value =
            serde_json::from_str(line).map_err(|_| "legacy_request_json_invalid")?;
        if !request.is_object() {
            return Err("legacy_request_json_invalid".into());
        }
        let mut inner = self.lock()?;
        if let Some(error) = &inner.failure {
            return Err(error.clone());
        }
        // Admission -> legacy read. The resolver never retains its legacy lock
        // or acquires admission again. This also serializes workspace changes.
        let mapped = protocol::worker_project(&request).and_then(|id| resolve(id));
        let registration = protocol::register(&mut inner, process, &request, mapped)?;
        inner.epoch = inner
            .epoch
            .checked_add(1)
            .ok_or("legacy_activity_epoch_exhausted")?;
        // Intent now blocks overlapping copies. Do not retain admission while
        // a child pipe blocks; its real stdout may also arrive before write ends.
        drop(inner);
        drop(request);
        let result = write();
        if result.is_err() {
            if let Some(id) = registration {
                let mut inner = self.lock()?;
                let e = inner
                    .evidence
                    .iter_mut()
                    .find(|e| e.id == id)
                    .expect("registered intent");
                if !e.settled {
                    e.reason = Some("remote_terminal_missing".into());
                    let e = e.clone();
                    inner.persist(&e)?;
                }
            }
        }
        result
    }
    pub(crate) fn observe_line(&self, process: &ProcessKey, bytes: &[u8]) -> Result<(), String> {
        let mut inner = self.lock()?;
        if bytes.len() > process.transport.frame_limit() {
            return inner.lost(process, "protocol_evidence_lost", false);
        }
        match serde_json::from_slice::<Value>(bytes) {
            Ok(value) if value.is_object() => protocol::observe(&mut inner, process, &value),
            _ => inner.lost(process, "protocol_evidence_lost", false),
        }
    }
    pub(crate) fn observe_bytes(
        &self,
        process: &ProcessKey,
        bytes: &[u8],
    ) -> Result<Vec<Result<String, String>>, String> {
        let mut inner = self.lock()?;
        let mut decoder = inner
            .buffers
            .remove(process)
            .unwrap_or_else(|| FrameDecoder::new(process.transport.frame_limit()));
        let mut forwarded = Vec::new();
        decoder.push(bytes, |frame| {
            let observed = (|| {
                let Ok(bytes) = frame else {
                    inner.lost(process, "protocol_evidence_lost", false)?;
                    return Err("protocol_evidence_lost".into());
                };
                let Ok(line) = std::str::from_utf8(bytes) else {
                    inner.lost(process, "protocol_evidence_lost", false)?;
                    return Err("protocol_evidence_lost".into());
                };
                // Preserve valid UTF-8 wire frames even when JSON is malformed;
                // evidence parsing and frontend protocol handling stay separate.
                forwarded.push(Ok(line.to_owned()));
                match serde_json::from_slice::<Value>(bytes) {
                    Ok(v) if v.is_object() => protocol::observe(&mut inner, process, &v),
                    _ => inner.lost(process, "protocol_evidence_lost", false),
                }
            })();
            if let Err(error) = observed {
                forwarded.push(Err(error));
            }
        });
        inner.buffers.insert(process.clone(), decoder);
        // Per-frame loss must not erase other complete wire frames in this
        // chunk. The receiver emits both successes and named loss events.
        Ok(forwarded)
    }
    pub(crate) fn transport_lost(&self, process: &ProcessKey, reason: &str) -> Result<(), String> {
        let mut inner = self.lock()?;
        if inner
            .buffers
            .remove(process)
            .is_some_and(|mut b| b.finish().is_err())
        {
            inner.lost(process, "protocol_evidence_lost", false)?;
        }
        inner.lost(process, reason, true)
    }
    pub(crate) fn evidence_lost(&self, process: &ProcessKey) -> Result<(), String> {
        self.lock()?.lost(process, "protocol_evidence_lost", false)
    }
    pub(crate) fn transport_retiring(&self, process: &ProcessKey) -> Result<(), String> {
        self.lock()?.lost(process, "remote_terminal_missing", false)
    }
    pub(crate) fn retire_and_stop(
        &self,
        process: &ProcessKey,
        stop: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        let evidence = self.transport_retiring(process);
        // A failed evidence write blocks copies, but must not prevent the user
        // from stopping the already launched child. Always attempt the stop.
        let stopped = stop();
        evidence.and(stopped)
    }
}
impl Inner {
    pub(super) fn persist(&mut self, evidence: &Evidence) -> Result<(), String> {
        storage::save(&self.store, evidence).map_err(|_| {
            self.failure = Some("legacy_activity_storage_unavailable".into());
            "legacy_activity_storage_unavailable".into()
        })
    }
    pub(super) fn insert(&mut self, evidence: Evidence) -> Result<String, String> {
        self.persist(&evidence)?;
        let id = evidence.id.clone();
        self.evidence.push(evidence);
        Ok(id)
    }
    pub(super) fn lost(
        &mut self,
        process: &ProcessKey,
        reason: &str,
        dead: bool,
    ) -> Result<(), String> {
        let ids: Vec<_> = self
            .evidence
            .iter()
            .enumerate()
            .filter(|(_, e)| e.process == *process && e.blocks())
            .map(|(i, _)| i)
            .collect();
        for i in ids {
            let e = &mut self.evidence[i];
            if dead
                && (e.kind == Kind::Local
                    || (process.transport == Transport::Worker && e.kind == Kind::Health))
            {
                e.settled = true;
                e.resolution = Some(Resolution {
                    kind: "local_child_terminated".into(),
                    process: process.clone(),
                    request: None,
                });
            } else {
                e.reason = Some(reason.into());
            }
            let e = e.clone();
            self.persist(&e)?;
        }
        if !dead
            && reason == "protocol_evidence_lost"
            && !self
                .evidence
                .iter()
                .any(|e| e.process == *process && e.kind == Kind::Health)
        {
            self.insert(Evidence {
                proof_version: 1,
                id: uuid::Uuid::new_v4().to_string(),
                process: process.clone(),
                rpc: None,
                kind: Kind::Health,
                scope: Scope::Global,
                thread: None,
                turn: None,
                reason: Some("protocol_evidence_lost".into()),
                settled: false,
                visual_id: None,
                prompt_hash: None,
                linked: None,
                resolution: None,
                resume_targets: Vec::new(),
            })?;
        }
        Ok(())
    }
}
impl SourceGuard<'_> {
    pub(crate) fn epoch(&self) -> u64 {
        self.inner.epoch
    }
    pub(crate) fn cover_visual(
        &mut self,
        source: NativeSource,
        record: &crate::visual_style::VisualGenerationRecord,
    ) -> Result<(), String> {
        if record.request.kind != "imagegen" {
            return Ok(());
        }
        let boot = self.inner.boot.clone();
        self.inner.insert(Evidence {
            proof_version: 1,
            id: uuid::Uuid::new_v4().to_string(),
            process: ProcessKey {
                boot,
                transport: Transport::Codex,
                generation: 0,
            },
            rpc: None,
            kind: Kind::Coverage,
            scope: Scope::Source(source),
            thread: None,
            turn: None,
            reason: None,
            settled: false,
            visual_id: Some(record.request.id.clone()),
            prompt_hash: Some(record.prompt_sha256.clone()),
            linked: None,
            resolution: None,
            resume_targets: Vec::new(),
        })?;
        Ok(())
    }
    pub(crate) fn check_visual_records(
        &self,
        source: &NativeSource,
        records: &[crate::visual_style::VisualGenerationRecord],
    ) -> Result<(), String> {
        for record in records {
            if record.request.kind == "imagegen"
                && record.receipt.is_none()
                && !self.inner.evidence.iter().any(|e| {
                    e.kind == Kind::Coverage
                        && e.scope == Scope::Source(source.clone())
                        && e.visual_id.as_deref() == Some(&record.request.id)
                        && e.prompt_hash.as_deref() == Some(&record.prompt_sha256)
                        && e.reason.is_none()
                })
            {
                return Err("legacy_imagegen_outcome_unknown".into());
            }
        }
        Ok(())
    }
}

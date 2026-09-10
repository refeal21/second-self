# Presales Durable Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an independently testable, persistent native queue for multi-page generation, with global admission limits and conservative recovery.

**Architecture:** A standalone `presales_queue` Rust module owns a separate, identified SQLite database. Jobs contain immutable request snapshots; admission and lifecycle changes are short SQLite transactions. This increment is not wired to the desktop UI or real generation: a feature-only JSONL harness proves actual process persistence without touching legacy project storage.

**Tech Stack:** Existing Rust, rusqlite, serde/serde_json, sha2; no added runtime dependency.

**Spec:** `docs/superpowers/specs/2026-09-09-presales-batch-visual-design.md`, sections 4, 6 and applicable section 9 acceptance criteria.

## Global Constraints

- 保留本地 Tauri 2 / React / Rust / TypeScript Worker / SQLite 架构和 Codex App Server 的 ChatGPT 登录路径。不增加按量计费 API、API Key 配置、本地 HTTP 服务或新的渲染平台。
- 首轮实现支持 1–4，默认及首次真实验收目标为 4。不是每项目各 4 个。
- 同一页最多一个未终结生成请求，重复点击返回同一任务。队列遵循先入先出。
- 降低并发不强杀已派发任务，只暂停新增派发，直到占用低于新上限。
- 未知结果与取消未确认仍占逻辑槽位，避免无意超并发。
- SQLite 保存批次、单页 Job、每次 attempt、派发意图、请求快照、提供方身份、暂存结果与提交回执。内存注册表只负责订阅/调度，不再作为真源。
- 新旧应用不共享 v3 可写文件。新版对未来未知 schema 显式拒绝写入。
- This increment must not modify `database.rs`, `WorkbenchService`, registered Tauri commands, customer data, existing app bundles, Codex settings or UI. Exporting the Rust module from `lib.rs` is allowed, not managing or opening it at application startup.
- This queue database is the future v3 storage boundary, not an auxiliary writer into the legacy database. Do not ATTACH legacy storage. Project IDs are opaque here; a future validated v3 catalog must authorize actual dispatch.
- `result_ready` in this internal store records a trusted staging layer's manifest declaration only. No method in this increment can publish a candidate, create approval, set `committing`/`succeeded`, or claim a PNG exists or is deliverable. Actual secured PNG staging and candidate/receipt/Job atomic publication are a subsequent integrated v3 increment, using this same database transaction boundary.
- All test inputs are synthetic. No real model requests, audio, desktop launch, notifications or customer project reads. The user requested quiet operation.

## Scope and sequence

The existing native paired checkpoint increment is complete at `1830d72`. This plan implements queue admission, durable attempts/recovery and a real subprocess inspection/control surface. It does not complete v3 project-copy migration, paired UI, Worker scheduling, gallery/history/feedback drafts, real image edits, selected-version export or four-way service/memory acceptance. Those remain governed by the full spec; no legacy fallback is added.

Files by responsibility:

- `apps/desktop/src-tauri/src/presales_queue/mod.rs`: public exports and queue boundary documentation.
- `apps/desktop/src-tauri/src/presales_queue/contracts.rs`: serde contracts, bounded validation, status predicates.
- `apps/desktop/src-tauri/src/presales_queue/store.rs`: own schema, reads, batch enqueue, settings, FIFO admission.
- `apps/desktop/src-tauri/src/presales_queue/lifecycle.rs`: guarded transitions, provider identity, result manifests, recovery and audit.
- `apps/desktop/src-tauri/src/presales_queue/rpc.rs`: reusable strict native.queue JSON-RPC dispatcher; not registered with the app yet.
- `apps/desktop/src-tauri/tests/presales_queue.rs`: real SQLite admission tests.
- `apps/desktop/src-tauri/tests/presales_queue_lifecycle.rs`: real SQLite lifecycle/restart tests.
- `apps/desktop/src-tauri/src/bin/queue-harness.rs`: feature-only queue JSONL adapter, no legacy service.
- `apps/desktop/src-tauri/tests/presales_queue_process.rs`: real harness child stdin/stdout and restart tests.

### Task 1: Separate queue schema, immutable requests and global admission

**Files:** Create `presales_queue/mod.rs`, `contracts.rs`, `store.rs` and `tests/presales_queue.rs` at the paths above; modify `src/lib.rs` only to export `pub mod presales_queue;`.

**Interfaces:**

All public JSON structs use camelCase and deny unknown fields; enums use snake_case. Use `Result<T, String>`. The store contains a crate-private `Connection`; no raw connection getter is public.

```rust
pub struct VersionHash { pub version: String, pub sha256: String }
pub struct ImageReference { pub asset_id: String, pub sha256: String }
pub struct QueueTarget {
  pub project_id: String, pub slide_id: String,
  pub spec: VersionHash, pub design: VersionHash,
  pub skill: VersionHash, pub palette: VersionHash,
  pub parent_visual: Option<ImageReference>,
  pub references: Vec<ImageReference>,
  pub prompt_version: String, pub prompt: String, pub feedback: String,
}
pub struct EnqueueJob { pub request_id: String, pub attempt_id: String, pub target: QueueTarget }
pub struct EnqueueBatch { pub batch_id: String, pub jobs: Vec<EnqueueJob> }
pub enum JobStatus { Queued, Dispatching, Running, ResultReady, Committing,
  Succeeded, Failed, CancelRequested, Cancelled, OutcomeUnknown, AbandonedUnresolved }
pub struct QueueSettings { pub concurrency: u8, pub paused: bool, pub epoch: i64 }
pub struct QueueJob {
  pub sequence: i64, pub batch_id: String, pub request_id: String,
  pub attempt_id: String, pub target: QueueTarget, pub status: JobStatus,
  pub created_at_ms: i64, pub updated_at_ms: i64, pub dispatched_at_ms: Option<i64>,
  pub epoch: Option<i64>, pub provider: Option<ProviderIdentity>,
  pub result: Option<StagedResult>, pub error: Option<String>,
}
pub struct ProviderIdentity { pub thread_id: String, pub turn_id: Option<String> }
pub struct StagedResult { pub relative_path: String, pub sha256: String, pub byte_length: u64 }
pub struct EnqueueOutcome { pub jobs: Vec<QueueJob>, pub reused_request_ids: Vec<String> }
impl QueueStore {
  pub fn open(path: impl AsRef<std::path::Path>) -> Result<Self, String>;
  pub fn open_in_memory() -> Result<Self, String>;
  pub fn settings(&self) -> Result<QueueSettings, String>;
  pub fn set_concurrency(&mut self, value: u8) -> Result<QueueSettings, String>;
  pub fn set_paused(&mut self, paused: bool) -> Result<QueueSettings, String>;
  pub fn set_batch_paused(&mut self, batch_id: &str, paused: bool) -> Result<(), String>;
  pub fn enqueue(&mut self, input: EnqueueBatch) -> Result<EnqueueOutcome, String>;
  pub fn list_jobs(&self) -> Result<Vec<QueueJob>, String>;
  pub fn get_job(&self, request_id: &str) -> Result<Option<QueueJob>, String>;
  pub fn claim_next(&mut self, epoch: i64) -> Result<Option<QueueJob>, String>;
}
```

The above structs derive Clone/Debug/PartialEq, Serialize and Deserialize. Small leaf structs/enums may derive Eq. `QueueStore` is not Clone. Shared transaction-local read helpers can be `pub(super)` for Task 2.

- [ ] **Step 1: Write behavioral admission tests first.** An empty store starts at epoch 0; future supervisor will establish each subsequent epoch via Task 2. Enqueue five literal synthetic jobs across two projects. Claim four, require FIFO request IDs `r1,r2,r3,r4`, fifth claim is None. Require persisted Dispatching and unchanged target. Verify separate connections racing claims never admit more than the global limit; use a Barrier and real file DB, not sleeps or mock counts.

```rust
let mut store = QueueStore::open_in_memory().unwrap();
store.enqueue(batch("b1", &[job("r1", "a1", "p1", "s1"),
  job("r2", "a2", "p2", "s1"), job("r3", "a3", "p1", "s2"),
  job("r4", "a4", "p2", "s2"), job("r5", "a5", "p1", "s3")])).unwrap();
for wanted in ["r1", "r2", "r3", "r4"] {
  assert_eq!(store.claim_next(0).unwrap().unwrap().request_id, wanted);
}
assert!(store.claim_next(0).unwrap().is_none());
```

Fixture helpers construct explicit synthetic `QueueTarget` values with literal version IDs and 64-character lowercase hex hashes; no real files or accounts. Additional tests cover limits 1/2/4, lower-to-1 holding all running slots, raising-to-4 allowing next queued jobs, persisted settings/batch pauses, exact batch replay, different-page progress during same-page dedup, transactional rollback for invalid second input, globally reused request/attempt IDs and changed batch replay rejection.

- [ ] **Step 2: Run the RED tests.** `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test presales_queue`. Record the missing-module/API diagnostic if the new module does not yet exist; after minimal declarations ensure new behavior assertions fail before filling implementations.

- [ ] **Step 3: Implement typed validation and dedicated schema/admission.** Identity strings use existing lowercase identifier semantics (`^[a-z0-9][a-z0-9_-]{0,63}$`). Version strings and prompt_version are nonblank <=128 UTF-8 bytes; hashes exactly 64 lowercase hex; prompt 1..65536 bytes, feedback <=16384, references <=32 with unique asset IDs; batch size 1..100, no duplicate pages/requests/attempts within a batch. Reject NUL in all free text. Bound stored target JSON to 128 KiB. Parent reference optional and separate in meaning from scene references.

Use SQLite `application_id = 0x44545133` (DTQ3), `user_version = 1`; initialize only an empty unowned database. Inspect both markers and existing user tables **before** WAL/schema mutation; reject foreign DBs and unknown versions without changing them. Existing identified DB must have the expected schema. Enable foreign_keys, busy_timeout 5000 ms, WAL for file-backed DBs, synchronous FULL. Persist settings, batches, jobs, attempts and transition events; reserve result/audit schema for Task 2 as needed without fake completion APIs.

Each manual generation is a new Job and a single immutable attempt; retry never updates old attempt identity. Jobs' request_id and attempts' attempt_id are globally unique. A partial unique index on `(project_id, slide_id)` covers queued/dispatching/running/result_ready/committing/cancel_requested/outcome_unknown. Batch ID replay requires exact original EnqueueBatch (including order and feedback); return the original request-ID mapping and reused_request_ids, hydrating jobs from their current persisted rows, not stale queued snapshots or new jobs. Same-page busy on a new valid batch returns the existing job and its request ID in reused_request_ids; its target is never rewritten. Validate identifier collisions before dedup so forged identity reuse cannot hide behind a busy page. No partial batch creation on errors.

Claim one eligible job in global sequence order inside `TransactionBehavior::Immediate`, verify expected epoch matches settings, honor global and batch pauses, and count dispatching/running/cancel_requested/outcome_unknown as occupying provider slots. Set Dispatching + epoch + persisted transition before returning it. result_ready/committing retain same-page lock but not long-call slots. No call to any provider. Native epoch-millisecond clock supplies created_at_ms/updated_at_ms on insertion, dispatched_at_ms/updated_at_ms on claim, and event timestamps. Exact replay preserves all timestamps. Sequence, not wall clock, is the FIFO authority; test persisted real timestamps and the absent-before/present-after dispatch boundary without sleeps.

- [ ] **Step 4: Verify and self-review.** Run focused tests, then default complete Rust suite once; run cargo fmt check and git diff --check. Verify an unrelated/legacy-looking DB retains tables/data/markers after failed open, and reopen preserves request snapshots/settings/dispatching (open alone does not decide recovery).
- [ ] **Step 5: Commit.** Stage only Task 1 files and commit `feat: add isolated durable generation queue admission`. Report exact RED/GREEN commands/results and interfaces.

### Task 2: Durable attempt transitions, cancellation and conservative recovery

**Files:** Create `presales_queue/lifecycle.rs`, `tests/presales_queue_lifecycle.rs`; extend `mod.rs`, `contracts.rs`, `store.rs` only for lifecycle shared schema/helpers.

**Interfaces:** Consumes Task 1 public contracts, atomic store and state predicates. Produces:

```rust
pub struct QueueEvent {
  pub sequence: i64, pub request_id: String, pub attempt_id: String,
  pub kind: String, pub detail: serde_json::Value, pub created_at_ms: i64,
}
pub struct RecoverySnapshot { pub settings: QueueSettings, pub jobs: Vec<QueueJob>,
  pub unresolved_remote_count: usize }
impl QueueStore {
  pub fn begin_runtime(&mut self) -> Result<RecoverySnapshot, String>;
  pub fn recovery_snapshot(&self) -> Result<RecoverySnapshot, String>;
  pub fn record_provider(&mut self, epoch: i64, request_id: &str, attempt_id: &str,
    identity: ProviderIdentity) -> Result<QueueJob, String>;
  pub fn request_cancel(&mut self, request_id: &str) -> Result<QueueJob, String>;
  pub fn confirm_cancelled(&mut self, epoch: i64, request_id: &str,
    attempt_id: &str) -> Result<QueueJob, String>;
  pub fn mark_failed(&mut self, epoch: i64, request_id: &str, attempt_id: &str,
    error: &str) -> Result<QueueJob, String>;
  pub fn mark_outcome_unknown(&mut self, epoch: i64, request_id: &str,
    attempt_id: &str, reason: &str) -> Result<QueueJob, String>;
  pub fn record_result_ready(&mut self, epoch: i64, request_id: &str,
    attempt_id: &str, result: StagedResult) -> Result<QueueJob, String>;
  pub fn abandon_unresolved(&mut self, request_id: &str,
    acknowledge_duplicate_risk: bool) -> Result<QueueJob, String>;
  pub fn record_late_result(&mut self, request_id: &str, attempt_id: &str,
    result: StagedResult) -> Result<(), String>;
  pub fn events(&self, request_id: &str) -> Result<Vec<QueueEvent>, String>;
}
```

- [ ] **Step 1: Write lifecycle RED tests.** Show pending cancel/unknown retain a slot, ordinary result_ready releases only the provider slot, queued cancel never dispatches, failed one page does not block other pages, immutable provider identity (thread learned before optional turn) persists immediately, valid duplicate event is idempotent and conflicting duplicate rejected. Begin-runtime once, claim, reopen without changing status, begin-runtime again, require unknown, retained ID/target, changed epoch; old callbacks fail and no automatic requeue.

```rust
let first = store.begin_runtime().unwrap().settings.epoch;
let claim = store.claim_next(first).unwrap().unwrap();
store.request_cancel(&claim.request_id).unwrap();
assert!(store.claim_next(first).unwrap().is_none()); // fixture limit 1, another queued page
let restarted = store.begin_runtime().unwrap();
assert_eq!(restarted.jobs[0].status, JobStatus::OutcomeUnknown);
assert_eq!(restarted.unresolved_remote_count, 1);
assert!(store.confirm_cancelled(first, &claim.request_id, &claim.attempt_id).is_err());
```

- [ ] **Step 2: Run RED.** `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test presales_queue_lifecycle`; retain failing evidence before adding lifecycle code.
- [ ] **Step 3: Implement transactionally guarded transitions.** Epoch is a monotonic native counter; checked increment, never caller-selected. `begin_runtime` is supervisor-only: increment epoch, move Dispatching/Running/CancelRequested to OutcomeUnknown, preserve their identities/snapshots and record recovery events; assign the new epoch to these unresolved attempts so verified recovery can later resolve them. Already OutcomeUnknown also acquires new epoch. Queued is untouched, ResultReady and terminal rows untouched. Old-epoch provider/terminal/result callbacks cannot mutate current state. Opening a second DB connection does not start a new runtime.

Record_provider permits Dispatching/Running/CancelRequested/OutcomeUnknown; it can fill thread first then turn, never change either known identity. Move Dispatching to Running only on observed identity, not dispatch request alone. Retain CancelRequested/OutcomeUnknown states during identity fill. Provider thread/turn are nonblank <=256 bytes, no control characters; errors/reasons nonblank <=4096 bytes.

Every actual lifecycle change updates native updated_at_ms and creates a native-timestamped QueueEvent in the same transaction. Preserve created/dispatched timestamps and do not reset elapsed time on recovery or idempotent replay.

Transition table (exact replay of the same evidence returns current value without duplicate history; differing evidence fails):

| Operation | Allowed source | Destination |
|---|---|---|
| request_cancel | Queued | Cancelled |
| request_cancel | Dispatching, Running, OutcomeUnknown | CancelRequested |
| request_cancel | CancelRequested, Cancelled | unchanged |
| confirm_cancelled (proven remote terminal) | Dispatching, Running, CancelRequested, OutcomeUnknown | Cancelled |
| mark_failed (proven terminal failure only) | Dispatching, Running, CancelRequested, OutcomeUnknown | Failed |
| mark_outcome_unknown (timeout/connection ambiguity) | Dispatching, Running, CancelRequested | OutcomeUnknown |
| record_result_ready | Dispatching, Running, OutcomeUnknown | ResultReady |
| record_result_ready during cancellation | CancelRequested | Cancelled with audit-only result; no candidate-ready result field |
| abandon_unresolved with explicit risk true | OutcomeUnknown, CancelRequested | AbandonedUnresolved |

Abandon false fails without mutation. Abandoned attempts retain unresolved-remote flag/count despite releasing local slot/page lock. New request and attempt IDs are required for explicit retry. `record_late_result` accepts only exact abandoned attempt identity, records bounded audit-only metadata, never changes Job status/result or new request, and never hides unresolved-remote risk. Existing terminal states cannot be overwritten by late success. No generic set-status method.

StagedResult is only an internal manifest declaration: relative path must be exactly `queue-results/{request_id}/{attempt_id}.png`, SHA-256 valid, byte_length 1..52428800. No URLs, absolute/traversal/backslash paths or raw PNG/base64. This store must document that only the future trusted file stager may call record_result_ready; the harness is synthetic, not that stager. Metadata duplicates are exact; different hash/size/path rejected. Record events and status change in one transaction; preserve immutable original feedback and content/design/palette references in every branch.

- [ ] **Step 4: Verify.** Test cancellation/result order races over separate real connections, unknown restart, confirmed terminal release, explicit abandonment + fresh same-page request + stale result audit, repeated same-page manual requests >=5 with no revision limit after each confirmed terminal, malformed manifests/identities, and all illegal transitions leave durable state unchanged. Run both queue test files plus default full Rust suite and formatting/diff check.
- [ ] **Step 5: Commit.** `feat: persist queue attempt recovery and cancellation`; report test evidence and staging boundary limitations.

### Task 3: Feature-only queue JSONL transport and actual process restart

**Files:** Create `presales_queue/rpc.rs`, `src/bin/queue-harness.rs`, `tests/presales_queue_process.rs`; export `handle_queue_rpc_line` from `presales_queue/mod.rs`; register `queue-harness` in `apps/desktop/src-tauri/Cargo.toml` with `required-features = ["acceptance-harness"]`.

**Interfaces:** Consumes QueueStore from Tasks 1–2. Produces `handle_queue_rpc_line(store: &mut QueueStore, line: &str) -> String`, a reusable dispatcher for newline JSON-RPC, and an independent harness requiring `--database <explicit-path>`. Requests are `{jsonrpc:"2.0",id:"native:<unique-id>",method:"native.queue.<operation>",params:{...}}`. Require bounded nonblank string IDs (<=128 bytes, prefix `native:`); reject notifications, numeric/UI IDs, unknown envelope fields and non-object params. Responses are `{jsonrpc:"2.0",id,result}` or `{jsonrpc:"2.0",id,error:{code,message}}`; malformed JSON returns id:null error and loop continues. Use standard parse/invalid-request/method-not-found/invalid-params codes and -32000 for store rejection. It must not open WorkbenchService, legacy DB, Codex, HTTP or desktop windows. This shared dispatcher can be used by the future native host router; the harness itself must never become a production daemon.

Methods and params (all listed queue names gain prefix `native.` on the wire; `harness.close` is harness-only, not a QueueStore operation):

```text
queue.enqueue              {input: EnqueueBatch}
queue.settings             {}
queue.setConcurrency       {value: u8}
queue.setPaused            {paused: bool}
queue.setBatchPaused       {batchId: string, paused: bool}
queue.beginRuntime         {}
queue.snapshot             {}
queue.claim                {epoch: i64}
queue.provider             {epoch, requestId, attemptId, identity: ProviderIdentity}
queue.cancel               {requestId}
queue.cancelled            {epoch, requestId, attemptId}
queue.failed               {epoch, requestId, attemptId, error}
queue.unknown              {epoch, requestId, attemptId, reason}
queue.result               {epoch, requestId, attemptId, result: StagedResult}
queue.abandon              {requestId, acknowledgeDuplicateRisk: bool}
queue.lateResult           {requestId, attemptId, result: StagedResult}
queue.events               {requestId}
harness.close              {}
```

Do not call begin_runtime implicitly on process start: tests/read-only inspection may open additional connections without stealing ownership. Future supervisor is its only production owner. No succeeded or arbitrary SQL command.

- [ ] **Step 1: Write process RED tests behind `cfg(feature = "acceptance-harness")`.** Spawn actual `CARGO_BIN_EXE_queue-harness` with a unique test-created temp directory; send serialized lines over stdin, collect correlated responses with a bounded test watchdog (kill only owned test child on failure). Enqueue across two projects, beginRuntime, claim with cap1, save provider thread then turn, request cancellation and close actual child. Spawn a new child with same DB, snapshot unchanged, beginRuntime becomes unknown retaining provider IDs; queued second page remains blocked until explicit terminal or risk acknowledgment. Assert no duplicate jobs and original feedback remains. A separate test records ResultReady manifest, restarts, and proves no new claim of that page and no candidate/approval/succeeded fabricated.

```rust
let mut first = Harness::spawn(&database);
let initial = first.call("native.queue.beginRuntime", serde_json::json!({}));
let epoch = initial["result"]["settings"]["epoch"].as_i64().unwrap();
let claimed = first.call("native.queue.claim", serde_json::json!({"epoch": epoch}));
assert_eq!(claimed["result"]["requestId"], "r1");
first.close_and_wait();
let mut second = Harness::spawn(&database);
let recovered = second.call("native.queue.beginRuntime", serde_json::json!({}));
assert_eq!(recovered["result"]["jobs"][0]["status"], "outcome_unknown");
```

Fixtures enqueue `r1` before the code above. Child/test helpers live only in tests and always reap child processes. Also test malformed/unknown command/invalid arguments followed by successful settings request, failed foreign-DB startup without mutation, and no implicit recovery simply by spawning another read-only child.

- [ ] **Step 2: Run RED.** `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --features acceptance-harness --test presales_queue_process`; record missing binary/behavior diagnostics.
- [ ] **Step 3: Implement short synchronous command dispatch.** Strictly decode command-specific params (deny unknown fields), forward only typed queue operations, flush one line per response, no raw secrets in error formatting. Large transport lines >262144 bytes rejected; bounded read prevents unbounded allocation before rejection and drains to the next newline so the next request succeeds. Handle byte-fragmented UTF-8 only after a complete line is assembled. Existing production-harness unchanged. The shared dispatcher has no generic SQL/Tauri method routing. Queue state requests are short; this binary does not perform long image calls or prove the future Worker async scheduler. Process tests send fragmented/coalesced input, include Chinese feedback, reject reserved-ID/method/params misuse and prove recovery after oversized lines.
- [ ] **Step 4: Verify increment.** Run feature process tests and all queue tests, `pnpm test`, `pnpm typecheck`, `pnpm lint`, `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check`, and `git diff --check`. Record synthetic coverage distinctly from actual account/PNG/UI acceptance. No application build/installation, customer-data migration or live provider calls.
- [ ] **Step 5: Commit.** `test: exercise durable queue through native process transport`. Parent writes `docs/verification-2026-09-10-presales-durable-queue.md` after independent review and marks completed plan steps. Preserve the ongoing feature branch; no merge or push of an unfinished user-facing feature.

## Plan self-review

Covered here: global persisted limit, FIFO/page uniqueness, immutable snapshots/provider IDs, lifecycle ambiguity/cancellation/restart, exact staged metadata, separate storage and actual native process control. Reserved (not claimed): file-backed PNG staging, candidate/receipt publication transaction, verified v3 catalog/migration, async Worker/provider ownership, gallery/history/review/drafts and real four-way/image/memory/export acceptance. Interfaces between tasks match the declarations above; no generic success or legacy mutation escape hatch exists.

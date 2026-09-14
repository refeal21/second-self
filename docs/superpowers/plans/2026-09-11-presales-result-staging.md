# Trusted PNG Result Staging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reliably preserve and revalidate an actual generated PNG before marking its exact durable queue attempt result-ready, including local-only recovery after interrupted saving.

**Architecture:** Extend the isolated native queue with a descriptor-rooted immutable result vault and a trusted in-process staging adapter. Publish PNG bytes first and an immutable binding manifest second; only after both are durable may the queue record result-ready. This is the file-staging portion of approved design §6.2, not candidate publication: project state, receipt, selected visual and succeeded must eventually join in one dedicated v3 database transaction, never across the legacy workbench database and standalone queue.

**Tech Stack:** Existing Rust, rusqlite, libc, serde/serde_json, sha2; directly pin the already locked and locally available `png = "=0.18.1"` decoder. No new runtime, image API or platform.

**Spec:** `docs/superpowers/specs/2026-09-09-presales-batch-visual-design.md`, particularly §§4.2, 5, 6.1–6.4 and 9.4–9.5. This is continuation of the already approved implementation, not a new product scope.

## Global Constraints

- Preserve local Tauri 2 / React / Rust / TypeScript Worker / SQLite and ChatGPT login. No API Key, paid API, HTTP server, personal Codex configuration changes or live model calls.
- Work only in `.worktrees/presales-batch`; do not read/change customer project material, the legacy `workbench.sqlite3`, or the running `.app`. Do not build/install/launch a replacement app, push or merge in this increment. Do not play sounds or send notifications.
- All image bytes are synthetic test inputs. Files go only beneath an explicitly supplied existing native-owned result root. No arbitrary output paths, symlink traversal or overwriting prior attempts.
- “结果提交”：可靠暂存结果 PNG 和哈希 → 加载最新 pipeline → 校验此 Job 的目标快照仍有效且未被取消/替代 → 同一 SQLite 事务记录候选、receipt、Job 终态、pipeline 和审批资格变化。This increment implements only the first part; no candidate, approval, active-version, export, or succeeded shortcut.
- “未知状态不自动释放名额或重试出图”。Recovery examines persisted files only, does not call a provider or enqueue/claim replacement work. Cancellation evidence survives runtime recovery.
- Existing queue database schema/application ID/version and existing JSON-RPC methods stay unchanged. Raw manifest RPC remains explicitly metadata-only and must not be wired into production as proof of bytes.
- Request/attempt identifiers use the exact existing queue identifier rules. Final PNG path stays `queue-results/{requestId}/{attemptId}.png`; its sidecar manifest is `queue-results/{requestId}/{attemptId}.json`.
- File size limit is 1..=52,428,800 bytes, dimensions 1..=8192 each, pixel count <=16,777,216, decoded frame <=134,217,728 bytes, decoder allocation limit 67,108,864 bytes. Reject animated PNG; decode the image and finish its remaining chunks, not just check the signature. These are defensive staging bounds, not a claim of measured application RSS or visual quality. Do not enforce a new aspect ratio or alter image pixels.
- Existing files are immutable: exact content may be reused after validation; different content at either path is an error. Preserve a durably staged file if subsequent SQLite recording fails; do not regenerate or remove it. Incomplete PNG-only artifacts are not recovery proof without their matching manifest.
- Future candidate publisher must revalidate stored files and the current approved project snapshot. This staging binding hashes the complete immutable QueueTarget using Rust serialization plus SHA-256; it does not resolve whether each target version hash belongs to a valid approved project.

---

### Task 1: Descriptor-rooted immutable PNG vault

**Files:**
- Create `apps/desktop/src-tauri/src/presales_queue/result_vault.rs` (public vault, private manifest and verified result, PNG validation).
- Create `apps/desktop/src-tauri/src/presales_queue/result_files.rs` (private descriptor-relative read/create/fsync primitives).
- Modify `apps/desktop/src-tauri/src/presales_queue/mod.rs` and `store.rs` (exports and share existing identifier/hash validators within module only).
- Modify `apps/desktop/src-tauri/Cargo.toml` / `Cargo.lock` (direct already-locked png dependency).
- Create `apps/desktop/src-tauri/tests/presales_result_vault.rs` and optional `tests/support/result_fixtures.rs` (test-only fixtures, no exported production test hooks).

**Interfaces:**

```rust
pub struct ResultVault { /* owns a held, canonical native root directory fd */ }
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResultBinding {
    pub request_id: String,
    pub attempt_id: String,
    pub target_sha256: String,
}
pub struct VerifiedPngResult { /* private verified manifest and binding */ }
impl VerifiedPngResult {
    pub fn manifest(&self) -> &StagedResult;
    pub fn binding(&self) -> &ResultBinding;
    pub fn dimensions(&self) -> (u32, u32);
}
impl ResultVault {
    pub fn open(root: impl AsRef<std::path::Path>) -> Result<Self, String>;
    pub fn stage(&self, binding: &ResultBinding, png: &[u8]) -> Result<VerifiedPngResult, String>;
    pub fn recover(&self, binding: &ResultBinding) -> Result<VerifiedPngResult, String>;
}
```

Neither `VerifiedPngResult` nor the vault is deserializable. Manifest JSON is strict camelCase, schemaVersion 1, containing `binding`, `result` (existing StagedResult), `width`, `height`. Verify all fields, path, size, hash and actual decoded dimensions on recovery. Native code computes size/hash; never accepts a caller's claimed file metadata as verification.

- [x] **Step 1: Write focused failing behavior tests.** Use real temp directories/PNG bytes, not mock filesystem or decoder. One minimal acceptance example (fixture helper creates a real fixed 16×9 RGB PNG):

```rust
let root = fixture_root();
let vault = ResultVault::open(&root).unwrap();
let binding = ResultBinding { request_id: "r1".into(), attempt_id: "a1".into(), target_sha256: "a".repeat(64) };
let png = solid_png(16, 9);
let staged = vault.stage(&binding, &png).unwrap();
assert_eq!(staged.manifest().relative_path, "queue-results/r1/a1.png");
assert_eq!(staged.dimensions(), (16, 9));
assert_eq!(std::fs::read(root.join("queue-results/r1/a1.png")).unwrap(), png);
assert_eq!(ResultVault::open(&root).unwrap().recover(&binding).unwrap().manifest(), staged.manifest());
```

Cover invalid IDs/hash before any writes; non-PNG, truncated PNG, corrupted image/chunk, APNG, dimensions/pixel/decode limits; exact repeated stage with unchanged files; same attempt/different bytes or target rejected with original bytes intact; parent/final symlinks, directories and FIFO at final paths; no write outside root; bounded manifest reads and unknown/changed metadata; missing/tampered PNG; PNG-only interrupted stage fails recovery; different pages staged from concurrent vault handles are independent. Use unique exclusively created test roots and owned cleanup guards. A root rename/replacement after open must not redirect writes to its replacement: root fd is held, and every child opened relative to held descriptors with O_NOFOLLOW.

- [x] **Step 2: Run RED.** `cargo test --offline --manifest-path apps/desktop/src-tauri/Cargo.toml --test presales_result_vault`. After declarations compile, retain actual behavior failures, not merely a missing-module compiler error.
- [x] **Step 3: Implement the vault.** Validate bounds before allocation; use png Decoder limits, read_info, reject animation, checked output size and decode + finish. Use private fd-relative helpers patterned on `paths.rs` / `visual_style.rs`; O_NOFOLLOW directory walk, O_NONBLOCK final reads with fstat regular-file and bounded lengths. Create required directories under held fds with mkdirat and handle EEXIST by safe reopen; fsync newly created parent entries. Write fresh mode-0600 temporary file, sync, linkat exclusive final, unlink only owned temporary link, fsync parent before success. Exact-existing replay must validate/read safely and sync durable files/parent too. Keep filenames generated from identifiers, never from manifest input. Reuse no-overwrite semantics without adding production test-only callbacks.
- [x] **Step 4: Run GREEN and regression.** Focused vault and existing paths tests, then one complete default Rust suite before commit. `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check` and `git diff --check`. Record exact suite counts and output; do not sum by guessing.
- [x] **Step 5: Commit only Task 1 files** as `feat: add immutable verified PNG result vault` and write the scoped implementation report with RED/GREEN evidence.

### Task 2: Queue staging bridge and restart-safe local recovery

**Files:**
- Create `apps/desktop/src-tauri/src/presales_queue/result_staging.rs` (native in-process bridge, no RPC registration).
- Modify `apps/desktop/src-tauri/src/presales_queue/mod.rs`, `lifecycle.rs` (keep cancel intent when an uncertain recovered attempt later returns), and narrowly scoped validator visibility if needed.
- Create `apps/desktop/src-tauri/tests/presales_result_staging.rs`; extend `presales_queue_lifecycle.rs` only for recovered-cancellation regression.
- Create `docs/verification-2026-09-11-presales-result-staging.md`.

**Interfaces:**

```rust
impl QueueStore {
    pub fn stage_png_result(&mut self, vault: &ResultVault, epoch: i64,
        request_id: &str, attempt_id: &str, png: &[u8]) -> Result<QueueJob, String>;
    pub fn recover_png_result(&mut self, vault: &ResultVault, epoch: i64,
        request_id: &str, attempt_id: &str) -> Result<QueueJob, String>;
}
```

Consumes Task 1 ResultVault. Derive `ResultBinding.target_sha256` from `sha2::Sha256::digest(serde_json::to_vec(&job.target)?)`; callers never supply binding or output paths. Both APIs validate epoch, exact job/attempt, eligible state before file work and again at the transactional recording boundary. Stage accepts the current owning epoch on dispatching/running/outcome_unknown/cancel_requested; exact result-ready replay is permitted only with matching verified result. Recovery accepts current owning active attempts and exact persisted result-ready jobs even if result-ready retained a previous epoch (current runtime epoch must still match; do not mutate ownership merely to return that result). Queued, failed, succeeded, cancelled and abandoned jobs cannot be promoted. Wrong/stale requests cause no file writes. Files left by a race after preflight remain isolated evidence, never candidates.

- [x] **Step 1: Write real integration RED tests.** Example behavior:

```rust
let (mut store, vault, db, root, epoch) = dispatched_fixture();
let result = store.stage_png_result(&vault, epoch, "r1", "a1", &solid_png(16, 9)).unwrap();
assert_eq!(result.status, JobStatus::ResultReady);
let before = store.events("r1").unwrap();
assert_eq!(store.recover_png_result(&vault, epoch, "r1", "a1").unwrap(), result);
assert_eq!(store.events("r1").unwrap(), before);
drop(store);
let mut store = QueueStore::open(&db).unwrap();
let epoch2 = store.begin_runtime().unwrap().settings.epoch;
assert_eq!(store.recover_png_result(&ResultVault::open(&root).unwrap(), epoch2, "r1", "a1").unwrap(), result);
```

Cover actual staged file before queue recording then reopen/begin_runtime/recover; SQLite recording failure via a temporary test-owned trigger leaves PNG+manifest but job not ready, remove trigger then recover without restaging or new attempt; invalid bytes/missing/corrupt/wrong-binding files never change queue; stale epoch/attempt/queued input creates no files; wrong manifest cannot change ready job; ready recovery revalidates bytes on every call. Exercise multi-page out-of-order stages across real SQLite connections and exact replay (one result event each, no replacement requests), while no new succeeded state/candidate/approval appears. Cover cancel before result (audit only, Cancelled), cancel → begin_runtime → recovered file (still Cancelled, no result), result before cancel (remains ready), abandonment with late files (not published, new same-page request untouched). No model invocation exists in this module.

- [x] **Step 2: Run RED.** Focused `presales_result_staging` plus recovered-cancel lifecycle regression; record behavioral failures before implementing corresponding branches.
- [x] **Step 3: Implement trusted bridge.** Derive exact binding from persisted job, stage or revalidate through vault, then use existing transactional evidence path. For active recovered cancellation, consult durable attempt-local cancel intent when processing Result evidence; never let runtime-recovered OutcomeUnknown erase an earlier user cancellation. Preserve exact replay/error behavior and unchanged schema. In result-ready recovery, check a fresh consistent read snapshot after file verification to fence runtime/replacement changes; require exact job result equality. Preserve staged files on every database error. Document that output is result-ready, not visual approval/publication, and that verifying bytes again is required when candidate integration lands.
- [x] **Step 4: Run GREEN and regression.** Focused vault/staging/lifecycle/queue process suites, one default Rust suite, fmt/diff. Parent independently repeats focused suites. No app/window needed. Documentation records actual results and the remaining atomic v3 publication, supervisor and UI work.
- [x] **Step 5: Commit Task 2** as `feat: recover staged queue images without regeneration`, include scoped report and no unrelated files. Whole-increment review follows; retain unfinished feature branch and original application.

## Self-review and execution

The approved broad design's file-first staging, attempt fencing, unknown-state retention and cancellation requirements map to Tasks 1/2. Atomic candidate publication, v3 catalog/import, production Worker transport and UI are intentionally not claimed by this file-staging increment and remain in the overall design. No cross-database success marker is added. Task 1's metadata matches the existing StagedResult path; Task 2's binding is computed natively from the persisted immutable target. Execute sequential implementers with independent task reviews; filesystem inspection and boundary analysis can run alongside controller preparation.

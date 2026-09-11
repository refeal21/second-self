# Presales v3 Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the existing durable queue, presales rules and verified PNG vault to a usable multi-page workbench with independent history, feedback, approval and delivery selection.

**Architecture:** A new strictly owned v3 SQLite database contains both queue and project/page records so publication is one local transaction. The legacy database, sequential pipeline and original customer directories retain their existing behavior. Rust owns persistent authority; an asynchronous Worker executes bounded jobs; React reconciles snapshots and never owns generation lifetime.

**Tech Stack:** Existing Tauri 2, React/TypeScript, Rust/rusqlite, TypeScript Worker and Codex App Server; no replacement stack or paid API.

**Spec:** `docs/superpowers/specs/2026-09-09-presales-batch-visual-design.md` (approved 2026-09-10).

## Global Constraints

- Default global concurrency is 4; the supported user setting is 1–4. FIFO applies across projects. At most one unfinished generation exists per project/page.
- All pages remain independently viewable and reviewable while other pages generate. Manual revisions have no application-imposed count limit; automatic QA still has at most two repair rounds.
- Existing v1/v2 projects, data, approvals and directories are not rewritten or silently upgraded. Creating a v3 copy requires an explicit in-product action; all development tests use synthetic fixtures.
- Outline/content and their companion presales plan/design are saved and approved as exact pairs. Frozen on-screen content is the truth; speaker notes must not become slide text.
- New generated candidates require exact content, design, skill and palette provenance. Do not fabricate missing legacy provenance or claim old approval is a new approval.
- Files are immutable and durably verified before publication. Candidate, receipt, page selection, eligibility and queue success are committed in the same v3 SQLite transaction.
- Uncertain or unconfirmed cancelled remote jobs retain their local slots until resolved or explicitly abandoned with a risk acknowledgement. Restart must not automatically resend them.
- Selecting a historical image for inspection is not selecting it for delivery. Revision invalidates only the affected page's effective approval; old versions and decisions remain available.
- Feedback drafts persist by project/page/base version. A same-page running job does not prevent saving the next draft but does prevent automatically sending another job.
- A history-based image edit must actually transmit the parent image. Unsupported reference input must be explicitly capability-gated; text-only regeneration cannot be presented as an image edit.
- No API Key configuration, paid API fallback, local HTTP server, personal Codex configuration changes, sound playback, app replacement or customer-project mutation during synthetic implementation/testing.
- All implementation occurs in `.worktrees/presales-batch` on `codex/presales-batch-review`; preserve the original checkout. Commit only task-owned changes.

## File and ownership map

- `src-tauri/src/presales_queue/schema.rs`: shared exact queue DDL and strict closed database ownership profiles; not an arbitrary extra-table facility.
- `src-tauri/src/presales_v3/{contracts,store,basis}.rs`: v3 transport/read model, database ownership, catalog and validated frozen basis.
- `src-tauri/src/presales_v3/{events,publication,feedback}.rs`: narrow page events, atomic verified publication, version-bound drafts and approval.
- `src-tauri/src/presales_v3/{import,service}.rs`: explicit copy preparation, immutable assets and workbench-facing authority.
- `src-tauri/src/presales_v3/{commands,supervisor}.rs`: Tauri commands/events and application-owned dispatch/recovery.
- `apps/worker/src/presales/{runtime,delivery}.ts`: asynchronous queue execution and frozen active-version export selection.
- `apps/desktop/src/presales/{adapter,workspace,read-model}.ts[x]`: typed native adapter and multi-page review UI.
- Targeted seams in existing App, Worker CLI/RPC, native service and process transport; do not rewrite the legacy workspace/pipeline to imitate independent pages.

Paths prefixed `src-tauri/` above are under `apps/desktop/`. Keep responsibilities in focused files; subdividing a named module into private helpers is allowed when needed to avoid a monolith.

### Task 1: Strict combined v3 store and frozen project catalog

**Files:**
- Create `apps/desktop/src-tauri/src/presales_queue/schema.rs`.
- Create `apps/desktop/src-tauri/src/presales_v3/{mod,contracts,store,basis}.rs`.
- Modify `apps/desktop/src-tauri/src/presales_queue/{mod,store}.rs`, `apps/desktop/src-tauri/src/presales/{mod,storage}.rs`, `apps/desktop/src-tauri/src/lib.rs` only for shared schema/basis seams and module registration.
- Test `apps/desktop/src-tauri/tests/presales_v3_store.rs` and existing queue/storage suites.

**Interfaces:**
- Consume `ProjectCheckpoint`, native paired validation, `native_value_hash`, `NATIVE_VALUE_HASH_ALGORITHM`, `QueueStore` and queue DDL.
- Produce `V3Store::open(path)`, `V3Store::open_in_memory()`, `V3Store::load_project(&str) -> Result<V3ProjectSnapshot, String>` and `V3Store::list_projects() -> Result<Vec<V3ProjectSummary>, String>`.
- Produce a crate-private `ValidatedV3ProjectSeed` (not `Deserialize`) and `V3Store::insert_project(ValidatedV3ProjectSeed)`. Construction must validate the complete paired native checkpoint, frozen outline/details, actual matching native approval bindings, current bundled skill and saved palette. A crate-private checked factory is not a public command accepting a trusted boolean.
- Produce `V3VisualBasis { hash_algorithm, spec, design, skill, palette }` using `VersionHash`; structural values use `native-json-sha256-v1`, actual image bytes use SHA-256. Spec/design hashes are per-page values, their version IDs are the paired details version; palette version is the saved style revision. Preserve the whole paired frozen checkpoint and origin snapshot digest as evidence.
- Produce strict camelCase/deny-unknown structs: `V3ProjectSummary`, `V3ProjectSnapshot`, `V3PageState`, `V3VisualVersion`, `V3Approval`, `V3FeedbackDraft`, `V3Origin` and tagged `V3VisualProvenance::Presales | LegacyImported`. Missing imported image/provenance stays explicitly absent.

- [ ] **Step 1: Add focused red tests using real in-memory/file SQLite.** Cover empty/reopen, foreign/queue-only/v3-version/extra-table rejection before mutation, duplicate project rejection, frozen-pair tampering and deterministic per-page basis. Use existing paired fixtures; do not claim a hand-written status is approval.

```rust
#[test]
fn queue_only_owner_cannot_open_v3_database() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("v3.sqlite3");
    drop(V3Store::open(&path).unwrap());
    let before = std::fs::read(&path).unwrap();
    assert!(QueueStore::open(&path).is_err());
    assert_eq!(before, std::fs::read(&path).unwrap());
}
```

- [ ] **Step 2: Run `cargo test --offline --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --test presales_v3_store`; record the missing implementation failure.**
- [ ] **Step 3: Implement a closed v3 schema profile, application ID `0x44545633`, user version `1`.** Retain exact queue-only identity `0x44545133`/2 and its eight objects. Shared strict schema validation accepts only an internally declared ownership profile, never caller-provided additional SQL. V3 includes queue objects plus `v3_projects`, `v3_pages`, `v3_versions`, `v3_receipts`, `v3_approvals`, `v3_feedback`, `v3_import_receipts`, `v3_delivery_snapshots`, `v3_artifacts`. Use foreign keys and unique request/attempt/version sequence keys. Queue/settings access for subsequent tasks is crate-private; do not expose a mutable queue that bypasses page admission to the frontend.

```rust
// Closed profile selection, not caller-defined schema extension.
enum DatabaseProfile { QueueOnly, PresalesV3 }
// Opening validates existing identity + exact SQL before setting WAL pragmas.
// Creating inserts the entire profile and its identity in one transaction.
```

- [ ] **Step 4: Run the new store, existing queue/lifecycle/result staging and paired storage tests; run fmt and diff checks.** Confirm old queue DB stays rejected by v3 and vice versa.
- [ ] **Step 5: Commit `feat: add isolated v3 project catalog and database ownership`.** Write task report with schema/API decisions, RED/GREEN evidence and exact command results. This is a foundation, not user feature completion.

### Task 2: Atomic admission, publication, history and approvals

**Files:**
- Create `apps/desktop/src-tauri/src/presales_v3/{events,publication,feedback}.rs`.
- Modify v3 contracts/store plus crate-private transaction seams in `presales_queue/{store,lifecycle,result_staging}.rs`.
- Test `apps/desktop/src-tauri/tests/presales_v3_events.rs`.

**Interfaces:**
- Consume Task 1 `V3Store`, validated saved per-page basis and existing `ResultVault`/`VerifiedPngResult`.
- Produce store methods `enqueue_pages`, `commit_result`, `approve_version`, `save_feedback`, `adopt_version`, `restore_approval`, `create_delivery_snapshot` plus typed inputs/outputs in v3 contracts. `enqueue_pages` input includes project, batch/request/attempt IDs, page IDs, expected page revisions, optional parent version and feedback; derive the target/basis natively. `approve_version` includes exact version/image/basis, page revision and two true manual checks. No arbitrary pipeline replacement command.

- [ ] **Step 1: Write red tests for three-page interleaved completion/approval, request replay, corrupt/missing vault file, same-page duplicate, changed basis, five revisions, draft keys, historical inspection versus adoption, cancellation/abandonment and delivery invalidation.**

```rust
// Given two queued pages A and B: publish B, approve B, then publish A.
// Assert B's exact effective approval survives and both receipts exist.
// Replaying A publication returns its original version ID and version count.
// A byte-corrupted staged PNG cannot create any candidate or mark success.
```

- [ ] **Step 2: Run `cargo test --offline --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --test presales_v3_events`; capture RED.**
- [ ] **Step 3: Implement admission and publication using short IMMEDIATE transactions.** Admission writes queue and page revision intent together and invalidates only that page's eligibility. Exact request replay is idempotent; another active request returns its identity without replacing feedback. Publication revalidates vault bytes, current epoch/attempt, target, revision intent, no durable cancel intent, immutable basis and current page; insert version+receipt, update active version/project revision and queue success together. Check receipt first for exact replay. A local commit failure retains verified files and ResultReady for save-only retry. A stale same-page event fails; unrelated-page project revisions do not replace the whole snapshot. At most three short local conflict retries, never another image call.

```rust
// Pseudocode defining the atomic boundary:
// verified = vault.recover(binding)?;
// tx = connection.transaction_with_behavior(Immediate)?;
// return_exact_receipt_or_validate_live_attempt(&tx, &verified)?;
// insert_immutable_version_and_receipt(&tx, &verified)?;
// update_only_target_page_and_invalidate_delivery(&tx)?;
// persist_queue_success_and_audit(&tx)?; tx.commit()?;
```

- [ ] **Step 4: Implement independent draft CAS and version-bound approval.** Preserve historical approval records; selecting for display is read-only. Adoption/restoration checks no unfinished affected request and all byte/basis evidence. Create immutable delivery maps only when each active version has exact effective approval; never `.at(-1)`.
- [ ] **Step 5: Run events/store/queue/vault suites, fmt/diff checks; commit `feat: publish and review independent slide versions atomically`.**

### Task 3: Explicit validated legacy-copy and v3 service boundary

**Files:**
- Create `apps/desktop/src-tauri/src/presales_v3/{import,service}.rs` and `apps/worker/src/presales/legacy-copy.ts`.
- Modify `database.rs`, `workbench.rs`, `paths.rs`, Worker RPC only for read-only snapshot validation/copy bridge.
- Test `tests/presales_v3_import.rs` and `apps/worker/src/presales/legacy-copy.test.ts`.

**Interfaces:**
- Consume Task 1 seed/catalog and Task 2 immutable version/event contracts.
- Produce `prepare_legacy_copy`, `publish_legacy_copy`, `load_v3_project`, `list_project_catalog` through `V3WorkbenchService`; opaque prepared-copy ID binds source ID/revision/snapshot digest, mode and immutable copied artifact index. Modes are `format_copy` and `presales_content_revision`.
- Worker `validateLegacyCopySnapshot(snapshot)` uses complete existing v1/v2 `validateNativePipeline`; returns a digest-bound result over exact supplied bytes, not a caller asserted validity flag.

- [ ] **Step 1: Red tests reject active/unknown source work, tampered source after prepare, malformed replay, missing active image, unsafe paths and half-failed copy publication; compare original DB/artifact bytes before and after.**

```ts
expect(() => validateLegacyCopySnapshot({ schemaVersion: 3 })).toThrow();
// A syntactically valid v1/v2 snapshot with an impossible approval replay fails.
// Successful copy receives a distinct ID; source bytes and approvals are unchanged.
```

- [ ] **Step 2: Run the two named test targets and record RED.**
- [ ] **Step 3: Read legacy through read-only SQLite, run full offline validation and native paired/style validation.** Stage copies under a sibling v3 root, verify sizes/hashes, save original snapshot and lineage, publish catalog/index/import receipt in one v3 transaction after all required assets succeed. Missing history is visible missing metadata, never eligible. Format-only copy preserves only proven original approval via `originApprovalRef`; content revision carries sources/analysis to draft and requires new paired approvals. Existing legacy without real presales companion is not assigned invented design/skill hashes: view history and use the content-revision path for new presales generation.
- [ ] **Step 4: Run import/legacy validation and native storage regression tests; commit `feat: create validated parallel-review project copies`.**

### Task 4: Application-owned asynchronous queue runtime

**Files:**
- Create `apps/desktop/src-tauri/src/presales_v3/{commands,supervisor}.rs`, `apps/worker/src/presales/runtime.ts`.
- Modify `lib.rs`, `tauri_worker.rs`, Worker `sidecar-cli.ts`, `sidecar-rpc.ts`, protocol contracts and tests.
- Test `apps/worker/src/presales/runtime.test.ts`, native `tests/presales_v3_supervisor.rs` and actual process harness.

**Interfaces:**
- Consume service admission/publication and queue epoch/lifecycle/claim operations.
- Produce typed short native commands for load/list/enqueue/approve/draft/history/settings/pause/cancel/abandon and `presales-queue-changed` events carrying revision, never full image bytes.
- Worker messages `presales/start` acknowledge promptly, emit provider identity/progress/result events asynchronously and service correlated native requests while a generation runs. Rust owns dispatch and global slots, Worker does not invent a second concurrency limit.

- [ ] **Step 1: Add RED fake-provider tests at concurrency 1/2/4 with five pages completing out of order; prove stdin remains responsive and a native callback can complete during a slow job.**

```ts
// Dispatch A and B, hold both providers, issue snapshot/settings RPC.
// Snapshot must resolve before either provider is released.
// Finish B then A; each emitted completion retains its original request/attempt.
```

- [ ] **Step 2: Run runtime/supervisor focused tests and record RED.**
- [ ] **Step 3: Start one managed v3 service/supervisor per app instance, recover epoch before dispatch, use bounded async Worker jobs and immediate provider-identity persistence.** Decode stdout as complete UTF-8 lines across byte boundaries. Bound event buffers and ignore old process generations. Cancel acknowledgement must be evidence-based; unknown errors retain slots. Lowering concurrency leaves already running jobs alone; pause stops claims only. Closing WebView routes does not cancel work; exiting app cannot promise continued generation.
- [ ] **Step 4: Run fake-provider plus process crash/restart/cancel/late-result tests; commit `feat: run durable multi-page generation outside the webview`.**

### Task 5: Real Codex image execution and reference capability

**Files:**
- Modify `apps/worker/src/{app-server,codex-image-turn}.ts` and `apps/worker/src/presales/runtime.ts`.
- Create `apps/worker/src/presales/image-provider.ts` and focused tests.
- Document actual supported protocol in `docs/presales-image-provider.md`.

**Interfaces:**
- Consume persisted QueueTarget and resolved immutable parent/reference paths from native artifact authority; provide runtime image runner with start identity, progress, cancellation evidence and PNG bytes.
- Produce capability `{ generation: boolean, referenceEditing: boolean, reason?: string }`. Capability is not inferred merely from a Pro account.

- [ ] **Step 1: Verify current local App Server schema and official documentation; preserve ChatGPT login, no API Key.** Record actual input/event names and what is not proven. Do not read tokens or personal credentials.
- [ ] **Step 2: Add RED tests that exact prompt/basis and genuine image references reach the provider call and notes/source provenance are not baked into visible text.**

```ts
// Fake protocol captures actual turn input, not just a metadata flag.
// If reference input is unsupported, edit action rejects with capability reason.
// A new text-only generation must never be described as modifying a parent image.
```

- [ ] **Step 3: Implement protocol-backed image provider and immutable result resolution.** Each job has separate thread/turn identity. Use only verified input and completion formats. Distinguish completed-without-image, image failure, usage limit and unknown outcome. Persist identity before observing completion, never retry uncertain provider calls as new generations.
- [ ] **Step 4: Run captured-protocol/fake-provider tests and record any unverified live capability; commit `feat: connect queue jobs to capability-checked Codex images`.**

### Task 6: Multi-page gallery, history, feedback and paired presales editing

**Files:**
- Create `apps/desktop/src/presales/{adapter,read-model,workspace,feedback-editor}.ts[x]` with focused tests/styles.
- Modify `App.tsx`, collection read models and adapter seams for tagged project routing and explicit copy UI; retain legacy workspace.
- Connect existing presales checkpoint helpers and Worker presales envelope generation to outline/details editors.

**Interfaces:**
- Consume native v3 snapshot/commands and runtime capability/settings events.
- Produce `PresalesWorkspacePage` with independent page/version selection, per-page draft/approval and all-page queue controls. All writes have native revision checks and reconcile authoritative state on conflicts.

- [ ] **Step 1: RED component tests: navigate away and return during jobs, approve B while A/C run, switch inspected history without changing delivery, save per-version feedback, five revisions, disabled action explains why, missing-image history remains browsable.**

```tsx
// Render three-page snapshot: A running, B candidate, C queued.
// B's feedback and approval remain enabled; A cannot dispatch twice.
// Selecting B-v1 does not invoke adoptVersion; explicit adoption does.
```

- [ ] **Step 2: Run new component tests and record RED.**
- [ ] **Step 3: Implement Chinese UI: page gallery with thumbnails/status, concurrency selector 1–4, selected/all missing generation, per-job progress/retry/save-result/cancel controls, persistent feedback, history selector, explicit current-delivery badge and exact-version approval checks.** Use accessible buttons and explain running/unknown/missing basis states. No global busy lock or automatic selection jump when another page finishes. Draft save failures retain text and visibly prevent silent navigation loss. Show copied-project origin and explicit copy confirmation.
- [ ] **Step 4: Wire content/design paired draft save and joint approval to existing human-readable outline/details editors.** New presales drafts use bundled rules and actual template palette. Editing a visible bound string invalidates dependent draft design, not silent mismatch. Speaker notes remain an explicitly separate field. No user-facing JSON-only review.
- [ ] **Step 5: Run UI/read-model regression tests and browser QA using synthetic app state; commit `feat: add independent multi-page review and revision workspace`.**

### Task 7: Frozen active-version delivery integration

**Files:**
- Create `apps/worker/src/presales/delivery.ts` and tests.
- Modify v3 service/commands and UI export action to consume immutable delivery snapshot; reuse existing exporter/QA interfaces without changing legacy selection.

**Interfaces:**
- Consume `create_delivery_snapshot` with exact active image/content/design/palette approval bindings.
- Produce `prepareV3Delivery(snapshot)` returning ordered approved page inputs to existing `PptxExporter`; export result and QA report retain snapshot ID and selected-version map.

- [ ] **Step 1: RED tests ensure an older selected approved version exports instead of the newest historical image, and revising any selected page invalidates current delivery eligibility.**

```ts
// History [v1, v2, v3], active+approved v2 -> exporter input is exactly v2.
// Frozen delivery D remains immutable; newer work does not mutate D's map.
// Missing clean background/editable geometry blocks editable export honestly.
```

- [ ] **Step 2: Run delivery tests and record RED.**
- [ ] **Step 3: Connect frozen inputs to exporter/QA; retain approved text and real image/geometry evidence.** No OCR replacement of approved content, no duplicate baked text, no fake editable success. Preserve template placement and actual approval snapshot. Unsupported image-to-editable conversion clearly blocks that export while retaining image/history access.
- [ ] **Step 4: Run synthetic PPTX/QA regression if dependencies available; commit `feat: bind v3 delivery to exact approved slide versions`.**

### Task 8: Integrated acceptance and development build handoff

**Files:**
- Add integration tests/fixtures under existing desktop and Worker test locations.
- Create `docs/verification-2026-09-11-presales-v3-workbench.md`.
- Update README/current developer usage with real app build/run paths and limitations.

**Interfaces:** Consume all preceding task interfaces; no new workflow authority.

- [ ] **Step 1: Run synthetic five-page acceptance including out-of-order 1/2/4 concurrency, cross-page approval, five revision rounds, restart recovery, saved feedback, exact history selection, missing resources and unknown/cancelled remote outcomes.**

```text
new/explicit-copy -> paired outline approval -> paired details approval
-> enqueue five -> B completes first -> approve B while A/C run
-> revise B five times with independent draft histories
-> restart -> view saved versions/drafts -> exact delivery snapshot
```

- [ ] **Step 2: Run complete TypeScript tests/typecheck/lint, Rust tests including acceptance feature, fmt, skill generation check, build and diff checks.** Record counts/commands without extrapolating synthetic results into real provider success.
- [ ] **Step 3: Perform a broad branch review from `5f0d06c5826fb63cdfd0156e6a4354125da0aba5`, address findings and narrowly re-review the fix set.**
- [ ] **Step 4: Build an isolated development `.app` without overwriting the user's installed/running app; visually verify synthetic pages.** Read-only check output mute; no sounds. Live account ImageGen, Keynote editing and true peak memory are separate acceptance claims requiring actual observations; list any not yet performed.
- [ ] **Step 5: Commit verification and usage; hand off the actual usable build and clear remaining external acceptance limits.** Do not call any preceding internal test milestone the finished multi-page feature.

# Presales Native Checkpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the new presales outline and page-design pair survive native save/load/restart, with atomic publication and approvals bound to the exact pair.

**Architecture:** Add explicit paired checkpoint commands around the unchanged v1/v2 pipeline. Rust validates raw paired envelopes and computes identities; SQLite publishes the pipeline, companion and approval bindings in one transaction. Legacy commands keep their response shape for legacy projects, and fail closed for companion-enabled projects.

**Tech Stack:** Existing Rust/serde_json/rusqlite/sha2, TypeScript/Vitest and Tauri commands. No new runtime service/dependency.

**Spec:** ../specs/2026-09-09-presales-batch-visual-design.md (§3.2–3.3)

## Global Constraints

- 不增加按量计费 API、API Key 配置、本地 HTTP 服务或新的渲染平台。
- 所有最终上屏文字只有一份权威：`SlideSpec` 的标题、正文、表格、图表或基础形状文字。
- 旧项目没有这些伴随对象时按旧契约读取，不伪造已应用技能。
- 不改变原项目、图片、审批和交付文件；全部工作位于隔离目录。
- 任一部分不合法就整份不发布；不能仅解析成功的半份进入审核。

## Increment boundary

This is the native storage portion of phase A, following the tested foundation at `8f92d59`. It is not live UI activation, v3 migration, a queue, or visual acceptance. No customer data or account calls are needed. The new APIs support first-outline draft → outline approval → detail draft/edit → detail approval, and unchanged-pair checkpoint reloads. Explicitly reject companion-enabled pending structural revisions and downstream visual/export mutations until their paired event/receipt integration arrives; do not fall back to bare legacy commands. Preserve all legacy pending-revision behavior. A subsequent paired editor/adapter increment will add structural revision companions and enable the new UI only when its required paths are complete. The isolated v3 store is required before customer rollout; these tests use new synthetic databases only.

## File responsibilities

- `apps/desktop/src-tauri/src/presales/{mod.rs,validation.rs,checkpoint.rs}`: envelope contracts, independent validation, binding identities and lifecycle guard respectively. Keep data parsing separate from persistence.
- `apps/desktop/src-tauri/src/presales/storage.rs`: companion SQL schema, exact-revision load and transactional validation/save helpers.
- `apps/desktop/src-tauri/src/database.rs`: existing transaction ownership and legacy mutation bypass guards; delegate presales logic to its module.
- `apps/desktop/src-tauri/src/workbench.rs`: reuse the existing path/artifact commit boundary for paired commits, not a second filesystem writer.
- `tauri_workbench.rs`, `lib.rs`, `src/bin/production-harness.rs`: paired command exposure.
- `apps/desktop/src/presales-checkpoint.ts`: explicit typed transport, native identity preservation and conflict recovery; not UI activation.
- Native tests in `tests/presales_contracts.rs`, `tests/presales_storage.rs`, `tests/presales_workbench.rs`; frontend transport tests adjacent to its module. Synthetic contract vector JSON in `fixtures/presales/native-contract.json`, also exercised by the TS validators.
- Compiler emits `apps/worker/src/presales/skill.metadata.generated.json` in addition to the existing TS bundle, consumed with Rust `include_str!` at build time. One compiler owns both; no runtime file reads or hand-maintained second hash.

### Task 1: Native paired-envelope validation and deterministic identity

**Files:** Create `presales/mod.rs`, `presales/validation.rs`, native contract tests and shared synthetic fixture. Modify `lib.rs` module registration, `scripts/compile-presales-skill.mjs`, `skill-build.test.ts`; add generated metadata JSON and a TS contract-vector test.

**Interfaces:**

```rust
// serde camelCase, deny_unknown_fields on request structs.
pub struct PresalesDraftPair {
    pub schema_version: u32, // exactly 1
    pub outline: serde_json::Value, // full OutlineEnvelope
    pub details: Option<serde_json::Value>, // full DetailsEnvelope; null until generated
}
pub fn validate_pair(pair: &PresalesDraftPair, analysis: &Value) -> Result<(), String>;
pub fn native_value_hash(value: &Value) -> Result<String, String>;
pub fn bundled_skill_metadata() -> Value; // {id,version,sha256}
```

Hashes are native-computed, opaque to callers, algorithm label `native-json-sha256-v1`: recursively sorted object keys, array order retained, compact serde JSON UTF-8, no Unicode normalization. Do not claim JCS/cross-language float equivalence; TS sends raw content and preserves returned hashes, it never independently authorizes by recalculating them. Same native algorithm is used for approval and reload validation. No hash of mutable project display metadata.

- [ ] Write Rust RED tests for valid outline-only/rich-details pairs, roundtrip identity, reordered object keys, changed text/plan/notes identities, unknown fields, mismatched IDs/order/titles/count, modules not covered, sources/findings/data references, dangling/duplicate visible bindings, notes/brief/geometry binding rejection, scene edges/module/ref mismatch, invalid shapes/table/chart dimensions, and bounded data.
- [ ] Run `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test presales_contracts` and record expected missing-code failure.
- [ ] Implement independent native contract validation matching the foundation's JSON semantics in `apps/worker/src/presales/validation.ts`. Limits: 2 MiB per envelope, depth 32, descriptive string 20,000 UTF-16 units; pages/modules/bindings/scene steps max 100, scene edges max 400. Validate the analysis structure and its references before using it as an authority. No legacy normalization or silently discarded fields. Every visible leaf has exactly one stable binding, including numeric chart values. JSON values cannot contain JS getters/prototypes, but reject reserved/unknown fields. Existing revision helpers may only be reused where semantics match; do not impose their nonempty-body requirement on the new contract.
- [ ] Extend compiler and tests so both generated files are deterministic and `--check` detects either stale/missing file without writing. Metadata hash must exactly match the current TS bundle. Test the same synthetic vector through both implementations, including a rich table/chart/shape/scene.
- [ ] Run focused native/Worker tests, `pnpm check:presales-skill`, then full `pnpm test:rust` and Worker typecheck before committing task-owned files. Report RED/GREEN evidence.

### Task 2: Atomic companion snapshots and joint approval guards

**Files:** Create `presales/checkpoint.rs`, `presales/storage.rs`, `tests/presales_storage.rs`; modify `presales/mod.rs`, `database.rs`.

**Interfaces:** Consume Task 1's `PresalesDraftPair`, `validate_pair`, `native_value_hash`, `bundled_skill_metadata`. Produce:

```rust
pub struct ProjectCheckpoint { pub pipeline: Value, pub presales: Option<PresalesCheckpoint> }
// Serializes schemaVersion, hashAlgorithm, skill, draft, basis, approvalBindings.
pub struct PresalesCheckpoint { /* typed named fields, never caller-owned approval claims */ }
pub fn Database::load_project_checkpoint(&self, project_id: &str) -> rusqlite::Result<ProjectCheckpoint>;
pub fn Database::replace_checkpoint_with_artifacts(
  &self, project_id: &str, expected_revision: i64, pipeline: &Value,
  presales: &PresalesDraftPair, artifacts: &[PersistedArtifact],
  visual: VisualCommitContext<'_>, commit_artifacts: impl FnOnce() -> Result<(), String>
) -> rusqlite::Result<Option<ProjectCheckpoint>>;
```

`None` denotes stale CAS, not success. Existing replace methods use a shared private implementation with `Option<&PresalesDraftPair>`; no duplicated projection/artifact transaction. Native `basis` records analysis request ID, existing artifact SHA and native output hash; outline version ID and content/plan hashes; optional spec version ID and spec/design hashes; per-page binding ID/path/visible-value hash. `approvalBindings` retain native-derived approval ID, stage, version ID, content and companion hashes, skill identity, decidedAt. Caller cannot submit these fields. Treat absent companion as absent, corrupt/missing exact revision as error.

- [ ] Write RED tests using real SQLite and fresh synthetic fixtures: save/reopen pair, exact revision snapshot, stale CAS, missing or corrupt snapshot, invalid half causes zero changes, artifact callback failure rolls back all relational state, two competing writers cannot publish mixed halves, and old storage roundtrip unchanged.
- [ ] Add `presales_projects(project_id PRIMARY KEY)` marker, append-only `presales_checkpoints(project_id,pipeline_revision,snapshot_json PRIMARY KEY)` and append-only `presales_approval_bindings` evidence. Include marker/companion/pipeline/projections/approvals/artifact metadata and callback in the same existing SQLite transaction. Loading the pipeline and exact revision companion uses one read transaction. Validate stored hashes/references on load; never query “latest at or before”.
- [ ] First opt-in allowed only with an unfrozen outline draft and no prior content approvals/images/export; the source analysis and both content values must exactly match the pipeline. Validate prior snapshot and freeze guards on every subsequent commit. Both outline content and plan are immutable after outline freeze; both specs and designs immutable after detail freeze. Do not detach or adopt a new plan after freeze. Reject pending structural-revision and downstream visual/export mutations with a clear capability error in this increment. Legacy projects remain unaffected.
- [ ] Joint approvals are derived only from exact next transition: outline_review draft→frozen advances to detail_review, detail_review draft→frozen advances to visual_review. Preserve prior approvals as a prefix; exactly one new matching approved record is required, with correct project/version/stage, unique ID and RFC3339 decidedAt matching freeze time. Approval-only commit cannot also edit content/design; detail approval also requires the saved joint outline proof. Reject forged approval without freeze, freeze without approval, altered historical proof, stale plan and reuse of one proof for another pair. Plan edits before freeze change eligibility/hash; never mutate the old snapshot.
- [ ] Guard every bare `replace_pipeline*`, `mutate_project`, `rename_project`, `decide_approval` mutation for enabled projects inside database transaction ownership (even direct callers). No unsafe presales read then independent write window. No automatic generation from a newly approved detail pair yet. Existing visual request start must fail clearly for enabled projects until design-aware receipts are implemented, even when no palette exists (add the narrow guard in `visual_style.rs` if needed).
- [ ] Run focused tests then complete Rust suite before committing. Record transaction/callback limitations honestly: filesystem and SQLite aren't one physical transaction; service guards publish immutable paths only after success.

### Task 3: Paired native command boundary and client recovery

**Files:** Modify `workbench.rs`, `tauri_workbench.rs`, `lib.rs`, `src/bin/production-harness.rs`, create `tests/presales_workbench.rs`, `apps/desktop/src/presales-checkpoint.ts` and its test. Add a focused production-harness test using existing harness testing patterns if available.

**Interfaces:**

```rust
// deny_unknown_fields; reuse PipelineCommitInput in a named field, not serde flatten.
pub struct PairedCheckpointCommitInput { pub commit: PipelineCommitInput, pub presales: PresalesDraftPair }
pub fn WorkbenchService::load_project_checkpoint(&self, id: &str) -> Result<ProjectCheckpoint,String>;
pub fn WorkbenchService::commit_project_checkpoint(&self, input: PairedCheckpointCommitInput) -> Result<ProjectCheckpoint,String>;
// Tauri/harness names: ppt_load_checkpoint, ppt_commit_checkpoint.
```

TS `loadPresalesCheckpoint(invoke,projectId)` and `commitPresalesCheckpoint(invoke,input)` preserve the full native checkpoint including opaque identity/proof fields. No React/adapter opt-in and no replacement of existing legacy transport yet.

- [ ] Write RED tests covering returned pair, reopen via production command, malformed pair and outside/symlink paths leave no state, stale result, and actual artifact callback failure. Client mocks only the invoke boundary and exercise serialized response validation; production native behavior uses real temporary DB/files, not mocked storage.
- [ ] Refactor existing Workbench commit preparation into one shared path for legacy/paired calls. Apply existing path/symlink/base64/hash/frozen-file protections plus exact companion artifacts. Generate companion artifact intents natively from validated pair using compact native JSON bytes and native hashes; caller must not submit its own writes under presales directories. Use immutable paths `outline/presales/plan-r{nextRevision}-{hash}.json` and `slide-specs/presales/designs-r{nextRevision}-{hash}.json`, kinds `presales-plan`/`presales-designs`, exact content version IDs. Only write changed/new pairs; approval-only/unchanged saves write none. No overwrite, no duplicate or extra companion files, no double-count in legacy v2 artifact requirements. Return the full database checkpoint only after commit, not the input pipeline.
- [ ] Register paired commands in Tauri and production harness. Reject legacy `ppt_load_pipeline` for enabled projects to prevent a consumer silently restoring half-state. Keep legacy response behavior unchanged elsewhere. Use synthetic paths; don't launch/replace the user's app.
- [ ] Client lost-response recovery may perform one read; it must compare exact requested pipeline revision, full requested pair and native identity consistency, not just pipeline equality. A successful read matching both returns the checkpoint; mismatch throws conflict without replaying writes or model calls. Malformed native response is an error, not a legacy fallback. Do not accept caller/model approval claims through this module.
- [ ] Run Rust suite, Worker and desktop tests, typecheck/lint/build/check:presales-skill and targeted production harness test. Commit task files. Add durable QA evidence describing native capability and explicitly pending editor/v3/queue/image work; do not claim user-visible batch generation is ready.

## Acceptance and remaining work

The deliverable is a working tested native paired API with durable exact-version approval evidence. Structural revision companions, paired form editors, live prompt routing, isolated v3 catalog, adjustable queue, gallery/history, actual reference-image edits and export snapshots remain mandatory subsequent increments under the original design. No new real image generation, customer project migration or app replacement is authorized by a synthetic storage test.

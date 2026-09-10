# Task 3 Report — Paired native command boundary and client recovery

## Status

DONE_WITH_CONCERNS. The scoped native paired checkpoint API, immutable artifact publication, command exposure, browser-safe transport validation, and single-read lost-response recovery are implemented. This does not activate the UI or claim batch presentation generation is user-visible.

## Files

- Modified `apps/desktop/src-tauri/src/workbench.rs`
- Modified `apps/desktop/src-tauri/src/tauri_workbench.rs`
- Modified `apps/desktop/src-tauri/src/lib.rs`
- Modified `apps/desktop/src-tauri/src/bin/production-harness.rs`
- Added `apps/desktop/src-tauri/tests/presales_workbench.rs`
- Added `apps/desktop/src/presales-checkpoint.ts`
- Added `apps/desktop/src/presales-checkpoint.test.ts`

The controller-owned dirty plan and `docs/verification-2026-09-10-presales-native-checkpoints.md` were not edited or staged by Task 3.

## RED evidence

1. `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test presales_workbench`
   - Failed to compile because `PairedCheckpointCommitInput`, `commit_project_checkpoint`, and `load_project_checkpoint` did not exist.
2. `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test presales_workbench normalized_presales_alias_is_rejected_as_a_native_owned_path -- --exact`
   - Failed with `Paired v1 changed-content artifact is missing`, proving reserved normalized aliases were checked too late.
3. `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --features acceptance-harness --bin production-harness serialized_paired_commands_survive_harness_restart_and_guard_legacy_load`
   - Failed with `unknown production command: ppt_commit_checkpoint`.
4. Initial intended TS-focused command `pnpm --filter @digital-twin/desktop test -- src/presales-checkpoint.test.ts`
   - The package script's extra `--` caused a full desktop run. The new suite failed with `Cannot find module './presales-checkpoint.js'`, the expected missing-production-module RED. That run also exposed an unrelated transient existing visual-feedback test failure; the later correct focused command and full desktop suite passed.
5. `pnpm --filter @digital-twin/desktop exec vitest run src/presales-checkpoint.test.ts -t 'loads a legacy checkpoint'`
   - Failed because the initial response parser incorrectly required paired analysis/outline even when `presales` was explicitly null.
6. `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test presales_workbench first_opt_in_of_an_existing_outline_still_publishes_a_revisioned_content_file -- --exact`
   - Failed because an existing legacy outline with equal bytes was not treated as new paired content.
7. Focused approval timestamp and cross-project proof tests each failed before their validation branches were added.
8. `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test presales_workbench invalid_or_oversized_pair_is_validated_before_native_companion_derivation -- --exact`
   - Failed because the service attempted companion derivation first and returned `Presales plan is missing`; after the fix it returns the pair validator's missing-field/limit diagnostics before native hashing or serialization.

## GREEN implementation and focused evidence

- Shared `prepare_pipeline_commit` retains legacy checks and prepares caller artifacts for both commit paths.
- Paired v1 exact-set validation requires `outline/outline-r{nextRevision}.json` and `slide-specs/slide-specs-r{nextRevision}.json` only for new/changed authoritative content, including first opt-in of an existing draft.
- Native-only plan/design artifacts use native hashes, exact version IDs, reserved component-aware namespaces, and immutable `write_new_workspace_artifact` publication. Approval-only saves add no artifact rows/files.
- The service validates the submitted pair against the current analysis output while holding the project lock and before deriving native companion hashes/bytes; the database repeats validation inside its transaction.
- Every paired filesystem write retains rollback ownership until the database transaction returns its full checkpoint.
- Legacy load fails closed for enabled projects; project-directory lookup uses the paired-aware loader; QA therefore remains closed. Unknown legacy project load still returns exactly `Unknown project`.
- Tauri and harness expose `ppt_load_checkpoint` and `ppt_commit_checkpoint`; harness inspection preserves `pipeline`/counts and adds the full checkpoint.
- The TypeScript transport validates and clones the request before the first await, validates direct success, preserves opaque native identities, compares JSON with object-key-order independence and array-order sensitivity, and performs one read only after invoke rejection. It never rehashes native values or retries a commit.

Focused commands:

- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test presales_workbench` — 11 passed.
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test workbench --test presales_storage --test presales_workbench` — 39 passed.
- `pnpm --filter @digital-twin/desktop exec vitest run src/presales-checkpoint.test.ts` — 12 passed, including browser-target esbuild with `write:false`.
- `pnpm --filter @digital-twin/desktop typecheck` — exit 0.
- `pnpm --filter @digital-twin/desktop lint` — exit 0, zero warnings.
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --features acceptance-harness --bin production-harness --test presales_workbench` — dispatch unit 1 passed; integration 12 passed, including a real JSONL child process, service restart, process restart, legacy rejection, and paired inspection.

## Full verification

- `pnpm test:rust` — 103 passed, 0 failed.
- `pnpm test:core` — 8 passed, 0 failed.
- `pnpm test:worker` — 361 passed, 0 failed.
- `pnpm test:desktop` — 324 passed, 0 failed.
- `pnpm typecheck` — core, desktop, Worker all passed.
- `pnpm lint` — core, desktop, Worker all passed with zero warnings.
- `pnpm check:presales-skill` — exit 0.
- `pnpm build:worker-sidecar` — sidecar blob/injection completed.
- `pnpm --filter @digital-twin/desktop build` — TypeScript and Vite production build passed; 66 modules transformed.
- `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check` — exit 0.
- `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml --features acceptance-harness --bins` — exit 0.
- `git diff --check` — exit 0.

## Self-review

- Mutation checks are covered for missing methods/commands, wrong v1 paths, SHA-valid wrong JSON, extra/missing unchanged writes, normalized reserved aliases, outside and symlink paths, stale CAS, late callback rollback, duplicate approval-only artifacts, legacy null companion, response/pair/revision mismatch, identity inconsistency, invalid proof timestamp/project, malformed direct/recovery responses, and caller mutation during await.
- The paired path does not mix native companions into the legacy v2 exact artifact validator.
- Artifact IDs use one ordinal sequence across caller and native writes, so one revision cannot collide internally.
- Only `QueryReturnedNoRows` maps to `Unknown project`; corrupt or half-present checkpoint errors remain fail-closed database errors.
- No customer data, account, model, network generation, application installation, or UI activation was used.

## Concerns and explicit remaining scope

- SQLite and filesystem publication are not one physical transaction. New paired files are immutable and rollback-owned before SQLite commit; exact pre-existing bytes can be reused after a crash, matching the existing native artifact primitive.
- Current Worker v1 actions still emit fixed legacy filenames. A later paired editor/adapter must intentionally construct the new revisioned caller intents; this task does not silently rewrite a submitted pipeline or write set.
- Structural revision companions, live paired editors/prompt routing, isolated v3 catalog, adjustable queue, gallery/history UI, design-aware image receipts/reference edits, and export snapshot integration remain pending.
- The focused production harness uses the real Rust JSONL process and persistence but not the packaged desktop app or packaged Worker; no model or application launch occurred.

## Independent review fix — load response project identity

- RED: `pnpm --filter @digital-twin/desktop exec vitest run src/presales-checkpoint.test.ts -t "rejects a .* checkpoint returned for another project without fallback"` — 2 failed because structurally valid paired and legacy-null checkpoints for project B resolved successfully when project A was requested.
- GREEN: the same focused command — 2 passed, 12 skipped. Both response shapes now require `pipeline.project.id` to equal the requested project ID, and each test confirms exactly one `ppt_load_checkpoint` invocation with no fallback.
- Final verification: full `src/presales-checkpoint.test.ts` 14 passed; desktop typecheck, zero-warning lint, production build (66 modules), and `git diff --check` all exited 0.

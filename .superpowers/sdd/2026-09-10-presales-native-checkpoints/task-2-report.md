# Task 2 Report — Atomic companion snapshots and joint approval guards

## Baseline

- Base: `d6f05fc97f32e45bf2775beaf3014d1d207956a7`.
- Baseline command: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`.
- Baseline result: 77 tests passed.

## RED / GREEN

- RED: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test presales_storage paired_checkpoint_is_returned_and_reloaded_at_the_exact_revision` failed to compile because `Database::replace_checkpoint_with_artifacts` and `Database::load_project_checkpoint` did not exist.
- Focused GREEN: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test presales_storage` passed 10/10 tests.
- The first complete Rust run reached one expected failure: `tests/database.rs::creates_all_workbench_domain_tables` still expected the legacy table inventory. The assertion was updated for the three required presales tables.
- Final formatting check: `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --all -- --check` passed.
- Final full Rust command: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` passed 87/87 tests (plus 0 doc-test failures).

## Delivered

- Added typed paired checkpoint, native basis, saved skill identity and native-derived approval binding records.
- Added marker, exact-revision append-only snapshots and append-only approval evidence tables.
- Added one shared immediate-transaction replacement implementation. Paired stale CAS returns `None`; paired unknown projects and corrupt/missing exact snapshots fail closed; legacy return behavior remains unchanged.
- First enable preserves source analysis, sources, prompt context and preferences and rejects prior approvals, visuals, export and generation history.
- Exact outline/detail approval-only transitions bind frozen content to plan/design hashes and saved skill identity. Draft edits are allowed before freeze; frozen halves are immutable.
- Bare pipeline replacement, rename, project mutation, approval insertion/decision and visual request start reject enabled projects under immediate writer ownership. Memory, settings and visual-style storage remain available.
- Paired artifact rows are insert-only. A legacy caller cannot replace an artifact row owned by an enabled project, while legacy-owned replacement behavior remains unchanged.
- Stored historical skill identity is preserved and checked for shape plus proof consistency; it is not silently compared or replaced with the current bundled skill.

## Changed files

- `apps/desktop/src-tauri/src/presales/checkpoint.rs`
- `apps/desktop/src-tauri/src/presales/storage.rs`
- `apps/desktop/src-tauri/src/presales/mod.rs`
- `apps/desktop/src-tauri/src/database.rs`
- `apps/desktop/src-tauri/src/visual_style.rs`
- `apps/desktop/src-tauri/tests/presales_storage.rs`
- `apps/desktop/src-tauri/tests/database.rs`
- `.superpowers/sdd/2026-09-10-presales-native-checkpoints/task-2-report.md`

## Remaining limits

- SQLite rollback and the artifact callback are coordinated but are not one physical filesystem/database transaction. The service layer must publish fresh immutable paths and clean up failed filesystem intents; Task 3 owns exact artifact-set/content validation and transport.
- Enabled projects intentionally reject structural revision, downstream visual/export mutation and visual request start until later increments add paired receipts.
- There is no skill-upgrade workflow. Existing projects retain their saved valid skill identity.
- Direct out-of-process SQLite writes are outside the API guard boundary.

## Review fix after `2b4cf2f`

- RED: the focused `presales_storage` run reported four new failing regressions covering inconsistent first-enable freeze metadata, relational content-approval history, persisted lifecycle corruption and reordered proofs. One relational test initially duplicated its analysis setup and was corrected before production changes.
- Added one paired lifecycle validator used on every accepted next checkpoint and every exact-revision reload. It requires explicit `outline`/`slideSpecs` slots and bidirectionally binds workflow, draft/frozen status, freeze time, detail availability, proof count/order, hashes and saved skill identity.
- First enable now rejects prior frozen/inconsistent outlines, preserves an existing unfrozen outline, requires the submitted outline to be draft with null `frozenAt`, and forbids details before saved joint outline approval.
- First enable now checks relational `outline_review`/`detail_review` history inside the immediate replacement transaction, so public approval inserts cannot be silently deleted during opt-in.
- Added corrupt slot/status/time/workflow/order reload cases and a next-commit case proving corrupt prior state fails closed.
- Focused GREEN: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test presales_storage` passed 14/14 tests.
- Final formatting check passed. Final `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` passed 91/91 tests with no doc-test failures.

## Proof-ID re-review fix after `113d32c`

- RED: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test presales_storage reload_and_next_commit_reject_pipeline_proof_id_divergence` failed because changing only the pipeline approval ID was accepted on reload and by the prior-checkpoint path.
- The ordered lifecycle check now compares the ID returned by exact approval validation with the append-only binding's `approval_id`.
- The regression covers both exact-revision reload and a subsequent paired commit from the corrupted state.
- Focused GREEN: the `presales_storage` suite passed 15/15 tests.
- Final formatting check passed. Final full Rust suite passed 92/92 tests with no doc-test failures.

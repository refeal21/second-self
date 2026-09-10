# Task 1 Report: Isolated durable queue admission

## Status

Implemented the standalone future-v3 SQLite queue admission boundary on branch
`codex/presales-batch-review`. The queue is exported as a Rust module but is not opened,
managed, or registered by the live Tauri application. No legacy database, WorkbenchService,
provider, account, customer data, UI, notification, audio, or external model path was used.

## Files

- `apps/desktop/src-tauri/src/lib.rs` — exports `presales_queue` only.
- `apps/desktop/src-tauri/src/presales_queue/mod.rs` — public module surface.
- `apps/desktop/src-tauri/src/presales_queue/contracts.rs` — typed camelCase JSON contracts and snake_case status enum.
- `apps/desktop/src-tauri/src/presales_queue/store.rs` — isolated schema, validation, persistence, replay/dedup, and admission.
- `apps/desktop/src-tauri/tests/presales_queue.rs` — 15 synthetic behavioral/integrity tests.

## Public API

The requested public types are present: `VersionHash`, `ImageReference`, `QueueTarget`,
`EnqueueJob`, `EnqueueBatch`, `JobStatus`, `QueueSettings`, `QueueJob`, `ProviderIdentity`,
`StagedResult`, and `EnqueueOutcome`. All derive `Clone`, `Debug`, `PartialEq`, `Serialize`,
and `Deserialize`; leaf types also derive `Eq`. Struct JSON uses camelCase with unknown-field
denial, and `JobStatus` uses snake_case.

`QueueStore` is intentionally non-Clone and exposes only:

```text
open
open_in_memory
settings
set_concurrency
set_paused
set_batch_paused
enqueue
list_jobs
get_job
claim_next
```

Its `rusqlite::Connection` is visible only within the parent module for the future Task 2
lifecycle implementation; there is no public raw connection getter.

## Behavior and storage

- Owns only SQLite files marked `application_id = 0x44545133` and `user_version = 1`.
- Inspects markers and existing user tables before WAL or schema mutation, initializes only an
  empty unowned database, and rejects foreign, future, incomplete, or index-damaged schemas.
- Enables foreign keys, a 5000 ms busy timeout, WAL for file-backed stores, and synchronous FULL.
- Persists queue settings, immutable batch input, jobs, immutable attempts, batch outcome
  mappings, target snapshots, status fields, reserved provider/result columns, and transition
  events.
- Uses a partial unique active-page index for queued/dispatching/running/result_ready/
  committing/cancel_requested/outcome_unknown.
- Validates all identifiers, byte limits, hashes, reference uniqueness, batch uniqueness and
  size, NUL exclusion, and the 128 KiB serialized target ceiling before mutation.
- Reserves every submitted request/attempt identity in a batch mapping before page dedup can
  hide a collision.
- Exact batch replay compares the complete typed input and rehydrates its original output
  mapping from current job rows, preserving timestamps and current status without creating or
  rewriting work.
- Claims under an IMMEDIATE transaction by global sequence, epoch, global/batch pause, and
  global slot accounting, then durably records Dispatching plus the transition before return.
- Native checked epoch-millisecond timestamps are written on insert and claim; sequence remains
  the sole FIFO authority.

## TDD evidence

### Initial RED: missing module

Command:

```text
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test presales_queue
```

Result: exit 101.

```text
error[E0432]: unresolved import `digital_twin_desktop_lib::presales_queue`
 --> tests/presales_queue.rs:1:31
  |
1 | use digital_twin_desktop_lib::presales_queue::{
  |                               ^^^^^^^^^^^^^^ could not find `presales_queue` in `digital_twin_desktop_lib`
error: could not compile `digital-twin-desktop` (test "presales_queue") due to 1 previous error
```

### Behavioral RED after minimal declarations

Command:

```text
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test presales_queue
```

Result: exit 101. The minimal declarations emitted one honest dead-code warning for the unused
stub connection. The suite ran 14 tests: 2 passed and 12 failed on the deliberate
`"queue schema is not implemented"` result or the absent marker.

```text
warning: field `connection` is never read
running 14 tests
test result: FAILED. 2 passed; 12 failed; 0 ignored; 0 measured; 0 filtered out
error: test failed, to rerun pass `--test presales_queue`
```

### Self-review RED: missing admission-index verification

Command:

```text
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test presales_queue identified_database_missing_the_admission_index_is_rejected -- --exact
```

Result: exit 101.

```text
running 1 test
test identified_database_missing_the_admission_index_is_rejected ... FAILED
assertion failed: QueueStore::open(&path).is_err()
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 14 filtered out
```

The minimal fix verifies the stored unique partial-index definition before configuring an
identified database.

### Final focused GREEN

Command:

```text
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test presales_queue
```

Result: exit 0, no warnings.

```text
running 15 tests
test result: ok. 15 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.04s
```

This final focused command was rerun after formatting and produced the same 15/15 result.

## Full verification

The default complete Rust suite was run exactly once, as requested.

Command:

```text
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Result: exit 0, no warnings. Across the library and integration targets, 119 tests passed,
0 failed; doc tests also passed (0 tests). The queue target itself reported 15/15.

Formatting and diff checks:

```text
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
git diff --check
```

Combined result: exit 0 with no output.

## Self-review and concerns

Mutation checks cover a wrong limit, wrong FIFO order, missing pause behavior, stale replay,
rewritten target, missing rollback, identity collision hidden by dedup, wrong epoch mutation,
foreign DB mutation, missing active-page index, missing persisted Dispatching, and missing native
dispatch timestamp. The multi-connection limit test uses four independently opened real SQLite
connections synchronized by a barrier and no sleeps or mock assertions.

Task 2 must remain responsible for epoch establishment and lifecycle transitions after
Dispatching. It may extend the v1 schema and its verification list in the same future-v3 module,
and must update job/event timestamps atomically. This task intentionally provides no generic
status setter and no completion, publication, approval, filesystem-staging, or provider API.

## Abandoned RED-process cleanup

One pre-fix focused run timed out while the barrier race test was active. The new schema-index
check initially rejected a worker connection before that worker reached the barrier, so the cargo
process and remaining test participants continued waiting after the command harness returned.
This was a test-harness defect, not a successful run: the race test was changed to open all four
connections before spawning or entering the barrier, so setup failures now fail promptly.

After the final verification, a read-only process check found the abandoned processes as cargo
PID 5194 and its `presales_queue` child PID 5234, both rooted in this exact worktree. Both were
sent targeted `SIGTERM` and a subsequent `ps` check returned no matching processes. No user app
or unrelated process was stopped. The later focused 15/15 and full 119/119 results documented
above were separate completed runs and remain valid.

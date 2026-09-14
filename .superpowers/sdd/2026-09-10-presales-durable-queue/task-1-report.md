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

## Review fix round 1: schema ownership preservation

The two Important review findings reproduced against `b112f56`:

1. `NOT LIKE 'sqlite_%'` treated `_` as a wildcard and hid a foreign table named
   `sqliteXlegacy`, allowing the queue to claim and mutate that database.
2. Recognized databases with the expected names/columns but missing PK, UNIQUE, FK, or CHECK
   constraints were accepted; lowercasing the whole index DDL also accepted `'QUEUED'` as if it
   were the required lowercase status literal.

Three real-SQLite preservation regressions were added before production changes. They snapshot
markers, journal mode, and schema objects and verify that rejection makes no changes. The
constraint test independently removes one required primary key, unique constraint, foreign key,
and check constraint from otherwise matching marked schemas.

RED command:

```text
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test presales_queue
```

RED result: exit 101, no warnings.

```text
running 18 tests
test marked_databases_missing_required_constraints_are_rejected_without_mutation ... FAILED
test marked_database_with_uppercase_status_predicate_is_rejected_without_mutation ... FAILED
test sqlite_prefix_lookalike_table_is_preserved_as_foreign ... FAILED
test result: FAILED. 15 passed; 3 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.04s
```

The fix now detects user tables with a literal, case-insensitive `sqlite_` prefix comparison.
Seven canonical DDL definitions are the single source for both initialization and verification.
Schema comparison removes insignificant whitespace and folds SQL syntax/identifier case only
outside string literals, preserving the exact lowercase status predicate semantics.

Final GREEN/check command:

```text
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
git diff --check
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test presales_queue
```

GREEN result: exit 0, no warnings.

```text
running 18 tests
test result: ok. 18 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.04s
```

A post-run process check found no lingering cargo or `presales_queue` test process from this
worktree. The earlier PIDs 5194/5234 cleanup remains fully documented in the preceding section;
this fix round introduced no additional leak.

## Review fix round 2: SQL token boundaries

The scoped re-review found that fix round 1 still removed every whitespace character outside
string literals. That made `INTEGER PRIMARY KEY` and SQLite's non-constraint type spelling
`INTEGER PRIMARYKEY` compare equal, so a marked schema without the required primary key could
still be accepted.

A real marked-database preservation regression was added first. It replaces the first
`PRIMARY KEY` with `PRIMARYKEY`, creates the schema through SQLite, and asserts that `QueueStore`
rejects it without changing markers, journal mode, or schema objects.

RED command:

```text
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test presales_queue marked_database_with_merged_primary_key_tokens_is_rejected_without_mutation -- --exact
```

RED result: exit 101, no warnings.

```text
running 1 test
test marked_database_with_merged_primary_key_tokens_is_rejected_without_mutation ... FAILED
mutation merged-primary-key-tokens was accepted
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 18 filtered out; finished in 0.01s
```

The minimal fix replaces whitespace deletion with SQL tokenization. ASCII word tokens are
case-folded individually, punctuation remains distinct, and complete single-quoted literals are
preserved exactly (including escaped quotes). Consequently layout and SQL keyword case remain
insignificant while keyword boundaries and literal status semantics cannot collapse.

Exact regression GREEN command:

```text
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test presales_queue marked_database_with_merged_primary_key_tokens_is_rejected_without_mutation -- --exact
```

Result: exit 0, no warnings; 1 passed, 0 failed, 18 filtered out.

Final focused/check commands:

```text
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
git diff --check
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test presales_queue
```

Result: exit 0, no warnings.

```text
running 19 tests
test result: ok. 19 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.04s
```

Self-review covered merged word tokens, whitespace around punctuation, SQL keyword/identifier
case, exact quoted status literals, and escaped single quotes. Noncanonical comment or quoting
forms fail closed, which is acceptable for the owned v1 schema. A post-run process check found
no lingering cargo or `presales_queue` test process from this worktree; the original 5194/5234
cleanup remains the only leak event.

## Review fix round 3: SQLite whitespace semantics

The scoped re-review found that Rust `char::is_whitespace()` still merged tokens across Unicode
separators that SQLite does not recognize as SQL whitespace. In particular,
`PRIMARY\u{00a0}KEY` was tokenized like `PRIMARY KEY` by the verifier, while SQLite stored it as
the column type `INTEGER PRIMARY\u{00a0}KEY` with `pk=0` and allowed duplicate singleton values.

A focused in-memory SQLite DDL probe established the separator behavior on this build before the
fix:

```text
HT status=0 result=0|id|INTEGER|0||1
LF status=0 result=0|id|INTEGER|0||1
VT status=1 result=Parse error ... unrecognized token
FF status=0 result=0|id|INTEGER|0||1
CR status=0 result=0|id|INTEGER|0||1
SPACE status=0 result=0|id|INTEGER|0||1
NBSP status=0 result=0|id|INTEGER PRIMARY KEY|0||0
```

A real marked-database preservation regression then replaced `PRIMARY KEY` with
`PRIMARY\u{00a0}KEY` and asserted rejection without any marker, journal-mode, or schema-object
mutation.

RED command:

```text
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test presales_queue marked_database_with_non_sqlite_unicode_whitespace_is_rejected_without_mutation -- --exact
```

RED result: exit 101, no warnings.

```text
running 1 test
test marked_database_with_non_sqlite_unicode_whitespace_is_rejected_without_mutation ... FAILED
mutation unicode-primary-key-separator was accepted
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 19 filtered out; finished in 0.01s
```

The minimal production fix replaces `char::is_whitespace()` with an explicit SQLite SQL
whitespace predicate containing only U+0009, U+000A, U+000C, U+000D, and U+0020. It deliberately
does not use `char::is_ascii_whitespace()`, which would also admit U+000B even though SQLite
rejects vertical tab here.

Exact regression GREEN command:

```text
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test presales_queue marked_database_with_non_sqlite_unicode_whitespace_is_rejected_without_mutation -- --exact
```

Result: exit 0, no warnings; 1 passed, 0 failed, 19 filtered out.

Final focused/check commands:

```text
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
git diff --check
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test presales_queue
```

Result: exit 0, no warnings.

```text
running 20 tests
test result: ok. 20 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.04s
```

Self-review confirms canonical schema spaces/newlines still compare normally, all five supported
SQLite separators preserve token boundaries, and non-SQLite Unicode/control separators remain
distinct tokens or fail closed. A post-run process check found no lingering cargo or
`presales_queue` test process from this worktree; the original 5194/5234 cleanup remains the only
leak event.

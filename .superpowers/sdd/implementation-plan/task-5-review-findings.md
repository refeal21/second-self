# Task 5 independent review findings

Verdict: REJECT. Task 5 does not yet satisfy MVP production acceptance. The Golden runner is an independent in-process path rather than the packaged production Tauri path.

## P0 — production PPT workflow is not connected

- `apps/worker/src/sidecar-rpc.ts:84-117`: packaged Worker only exposes health, capabilities, transition, checkpoint validation and test crash.
- `apps/desktop/src/workflow-worker-client.ts:4-12,57-63`: UI gateway only defines/calls `health()`.
- `apps/desktop/src/desktop-adapter.ts:283-334`: native PPT operations bypass the real Worker and call a simplified Rust state machine.
- `apps/desktop/src-tauri/src/tauri_workbench.rs:84-92`: export always returns an error.
- Native UI has no material upload, parsing/analysis, whole-outline review, whole-deck detail review, ImageGen/visual replacement, real export or QA path. It opens hard-coded five-page visual review.
- `apps/desktop/src/App.tsx:1112-1115,1256-1293,1349-1378`: production renders fabricated completed timeline, source files and fixed slide content. This violates no demo false-success.

## P1 — restart recovery only persists a simplified state

- Real `PptProjectService` stays in an in-memory `Map` and is not in the packaged Worker.
- SQLite stores only stage/progress/selected slide/five slide statuses. `versions`, `tasks`, `artifacts` remain effectively unused.
- Native approvals do not persist version/spec/visual hashes and provenance.
- `checkpoint.recover` validates caller-supplied stage prefixes; it does not rehydrate authoritative SQLite/project artifacts.
- Restart tests only reopen Rust `WorkbenchService`; they do not restart Worker and recover outline/spec/visual versions/export state.
- Preference snapshot creation is tested, but the production app has no AI preference-proposal workflow.

## P1 — secure write boundary is not used by production artifacts

- Rust fd/`renameat` safe writer in `paths.rs:69` is only exercised by tests.
- Project directories use ordinary path `fs::create_dir` in `workbench.rs:550`.
- Golden/PPTX artifacts are written by Node. `workspace-artifacts.ts:129` checks paths, creates a temp file, checks again, then `link()` without holding the parent directory fd; parent replacement between final check and link remains a TOCTOU window.
- Existing tests cover already-present symlinks, not concurrent parent replacement.

## P1 — automatic QA does not match documented acceptance

- `libreoffice-qa.ts:171`: comparator only detects near-blank pages; it does not accept approved visuals or calculate visual difference.
- `libreoffice-qa.ts:445`: final checks cover only page count and blank pages.
- No implemented automatic check for missing fonts, object bounds/crop, missing OOXML relationships/resources or similarity against approved PNG.
- `libreoffice-qa.ts:546`: `textReportPath` incorrectly points at JSON.
- `docs/qa.md:31`: documented `qa/run-1/qa-report.json` does not exist.

## P1 — Golden source and visuals are invalid as evidence

- `fixtures/golden-project/sources/kpis.csv` contains only 2025 actual, 2026 target, 2026 actual.
- `golden-project.ts:503` invents `2027 计划 = 150` while citing the existing KPI source.
- All five visual approvals use the same background PNG. Only slide 5 embeds it; first four treat it as reference. This does not prove five distinct full-slide visual approvals, text clearing or render similarity.

## P2 — configured Codex path is ignored

- Settings persist the path, but `desktop-adapter.ts:368` always constructs `new TauriCodexTransport(null)`. The required precedence configured path → PATH → ChatGPT-bundled path is ineffective.

## P2 — bundled Node license material is incomplete

- SEA embeds a complete Node executable, but the app notice only links to upstream and includes generic MIT text. Bundle the matching Node distribution license and third-party notices inside the app.

## Verified and not findings

- Baseline typecheck/lint/tests/Rust fmt/diff check pass.
- Fresh Golden runner and LibreOffice render 5/5 pass, slides_test reports no overflow, PPTX has editable OOXML and exact spec text.
- Fresh `.app` builds; both binaries are arm64; malformed/unknown Worker RPC survives; live Codex initialize/account/read returns Pro without a turn.
- No API key, billed REST fallback or production TCP listener found.
- ImageGen unavailable, Keynote not manually checked and PowerPoint unavailable are correctly disclosed.

## Evidence requiring strengthening

- Memory reports sum root+descendant RSS but do not record PID-to-command mapping or a user-operation timeline, so they do not independently prove the connected idle and one-project scenarios.
- Worker crash/generation tests cannot prove real project recovery until the production Worker owns/reconstructs real PPT workflow state.
- Strict deep app signature verification fails; unsigned/ad-hoc is in scope, so this is not itself blocking.

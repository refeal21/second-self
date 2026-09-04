# Task 5 implementation report

## Final Task 5 integration report

Status: Task 5 engineering and automated acceptance are implemented and verified. Live ImageGen remains unavailable in this local Codex environment, so native visual regeneration stays at an explicit recoverable checkpoint with no billed fallback. Keynote open/edit is intentionally a documented human check, not an automated claim.

### Delivered

- A versioned newline-delimited Worker JSON-RPC CLI for health, capabilities, legal workflow transitions, and validated checkpoint recovery. Malformed and unknown requests return protocol errors without ending the process.
- A repeatable host-triple Node SEA build that produces an arm64 Mach-O Tauri `externalBin` sidecar. The packaged Worker has no separately installed Node.js runtime dependency.
- Rust ownership of Worker lifetime and stdin/stdout/stderr/exit bridging through `tauri-plugin-shell`, including monotonic generations, stale-generation rejection, controlled stop, termination cleanup, and restart after crash.
- Rust-owned SQLite persistence for projects, settings, approvals, memory proposals, immutable per-project preference snapshots, and full workflow checkpoints.
- A real Unix/macOS workspace write boundary using directory handles, `O_NOFOLLOW`, atomic replacement, and file/directory durability barriers.
- Tauri commands for native state hydration, project creation/rename/workflow mutations, approval/memory decisions, and settings. Export remains an explicit unavailable error until 5B produces a verified delivery bundle.
- Production-only native hydration. Browser fixtures remain demo-only and cannot replace persisted native data.
- Explicit unavailable ImageGen capability and project error with no billed API fallback.

### Test evidence

- `pnpm typecheck`: green.
- `pnpm lint`: green.
- `pnpm test`: core 8/8, Worker 154/154, desktop 45/45, Rust integration 17/17; all green.
- `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check`: green.
- `pnpm --filter desktop build`: green; embedded Vite assets produced.
- `pnpm build:worker-sidecar`: green; produced `digital-twin-worker-aarch64-apple-darwin` as a 106 MiB arm64 Mach-O executable.
- Direct SEA stdin smoke returned `system.health = { protocolVersion: 1, status: "ready" }` with exit code 0.
- `git diff --check`: green.

### RED to GREEN record

- Worker protocol tests first failed because no CLI/RPC boundary existed; implementation made 5 unit and 2 real-child integration cases pass.
- Persistence/restart and actual-write boundary tests first failed against the schema-only database and string-only path guard; SQLite checkpoints/preferences and the atomic writer made them pass.
- Native hydration initially regressed two UI tests by reloading complete demo state during user input; hydration is now limited to Tauri mode and desktop returned to 45/45.
- The first SEA attempts exposed a top-level-await CommonJS error, a macOS injected-segment crash, and a bundled shebang syntax error. The final build uses an explicit `main()`, the `NODE_SEA` Mach-O segment, and bundle output without an injected banner/shebang.

## 5B Golden Project and packaging

### Delivered

- A deterministic five-page Chinese management-report fixture with PDF, CSV, text-free PNG and visual-reference PPTX sources. The generator normalizes ZIP dates; two consecutive generations produced the same PPTX SHA-256, and the committed manifest binds every source hash and byte length.
- A complete production workflow run with four explicit negative skip checks, full-deck outline approval, full-deck detail approval, five sequential visual approvals, real editable PPTX export and a completed delivery receipt.
- OOXML assertions for exact approved Chinese, independent text/basic-shape/table/chart/picture objects, chart relationship data, and a single copy of the approved cover title.
- macOS headless LibreOffice font discovery through project-local Fontconfig and `Hiragino Sans GB`. All five rendered pages were visually inspected after fixing the initially observed square-glyph failure.
- Source mapping, JSON QA and readable QA reports plus five approved visual PNGs under ignored `artifacts/qa/` output.
- A production Tauri-to-Worker JSON-RPC health client with chunk reassembly, protocol validation, process-exit rejection and next-call restart. The main-window ACL permits only event listen/unlisten.
- An unsigned/ad-hoc Apple Silicon `.app` containing both arm64 executables. It launches from embedded frontend assets with an embedded ~106 MiB Worker and no separately running Vite/Node process.
- Root README, architecture, run/build, QA, troubleshooting and third-party notices. Documentation states the unsigned/not-notarized boundary, sleep behavior, Keynote manual check and lack of PowerPoint verification.

### RED to GREEN record

- Golden tests began without fixtures or a workflow runner. The implementation made fixture hashing, approval guards, OOXML structure and five-page LibreOffice QA pass.
- LibreOffice first rendered Chinese as square boxes despite passing page-count checks. The exporter/fontconfig fix made every inspected page legible.
- Tauri's first bundled launch rejected `event|listen` by ACL, preventing the Worker health handshake. A minimal main-window capability fixed the real `.app` launch; App and embedded Worker remained stable.
- The native adapter was initially recreated on each React render and continuously restarted owned children. A component-lifetime adapter instance fixed it; desktop regression tests remained green.
- Native string errors were collapsed to a generic UI error. The UI now preserves Tauri's explicit unavailable/blocking reason.
- The initial memory sampler incorrectly called `reduce` on a `Set`; the corrected sampler was rerun for both evidence windows.

### Final evidence

- `pnpm typecheck`: green across core, Worker and desktop.
- `pnpm lint`: green across core, Worker and desktop.
- `pnpm test`: core 8/8; Worker 156/156; desktop 49/49; Rust integration 17/17; all green.
- `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check`: green.
- `pnpm golden:qa`: `completed`, four skip guards true, LibreOffice 5/5, no blank pages/issues, 0 repair rounds.
- `pnpm --filter @digital-twin/desktop tauri build --bundles app`: green.
- Bundle inspection: 124 MiB `.app`; main and Worker are arm64 Mach-O; `Signature=adhoc`; `TeamIdentifier=not set`.
- Live read-only app smoke: embedded Worker `system.health=ready`; Codex selected the ChatGPT application binary, completed `initialize` + `account/read`, and returned the local Pro plan without `thread/start` or `turn/start`.
- RSS process-tree sampling at 100 ms: 224.2 MiB connected idle peak; 223.4 MiB one-project create/open peak; both below 4096 MiB.
- Runtime `lsof` found no TCP socket/listener for app, Worker or owned Codex child. Repository and bundle scans found no `OPENAI_API_KEY` or `api.openai.com`.
- `git diff --check`: green.

### Artifacts

- `.app`: `apps/desktop/src-tauri/target/release/bundle/macos/Digital Twin Workbench.app`
- PPTX: `artifacts/qa/golden-project/golden-project/exports/golden-management-report.pptx`
- source map: `artifacts/qa/golden-project/golden-project/exports/source-map.json`
- readable QA: `artifacts/qa/golden-project/golden-project/qa/qa-summary.txt`
- JSON QA: `artifacts/qa/golden-project/golden-project/qa/qa-round-1.json`
- rendered pages: `artifacts/qa/golden-project/golden-project/qa/run-1/rendered-1.png` through `rendered-5.png`
- memory reports: `artifacts/qa/memory-idle.json` and `artifacts/qa/memory-one-project.json`

### Explicit residuals

- The current local Codex capability report does not expose ImageGen. Native visual regeneration therefore returns the tested Chinese blocked state and persists the current visual-review checkpoint; it never swaps to an API-key/billed client.
- The native UI exports only a project with a verified delivery artifact. In the unavailable-ImageGen environment, it reports that no verified artifact exists; the Golden runner is the automated proof of the real exporter/QA path.
- Keynote is installed but the human open/edit checklist in `docs/qa.md` remains to be performed by the user. Microsoft PowerPoint compatibility is unverified.

## 5C production pipeline correction

The rejected implementation has been replaced on the production path. The packaged Worker now owns the real versioned PPT workflow aggregate and exposes create/restore/snapshot/execute JSON-RPC methods. The Tauri adapter restores the authoritative SQLite snapshot before every action and commits the resulting snapshot plus artifact write intents through Rust. Production no longer calls the simplified Rust slide state machine and no longer renders the fabricated timeline, sources or slide content; the browser-only demo remains isolated.

The native workspace now provides user-selected material attachment, Codex source analysis without network permission, whole-deck outline generation/edit/approval, whole-deck slide-spec generation/edit/approval, sequential ImageGen requests, explicit recoverable ImageGen-unavailable state, user PNG replacement, per-page approval/reopen, editable PPTX export, and an honest pending-QA state. Approved preference snapshots are copied into the aggregate. AI can propose a reusable preference, but it stays only a pending proposal until the user approves it in the memory center.

SQLite durably stores the full aggregate and synchronized versions, approvals with version/slide provenance, task records, artifacts and complete checkpoints. A fresh Worker process restores outline/spec/visual histories, approvals, sources, hashes, export receipt and preference snapshot. Every production artifact is length/SHA-256 checked and written by Rust through held workspace/project directory fds; stale Worker results are rejected before bytes can overwrite newer artifacts. Project-tree creation uses the same fd-relative boundary and has a deterministic concurrent parent-replacement regression test.

The saved Codex binary path is applied as the first resolution candidate immediately. Changing it safely stops the active App Server generation so the next connection starts the configured binary, without restarting the desktop app.

5C verification before commit: repository typecheck/lint and all suites green (core 8, Worker 159, desktop 52, Rust 19 at this checkpoint); packaged 106 MiB arm64 SEA rebuilt and directly executed native project create/snapshot. Task 5D remains responsible for production LibreOffice QA comparison/check expansion, corrected Golden sources/distinct visuals, complete bundled Node license evidence and strengthened process-memory timeline.

## 5D production QA, corrected Golden evidence and final package

Status: implemented and verified against every finding in `task-5-review-findings.md`.

### Production QA path

- The native UI exposes an honest QA action only at the QA/recoverable-QA checkpoint. `TauriDesktopAdapter.runProjectQa` asks Rust to prepare a local LibreOffice render, sends that preparation to the supervised Worker `deck.qa` action, and returns the Worker snapshot/write intents to Rust for atomic persistence.
- Rust validates and re-hashes the persisted PPTX and all five ordered approved visuals, resolves executable `soffice`/`pdftoppm` files, and renders only in an isolated temporary directory outside the workspace. Each process runs in its own process group with a 30-second timeout, TERM/KILL fallback and 16 KiB captured-output ceiling; PPTX/PDF/page inputs and outputs also have byte limits. PDF, rendered PNGs and text/JSON reports cross the existing length/SHA-bound write-intent interface and are committed through held fds with `O_NOFOLLOW` and atomic replacement.
- The Worker rejects stale or inconsistent export/spec/visual provenance. Completion requires exact page count, nonblank pages, available fonts, no missing OOXML relationships/resources, no out-of-bounds objects, no invalid crop, and a per-page normalized RGB difference of at most `0.6` against that page's distinct approved full-slide PNG.
- `textReportPath` is a readable `.txt` file; `jsonReportPath` is a separate structured `.json` file. A QA failure persists a recoverable blocked checkpoint with actionable issues and retry count.

### Golden and restart evidence

- The deterministic KPI source now explicitly contains `2027计划 = 150`; every assertion/data point cites an analyzed fixture source.
- Five byte-distinct 1280×720 full-slide PNGs are approved sequentially. Golden QA reports differences `0.023563`, `0.019064`, `0.024678`, `0.024501`, and `0.045109` respectively, all below `0.6`.
- The real child-process integration creates the five-page project through newline JSON-RPC, completes analysis/whole-deck outline and detail approvals, kills the Worker, restores the complete revision into a fresh Worker, approves five visuals in order, exports, and completes `deck.qa`.
- The separately rebuilt `.app` Worker smoke reaches `completed`, restores revision 18 after restart, proves five distinct approvals and emits PDF, five rendered PNGs, and both reports. This smoke invokes the exact embedded arm64 SEA rather than `tsx`.

### Final verification evidence

- `pnpm test`: core 8/8; Worker 162/162; desktop 53/53; Rust unit/integration 21/21.
- `pnpm typecheck`, `pnpm lint`, Rust formatting and `git diff --check`: green.
- `pnpm golden:qa`: completed, 5/5 pages, all skip guards true, no issue/blank/bounds/crop/missing-resource finding, zero repair rounds.
- Presentations `slides_test.py`: passed with no overflow.
- `pnpm --filter @digital-twin/desktop tauri build --bundles app`: green. Bundle size 125 MiB; both executables are arm64 Mach-O; `Signature=adhoc`; `TeamIdentifier=not set`.
- `pnpm smoke:packaged-worker`: completed all production Worker stages and restart recovery; maximum visual difference `0.045109`.
- The bundle carries the exact 143,299-byte license from its Node v22.21.1 SEA build executable, including dependency/third-party notices, plus an exact `VERSION.txt`.
- Latest-bundle release memory evidence: the persisted project was created through the real native UI, the app was restarted, the project reopened, then root+descendants were sampled every 100 ms for 8 seconds. `artifacts/qa/memory-one-project-v2.json` records 60 `one-project-open` samples, PID/PPID/RSS/full commands, a `130.6 MiB` peak, and a passing 4096 MiB gate.
- `lsof` found no TCP listener for the latest-bundle main/Worker PIDs. Repository and executable string scans found neither `OPENAI_API_KEY` nor `api.openai.com`.

### Final artifacts

- `.app`: `apps/desktop/src-tauri/target/release/bundle/macos/Digital Twin Workbench.app`
- editable PPTX: `artifacts/qa/golden-project/golden-project/exports/golden-management-report.pptx`
- source map: `artifacts/qa/golden-project/golden-project/exports/source-map.json`
- readable QA: `artifacts/qa/golden-project/golden-project/qa/qa-round-1.txt`
- structured QA: `artifacts/qa/golden-project/golden-project/qa/qa-round-1.json`
- rendered pages: `artifacts/qa/golden-project/golden-project/qa/run-1/rendered-1.png` through `rendered-5.png`
- memory: `artifacts/qa/memory-one-project-v2.json`

### Honest residuals

- This Codex environment does not expose ImageGen. The production flow therefore proves the required recoverable block and user-replacement continuation; there is no API-key or paid fallback.
- Keynote is installed, but the human open/edit checklist remains for the user. Microsoft PowerPoint compatibility was not tested.
- The personal `.app` is ad-hoc/unsigned and not notarized, exactly as scoped; strict deep signature verification is not claimed.

## 5E fix round 2 — authoritative final acceptance

This section supersedes the rejected packaged-E2E and operation-timeline claims above. The earlier `memory-one-project-v2.json` proves only its identically labelled steady-state window; it is not evidence for project creation or restart peaks.

### Restore and action boundary

- `ppt.project.restore` now parses and validates the complete aggregate before replacing process state: exact schema, project/preference/source metadata, source-analysis file/hash/provenance, outline and detail version order, visual history and hashes, approval-to-frozen-version bindings, tasks, checkpoint, blocked state, export receipt and QA provenance, plus legal replay and cross-field stage invariants.
- A forged `completed` snapshot is rejected as JSON-RPC invalid params and the prior aggregate is byte-for-byte unchanged. Recursive canonical JSON hashing also makes Rust `serde_json` key-order normalization safe across SQLite restart.
- The JSON-RPC action boundary is an explicit discriminated union with exact allowed keys and nested value validation. Unknown or malformed actions return invalid params. The runtime also has a rejecting exhaustive default before task creation or revision increment.
- Packaged SEA regressions exercise forged restore, unknown action, malformed action and deleted task history with forged revision against the exact Worker embedded in the final `.app`, and assert atomic revision/state preservation.

### Whole-deck editing

- Saving an edited outline at `outline_review` now updates the expected mutable draft without trying to replay past the existing draft. Approval still freezes that version and cannot be skipped.
- Worker and production UI tests both execute generate → edit → save → approve for the whole outline and the equivalent whole-deck detail document.

### Deterministic packaged production harness

The authoritative harness uses the real `createTauriDesktopAdapter`, compiled Rust Workbench functions shared by Tauri commands, persisted SQLite with process reopen, the final `.app` embedded SEA over newline JSON-RPC, Rust hash-bound held-fd artifact writes, and real LibreOffice/pdftoppm export QA. Only Codex structured generation is scripted to make the run deterministic and free of model-turn spending.

The run creates and attaches Golden inputs, executes source analysis, edits and approves the whole outline and detail deck, restarts Rust/SQLite and Worker, restores the complete checkpoint, records an honest ImageGen-unavailable block for every slide, continues through five user-uploaded distinct replacements and sequential approvals, exports, runs QA, restarts again and reopens the completed project. The result records revision `29`, workflow `completed`, five comparison pages with maximum normalized difference `0.106718`, and SQLite counts of 7 versions, 7 approvals, 12 tasks and 23 artifacts.

### Operation and memory evidence

The native macOS libproc sampler receives timestamped harness events and samples immediately at create, open, quit/close, Rust+SQLite+Worker restart, reopen and stable-window boundaries, as well as the intervening workflow operations. Its latest 64 samples list PID/PPID/RSS/executable path for Node, compiled Rust harness, sampler, `.app` embedded SEA, LibreOffice and pdftoppm. The conservative full-harness peak is `480.5 MiB`, below the `4096 MiB` target. This is not presented as a GUI-only idle-RSS measurement.

### Authoritative artifacts

- production result: `artifacts/qa/production-harness/result.json`
- operation/RSS evidence: `artifacts/qa/production-harness/memory.json`
- editable PPTX: use `result.json` → `exportPath` because the production project ID is generated per run
- readable QA: use `result.json` → `readableReportPath`; the adjacent `qa-round-1.json` is the structured report

### Fresh verification after the final bundle

- TypeScript typecheck and ESLint are green for core, Worker, desktop and the production harness script.
- Vitest is green: core 8/8, Worker 165/165 and desktop 55/55. Rust unit/integration is 21/21; Rust formatting and release harness-bin checks are green.
- Fresh Golden QA is `completed`, 5/5, all skip guards true, five distinct comparison paths, maximum difference `0.045109`, no issue/blank/font/bounds/crop/resource failure. Presentations `slides_test.py` reports no overflow for both Golden and production-harness PPTX files.
- Fresh SEA and `.app` builds are green. The 125 MiB app contains only the arm64 main and embedded Worker executables in `Contents/MacOS`; their source/bundle Worker SHA-256 values match. Signature is ad-hoc with no TeamIdentifier.
- The final embedded SEA smoke reaches `completed` and rejects forged restore, unknown action and malformed action atomically. The final production harness result is `completed` at revision 29 with real SQLite restart, embedded-Worker restart and real LibreOffice/pdftoppm QA.
- The bundled Node v22.21.1 notice is byte-identical to the build runtime's 143,299-byte `LICENSE`, with exact `VERSION.txt`. Static source and executable scans find no `OPENAI_API_KEY`, `api.openai.com` or production HTTP listener implementation; Vite's documented `127.0.0.1:1420` remains development-only.
- `git diff --check` is green and no `.pnpm-store/`, root `tsx` dependency or lockfile churn is present.

### Residual boundaries

- Live ImageGen is unavailable, so the accepted production path persists a recoverable block and requires user replacement PNGs. There is no paid/API-key fallback.
- Codex generation is scripted only in deterministic acceptance. The existing live `initialize` + `account/read` smoke remains the read-only proof of local ChatGPT/Codex login and does not spend a model turn.
- Keynote open/edit remains the documented human check. PowerPoint compatibility, Developer ID signing and notarization are not claimed.

## 5F fix round 3 — task/revision provenance closure

The last P0 reproduced against a complete legal five-page `completed` snapshot: deleting all 12 task records and setting `revision=999` was accepted by the pre-fix restore path and could replace an existing same-ID aggregate. The RED regression now starts from that real legal history and also exercises revision-only forgery, a forged task-ID revision, and removal plus renumbering of a required task. Every case must return JSON-RPC invalid params and leave the prior completed aggregate structurally identical.

The validator now derives the allowed revision timeline from the whole aggregate instead of checking task record shapes independently. Task IDs must bind the project, task kind and exact positive revision; task revisions must be strictly increasing and phase-monotonic; persisted status/error combinations are constrained; required analysis, outline, detail, conversion and QA tasks must exist when their artifacts exist; and outline/detail approvals, visual candidate generation or replacement, visual approvals, reopen history, export and QA are counted as the corresponding legal actions. The only retained source-revision compatibility boundary is revision 2 for the legacy direct-source path or `source count + 2` for the Rust attachment path. Arbitrary offsets, missing task provenance and forged terminal revisions are rejected before the in-memory map is replaced. Approval IDs and freeze timestamps are also bound to their exact frozen versions.

Fresh focused TDD is green at 14 tests; the full Worker suite remains 165/165 with Worker typecheck and lint green. The final `.app` embedded SEA smoke reports `taskHistoryForgeryRejectedAtomically: true`. The rebuilt packaged production harness still accepts the genuine revision-29/12-task history, survives SQLite and Worker restart, and completes real LibreOffice/pdftoppm QA, proving the validator did not reject the legal production path. Latest operation evidence has 64 samples and a conservative `480.5 MiB` peak. This is structural cross-field provenance validation, not a cryptographically authenticated append-only log.

## 5G fix round 4/5 — revision-by-revision action replay

### RED and architectural ruling

The remaining P0 used the genuine production `completed` snapshot unchanged except for the final visual-generation task ID: `...-task-25-visual_generation` became `...-task-27-visual_generation`; aggregate revision stayed 29 and task count stayed 12. The round-3 phase-range validator accepted it even though revisions 13–27 already contain five blocked generations, five replacements and five approvals: after the fifth approval at revision 27 the state is conversion, so revision 27 cannot also be `visual.generate`. The same RED table moved each generation task into its immediately following replacement slot and moved the whole generation set into approval slots, proving this was an ordering defect rather than a magic-value defect.

The replacement is an explicit schema-v1 action replay model, not another range/count rule. It fixes every task-bearing action to the revision encoded in its ID, then walks every visual revision with three workflow states (`visual_review`, `blocked`, `conversion`) and four per-slide version states (`none`, `placeholder`, `candidate`, `frozen`). Persisted visual histories generate the only possible replacement/candidate, approval and reopen events. An iterative memoized search accepts only when one legal execution consumes every event, keeps the current slide legal at every action, and ends at the persisted workflow/current-slide checkpoint. Conversion and QA then continue from that exact replay endpoint; QA report round equals the QA-task count, only blocked QA tasks may precede a retry, and the terminal blocked error must match its recoverable condition.

No schema migration or action-journal field was introduced. Rust and SQLite already persist the aggregate as opaque canonical JSON, so retaining `schemaVersion: 1` preserves existing databases, direct-source snapshots, Rust-attached-source snapshots and the genuine revision-29 production checkpoint. `restore` still validates schema, cross-field evidence, action replay and semantic workflow replay before `Map.set`; Rust never receives a commit after a rejected Worker restore. A future cryptographically attributable audit log would require a schema upgrade, but it is not needed to prove that every persisted task revision corresponds to some legal state-machine action.

### Tests and release evidence

- TDD RED: `pnpm --filter @digital-twin/worker exec vitest run src/sidecar-cli.integration.test.ts` failed because the real rev29/12 snapshot with an interval-internal visual task revision was returned as a successful restore.
- Focused GREEN: `pnpm --filter @digital-twin/worker exec vitest run src/sidecar-cli.integration.test.ts src/native-pipeline.test.ts src/sidecar-rpc.test.ts` — 14/14. This includes exact `25→27`, five replacement-slot ordering forgeries, the full approval-slot permutation, forged QA round, atomic same-ID preservation, a legal reopen history, blocked→retry QA and fresh-Worker restore.
- `pnpm --filter @digital-twin/worker test` — 165/165; `pnpm typecheck` and `pnpm lint` — green; desktop — 55/55; Rust unit/integration/doc — 21/21; core — 8/8; Rust format check — green.
- Fresh `pnpm build:worker-sidecar` produced an arm64 Mach-O; `pnpm --filter @digital-twin/desktop tauri build --bundles app` rebuilt the final `.app` successfully.
- `pnpm smoke:packaged-worker` ran the embedded `.app` SEA, completed revision 29 with 12 tasks and five distinct visuals, rejected the exact `task-25→task-27` restore as invalid params, and preserved the prior completed aggregate byte-for-byte.
- The production harness rebuilt its release Rust binaries, restarted SQLite and Worker, reopened revision 12, completed real LibreOffice/pdftoppm QA at revision 29, then restarted/reopened the completed aggregate. Counts remain 7 versions, 7 approvals, 12 tasks and 23 artifacts; maximum difference is `0.106718`. The fresh memory window has 59 samples, peaks at `472.6 MiB`, and passes the 4096 MiB gate.
- Golden QA passed independently through the no-IPC Node loader: completed 5/5, all skip guards true, five distinct comparison paths, maximum difference `0.045109`, zero issues and zero repair rounds. The ordinary `pnpm golden:qa` wrapper hit a sandbox-only `tsx` Unix-socket `EPERM`; the same script and loader used by production acceptance exited 0.

### Residual risk

The schema-v1 aggregate proves structural legal executability, not which actor emitted an indistinguishable legal action and not cryptographic append-only history. The replay search is iterative and memoized to avoid recursive-stack failure; its state space grows with reopen permutations, although current production decks and the five-page acceptance remain small. Live ImageGen, Keynote/PowerPoint, signing and notarization boundaries are unchanged.

# Task 3 report — image-first PPT workflow and fix rounds 1–5

## Outcome

Task 3 now has one evidence-bearing workflow from attached project sources through validated analysis, frozen outline/specs, individually approved visual artifact versions, editable PPTX export, authentic LibreOffice QA, repair/checkpoint recovery, and the final `completed`/`blocked` transition. The production factory exposes the complete authorized business workflow while retaining all commit/block/resume authority in private fields and closures. Public arbitrary image/export/status mutation methods were removed. No API-key or model fallback path was added.

Fix commits:

- round 1: `d9d887dbce850ac8574b5b2c03f56a496638672c` (`fix: harden PPT evidence chain`);
- round 2: `251f166` (`fix: secure PPT composition and delivery recovery`).

## Fix-round 2 implementation

### Private production composition and complete facade

- Removed every exported symbol-based state mutation hook. The former analysis, visual, and delivery evidence modules now export no runtime authority, and project state, active operations, mutation callbacks, coordinator dependencies, and QA dependencies use ECMAScript `#private` fields or factory-local closures.
- `createProductionPptWorkflow` now wires and returns the complete production business facade: projects, source analysis, outline generation, SlideSpec generation, visual generation, and delivery. It internally constructs the workspace boundary, PptxGenJS exporter, exact Codex ImageGen adapter, local process runner, PNG comparator, and LibreOffice QA runner.
- Production QA attestation is a factory-local `WeakSet`. The factory invokes the captured real `LibreOfficeQa` implementation, whose execution/persistence methods and dependencies are private; public-run monkeypatches, guessed private names, arbitrary fake QA/command/comparator fields, and standalone fake QA instances cannot create a production proof.
- The adversarial production test recursively checks own/prototype keys and symbols, attempts arbitrary artifact writes and a deep-import source-analysis forgery, injects guessed delivery dependencies, and monkeypatches the public/legacy QA method names. None can mutate production project state or forge a pass.
- Capability block/resume mutations are private to the factory-captured visual coordinator. Resume always rechecks the exact `{ id: 'image_gen.imagegen', status: 'available' }` capability.

### Authoritative repair and checkpoint recovery

- Initial export creates a QA checkpoint bound to the frozen SlideSpec version, exact frozen visual versions, expected page count, current export receipt, reports, and next action.
- The authoritative delivery coordinator now executes round 1 QA, validates a repaired artifact under `exports/` with a new byte hash, atomically replaces the current receipt, and repeats QA. It permits at most two repair calls and three QA reports before blocking.
- A repair cannot change project/spec/visual bindings, use an absolute/traversal/backslash/non-PPTX path, report a stale or mismatched hash, or replace the current receipt before validation succeeds.
- A thrown QA run leaves the project at its existing `qa` checkpoint. A later `deliver` call resumes QA without returning to `conversion` or invoking the exporter again.
- QA persistence is one create-only JSON bundle containing both the machine-readable report and readable summary. If an interruption occurs after the bytes reached disk, a retry accepts only a byte-identical bundle; differing pre-existing bytes remain a failure.

### Remaining round-2 boundaries

- Source-analysis reservation now moves shared project state to `source_analysis` before request artifact I/O. Concurrent service instances cannot both stage artifacts; request-write failure rolls the workflow and reservation back, while approval/evidence write failures leave a retryable pre-commit state.
- Generated outline and slide citations are restricted to the exact citation set in completed validated analysis, rather than all attached sources.
- Workspace creation walks every existing absolute root component before any descendant creation and rejects a symlinked parent. macOS tests canonicalize the temporary base so `/tmp` itself does not invalidate the intended case.
- `LocalCommandRunner` uses a detached POSIX process group, TERM/KILL fallback, forced pipe settlement, and Buffer-based stdout/stderr byte limits. Tests cover multi-byte truncation and a descendant retaining pipes.
- Runtime validation first rejects non-string identifiers, validates nested table/chart/shape/citation types and dimensions, enforces page-local nested IDs and chart category/value lengths, and rejects non-finite or negative layout values.
- Generated visual bytes must decode as PNG. An AI-declared `usage`/`textFree` value alone is insufficient for embedding: the frozen visual approval must contain an explicit matching user audit; full-slide references remain excluded.

## Fix-round 1 implementation

### Artifact boundary

- Added one conservative identifier validator for project, source, request, slide, and version/entity identifiers. Empty, dot, traversal, separator, uppercase, whitespace, and non-ASCII identifiers are rejected.
- `LocalWorkspaceArtifacts` now rejects `.`/`..` path components before normalization and permits only the six fixed top-level directories: `sources/`, `outline/`, `slide-specs/`, `visuals/`, `exports/`, and `qa/`.
- Every existing path component is checked with `lstat`; symlinks replacing a fixed directory or appearing in nested components are rejected.
- Writes use a same-directory exclusive temporary file opened with `O_EXCL | O_NOFOLLOW`, `fsync`, and a create-only hard link to the final name. Existing frozen artifacts cannot be overwritten.
- Slide specs and image briefs are persisted together in one authoritative `slide-specs/slide-specs-v1.json` bundle, so state commits after one atomic artifact write rather than a partial multi-file batch.
- Read, list, project-directory, directory-creation, and path-resolution operations use the same checked boundary.

### AI provenance, identity, and concurrency

- Source analysis is now requested against an exact attached source set. Request records and explicit web-search decisions are persisted before state changes.
- Analysis is marked `running` before awaiting the gateway. A store shared by all `SourceAnalysisService` instances for one project service prevents duplicate execution.
- Gateway output is runtime-validated: findings, data points, citations, IDs, and all source references must match the requested attached source set. The resulting artifact/hash receipt binds project, request, source set, web-search decision, and output.
- Removed public `recordSourceAnalysis`; outline generation consumes only completed analysis evidence through `OutlineGenerationGateway`, and SlideSpec generation consumes only a frozen outline through `SlideSpecGenerationGateway`.
- Generated outline and SlideSpec schemas are checked at runtime. Outline slide IDs must be safe and unique; SlideSpec IDs must be an exact unique bijection with frozen outline IDs. Finding/data/source references must resolve.
- Project-scoped operation locks are owned by `PptProjectService`, so separate visual service instances cannot race. Durable workflow state is updated only after artifact writes succeed.
- Tests prove one page approval cannot satisfy a second page.

### ImageGen boundary

- Capability discovery now requires the exact `{ id: 'image_gen.imagegen', status: 'available' }` contract. Fuzzy names and `imagegen-disabled` are rejected.
- The Codex gateway no longer accepts an arbitrary constructor CWD. `VisualGenerationService` obtains the project CWD from the validated workspace-artifact boundary and supplies it per request.
- Capability absence is persisted as a recoverable project block containing the slide, reason, exact capability, and `resumeStage: 'visual_review'`. Resume succeeds only after exact capability restoration and preserves all earlier approvals.
- Arbitrary public image-byte mutation methods were removed; generated bytes enter project state only through the visual-generation evidence path. No API fallback exists.

### Export and QA evidence chain

- Added `PptDeliveryCoordinator` as the only workflow-advancing delivery path. It reads the frozen specs and current frozen visual versions, validates each visual artifact path, reads the artifact bytes, and constructs the exporter input itself.
- Editable copy, tables, chart data, shapes, and speaker-note citations come only from the frozen SlideSpecs. Approved full-slide reference PNGs are not embedded below editable content; only explicitly text-free background/complex assets are eligible.
- Export is normalized to a local lowercase `.pptx` extension, written through the boundary, read back, and SHA-256 checked. The export receipt binds project, relative/absolute validated path, byte count/hash, SlideSpec version, and every current visual version.
- Removed public `recordExport` and `recordQaResult`. An export receipt is re-read and re-hashed before `conversion → qa`.
- A QA report can advance state only when it carries runtime execution proof issued after `LibreOfficeQa` has persisted both report artifacts. Self-reported/fake `passed` reports are rejected and leave the project in `qa`.
- QA report bindings must exactly match the validated export receipt before `qa → completed` or `qa → blocked`.

### LibreOffice and OOXML QA

- Replaced zero-byte blank detection with decoded PNG RGBA pixel analysis. Pure-white and near-uniform white pages are blank; visibly colored pages are not.
- Initial and repaired QA inputs must be relative paths under project `exports/`; each QA invocation validates the artifact path and SHA-256.
- Each run uses `qa/run-N/profile` as the LibreOffice user profile and `qa/run-N/temp` as `TMPDIR`.
- `LocalCommandRunner` now enforces configurable timeouts, sends `SIGTERM` then `SIGKILL`, and bounds captured stdout/stderr. Spawn errors and timeouts become persisted failed reports.
- Mixed-case requested extensions are normalized by delivery; QA also handles `.pptx` case-insensitively when deriving the PDF name.
- Automated repair remains capped at two repair calls, and every repaired path/hash is revalidated by the same QA boundary.
- ZIP/XML tests inspect concrete editable text/table objects, `a:prstGeom`, chart relationships and numeric caches, notes relationships/content, and absence of a full-slide image relationship/media item.

## TDD RED/GREEN evidence

| Behavior | RED command/result | GREEN command/result |
| --- | --- | --- |
| Strict IDs, dot paths, create-only writes, fixed/nested symlink traversal | `pnpm --filter @digital-twin/worker exec vitest run src/identifiers.test.ts src/workspace-artifacts.test.ts` → exit 1; identifier module missing and 9/11 artifact tests failed | Same command → exit 0; 21/21 passed |
| Unique outline IDs, exact SlideSpec mapping, write-before-state | `pnpm --filter @digital-twin/worker exec vitest run src/ppt-project.test.ts` → exit 1; 3/7 failed | Same focused file → exit 0; 7/7 passed; final expanded file 9/9 passed |
| Request/source provenance, reference integrity, cross-instance running lock | `pnpm --filter @digital-twin/worker exec vitest run src/source-analysis.test.ts` → exit 1; 4/4 failed | Same command → exit 0; 4/4 passed |
| Analysis-bound outline and frozen-outline-bound SlideSpec gateways | `pnpm --filter @digital-twin/worker exec vitest run src/structure-generation.test.ts` → exit 1; 3/3 failed because services were absent | Same file plus source analysis → exit 0; 7/7 passed |
| Exact ImageGen capability/CWD, shared visual lock, persisted block/resume, no public image mutation | `pnpm --filter @digital-twin/worker exec vitest run src/visual-generation.test.ts` → exit 1; 5/7 failed, then the arbitrary-image surface counterexample remained RED | Same command → exit 0; final 8/8 passed |
| Delivery receipt and removal of arbitrary export/status mutation | `pnpm --filter @digital-twin/worker exec vitest run src/delivery-coordinator.test.ts src/visual-generation.test.ts` → exit 1; 2/9 failed on exposed mutation methods | Same command → exit 0; 9/9 passed at that checkpoint |
| Self-reported QA cannot complete a project | `pnpm --filter @digital-twin/worker exec vitest run src/delivery-coordinator.test.ts` → exit 1; forged QA test resolved instead of rejecting | Same file plus QA tests → exit 0; 8/8 passed |
| Decoded PNG blank detection, exports restriction, run isolation, timeout/exception persistence | First QA run → exit 1 because `pngjs` was absent; after adding the explicit dependency, 4/6 behavior tests failed | `pnpm --filter @digital-twin/worker exec vitest run src/libreoffice-qa.test.ts` → exit 0; 6/6 passed |
| Atomic authoritative SlideSpec bundle | `pnpm --filter @digital-twin/worker exec vitest run src/ppt-project.test.ts` → exit 1; 2/9 failed because the implementation still wrote per-page files | Same command → exit 0; 9/9 passed |
| Concrete OOXML proof | Strengthened `src/pptx-exporter.test.ts`; first run was RED on the concrete chart relationship target assertion | Same command → exit 0; 3/3 passed with shape/chart/relationship/notes/no-image assertions |
| Complete private production facade and unforgeable signer | Initial production test was RED because the factory exposed only projects; follow-up adversarial runs exposed a reflection-visible mutation field and then showed the monkeypatched public QA path was called | `production-workflow.test.ts` → exit 0; 2/2 passed with the full authorized chain and all fake/deep-import/reflection/monkeypatch attempts rejected |
| Authoritative repair, cap, invalid repair rejection, and recovery | Expanded delivery file initially had 6 failing tests because delivery ran one QA round and could not resume | `delivery-coordinator.test.ts` → exit 0; 8/8 passed, including fail→repair→pass, three-failure block, partial-persistence resume with one export, and stale/path/hash rejection |
| Source pre-I/O reservation and boundary rollback | Expanded source suite initially had 2 failing boundary tests | `source-analysis.test.ts` → exit 0; 8/8 passed with a cross-instance request winner and retryable request/approval/evidence write failures |
| Page-local nested object identity and deep schemas | New duplicate nested-object counterexample initially failed; the first implementation was intentionally corrected after proving a global uniqueness rule was too strict for independent pages | `ppt-project.test.ts` → exit 0; 17/17 passed with table/chart/shape/citation and non-string-ID counterexamples |
| Factory-local QA path cannot be replaced | A forged `LibreOfficeQa.prototype.run`, guessed `runChecked`, fake command runner, and fake comparator initially issued/counted a forged path | Focused production/delivery/QA suite → exit 0; final 19/19 at that checkpoint, and final combined focused suite 44/44 |

## Verification and real QA evidence

- Focused fix-round-2 suite (`production-workflow`, `delivery-coordinator`, `libreoffice-qa`, `source-analysis`, and `ppt-project`) → exit 0; 44/44 passed.
- Final Worker suite: `pnpm --filter @digital-twin/worker test` → exit 0; 117/117 passed across 12 files.
- Real local LibreOffice counterexample used the bundled runtime `soffice` and `pdftoppm`, `LocalWorkspaceArtifacts`, the production command runner, and the PNG comparator:
  - editable normal one-page PPTX: `status: passed`, `actualPageCount: 1`, `blankPages: []`, `issues: []`;
  - empty one-page PPTX: `status: failed`, `actualPageCount: 1`, `blankPages: [1]`, issue `Blank rendered pages: 1`;
  - authoritative repair: blank initial receipt produced `failed`, repaired normal receipt produced `passed`, `repairRounds: 1`, final path `exports/repaired-1.pptx`;
  - recovery: the real runner persisted round 1 and then a simulated interruption was thrown; the checkpoint remained `qa`, retry passed, and the exporter call count remained exactly 1.
- Fresh repository gate before final commit:
  - `pnpm typecheck` → exit 0 for core, worker, and desktop;
  - `pnpm lint` → exit 0 with zero warnings;
  - `pnpm test` → exit 0: core 8/8, Worker 117/117, desktop 11/11, Rust 13/13 integration tests plus unit/doc suites;
  - `npx --yes prettier@3.6.2 --single-quote --check <changed TypeScript files>` → exit 0;
  - `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check` → exit 0;
  - `git diff --check` → exit 0.
- The full code gate above was rerun after formatting. The report-only follow-up was then checked independently for formatting and whitespace before its documentation commit.

## Files added or materially updated

- `apps/worker/src/identifiers.ts` and test
- `apps/worker/src/workspace-artifacts.ts` and test
- `apps/worker/src/analysis-evidence.ts`
- `apps/worker/src/source-analysis.ts` and test
- `apps/worker/src/structure-generation.ts` and test
- `apps/worker/src/visual-evidence.ts`
- `apps/worker/src/visual-generation.ts` and test
- `apps/worker/src/delivery-evidence.ts`
- `apps/worker/src/delivery-coordinator.ts` and test
- `apps/worker/src/ppt-project.ts` and test
- `apps/worker/src/libreoffice-qa.ts` and test
- `apps/worker/src/pptx-exporter.test.ts`
- `apps/worker/src/index.ts`
- `apps/worker/package.json`
- `pnpm-lock.yaml`
- `apps/worker/src/production-workflow.test.ts` (round 2)
- `.superpowers/sdd/implementation-plan/task-3-report.md` (round-2 evidence)

## Self-review and residual risks

- The Node adapter closes lexical traversal, existing-component symlink traversal, final-file following, and accidental overwrite. There remains an unavoidable parent-directory TOCTOU window between `lstat` checks and a later Node filesystem operation. The production Rust workspace binding should use directory-handle-relative operations (`openat`/equivalent) where available; this is now a documented defense-in-depth follow-up, not a reason to weaken the Node boundary.
- LibreOffice/Poppler behavior was verified on this macOS runtime. PowerPoint and Keynote were not run; editable compatibility still depends on the documented PptxGenJS/OOXML surface and should receive manual application smoke checks before release.
- Project state and the resumable QA checkpoint are intentionally process-local for this task. They recover a thrown/partial-persistence operation within the live workflow; a host-process restart still requires the later SQLite state-restoration work to rehydrate receipts, frozen versions, reports, and next action without introducing a parallel mutation path.
- The authentic QA proof is factory-local by design. Durable restoration must revalidate the persisted atomic QA bundle and bound export receipt rather than attempting to serialize the in-memory proof marker.
- A production repairer is an injected business capability and must have its own validated means to create the returned `exports/*.pptx` artifact. Regardless of its implementation, the coordinator independently reads the bytes and rejects stale paths, hashes, or version bindings before replacing the authoritative receipt.
- No live model or ImageGen call was made; gateways use deterministic fakes in tests. The no-API-fallback invariant remains intact.

## Fix-round 3 implementation

- Production LibreOffice QA no longer captures a prototype method at module load. Its execution entry is an instance-own closure that calls private state, and the factory keeps that instance behind its own closure. A fresh module-graph test first patches `LibreOfficeQa.prototype.run`, then imports the production factory; the patch is not called and genuine QA produces the expected unavailable-capability report.
- POSIX timeouts now defer settlement until the scheduled process-group `SIGKILL` fallback is issued. The regression starts a root that exits on `SIGTERM` plus a descendant that ignores it and owns no output pipe; after the runner returns the descendant is no longer active, with deterministic test cleanup retained.
- Visual generation validates the full runtime discriminated union before any block/state/artifact mutation: only exact generated/blocked discriminants, PNG media/bytes, allowed usage, boolean `textFree`, and string `altText`/block message are accepted. Project storage retains its independent generated-asset and PNG checks. Source analysis now validates optional data-point `unit` and `sourceIds` before provenance traversal.
- QA delivery checks `qa/qa-round-N.json` before re-running a round. It parses and validates the authoritative bundle’s full report shape, receipt/project/spec/visual/page/round binding, report paths, and canonical readable summary; a validated report is reissued by the factory-local signer. Corrupt or differently bound bundles reject without executing QA commands.
- `LocalWorkspaceArtifacts.write` now treats a completed create-only hard link as committed even if best-effort temporary cleanup fails. Request staging, web-search decision, and analysis-evidence writes read back and adopt only byte-identical committed artifacts after adapter-reported failure; non-identical/missing artifacts retain the original rollback behavior.
- Repairs must use a new relative artifact path. Before accepting a replacement, delivery re-resolves, reads, length-checks, and hashes the current receipt; a current-artifact mutation or stale checkpoint cannot advance recovery state.

## Fix-round 3 TDD and verification

- RED/GREEN focused coverage:
  - `source-analysis.test.ts` and `visual-generation.test.ts`: 5 initial RED assertions (malformed source points and ImageGen statuses/results) → 22/22 GREEN.
  - `production-load-order.test.ts`: prototype patch was invoked once before the instance-own QA entry → GREEN with zero patch calls.
  - `libreoffice-qa.test.ts`: TERM-ignoring descendant outlived the root close → GREEN after mandatory group-KILL-before-settlement.
  - `delivery-coordinator.test.ts`: persisted bundle reran `soffice`/`pdftoppm`, same-path repair reported only a duplicate hash, and current-receipt mutation completed → GREEN bundle replay/rejection and repair invariants.
  - `workspace-artifacts-post-commit.test.ts` plus source-analysis post-commit parametrization: final-link cleanup and each of request/decision/evidence post-commit errors initially rejected → GREEN only for exact read-back adoption.
- Focused round-3 suite: 8 files, 64 tests passed.
- Worker suite: `pnpm --filter @digital-twin/worker test` → 14 files, 132 tests passed.
- Fresh repository gate: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check`, `npx --yes prettier@3.6.2 --single-quote --check <changed TypeScript files>`, and `git diff --check` all exited 0.
- Real local LibreOffice smoke (bundled runtime `soffice` and `pdftoppm`, `LocalWorkspaceArtifacts`, `LocalCommandRunner`, and actual PptxGenJS files):
  - normal deck: `passed`, one rendered page, no blank pages;
  - blank deck: `failed`, one rendered page, `blankPages: [1]`;
  - repair: blank initial QA then `exports/repaired.pptx` passed, with one repair round;
  - recovery: an injected interruption after the durable round-1 bundle left the checkpoint resumable; replay passed with exactly the original two QA commands (one conversion and one render), not a second QA execution.

## Fix-round 4 implementation

- Persisted QA bundles now require semantic consistency before they can be reissued with the factory-local QA proof. A passed report must have the exact expected/rendered/comparison count, no issues or blanks, a one-to-one rendered/comparison path mapping, no blank comparison, and non-empty LibreOffice, renderer, and PDF paths.
- Every replayed report validates unique rendered/comparison paths, comparison/page cardinality, an exact comparison-derived blank-page sequence with unique in-range page numbers, and the existing finite optional difference-score type boundary. Failed and blocked reports require a non-empty, non-blank issue list, so they cannot be mistaken for a successful report.
- The coordinator now re-resolves, re-reads, length-checks, and SHA-256-checks the current export receipt after finding a persisted QA bundle but before parsing/reissuing it. A stale or in-place-mutated receipt rejects without running QA, reissuing the local proof, advancing the checkpoint, or re-exporting.

## Fix-round 4 TDD and verification

- RED: seven new delivery counterexamples initially failed: six contradictory persisted bundles (including the exact `passed`, expected-one/actual-zero/empty-render/timeout-issue case) were accepted, and a QA bundle replayed after the current export bytes were changed.
- GREEN: `pnpm --filter @digital-twin/worker exec vitest run src/delivery-coordinator.test.ts` → exit 0; 19/19 passed. The semantic cases prove that neither QA commands nor the reissue signer run; the stale-current-receipt case retains the QA checkpoint and executes no second QA run.
- Worker gate: `pnpm --filter @digital-twin/worker test` → exit 0; 14 files, 139 tests passed.
- Fresh repository gate: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check`, `npx --yes prettier@3.6.2 --single-quote --check apps/worker/src/delivery-coordinator.ts apps/worker/src/delivery-coordinator.test.ts`, and `git diff --check` all exited 0.
- Real local LibreOffice smoke used the bundled runtime `soffice` and `pdftoppm`, `LocalWorkspaceArtifacts`, `LocalCommandRunner`, `PngPixelPageComparator`, and actual PptxGenJS bytes: normal one-page deck passed with no blanks; empty one-page deck failed with `blankPages: [1]`; a durable-QA interruption recovered by replaying the saved bundle to passed with exactly one real QA execution.

## Fix-round 5 implementation

- Replay now resolves the authoritative `qa/run-N` directory through the workspace-artifact boundary before reissuing the factory-local QA proof. It derives the one expected PDF from the bound export filename and the exact ordered rendered-page paths `rendered-1.png` through `rendered-N.png` from the persisted actual count.
- Persisted passed reports require those exact absolute PDF, rendered-page, and comparison paths in order. Empty, relative, different-run, duplicated, skipped, or reordered page paths therefore cannot be signed or advance the workflow.
- Failed and blocked reports retain their valid early-failure form with zero rendered output, but any non-null executable path must be non-empty; a non-null PDF must be the exact QA-run output; and any rendered/comparison paths use the same exact sequence. Rejected reports do not execute QA, invoke the local reissuer, or change the retryable checkpoint.

## Fix-round 5 TDD and verification

- RED: `pnpm --filter @digital-twin/worker exec vitest run src/delivery-coordinator.test.ts` initially failed 5/24 new path-boundary counterexamples: passed empty/outside-run paths were accepted; failed empty executable and outside-run rendered paths advanced to repair; and a blocked empty PDF path completed. The additional GREEN set covers relative, skipped-page, and outside-run PDF forms.
- GREEN focused suite: the same command → exit 0; 27/27 passed. Every rejected bundle proves zero QA commands and zero replay-signing calls, with the checkpoint remaining at `qa`/`nextAction: qa`.
- Worker gate: `pnpm --filter @digital-twin/worker test` → exit 0; 14 files, 147 tests passed.
- Fresh repository gate: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check`, `npx --yes prettier@3.6.2 --single-quote --check apps/worker/src/delivery-coordinator.ts apps/worker/src/delivery-coordinator.test.ts`, and `git diff --check` all exited 0.
- Real local LibreOffice smoke again used bundled `soffice`/`pdftoppm`, `LocalWorkspaceArtifacts`, `LocalCommandRunner`, `PngPixelPageComparator`, and real PptxGenJS files: normal one-page passed; empty one-page failed with `blankPages: [1]`; a simulated post-persistence interruption replayed the exact run-one report to passed with only one actual QA execution.

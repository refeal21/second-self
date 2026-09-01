# Task 3 report — image-first PPT workflow and local artifacts

## Implementation

- Added a focused workspace-artifact boundary with the exact per-project folders `sources/`, `outline/`, `slide-specs/`, `visuals/`, `exports/`, and `qa/`. Project, source, structured-analysis, outline, page-spec, visual, export, and QA writes all pass through this boundary.
- Added a PPT project/workflow service that reuses the core fixed-stage transition guard and `freezeVersion`:
  - creates projects and attaches selected source material;
  - stores structured material analysis with findings, data points, and `sourceMap` citations;
  - freezes the whole outline on approval;
  - freezes all page specifications together on detail approval;
  - freezes each page visual independently;
  - requires every current page visual to be approved before conversion;
  - reopens only the current approved page into a new draft version;
  - creates a new version for regeneration/replacement instead of mutating prior approved output;
  - enforces `conversion → qa → completed`, with failed QA entering `blocked`.
- Added a source-analysis service and gateway. A requested web search enters `awaiting_web_search_approval`; execution is rejected until the user explicitly approves it, and rejection remains non-executable.
- Added `VisualGenerationGateway`, `VisualGenerationService`, and `CodexVisualGenerationGateway`:
  - only one page visual may generate at a time per project;
  - the request contains one page ID, its frozen spec version, the approved structured spec, and its page-specific image brief;
  - the prompt states that structured spec text/data/citations are authoritative and OCR/image text may not overwrite them;
  - missing ImageGen skill/tool capability returns `{ status: 'blocked', reason: 'capability_unavailable' }` without starting a turn;
  - no API-key field, login, environment variable, or fallback path was added.
- Added `PptxExporter` and a PptxGenJS 4.0.1 adapter. It rebuilds approved titles, body copy, tables, charts, and basic shapes as editable OOXML objects. A full-slide reference PNG or any image not explicitly marked text-free is not embedded beneath editable copy. Explicitly text-free backgrounds and complex visual layers are the only approved images eligible for embedding. Per-slide `sourceMap` entries are written to `[Sources]` speaker notes.
- Added `PptExportService`, which writes `.pptx` bytes through the workspace-artifact boundary.
- Added `CommandRunner`, `LocalCommandRunner`, `LibreOfficeQa`, a pluggable rendered-page comparator, and `QaRepairOrchestrator`:
  - probes configured, bundled, and PATH `soffice` candidates;
  - probes configurable PDF page renderers;
  - runs `soffice --headless --convert-to pdf` and `pdftoppm -png -r 144` with paths resolved through the artifact boundary;
  - checks rendered page count and comparator-reported blank pages;
  - persists JSON and readable text reports under `qa/`;
  - stops after at most two automated repair calls.

## Files added or updated

- `apps/worker/src/workspace-artifacts.ts`
- `apps/worker/src/workspace-artifacts.test.ts`
- `apps/worker/src/source-analysis.ts`
- `apps/worker/src/source-analysis.test.ts`
- `apps/worker/src/ppt-project.ts`
- `apps/worker/src/ppt-project.test.ts`
- `apps/worker/src/visual-generation.ts`
- `apps/worker/src/visual-generation.test.ts`
- `apps/worker/src/pptx-exporter.ts`
- `apps/worker/src/pptx-exporter.test.ts`
- `apps/worker/src/libreoffice-qa.ts`
- `apps/worker/src/libreoffice-qa.test.ts`
- `apps/worker/src/index.ts`
- `apps/worker/package.json`
- `packages/core/package.json`
- `packages/core/src/types.ts`
- `pnpm-lock.yaml`

## TDD RED/GREEN evidence

| Behavior | RED command/result | GREEN command/result |
| --- | --- | --- |
| Exact project folders, artifact path boundary, attachments, source analysis, web-search approval, outline/detail freeze | `pnpm --filter @digital-twin/worker exec vitest run src/workspace-artifacts.test.ts src/ppt-project.test.ts src/source-analysis.test.ts` → exit 1; 3 test failures because `PptProjectService` was absent and 2 failed suites because the artifact and analysis modules were missing | Same command → exit 0; 7/7 tests passed |
| One-page visual lock, page versions, per-page approval/reopen/replacement, ImageGen capability block, page-specific Codex request | `pnpm --filter @digital-twin/worker exec vitest run src/visual-generation.test.ts` → exit 1; 5/5 tests failed because the visual services/gateway and version operations were absent | Same command → exit 0; 5/5 tests passed; `pnpm --filter @digital-twin/worker typecheck` also exited 0 after the focused type corrections |
| Editable PPTX OOXML, source notes, full-slide PNG exclusion, eligible complex-visual inclusion, artifact export | First `pnpm --filter @digital-twin/worker exec vitest run src/pptx-exporter.test.ts` → exit 1 because the required ZIP inspector dependency was absent; after adding the explicit test dependency, the same command → exit 1 with 3/3 focused failures because `PptxGenJsExporter` and `PptExportService` were absent | Same command → exit 0; 3/3 tests passed; ZIP/XML assertions found approved text once in editable slide XML, native table/chart/shape objects, `[Sources]` notes, zero media files for the baked full-slide reference, and one media file for an explicitly text-free complex visual |
| LibreOffice detection/conversion/render/report and two-repair cap | `pnpm --filter @digital-twin/worker exec vitest run src/libreoffice-qa.test.ts` → exit 1; 3/3 tests failed because `LibreOfficeQa` and `QaRepairOrchestrator` were absent | Same command → exit 0; 3/3 tests passed with fake command runner and deterministic comparator |
| Legal conversion/QA completion | `pnpm --filter @digital-twin/worker exec vitest run src/ppt-project.test.ts` → exit 1; 1 focused failure because `recordExport`/`recordQaResult` were absent | Same command → exit 0; 4/4 project-workflow tests passed and worker typecheck exited 0 |

## Verification and QA evidence

- Clean baseline before Task 3: `pnpm test` → exit 0; core 8/8, worker 33/33, desktop 11/11, Rust 13/13 integration tests passed.
- Focused Worker gate after implementation: `pnpm --filter @digital-twin/worker typecheck && pnpm --filter @digital-twin/worker test` → exit 0; Worker 51/51 at that checkpoint. The legal QA-stage regression then brought the final Worker total to 52/52.
- Real local smoke QA used the bundled runtime executables reported by `command -v`: `soffice` and `pdftoppm` both resolved under the Codex primary runtime. A one-page editable PPTX was created through `PptxGenJsExporter`, written through `LocalWorkspaceArtifacts`, converted headlessly to PDF, rendered to PNG, and inspected by `LibreOfficeQa`. Result: `status: passed`, `actualPageCount: 1`, `blankPages: []`, `issues: []`; JSON report was written to the temporary project's `qa/qa-round-1.json`.
- Task files were formatted with `pnpm dlx prettier@3.6.2 --single-quote --write ...`; the check command reported all selected Task 3 files matched Prettier style.
- Fresh repository gate: `pnpm typecheck && pnpm lint && pnpm test && pnpm dlx prettier@3.6.2 --check ...` → exit 0.
  - Core: 8/8 tests passed.
  - Worker: 52/52 tests passed.
  - Desktop TypeScript: 11/11 tests passed.
  - Rust: 13/13 integration tests passed (7 process, 1 database, 5 path); unit/doc suites passed.
  - All three TypeScript workspace projects passed typecheck.
  - All three TypeScript workspace projects passed lint with zero warnings.
  - All selected Task 3 files passed the formatting check.
- `git diff --check` → exit 0.
- Production boundary audit found no API-key symbol or fallback in new production code. The only existing `apikey` strings remain Task 2 tests that verify unsupported auth is rejected.

## Design decisions and self-review

- The structured `SlideSpec` is passed directly from the frozen detail version to visual generation and to PPTX authoring. Generated image output has no channel for replacing slide text, numbers, tables, chart data, or citations.
- Visual artifacts carry two explicit safeguards: `usage` and `textFree`. The exporter requires `textFree: true` and rejects `full_slide_reference` for embedding, even when image bytes are supplied.
- Current visual approval is matched by both `slideId` and `versionId`; reopening leaves the historical frozen version intact and makes the new draft current, so stale approval cannot unlock conversion.
- The visual-generation coordinator clears its active-project lock in `finally`, including capability blocks and gateway errors.
- External source analysis, image generation, PPTX authoring, command execution, comparison, repair, and artifact IO are separate interfaces/classes rather than one worker controller.
- PptxGenJS is isolated behind `PptxExporter`; ZIP/XML inspection tests assert outcomes in generated OOXML instead of implementation source text.
- LibreOffice and PDF renderer calls are argument arrays with `shell: false` process spawning. No shell command construction is exposed through the QA API.
- QA output paths are resolved within the project `qa/` boundary before external tools receive them, and QA reports themselves are written through the artifact writer.

## Concerns / Task 5 boundaries

- The production Tauri binding for `WorkspaceArtifacts` still belongs to Task 5. The Node `LocalWorkspaceArtifacts` adapter is suitable for Worker tests and the local smoke run, but the packaged app must bind the same interface to the existing Rust symlink-aware workspace commands so Rust remains the authority for production path safety and filesystem writes.
- The Codex ImageGen adapter intentionally depends on `CodexImageGenTurnRunner`; Task 5 must connect that runner to the existing App Server/general-task turn lifecycle and capability discovery. No live model/image generation was attempted here.
- The default page comparator treats a zero-byte rendered page as blank. More expensive white-page and visual-difference scoring is intentionally pluggable and should be supplied in Task 5; deterministic comparator behavior and report plumbing are covered now.
- The real smoke run verifies LibreOffice compatibility in this environment. Microsoft PowerPoint and Keynote were not claimed or run; Task 5 retains the documented manual Keynote check.
- Project/workflow state is intentionally in memory behind focused services. SQLite checkpoint persistence and restart restoration are Task 5 integration work.

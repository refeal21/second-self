# Full-slide generation and project template palette

Status: implementation authorized by the user's 2026-09-09 request to continue yesterday's unfinished work and match the 北投 template colors.

## Goal

Generate complete slide PNGs containing approved text and data; stop generating background-only artwork. Let the user select a local PPTX as a palette reference, confirm/edit project colors, and inspect the app prompt and feedback used for a new candidate. Preserve frozen content, previous images, approvals, and route-safe operations.

## Architecture and boundaries

Tauri 2 / Rust / rusqlite, React/TypeScript, existing standalone TypeScript Worker and native Codex ImageGen. No API-key or paid API fallback. Keep NativePptPipeline v1/v2 unchanged. Add companion SQLite style versions and generation requests/receipts. A template is not factual source material. This release does not insert images into the actual template, guarantee editable conversion fidelity, or mass-regenerate the customer project.

Project palette confirmation is independent of outline approval. The first visual approval permanently locks the palette; reopening a visual cannot unlock it. Before that, a palette change invalidates older-style draft approval but does not delete images. Legacy visuals without generation records must be identified as such. Complete-page checks are human review, not an OCR claim.

## Shared contracts

Types in `apps/worker/src/visual-style.ts` (browser safe):

```ts
interface VisualStyleProfile {
  primaryColor: string; backgroundColor: string; textColor: string;
  accentColors: string[]; instructions: string;
  template: { fileName: string; sha256: string; relativePath: string } | null;
}
interface VisualStyleState { revision: number; profile: VisualStyleProfile | null; locked: boolean }
interface TemplateStyleInspection {
  colors: Array<{ color: string; count: number }>;
  slideCount: number; warnings: string[];
}
interface VisualGenerationRequest {
  id: string; projectId: string; expectedRevision: number; styleRevision: number;
  slideId: string; kind: 'imagegen' | 'upload'; prompt: string;
  feedback: string; promptVersion: string;
}
interface VisualGenerationRecord extends VisualGenerationRequest {
  createdAt: string; promptSha256: string; specSha256: string;
  style: VisualStyleState;
  receipt: null | { relativePath: string; sha256: string; committedRevision: number;
    createdAt: string; provider: { threadId?: string; turnId?: string; itemId?: string } };
}
```

Native commands (camelCase payloads):

- `ppt_load_visual_style {projectId}` -> VisualStyleState.
- `ppt_save_visual_style {input:{projectId,expectedRevision,expectedStyleRevision,profile,templateBase64?:string}}` -> VisualStyleState. Validate colors/lengths/path/hash/size locally; original template stored as immutable `visuals/style-templates/<sha256>.pptx`, never sources. No raw user-controlled filesystem path.
- `ppt_begin_visual_request {input:VisualGenerationRequest}` -> VisualGenerationRecord. Persist before model dispatch; compare project/style revisions and approved spec. Exact app prompt, feedback and spec/style hashes are local audit, not a claim about provider-internal prompt.
- `ppt_visual_records {projectId}` -> VisualGenerationRecord[].
- Existing `ppt_commit_pipeline` gains optional `visualRequestId` and `visualProvider` input fields. Any new visual candidate in a style-enabled project needs a matching request. Validate imagegen/upload request against base revision and current palette; atomically write receipt with pipeline commit. Approval rejects mismatched-style candidates. Existing unstyled legacy pipelines stay readable and cannot bypass a stored lock.
- Worker RPC `ppt.template.inspect {contentsBase64}` -> TemplateStyleInspection. Bounded local ZIP/XML parser; no HTTP, entities, macros, external file reads. Read actual slide-referenced layouts/masters; do not interpret the default Office theme palette as visible brand colors. Output suggestions, not an automatic decision.

## Task 1 — Worker prompt contract and local template inspector

Owner files: new `visual-style.ts`, `template-style.ts` and tests; `visual-prompt.ts`, new tests; `slide-spec-contract.ts`; `sidecar-rpc.ts` and tests; `codex-image-turn.ts` and tests; worker package manifest and lockfile only.

1. Write failing tests: full-page title/body/data required; legacy background-only language cannot override; explicit style wins old blue; feedback cannot edit approved facts; default has no forced technology blue.
2. Implement `buildPageVisualPrompt(request & {style?:VisualStyleState}, feedback?)` and export `VISUAL_PROMPT_VERSION`. Keep approved values byte-for-byte and classify legacy design context as lower priority. Render narrative content, not debug IDs or provenance JSON.
3. Add browser-safe style validators (hex colors, bounded palette/instructions). Add secure, bounded PPTX color inspection with adversarial ZIP/XML tests. Palette inference returns warnings and needs confirmation.
4. Include real thread/turn/item IDs in image result when observed. Do not fabricate IDs or revised prompt.
5. RED then GREEN focused Worker tests; Worker typecheck; commit only owned files and report exact commands.

## Task 2 — Rust durable style and request persistence

Owner files: Rust new `visual_style.rs`, `database.rs`, `workbench.rs`, `tauri_workbench.rs`, `lib.rs`, production harness and Rust tests. No frontend or Worker edits.

1. Failing tests for style roundtrip/restart, stale style/project revisions, exact role-color validation, immutable template/hash/path safeguards, unknown project, requests preserved across restart.
2. Companion tables with project foreign keys and bounded payloads. Do not add fields to strict v1/v2 checkpoint JSON. Keep templates and records out of factual source lists. Preserve current preferences.
3. Extend pipeline commit atomically for receipts. Guard first-approval lock and stale-style candidate approval; preserve historical records and images. Test mismatched requests, stale generation completion, commit rollback and repeat/uncertain receipt reads.
4. Wire Tauri commands and production harness through identical service methods. Existing legacy approve paths must respect style guards.
5. Run focused and full Cargo tests; commit owned files with evidence.

## Task 3 — Desktop integration and review UX

Owner: root (frontend files only while Task 1/2 run independently). Shared interfaces above are frozen; report any needed change before editing another owner's files.

1. Failing adapter/UI tests for template confirmation, persistence across route changes, request saved before model dispatch, style included in details/visual prompts, uncertain commits, provider IDs and legacy provenance.
2. Add `inspectTemplateStyle` to worker gateway. Add adapter methods for style save/load and records, use existing project busy registry. Save style via explicit user confirmation. Do not autoapply template or start model work on file selection.
3. Add a collapsible project palette form: template selection, candidate swatches, editable role colors and instructions, clear deferred-template-insertion notice and lock explanation. Render known-style provenance near complete PNG review; hide exact technical prompt in details.
4. Rename visual review to whole-slide PPT review. Require explicit human checks for content and layout/palette before approval; reset checks when candidate changes. Preserve existing retry, navigation and approval rules. Update detail generation contract to complete-slide description and style context.
5. Adapter and browser tests, typecheck/build, integration harness. Tests must fail on unsupported new native commands rather than silently returning undefined.

## Task 4 — Integration verification and delivery

1. Full core/Worker/desktop/Rust tests, no paid API audit, scoped code review and fixes.
2. Browser validation (Browser plugin unavailable; bundled Playwright fallback) at 1440×960 and 390×844, file load/confirm/save/reopen/provenance/approval states, console and screenshot checks.
3. Build separate unsigned Apple Silicon `.app` under `artifacts/build/full-slide-style-target`; do not close or replace running customer app without permission.
4. In a disposable workspace with copied approved specs and confirmed template palette, generate one cover and one content page via the real production path. No automatic customer approvals or bulk generation. Inspect PNGs; report any model/network/font limitations truthfully.
5. Push tested branch to authorized existing GitHub repository, no force push or main merge. Report exact completion and remaining template-export step.

## Preflight ownership and risks

Task 1/2 can run independently because they only share the frozen JSON contract; root owns Task 3 integration. No simultaneous edits to the same file. Any contract mismatch blocks integration, not a compatibility workaround. Task 4 depends on all three.

The customer's original template/specs/PNG files must not enter Git. Backup/recovery of style and request history requires SQLite plus the project workspace, since pipeline-only snapshots do not contain companion tables. Existing blue images have unknown historical request provenance; do not infer author from the feedback field alone.

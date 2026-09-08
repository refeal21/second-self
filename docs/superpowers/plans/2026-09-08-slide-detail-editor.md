# Slide Detail Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace detail-review JSON with a lossless per-page CRUD editor and explicitly approved outline revisions.

**Architecture:** Keep the native Rust persistence boundary and ordered workflow. A pending outline revision holds edited structure and matching details without replacing the frozen outline; confirmation archives the base, freezes the revised outline and leaves details draft. A controlled React document editor communicates through baseline-aware adapter methods.

**Tech Stack:** Existing Tauri 2, Rust/rusqlite, React/TypeScript, Worker JSON-RPC, Vitest and Playwright; no new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-08-slide-detail-editor-design.md` (user approved 2026-09-08).

## Global Constraints

- 不更换技术栈、不改变账号或代理配置、不调用收费 API。
- 开发和测试不修改真实客户项目、不自动提交客户审批、不重跑模型生成。
- 未受影响页面按稳定页面 ID 沿用全部细化内容，而非按页码重新匹配。
- 结构确认和细化批准始终是两个明确操作。
- 原 v1 检查点和产物仍保留；只读打开旧项目不写库、不迁移文件。
- 不自动替换正在运行的应用、不修改系统代理、不调用真实模型消耗额度、不把客户材料推送到 GitHub。
- Use apply_patch for file edits, test first, commit only owned files, do not create helper subagents. Root owns review dispatch and final packaging/push.

## File and interface map

Task 1 owns Worker and native Rust revision handling. Task 2 owns only new editor files (type-only imports of existing domain types). Task 3 owns desktop integration and shared app/adapter tests. Task 4 owns production integration acceptance and technical documentation. Tasks 1/2 have disjoint writes; Task 3 starts after both reviews.

Pending draft public shape (Task 1 exports these from `native-pipeline.ts` or re-exports a focused module):

```ts
export interface NativeOutlineRevisionDraft {
  id: string;
  baseOutlineVersionId: string;
  outline: PptOutline;
  specs: readonly SlideSpec[];
  createdAt: string;
  updatedAt: string;
}
// NativePptPipeline supports schemaVersion 1 | 2; new fields are optional
// to existing TypeScript fixtures, but mandatory/strictly checked for v2.
outlineRevisionDraft?: NativeOutlineRevisionDraft | null;
revisionHistory?: NativeOutlineRevisionHistory[];
```

History has ID, status (`confirmed`/`cancelled`), base outline and detail version snapshots, saved draft, decision time and resulting version reference when confirmed. Task 1 records its exact exported history shape for Task 3. A cancelled draft ID is not reused.

New Worker action kinds and payloads:

```ts
{ kind: 'outline.revision.save', at: string, expectedRevision: number,
  revisionId: string, baseOutlineVersionId: string,
  outline: PptOutline, specs: readonly SlideSpec[] }
{ kind: 'outline.revision.approve' | 'outline.revision.cancel', at: string,
  expectedRevision: number, revisionId: string, baseOutlineVersionId: string }
```

Existing `details.submit` and `details.approve` accept `expectedRevision`; editing an existing draft must supply it, while initial AI generation retains its existing validated path. Worker checks it before any mutation. Task 3 adapter always supplies the editor baseline for save/approve. Do not change paid API/auth/network code.

## Task 1: Native outline revision state and provenance

**Files:**
- Create: `apps/worker/src/outline-revisions.ts`, `apps/worker/src/outline-revisions.test.ts` (additional focused validation/replay module allowed within Worker).
- Modify: `apps/worker/src/native-pipeline.ts`, `apps/worker/src/ppt-project.ts` and narrowly related Worker validators/services if needed.
- Modify/test: `apps/desktop/src-tauri/src/workbench.rs`, `apps/desktop/src-tauri/src/database.rs`, `apps/desktop/src-tauri/tests/workbench.rs` only as required for new revision contracts and persistence.

**Interfaces:** Consumes existing source analysis, outline/spec domain types and native action/commit boundaries. Produces public fields/actions above, strict v1/v2 restore, immutable version histories, actual version-aware export/QA.

- [ ] Write failing tests that drive the actual NativePptRpcRuntime from sources through outline approval and detail draft. Use synthetic fixtures only. Test new actions initially rejected by old parser, then state changes/provenance independently:

```ts
const before = structuredClone(runtime.snapshot(projectId));
const saved = await runtime.execute(projectId, {
  kind: 'outline.revision.save', at, expectedRevision: before.revision,
  revisionId: 'revision-1', baseOutlineVersionId: before.outline!.version.id,
  outline: reversedOutline, specs: reversedSpecs,
});
expect(saved.pipeline.outline).toEqual(before.outline);
expect(saved.pipeline.approvals).toEqual(before.approvals);
expect(saved.pipeline.outlineRevisionDraft!.specs[0]!.body).toEqual(['第二页原文']);
expect(saved.pipeline.project.workflowStatus).toBe('detail_review');
```

- [ ] Run `pnpm --filter @digital-twin/worker exec vitest run src/outline-revisions.test.ts`; record RED output due to unsupported revision action (not fixture/compile errors).
- [ ] Implement save/confirm/cancel in a focused revision module. `save` keeps current versions unchanged, validates same ordered IDs in candidate outline/specs and known sources. `confirm` archives base, creates unique versioned artifacts, freezes new outline, appends its approval, creates matching details draft, clears pending. `cancel` archives cancelled draft and preserves current versions. No global backward transition.
- [ ] Preserve v1 parsing and production fixtures. Add strict v2 parsing, version/history/approval/task chronology validation and recovery; no bypasses or synthetic replacement approvals. Existing frozen artifacts must never be overwritten. Let initial source/outline actions remain v1 until first structural edit. Version-aware replay must retain actual IDs, times and sequences through later visual/export/QA actions.
- [ ] Test add/delete/reorder/title-purpose changes, repeated saves, two successive revisions, cancel then new revision ID, stale revision/base/id, duplicate page IDs, unknown references, malformed history, unknown schema, tampered approvals/times, pending revision blocking approval/images/export, frozen detail blocking edits, old v1 restore, v2 process restart, active details/body equality and new version artifact paths.
- [ ] Add native Rust persistence tests on temporary workspaces for CAS, immutable historical artifacts and failed commit not producing partial new state; use actual workbench service, no user DB.
- [ ] Run focused tests, `pnpm --filter @digital-twin/worker test`, Worker typecheck/lint and Rust tests once before commit. Self-review and commit only Task 1 files. Write report with RED/GREEN evidence and exact history shape.

## Task 2: Lossless structured detail editor

**Files:**
- Create: `apps/desktop/src/detail-editor.tsx`, `detail-editor.css`, `detail-editor.test.tsx`.
- Create: `apps/desktop/src/detail-document.ts`, `detail-document.test.ts`.
- Create focused editor subcomponents for nested collections if needed; do not edit native-workspace, adapter, App, Worker or shared CSS.

**Interfaces:**

```ts
export interface DetailDocument { outline: PptOutline; specs: readonly SlideSpec[] }
export function detailDocumentError(value: DetailDocument): string | null;
export function hasOutlineChanges(base: PptOutline, next: PptOutline): boolean;
export function describeOutlineChanges(base: PptOutline, next: PptOutline): string[];
export interface DetailEditorProps {
  value: DetailDocument;
  analysis: SourceAnalysis | null;
  sources: readonly { id: string; fileName: string }[];
  readOnly: boolean;
  disabled: boolean;
  idPrefix?: string;
  onChange: (next: DetailDocument) => void;
}
export function DetailEditor(props: DetailEditorProps): ReactNode;
export function DetailPageIndex(props: {
  value: DetailDocument; idPrefix?: string;
}): ReactNode;
```

- [ ] Add failing tests for controlled title/body editing, ordered stable IDs on CRUD, delete confirmation/last-page guard, no model invocation, read-only/disabled controls, Chinese labels, and lossless compatibility suffix preservation:

```ts
fireEvent.change(screen.getByRole('textbox', { name: '第 1 页正文第 1 段' }),
  { target: { value: '调整后正文\n仍是同一段' } });
expect(latest.specs[0]!.body).toEqual(['调整后正文\n仍是同一段', '保留段落']);
expect(latest.specs[0]!.imageGenerationBrief).toBe(originalBrief);
expect(screen.queryByRole('textbox', { name: '逐页细化 JSON' })).toBeNull();
```

- [ ] Run `pnpm --filter @digital-twin/desktop exec vitest run src/detail-document.test.ts src/detail-editor.test.tsx`; record expected RED behavior.
- [ ] Implement controlled document form using existing outline card styling conventions. Each page supports title/purpose, paragraph CRUD, table+row+column CRUD with delete confirmation, chart/category/series editing (blank numeric input is invalid, never silently 0), basic shape forms, known analysis evidence/source selection and source locator editing. New page inserted after current with safe unique ID and empty required content; sorting moves complete ID-associated objects.
- [ ] Split compatibility brief only at exact known recovery marker; preserve suffix byte-for-byte on main-text edit, repeated saves and unsupported supplement parsing. Render known supplement in safe Chinese property lists, default-collapse raw fallback. Explain restored supplements are historical background, not authoritative current data; never re-key old index annotations to new objects.
- [ ] Add field validation returning page+field Chinese errors; preserve body arrays/newlines/numeric strings without normalize-on-load. Tables keep rectangular shape, charts keep series/category length, IDs remain unique, titles/purposes/main prompt nonblank. Errors must reach integration to disable save/approve.
- [ ] Style long data for internal table scroll only, safe wrapping and keyboard focus; include page index anchors, focus after insert/delete/sort and collision-free prefixes for history view. Add readonly per-page advanced JSON, never editable JSON.
- [ ] Run focused tests plus desktop test/typecheck/lint once. Self-review and commit only Task 2 files. Report RED/GREEN and public interface details.

## Task 3: Desktop persistence, approval and navigation integration

**Files:**
- Modify: `apps/desktop/src/native-workspace.tsx`, `desktop-adapter.ts`, `App.tsx`, `collection-read-model.ts`, `ppt-prompts.ts` and associated tests.
- Create: `apps/desktop/src/project-edits.ts`, `native-detail-review.test.tsx`, `project-edits.test.ts` (focused hooks/state module allowed).

**Interfaces:** Consumes Tasks 1/2. Adapter produces these calls:

```ts
saveDetails(projectId: string, specs: readonly SlideSpec[], expectedRevision: number): Promise<NativePptPipeline>;
saveOutlineRevision(projectId: string, draft: NativeOutlineRevisionDraft,
  expectedRevision: number): Promise<NativePptPipeline>;
approveOutlineRevision(projectId: string, revisionId: string,
  baseOutlineVersionId: string, expectedRevision: number): Promise<NativePptPipeline>;
cancelOutlineRevision(projectId: string, revisionId: string,
  baseOutlineVersionId: string, expectedRevision: number): Promise<NativePptPipeline>;
```

App-owned edit operation registry holds running/success/failure and persisted result through remount. Expose subscription/getter methods analogous to existing project-generation registry. Pass expectedRevision to detail approval too. Keep methods backward-compatible only where existing initial generation/readonly use requires it; edit callers never omit baseline.

- [ ] Write RED UI tests for rendering actual per-page editor, editing body then attempting navigation/approval, saving and remounting, creating structure draft and confirming separately, losing response and stale baseline:

```ts
expect(screen.getByRole('button', { name: '批准全部细化' })).toBeDisabled();
fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
// After native persistence, remount real workspace against stored pipeline.
expect(await screen.findByRole('textbox', { name: '第 1 页正文第 1 段' }))
  .toHaveValue('用户已保存的正文');
expect(stored.approvals).toHaveLength(1); // save did not approve
```

- [ ] Run targeted native detail/adapter/edit-state tests and record expected RED results.
- [ ] Replace JSON textarea and parseJson save path with controlled DetailDocument initialized from pending revision or current outline/specs. Track base revision and persisted content; dirty drafts survive background refresh, with explicit conflict instead of reset. Add directory, sticky save/review actions, history readonly cards, pending diff/confirm/cancel UI and field errors.
- [ ] Ordinary content saves call saveDetails; structural edits or already-pending edits save the candidate revision. Title and purpose changes are structural. Approval disables on dirty/pending/invalid/busy. Only successful persistence marks clean. Draft cancel confirms both structural and content loss. Native frozen details render readonly in later stages.
- [ ] Anchor CAS to editor baseline at adapter and Worker boundaries. Do not reread latest then use it as the old edit's baseline. Coordinate edit actions with generation registry to avoid conflicting same-project actions; hold lock until persistence/reconciliation completes; never swallow uncertain commit failures. Route-away/remount sees same running operation and final result.
- [ ] Extend dirty navigation/window guard and updated Chinese message; refreshing collections must not clobber editing state. Pending structure gets precedence over details in approval center/dashboard and links guarded workspace. Display historical approval proof separately. Update prompt building so restored supplements cannot override approved body/tables/data.
- [ ] Run focused tests and desktop full tests/typecheck/lint, update existing fixtures/call sites to real interfaces, self-review and commit only Task 3 files. Report evidence.

## Task 4: Production acceptance, browser QA and release

**Files:**
- Modify/test: `apps/desktop/src/production-pipeline-e2e.test.ts`, Worker process integration fixtures/tests and Rust temporary-workspace integration tests as needed.
- Modify docs: `docs/troubleshooting.md`, `docs/run-build.md`, `docs/Interaction-Spec.md`, approved spec status and this checklist.
- Browser script/screenshots live in `/tmp/second-self-detail-qa`, not committed source.

**Interfaces:** Consumes final editor, adapter and actual native pipeline. Uses mocked external Codex only, real domain/runtime/persistence code and actual exported PPTX inspection.

- [ ] Add a failing production-equivalent acceptance test driving an initially v1 saved project through structure save, reload, confirm, ordinary edit, detail approval, visual approval, export and QA. Verify known literal text in resulting OOXML, actual new outline/detail version IDs, original approval/history preservation, and pending revision entry absence after confirm.

```ts
expect(reloaded.schemaVersion).toBe(2);
expect(reloaded.revisionHistory![0]!.baseOutline.value.slides[0]!.title).toBe('原第一页');
expect(reloaded.slideSpecs!.version.status).toBe('draft');
expect(exportedXml).toContain('改后正文');
```

- [ ] Add fault cases for persistence failure, stale edit, restart and uncertain response using actual production adapter and strict runtime, not a mock save that accepts any content.
- [ ] Run targeted acceptance test RED/GREEN then full `pnpm test`, `pnpm typecheck`, `pnpm lint`, `git diff --check`.
- [ ] Browser availability: Browser plugin not available; use installed Playwright without dependency install. Start `pnpm --filter @digital-twin/desktop dev --host 127.0.0.1 --port 1420 --strictPort` only if free. Follow dashboard/project → real structured editor → edit/save → navigate away/back → structural change/confirm → content approval. At 1440×1050 and 390×844 check identity, nonblank, no overlay/errors, no page overflow/scroll traps, reachable controls and screenshots. External adapters are explicitly synthetic; no user DB/models.
- [ ] Perform independent task/final reviews, fix findings with tested scoped changes, then build serially with `pnpm --filter @digital-twin/desktop tauri build --bundles app` and `pnpm smoke:packaged-worker`. Do not restart an active app or replace an installed copy.
- [ ] Update docs/checklists with actual evidence, commit scoped code/docs, push to user-authorized `refeal21/second-self` main only after verified completion (no force push). Tell user exact .app path, safe quit/reopen instructions, tested behavior and unverified real-model/PowerPoint boundaries.

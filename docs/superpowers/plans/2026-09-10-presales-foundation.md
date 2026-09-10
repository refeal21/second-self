# Presales Planning Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the versioned presales instruction package and jointly validated planning boundary consumed by the subsequent native persistence and UI integration.

**Architecture:** Keep the existing v1/v2 pipeline and strict SlideSpec unchanged. Add a browser-safe presales module which compiles reviewed local instructions, validates model planning envelopes, and builds generation prompts from a single approved-content authority. This is the first independently testable part of design phase A; it must not enable unpersisted plans in the live UI.

**Tech Stack:** Existing TypeScript, Node build scripts, Vitest, React/Vite consumers; no new runtime dependency or API.

**Spec:** ../specs/2026-09-09-presales-batch-visual-design.md

**Foundation status (2026-09-10):** implemented and independently reviewed at `6bd962a`; 674 TypeScript tests, typecheck, lint, desktop build and generated-rule check pass. See [verification record](../../verification-2026-09-10-presales-foundation.md). Live native/UI integration and the overall multi-page feature remain pending.

## Global Constraints

- 不增加按量计费 API、API Key 配置、本地 HTTP 服务或新的渲染平台。
- 不安装未经审查的第三方全局技能，不修改用户的 Codex 个人设置。
- 所有最终上屏文字只有一份权威：`SlideSpec` 的标题、正文、表格、图表或基础形状文字。
- `imageGenerationBrief` 仅描述表达方式，不能作为额外文案入口。
- 旧项目没有这些伴随对象时按旧契约读取，不伪造已应用技能。
- 不改变原项目、图片、审批和交付文件；全部工作位于隔离目录。

## Increment boundaries and remaining design coverage

This plan implements the instruction/contract portion of §§3.1–3.3. It supplies testable interfaces for native companion snapshots and the paired editor, not a replacement workflow. The unchanged live adapter continues using its current contract until a native snapshot can be durably committed and jointly approved.

Next independent implementation plans consume these interfaces in order:

1. Native companion save/load/CAS, joint outline/detail editor and approval binding, actual adapter routing (§3.2–3.3).
2. Isolated v3 catalog, origin migration, page version/approval selection, durable jobs and Worker-owned two-slot scheduler (§§4–6).
3. Multi-page gallery, history feedback, image references, content revision copies and exact-version export/QA (§§5,7).

No scope is removed. A foundation test pass must not be reported as concurrent generation, finished visual quality or full design completion.

## File responsibilities

- `apps/worker/skills/presales-ppt/`: concise skill entrypoint and stage references, source provenance and MIT license notices for reviewed adaptation.
- `scripts/compile-presales-skill.mjs`: deterministic build-time bundler; never executes remote code.
- `apps/worker/src/presales/skill.generated.ts`: generated, portable instruction strings and source hashes, committed with the source.
- `apps/worker/src/presales/contracts.ts`: public types only.
- `apps/worker/src/presales/validation.ts`: bounded unknown-input validation and cross-page/reference consistency.
- `apps/worker/src/presales/planning.ts`: explicit opt-in planning prompt builders and renderer-safe scene inputs.
- Tests live next to the modules; fixtures contain synthetic data only.

### Task 1: Versioned presales instruction package

**Files:** Create the skill directory, build script, generated module and `apps/worker/src/presales/skill-build.test.ts`. Add `build:presales-skill` and `check:presales-skill` scripts to root package.json.

**Interfaces:**
- Produces `PRESALES_SKILL` with `id: 'presales-ppt'`, `version: '1.0.0'`, `sha256: string`, `stages: { outline: string; details: string; visual: string }` and source file hashes.
- Bundler CLI: `node scripts/compile-presales-skill.mjs [--check] [--root absolute-repo-path]`. Default repo root is resolved from script location, not process cwd. Check mode is strictly read-only; missing/stale output exits nonzero.
- No browser or Worker runtime filesystem reads; no remote updates.

- [x] **Step 1: Write tests before the compiler.**

```ts
it('check detects a changed skill without updating generated output', async () => {
  // Copy the minimal synthetic skill tree and compiler to a mkdtemp fixture.
  const generated = runCompiler(fixture, []);
  expect(generated.status).toBe(0);
  const before = readGenerated(fixture);
  changeReference(fixture, 'details', 'Scene label changed');
  expect(runCompiler(fixture, ['--check']).status).not.toBe(0);
  expect(readGenerated(fixture)).toBe(before);
});
```

The helpers are test-local fs/child_process operations, not production test hooks. Also test byte-identical two builds, invocation from another cwd, missing required reference, source metadata hash change, and malformed manifest. Do not test skill quality by grepping prose.

- [x] **Step 2: Run `pnpm --filter @digital-twin/worker exec vitest run src/presales/skill-build.test.ts`; record the expected preimplementation failure.**
- [x] **Step 3: Implement compiler and minimal stage references.**

Use node:crypto SHA-256 of exact UTF-8 source bytes, deterministic ordered file paths, no time/env in output. Manifest fixed source paths: SKILL.md, references/outline.md, references/details.md, references/visual.md and sources.json. Validate package id/version and source metadata; reject path traversal and missing files. Output a TypeScript const via JSON.stringify, with no runtime node imports. Every stage combines the shared entrypoint body with its stage reference.

Sources.json records these exact upstream pins and consulted references (rules are scoped adaptations, not wholesale copies):

- PPT Master `78fa4eebf67d38f33c51ec457c911d7e05013587`: plan-core.md, executor-structure.md, image-layout-patterns.md.
- slides_maker `02ea841a6283f3c262f0ff534d28091a3d9554e1`: form-selection.md, design-principles.md.
- baoyu-skills `6b7a2e417500561a5ecdd0b168332f4142584617`: baoyu-infographic/SKILL.md.

Skill covers goals → architecture OR overview → mapped function pages → role/scenario steps. Teach relational forms rather than equal cards everywhere. All visible text has one authority; scene design references approved text once, not a second paraphrase. Fixed palette comes from project, no hardcoded corporate blue/red and no invented interfaces or benefits. Missing evidence can be a visible question, not an unqualified assertion. Long notes remain separate and never silently replace frozen text. Explain full-slide output, not background-only output. No automatic API fallback, no automatic approvals.

- [x] **Step 4: Run focused tests, `node scripts/compile-presales-skill.mjs --check`, worker typecheck and skill quick_validate. Record behavior baseline and forward validation separately; structural tests do not prove visual quality.**
- [x] **Step 5: Commit only task-owned files after diff check.**

### Task 2: Joint model-envelope and semantic-reference validation

**Files:** Create `contracts.ts`, `validation.ts`, `validation.test.ts`, `fixtures.test-support.ts` under apps/worker/src/presales.

**Interfaces:** Imports existing PptOutline, SlideSpec and SourceAnalysis as types. Produces:

```ts
type PageType = 'cover' | 'goals' | 'architecture' | 'overview' | 'module' | 'scenario' | 'closing';
interface PresalesModule { id: string; name: string; findingIds: string[] }
interface PagePlan { slideId: string; pageType: PageType; keyMessage: string; moduleIds: string[] }
interface PresalesPlan { schemaVersion: 1; modules: PresalesModule[]; pages: PagePlan[] }
interface TextBinding { id: string; path: string }
interface SceneStep {
  id: string; moduleId: string; actor: string; location: string;
  triggerRef: string; actionRef: string; responseRef: string; outcomeRef: string;
}
interface SceneEdge { from: string; to: string }
interface SlideDesignPlan {
  slideId: string; layout: string; visualFocus: string; speakerNotes: string;
  textBindings: TextBinding[]; scene: { steps: SceneStep[]; edges: SceneEdge[] } | null;
}
interface OutlineEnvelope { schemaVersion: 1; outline: PptOutline; plan: PresalesPlan }
interface DetailsEnvelope { schemaVersion: 1; specs: SlideSpec[]; designs: SlideDesignPlan[] }
function parseOutlineEnvelope(raw: unknown, analysis: SourceAnalysis): OutlineEnvelope;
function parseDetailsEnvelope(raw: unknown, outline: OutlineEnvelope, analysis: SourceAnalysis): DetailsEnvelope;
```

These are model draft envelopes: no model-computed hashes or claims of approval. Runtime-derived binding text hashes and native authority snapshots belong to the next persistence increment. Inputs are cloned; no mutation or frozen approval metadata is returned. Stage rules must not ask the model for unsupported fields.

- [x] **Step 1: Write regression tests with literal synthetic fixtures.**

```ts
it('rejects a scene referencing an absent binding instead of silently dropping it', () => {
  const draft = scenarioDetails();
  draft.designs[0]!.scene!.steps[0]!.responseRef = 'absent';
  expect(() => parseDetailsEnvelope(draft, scenarioOutline(), sourceAnalysis()))
    .toThrow(/responseRef/);
});
it('rejects notes as a visible text binding', () => {
  const draft = scenarioDetails();
  draft.designs[0]!.textBindings[0]!.path = '/speakerNotes';
  expect(() => parseDetailsEnvelope(draft, scenarioOutline(), sourceAnalysis()))
    .toThrow(/path/);
});
```

Also test full valid roundtrip, input immutability, extra fields, duplicate IDs, mismatched page order/title/count, dangling modules, architecture/overview missing a module, module never covered by a later module/scenario page, invalid source findings, unsupported scene edges/self edge, scene module outside page membership, numeric/negative/out-of-range paths, unknown source IDs, body strings vs arrays, NaN/chart/table width, too many pages and excessive payload. Empty optional collections allowed; architecture and overview both allowed when explicitly present in approved outline. No speculative semantic guessing from text.

- [x] **Step 2: Run focused tests and verify missing implementation fails.**
- [x] **Step 3: Implement strict bounded validation.**

Object keys allowlisted with prototype-safe lookups. Maximum 100 pages, 100 modules, 100 text bindings/scene steps per page, 400 scene edges; max envelope UTF-8 bytes 2 MiB; individual descriptive string 20,000 chars. IDs use existing strict identifier validation. Title/body/table/header/row/chart category/series name and numeric value/shape text paths only, using exact index syntax without leading zero/negative/escaped prototype segments. Every scene reference resolves to one binding whose path points to a supported visible leaf. Every visible leaf has exactly one binding (including numeric chart values), with stable IDs local to the page; no path duplication. Scene roles/location are illustrative design data; no additional text is implied on screen. Validation checks existing strict SlideSpec shapes, numbers, sources and exact outline agreement without legacy normalization that could hide defects.

Keep helpers private unless another production module consumes them. `resolveVisibleBindings(spec, design)` may be public only for Task 3 consumption and returns `{id,path,text}[]`, where chart numbers are formatted with String without changing the source number.

- [x] **Step 4: Run focused tests, worker typecheck/lint, then commit task files.**

### Task 3: Explicit opt-in planning prompts and approved-scene rendering

**Files:** Create `apps/worker/src/presales/planning.ts`, `planning.test.ts`. Modify `apps/desktop/src/ppt-prompts.ts` and its test; modify `apps/worker/src/visual-prompt.ts` and its test.

**Interfaces:**

```ts
interface PresalesPromptOptions { outline?: OutlineEnvelope }
function buildPresalesStageInstructions(stage: 'outline' | 'details'): string;
function buildPresalesVisualContext(spec: SlideSpec, design: SlideDesignPlan): object;
// Existing signatures retain optional opt-in arguments; defaults preserve legacy behavior.
buildPptPrompt(pipeline, stage, style?, presales?: PresalesPromptOptions): string;
// PageVisualPromptRequest adds optional designPlan?: SlideDesignPlan.
```

DesignPlan here is validated data supplied by the later trusted native loader; builder validation is defense-in-depth, not approval authorization. No live adapter opt-in before native snapshot/approval integration. The actual shared builders, not disconnected previews, implement the new branch so future callers cannot duplicate instructions.

- [x] **Step 1: Write tests exercising output payloads from the real builders.**

```ts
it('keeps speaker notes out of the image request and resolves approved scene text once', () => {
  const { spec, design } = approvedScene();
  design.speakerNotes = 'INTERNAL_NOTE_NOT_FOR_IMAGE';
  const prompt = buildPageVisualPrompt({ slideId: spec.id, spec, designPlan: design });
  const payload = JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n{') + 2));
  expect(payload.approvedSlideSpec.body).toEqual(['告警建单', '派单', '到场处理', '验收关闭']);
  expect(prompt).not.toContain('INTERNAL_NOTE_NOT_FOR_IMAGE');
  expect(payload.approvedDesign.scene.steps[0].actionRef).toBe('body-0');
});
```

Test details opt-in rejects missing/mismatched approved outline context, analysis remains unchanged and contains no presales instructions, correct schema/stage only, legacy requests omit new metadata, two callers with same inputs yield identical request, no source/pipeline mutation, invalid binding fails before output, palette precedence preserved, and malicious notes/brief cannot introduce second on-screen copy in the opt-in branch.

- [x] **Step 2: Run focused tests and verify desired behavior fails before code.**
- [x] **Step 3: Build contracts and data sections explicitly.**

The outline branch requests OutlineEnvelope; details requests DetailsEnvelope and includes validated PresalesPlan, not the shared legacy ARRAY contract. Reuse existing project input and source security instructions. Render schema examples as text, not extra unvalidated fields. Include skill id/version/hash in the actual request. Visual opt-in uses the existing exact approved content JSON, a reference-only scene graph, layout/visual-focus and instruction snapshot; omit speaker notes and historical recovery supplement from the model payload. Keep legacy visual builder byte behavior for absent designPlan. In presales details do not inject the legacy rule that asks for concept labels to be repeated inside brief.

- [x] **Step 4: Run worker and desktop focused tests, all TS suites, typecheck/lint, desktop build. Forward-evaluate synthetic goals/architecture/scene requests with and without rules; report structure and semantic issues, not an unrendered claim of beauty.**
- [x] **Step 5: Commit and record this increment as foundation complete, live native/UI integration still pending.**

## Self-review and verification record

- Task 1 → Task 3: generated string bundle is portable; runtime never reads the skill directory.
- Task 2 → Task 3: raw model envelopes are not approvals; builders validate references but cannot authorize generation.
- Shared SlideSpec remains unchanged; bindings and notes are companion data.
- All tasks preserve current user data and legacy workflows. Remaining native persistence, visual UI, queue and export requirements are explicitly tracked above and in the full design.
- Task completion evidence belongs in this plan's SDD progress ledger and a committed QA note; do not claim the overall feature finished.

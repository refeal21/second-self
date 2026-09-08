# Real visual generation repair implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Generate Current Page invoke the installed Codex ImageGen capability and retain progress/results/errors across route navigation.

**Architecture:** The desktop adapter owns the initialized App Server connection and project generation registry. Capture typed image-generation events in a dedicated runner, then send validated PNG bytes to the existing Worker visual replacement action and Rust atomic checkpoint commit. Do not pretend the Worker environment flag proves a running provider exists.

**Tech Stack:** Existing Tauri 2, Rust, React/TypeScript, Vitest, pnpm; no added external services.

**Spec:** User-approved repair on 2026-09-08: repair real image connection and cross-page progress/error display; preserve approved project content and manual page approvals.

## Global Constraints

- Use the current ChatGPT login and Codex App Server; no API key configuration or paid API fallback.
- Do not mutate the real customer project during development or automatically approve any page.
- Generate only the requested current page with frozen details; preserve approved titles, text, data, sources and approvals.
- Route navigation must not cause another model call or lose running/failure/result state. Application exit is not promised to continue a job.
- Only a matching image-generation item plus successful matching terminal turn may produce a persisted candidate. Never trust assistant prose as image evidence.
- Use the existing canonical workspace and Rust atomic commit boundary; never import arbitrary model-returned paths.
- Run tests before and after changes. Real generation evidence is separate from scripted protocol tests.

## Verified protocol

Installed `/Applications/ChatGPT.app/Contents/Resources/codex` is 0.153.4. Read-only `modelProvider/capabilities/read {}` returns `imageGeneration: true`. Generated schema defines `item/completed` with `item.type = imageGeneration`, `result: string`, optional `savedPath`, and `failure: {type: usageLimitExceeded, limitId, resetsAt} | null`. No direct image-generation RPC exists. Capability support does not guarantee quota or generation success. Official references: https://learn.chatgpt.com/docs/app-server and https://learn.chatgpt.com/docs/image-generation.

### Task 1: App Server image runner and production adapter integration

**Files:** Create `apps/worker/src/codex-image-turn.ts` and its test. Modify `app-server.ts` / tests, `apps/desktop/src/desktop-adapter.ts` / tests, `project-generation.ts` / tests, `apps/worker/src/sidecar-rpc.ts` / tests. Extract shared prompt building from `visual-generation.ts` to a browser-safe module if needed (no PNG/Buffer runtime imports in the webview).

**Interfaces:**

```ts
interface CodexImageTurnRequest {
  cwd: string;
  prompt: string;
  onProgress?: (message: string) => void;
}
interface CodexImageTurnResult { imageBase64: string }
// Browser-safe: no Node built-ins or filesystem access.
// CodexImageTurnRunner(client).generate(request): Promise<CodexImageTurnResult>
// ProjectGeneration adds kind 'visual', optional progress: string, and
// updateProgress(projectId, message): void for the current running operation.
```

- [ ] Write failing tests through real client+transport double: capability false/malformed, real image item retained until turn completed, other thread/turn ignored, notifications before turn/start response, quota error, turn failure after image, no image, multiple images, exit, timeout and cleanup. Derive PNG fixture independently, assert no candidate on each failure.
- [ ] Run `pnpm --filter @digital-twin/worker test` and focused desktop tests; record expected RED.
- [ ] Add capability method and a dedicated ephemeral image thread (read-only sandbox, no execution approvals automatically granted). Generate using native ImageGen only; no shell/API substitutes. Match thread and turn, handle early events, bounded total timeout with best-effort turn interruption; reject unsupported/malformed output, oversized base64, error terminal, absent/multiple images. Use conservative metadata `full_slide_reference`, `textFree: false`; exact decode/dimension validation remains Worker-owned.
- [ ] Wrap `requestVisual` in `generations.run(projectId, 'visual', ...)` before the first await. Enforce edit lock, current slide and frozen spec before any model request. Supply authoritative approved-spec prompt and feedback, run image turn, report saving progress, apply `visual.replace` against the captured original revision. On commit uncertainty re-read exact proposed checkpoint before reporting success; never retry model generation automatically. Legacy `regenerateSlide` must route through this path. Remove environment-only claims of provider availability in the standalone Worker; retain its explicit capability-unavailable fallback for callers without a runner.
- [ ] Run all Worker and desktop tests, typecheck and lint once; commit only owned files. Report precise RED/GREEN commands and remaining risks.

### Task 2: Visual generation interaction feedback

**Files:** `apps/desktop/src/native-workspace.tsx`, its tests or a focused visual-generation test, and `styles.css` only if necessary.

**Consumes:** `ProjectGeneration.kind = visual`, optional `progress`, existing `getProjectGeneration`/`subscribeProjectGeneration` and `requestVisual` methods. Do not edit registry or adapter (Task 1 owns them).

- [ ] Write a rendered React regression test using real registry plus delayed external operation. Click Generate, unmount/remount, assert disabled generating button and retained progress; finish and assert candidate display/read. Failure after navigation must be visible on return with explicit retry. No second invocation on navigation or duplicate click.
- [ ] Run focused test and record expected RED.
- [ ] Include visual stage in generation labels and stage matching (including blocked visual recovery). Show running progress and elapsed time derived from startedAt, with no invented percentage. Add visible idle text explaining current stage is waiting for generation and approval requires a PNG. Preserve previous candidate on retry failure, disable approval/replacement/regeneration during active work. Label success only after candidate persistence. Keep long prompt/technical JSON in an expandable section so status and actions remain accessible.
- [ ] Run focused tests, desktop suite and typecheck after Task 1 integration; commit owned files and report RED/GREEN.

### Task 3: Verification and delivery

**Files:** A scoped acceptance report under `docs/`; generated bundles and QA evidence under ignored `artifacts/`.

- [ ] Review Task 1 and Task 2 diffs for spec and code quality, then full branch review after corrections.
- [ ] Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `cargo fmt --check --manifest-path apps/desktop/src-tauri/Cargo.toml`.
- [ ] In a temporary synthetic workspace, run the production image runner against installed Codex using existing ChatGPT authentication; never read/copy tokens, never run on customer data. Validate actual PNG payload, then feed it through production Worker and verify candidate remains unapproved. Bound run duration; report real capability/network/quota blocks without invented success.
- [ ] Run browser interaction QA at wide and narrow sizes using existing Playwright fallback (Browser plugin unavailable). Verify route return, running/error/idle states and manual approval only. Do not touch the running customer app.
- [ ] Build new `.app` with a separate Cargo target directory; never overwrite or quit the existing running bundle. Record evidence, exact bundle path, real-generation outcome and any remaining limitation. Push tested source under the user's standing repository authorization only after review.

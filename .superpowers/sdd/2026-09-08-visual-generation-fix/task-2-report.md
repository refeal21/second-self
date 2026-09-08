# Task 2 report: visual generation interaction feedback

## Outcome

- Added visual generation lifecycle feedback to the native workspace: registry progress, elapsed time derived from `startedAt`, visual running/success/retry labels, and visual-stage error matching including recoverable blocked state.
- Kept generation single-flight across route unmount/remount and disabled generation, upload, approval, and feedback controls while work is active.
- Added an explicit idle explanation that approval requires a persisted, inspectable PNG. The long per-slide technical prompt is collapsed behind a disclosure.
- Completion text now says the visual candidate was generated and saved only after the adapter promise and registry completion deliver the persisted candidate. A failed replacement retains the previous PNG and exposes the scoped error.
- No API-key path, fallback provider, approval/spec mutation, model call, app restart, or customer-data mutation was added. `styles.css` did not need a change.

## TDD evidence

RED (after adding the rendered real-registry/delayed-operation fixtures, before production edits):

```text
pnpm --filter @digital-twin/desktop test -- native-generation-review.test.tsx
FAIL src/native-generation-review.test.tsx: 3 failed
- missing `正在生成当前页…` action label
- missing `重试生成当前页` after an off-page failure
- missing idle PNG explanation / technical-prompt disclosure
```

GREEN (final focused run):

```text
cd apps/desktop
pnpm exec vitest run src/native-generation-review.test.tsx src/native-workspace.test.tsx
Test Files  2 passed (2)
Tests       31 passed (31)
```

The focused fixture uses the real `ProjectGenerationRegistry`, a delayed external promise boundary, and `updateProgress`. It proves retained progress and derived `1 分 5 秒` elapsed time after remount, no duplicate invocation, off-page completion plus candidate read, blocked-stage failure replay plus explicit retry, preservation of an earlier PNG on replacement failure, and disabled mutation controls during active work.

## Verification

```text
cd apps/desktop
pnpm typecheck
exit 0

pnpm lint
exit 0

pnpm test
Test Files  27 passed (27)
Tests       266 passed (266)
```

## Files

- `apps/desktop/src/native-workspace.tsx`
- `apps/desktop/src/native-generation-review.test.tsx`
- `.superpowers/sdd/2026-09-08-visual-generation-fix/task-2-report.md`

## Remaining concerns

- Browser plugin/browser skill was not available in this agent context, and the root task explicitly owns actual browser QA. No Playwright harness or live-app restart was created here; root has prepared `/tmp/second-self-visual-fix.XtAa5V/browser-qa.mjs` for final rendered validation after Task 1 integration.
- Elapsed time is intentionally wall-clock display only; it does not invent percentage progress and does not promise generation persistence across a full desktop-app exit.

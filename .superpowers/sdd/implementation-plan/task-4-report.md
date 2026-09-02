# Task 4 report — production desktop UI

## Outcome

Task 4 delivers the React/Tauri desktop workbench for the six required product views: dashboard, general tasks, PPT projects, approval center, preference memory, and settings. The PPT project opens a complete workspace with the fixed seven-stage workflow, five-slide navigator, code-native 16:9 preview, source/progress inspector, review comment, reopen, regenerate, approve-next, and export actions.

Every primary navigation item, button, and form now reaches typed local state, the desktop adapter, or a visible error/status response. Browser builds select an explicitly labeled deterministic demo adapter. Tauri builds use the existing Codex App Server transport for account and general-task operations; future PPT/memory/settings commands pass through the adapter boundary and surface Tauri command errors instead of silently succeeding.

## Implementation

- `App.tsx` composes the six views and PPT workspace, state-based hash navigation, browser-history behavior, live status/error feedback, semantic landmarks, labeled controls, and a small consistent outline icon set.
- `desktop-adapter.ts` defines typed account, task, project, review, export, memory, and settings contracts. It provides deterministic demo behavior and a Tauri implementation backed by the existing JSONL Codex transport plus explicit command calls.
- `styles.css` implements the approved white/cool-neutral design system, 240px dashboard shell, dashboard activity rail, concept-driven rows/tables, PPT workflow/canvas/inspector columns, visible focus, reduced motion, and Chinese typography.
- At 900–1279px the primary navigation collapses while the PPT inspector remains usable. Below 900px the PPT workflow, canvas, and review inspector become three keyboard-accessible tabs with one visible panel and no page-level horizontal overflow.
- General-task approval changes the local run out of `waiting_for_approval`; approval-center decisions remove handled rows; memory decisions persist visible state; project creation opens the named project; settings/export/review actions all acknowledge completion or display adapter errors.

## TDD evidence

The inherited worktree already contained an uncommitted partial UI when this task was resumed. Its first focused run was green (17/17), while baseline commit `4ab5433` contains only the placeholder `Digital Twin Workbench` entry and no `App.tsx`, so the supplied UI suite is absent/failing against the baseline.

New behavior was then developed with fresh RED/GREEN cycles:

| Behavior | RED evidence | GREEN evidence |
| --- | --- | --- |
| General-task approval advances real UI state | focused desktop run: 1/20 failed because the `批准继续` control remained present | focused run: 20/20 passed after updating task status/transcript and visible notice |
| Compact PPT panel tabs | focused desktop run: 1/21 failed because no `幻灯片画布` tab existed | focused run: 21/21 passed after workflow/canvas/review tab state was added |
| Navigation, project creation, regenerate/approve, memory decision, adapter error, export acknowledgement, approval center, and settings | component suite exercises the real `App` and demo adapter | final desktop suite: 21/21 passed across 3 files |

## Browser visual and interaction QA

Target flow: app loads → dashboard renders → PPT project opens → regenerate and approve advance the slide → narrow-window tabs expose workflow/canvas/review without overflow.

- Browser path: Codex in-app Browser at `http://127.0.0.1:1420/`; no Playwright fallback.
- Viewports: 1536×1024 concept-native, 1440×960 desktop baseline, 820×900 compact workspace, and 390×844 mobile dashboard.
- Page identity and non-blank content passed. No framework overlay or console warning/error was observed.
- 1440px PPT column widths measured `190 / 740 / 310`; document `scrollWidth` equaled `clientWidth`.
- 1536px and 1440px checks confirmed both the slide business content and approve-next button fit their visible regions.
- 820px confirmed only the selected workflow/canvas/review panel is displayed and the document has no horizontal overflow.
- 390px confirmed stacked dashboard activity content and no page-level horizontal overflow.
- Keyboard proof: the skip link received a solid 3px focus outline; mobile icon-only navigation retains accessible names.
- Interaction proof: regenerate produced `已生成候选版本`; approve-next produced `已批准，进入第 4 页` and changed the pager to `04 / 05`.

### Fidelity ledger

| Comparison point | Result |
| --- | --- |
| Dashboard shell, navigation order, hero copy, quick rows, recent-work table, and right activity rail | Matches the accepted dashboard concept and allowed copy |
| Palette, borders, typography, button hierarchy, and outline icon treatment | Matches the design system; no gradients, glow, emoji, or component-library language |
| PPT header, fixed workflow stages, slide list, selected states, sources, progress timeline, comment field, and actions | Matches the accepted workspace concept |
| Slide preview | Kept strictly 16:9 per the task brief; code-native metrics, insights, bars, and trend line remain editable UI rather than a baked screenshot |
| Responsive behavior | Adds the required compact three-tab presentation while retaining the desktop three-column concept |

Material browser findings fixed during QA: the mobile workspace sidebar was incorrectly held at `100vh`; hidden mobile navigation labels removed accessible names; route changes retained stale scroll; desktop slide content and approve-next initially clipped; and compact PPT panels initially stacked into one long page.

## Fresh verification

- Desktop gate: `pnpm --filter @digital-twin/desktop typecheck && pnpm --filter @digital-twin/desktop lint && pnpm --filter @digital-twin/desktop test && pnpm --filter @digital-twin/desktop build` → exit 0; 21/21 tests and Vite production build passed.
- Repository typecheck: `pnpm typecheck` → exit 0 for core, worker, and desktop.
- Repository lint: `pnpm lint` → exit 0 with zero warnings.
- Repository tests: `pnpm test` → exit 0; core 8/8, worker 147/147, desktop 21/21, Rust integration tests 13/13 plus unit/doc suites.
- Browser console at all tested viewports: zero relevant warnings/errors.
- `git diff --check` → exit 0 before report creation and is rerun before commit.

## Residual boundary

Browser QA intentionally uses labeled demo data and does not claim that future PPT/memory/settings Tauri commands already exist. In a Tauri build, an unavailable command is reported to the user as an error through the adapter boundary. Account and general-task transport use the existing Codex App Server command surface. Native macOS visual smoke and final controller screenshots remain release-level follow-ups; the full browser-rendered UI and repository code gates are complete here.

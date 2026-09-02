# Task 4 report — production desktop UI, fix round 1

## Outcome

Task 4 now provides the six required React/Tauri views plus a complete PPT review workspace without allowing browser demo state to masquerade as native state. Browser builds use a visibly labelled deterministic demo adapter. Tauri builds start with unavailable account/runtime and empty project/approval/memory collections until a native capability returns data or an explicit error.

The rejected-review blockers were addressed in one coherent adapter/store pass:

- Native general tasks reuse the existing worker `CodexAppServerClient` and `GeneralTaskManager`. The UI receives App Server assistant deltas, completion, terminal error, token usage, approval, and user-input updates through a task subscription.
- Approval and input responses use the actual App Server JSON-RPC request ID. UI `approve` maps to protocol `accept`, UI `decline` maps to `decline`, and no code path sends request ID `0`.
- Adapter-owned initial state supplies account, runtime, projects, approvals, and memories. Native missing capabilities render unavailable/empty states; demo content and successful demo mutations are explicitly labelled.
- A single reducer owns selected project ID, project goal/name, workflow stage, five page states, approval list, memory decisions, and mutation tokens. This state survives route remounts.
- Page approval updates the approved/current/pending sequence. Page 5 remains page 5 and enters `conversion`/export-ready. Reopening an earlier page clears impossible later completion. Stage history clicks do not mutate the authoritative current stage.
- Project creation requires and preserves both name and goal; project rows select by ID; rename calls the adapter and updates the store.
- PPT approve/regenerate/reopen, export, rename, approval-center, and memory mutations expose pending state. Reducer tokens reject stale PPT/memory responses.
- The workspace skip link resolves to `main#main-content`. Compact tabs use tablist/tab/tabpanel relationships, roving `tabIndex`, ArrowLeft/ArrowRight/Home/End selection, and focus movement.
- The compact workspace breakpoint is `<=955px`; `>=956px` retains the three-column shell. This removes the 900–955px minimum-column clipping while preserving the mid-size desktop layout where it fits.
- The HTML document declares `lang="zh-CN"` and the Chinese title `分身工作台`.

## TDD evidence

| Cycle | RED | GREEN |
| --- | --- | --- |
| Native App Server bridge | 4/4 scripted native tests failed because `createTauriDesktopAdapter` and the event bridge did not exist | 4/4 pass for streaming/completion/usage/error, real string and number request IDs, accept/decline mapping, and user-input answers |
| Single PPT/store state machine | focused suite failed to load the absent `workbench-store` module | 4/4 reducer tests pass for page-5 conversion, reopen rollback, stale PPT/memory tokens, goal preservation, and project-ID selection |
| UI integration | existing project tests failed after goal became required, exposing the outdated test path | updated integration suite is 16/16 and covers required goal, route persistence, real rename, page-5 conversion, pending deduplication, ARIA tabs, skip target, and native unavailable state |

Final desktop suite: 35/35 across transport, native adapter, reducer, development server, and rendered UI tests.

## Browser QA

Flow: `#/workspace` → inspect responsive shell → switch to the review tab → approve page 3 → observe page 4.

- Browser path: Browser plugin controlling the available Chromium session at `http://127.0.0.1:1420/`; no fallback.
- Page identity: URL and Chinese title matched; meaningful PPT content rendered; no framework overlay.
- Console: zero relevant warnings/errors.
- Viewports: 1440×900, 955×900, 900×900, 820×900, and 390×900; extra boundary probes at 901 and 1279.
- Horizontal overflow: at every measured width, `documentElement.scrollWidth === clientWidth`.
- 1440: full `190 / flexible canvas / 310`-style three-column workspace; all panel bounds remain within the viewport.
- 955/900/820/390: compact tabs render and only the selected panel is visible; canvas and review remain usable.
- 901 uses compact mode without clipping. 1279 uses the full three-column mode without overflow.
- Interaction: review tab became selected/visible; approve-next returned `已批准，进入第 4 页`; the console remained clean.

## Fresh verification

- Desktop: `pnpm --filter @digital-twin/desktop test` → 35/35; `lint` → zero warnings; `build` → Vite production build exit 0.
- Repository: `pnpm typecheck` and `pnpm lint` → exit 0 for core, worker, and desktop.
- Repository tests: core 8/8, worker 147/147, desktop 35/35, Rust integration 13/13 plus unit/doc suites.
- `git diff --check` → exit 0.

## Boundary

Native PPT/approval/memory/settings commands remain explicit future Tauri command surfaces. When a command or native data-loading capability is absent, the production UI shows unavailable/empty state or the propagated command error; it does not substitute demo success. Browser QA intentionally exercises the labelled demo adapter and does not claim native IPC persistence.

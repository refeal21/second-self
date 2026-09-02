# Task 4 report — production desktop UI, fix rounds 1–2

## Outcome

Task 4 now provides the six required React/Tauri views plus a complete PPT review workspace without allowing browser demo state to masquerade as native state. Browser builds use a visibly labelled deterministic demo adapter. Tauri builds start with unavailable account/runtime and empty project/approval/memory collections until a native capability returns data or an explicit error.

The rejected-review blockers were addressed in two coherent adapter/store passes:

- Native general tasks reuse the existing worker `CodexAppServerClient` and `GeneralTaskManager`. The UI receives App Server assistant deltas, completion, terminal error, token usage, approval, and user-input updates through a task subscription.
- Approval and input responses use the actual App Server JSON-RPC request ID. UI `approve` maps to protocol `accept`, UI `decline` maps to `decline`, and no code path sends request ID `0`.
- Adapter-owned initial state supplies account, runtime, projects, approvals, and memories. Native missing capabilities render unavailable/empty states; demo content and successful demo mutations are explicitly labelled.
- A single reducer owns selected project ID, project goal/name, workflow stage, five page states, approval list, memory decisions, and mutation tokens. This state survives route remounts.
- Page approval updates only the current waiting page and exposes the immediate next page. Page 5 remains page 5 and enters `conversion`/export-ready. Reopen is legal only for an already-approved page; it preserves earlier states and clears impossible later completion without inferring approvals. Stage history clicks do not mutate the authoritative current stage.
- Project creation requires and preserves both name and goal; project rows select by ID; rename calls the adapter and updates the store.
- PPT approve/regenerate/reopen, export, rename, approval-center, and memory mutations expose pending state. Reducer tokens reject stale PPT/memory responses.
- The workspace skip link resolves to `main#main-content`. Compact tabs use tablist/tab/tabpanel relationships, roving `tabIndex`, ArrowLeft/ArrowRight/Home/End selection, and focus movement.
- The compact workspace breakpoint is `<=956px`; `>=957px` retains the three-column shell. The 957px three-column minimum is `169 + 400 + 310`, exactly matching its available content width and avoiding the former one-pixel crop.
- The HTML document declares `lang="zh-CN"` and the Chinese title `分身工作台`.
- App Server user-input requests render every question header, prompt, option, and description, then submit one answer map covering every question. Empty native projects, approvals, and memories carry explicit unavailable/loading/loaded metadata, so they are never presented as successfully loaded empty results.
- Workspace and Codex paths live in the top-level reducer state, survive route navigation, and are sent to the adapter only on an explicit save.

## TDD evidence

| Cycle | RED | GREEN |
| --- | --- | --- |
| Native App Server bridge | 4/4 scripted native tests failed because `createTauriDesktopAdapter` and the event bridge did not exist | 4/4 pass for streaming/completion/usage/error, real string and number request IDs, accept/decline mapping, and user-input answers |
| Single PPT/store state machine | focused suite failed to load the absent `workbench-store` module | 4/4 reducer tests pass for page-5 conversion, reopen rollback, stale PPT/memory tokens, goal preservation, and project-ID selection |
| UI integration | existing project tests failed after goal became required, exposing the outdated test path | updated integration suite is 16/16 and covers required goal, route persistence, real rename, page-5 conversion, pending deduplication, ARIA tabs, skip target, and native unavailable state |
| Fix round 2 workflow invariants | focused suite rejected reopening a pending future page and direct approval with incomplete predecessors | reducer now rejects both mutations, never auto-approves prior pages, and preserves an intentionally non-approved predecessor |
| Fix round 2 input/collections/settings | focused UI suite failed because only one App Server question was handled, native empty collections looked successful, and settings remounted from local defaults | all questions are rendered/submitted together; collection availability is explicit; settings survive save → away → back |
| Fix round 2 responsive boundary | CSS contract failed because 956px still entered the three-column shell | compact mode includes 956px; 957px starts an exact-fit three-column shell |

Fix round 2 RED: 7 failures across the workflow reducer, rendered UI, and responsive CSS contract. Focused GREEN: 27/27. Final desktop suite: 42/42 across transport, native adapter, reducer, development server, responsive CSS, and rendered UI tests.

## Browser QA

Flow: `#/workspace` → inspect responsive shell → switch to the review tab → approve page 3 → observe page 4.

- Browser path: Browser plugin controlling the available Chromium session at `http://127.0.0.1:1420/`; no fallback.
- Page identity: URL and Chinese title matched; meaningful PPT content rendered; no framework overlay.
- Console: zero relevant warnings/errors.
- Viewports: 1440×900, 955×900, 900×900, 820×900, and 390×900 in round 1; fix round 2 added exact boundary probes at 956×900 and 957×900.
- Horizontal overflow: at every measured width, `documentElement.scrollWidth === clientWidth`.
- 1440: full `190 / flexible canvas / 310`-style three-column workspace; all panel bounds remain within the viewport.
- 956/955/900/820/390: compact tabs render and only the selected panel is visible; canvas and review remain usable.
- 901 uses compact mode without clipping. 1279 uses the full three-column mode without overflow.
- 957 restores all three columns at measured widths `169 / 400 / 310`; both layout and document scroll widths equal their client widths. Page 5 is still pending and its `重新打开` action is disabled.
- Interaction: review tab became selected/visible; approve-next returned `已批准，进入第 4 页`; the console remained clean.

## Fresh verification

- Desktop: `pnpm --filter @digital-twin/desktop test` → 42/42; `lint` → zero warnings; `typecheck` and Vite production build → exit 0.
- Repository: `pnpm typecheck` and `pnpm lint` → exit 0 for core, worker, and desktop.
- Repository tests: core 8/8, worker 147/147, desktop 42/42, Rust integration 13/13 plus unit/doc suites.
- `git diff --check` → exit 0.

## Boundary

Native PPT/approval/memory/settings commands remain explicit future Tauri command surfaces. When a command or native data-loading capability is absent, the production UI shows unavailable/empty state or the propagated command error; it does not substitute demo success. Browser QA intentionally exercises the labelled demo adapter and does not claim native IPC persistence.

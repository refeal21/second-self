# SDD ledger — plan: docs/implementation-plan.md

## Preflight

Ruling: 当前目录是宿主为本任务提供的全新空目录且没有既有 Git 历史，因此直接在 `feature/digital-twin-mvp` 初始化，而不再嵌套创建 worktree — 仍满足不在 main/master 开发的约束 — 若判断错误，代价是缺少额外的工作树隔离，但不会覆盖用户既有代码。

| Tasks | Producer → consumer | Check |
| --- | --- | --- |
| 1 → 2 | workspace/types/process/database foundation → Codex adapter | compatible; protocol stays behind Worker interface |
| 1 → 3 | workflow/version/path primitives → PPT workflow | compatible; approval transition is the shared contract |
| 1 → 4 | typed Tauri commands/events → UI | compatible; UI must not invent a parallel state model |
| 1 → 5 | scripts/build/test foundation → integration | compatible |
| 2 → 3 | Codex turn/skill execution → AI analysis and visual requests | compatible; ImageGen absence must block explicitly |
| 2 → 4 | auth/thread/events → general-task UI | compatible |
| 2 → 5 | mockable protocol boundary → E2E | compatible |
| 3 → 4 | PPT project state/artifacts → three-column workspace | compatible |
| 3 → 5 | exporter/QA → golden project | compatible |
| 4 → 5 | production UI → browser/Tauri E2E | compatible |

| Task | Internal consistency |
| --- | --- |
| 1 | Tests named before domain implementation; scaffold/config is generated setup. |
| 2 | Stable App Server surface only; ChatGPT browser login, never API-key login. |
| 3 | Image-first approval and editable export are complementary; approved spec is the text authority. |
| 4 | Two accepted concept images and documented copy/tokens define fidelity. |
| 5 | Automated LibreOffice validation plus documented Keynote manual check; no claim of PowerPoint verification. |

Ruling: Image generation is modeled as a Codex skill/tool capability invoked through a turn, not as an undocumented App Server RPC — official App Server exposes generic turn inputs/events, while ImageGen availability may vary — if wrong, the adapter may need one additional protocol mapping without changing the workflow.

Task 1: Ruling: “不开放 HTTP 端口”约束适用于打包应用与本地后端/API，开发期 Vite 仅绑定回环地址用于热更新和浏览器视觉 QA — Tauri 官方开发链依赖 dev server，而生产 `frontendDist` 内嵌静态资源 — 若解释错误，代价是需要改为每次开发前静态构建并放弃 HMR；实现中仍需明确生产不监听端口。

Task 1: minor (deferred): SQLite 状态字段当前为 TEXT，缺少 CHECK 约束；交由最终全分支审查结合迁移策略判断。

Task 1: fix round 1/5 (4 addressed, 1 open — Rust guard still collapses `symlink/..` lexically and lacks broken-symlink coverage; commits 22df2fe..5bfc130)

Task 1: minor (deferred): Tauri `devUrl` 使用 `localhost`，而 Vite 绑定 `127.0.0.1`，IPv6-first 解析器下可能连接失败。

Task 1: fix round 2/5 (1 addressed, 0 open — component-wise symlink resolution and broken-link fail-closed; commits 5bfc130..38cd1ca)

Task 1: minor (deferred): macOS MVP 已覆盖 Unix 符号链接；没有 Windows 等价回归测试。

Task 1: minor (deferred): 未来真正执行写入时仍需采用受控文件句柄/原子写策略，缩小校验后符号链接被交换的 TOCTOU 窗口。

Task 1: complete (commits bd24914..38cd1ca, review clean)

Task 2: Ruling: 保留 App Server wire 枚举 `on-request` / `workspace-write` — 本机 0.151.0-alpha.7.2 生成类型明确给出连字符值，且 ephemeral live probe 显示驼峰 `onRequest` 被 `-32600 unknown variant` 拒绝、连字符请求成功 — 官方网页示例与安装版本发生漂移；若未来版本改回驼峰，代价是适配器需依据生成 schema 升级并更新协议测试。

Task 2: minor (deferred): 用户配置的相对 Codex 路径应在检查后规范化，避免检查与 `Command::new` 解析目标不一致。

Task 2: fix round 1/5 (2 addressed, 2 open — turnless error cleanup and immediate-start exit race; commits d3de544..73d6c70)

Task 2: Ruling: `account/updated` 继续按平铺 `{ authMode, planType }` 解码 — 本机生成的 `v2/AccountUpdatedNotification.ts` 与官方 0.151 文档都定义该平铺结构，审查者提出的 `{ account }` 结构不属于目标协议 — 若未来协议改为 account 对象，代价是登录状态适配器需要随生成类型升级并添加兼容分支。

Task 2: fix round 2/5 (2 addressed, 0 open — fail-closed error turn IDs and startup event replay; commits 73d6c70..90faf09)

Task 2: minor (deferred): Rust shell fixture 曾出现一次 2 秒超时，随后隔离与两次全量运行通过；最终集成阶段评估是否提高测试超时或改用更确定的 fixture 同步。

Task 2: complete (commits 38cd1ca..90faf09, review clean)

Task 3: review rejected commit 57c5882 (7 blocking findings: symlink/identifier write escape; unbound export/QA/spec provenance; duplicate slide-ID approval bypass; ineffective blank-page detection; unrestricted LibreOffice inputs/process side effects; missing AI-output provenance/schema integrity; inexact ImageGen capability/CWD boundary. Additional P2 concurrency and mixed-case extension defects are included in the same fix round.)

Task 3: Ruling: all P0/P1 review findings and the directly related P2 concurrency/extension defects are fixed before UI work rather than deferred to Task 5 — these are workflow/security invariants consumed by later tasks — if this expands Task 3 more than necessary, the cost is implementation time now; deferral would risk building UI and E2E on an invalid evidence chain.

Task 3: fix round 1/5 rejected (original path/identity/blank-page/OOXML issues mostly addressed, but 7 blockers remain: reflection-importable commit symbols permit full evidence forgery; delivery does not use repairs or resume QA; citations escape the analyzed source set; workspace-root parent symlink escape; public capability resume; non-atomic QA report persistence; concurrent analysis orphan artifacts. Related process byte/group and schema/visual-audit gaps included in round 2.)

Task 3: Ruling: replace symbol-based “internal” authority with a non-exported composition-root closure rather than treating package-internal imports as trusted — future UI/modules run in the same process and accidental or malicious deep imports must not bypass approval provenance — if this boundary is stricter than needed, the cost is a larger refactor; the alternative is a demonstrably forgeable completed state.

Task 3: fix round 2 implementation complete pending review (commits 073a936..ff06922; production composition facade, factory-local QA attestation, authoritative repair/resume, exact analyzed source provenance, parent-symlink rejection, atomic/idempotent QA receipt, shared source request rollback, process-group/byte limits, nested schema/PNG/user-audited visual validation).

Task 3: fix round 2/5 rejected (5 P1: prototype load-order can poison production QA call; timeout root close cancels group KILL; malformed ImageGen result can mutate state; committed QA bundle is not replayed on recovery; post-commit source writes cannot be adopted. 2 P2 repair same-path/current-receipt and SourceDataPoint unit gaps included in round 3.)

Task 3: Ruling: committed QA/report and source artifacts are authoritative idempotency records and must be validated/replayed before new external work — environment changes after a crash must not make recovery impossible — if replay validation is too permissive, stale data could be accepted, so every project/version/hash/round binding is checked exactly.

Task 3: fix round 3 implementation complete pending review (commit 1b2ff97; exact ImageGen union, load-order-stable private QA entry, guaranteed group KILL fallback, validated QA bundle replay, post-commit byte adoption, repair new-path/current-receipt checks, remaining source schema closure).

Task 3: fix round 3/5 rejected (2 P1 in persisted QA replay: report bindings were checked without semantic status/page invariants, and current export bytes were not re-read/re-hashed before replay signing).

Task 3: Ruling: first-version process-local evidence protects against accidental corruption and invalid in-app mutation, not a local machine owner deliberately rewriting all artifacts and recomputing unkeyed metadata — semantic validation plus exact current-export rehash is required now; durable keyed trust, if needed, belongs with Task 5 persistence/key management — if this threat assumption is wrong, local filesystem compromise could still manufacture a coherent report, requiring a Keychain-backed MAC design.

Task 3: fix round 4 implementation complete pending scoped review (commit 65c881f; persisted QA semantic invariants and current export path/length/hash revalidation before replay signing).

Task 3: fix round 4/5 scoped review: current-export replay revalidation resolved; one P1 remains because rendered/comparison paths could be empty or outside the expected QA run while satisfying equality/count checks.

Task 3: Ruling: QA output paths are treated as part of the signed execution evidence and must resolve to the exact project/round output filenames, not merely match each other — if renderer naming changes, the validator and renderer contract must be upgraded together; accepting arbitrary matching strings would make replay evidence meaningless.

Task 3: fix round 5/5 implementation complete pending final scoped review (commit 4ab5433; exact project/round PDF and ordered rendered/comparison path binding, including failed/blocked path validation).

Task 3: complete (commits 90faf09..4ab5433, final scoped review approved; residuals: Node parent TOCTOU defense-in-depth moves to Rust production binding, process-restart rehydration to Task 5, no live ImageGen/PowerPoint/Keynote claim yet).

Task 4: Ruling: UI 使用显式 `DesktopAdapter` 边界同时支持真实 Tauri 调用与浏览器演示数据 — 浏览器演示只用于开发视觉验收，所有可变操作都返回明确的演示状态，不能伪装成桌面后端成功 — 若适配器边界泄漏，代价是生产界面可能显示未持久化的假状态，因此集成阶段必须让 Tauri 环境完全替换演示适配器。

Task 4: controller visual QA passed at 1440×960, 820×900 and 390×844 — dashboard and PPT workspace match accepted concept structure/palette; PPT seven-stage flow, five-page list, approval timeline, source list, comments and actions remain usable; responsive tab panels prevent column overflow; tested regenerate and approve-next transitions; no browser console errors and no document horizontal overflow.

Task 4: fidelity ledger — dashboard shell/navigation/hero/quick-start/recent-work/right rail matched; PPT header/workflow/slide canvas/inspector/sources/approval controls matched; code-native 16:9 preview and restrained indigo/green visual system matched; copy differences are product wording rather than structural deviations; skip-link focus treatment is intentionally visible for keyboard accessibility.

Task 4: review rejected commit 9d58dc2 (native tasks ignored App Server events and responded with ID 0; Tauri rendered demo success; PPT/project/approval/memory state diverged or reset; 900–955 clipped; project goal/ID/rename and mutation concurrency were incomplete; skip target/tabs/title were incomplete).

Task 4: Ruling: native general tasks reuse the reviewed worker `CodexAppServerClient` and `GeneralTaskManager`, with a thin UI subscription adapter, instead of inventing another JSON-RPC lifecycle — this preserves the actual server request ID and the worker's stale turn/request guards — if worker task contracts change, the desktop mapping must be upgraded with its scripted bridge tests.

Task 4: Ruling: Tauri initial account/runtime/projects/approvals/memories are unavailable or empty until a native capability returns data; only the browser demo adapter owns deterministic sample success — if a native snapshot command is added later, it replaces the unavailable seed without changing view contracts.

Task 4: Ruling: one app-level reducer is authoritative for project identity/goal/name, workflow stage, five-page approval sequence, approval-center rows, and memory decisions — route components receive state and dispatch rather than creating local copies — if backend rehydration arrives in Task 5, it must hydrate this same contract rather than add a parallel state model.

Task 4: Ruling: approving page 5 clamps selection to page 5 and advances the workflow to editable conversion/export-ready; reopening an earlier page demotes that page to waiting and all later pages to pending; stage-history clicks are read-only — this prevents impossible later completion from surviving workflow rollback.

Task 4: Ruling (superseded by fix round 2): compact panel mode originally began at 955px, but the review boundary probe showed 956px must also remain compact; the authoritative boundary is now recorded below.

Task 4: Ruling: project creation requires both name and goal, selection is by persisted adapter ID, and rename is an adapter mutation with pending/error UI; the previous explanatory no-op control is removed.

Task 4: Ruling: PPT approve/regenerate/reopen and memory actions use reducer mutation tokens plus disabled pending controls; a response whose token is no longer current is ignored — export and rename use equivalent per-control pending exclusion because they do not update page/memory state.

Task 4: Ruling: compact workspace tabs implement tablist/tab/tabpanel ownership, roving tabindex, arrow/Home/End focus movement, and a real `main#main-content` skip destination; the document language/title are Chinese.

Task 4: fix round 1 implementation complete pending review (native adapter scripted tests 4/4; store tests 4/4; desktop 35/35; core 8/8; worker 147/147; Rust integration 13/13; repository typecheck/lint/build green; Browser QA at 1440/955/900/820/390 plus 901/1279 shows zero horizontal overflow and zero console warnings/errors).

Task 4: fix round 2 review rejected fix round 1 (pending future slides could be reopened/skip prior pages; App Server input rendered only the first question; native empty collections looked successfully processed; settings remounted; 956px missed compact mode).

Task 4: Ruling: reopening is valid only when the target page is currently `approved`; reducer start and resolution both revalidate that exact state, preserve earlier page states, and never synthesize approval for predecessors — malformed or stale mutations become no-ops rather than repairing the workflow by inference.

Task 4: Ruling: a user-input request is one atomic App Server interaction containing all questions; the UI renders every header/question/option/description, requires one answer per question, and sends a single answer map keyed by every question ID.

Task 4: Ruling: native project/approval/memory collections have explicit `unavailable | loading | loaded` metadata independent of array length — an unavailable empty collection must say unavailable, while success-empty wording is reserved for `loaded`.

Task 4: Ruling: workspace/Codex settings belong to the app-level store and survive route remounts; explicit save calls the adapter with that durable draft rather than rebuilding defaults inside the settings page.

Task 4: Ruling: compact panel mode includes 956px and the full shell starts at 957px with exact-fit `169 + 400 + 310` columns — browser measurements require both document and workspace scroll widths to equal client widths at the boundary.

Task 4: fix round 2 implementation complete pending review (RED 7 failures → focused GREEN 27/27; desktop 42/42 plus lint/typecheck/build green; Browser QA 956 compact and 957 exact-fit three-column with no horizontal overflow; pending page 5 reopen disabled; repository typecheck/lint green; core 8/8, worker 147/147, desktop 42/42, Rust integration 13/13 plus unit/doc suites; `git diff --check` green).

Task 4: fix round 3 review found one scoped loaded-empty rendering defect: `MemoryPage` distinguished unavailable/loading from loaded, but the loaded collection with zero entries rendered a blank section.

Task 4: Ruling: collection availability and collection cardinality are independent UI states — `loaded + []` renders the explicit successful empty state `当前没有偏好记忆。`, while unavailable/loading retain their honest status messages.

Task 4: fix round 3 implementation complete pending review (focused RED 1 failure → GREEN 1/1; desktop 43/43; desktop lint/typecheck/build and `git diff --check` green).

Task 5: Ruling: package the TypeScript workflow Worker as a Node Single Executable Application behind Tauri `bundle.externalBin` — this preserves the reviewed TypeScript implementation while removing any separately installed Node.js runtime requirement; the Apple Silicon sidecar is approximately 106 MiB and is rebuilt for the active Rust host triple — if the SEA mechanism changes in a future Node release, only the repeatable sidecar build script and packaging adapter need replacement.

Task 5: Ruling: Rust remains the sole durable authority for project/settings/approval/preference/checkpoint state and workspace writes; the browser demo adapter never performs asynchronous hydration, while the Tauri adapter starts the supervised sidecar and replaces its unavailable bootstrap state from SQLite — this prevents browser sample data from appearing as native success and prevents hydration races from overwriting in-session demo edits.

Task 5: Ruling: actual artifact writes use directory-file-descriptor traversal with `openat(O_NOFOLLOW)`, same-directory temporary files, `fsync`, and atomic `renameat` — a prior path string validation remains useful for diagnostics but is not treated as the write authorization boundary; macOS/Unix is the MVP target.

Task 5: Ruling: ImageGen absence is a typed capability result and an explicit recoverable project error with `billedApiFallback: false`; native regeneration persists the visual-review checkpoint notice and never substitutes an OpenAI API-key client or a fake visual.

Task 5A checkpoint implementation complete pending commit (Worker JSON-RPC 5/5 plus process integration 2/2 including controlled crash/restart; core 8/8, Worker 154/154, desktop 45/45, Rust 17/17; repository typecheck/lint, Rust fmt, desktop production build, SEA rebuild/smoke, and `git diff --check` green). Task 5B remains: deterministic Golden Project, real delivery export/LibreOffice evidence, live Codex read-only smoke, app bundle/launch/memory/network audits, and operational/license documentation.

Task 5: Ruling: the committed Golden fixtures are regenerated with fixed ZIP entry dates and manifest SHA-256/byte-length bindings — this makes PDF, CSV, PNG and style-reference PPTX byte-stable across repeated generator runs instead of treating a checked-in but time-varying PPTX as deterministic — if PptxGenJS/JSZip changes its archive format, the manifest test will fail and require an intentional fixture refresh.

Task 5: RED → GREEN: the first packaged production launch with a Worker health handshake failed visibly with `Command plugin:event|listen not allowed by ACL`; a main-window capability now grants only Tauri event listen/unlisten, and the rebuilt `.app` starts its embedded Worker and completes `system.health` over newline JSON-RPC. A second RED exposed non-`Error` Tauri failures being collapsed to a generic UI message; string errors are now displayed verbatim.

Task 5: Ruling: headless LibreOffice on macOS receives a project-local Fontconfig file pointing at system font directories and the exporter uses `Hiragino Sans GB` — the first real render exposed square glyphs even though page-count/blank checks passed, so all five pages were re-rendered and visually inspected after the fix — if a target Mac lacks this system font, QA blocks rather than silently accepting unreadable Chinese.

Task 5: Golden Project complete — stable source manifest; all four approval-skip guards rejected; legal workflow reached `completed`; exact Chinese plus editable title/body/basic shape/table/chart and image-background OOXML assertions passed; LibreOffice rendered 5/5 with zero blank pages/issues and zero repair rounds; source map, JSON and readable reports persisted under ignored artifacts.

Task 5: Packaging and operational evidence — unsigned/ad-hoc Apple Silicon `.app` built at 124 MiB with both arm64 main executable and 106 MiB embedded Worker; launch required neither Vite nor an external Worker/Node runtime; live UI boundary completed Worker health plus Codex `initialize`/`initialized`/`account/read` using `/Applications/ChatGPT.app/Contents/Resources/codex`, returned the local Pro account, and created no model turn.

Task 5: Memory acceptance — release app process tree sampled every 100 ms: connected idle peak 224.2 MiB; one persisted PPT project create/open window peak 223.4 MiB; both include app, Worker and Codex App Server and pass the 4096 MiB incremental gate. Exact method is reproducible via `scripts/measure-process-tree-rss.mjs`.

Task 5: Network/billing audit — `lsof -nP -a -p <pid> -iTCP` returned no sockets/listeners for app, Worker or its Codex child during read-only smoke; repository and bundle string scans found no `OPENAI_API_KEY` or `api.openai.com`; the sole `apikey` code occurrence is a negative test proving that Codex API-key auth notifications are rejected. Official documentation links are exempt.

Task 5: Ruling: Keynote remains a documented human open/edit check rather than an automated success claim — `/Applications/Keynote.app` is present, but UI automation would risk saving changes or accepting import dialogs unreliably; Microsoft PowerPoint was not available and is not claimed.

Task 5 review: rejected after commits `fe141f1`, `2ebb285`, `751e582`; authoritative findings are retained in `task-5-review-findings.md`. The Golden runner was not accepted as production evidence because the packaged Worker exposed only health/transitions, the Tauri UI used a simplified Rust state machine and fabricated five-page content, complete PPT aggregates were not durable, production writes did not all cross the Rust fd boundary, QA did not compare approved visuals or validate fonts/bounds/resources, Golden evidence reused one image and invented 2027 data, configured Codex path was ignored, and SEA license/memory evidence was incomplete.

Task 5C Ruling: SQLite is the sole authoritative aggregate store; before every Worker action the Tauri adapter reloads the full `NativePptPipeline`, restores it into the supervised sidecar, executes one legal action, then asks Rust to commit the returned snapshot and hash-bound write intents with an exact revision compare-and-swap. Rust holds the database mutex from stale-revision validation through fd-relative artifact writes and the SQLite transaction, so an old/restarted Worker cannot overwrite a newer artifact before being rejected.

Task 5C Ruling: full visual history is persisted per slide rather than retaining only the latest status. Reopening an approved earlier page adds a new draft version, invalidates the export receipt, keeps prior frozen provenance, and returns to sequential visual review; ImageGen absence persists a recoverable `blocked` condition and user-uploaded PNG replacement resumes the exact blocked slide without a paid fallback.

Task 5C Ruling: production project directories and every source/outline/spec/visual/PPTX write use Rust directory descriptors with `O_NOFOLLOW`, atomic same-directory replacement and durability barriers. A deterministic concurrent-parent-replacement test renames the path and installs an outside symlink after Rust holds the destination fd; bytes remain in the held in-workspace directory and the outside target stays untouched.

Task 5C RED → GREEN: Worker native workflow/service tests 2/2 and sidecar JSON-RPC tests 6/6; configured Codex path live-reload tests 9/9; Rust complete-aggregate/source/write-intent/restart/stale-generation tests 3/3 and path tests 7/7; production-equivalent adapter → scripted App Server → real Worker runtime → native persistence harness E2E runs analysis, whole-outline approval, whole-deck detail approval, explicit ImageGen block, five sequential replacement approvals, Worker restart restore and editable export. Packaged SEA direct smoke successfully executes `ppt.project.create` and `ppt.project.snapshot`.

Task 5D Ruling: `deck.qa` is a production Worker action, while Rust exclusively performs local LibreOffice/PDF preparation outside the workspace and commits every final PDF/render/report write intent through the held-directory-fd boundary. The Worker accepts QA only when export SHA, frozen spec version, ordered approved visual versions/paths/hashes and slide count all match the restored authoritative aggregate; a failure persists a recoverable QA checkpoint rather than fabricating completion.

Task 5D Ruling: visual QA is a one-to-one ordered contract. Every rendered page is compared with its own distinct approved full-slide PNG using normalized RGB difference (`<= 0.6`), and completion additionally requires available fonts, exact page count, no blank page, no out-of-bounds object, no invalid crop and no missing OOXML resource. The readable `textReportPath` points to a real `.txt` artifact; the structured report remains a separate `.json` artifact.

Task 5D Ruling: the Golden fixture is corrected at the source instead of tolerating invented evidence. `kpis.csv` now contains the cited `2027计划 = 150` row, all datapoints bind to analyzed source IDs, and all five sequential approvals use byte-distinct complete-slide PNGs. Both the in-process Golden acceptance and the packaged newline-JSON-RPC recovery smoke execute the same production `NativePptPipeline` actions.

Task 5D RED → GREEN: focused tests added real pixel differences, OOXML font/bounds/crop/resource failures, readable text reports, native `deck.qa`, production QA UI controls, full child-process restart recovery, and bounded Rust QA subprocess execution. Final regression is core 8/8, Worker 162/162, desktop 53/53 and Rust 21/21; typecheck, lint, Rust fmt, `git diff --check`, Golden QA, `slides_test.py`, Apple Silicon `.app` build and packaged Worker smoke all pass.

Task 5D Packaging/operations: the 125 MiB app contains arm64 main/Worker executables, ad-hoc signature with no TeamIdentifier, and the exact 143,299-byte Node v22.21.1 distribution LICENSE plus third-party notices and version. Latest-bundle one-project process-tree sampling records 60 labeled 100 ms samples, PID/PPID/RSS/full commands and a 130.6 MiB peak, passing the 4096 MiB gate. Runtime listener checks for the main/Worker PIDs were empty; repository and executable scans found no API key or billed OpenAI REST endpoint.

Task 5D residual boundaries: live ImageGen remains unavailable and therefore persists the explicit recoverable visual block until the user supplies a replacement PNG; Keynote open/edit remains the documented human check; PowerPoint compatibility, Developer ID signing and notarization are not claimed. The previously verified live Codex `initialize` + `account/read` smoke remains read-only and consumes no model turn.

Task 5 fix round 1 re-review: rejected after `fc3235c` and `ffe9d01`; authoritative findings are in `task-5-review-round-2.md` — P0 full-aggregate restore accepts forged completed snapshots; P1 unknown actions mutate revision, whole-outline edit/save is broken, and packaged E2E still substitutes core production boundaries; P2 memory evidence labels only steady state and cannot prove create/restart/reopen peaks.

Task 5 fix round 2 Ruling: untrusted restore and action input are validated twice at complementary boundaries — strict discriminated parsing rejects unknown/malformed JSON-RPC values, while full aggregate validation proves schema, legal replay and cross-field provenance before atomic Map replacement; runtime default rejection occurs before task/revision mutation. Recursive canonical JSON hashing is part of the persistence contract because Rust JSON map ordering may change after SQLite round-trip.

Task 5 fix round 2 RED → GREEN: exact packaged regressions reject a forged `completed` restore, unknown action and malformed action as invalid params with byte-identical prior revision/state. Worker and native UI regressions execute whole-outline and whole-detail generate → edit → save → approve, preserving approval gates.

Task 5 fix round 2 Ruling: deterministic packaged E2E may script only Codex structured generation. The authoritative production harness uses the real production Tauri adapter, compiled Rust Workbench service delegates shared with Tauri commands, SQLite restart, final `.app` embedded SEA, Rust held-fd/hash-bound artifact writes and real LibreOffice/pdftoppm QA. It does not substitute in-memory persistence, a fake Worker, copied renders or fake QA.

Task 5 fix round 2 production acceptance: workflow reaches `completed` at revision 29 after both Rust/SQLite and Worker restart/reopen; five distinct visual comparisons pass with maximum normalized difference `0.106718`; persisted counts are 7 versions, 7 approvals, 12 tasks and 23 artifacts; readable and structured reports resolve to real files.

Task 5 fix round 2 memory ruling: `memory-one-project-v2.json` is retained only as historic steady-state evidence. The authoritative native libproc timeline records 60 PID/PPID/RSS/executable samples across actual create/open/quit+restart/reopen/stable events and the full harness, with a conservative `484.4 MiB` peak including Node, Rust, embedded SEA, LibreOffice and pdftoppm; it passes the 4096 MiB limit without claiming GUI-only idle RSS.

Task 5 fix round 2 implementation complete pending re-review: fresh typecheck/lint green; core 8/8, Worker 165/165, desktop 55/55, Rust 21/21; Golden and production PPTX `slides_test.py` no overflow; fresh arm64 SEA and 125 MiB `.app`; packaged adversarial smoke green; production harness completed revision 29 with real SQLite/Worker restart and LibreOffice/pdftoppm; exact Node license/version and static billing/listener scans green; no temporary pnpm store or lockfile churn.

Task 5 fix round 3 RED: a complete legal production `completed` snapshot with revision 29 and 12 tasks was cloned, changed to `tasks=[]` and `revision=999`, and accepted by the pre-fix JSON-RPC restore path. Additional RED cases isolated revision-only forgery, task-ID revision forgery, and removal plus renumbering of a required source-analysis task.

Task 5 fix round 3 Ruling: restore provenance is reconstructed from the complete aggregate. Exact task IDs bind project/kind/revision; revisions are strictly increasing and phase-monotonic; task status/error pairs are legal; required phase tasks cannot be deleted; and source attachment offsets, outline/detail edits and approvals, visual generation/replacement/approval/reopen actions, export and QA must sum to the persisted revision. The only compatibility offsets are the existing direct-source path and the Rust attachment path. This is structural consistency validation, not a cryptographic audit log.

Task 5 fix round 3 GREEN: focused restore/RPC/packaged-process tests 14/14 and full Worker 165/165 with Worker typecheck/lint. The rebuilt final `.app` SEA rejects `tasks=[]`/`revision=999` atomically, while the production harness accepts the genuine revision-29/12-task aggregate, restarts SQLite and Worker, and completes real LibreOffice/pdftoppm QA. Latest memory evidence contains 64 PID/PPID/RSS/executable samples across real operation events with a conservative `480.5 MiB` peak under the 4096 MiB limit.

Task 5 fix round 4/5 RED: the genuine production revision-29/12-task completed snapshot was changed only from `task-25-visual_generation` to `task-27-visual_generation` and was accepted. Five generation→replacement-slot cases, a whole-set approval-slot permutation and a QA-round mismatch established that phase ranges/counts did not prove legal action ordering.

Task 5 fix round 4/5 Ruling: retain schema v1 and SQLite opaque-JSON compatibility, but replace visual phase ranges with explicit revision-by-revision state replay. Fixed task revisions and reconstructed candidate/replacement/approval/reopen events advance workflow (`visual_review/blocked/conversion`) and per-slide version state (`none/placeholder/candidate/frozen`); only a complete legal path matching persisted current slide, versions, approvals, export and QA is accepted before `Map.set` or any Rust/SQLite commit. QA round/retry/error provenance is bound to its task sequence.

Task 5 fix round 4/5 GREEN: focused 14/14; Worker 165/165; desktop 55/55; Rust 21/21; core 8/8; repository typecheck/lint and Rust fmt green. Fresh arm64 SEA and `.app` build green. Embedded packaged smoke completes genuine revision 29/tasks12 and atomically rejects exact `25→27`; production harness survives SQLite+Worker restart and completes real LibreOffice/pdftoppm QA at revision 29 with 7 versions, 7 approvals, 12 tasks, 23 artifacts, 59 memory samples and a `472.6 MiB` peak. Golden 5/5 passes through the no-IPC Node loader; the `pnpm golden:qa` wrapper alone is sandbox-blocked by `tsx` Unix-socket `EPERM`.

Task 5: complete (commits `fe141f1`..`f790e4a`; independent scoped re-review APPROVE). The final `.app` SEA atomically rejects the exact in-range visual-task revision forgery plus replacement-slot, approval-slot, deletion, reorder and QA-round attack matrices while preserving the prior aggregate byte-for-byte; genuine revision-29/tasks12 restore and the real Rust/SQLite/Worker/LibreOffice production harness remain green.

Task 5 final centralized production-chain wave RED → GREEN (2026-09-04, no commit, `.git` read-only): closed all five new critical findings. Rust QA now creates/passes local Fontconfig, rejects likely tofu, discovers native LibreOffice/Poppler with `PATH=''`, and bounds process-group termination/drain. Native approval renders and validates the full PNG, supports feedback/regenerate/upload/reopen, and never enables approval on load/size/aspect failure. Approved complex visuals are masked in editable regions, embedded one per slide, and overlaid with editable title/body/table/chart/shape OOXML. Every general/PPT model task re-reads active ChatGPT auth before any workspace/thread/turn call; cwd comes only from Rust canonical workspace/project commands.

Task 5 final important/minor closure: Worker pre-generation exit is observable and restartable; cancel/recover reaches the UI; Poppler has settings/common/bundle/Codex-runtime discovery; Finder launch no longer depends on process cwd/PATH; project rename transaction also updates `pipeline_json.project.name`; HTTPS ChatGPT login is a real system-browser link. Held-fd and no-HTTP boundaries remain unchanged.

Task 5 final fresh verification: typecheck/lint/fmt green; core 8/8, Worker 165/165, desktop 68/68, Rust 26/26. Golden 5/5 and both `slides_test.py` runs pass. Fresh arm64 SEA/125 MiB `.app`, packaged smoke and production harness pass. Latest production project `project-1788508015569-1` completes revision 29 after SQLite+Worker restart with media 5, one visual per page, editable OOXML evidence, five tofu-free rendered PNGs, 8 ChatGPT account reads across 3 structured turns plus 5 visual requests, and a 90-sample/618.8 MiB peak below 4 GiB. Bundle/source hashes and exact 143,299-byte Node license match; API/billing/listener scans are clean.

Task 5 final evidence boundary: focused production component tests prove PNG load/dimension gate, feedback, replacement and reopen. Browser screenshot automation could not run because the sandbox denied Vite listen, terminated Playwright Chrome and Browser Use blocked `file://`; no browser pass is claimed. Live ImageGen, Keynote/PowerPoint compatibility, Developer ID/notarization remain out of scope. The ad-hoc bundle's strict deep codesign check exits 1 for unsealed resources and is documented rather than hidden.

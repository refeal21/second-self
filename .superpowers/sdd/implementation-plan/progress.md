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

# 售前队列 PNG 暂存与本地恢复验证

状态：本轮只完成原生受信任 PNG 暂存桥及重启后本地恢复。输出停在 `result_ready`，不是视觉批准、候选发布、项目提交或 `succeeded`。

## 已实现边界

- `QueueStore::stage_png_result` 从持久化的完整 `QueueTarget` 使用 Rust JSON 序列化和 SHA-256 原生派生绑定；调用方不能传绑定、哈希声明或输出路径。
- `QueueStore::recover_png_result` 只读取 `ResultVault` 中已有的 PNG 和 sidecar，不调用模型、不重发生成、不创建替代 attempt。
- 文件工作前校验当前 runtime epoch、精确 request/attempt 和允许状态；文件校验后再取得 SQLite `IMMEDIATE` 写快照，重新校验 runtime、attempt、完整目标绑定及状态。
- 当前拥有 epoch 的 `dispatching`、`running`、`outcome_unknown`、`cancel_requested` 可提交已验证结果；已有 `result_ready` 只允许与持久化结果完全一致的重放，并可保留其旧 epoch。
- `queued`、`failed`、`succeeded`、`cancelled`、`abandoned_unresolved` 不可提升。预检失败不写文件；预检后发生竞争或 SQLite 写失败时，已持久化文件保留为隔离证据，不自动成为候选。
- runtime 恢复把显示状态变为 `outcome_unknown` 后，处理结果仍查询相同 attempt 的持久 `cancel_requested` 审计；取消先发生时最终为 `cancelled` 且不保存可发布 result。
- 每次恢复（包括已有 `result_ready`）都重新验证 PNG 字节、manifest、绑定、大小、哈希和解码尺寸。

## 实际验证

全部测试只使用测试自己创建的临时 SQLite、原生 result root 和合成 PNG。

- 定向暂存/恢复：`presales_result_staging` 10 项通过。
- 文件 vault：`presales_result_vault` 14 项通过。
- 生命周期：`presales_queue_lifecycle` 20 项通过，包含取消意图跨 runtime 恢复回归。
- feature-only 真子进程队列：`presales_queue_process` 8 项通过；新桥未注册 RPC。
- 默认 Rust 全套 exit 0。各 target 原始计数：lib 9、main 0、codex_process 7、database 6、opener_acl 3、paths 7、presales_contracts 13、presales_queue 24、presales_queue_lifecycle 20、presales_queue_process 0、presales_result_staging 10、presales_result_vault 14、presales_storage 16、presales_workbench 11、visual_style 21、workbench 14、doc-tests 0；每项均 0 failed。
- `cargo fmt --check` 与 `git diff --check` 均 exit 0、无输出。

父代理在 `b039f9b` 独立复跑：vault 14、staging 10、lifecycle 20、feature-only process 8，以及私有目录持久化单元测试 3，合计 55 项全部通过；格式和 diff 检查也通过。实现者的默认 Rust 全套原始计数合计为 175 项，不将独立重复运行累加成新的测试数量。

覆盖行为包括：先落文件再重启恢复；SQLite 触发器故意拒绝记录后保留 PNG/manifest 并在移除触发器后恢复；缺失、损坏、错误绑定及错误 ready manifest 不改变队列；旧 epoch、错误 attempt、queued 输入不创建目录；多页跨真实连接乱序暂存与精确重放各只有一条 result 事件；取消/结果两种先后顺序；放弃后的迟到文件不影响同页新请求。

## 逐任务复查

文件 vault 的首次复查发现 PNG 解码器默认未严格校验部分校验和、目录链接持久化检查不完整。两项均先以失败测试复现，再在 `cdcdfaf` 修复：显式开启 Adler32/所有块 CRC 校验；文件按 PNG 在前、manifest 在后确认持久化，并同步所持目录链。14 项 vault 与 3 项私有持久化测试通过，定向复查关闭两项问题。

暂存桥 `b039f9b` 通过独立规格及质量复查，无新问题。取消意图跨重启的缺陷也以 `ResultReady` 与期望 `Cancelled` 不一致的失败测试复现后修复。完整分支复查尚待完成。

新增直接依赖 png 0.18.1 的 MIT 归属已依据本地 crate 的完整许可证补充到 `THIRD_PARTY_NOTICES.md`。再次只读确认系统输出音量 0、提醒音量 0、输出静音开启；没有播放测试音，也未修改输入音量。

## 未完成且不能宣称

- 尚无 v3 项目目录中的候选、receipt、Job 终态、pipeline 指针和审批资格的同一事务原子发布；没有跨数据库成功标记。
- 尚无 production Worker transport、supervisor 自动扫描/恢复、Tauri RPC 注册或前端多页画廊/审批接线。
- 暂存绑定不证明 QueueTarget 中每个版本哈希属于当前有效且已批准项目。未来候选发布器必须再次验证文件字节和当时最新的已批准项目快照，不能直接信任本轮 `result_ready`。
- 未改、未启动或安装运行中的应用，未访问客户项目或旧 `workbench.sqlite3`，未调用模型、网络、音频或通知。

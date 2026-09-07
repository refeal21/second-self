# Second Self — 本地数字分身工作台

Second Self 是一个仅在本机运行的 macOS 工作台。它把通用 Codex 任务和“先审批内容与整页视觉、再交付可编辑 PPTX”的演示文稿流程放在同一个 Tauri 桌面应用里。

当前仓库是第一版工程与验收基线：生产窗口读取 Rust/SQLite 的真实持久化状态；Rust 监管内嵌 Worker 与 Codex App Server；五页中文 Golden Project 已覆盖合法审批链、批准 PNG 的安全预览、分层可编辑 OOXML 导出和 LibreOffice 全页 QA。浏览器开发模式包含明确标记的演示数据，不代表桌面端已保存的项目。

## 第一版边界

- macOS 13+、Apple Silicon、单人本地使用。
- 使用 Codex/ChatGPT 登录态；没有 OpenAI API Key 输入、环境变量回退或按量 API 客户端。
- 每个通用任务和 PPT 结构化生成回合都会重新读取账户，只有带有效计划的 ChatGPT 账户可以进入 `thread/start` / `turn/start`；工作目录只接受 Rust 返回的 canonical 绝对路径。
- 打包运行时不需要另装 Node.js，不启动后端 HTTP 服务；开发期 Vite 只监听 `127.0.0.1:1420`。
- 默认工作区为 `~/Documents/DigitalTwinWorkspace`，项目大文件写入固定子目录，索引与审批状态保存在应用数据目录的 SQLite。
- ImageGen 不可用时明确阻塞，不会偷偷切换到收费 API。
- 生产 QA 需要 LibreOffice 和 Poppler `pdftoppm`。应用会验证设置值、bundle、常见 Homebrew 路径与 Codex 本地 runtime；Finder 启动不依赖进程 PATH。
- 不支持编辑已有 PPT、团队协作、云同步、自动更新或移动端。

## 快速验证

PPT 使用顺序：创建项目 → 选择材料 → 填写并保存“本次任务说明”和各文件用途 → 分析材料 → 补充“本次大纲要求” → 生成整份大纲并审核 → 逐页细化并审核。说明会真正随请求发送给 AI，并可在生成前预览；大纲批准后说明锁定。具体的修改影响和旧项目兼容规则见[提示词填写说明](docs/troubleshooting.md#背景文件用途和大纲要求放在哪里)。

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm lint
pnpm golden:qa
pnpm --filter @digital-twin/desktop tauri build --bundles app
pnpm build:production-harness
pnpm harness:production
```

最后两条命令执行确定性的生产边界验收：真实前端 Tauri adapter、编译后的 Rust Workbench 服务、SQLite 重启、`.app` 内嵌 Worker SEA、Rust 原子产物写入和真实 LibreOffice/pdftoppm QA。只有 Codex 的结构化生成响应由本地脚本固定，不会调用模型或收费 API。

生成的个人开发构建位于：

`apps/desktop/src-tauri/target/release/bundle/macos/Digital Twin Workbench.app`

该 `.app` 未使用 Apple Developer ID 签名、未公证，只适合当前用户的本机开发验证。完整依赖、运行、验收与排障步骤见：

- [系统架构](docs/architecture.md)
- [开发、运行与打包](docs/run-build.md)
- [Golden Project 与 QA](docs/qa.md)
- [故障排查](docs/troubleshooting.md)
- [第三方声明](THIRD_PARTY_NOTICES.md)

合盖或让 Mac 睡眠会暂停本地应用、Worker、Codex 与 LibreOffice 任务；唤醒后应用可从最后一个完整检查点恢复，但睡眠期间不会继续工作。

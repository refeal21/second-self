# Second Self — 本地数字分身工作台

Second Self 是一个仅在本机运行的 macOS 工作台。它把通用 Codex 任务和“先审批内容与整页视觉、再交付可编辑 PPTX”的演示文稿流程放在同一个 Tauri 桌面应用里。

当前仓库是第一版工程与验收基线：生产窗口读取 Rust/SQLite 的真实持久化状态；Rust 监管内嵌 Worker 与 Codex App Server；五页中文 Golden Project 已覆盖合法审批链、可编辑 OOXML 导出和 LibreOffice 全页 QA。浏览器开发模式包含明确标记的演示数据，不代表桌面端已保存的项目。

## 第一版边界

- macOS 13+、Apple Silicon、单人本地使用。
- 使用 Codex/ChatGPT 登录态；没有 OpenAI API Key 输入、环境变量回退或按量 API 客户端。
- 打包运行时不需要另装 Node.js，不启动后端 HTTP 服务；开发期 Vite 只监听 `127.0.0.1:1420`。
- 默认工作区为 `~/Documents/DigitalTwinWorkspace`，项目大文件写入固定子目录，索引与审批状态保存在应用数据目录的 SQLite。
- ImageGen 不可用时明确阻塞，不会偷偷切换到收费 API。
- 不支持编辑已有 PPT、团队协作、云同步、自动更新或移动端。

## 快速验证

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm lint
pnpm golden:qa
pnpm --filter @digital-twin/desktop tauri build --bundles app
```

生成的个人开发构建位于：

`apps/desktop/src-tauri/target/release/bundle/macos/Digital Twin Workbench.app`

该 `.app` 未使用 Apple Developer ID 签名、未公证，只适合当前用户的本机开发验证。完整依赖、运行、验收与排障步骤见：

- [系统架构](docs/architecture.md)
- [开发、运行与打包](docs/run-build.md)
- [Golden Project 与 QA](docs/qa.md)
- [故障排查](docs/troubleshooting.md)
- [第三方声明](THIRD_PARTY_NOTICES.md)

合盖或让 Mac 睡眠会暂停本地应用、Worker、Codex 与 LibreOffice 任务；唤醒后应用可从最后一个完整检查点恢复，但睡眠期间不会继续工作。

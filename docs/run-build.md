# 开发、运行与打包

## 环境

- Apple Silicon Mac，macOS 13 或更新版本。
- pnpm 11、Node.js 22（只在开发和构建时需要）。
- Rust stable 与 Apple Command Line Tools。
- 本机 Codex CLI，或包含 Codex 的 ChatGPT macOS 应用。
- LibreOffice（Golden Project 自动 QA 必需）。
- Keynote（只用于最后的人工打开/编辑检查）。

检测工具：

```bash
rustc --version
node --version
pnpm --version
codex --version || /Applications/ChatGPT.app/Contents/Resources/codex --version
mdfind 'kMDItemCFBundleIdentifier == "org.libreoffice.script"'
test -d /Applications/Keynote.app && echo "Keynote available"
```

## 开发模式

```bash
pnpm install
pnpm dev
```

开发期 Vite 固定绑定 `127.0.0.1:1420`，这是热更新页面，不是应用后端。只看可视化演示数据时可运行 `pnpm dev:web`；页面会明确显示演示服务。

## 测试

```bash
pnpm test
pnpm typecheck
pnpm lint
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
git diff --check
```

`pnpm test` 依次执行 core、Worker、desktop 和 Rust 测试。Rust 边界测试包括持久化重启、审批不可跳过、偏好快照，以及相对逃逸、绝对路径、已有/断裂符号链接和父目录替换。

## Golden Project

```bash
pnpm generate:golden-fixtures
pnpm golden:qa
```

测试夹具已提交到 `fixtures/golden-project/`。生成结果位于忽略提交的 `artifacts/qa/golden-project/`，详情见 [QA 文档](qa.md)。

## 构建个人 `.app`

```bash
pnpm build:worker-sidecar
pnpm --filter @digital-twin/desktop tauri build --bundles app
```

第一条命令把 Worker 打成与当前 Rust host triple 对应的 Node SEA。第二条命令会重新执行前端和 sidecar 构建，并输出：

`apps/desktop/src-tauri/target/release/bundle/macos/Digital Twin Workbench.app`

检查包内容：

```bash
file 'apps/desktop/src-tauri/target/release/bundle/macos/Digital Twin Workbench.app/Contents/MacOS/'*
codesign -dv --verbose=4 'apps/desktop/src-tauri/target/release/bundle/macos/Digital Twin Workbench.app' 2>&1
```

应看到主程序和 `digital-twin-worker` 都是 arm64 Mach-O。签名应为 ad-hoc/linker-signed、没有 TeamIdentifier；这不是 Developer ID 签名，也没有 Apple 公证。不要把此构建当作可公开分发的安装包。

Worker SEA 使用当前 Node 22 可执行文件构建，同时把该 Node 发行版的完整 `LICENSE`（其中包含依赖许可证和第三方声明）以及精确版本复制到 `.app/Contents/Resources/licenses/node-runtime/`。若构建机器上的匹配 LICENSE 缺失，构建会直接失败。

## 只读账号冒烟测试

打开 `.app`，进入“通用任务”，点击“检查连接”。该操作只启动 `codex app-server --listen stdio://`，发送 `initialize` / `initialized` / `account/read`，不会创建 thread/turn，也不会为了测试消耗一个模型回合。账户状态应显示本机 Codex 已登录的 ChatGPT 计划。

## 打包 Worker 的完整流程冒烟测试

先运行 `pnpm golden:qa` 生成确定性的五页输入，再运行：

```bash
pnpm smoke:packaged-worker
```

该命令直接执行 `.app/Contents/MacOS/digital-twin-worker`，走完材料分析结果提交、整份大纲/细化批准、五页顺序视觉批准、进程重启恢复、PPTX 导出和 `deck.qa`，并要求最终状态为 `completed`。它不会调用付费 API；QA 输入来自本地 Golden 产物。

## 打包生产边界验收

先生成 Golden 产物并构建最新 `.app`，然后运行：

```bash
pnpm build:production-harness
pnpm harness:production
```

第一条命令以 `acceptance-harness` Cargo feature 编译 `production-harness` 和原生 RSS sampler；这些测试二进制不会进入最终 `.app`。第二条命令使用生产 `createTauriDesktopAdapter`，通过与 Tauri commands 共用的 Rust Workbench service delegates 执行：项目创建与附件、SQLite 提交和重启、打包 SEA 恢复、两次整份编辑/审批、五页 ImageGen 明确阻塞与用户替换、顺序视觉审批、Rust fd 边界导出，以及真实 LibreOffice/pdftoppm QA。

为保持确定性且不花费模型回合，只有 Codex 的结构化生成响应由本地脚本固定；adapter、Worker、Rust、SQLite、文件写入和 QA 都使用生产实现。结果写入：

```text
artifacts/qa/production-harness/result.json
artifacts/qa/production-harness/memory.json
```

项目 ID 每次运行都会重新生成，因此 PPTX 和 QA 报告的精确绝对路径以 `result.json` 的 `exportPath` 与 `readableReportPath` 为准。

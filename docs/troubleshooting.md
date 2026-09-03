# 故障排查

## 应用打不开

这是未签名、未公证的个人开发构建。若从其他 Mac 下载后被 Gatekeeper 拦截，先确认代码来源，再在 Finder 中按住 Control 点击应用并选择“打开”，或在“系统设置 → 隐私与安全性”中选择“仍要打开”。不要为了省事全局关闭 Gatekeeper。

若从源码构建，确认系统为 Apple Silicon/macOS 13+，并重新运行：

```bash
pnpm build:worker-sidecar
pnpm --filter @digital-twin/desktop tauri build --bundles app
```

## Worker 不可用或意外退出

确认 `.app/Contents/MacOS/digital-twin-worker` 存在、是 arm64 Mach-O 且可执行。应用会拒绝过期 generation，并允许下一次健康检查重新启动 Worker。JSON-RPC 畸形输入或未知方法只返回错误，不应结束进程。

若应用在首页显示 Worker 错误，完全退出后重开；SQLite 检查点会从最后一个完整阶段恢复，不能跳过审批。

## Codex 账户不可用

应用按以下顺序查找 Codex：设置中的绝对路径、系统 PATH、ChatGPT 应用内置 Codex。推荐保持路径为空并使用自动检测。进入“通用任务”点击“检查连接”；若显示未登录，再点击“登录或重新登录”，登录过程由 Codex 管理。

应用不接受 OpenAI API Key。ChatGPT/Codex 未提供 ImageGen 能力时，页面会明确显示不可用；这不是网络重试问题，也不会回退到收费 API。

## LibreOffice QA 失败或中文方框

先确认 LibreOffice 能从命令行启动。macOS 无头 LibreOffice 可能看不到系统中文字体，因此 QA 为每次运行生成局部 Fontconfig，包含 `/System/Library/Fonts`、`/System/Library/Fonts/Supplemental` 和 `/Library/Fonts`，字体缓存也留在项目 `qa/run-N` 下。

不要删除单轮目录中的 PDF、rendered PNG、comparison PNG 或 JSON 后继续复用 receipt；恢复逻辑会校验路径、字节与哈希并拒绝不完整证据。可删除整个忽略提交的 Golden 输出目录后重新运行 `pnpm golden:qa`。

## 工作区路径被拒绝

工作区内禁止 `..`、绝对逃逸、已有或断裂符号链接，以及运行中被替换成链接的父目录。这是安全边界，不应通过关闭校验绕过。将材料复制到真实的工作区子目录，或在设置中选择一个不经过符号链接的目录。

## 合盖、睡眠或长任务中断

本应用完全本地运行。Mac 睡眠时 JavaScript、Rust、Worker、Codex 和 LibreOffice 都会暂停，合盖期间不会继续生成。唤醒后从最后一个完整检查点继续；如进程已退出，重新打开应用再恢复。

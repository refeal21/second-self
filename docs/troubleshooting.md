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

应用按以下顺序查找 Codex：设置中的绝对路径、系统 PATH、ChatGPT 应用内置 Codex。推荐保持路径为空并使用自动检测。进入“通用任务”点击“检查连接”；若显示未登录，再点击“登录或重新登录”。Codex 返回的 HTTPS 登录地址会显示为真实链接，桌面端使用系统浏览器安全打开；登录过程由 Codex 管理。

应用不接受 OpenAI API Key。API-key、未知账户类型、登出状态或空计划都会保持“开始任务”禁用；即使 UI 状态过期，所有通用任务和 PPT 结构化生成也会在 `thread/start` 前重新执行 `account/read` 并原子拒绝。ChatGPT/Codex 未提供 ImageGen 能力时，页面会明确显示不可用；这不是网络重试问题，也不会回退到收费 API。

桌面端登录链接只可由系统默认浏览器打开，并且 Tauri capability 只允许 `https://auth.openai.com/*`、`https://chatgpt.com/*` 和兼容旧登录跳转的 `https://chat.openai.com/*`。`http:`、`file:`、第三方域名、任意指定应用、文件/目录打开、Finder reveal 和 shell 命令都不在此权限内；若登录链接被拒绝，请检查本机 Codex 是否返回上述官方 HTTPS 域名，而不要放宽 capability。

## LibreOffice QA 失败或中文方框

先确认 LibreOffice 能从命令行启动。macOS 无头 LibreOffice 可能看不到系统中文字体，因此 QA 为每次运行在工作区外的隔离临时目录生成局部 Fontconfig，显式包含 `/System/Library/Fonts`、`/System/Library/Fonts/Supplemental` 和 `/Library/Fonts`，并把 `FONTCONFIG_FILE`、`FONTCONFIG_PATH`、`XDG_CACHE_HOME` 传给 LibreOffice 与 pdftoppm。临时字体缓存随本轮准备清理，不会写入项目交付目录。QA 除了检查字体文件，还会对真实 rendered PNG 检测连续方框/tofu；检测到不可读中文会进入可恢复的 `qa-rendering` 阻塞。

## 找不到 pdftoppm 或 soffice

生产应用会验证候选文件确实为可执行的绝对普通文件，并检查 bundle、`/Applications`、`/opt/homebrew/bin`、`/usr/local/bin`、显式覆盖和 Codex runtime 的原生二进制，PATH 只作最后后备。Codex runtime 的 `env bash` 包装脚本在受限 PATH 下不可用，因此原生 Mach-O 候选优先。

若 Poppler 仍不可用，在设置中填写 `pdftoppm` 的绝对路径，例如 `/opt/homebrew/bin/pdftoppm`。若 LibreOffice 不可用，安装 LibreOffice 后重试；错误信息会列出已经检查的来源。不要通过关闭可执行权限校验或改成任意 shell 命令绕过能力阻塞。

不要删除单轮目录中的 PDF、rendered PNG、comparison PNG 或 JSON 后继续复用 receipt；恢复逻辑会校验路径、字节与哈希并拒绝不完整证据。可删除整个忽略提交的 Golden 输出目录后重新运行 `pnpm golden:qa`。

## 生产 harness 失败

先确认最新 `.app`、Golden 产物、LibreOffice 和 pdftoppm 均存在，再重新运行：

```bash
pnpm build:production-harness
pnpm harness:production
```

`production-harness` 与 RSS sampler 只在 `acceptance-harness` Cargo feature 下构建，不会打包进 `.app`。harness 必须使用 `.app/Contents/MacOS/digital-twin-worker`，如果只看到 TypeScript Worker 或内存假数据库，应视为无效验收。失败现场保留在 `artifacts/qa/production-harness/`；不要用复制 Golden 渲染图的方式绕过 LibreOffice/pdftoppm。

## 工作区路径被拒绝

工作区内禁止 `..`、绝对逃逸、已有或断裂符号链接，以及运行中被替换成链接的父目录。这是安全边界，不应通过关闭校验绕过。通用任务不会使用进程当前目录 `.`；它只把 Rust `workspace_directory` 返回的 canonical 绝对路径交给 Codex。将材料复制到真实的工作区子目录，或在设置中选择一个不经过符号链接的目录。

## Worker 或 QA 退出后一直等待

Worker 启动期间的 exit 会作为当前 generation 的失败被观察并清理，下一请求会启动新 generation。LibreOffice/pdftoppm 无论根进程先退出还是超时都会隔离并终止进程组，stdout/stderr 只做有界 drain；后代继承 pipe 不应造成无限等待。若仍复现，请保留错误输出与 `artifacts/qa/production-harness/`，不要反复强制结束后删除 SQLite 检查点。

## 合盖、睡眠或长任务中断

本应用完全本地运行。Mac 睡眠时 JavaScript、Rust、Worker、Codex 和 LibreOffice 都会暂停，合盖期间不会继续生成。唤醒后从最后一个完整检查点继续；如进程已退出，重新打开应用再恢复。

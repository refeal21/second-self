# 架构

## 进程与信任边界

```text
React WebView
  │ Tauri invoke / typed events（无 HTTP）
  ▼
Tauri / Rust
  ├─ SQLite：项目、版本、审批、检查点、偏好快照、设置
  ├─ 安全工作区写入：openat + O_NOFOLLOW + fsync + renameat
  ├─ 内嵌 digital-twin-worker：newline JSON-RPC over stdio
  └─ 独立 codex app-server：newline JSON-RPC over stdio
       └─ 读取本机 ChatGPT/Codex 登录态；令牌由 Codex 自己管理
```

React 不直接访问数据库、工作区或子进程。生产适配器必须先完成内嵌 Worker 的 `system.health` 握手，再通过 Tauri Command 加载持久化状态。浏览器模式使用单独的演示适配器，所有返回值均标明演示性质。

## Rust 核心

Rust 是持久化和本机权限的唯一权威：

- `workbench.sqlite3` 保存轻量状态；材料、视觉、导出和 QA 文件不写入数据库。
- 工作区写入在实际文件描述符边界逐级拒绝符号链接、`..`、绝对逃逸和被替换的父目录，并使用同目录临时文件原子替换。
- Worker 与 Codex App Server 均由 Rust 创建和终止。每次启动使用单调递增 generation，过期进程的 stdout、exit 或 stdin 写入会被拒绝。
- 偏好必须先成为建议，再由用户明确批准；创建项目时复制快照，后续偏好变化不会改写旧项目。

## TypeScript Worker

Worker 承担 PPT 状态机、来源约束、规格生成、图片编排、PPTX 导出和 QA。打包时通过 Node Single Executable Application 生成 Apple Silicon Mach-O，并按 Tauri `bundle.externalBin` 作为 sidecar 嵌入 `.app`；运行目标机不需要单独安装 Node.js。

Worker stdio 协议版本为 1，包含 health、capabilities、合法 workflow transition 和 checkpoint recovery。未知方法、非法参数和畸形 JSON 返回标准 JSON-RPC 错误，进程保持可用。

## PPT 证据链

状态只能按以下顺序推进：

`intake → source_analysis → outline_review → detail_review → visual_review → conversion → qa → completed`

整份大纲、整份逐页规格和五页视觉分别审批。规格文本是导出文字与数据的真源；参考图不会通过 OCR 覆盖已批准文本。照片或复杂背景可保留图片，标题、正文、表格、图表和基础形状以独立 OOXML 对象导出。

每个外部产物都绑定项目、版本、来源与哈希。LibreOffice 渲染报告也要绑定当前 PPTX 字节和本轮输出路径，最多修复两轮，只有验证后的 QA receipt 才能使交付完成。

## 网络与账号

生产应用没有 HTTP 后端和 TCP listener。Codex App Server 使用 `stdio://`；ChatGPT 登录和令牌生命周期由本机 Codex 管理，应用不保存 cookies/tokens。仓库不实现 `OPENAI_API_KEY`、OpenAI REST 客户端或按量计费回退。

# Task 2 报告：无损逐页细化编辑器

## 交付范围

- 新增 `apps/desktop/src/detail-document.ts` 与纯函数测试。
- 新增 `apps/desktop/src/detail-editor.tsx`、独立样式与组件测试。
- 未修改 `native-workspace`、`App`、adapter、Worker、Rust 或共享 CSS；未安装依赖，未调用网络、模型或真实客户数据。

## TDD RED 证据

规定命令：

```text
pnpm --filter @digital-twin/desktop exec vitest run src/detail-document.test.ts src/detail-editor.test.tsx
```

首次运行：退出码 1，2 个 suite 失败；`detail-document.js` / `detail-editor.js` 均不存在。后续小循环也先观察到以下预期失败，再实现：

- legacy v1 标题不一致夹具被旧校验拒绝（实际错误“第 1 页标题与大纲不一致”）。
- 表格行、图表分类/系列删除按钮不存在。
- 70 字符超长 ID 未被本地校验拒绝。
- 草稿与历史编辑器并列时内部正文标题 ID 重复（8 个 ID、仅 6 个唯一值）。

## GREEN 与行为覆盖

- 最新聚焦：2 个文件、24 个测试通过。
- 最新桌面完整套件：23 个文件、229 个测试通过。
- `pnpm --filter @digital-twin/desktop typecheck`：退出码 0。
- `pnpm --filter @digital-twin/desktop lint`：退出码 0、0 warning。
- 覆盖受控标题/目的/正文、正文数组与段内换行原样保持、页/段落/表格/行/列 CRUD、图表/分类/系列、基础形状、分析事实/数据/来源与 locator。
- 页增删排序按完整 stable ID 对象移动；新增页插入当前页之后且必填内容为空；删除均二次确认，最后一页受保护；增删排序后焦点可预测。
- 空图表数值写为 `NaN` 的显式无效草稿态，绝不静默转成 `0`；表格单元格保留 `00128` 等原始字符串。
- 只识别 Worker 的精确恢复标记。主提示词修改时从标记到 EOF 的全部后缀原样拼回；有效、重复编辑及无效 JSON 后缀均做 exact string 断言。
- 已知恢复对象仅以 React 文本和中文属性表显示；原文默认折叠只读；`<script>` 样本文字不产生脚本节点；明确提示历史补充不是当前数据权威来源，也不重绑旧索引。
- 默认无可编辑 JSON；每页只有默认折叠的只读 `<pre>`。表格自身横向滚动，长文字安全换行，控件为原生可聚焦元素。
- `idPrefix` 覆盖页锚点及内部 `aria-labelledby`，当前草稿和历史只读视图可同时无碰撞渲染。新对象 ID 会避开当前页、嵌套对象和已识别恢复补充中的历史 ID。
- 页管理测试显式断言不发送 `fetch`，组件本身不接收 adapter、生成器或模型调用接口。

## Public API

`detail-document.ts`：

```ts
export interface DetailDocument { outline: PptOutline; specs: readonly SlideSpec[] }
export function detailDocumentError(value: DetailDocument): string | null
export function hasOutlineChanges(base: PptOutline, next: PptOutline): boolean
export function describeOutlineChanges(base: PptOutline, next: PptOutline): string[]
export const COMPATIBILITY_RECOVERY_MARKER: string
export interface CompatibilityBrief
export function parseCompatibilityBrief(value: string): CompatibilityBrief
export function replaceCompatibilityMainText(value: string, mainText: string): string
```

`detail-editor.tsx`：

```ts
export interface DetailEditorProps
export function DetailEditor(props: DetailEditorProps): ReactNode
export function DetailPageIndex(props: { value: DetailDocument; idPrefix?: string }): ReactNode
```

`detailDocumentError` 返回第一个“页码 + 字段”的中文错误，检查空标题/目的/正文/主提示词、严格 ID、页序 ID 对齐、表格矩形、图表等长与有限数、非负形状坐标及来源字段。它有意允许合法 legacy v1 的 `outline slide.title !== spec.title`，不会在加载或普通正文编辑时归一化旧数据。

标题框显示当前 `spec.title`。显式标题编辑同步 outline/spec；显式目的、页增删或排序属于结构操作，会先按 stable ID 将候选 outline 标题对齐到原 spec 标题。因此 legacy 文档的普通内容修改仍无损，v2 结构候选合法，且对齐变化会由 `describeOutlineChanges` 出现在确认摘要中。若用户把旧 spec 标题改回已批准 outline 标题，候选相对批准大纲无标题结构变化。

## 集成注意事项

- Task 3 应把 `detailDocumentError(value) !== null` 直接用于禁用保存/批准，并将返回文案显示在编辑器操作区。
- Task 3 应以持久化的批准大纲为 `hasOutlineChanges` / `describeOutlineChanges` 基线；不要以编辑器已对齐后的 outline 自身作基线。
- `NaN` 只存在于受控的无效 UI 草稿中；校验通过前不得 JSON 持久化，否则 JSON 会把它序列化为 `null`。
- 来源选择器只提供当前 analysis 且仍在 attachments 列表中的 citation；历史无法解析引用保持只读可见，最终来源真值仍由 Worker 校验。
- Task 1/3 的 Worker、Rust、adapter 与 workspace 并行改动不在本提交中；本次完整桌面套件在这些当前共享改动存在时仍为 229/229。

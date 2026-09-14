export function PreVersionFeedbackEditor({ pageNumber, text, baseline, busy, error, onChange, onSave }: {
  pageNumber: number; text: string; baseline: string; busy: boolean; error: string | null;
  onChange: (text: string) => void; onSave: () => void;
}) {
  return <section className="presales-workspace__panel" aria-label="页级生成说明"><h2>第 {pageNumber} 页 · 下一次生成说明</h2>
    <p>这份草稿独立于图片版本。即使该页正在生成，也可保存供之后的明确请求使用；不会自动重新排队。</p>
    <label>下一次生成说明<textarea aria-label="下一次生成说明" value={text} onChange={event => onChange(event.target.value)} /></label>
    <button disabled={busy || text === baseline} onClick={onSave}>保存下一次生成说明</button>
    {error && <p role="alert">{error}。输入已保留。</p>}
  </section>;
}

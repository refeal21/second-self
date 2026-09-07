import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react';
import type {
  PptOutline,
  SourceAnalysis,
} from '../../worker/src/ppt-project.js';
import './outline-editor.css';

type OutlineSlide = PptOutline['slides'][number];
type EvidenceKey = 'findingIds' | 'dataPointIds';

export interface OutlineEditorProps {
  outline: PptOutline;
  analysis: SourceAnalysis | null;
  sources: readonly { id: string; fileName: string }[];
  readOnly: boolean;
  disabled: boolean;
  onChange: (outline: PptOutline) => void;
}

const SAFE_ID = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

export function outlineDraftError(outline: PptOutline): string | null {
  if (!outline.title.trim()) return '请填写大纲标题。';
  if (outline.slides.length === 0) return '大纲至少需要 1 页。';

  const ids = new Set<string>();
  for (const [index, slide] of outline.slides.entries()) {
    const page = index + 1;
    if (!slide.title.trim()) return `第 ${page} 页标题不能为空。`;
    if (!slide.purpose.trim()) return `第 ${page} 页页面目的不能为空。`;
    if (!SAFE_ID.test(slide.id)) return `第 ${page} 页 ID 格式不安全。`;
    if (ids.has(slide.id)) return `第 ${page} 页 ID 重复。`;
    ids.add(slide.id);
  }
  return null;
}

export function OutlineEditor({
  outline,
  analysis,
  sources,
  readOnly,
  disabled,
  onChange,
}: OutlineEditorProps) {
  const [deleteIndex, setDeleteIndex] = useState<number | null>(null);
  const blocked = readOnly || disabled;
  const sourceNames = useMemo(
    () => new Map(sources.map(({ id, fileName }) => [id, fileName])),
    [sources],
  );
  const findings = useMemo(
    () => new Map(analysis?.findings.map((finding) => [finding.id, finding]) ?? []),
    [analysis],
  );
  const dataPoints = useMemo(
    () => new Map(analysis?.dataPoints.map((point) => [point.id, point]) ?? []),
    [analysis],
  );
  const analyzedSourceIds = useMemo(
    () => new Set(analysis?.sourceMap.map(({ sourceId }) => sourceId) ?? []),
    [analysis],
  );

  const replaceSlide = (index: number, nextSlide: OutlineSlide) => {
    if (blocked) return;
    onChange({
      ...outline,
      slides: outline.slides.map((slide, slideIndex) =>
        slideIndex === index ? nextSlide : slide),
    });
  };

  const moveSlide = (index: number, offset: -1 | 1) => {
    if (blocked) return;
    const destination = index + offset;
    if (destination < 0 || destination >= outline.slides.length) return;
    const slides = [...outline.slides];
    [slides[index], slides[destination]] = [slides[destination]!, slides[index]!];
    setDeleteIndex(null);
    onChange({ ...outline, slides });
  };

  const addPage = () => {
    if (blocked) return;
    const existingIds = new Set(outline.slides.map(({ id }) => id));
    let id = `slide-${crypto.randomUUID()}`;
    while (existingIds.has(id)) id = `slide-${crypto.randomUUID()}`;
    setDeleteIndex(null);
    onChange({
      ...outline,
      slides: [...outline.slides, { id, title: '', purpose: '' }],
    });
  };

  const deletePage = (index: number) => {
    if (blocked || outline.slides.length <= 1) return;
    setDeleteIndex(null);
    onChange({
      ...outline,
      slides: outline.slides.filter((_, slideIndex) => slideIndex !== index),
    });
  };

  const toggleEvidence = (
    index: number,
    key: EvidenceKey,
    id: string,
    checked: boolean,
    requiredSourceIds: readonly string[],
  ) => {
    const slide = outline.slides[index]!;
    const selectedIds = slide[key] ?? [];
    const nextIds = checked
      ? unionIds(selectedIds, [id])
      : selectedIds.filter((selectedId) => selectedId !== id);
    replaceSlide(index, {
      ...slide,
      [key]: nextIds,
      ...(checked
        ? { sourceIds: unionIds(slide.sourceIds ?? [], requiredSourceIds) }
        : {}),
    });
  };

  const toggleSource = (index: number, sourceId: string, checked: boolean) => {
    const slide = outline.slides[index]!;
    if (!checked && evidenceSourceIds(slide, findings, dataPoints).includes(sourceId)) return;
    const selectedIds = slide.sourceIds ?? [];
    replaceSlide(index, {
      ...slide,
      sourceIds: checked
        ? unionIds(selectedIds, [sourceId])
        : selectedIds.filter((selectedId) => selectedId !== sourceId),
    });
  };

  return (
    <section className="outline-editor" aria-label="整份大纲编辑器">
      <label className="outline-editor__deck-title">
        <span>大纲标题</span>
        <AutoGrowingTextarea
          aria-label="大纲标题"
          rows={1}
          value={outline.title}
          readOnly={readOnly}
          disabled={disabled}
          onChange={(event) => {
            if (!blocked) onChange({ ...outline, title: event.currentTarget.value });
          }}
        />
      </label>

      <div className="outline-editor__pages">
        {outline.slides.map((slide, index) => {
          const page = index + 1;
          const requiredSourceIds = evidenceSourceIds(slide, findings, dataPoints);
          const pageSources = unionIds(slide.sourceIds ?? [], requiredSourceIds);
          return (
            <article
              className="outline-page"
              aria-label={`第 ${page} 页：${slide.title || '未命名页面'}`}
              key={slide.id}
            >
              <header className="outline-page__header">
                <span className="outline-page__number">第 {page} 页</span>
                <div className="outline-page__actions">
                  <button
                    type="button"
                    className="outline-editor__compact-button"
                    aria-label={`上移第 ${page} 页`}
                    disabled={blocked || index === 0}
                    onClick={() => moveSlide(index, -1)}
                  >↑</button>
                  <button
                    type="button"
                    className="outline-editor__compact-button"
                    aria-label={`下移第 ${page} 页`}
                    disabled={blocked || index === outline.slides.length - 1}
                    onClick={() => moveSlide(index, 1)}
                  >↓</button>
                  <button
                    type="button"
                    className="outline-editor__compact-button outline-editor__delete-button"
                    aria-label={`删除第 ${page} 页`}
                    disabled={blocked || outline.slides.length <= 1}
                    onClick={() => setDeleteIndex(index)}
                  >删除</button>
                </div>
              </header>

              {deleteIndex === index && (
                <div className="outline-page__delete-confirmation" role="alert">
                  <p>确认删除第 {page} 页“{slide.title || '未命名页面'}”？</p>
                  <div>
                    <button
                      type="button"
                      className="outline-editor__compact-button outline-editor__delete-button"
                      aria-label={`确认删除第 ${page} 页`}
                      disabled={blocked}
                      onClick={() => deletePage(index)}
                    >确认删除</button>
                    <button
                      type="button"
                      className="outline-editor__compact-button"
                      aria-label={`取消删除第 ${page} 页`}
                      disabled={blocked}
                      onClick={() => setDeleteIndex(null)}
                    >取消</button>
                  </div>
                </div>
              )}

              <div className="outline-page__fields">
                <label>
                  <span>第 {page} 页标题</span>
                  <AutoGrowingTextarea
                    aria-label={`第 ${page} 页标题`}
                    rows={1}
                    value={slide.title}
                    readOnly={readOnly}
                    disabled={disabled}
                    onChange={(event) => replaceSlide(index, {
                      ...slide,
                      title: event.currentTarget.value,
                    })}
                  />
                </label>
                <label>
                  <span>第 {page} 页页面目的</span>
                  <AutoGrowingTextarea
                    aria-label={`第 ${page} 页页面目的`}
                    rows={2}
                    value={slide.purpose}
                    readOnly={readOnly}
                    disabled={disabled}
                    onChange={(event) => replaceSlide(index, {
                      ...slide,
                      purpose: event.currentTarget.value,
                    })}
                  />
                </label>
              </div>

              <div className="outline-page__evidence">
                <EvidenceList
                  title="核心事实"
                  ids={slide.findingIds}
                  resolve={(id) => findings.get(id)?.text}
                  empty="此页尚未绑定核心事实；不会根据来源自动推断事实。"
                  missing="有一条已保存的核心事实引用无法解析；请在高级信息中检查原始 ID。"
                />
                <EvidenceList
                  title="数据依据"
                  ids={slide.dataPointIds}
                  resolve={(id) => {
                    const point = dataPoints.get(id);
                    return point ? formatDataPoint(point) : undefined;
                  }}
                  empty="此页尚未绑定数据依据。"
                  missing="有一条已保存的数据引用无法解析；请在高级信息中检查原始 ID。"
                />
                <SourceList
                  sourceIds={pageSources}
                  sourceNames={sourceNames}
                  analysis={analysis}
                />
              </div>

              <details className="outline-page__picker">
                <summary>调整第 {page} 页材料</summary>
                <fieldset disabled={blocked}>
                  <legend className="outline-editor__visually-hidden">第 {page} 页材料选择</legend>
                  <PickerGroup title="核心事实">
                    {analysis?.findings.length ? analysis.findings.map((finding) => (
                      <label key={finding.id}>
                        <input
                          type="checkbox"
                          checked={(slide.findingIds ?? []).includes(finding.id)}
                          onChange={(event) => toggleEvidence(
                            index,
                            'findingIds',
                            finding.id,
                            event.currentTarget.checked,
                            finding.sourceIds,
                          )}
                        />
                        <span>结论：{finding.text}</span>
                      </label>
                    )) : <p>材料分析中暂无可选核心事实。</p>}
                  </PickerGroup>
                  <PickerGroup title="数据依据">
                    {analysis?.dataPoints.length ? analysis.dataPoints.map((point) => (
                      <label key={point.id}>
                        <input
                          type="checkbox"
                          checked={(slide.dataPointIds ?? []).includes(point.id)}
                          onChange={(event) => toggleEvidence(
                            index,
                            'dataPointIds',
                            point.id,
                            event.currentTarget.checked,
                            point.sourceIds ?? [],
                          )}
                        />
                        <span>数据：{formatDataPoint(point)}</span>
                      </label>
                    )) : <p>材料分析中暂无可选数据。</p>}
                  </PickerGroup>
                  <PickerGroup title="参考来源">
                    {sources.length ? sources.map((source) => {
                      const analyzed = analyzedSourceIds.has(source.id);
                      const required = requiredSourceIds.includes(source.id);
                      const suffix = required
                        ? '（被本页事实或数据引用，请先取消对应引用）'
                        : analyzed ? '' : '（尚未出现在材料分析中）';
                      return (
                        <label key={source.id} className={analyzed && !required ? '' : 'is-unavailable'}>
                          <input
                            type="checkbox"
                            aria-label={`来源：${source.fileName}${suffix}`}
                            checked={required || (slide.sourceIds ?? []).includes(source.id)}
                            disabled={blocked || !analyzed || required}
                            onChange={(event) => toggleSource(
                              index,
                              source.id,
                              event.currentTarget.checked,
                            )}
                          />
                          <span aria-hidden="true">来源：{source.fileName}{suffix}</span>
                        </label>
                      );
                    }) : <p>当前项目没有已附加文件。</p>}
                  </PickerGroup>
                </fieldset>
              </details>
            </article>
          );
        })}
      </div>

      <button
        type="button"
        className="outline-editor__add-button"
        aria-label="新增页面"
        disabled={blocked}
        onClick={addPage}
      >＋ 新增页面</button>

      <details className="outline-editor__advanced">
        <summary>高级信息（JSON，只读）</summary>
        <pre aria-label="大纲 JSON">{JSON.stringify(outline, null, 2)}</pre>
      </details>
    </section>
  );
}

function EvidenceList({
  title,
  ids,
  resolve,
  empty,
  missing,
}: {
  title: string;
  ids: readonly string[] | undefined;
  resolve: (id: string) => string | undefined;
  empty: string;
  missing: string;
}) {
  return (
    <section className="outline-evidence-group">
      <h3>{title}</h3>
      {ids?.length ? (
        <ul>{ids.map((id, index) => {
          const value = resolve(id);
          return value
            ? <li key={`${id}-${index}`}>{value}</li>
            : <li className="outline-editor__warning" key={`${id}-${index}`}>{missing}</li>;
        })}</ul>
      ) : <p className="outline-editor__hint">{empty}</p>}
    </section>
  );
}

function SourceList({
  sourceIds,
  sourceNames,
  analysis,
}: {
  sourceIds: readonly string[];
  sourceNames: ReadonlyMap<string, string>;
  analysis: SourceAnalysis | null;
}) {
  return (
    <section className="outline-evidence-group outline-evidence-group--sources">
      <h3>参考来源</h3>
      {sourceIds.length ? (
        <ul>{sourceIds.flatMap((sourceId) => {
          const fileName = sourceNames.get(sourceId);
          const citations = analysis?.sourceMap.filter((citation) => citation.sourceId === sourceId) ?? [];
          if (!fileName) {
            return [<li className="outline-editor__warning" key={`${sourceId}-missing`}>
              有一个已保存的来源引用无法解析；请在高级信息中检查原始 ID。
            </li>];
          }
          if (!citations.length) {
            return [<li className="outline-editor__warning" key={`${sourceId}-unlocated`}>
              <strong>{fileName}</strong><span>定位信息无法解析。</span>
            </li>];
          }
          return citations.map((citation, index) => (
            <li key={`${sourceId}-${index}-${citation.locator}`}>
              <strong>{fileName}</strong><span>{citation.locator}</span>
            </li>
          ));
        })}</ul>
      ) : <p className="outline-editor__hint">此页尚未绑定参考来源。</p>}
    </section>
  );
}

function PickerGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="outline-picker-group">
      <h3>{title}</h3>
      <div>{children}</div>
    </section>
  );
}

function AutoGrowingTextarea({
  'aria-label': ariaLabel,
  value,
  readOnly,
  disabled,
  rows,
  onChange,
}: {
  'aria-label': string;
  value: string;
  readOnly: boolean;
  disabled: boolean;
  rows: number;
  onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const resize = useCallback(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = 'auto';
    const borderHeight = element.offsetHeight - element.clientHeight;
    element.style.height = `${element.scrollHeight + borderHeight}px`;
  }, []);

  useLayoutEffect(resize, [resize, value]);
  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [resize]);

  return (
    <textarea
      ref={textarea}
      aria-label={ariaLabel}
      rows={rows}
      value={value}
      readOnly={readOnly}
      disabled={disabled}
      onChange={onChange}
    />
  );
}

function unionIds(first: readonly string[], second: readonly string[]): string[] {
  return [...new Set([...first, ...second])];
}

function evidenceSourceIds(
  slide: OutlineSlide,
  findings: ReadonlyMap<string, SourceAnalysis['findings'][number]>,
  dataPoints: ReadonlyMap<string, SourceAnalysis['dataPoints'][number]>,
): string[] {
  const referenced = [
    ...(slide.findingIds ?? []).flatMap((id) => findings.get(id)?.sourceIds ?? []),
    ...(slide.dataPointIds ?? []).flatMap((id) => dataPoints.get(id)?.sourceIds ?? []),
  ];
  return unionIds([], referenced);
}

function formatDataPoint(point: SourceAnalysis['dataPoints'][number]): string {
  return `${point.label}：${String(point.value)}${point.unit ? ` ${point.unit}` : ''}`;
}

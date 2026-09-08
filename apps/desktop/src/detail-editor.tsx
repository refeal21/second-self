import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  PptOutline,
  SlideChart,
  SlideShape,
  SlideSpec,
  SlideTable,
  SourceAnalysis,
  SourceCitation,
} from '../../worker/src/ppt-project.js';
import {
  parseCompatibilityBrief,
  replaceCompatibilityMainText,
  type DetailDocument,
} from './detail-document.js';
import './detail-editor.css';

export interface DetailEditorProps {
  value: DetailDocument;
  analysis: SourceAnalysis | null;
  sources: readonly { id: string; fileName: string }[];
  readOnly: boolean;
  disabled: boolean;
  idPrefix?: string;
  onChange: (next: DetailDocument) => void;
}

type Confirmation = { key: string; message: string };
type FocusTarget =
  | { kind: 'title'; pageId: string }
  | { kind: 'paragraph'; pageId: string; index: number }
  | { kind: 'move'; pageId: string }
  | { kind: 'page'; pageId: string };

export function DetailPageIndex({
  value,
  idPrefix = 'detail',
}: {
  value: DetailDocument;
  idPrefix?: string;
}): ReactNode {
  const specsById = new Map(value.specs.map((spec) => [spec.id, spec]));
  return (
    <nav className="detail-page-index" aria-label="逐页细化目录">
      <ol>{value.outline.slides.map((slide, index) => (
        <li key={slide.id}>
          <a href={`#${pageDomId(idPrefix, slide.id)}`}>
            第 {index + 1} 页：{specsById.get(slide.id)?.title || slide.title || '未命名页面'}
          </a>
        </li>
      ))}</ol>
    </nav>
  );
}

export function DetailEditor({
  value,
  analysis,
  sources,
  readOnly,
  disabled,
  idPrefix = 'detail',
  onChange,
}: DetailEditorProps): ReactNode {
  const blocked = readOnly || disabled;
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const pendingFocus = useRef<FocusTarget | null>(null);
  const titleRefs = useRef(new Map<string, HTMLTextAreaElement>());
  const paragraphRefs = useRef(new Map<string, HTMLTextAreaElement>());
  const moveRefs = useRef(new Map<string, HTMLButtonElement>());
  const pageRefs = useRef(new Map<string, HTMLElement>());
  const sourceNames = useMemo(
    () => new Map(sources.map(({ id, fileName }) => [id, fileName])),
    [sources],
  );

  useLayoutEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    if (target.kind === 'title') titleRefs.current.get(target.pageId)?.focus();
    if (target.kind === 'paragraph') {
      paragraphRefs.current.get(`${target.pageId}-${target.index}`)?.focus();
    }
    if (target.kind === 'move') moveRefs.current.get(target.pageId)?.focus();
    if (target.kind === 'page') pageRefs.current.get(target.pageId)?.focus();
  }, [value]);

  const emit = (next: DetailDocument, focus?: FocusTarget) => {
    if (blocked) return;
    if (focus) pendingFocus.current = focus;
    onChange(next);
  };

  const replacePage = (
    index: number,
    outlineSlide: PptOutline['slides'][number],
    spec: SlideSpec,
    focus?: FocusTarget,
  ) => {
    emit({
      outline: {
        ...value.outline,
        slides: value.outline.slides.map((slide, slideIndex) =>
          slideIndex === index ? outlineSlide : slide),
      },
      specs: value.specs.map((slideSpec, slideIndex) => slideIndex === index ? spec : slideSpec),
    }, focus);
  };

  const replaceSpec = (index: number, spec: SlideSpec, focus?: FocusTarget) => {
    replacePage(index, value.outline.slides[index]!, spec, focus);
  };

  const structuralSlides = () => value.outline.slides.map((slide, slideIndex) => ({
    ...slide,
    title: value.specs[slideIndex]?.id === slide.id ? value.specs[slideIndex]!.title : slide.title,
  }));

  const movePage = (index: number, offset: -1 | 1) => {
    const destination = index + offset;
    if (blocked || destination < 0 || destination >= value.specs.length) return;
    const slides = structuralSlides();
    const specs = [...value.specs];
    [slides[index], slides[destination]] = [slides[destination]!, slides[index]!];
    [specs[index], specs[destination]] = [specs[destination]!, specs[index]!];
    setConfirmation(null);
    emit(
      { outline: { ...value.outline, slides }, specs },
      { kind: 'move', pageId: specs[destination]!.id },
    );
  };

  const insertPage = (index: number) => {
    if (blocked) return;
    const id = uniqueId('slide', value);
    const outlineSlide = { id, title: '', purpose: '' };
    const spec: SlideSpec = {
      id,
      title: '',
      body: [''],
      tables: [],
      charts: [],
      shapes: [],
      sourceMap: [],
      imageGenerationBrief: '',
    };
    const slides = structuralSlides();
    const specs = [...value.specs];
    slides.splice(index + 1, 0, outlineSlide);
    specs.splice(index + 1, 0, spec);
    setConfirmation(null);
    emit({ outline: { ...value.outline, slides }, specs }, { kind: 'title', pageId: id });
  };

  const deletePage = (index: number) => {
    if (blocked || value.specs.length <= 1) return;
    const remainingSpecs = value.specs.filter((_, specIndex) => specIndex !== index);
    const remainingSlides = structuralSlides().filter((_, slideIndex) => slideIndex !== index);
    const focusId = remainingSpecs[Math.min(index, remainingSpecs.length - 1)]!.id;
    setConfirmation(null);
    emit(
      { outline: { ...value.outline, slides: remainingSlides }, specs: remainingSpecs },
      { kind: 'page', pageId: focusId },
    );
  };

  return (
    <section className="detail-editor" aria-label="整份逐页细化编辑器">
      <div className="detail-editor__pages">
        {value.specs.map((spec, index) => {
          const outlineSlide = value.outline.slides[index]!;
          const page = index + 1;
          const pageLabel = `第 ${page} 页`;
          return (
            <article
              className="detail-page"
              id={pageDomId(idPrefix, spec.id)}
              aria-label={`${pageLabel}：${spec.title || outlineSlide.title || '未命名页面'}`}
              key={spec.id}
              ref={(element) => setMapRef(pageRefs.current, spec.id, element)}
              tabIndex={-1}
            >
              <header className="detail-page__header">
                <span className="detail-page__number">{pageLabel}</span>
                <div className="detail-page__actions">
                  <button type="button" className="detail-editor__compact-button"
                    aria-label={`上移${pageLabel}`} disabled={blocked || index === 0}
                    ref={(element) => setMapRef(moveRefs.current, spec.id, element)}
                    onClick={() => movePage(index, -1)}>↑</button>
                  <button type="button" className="detail-editor__compact-button"
                    aria-label={`下移${pageLabel}`} disabled={blocked || index === value.specs.length - 1}
                    onClick={() => movePage(index, 1)}>↓</button>
                  <button type="button" className="detail-editor__compact-button detail-editor__delete-button"
                    aria-label={`删除${pageLabel}`} disabled={blocked || value.specs.length <= 1}
                    onClick={() => setConfirmation({
                      key: `page-${spec.id}`,
                      message: `确认删除${pageLabel}“${spec.title || outlineSlide.title || '未命名页面'}”？`,
                    })}>删除</button>
                </div>
              </header>

              {confirmation?.key === `page-${spec.id}` && (
                <DeleteConfirmation confirmation={confirmation} blocked={blocked}
                  confirmLabel={`确认删除${pageLabel}`} onCancel={() => setConfirmation(null)}
                  onConfirm={() => deletePage(index)} />
              )}

              <section className="detail-section detail-section--identity" aria-label={`${pageLabel}基本信息`}>
                <label>
                  <span>{pageLabel}标题</span>
                  <textarea aria-label={`${pageLabel}标题`} rows={1} value={spec.title}
                    readOnly={readOnly} disabled={disabled}
                    ref={(element) => setMapRef(titleRefs.current, spec.id, element)}
                    onChange={(event) => {
                      if (blocked) return;
                      const title = event.currentTarget.value;
                      const slides = structuralSlides();
                      slides[index] = { ...slides[index]!, title };
                      emit({
                        outline: { ...value.outline, slides },
                        specs: replaceAt(value.specs, index, { ...spec, title }),
                      });
                    }} />
                </label>
                <label>
                  <span>{pageLabel}页面目的</span>
                  <textarea aria-label={`${pageLabel}页面目的`} rows={2} value={outlineSlide.purpose}
                    readOnly={readOnly} disabled={disabled}
                    onChange={(event) => {
                      if (!blocked) {
                        const slides = structuralSlides();
                        slides[index] = { ...slides[index]!, purpose: event.currentTarget.value };
                        emit({ outline: { ...value.outline, slides }, specs: value.specs });
                      }
                    }} />
                </label>
              </section>

              <ParagraphEditor page={page} pageId={spec.id} idPrefix={idPrefix} body={spec.body} blocked={blocked}
                readOnly={readOnly} disabled={disabled} confirmation={confirmation}
                setConfirmation={setConfirmation} paragraphRefs={paragraphRefs.current}
                onChange={(body, focus) => replaceSpec(index, { ...spec, body }, focus)} />

              <TableEditor page={page} spec={spec} document={value} blocked={blocked}
                readOnly={readOnly} disabled={disabled} confirmation={confirmation}
                setConfirmation={setConfirmation} onChange={(tables) => replaceSpec(index, { ...spec, tables })} />

              <ChartEditor page={page} spec={spec} document={value} blocked={blocked}
                readOnly={readOnly} disabled={disabled} confirmation={confirmation}
                setConfirmation={setConfirmation} onChange={(charts) => replaceSpec(index, { ...spec, charts })} />

              <ShapeEditor page={page} spec={spec} document={value} blocked={blocked}
                readOnly={readOnly} disabled={disabled} confirmation={confirmation}
                setConfirmation={setConfirmation} onChange={(shapes) => replaceSpec(index, { ...spec, shapes })} />

              <EvidenceEditor page={page} spec={spec} analysis={analysis} sourceNames={sourceNames}
                blocked={blocked} readOnly={readOnly} disabled={disabled}
                onChange={(nextSpec) => replaceSpec(index, nextSpec)} />

              <BriefEditor page={page} spec={spec} readOnly={readOnly} disabled={disabled}
                blocked={blocked} onChange={(imageGenerationBrief) => replaceSpec(index, {
                  ...spec, imageGenerationBrief,
                })} />

              <details className="detail-editor__advanced">
                <summary>{pageLabel}高级信息（JSON，只读）</summary>
                <pre aria-label={`${pageLabel}细化 JSON`}>{JSON.stringify(spec, null, 2)}</pre>
              </details>

              <button type="button" className="detail-editor__add-page-button"
                aria-label={`在${pageLabel}后新增页面`} disabled={blocked}
                onClick={() => insertPage(index)}>＋ 在本页后新增页面</button>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function ParagraphEditor({
  page, pageId, idPrefix, body, blocked, readOnly, disabled, confirmation, setConfirmation,
  paragraphRefs, onChange,
}: {
  page: number;
  pageId: string;
  idPrefix: string;
  body: readonly string[];
  blocked: boolean;
  readOnly: boolean;
  disabled: boolean;
  confirmation: Confirmation | null;
  setConfirmation: (value: Confirmation | null) => void;
  paragraphRefs: Map<string, HTMLTextAreaElement>;
  onChange: (body: readonly string[], focus?: FocusTarget) => void;
}) {
  const bodyId = `${safeDomPrefix(idPrefix)}-body-${pageId}`;
  return (
    <section className="detail-section" aria-labelledby={bodyId}>
      <h3 id={bodyId}>最终正文</h3>
      <div className="detail-editor__stack">{body.map((paragraph, paragraphIndex) => {
        const number = paragraphIndex + 1;
        const key = `paragraph-${pageId}-${paragraphIndex}`;
        return (
          <div className="detail-editor__collection-item" key={`${pageId}-${paragraphIndex}`}>
            <label>
              <span>第 {page} 页正文第 {number} 段</span>
              <textarea rows={2} aria-label={`第 ${page} 页正文第 ${number} 段`}
                value={paragraph} readOnly={readOnly} disabled={disabled}
                ref={(element) => setMapRef(paragraphRefs, `${pageId}-${paragraphIndex}`, element)}
                onChange={(event) => {
                  if (blocked) return;
                  const next = [...body];
                  next[paragraphIndex] = event.currentTarget.value;
                  onChange(next);
                }} />
            </label>
            <div className="detail-editor__inline-actions">
              <button type="button" className="detail-editor__compact-button"
                aria-label={`在第 ${page} 页正文第 ${number} 段后新增段落`} disabled={blocked}
                onClick={() => {
                  const next = [...body];
                  next.splice(paragraphIndex + 1, 0, '');
                  onChange(next, { kind: 'paragraph', pageId, index: paragraphIndex + 1 });
                }}>新增段落</button>
              <button type="button" className="detail-editor__compact-button detail-editor__delete-button"
                aria-label={`删除第 ${page} 页正文第 ${number} 段`} disabled={blocked || body.length <= 1}
                onClick={() => setConfirmation({
                  key,
                  message: `确认删除第 ${page} 页正文第 ${number} 段？`,
                })}>删除</button>
            </div>
            {confirmation?.key === key && <DeleteConfirmation confirmation={confirmation}
              blocked={blocked} confirmLabel={`确认删除第 ${page} 页正文第 ${number} 段`}
              onCancel={() => setConfirmation(null)} onConfirm={() => {
                setConfirmation(null);
                onChange(body.filter((_, index) => index !== paragraphIndex));
              }} />}
          </div>
        );
      })}</div>
    </section>
  );
}

function TableEditor({
  page, spec, document, blocked, readOnly, disabled, confirmation, setConfirmation, onChange,
}: StructuredEditorProps<readonly SlideTable[]>) {
  const tables = spec.tables;
  return (
    <section className="detail-section">
      <div className="detail-section__heading"><h3>表格</h3>
        <button type="button" className="detail-editor__compact-button"
          aria-label={`第 ${page} 页新增表格`} disabled={blocked}
          onClick={() => onChange([...tables, {
            id: uniqueId('table', document), headers: [''], rows: [['']],
          }])}>＋ 新增表格</button>
      </div>
      {tables.length === 0 && <p className="detail-editor__hint">本页没有表格。</p>}
      {tables.map((table, tableIndex) => {
        const tableNumber = tableIndex + 1;
        const tableKey = `table-${spec.id}-${table.id}`;
        return <div className="detail-editor__structured-card" key={table.id}>
          <div className="detail-section__heading"><h4>表格 {tableNumber}</h4>
            <button type="button" className="detail-editor__compact-button detail-editor__delete-button"
              aria-label={`删除第 ${page} 页表格 ${tableNumber}`} disabled={blocked}
              onClick={() => setConfirmation({ key: tableKey, message: `确认删除第 ${page} 页表格 ${tableNumber}？` })}>
              删除表格
            </button>
          </div>
          {confirmation?.key === tableKey && <DeleteConfirmation confirmation={confirmation}
            blocked={blocked} confirmLabel={`确认删除第 ${page} 页表格 ${tableNumber}`}
            onCancel={() => setConfirmation(null)} onConfirm={() => {
              setConfirmation(null);
              onChange(tables.filter((_, index) => index !== tableIndex));
            }} />}
          <div className="detail-editor__table-scroll" tabIndex={0} aria-label={`第 ${page} 页表格 ${tableNumber}数据`}>
            <table><thead><tr>{table.headers.map((header, columnIndex) => <th key={columnIndex}>
              <input aria-label={`第 ${page} 页表格 ${tableNumber}第 ${columnIndex + 1} 列表头`}
                value={header} readOnly={readOnly} disabled={disabled}
                onChange={(event) => updateTable(tables, tableIndex, {
                  ...table,
                  headers: replaceAt(table.headers, columnIndex, event.currentTarget.value),
                }, blocked, onChange)} />
              <button type="button" className="detail-editor__cell-delete"
                aria-label={`删除第 ${page} 页表格 ${tableNumber} 第 ${columnIndex + 1} 列`}
                disabled={blocked || table.headers.length <= 1}
                onClick={() => setConfirmation({
                  key: `${tableKey}-column-${columnIndex}`,
                  message: `确认删除第 ${page} 页表格 ${tableNumber} 第 ${columnIndex + 1} 列？`,
                })}>删除列</button>
            </th>)}<th>操作</th></tr></thead>
            <tbody>{table.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, columnIndex) =>
              <td key={columnIndex}><input
                aria-label={`第 ${page} 页表格 ${tableNumber} 第 ${rowIndex + 1} 行第 ${columnIndex + 1} 列`}
                value={cell} readOnly={readOnly} disabled={disabled}
                onChange={(event) => {
                  if (blocked) return;
                  const rows = table.rows.map((currentRow, currentIndex) => currentIndex === rowIndex
                    ? replaceAt(currentRow, columnIndex, event.currentTarget.value) : currentRow);
                  updateTable(tables, tableIndex, { ...table, rows }, false, onChange);
                }} /></td>)}<td><button type="button" className="detail-editor__cell-delete"
                  aria-label={`删除第 ${page} 页表格 ${tableNumber} 第 ${rowIndex + 1} 行`}
                  disabled={blocked} onClick={() => setConfirmation({
                    key: `${tableKey}-row-${rowIndex}`,
                    message: `确认删除第 ${page} 页表格 ${tableNumber} 第 ${rowIndex + 1} 行？`,
                  })}>删除行</button></td></tr>)}</tbody></table>
          </div>
          {table.headers.map((_, columnIndex) => confirmation?.key === `${tableKey}-column-${columnIndex}` &&
            <DeleteConfirmation key={columnIndex} confirmation={confirmation} blocked={blocked}
              confirmLabel={`确认删除第 ${page} 页表格 ${tableNumber} 第 ${columnIndex + 1} 列`}
              onCancel={() => setConfirmation(null)} onConfirm={() => {
                setConfirmation(null);
                updateTable(tables, tableIndex, {
                  ...table,
                  headers: table.headers.filter((_, index) => index !== columnIndex),
                  rows: table.rows.map((row) => row.filter((_, index) => index !== columnIndex)),
                }, false, onChange);
              }} />)}
          {table.rows.map((_, rowIndex) => confirmation?.key === `${tableKey}-row-${rowIndex}` &&
            <DeleteConfirmation key={rowIndex} confirmation={confirmation} blocked={blocked}
              confirmLabel={`确认删除第 ${page} 页表格 ${tableNumber} 第 ${rowIndex + 1} 行`}
              onCancel={() => setConfirmation(null)} onConfirm={() => {
                setConfirmation(null);
                updateTable(tables, tableIndex, {
                  ...table,
                  rows: table.rows.filter((_, index) => index !== rowIndex),
                }, false, onChange);
              }} />)}
          <div className="detail-editor__inline-actions">
            <button type="button" className="detail-editor__compact-button"
              aria-label={`第 ${page} 页表格 ${tableNumber} 新增行`} disabled={blocked}
              onClick={() => updateTable(tables, tableIndex, {
                ...table, rows: [...table.rows, table.headers.map(() => '')],
              }, false, onChange)}>新增行</button>
            <button type="button" className="detail-editor__compact-button"
              aria-label={`第 ${page} 页表格 ${tableNumber} 新增列`} disabled={blocked}
              onClick={() => updateTable(tables, tableIndex, {
                ...table,
                headers: [...table.headers, ''],
                rows: table.rows.map((row) => [...row, '']),
              }, false, onChange)}>新增列</button>
          </div>
        </div>;
      })}
    </section>
  );
}

function ChartEditor({
  page, spec, document, blocked, readOnly, disabled, confirmation, setConfirmation, onChange,
}: StructuredEditorProps<readonly SlideChart[]>) {
  const charts = spec.charts;
  return <section className="detail-section">
    <div className="detail-section__heading"><h3>图表</h3>
      <button type="button" className="detail-editor__compact-button" aria-label={`第 ${page} 页新增图表`}
        disabled={blocked} onClick={() => onChange([...charts, {
          id: uniqueId('chart', document), type: 'bar', categories: [''],
          series: [{ name: '', values: [Number.NaN] }],
        }])}>＋ 新增图表</button>
    </div>
    {charts.length === 0 && <p className="detail-editor__hint">本页没有图表。</p>}
    {charts.map((chart, chartIndex) => {
      const chartNumber = chartIndex + 1;
      const chartKey = `chart-${spec.id}-${chart.id}`;
      const update = (next: SlideChart) => onChange(replaceAt(charts, chartIndex, next));
      return <div className="detail-editor__structured-card" key={chart.id}>
        <div className="detail-section__heading"><h4>图表 {chartNumber}</h4>
          <button type="button" className="detail-editor__compact-button detail-editor__delete-button"
            aria-label={`删除第 ${page} 页图表 ${chartNumber}`} disabled={blocked}
            onClick={() => setConfirmation({ key: chartKey, message: `确认删除第 ${page} 页图表 ${chartNumber}？` })}>
            删除图表
          </button>
        </div>
        {confirmation?.key === chartKey && <DeleteConfirmation confirmation={confirmation} blocked={blocked}
          confirmLabel={`确认删除第 ${page} 页图表 ${chartNumber}`} onCancel={() => setConfirmation(null)}
          onConfirm={() => { setConfirmation(null); onChange(charts.filter((_, index) => index !== chartIndex)); }} />}
        <label className="detail-editor__short-field"><span>图表类型</span>
          <select aria-label={`第 ${page} 页图表 ${chartNumber}类型`} value={chart.type} disabled={blocked}
            onChange={(event) => update({ ...chart, type: event.currentTarget.value as SlideChart['type'] })}>
            <option value="bar">柱状图</option><option value="line">折线图</option><option value="pie">饼图</option>
          </select>
        </label>
        <div className="detail-editor__table-scroll" tabIndex={0} aria-label={`第 ${page} 页图表 ${chartNumber}数据`}>
          <table><thead><tr><th>系列</th>{chart.categories.map((category, categoryIndex) => <th key={categoryIndex}>
            <input aria-label={`第 ${page} 页图表 ${chartNumber}分类 ${categoryIndex + 1}`}
              value={category} readOnly={readOnly} disabled={disabled}
              onChange={(event) => !blocked && update({
                ...chart, categories: replaceAt(chart.categories, categoryIndex, event.currentTarget.value),
              })} />
            <button type="button" className="detail-editor__cell-delete"
              aria-label={`删除第 ${page} 页图表 ${chartNumber} 分类 ${categoryIndex + 1}`}
              disabled={blocked || chart.categories.length <= 1}
              onClick={() => setConfirmation({
                key: `${chartKey}-category-${categoryIndex}`,
                message: `确认删除第 ${page} 页图表 ${chartNumber} 分类 ${categoryIndex + 1}？`,
              })}>删除分类</button>
          </th>)}</tr></thead>
          <tbody>{chart.series.map((series, seriesIndex) => <tr key={seriesIndex}>
            <th><input aria-label={`第 ${page} 页图表 ${chartNumber}系列 ${seriesIndex + 1}名称`}
              value={series.name} readOnly={readOnly} disabled={disabled}
              onChange={(event) => !blocked && update({ ...chart, series: replaceAt(chart.series, seriesIndex, {
                ...series, name: event.currentTarget.value,
              }) })} />
              <button type="button" className="detail-editor__cell-delete"
                aria-label={`删除第 ${page} 页图表 ${chartNumber} 系列 ${seriesIndex + 1}`}
                disabled={blocked || chart.series.length <= 1}
                onClick={() => setConfirmation({
                  key: `${chartKey}-series-${seriesIndex}`,
                  message: `确认删除第 ${page} 页图表 ${chartNumber} 系列 ${seriesIndex + 1}？`,
                })}>删除系列</button></th>
            {series.values.map((chartValue, valueIndex) => <td key={valueIndex}><input type="number"
              aria-label={`第 ${page} 页图表 ${chartNumber} 系列 ${seriesIndex + 1} 第 ${valueIndex + 1} 个数值`}
              value={Number.isFinite(chartValue) ? String(chartValue) : ''} readOnly={readOnly} disabled={disabled}
              onChange={(event) => {
                if (blocked) return;
                const raw = event.currentTarget.value;
                const numeric = raw === '' ? Number.NaN : Number(raw);
                update({ ...chart, series: replaceAt(chart.series, seriesIndex, {
                  ...series, values: replaceAt(series.values, valueIndex, numeric),
                }) });
              }} /></td>)}
          </tr>)}</tbody></table>
        </div>
        {chart.categories.map((_, categoryIndex) => confirmation?.key === `${chartKey}-category-${categoryIndex}` &&
          <DeleteConfirmation key={categoryIndex} confirmation={confirmation} blocked={blocked}
            confirmLabel={`确认删除第 ${page} 页图表 ${chartNumber} 分类 ${categoryIndex + 1}`}
            onCancel={() => setConfirmation(null)} onConfirm={() => {
              setConfirmation(null);
              update({
                ...chart,
                categories: chart.categories.filter((_, index) => index !== categoryIndex),
                series: chart.series.map((series) => ({
                  ...series,
                  values: series.values.filter((_, index) => index !== categoryIndex),
                })),
              });
            }} />)}
        {chart.series.map((_, seriesIndex) => confirmation?.key === `${chartKey}-series-${seriesIndex}` &&
          <DeleteConfirmation key={seriesIndex} confirmation={confirmation} blocked={blocked}
            confirmLabel={`确认删除第 ${page} 页图表 ${chartNumber} 系列 ${seriesIndex + 1}`}
            onCancel={() => setConfirmation(null)} onConfirm={() => {
              setConfirmation(null);
              update({ ...chart, series: chart.series.filter((_, index) => index !== seriesIndex) });
            }} />)}
        <div className="detail-editor__inline-actions">
          <button type="button" className="detail-editor__compact-button"
            aria-label={`第 ${page} 页图表 ${chartNumber} 新增分类`} disabled={blocked}
            onClick={() => update({
              ...chart,
              categories: [...chart.categories, ''],
              series: chart.series.map((series) => ({ ...series, values: [...series.values, Number.NaN] })),
            })}>新增分类</button>
          <button type="button" className="detail-editor__compact-button"
            aria-label={`第 ${page} 页图表 ${chartNumber} 新增系列`} disabled={blocked}
            onClick={() => update({ ...chart, series: [...chart.series, {
              name: '', values: chart.categories.map(() => Number.NaN),
            }] })}>新增系列</button>
        </div>
      </div>;
    })}
  </section>;
}

function ShapeEditor({
  page, spec, document, blocked, readOnly, disabled, confirmation, setConfirmation, onChange,
}: StructuredEditorProps<readonly SlideShape[]>) {
  const shapes = spec.shapes;
  return <section className="detail-section">
    <div className="detail-section__heading"><h3>基础形状</h3>
      <button type="button" className="detail-editor__compact-button" aria-label={`第 ${page} 页新增基础形状`}
        disabled={blocked} onClick={() => onChange([...shapes, {
          id: uniqueId('shape', document), type: 'rect', x: 0, y: 0, w: 1, h: 1,
        }])}>＋ 新增形状</button>
    </div>
    {shapes.length === 0 && <p className="detail-editor__hint">本页没有带坐标的基础形状。</p>}
    {shapes.map((shape, shapeIndex) => {
      const number = shapeIndex + 1;
      const key = `shape-${spec.id}-${shape.id}`;
      const update = (next: SlideShape) => onChange(replaceAt(shapes, shapeIndex, next));
      return <details className="detail-editor__structured-card" key={shape.id}>
        <summary>形状 {number}：{shapeTypeLabel(shape.type)}</summary>
        <button type="button" className="detail-editor__compact-button detail-editor__delete-button"
          aria-label={`删除第 ${page} 页形状 ${number}`} disabled={blocked}
          onClick={() => setConfirmation({ key, message: `确认删除第 ${page} 页形状 ${number}？` })}>删除形状</button>
        {confirmation?.key === key && <DeleteConfirmation confirmation={confirmation} blocked={blocked}
          confirmLabel={`确认删除第 ${page} 页形状 ${number}`} onCancel={() => setConfirmation(null)}
          onConfirm={() => { setConfirmation(null); onChange(shapes.filter((_, index) => index !== shapeIndex)); }} />}
        <div className="detail-editor__shape-grid">
          <label><span>类型</span><select aria-label={`第 ${page} 页形状 ${number}类型`}
            value={shape.type} disabled={blocked}
            onChange={(event) => update({ ...shape, type: event.currentTarget.value as SlideShape['type'] })}>
            <option value="rect">矩形</option><option value="ellipse">椭圆</option><option value="line">线条</option>
          </select></label>
          {([['x', '横坐标'], ['y', '纵坐标'], ['w', '宽度'], ['h', '高度']] as const).map(([field, label]) =>
            <label key={field}><span>{label}（英寸）</span><input type="number" step="any"
              aria-label={`第 ${page} 页形状 ${number} ${label}`}
              value={Number.isFinite(shape[field]) ? String(shape[field]) : ''} readOnly={readOnly} disabled={disabled}
              onChange={(event) => !blocked && update({
                ...shape, [field]: event.currentTarget.value === '' ? Number.NaN : Number(event.currentTarget.value),
              })} /></label>)}
          {([['fill', '填充色'], ['line', '线条色'], ['text', '文字']] as const).map(([field, label]) =>
            <label key={field}><span>{label}</span><input
              aria-label={`第 ${page} 页形状 ${number}${label}`} value={shape[field] ?? ''}
              readOnly={readOnly} disabled={disabled}
              onChange={(event) => !blocked && update({ ...shape, [field]: event.currentTarget.value })} /></label>)}
        </div>
      </details>;
    })}
  </section>;
}

function EvidenceEditor({
  page, spec, analysis, sourceNames, blocked, readOnly, disabled, onChange,
}: {
  page: number;
  spec: SlideSpec;
  analysis: SourceAnalysis | null;
  sourceNames: ReadonlyMap<string, string>;
  blocked: boolean;
  readOnly: boolean;
  disabled: boolean;
  onChange: (spec: SlideSpec) => void;
}) {
  const toggleId = (key: 'findingIds' | 'dataPointIds', id: string, checked: boolean) => {
    if (blocked) return;
    const existing = spec[key] ?? [];
    onChange({ ...spec, [key]: checked ? uniqueStrings([...existing, id]) : existing.filter((value) => value !== id) });
  };
  const citationSelected = (citation: SourceCitation) => spec.sourceMap.some((current) =>
    current.sourceId === citation.sourceId && current.title === citation.title && current.locator === citation.locator);
  return <section className="detail-section">
    <h3>来源与依据</h3>
    <div className="detail-editor__evidence-summary">
      <EvidenceSummary title="核心事实" values={(spec.findingIds ?? []).map((id) =>
        analysis?.findings.find((finding) => finding.id === id)?.text ?? '一条历史事实引用无法解析。')} />
      <EvidenceSummary title="数据依据" values={(spec.dataPointIds ?? []).map((id) => {
        const point = analysis?.dataPoints.find((dataPoint) => dataPoint.id === id);
        return point ? `${point.label}：${String(point.value)}${point.unit ? ` ${point.unit}` : ''}` : '一条历史数据引用无法解析。';
      })} />
    </div>
    <div className="detail-editor__stack">{spec.sourceMap.map((citation, sourceIndex) => <div
      className="detail-editor__source" key={`${citation.sourceId}-${sourceIndex}`}>
      <strong>{sourceNames.get(citation.sourceId) ?? citation.title}</strong>
      <label><span>第 {page} 页来源 {sourceIndex + 1} 定位</span><input
        aria-label={`第 ${page} 页来源 ${sourceIndex + 1} 定位`} value={citation.locator}
        readOnly={readOnly} disabled={disabled}
        onChange={(event) => !blocked && onChange({
          ...spec, sourceMap: replaceAt(spec.sourceMap, sourceIndex, {
            ...citation, locator: event.currentTarget.value,
          }),
        })} /></label>
    </div>)}</div>
    {!spec.sourceMap.length && <p className="detail-editor__hint">本页尚未绑定参考来源。</p>}
    <details className="detail-editor__picker">
      <summary>调整第 {page} 页来源与依据</summary>
      <fieldset disabled={blocked}>
        <legend className="detail-editor__visually-hidden">第 {page} 页来源与依据选择</legend>
        <Picker title="核心事实">{analysis?.findings.length ? analysis.findings.map((finding) => <label key={finding.id}>
          <input type="checkbox" checked={(spec.findingIds ?? []).includes(finding.id)}
            onChange={(event) => toggleId('findingIds', finding.id, event.currentTarget.checked)} />
          <span>结论：{finding.text}</span>
        </label>) : <p>材料分析中暂无可选核心事实。</p>}</Picker>
        <Picker title="数据依据">{analysis?.dataPoints.length ? analysis.dataPoints.map((point) => <label key={point.id}>
          <input type="checkbox" checked={(spec.dataPointIds ?? []).includes(point.id)}
            onChange={(event) => toggleId('dataPointIds', point.id, event.currentTarget.checked)} />
          <span>数据：{point.label}：{String(point.value)}{point.unit ? ` ${point.unit}` : ''}</span>
        </label>) : <p>材料分析中暂无可选数据。</p>}</Picker>
        <Picker title="参考来源">{analysis?.sourceMap.length ? analysis.sourceMap.map((citation, citationIndex) => {
          const fileName = sourceNames.get(citation.sourceId);
          const selected = citationSelected(citation);
          return <label key={`${citation.sourceId}-${citationIndex}-${citation.locator}`}>
            <input type="checkbox" aria-label={`来源：${fileName ?? citation.title}，${citation.locator}`}
              checked={selected} disabled={blocked || !fileName}
              onChange={(event) => {
                if (blocked || !fileName) return;
                onChange({ ...spec, sourceMap: event.currentTarget.checked
                  ? [...spec.sourceMap, citation]
                  : spec.sourceMap.filter((current) => current !== citation && !(
                    current.sourceId === citation.sourceId && current.title === citation.title && current.locator === citation.locator
                  )) });
              }} />
            <span aria-hidden="true">来源：{fileName ?? citation.title}，{citation.locator}</span>
          </label>;
        }) : <p>材料分析中暂无可选来源。</p>}</Picker>
      </fieldset>
    </details>
  </section>;
}

function BriefEditor({
  page, spec, readOnly, disabled, blocked, onChange,
}: {
  page: number;
  spec: SlideSpec;
  readOnly: boolean;
  disabled: boolean;
  blocked: boolean;
  onChange: (value: string) => void;
}) {
  const compatibility = parseCompatibilityBrief(spec.imageGenerationBrief);
  return <section className="detail-section">
    <h3>构图与图片提示词</h3>
    <label><span>第 {page} 页图片提示词</span><textarea rows={3}
      aria-label={`第 ${page} 页图片提示词`} value={compatibility.mainText}
      readOnly={readOnly} disabled={disabled}
      onChange={(event) => !blocked && onChange(replaceCompatibilityMainText(
        spec.imageGenerationBrief, event.currentTarget.value,
      ))} /></label>
    {compatibility.suffix && <div className="detail-editor__recovery">
      <p className="detail-editor__recovery-note">恢复补充是历史设计背景，不是当前数据的权威来源。</p>
      <p>来自恢复原稿，需结合当前正文、表格和有效来源核对；不会按旧索引重新关联。</p>
      {compatibility.supplement
        ? <KnownSupplement supplement={compatibility.supplement} />
        : <p className="detail-editor__warning">原始补充资料已保留，但无法识别为受支持的结构。</p>}
      <details><summary>查看恢复补充原文（只读）</summary>
        <pre aria-label={`第 ${page} 页恢复补充原文`}>{compatibility.suffix}</pre>
      </details>
    </div>}
  </section>;
}

function KnownSupplement({ supplement }: { supplement: Readonly<Record<string, unknown>> }) {
  const concepts = Array.isArray(supplement.conceptualShapes) ? supplement.conceptualShapes : [];
  const tables = Object.entries(supplement).filter(([key]) => /^table-\d+$/.test(key));
  const citations = Object.entries(supplement).filter(([key]) => /^citation-\d+$/.test(key));
  return <div className="detail-editor__supplement">
    {concepts.length > 0 && <section><h4>概念构图</h4>{concepts.map((concept, index) =>
      <ReadableProperties key={index} value={concept} preferredType />)}</section>}
    {tables.length > 0 && <section><h4>历史表格备注</h4>{tables.map(([key, item]) =>
      <ReadableProperties key={key} value={item} />)}</section>}
    {citations.length > 0 && <section><h4>历史来源说明</h4>{citations.map(([key, item]) =>
      <ReadableProperties key={key} value={item} />)}</section>}
  </div>;
}

function ReadableProperties({ value, preferredType = false }: { value: unknown; preferredType?: boolean }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return <p>{readableValue(value)}</p>;
  const entries = Object.entries(value as Record<string, unknown>);
  const type = typeof (value as Record<string, unknown>).type === 'string'
    ? String((value as Record<string, unknown>).type) : '';
  return <div className="detail-editor__properties">
    {preferredType && type && <strong>{conceptTypeLabel(type)}</strong>}
    <dl>{entries.filter(([key]) => !(preferredType && key === 'type')).map(([key, item]) => <div key={key}>
      <dt>{propertyLabel(key)}</dt><dd>{readableValue(item)}</dd>
    </div>)}</dl>
  </div>;
}

function DeleteConfirmation({ confirmation, blocked, confirmLabel, onCancel, onConfirm }: {
  confirmation: Confirmation;
  blocked: boolean;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return <div className="detail-editor__confirmation" role="alert">
    <p>{confirmation.message}</p><div>
      <button type="button" className="detail-editor__compact-button detail-editor__delete-button"
        aria-label={confirmLabel} disabled={blocked} onClick={onConfirm}>确认删除</button>
      <button type="button" className="detail-editor__compact-button" aria-label={`取消${confirmLabel}`}
        disabled={blocked} onClick={onCancel}>取消</button>
    </div>
  </div>;
}

interface StructuredEditorProps<T> {
  page: number;
  spec: SlideSpec;
  document: DetailDocument;
  blocked: boolean;
  readOnly: boolean;
  disabled: boolean;
  confirmation: Confirmation | null;
  setConfirmation: (value: Confirmation | null) => void;
  onChange: (value: T) => void;
}

function EvidenceSummary({ title, values }: { title: string; values: readonly string[] }) {
  return <section><h4>{title}</h4>{values.length
    ? <ul>{values.map((value, index) => <li key={index}>{value}</li>)}</ul>
    : <p className="detail-editor__hint">暂无。</p>}</section>;
}

function Picker({ title, children }: { title: string; children: ReactNode }) {
  return <section><h4>{title}</h4><div>{children}</div></section>;
}

function updateTable(
  tables: readonly SlideTable[],
  index: number,
  table: SlideTable,
  blocked: boolean,
  onChange: (tables: readonly SlideTable[]) => void,
) {
  if (!blocked) onChange(replaceAt(tables, index, table));
}

function replaceAt<T>(values: readonly T[], index: number, value: T): T[] {
  return values.map((current, currentIndex) => currentIndex === index ? value : current);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function uniqueId(prefix: 'slide' | 'table' | 'chart' | 'shape', document: DetailDocument): string {
  const existing = collectDocumentIds(document);
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const id = `${prefix}-${crypto.randomUUID()}`;
    if (!existing.has(id)) return id;
  }
  throw new Error('无法生成唯一对象 ID，请重试。');
}

function collectDocumentIds(document: DetailDocument): Set<string> {
  const ids = new Set(document.outline.slides.map(({ id }) => id));
  for (const spec of document.specs) {
    ids.add(spec.id);
    spec.tables.forEach(({ id }) => ids.add(id));
    spec.charts.forEach(({ id }) => ids.add(id));
    spec.shapes.forEach(({ id }) => ids.add(id));
    collectSupplementIds(parseCompatibilityBrief(spec.imageGenerationBrief).supplement, ids);
  }
  return ids;
}

function collectSupplementIds(value: unknown, ids: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectSupplementIds(item, ids));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'id' && typeof item === 'string') ids.add(item);
    collectSupplementIds(item, ids);
  }
}

function pageDomId(prefix: string, pageId: string): string {
  return `${safeDomPrefix(prefix)}-page-${pageId}`;
}

function safeDomPrefix(prefix: string): string {
  return prefix.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function setMapRef<T>(map: Map<string, T>, key: string, value: T | null): void {
  if (value) map.set(key, value);
  else map.delete(key);
}

function shapeTypeLabel(type: SlideShape['type']): string {
  return { rect: '矩形', ellipse: '椭圆', line: '线条' }[type];
}

function conceptTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    flowDiagram: '流程构图', flowchart: '流程构图', layeredDiagram: '分层构图',
    hierarchyDiagram: '层级构图', conceptDiagram: '概念构图', lifecycleDiagram: '生命周期构图',
    swimlaneDiagram: '泳道构图', parallelProcessDiagram: '并行流程构图',
    inputOutputDiagram: '输入输出构图', scopeDiagram: '范围构图', textComposition: '文字构图',
  };
  return labels[type] ?? `历史概念构图（${type}）`;
}

function propertyLabel(key: string): string {
  const labels: Record<string, string> = {
    id: '原始 ID', title: '标题', note: '备注', sourceId: '来源', basis: '依据',
    targets: '目标', analysisRefs: '分析引用', nodes: '节点', edges: '连线', layout: '布局', text: '文字',
  };
  return labels[key] ?? key;
}

function readableValue(value: unknown): string {
  if (value === null) return '空';
  if (Array.isArray(value)) return value.map(readableValue).join('、');
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${propertyLabel(key)}：${readableValue(item)}`).join('；');
  }
  return String(value);
}

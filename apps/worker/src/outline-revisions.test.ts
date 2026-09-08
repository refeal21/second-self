import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import { NativePptRpcRuntime, parseNativePipelineAction, type NativePipelineAction, type NativePptPipeline } from './native-pipeline.js';

const projectId = 'revision-project';
const at = (minute: number) => `2026-09-08T01:${String(minute).padStart(2, '0')}:00.000Z`;
const outline = { title: '合成汇报', slides: [
  { id: 'page-a', title: '第一页', purpose: '介绍' },
  { id: 'page-b', title: '第二页', purpose: '说明' },
] };
const specs = outline.slides.map((page, index) => ({
  id: page.id, title: page.title, body: [index ? '第二页原文' : '第一段\n保留换行', '特殊字符 {"x":1}'],
  tables: [], charts: [], shapes: [], sourceMap: [], imageGenerationBrief: '用户填写的构图提示词',
}));
const png = new PNG({ width: 640, height: 360 });
for (let offset = 0; offset < png.data.length; offset += 4) {
  png.data[offset] = 30 + (offset / 4) % 180;
  png.data[offset + 1] = 100;
  png.data[offset + 2] = 180;
  png.data[offset + 3] = 255;
}
const imageBase64 = PNG.sync.write(png).toString('base64');

async function setup() {
  const runtime = new NativePptRpcRuntime({ imageGenAvailable: false });
  const intake = runtime.create({ id: projectId, name: '合成项目', goal: '验证结构修订', createdAt: at(0) });
  intake.sources.push({ id: 'source-one', fileName: 'synthetic.txt', mediaType: 'text/plain', relativePath: 'sources/synthetic.txt', sha256: 'a'.repeat(64), byteLength: 1 });
  await runtime.restore(intake);
  await runtime.execute(projectId, { kind: 'analysis.commit', at: at(1), requestId: 'analysis-one', output: { findings: [], dataPoints: [], sourceMap: [{ sourceId: 'source-one', title: '合成来源', locator: '第一行' }] } });
  await runtime.execute(projectId, { kind: 'outline.submit', at: at(2), outline });
  await runtime.execute(projectId, { kind: 'outline.approve', at: at(3) });
  await runtime.execute(projectId, { kind: 'details.submit', at: at(4), specs });
  return runtime;
}

function revisionSave(runtime: NativePptRpcRuntime, minute = 5, revisionId = 'revision-one') {
  const before = runtime.snapshot(projectId);
  return parseNativePipelineAction({ kind: 'outline.revision.save', at: at(minute),
    expectedRevision: before.revision, revisionId, baseOutlineVersionId: before.outline!.version.id,
    outline: { ...outline, slides: [...outline.slides].reverse() }, specs: [...specs].reverse(),
  });
}

describe('native outline revisions', () => {
  it('saves a pending structure without changing frozen outline, details or approvals', async () => {
    const runtime = await setup();
    const before = runtime.snapshot(projectId);
    const result = await runtime.execute(projectId, revisionSave(runtime));
    expect(result.pipeline.outline).toEqual(before.outline);
    expect(result.pipeline.slideSpecs).toEqual(before.slideSpecs);
    expect(result.pipeline.approvals).toEqual(before.approvals);
    expect(result.pipeline).toMatchObject({ schemaVersion: 2, revision: 6,
      project: { workflowStatus: 'detail_review' },
      outlineRevisionDraft: { id: 'revision-one', specs: [{ id: 'page-b', body: specs[1]!.body }, { id: 'page-a' }] },
    });
    await expect(new NativePptRpcRuntime({ imageGenAvailable: false }).restore(result.pipeline)).resolves.toEqual(result.pipeline);
  });

  it('confirms only the outline and preserves historical evidence through detail approval and export replay', async () => {
    const runtime = await setup();
    const original = runtime.snapshot(projectId);
    const pendingBeforeRename = await runtime.execute(projectId, revisionSave(runtime));
    pendingBeforeRename.pipeline.project.name = '人工重新命名项目';
    await runtime.restore(pendingBeforeRename.pipeline);
    const confirmed = await runtime.execute(projectId, parseNativePipelineAction({
      kind: 'outline.revision.approve', at: at(6), expectedRevision: 6,
      revisionId: 'revision-one', baseOutlineVersionId: original.outline!.version.id,
    }));
    expect(confirmed.pipeline.outline).toMatchObject({ version: { id: `${projectId}-outline-v2`, sequence: 2, status: 'frozen', frozenAt: at(6) } });
    expect(confirmed.pipeline.slideSpecs).toMatchObject({ version: { id: `${projectId}-slide-specs-v2`, sequence: 2, status: 'draft' }, value: [...specs].reverse() });
    expect(confirmed.pipeline.approvals[0]).toEqual(original.approvals[0]);
    expect(confirmed.pipeline.approvals).toHaveLength(2);
    expect(confirmed.pipeline.project.workflowStatus).toBe('detail_review');
    expect(confirmed.writes.map((write) => write.relativePath)).toContain('outline/outline-v2.json');
    expect(confirmed.writes.map((write) => write.relativePath)).toContain('slide-specs/slide-specs-v2.json');
    await runtime.restore(confirmed.pipeline);
    const approved = await runtime.execute(projectId, parseNativePipelineAction({ kind: 'details.approve', at: at(7), expectedRevision: 7 }));
    expect(approved.pipeline.slideSpecs!.version.id).toBe(`${projectId}-slide-specs-v2`);
    expect(approved.pipeline.approvals.slice(0, 2)).toEqual(confirmed.pipeline.approvals);
    await runtime.restore(approved.pipeline);
    for (const [index, slideId] of ['page-b', 'page-a'].entries()) {
      await runtime.execute(projectId, { kind: 'visual.replace', at: at(8 + index * 2), slideId,
        imageBase64, altText: '合成图片' });
      await runtime.execute(projectId, { kind: 'visual.approve', at: at(9 + index * 2), slideId });
      await runtime.restore(runtime.snapshot(projectId));
    }
    const exported = await runtime.execute(projectId, { kind: 'deck.export', at: at(12), fileName: 'synthetic.pptx', visualBytes: { 'page-b': imageBase64, 'page-a': imageBase64 } });
    expect(exported.pipeline.exportReceipt!.specVersionId).toBe(`${projectId}-slide-specs-v2`);
    await expect(new NativePptRpcRuntime({ imageGenAvailable: false }).restore(exported.pipeline)).resolves.toEqual(exported.pipeline);
    const qa = await runtime.execute(projectId, { kind: 'deck.qa', at: at(13), preparation: { status: 'blocked', issue: '合成环境未运行外部渲染', capability: 'libreoffice' } });
    expect(qa.pipeline.exportReceipt!.specVersionId).toBe(`${projectId}-slide-specs-v2`);
    await runtime.restore(qa.pipeline);
    const completed = await runtime.execute(projectId, { kind: 'deck.qa', at: at(14), preparation: {
      status: 'ready', sofficePath: '/synthetic/soffice', rendererPath: '/synthetic/pdftoppm',
      pdfBase64: Buffer.from('synthetic PDF fixture').toString('base64'), pptxBase64: exported.writes.find(({ kind }) => kind === 'pptx')!.contentsBase64,
      renderedPages: [1, 2].map((number) => ({ fileName: `rendered-${number}.png`, contentsBase64: imageBase64 })),
      approvedVisuals: ['page-b', 'page-a'].map((slideId) => ({ slideId, relativePath: `visuals/${slideId}-v1.png`, contentsBase64: imageBase64 })),
      fontAvailability: { 'Hiragino Sans GB': true },
    } });
    expect(completed.pipeline.qaReport!.issues).toEqual([]);
    expect(completed.pipeline.project.workflowStatus).toBe('completed');
    expect(completed.pipeline.qaReport!.status).toBe('passed');
    expect(completed.pipeline.approvals.slice(0, 2)).toEqual(confirmed.pipeline.approvals);
    await runtime.restore(completed.pipeline);
    const corruptArchive = await JSZip.loadAsync(Buffer.from(exported.writes.find(({ kind }) => kind === 'pptx')!.contentsBase64, 'base64'));
    const secondPage = await corruptArchive.file('ppt/slides/slide2.xml')!.async('string');
    corruptArchive.file('ppt/slides/slide2.xml', secondPage.replace('第一段', '篡改正文'));
    const corruptBytes = await corruptArchive.generateAsync({ type: 'nodebuffer' });
    const corruptCheckpoint = structuredClone(exported.pipeline);
    corruptCheckpoint.exportReceipt!.sha256 = createHash('sha256').update(corruptBytes).digest('hex');
    corruptCheckpoint.exportReceipt!.byteLength = corruptBytes.length;
    const corruptionCheck = new NativePptRpcRuntime({ imageGenAvailable: false });
    await corruptionCheck.restore(corruptCheckpoint);
    const rejected = await corruptionCheck.execute(projectId, { kind: 'deck.qa', at: at(13), preparation: {
      status: 'ready', sofficePath: '/synthetic/soffice', rendererPath: '/synthetic/pdftoppm',
      pdfBase64: Buffer.from('synthetic PDF fixture').toString('base64'), pptxBase64: corruptBytes.toString('base64'),
      renderedPages: [1, 2].map((number) => ({ fileName: `rendered-${number}.png`, contentsBase64: imageBase64 })),
      approvedVisuals: ['page-b', 'page-a'].map((slideId) => ({ slideId, relativePath: `visuals/${slideId}-v1.png`, contentsBase64: imageBase64 })),
      fontAvailability: { 'Hiragino Sans GB': true },
    } });
    expect(rejected.pipeline.qaReport!.issues).toContain('Editable body text is missing on page 2: 第一段\n保留换行');
    expect(rejected.pipeline.project.workflowStatus).toBe('blocked');
  });

  it('requires the editor baseline for edits to existing details', async () => {
    const runtime = await setup();
    await expect(runtime.execute(projectId, { kind: 'details.submit', at: at(5), specs })).rejects.toThrow(/revision|baseline/i);
    await expect(runtime.execute(projectId, { kind: 'details.submit', at: at(5), specs, expectedRevision: 4 } as NativePipelineAction)).rejects.toThrow(/revision|baseline/i);
  });

  it('keeps repeated saves, cancellation and two successive revisions independently restorable', async () => {
    const runtime = await setup();
    const original = runtime.snapshot(projectId);
    await runtime.execute(projectId, revisionSave(runtime));
    const repeated = await runtime.execute(projectId, revisionSave(runtime, 6));
    expect(repeated.pipeline.outlineRevisionDraft!.createdAt).toBe(at(5));
    expect(repeated.pipeline.outlineRevisionDraft!.updatedAt).toBe(at(6));
    await runtime.execute(projectId, parseNativePipelineAction({ kind: 'outline.revision.cancel', at: at(7), expectedRevision: 7,
      revisionId: 'revision-one', baseOutlineVersionId: original.outline!.version.id }));
    const cancelled = runtime.snapshot(projectId);
    expect(cancelled.outline).toEqual(original.outline);
    expect(cancelled.slideSpecs).toEqual(original.slideSpecs);
    expect(cancelled.approvals).toEqual(original.approvals);
    expect(cancelled.revisionHistory![0]).toMatchObject({ status: 'cancelled', draft: repeated.pipeline.outlineRevisionDraft, baseSlideSpecs: original.slideSpecs });
    await runtime.restore(cancelled);
    await expect(runtime.execute(projectId, revisionSave(runtime, 8))).rejects.toThrow(/used/);
    for (const [index, revisionId] of ['revision-two', 'revision-three'].entries()) {
      const saved = await runtime.execute(projectId, revisionSave(runtime, 8 + index * 2, revisionId));
      await runtime.execute(projectId, parseNativePipelineAction({ kind: 'outline.revision.approve', at: at(9 + index * 2), expectedRevision: saved.pipeline.revision,
        revisionId, baseOutlineVersionId: saved.pipeline.outline!.version.id }));
      await runtime.restore(runtime.snapshot(projectId));
    }
    const final = runtime.snapshot(projectId);
    expect(final.outline!.version.sequence).toBe(3);
    expect(final.revisionHistory).toHaveLength(3);
    expect(final.approvals).toHaveLength(3);
    expect(final.revisionHistory![1]!.baseOutline).toEqual(original.outline);
    const edited = final.slideSpecs!.value.map((page) => ({ ...page, body: ['保存人工细化'] }));
    const updated = await runtime.execute(projectId, { kind: 'details.submit', at: at(12), expectedRevision: final.revision, specs: edited });
    expect(updated.pipeline.slideSpecs!.value[0]!.body).toEqual(['保存人工细化']);
    expect(updated.pipeline.slideSpecs!.version.sequence).toBe(4);
    expect(updated.writes[0]!.relativePath).toBe('slide-specs/slide-specs-v4.json');
    await runtime.restore(updated.pipeline);
  });

  it.each(['add', 'delete', 'title', 'purpose'] as const)('supports a %s structure change without reassigning page content', async (change) => {
    const runtime = await setup();
    const nextOutline = structuredClone(outline);
    const nextSpecs = structuredClone(specs);
    if (change === 'add') {
      nextOutline.slides.push({ id: 'page-new', title: '新增页', purpose: '补充说明' });
      nextSpecs.push({ ...structuredClone(specs[0]!), id: 'page-new', title: '新增页', body: ['人工新页'] });
    } else if (change === 'delete') { nextOutline.slides.splice(0, 1); nextSpecs.splice(0, 1); }
    else if (change === 'title') { nextOutline.slides[0]!.title = '新标题'; nextSpecs[0]!.title = '新标题'; }
    else { nextOutline.slides[0]!.purpose = '新的页面目的'; }
    const action = { ...revisionSave(runtime), outline: nextOutline, specs: nextSpecs } as NativePipelineAction;
    const saved = await runtime.execute(projectId, action);
    expect(saved.pipeline.outlineRevisionDraft!.specs.find(({ id }) => id === 'page-b')).toEqual(specs[1]);
    await runtime.restore(saved.pipeline);
  });

  it.each([
    ['stale revision', { expectedRevision: 4 }], ['stale base', { baseOutlineVersionId: 'missing-version' }],
    ['duplicate page', { outline: { ...outline, slides: [outline.slides[0], outline.slides[0]] } }],
    ['unknown reference', { outline: { ...outline, slides: [{ ...outline.slides[0], sourceIds: ['unknown'] }, outline.slides[1]] }, specs }],
    ['empty pages', { outline: { title: '空大纲', slides: [] }, specs: [] }],
    ['wrong order', { outline, specs: [...specs].reverse() }],
    ['title mismatch', { outline, specs: [{ ...specs[0], title: '不一致' }, specs[1]] }],
    ['incomplete page body', { outline, specs: [{ ...specs[0], body: [] }, specs[1]] }],
    ['blank page purpose', { outline: { ...outline, slides: [{ ...outline.slides[0], purpose: '  ' }, outline.slides[1]] }, specs }],
    ['blank image brief', { outline, specs: [{ ...specs[0], imageGenerationBrief: '  ' }, specs[1]] }],
  ])('rejects %s without changing state', async (_name, changes) => {
    const runtime = await setup();
    const before = runtime.snapshot(projectId);
    await expect(runtime.execute(projectId, { ...revisionSave(runtime), ...changes } as NativePipelineAction)).rejects.toThrow();
    expect(runtime.snapshot(projectId)).toEqual(before);
  });

  it.each(['details.approve', 'details.submit', 'visual.generate', 'deck.export'])('blocks %s while a revision is pending', async (kind) => {
    const runtime = await setup();
    await runtime.execute(projectId, revisionSave(runtime));
    const action = kind === 'details.submit' ? { kind, at: at(6), specs }
      : kind === 'visual.generate' ? { kind, at: at(6), slideId: 'page-a' }
        : kind === 'deck.export' ? { kind, at: at(6), fileName: 'bad.pptx', visualBytes: {} } : { kind, at: at(6) };
    await expect(runtime.execute(projectId, action as NativePipelineAction)).rejects.toThrow(/Pending outline revision/);
  });

  it.each([
    ['unknown schema', (state: NativePptPipeline) => { state.schemaVersion = 3 as 2; }],
    ['changed origin', (state: NativePptPipeline) => { state.revisionOrigin!.schemaVersion = 2; }],
    ['changed history', (state: NativePptPipeline) => { state.revisionHistory![0]!.baseSlideSpecs.value = []; }],
    ['approval timestamp', (state: NativePptPipeline) => { state.approvals[0]!.decidedAt = at(20); }],
    ['event timestamp', (state: NativePptPipeline) => { state.revisionEvents![0]!.at = at(20); }],
    ['event baseline', (state: NativePptPipeline) => { state.revisionEvents![0]!.expectedRevision = 1; }],
    ['extra field', (state: NativePptPipeline) => { Object.assign(state.revisionHistory![0]!, { fake: true }); }],
  ])('rejects tampered %s on process restart', async (_name, tamper) => {
    const runtime = await setup();
    const saved = await runtime.execute(projectId, revisionSave(runtime));
    const result = await runtime.execute(projectId, parseNativePipelineAction({ kind: 'outline.revision.approve', at: at(6), expectedRevision: saved.pipeline.revision,
      revisionId: 'revision-one', baseOutlineVersionId: saved.pipeline.outline!.version.id }));
    tamper(result.pipeline);
    await expect(new NativePptRpcRuntime({ imageGenAvailable: false }).restore(result.pipeline)).rejects.toThrow();
  });

  it('rejects edits and revisions after details freeze', async () => {
    const runtime = await setup();
    const approved = await runtime.execute(projectId, { kind: 'details.approve', at: at(5), expectedRevision: 5 });
    await expect(runtime.execute(projectId, revisionSave(runtime, 6))).rejects.toThrow(/unfrozen/);
    await expect(runtime.execute(projectId, { kind: 'details.submit', at: at(6), specs, expectedRevision: approved.pipeline.revision })).rejects.toThrow();
  });

  it('rejects invalid approval dates and visual times before the current detail approval', async () => {
    const runtime = await setup();
    const saved = await runtime.execute(projectId, revisionSave(runtime));
    await runtime.execute(projectId, parseNativePipelineAction({ kind: 'outline.revision.approve', at: at(6), expectedRevision: saved.pipeline.revision,
      revisionId: 'revision-one', baseOutlineVersionId: saved.pipeline.outline!.version.id }));
    const approved = await runtime.execute(projectId, { kind: 'details.approve', at: at(7), expectedRevision: 7 });
    const malformed = structuredClone(approved.pipeline);
    malformed.slideSpecs!.version.frozenAt = 'not-a-date';
    malformed.approvals.at(-1)!.decidedAt = 'not-a-date';
    malformed.project.updatedAt = 'not-a-date';
    await expect(new NativePptRpcRuntime({ imageGenAvailable: false }).restore(malformed)).rejects.toThrow(/time|date|chronology/i);
    await expect(runtime.execute(projectId, { kind: 'visual.replace', at: at(6), slideId: 'page-b', imageBase64, altText: '合成' })).rejects.toThrow(/time|date|chronology/i);
  });

  it('preserves or reconciles legacy v1 titles but rejects a newly divergent title', async () => {
    const runtime = await setup();
    const legacy = runtime.snapshot(projectId);
    legacy.slideSpecs!.value = legacy.slideSpecs!.value.map((page) => ({ ...page, title: '旧恢复标题' }));
    await runtime.restore(legacy);
    const bodyEdit = legacy.slideSpecs!.value.map((page) => ({ ...page, body: ['用户改正文'] }));
    const saved = await runtime.execute(projectId, { kind: 'details.submit', at: at(5), expectedRevision: legacy.revision, specs: bodyEdit });
    expect(saved.pipeline.slideSpecs!.value[0]!.title).toBe('旧恢复标题');
    const reconciled = await runtime.execute(projectId, { kind: 'details.submit', at: at(6), expectedRevision: saved.pipeline.revision,
      specs: saved.pipeline.slideSpecs!.value.map((page, index) => ({ ...page, title: outline.slides[index]!.title })) });
    expect(reconciled.pipeline.schemaVersion).toBe(1);
    await expect(runtime.execute(projectId, { kind: 'details.submit', at: at(7), expectedRevision: reconciled.pipeline.revision,
      specs: reconciled.pipeline.slideSpecs!.value.map((page) => ({ ...page, title: '全新结构标题' })) })).rejects.toThrow(/title|revision/i);
  });

  it('rejects the second concurrent detail save using the same editor baseline', async () => {
    const runtime = await setup();
    const actions = ['first', 'second'].map((body) => runtime.execute(projectId, { kind: 'details.submit', at: at(5), expectedRevision: 5,
      specs: specs.map((page) => ({ ...page, body: [body] })) }));
    const results = await Promise.allSettled(actions);
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(runtime.snapshot(projectId).revision).toBe(6);
  });

  it('allows ordinary legacy body edits after cancelling the first v2 revision', async () => {
    const runtime = await setup();
    const legacy = runtime.snapshot(projectId);
    legacy.slideSpecs!.value = legacy.slideSpecs!.value.map((page) => ({ ...page, title: '旧恢复标题' }));
    await runtime.restore(legacy);
    const candidateOutline = { ...outline, slides: outline.slides.map((page) => ({ ...page, title: '旧恢复标题' })) };
    await runtime.execute(projectId, parseNativePipelineAction({ kind: 'outline.revision.save', at: at(5), expectedRevision: 5,
      revisionId: 'legacy-revision', baseOutlineVersionId: legacy.outline!.version.id, outline: candidateOutline, specs: legacy.slideSpecs!.value }));
    await runtime.execute(projectId, parseNativePipelineAction({ kind: 'outline.revision.cancel', at: at(6), expectedRevision: 6,
      revisionId: 'legacy-revision', baseOutlineVersionId: legacy.outline!.version.id }));
    const saved = await runtime.execute(projectId, { kind: 'details.submit', at: at(7), expectedRevision: 7,
      specs: legacy.slideSpecs!.value.map((page) => ({ ...page, body: ['放弃结构后只改正文'] })) });
    expect(saved.pipeline.outline).toEqual(legacy.outline);
    expect(saved.pipeline.slideSpecs!.value[0]!.title).toBe('旧恢复标题');
    await runtime.restore(saved.pipeline);
  });
});

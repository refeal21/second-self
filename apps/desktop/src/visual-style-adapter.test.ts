import { describe, expect, it, vi } from 'vitest';
import { createTauriDesktopAdapter, type NativeAppServerTransport } from './desktop-adapter.js';
import { createNativePipeline } from '../../worker/src/native-pipeline.js';
import { buildPptPrompt } from './ppt-prompts.js';

const profile = { primaryColor: '#D2232A', backgroundColor: '#FFFFFF', textColor: '#222222',
  accentColors: ['#EEEEEE'], instructions: '商务简洁，少量品牌色装饰', template: null };
const style = { revision: 1, profile, locked: false };
const pipeline = createNativePipeline({ id: 'style-project', name: '配色测试', goal: '保留事实', createdAt: '2026-09-09T00:00:00.000Z' });
const transport: NativeAppServerTransport = { start: vi.fn(async () => {}), send: vi.fn(async () => {}),
  onLine: () => () => {}, onExit: () => () => {} };

describe('project visual style adapter', () => {
  it('includes the confirmed role palette in detail generation, but not factual analysis', () => {
    const prompt = buildPptPrompt(pipeline, 'details', style);
    expect(prompt).toContain('#D2232A');
    expect(prompt).toContain('整页');
    expect(buildPptPrompt(pipeline, 'analysis', style)).not.toContain('#D2232A');
    expect(pipeline).not.toHaveProperty('visualStyle');
  });

  it('loads durable style and records through native commands without connecting a model', async () => {
    const native = vi.fn(async (command: string) => {
      if (command === 'ppt_load_visual_style') return style;
      if (command === 'ppt_visual_records') return [];
      throw new Error(`Unexpected native command ${command}`);
    });
    const adapter = createTauriDesktopAdapter(transport, native);
    expect(await adapter.loadVisualStyle(pipeline.project.id)).toEqual(style);
    expect(await adapter.loadVisualRecords(pipeline.project.id)).toEqual([]);
    expect(native.mock.calls.map(([command]) => command)).toEqual(['ppt_load_visual_style', 'ppt_visual_records']);
    expect(transport.start).not.toHaveBeenCalled();
  });

  it('keeps a palette save busy across subscribers and compares both revisions', async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const native = vi.fn(async (command: string) => {
      if (command === 'ppt_load_pipeline') return pipeline;
      if (command === 'ppt_load_visual_style') return style;
      if (command === 'ppt_save_visual_style') { await pending; return style; }
      throw new Error(`Unexpected native command ${command}`);
    });
    const adapter = createTauriDesktopAdapter(transport, native);
    const save = adapter.saveVisualStyle(pipeline.project.id, profile, pipeline.revision, 0);
    expect(adapter.getProjectGeneration(pipeline.project.id)?.status).toBe('running');
    const states: string[] = [];
    const stop = adapter.subscribeProjectGeneration(pipeline.project.id, (value) => { if (value) states.push(value.status); });
    await vi.waitFor(() => expect(native).toHaveBeenCalledWith('ppt_save_visual_style', { input: {
      projectId: pipeline.project.id, expectedRevision: pipeline.revision, expectedStyleRevision: 0, profile,
    } }));
    finish();
    expect(await save).toEqual(style);
    expect(states).toContain('completed');
    stop();
  });

  it('does not downgrade missing native support into an unstyled generation', async () => {
    const adapter = createTauriDesktopAdapter(transport, async () => { throw new Error('unknown command'); });
    await expect(adapter.loadVisualStyle(pipeline.project.id)).rejects.toThrow('unknown command');
  });

  it('loads a Rust-compatible manual upload record with no AI prompt after reopening', async () => {
    const record = {
      id: 'upload-record', projectId: pipeline.project.id, expectedRevision: 0, styleRevision: 1,
      slideId: 'slide-1', kind: 'upload', prompt: '', feedback: '', promptVersion: 'upload-v1',
      createdAt: '2026-09-09T00:00:00.000Z', promptSha256: 'a'.repeat(64), specSha256: 'b'.repeat(64), style,
      receipt: { relativePath: 'visuals/slide-1-v1.png', sha256: 'c'.repeat(64), committedRevision: 1,
        createdAt: '2026-09-09T00:00:01.000Z', provider: {} },
    };
    const adapter = createTauriDesktopAdapter(transport, async (command) => {
      if (command === 'ppt_visual_records') return [record];
      if (command === 'ppt_load_visual_style') return style;
      throw new Error(`Unexpected ${command}`);
    });
    expect(await Promise.all([adapter.loadVisualStyle(pipeline.project.id), adapter.loadVisualRecords(pipeline.project.id)]))
      .toEqual([style, [record]]);
  });

  it('rejects a second palette intent while the first is saving instead of reporting false success', async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const native = vi.fn(async (command: string) => {
      if (command === 'ppt_load_pipeline') return pipeline;
      if (command === 'ppt_load_visual_style') return style;
      if (command === 'ppt_save_visual_style') { await pending; return style; }
      throw new Error(`Unexpected native command ${command}`);
    });
    const adapter = createTauriDesktopAdapter(transport, native);
    const first = adapter.saveVisualStyle(pipeline.project.id, profile, pipeline.revision, 0);
    const second = adapter.saveVisualStyle(pipeline.project.id, { ...profile, primaryColor: '#123456' }, pipeline.revision, 0);
    finish();
    await expect(second).rejects.toThrow('当前项目已有任务');
    expect(await first).toEqual(style);
    expect(native.mock.calls.filter(([command]) => command === 'ppt_save_visual_style')).toHaveLength(1);
  });

  it('rejects overlapping replacement uploads instead of treating another image as this upload', async () => {
    let fail!: (reason: Error) => void;
    const pending = new Promise<never>((_resolve, reject) => { fail = reject; });
    const adapter = createTauriDesktopAdapter(transport, async () => pending);
    const first = adapter.replaceVisual(pipeline.project.id, 'slide-1', 'first', 'first');
    const firstRejected = expect(first).rejects.toThrow('controlled load failure');
    const second = adapter.replaceVisual(pipeline.project.id, 'slide-1', 'second', 'second');
    // Settle the controlled native load so the test never leaves work running.
    fail(new Error('controlled load failure'));
    await expect(second).rejects.toThrow('当前项目已有任务');
    await firstRejected;
  });
});

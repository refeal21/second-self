import { describe, expect, it } from 'vitest';
import { detailTestHarness } from './native-detail-test-support.js';

describe('native edit persistence boundary', () => {
  it('keeps an uncertain commit gated and retries its exact original identity after remount', async () => {
    const h = await detailTestHarness(); const before = h.getStored();
    h.controls.loseResponse = true; h.controls.failReconcile = true;
    await expect(h.adapter.saveDetails(h.id, before.slideSpecs!.value, before.revision)).rejects.toThrow(/尚未核实/);
    await expect(h.adapter.generateDetails(h.id)).rejects.toThrow(/编辑/);
    await expect(h.adapter.approveDetails(h.id, before.revision)).rejects.toThrow(/尚未核实/);
    expect(h.adapter.getProjectEdit(h.id)?.kind).toBe('details.save');
    await expect(h.adapter.retryProjectEdit(h.id)).rejects.toThrow(/尚未核实/);
    h.controls.failLoad = false;
    const next = await h.adapter.retryProjectEdit(h.id);
    expect(next.revision).toBe(6); expect(h.commits).toEqual([5]);
    expect(h.adapter.getProjectEdit(h.id)?.status).toBe('completed');
  });
  it('refuses an edit while the same project generation gate is held', async () => {
    const h = await detailTestHarness(); const before = h.getStored();
    const generation = expect(h.adapter.generateDetails(h.id)).rejects.toThrow(/已有逐页细化/);
    await expect(h.adapter.saveDetails(h.id, before.slideSpecs!.value, before.revision)).rejects.toThrow(/暂不可/);
    await generation; expect(h.actions).toEqual([]); expect(h.commits).toEqual([]);
  });
  it('uses the editor baseline and refuses stale edits before Worker or native writes', async () => {
    const h = await detailTestHarness(); const before = h.getStored();
    const specs = structuredClone(before.slideSpecs!.value); specs[0]!.body = ['用户正文'];
    const saved = await h.adapter.saveDetails(h.id, specs, before.revision);
    expect(saved.slideSpecs!.value[0]!.body).toEqual(['用户正文']);
    expect(saved.approvals).toEqual(before.approvals);
    await expect(h.adapter.saveDetails(h.id, before.slideSpecs!.value, before.revision)).rejects.toThrow(/冲突/);
    expect(h.commits).toEqual([5]); expect(h.actions).toHaveLength(1);
  });
  it('reconciles a lost native response without submitting twice', async () => {
    const h = await detailTestHarness(); const before = h.getStored(); h.controls.loseResponse = true;
    const saved = await h.adapter.saveDetails(h.id, before.slideSpecs!.value, before.revision);
    expect(saved.revision).toBe(6); expect(h.commits).toEqual([5]);
    expect(h.adapter.getProjectEdit(h.id)).toMatchObject({ status: 'completed', pipeline: { revision: 6 } });
  });
  it('holds the edit gate through persistence and recovers running and completed state for subscribers', async () => {
    const h = await detailTestHarness(); const before = h.getStored();
    let finish!: () => void; h.controls.holdCommit = new Promise<void>((resolve) => { finish = resolve; });
    const saving = h.adapter.saveDetails(h.id, before.slideSpecs!.value, before.revision);
    expect(h.adapter.getProjectEdit(h.id)?.status).toBe('running');
    await expect(h.adapter.generateDetails(h.id)).rejects.toThrow(/编辑/);
    finish(); await saving;
    let revision = 0; const stop = h.adapter.subscribeProjectEdit(h.id, (edit) => { revision = edit?.pipeline?.revision ?? 0; });
    expect(revision).toBe(6); stop();
  });
});

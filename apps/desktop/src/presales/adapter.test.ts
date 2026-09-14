import { describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { createPresalesAdapter } from './adapter.js';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

describe('typed native v3 bridge', () => {
  it('uses a scoped verified image read with top-level camelCase identity', async () => {
    await createPresalesAdapter().readImage({ projectId: 'copy', slideId: 'page', versionId: 'v2', assetId: 'asset', sha256: 'hash' });
    expect(invoke).toHaveBeenLastCalledWith('presales_v3_read_image', { projectId: 'copy', slideId: 'page', versionId: 'v2', assetId: 'asset', sha256: 'hash' });
  });
  it('passes exact revision and dual human checks only through the typed approval command', async () => {
    const input = { projectId: 'copy', slideId: 'page', versionId: 'v2', imageSha256: 'hash', basis: { hashAlgorithm: 'h', spec: { version: 's', sha256: 's' }, design: { version: 'd', sha256: 'd' }, skill: { version: 'k', sha256: 'k' }, palette: { version: 'p', sha256: 'p' } }, expectedRevision: 9, contentChecked: true as const, visualChecked: true as const };
    await createPresalesAdapter().approveVersion(input);
    expect(invoke).toHaveBeenLastCalledWith('presales_v3_approve_version', { input });
  });
  it('keeps prepare, publish and discard distinct from legacy checkpoint writes', async () => {
    const api = createPresalesAdapter();
    await api.prepareCopy('legacy', 'format_copy'); await api.publishCopy('preparation'); await api.discardCopy('preparation');
    expect(vi.mocked(invoke).mock.calls.slice(-3)).toEqual([
      ['presales_v3_prepare_copy', { input: { sourceProjectId: 'legacy', mode: 'format_copy' } }],
      ['presales_v3_publish_copy', { preparationId: 'preparation' }],
      ['presales_v3_discard_copy', { preparationId: 'preparation' }],
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import config from '../vite.config.js';

describe('development server boundary', () => {
  it('binds Vite development and visual-QA traffic to loopback only', () => {
    expect(config.server).toMatchObject({ host: '127.0.0.1', port: 1420, strictPort: true });
  });

  it('uses embedded frontend assets for packaged runtime instead of a server', () => {
    const tauriConfig = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));

    expect(tauriConfig.build.frontendDist).toBe('../dist');
    expect(tauriConfig.build.beforeBuildCommand).toBe(
      'pnpm build:tauri-assets',
    );
    expect(tauriConfig.bundle.resources).toEqual({
      '../../../THIRD_PARTY_NOTICES.md': 'THIRD_PARTY_NOTICES.md',
      'resources/node-runtime': 'licenses/node-runtime',
    });
  });

  it('uses the same loopback address for Tauri development', () => {
    const tauriConfig = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));

    expect(tauriConfig.build.devUrl).toBe('http://127.0.0.1:1420');
    expect(tauriConfig.build.beforeDevCommand).toBe('pnpm dev');
  });

  it('grants only listen/unlisten access for typed local-process events', () => {
    const capability = JSON.parse(
      readFileSync(
        new URL('../src-tauri/capabilities/main.json', import.meta.url),
        'utf8',
      ),
    ) as { windows: string[]; permissions: string[] };

    expect(capability.windows).toEqual(['main']);
    expect(capability.permissions).toEqual([
      'core:event:allow-listen',
      'core:event:allow-unlisten',
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import config from '../vite.config.js';

describe('development server boundary', () => {
  it('binds Vite development and visual-QA traffic to loopback only', () => {
    expect(config.server).toMatchObject({ host: '127.0.0.1', port: 1420, strictPort: true });
  });

  it('uses embedded frontend assets for packaged runtime instead of a Vite or HTTP listener', () => {
    const tauriConfig = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));

    expect(tauriConfig.build.frontendDist).toBe('../dist');
    expect(tauriConfig.build.beforeBuildCommand).toBe(
      'pnpm build:tauri-assets',
    );
    expect(tauriConfig.build).not.toHaveProperty('server');
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

  it('grants typed local-process events plus the narrowly scoped system-browser login flow', () => {
    const capability = JSON.parse(
      readFileSync(
        new URL('../src-tauri/capabilities/main.json', import.meta.url),
        'utf8',
      ),
    ) as {
      windows: string[];
      permissions: Array<
        | string
        | { identifier: string; allow?: Array<{ url?: string; app?: unknown }> }
      >;
    };

    expect(capability.windows).toEqual(['main']);
    expect(capability.permissions.filter((permission): permission is string => (
      typeof permission === 'string'
    ))).toEqual([
      'core:event:allow-listen',
      'core:event:allow-unlisten',
    ]);
    const opener = capability.permissions.find((permission): permission is {
      identifier: string;
      allow?: Array<{ url?: string; app?: unknown }>;
    } => typeof permission !== 'string' && permission.identifier === 'opener:allow-open-url');

    expect(opener).toEqual({
      identifier: 'opener:allow-open-url',
      allow: [
        { url: 'https://auth.openai.com/*' },
        { url: 'https://chatgpt.com/*' },
        { url: 'https://chat.openai.com/*' },
      ],
    });
    expect(opener?.allow?.every(({ app }) => app === undefined)).toBe(true);

    const identifiers = capability.permissions.map((permission) => (
      typeof permission === 'string' ? permission : permission.identifier
    ));
    expect(identifiers).not.toContain('opener:default');
    expect(identifiers).not.toContain('opener:allow-open-path');
    expect(identifiers).not.toContain('opener:allow-reveal-item-in-dir');
    expect(identifiers.some((identifier) => identifier.startsWith('shell:'))).toBe(false);
    expect(identifiers.some((identifier) => identifier.startsWith('fs:'))).toBe(false);
    expect(opener?.allow?.some(({ url }) => url?.startsWith('http://'))).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import {
  TauriCodexTransport,
  type TauriBridge,
} from './codex-transport.js';

class FakeTauriBridge implements TauriBridge {
  readonly commands: Array<{ command: string; args?: Record<string, unknown> }> = [];
  private readonly listeners = new Map<string, Set<(event: { payload: unknown }) => void>>();
  private generation = 0;

  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    this.commands.push({ command, args });
    if (command === 'start_codex_app_server') {
      this.generation += 1;
      return { binaryPath: '/custom/codex', generation: this.generation } as T;
    }
    return undefined as T;
  }

  async listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void> {
    const listeners = this.listeners.get(event) ?? new Set();
    const listener = handler as (event: { payload: unknown }) => void;
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return () => listeners.delete(listener);
  }

  emit(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener({ payload });
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

describe('typed Tauri Codex transport', () => {
  it('maps process commands and typed events without an HTTP boundary', async () => {
    const bridge = new FakeTauriBridge();
    const transport = new TauriCodexTransport('/custom/codex', bridge);
    const lines: string[] = [];
    const exits: Array<{ code: number | null; signal: string | null }> = [];
    transport.onLine((line) => lines.push(line));
    transport.onExit((exit) => exits.push(exit));

    await transport.start();
    await transport.send('{"method":"initialized"}');
    bridge.emit('codex-app-server://stdout', {
      generation: 1,
      line: '{"method":"turn/completed"}',
    });
    bridge.emit('codex-app-server://exit', { generation: 1, code: 70, signal: null });

    expect(bridge.commands).toEqual([
      {
        command: 'start_codex_app_server',
        args: { configuredPath: '/custom/codex' },
      },
      {
        command: 'send_codex_app_server_line',
        args: { generation: 1, line: '{"method":"initialized"}' },
      },
    ]);
    expect(lines).toEqual(['{"method":"turn/completed"}']);
    expect(exits).toEqual([{ code: 70, signal: null }]);
  });

  it('unlistens process events on stop and rebinds once on restart', async () => {
    const bridge = new FakeTauriBridge();
    const transport = new TauriCodexTransport(null, bridge);
    const lines: string[] = [];
    transport.onLine((line) => lines.push(line));
    await transport.start();

    await transport.stop();

    expect(bridge.listenerCount('codex-app-server://stdout')).toBe(0);
    expect(bridge.listenerCount('codex-app-server://exit')).toBe(0);
    bridge.emit('codex-app-server://stdout', { generation: 1, line: 'stale' });

    await transport.start();
    bridge.emit('codex-app-server://stdout', { generation: 2, line: 'current' });
    expect(lines).toEqual(['current']);
    expect(bridge.listenerCount('codex-app-server://stdout')).toBe(1);
  });

  it('ignores stdout and exit events from a superseded process generation', async () => {
    const bridge = new FakeTauriBridge();
    const transport = new TauriCodexTransport(null, bridge);
    const lines: string[] = [];
    const exits: Array<{ code: number | null; signal: string | null }> = [];
    transport.onLine((line) => lines.push(line));
    transport.onExit((exit) => exits.push(exit));
    await transport.start();
    await transport.start();

    bridge.emit('codex-app-server://stdout', { generation: 1, line: 'stale' });
    bridge.emit('codex-app-server://exit', { generation: 1, code: 70, signal: null });
    bridge.emit('codex-app-server://stdout', { generation: 2, line: 'current' });
    bridge.emit('codex-app-server://exit', { generation: 2, code: 0, signal: null });

    expect(lines).toEqual(['current']);
    expect(exits).toEqual([{ code: 0, signal: null }]);
  });
});

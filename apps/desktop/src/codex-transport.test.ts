import { describe, expect, it } from 'vitest';
import {
  TauriCodexTransport,
  type TauriBridge,
} from './codex-transport.js';

class FakeTauriBridge implements TauriBridge {
  readonly commands: Array<{ command: string; args?: Record<string, unknown> }> = [];
  private readonly listeners = new Map<string, (event: { payload: unknown }) => void>();

  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    this.commands.push({ command, args });
    return { binaryPath: '/custom/codex' } as T;
  }

  async listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void> {
    this.listeners.set(event, handler as (event: { payload: unknown }) => void);
    return () => this.listeners.delete(event);
  }

  emit(event: string, payload: unknown): void {
    this.listeners.get(event)?.({ payload });
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
    bridge.emit('codex-app-server://stdout', { line: '{"method":"turn/completed"}' });
    bridge.emit('codex-app-server://exit', { code: 70, signal: null });

    expect(bridge.commands).toEqual([
      {
        command: 'start_codex_app_server',
        args: { configuredPath: '/custom/codex' },
      },
      {
        command: 'send_codex_app_server_line',
        args: { line: '{"method":"initialized"}' },
      },
    ]);
    expect(lines).toEqual(['{"method":"turn/completed"}']);
    expect(exits).toEqual([{ code: 70, signal: null }]);
  });
});

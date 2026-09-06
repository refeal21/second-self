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

class DeferredStartBridge implements TauriBridge {
  readonly commands: Array<{ command: string; args?: Record<string, unknown> }> = [];
  readonly startObserved: Promise<void>;
  private readonly listeners = new Map<string, Set<(event: { payload: unknown }) => void>>();
  private resolveStartObserved!: () => void;
  private resolveStartResponse: ((result: { binaryPath: string; generation: number }) => void) | undefined;

  constructor() {
    this.startObserved = new Promise((resolve) => { this.resolveStartObserved = resolve; });
  }

  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    this.commands.push({ command, args });
    if (command === 'start_codex_app_server') {
      this.resolveStartObserved();
      return new Promise((resolve) => {
        this.resolveStartResponse = resolve as (result: { binaryPath: string; generation: number }) => void;
      });
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

  resolveStart(generation: number): void {
    this.resolveStartResponse?.({ binaryPath: '/custom/codex', generation });
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

class DeferredStopBridge extends FakeTauriBridge {
  readonly stopObserved: Promise<void>;
  private markStopObserved!: () => void;
  private completeStop!: () => void;

  constructor() {
    super();
    this.stopObserved = new Promise((resolve) => { this.markStopObserved = resolve; });
  }

  override async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    const result = await super.invoke<T>(command, args);
    if (command === 'stop_codex_app_server') {
      this.markStopObserved();
      await new Promise<void>((resolve) => { this.completeStop = resolve; });
    }
    return result;
  }

  finishStop(): void { this.completeStop(); }
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

  it('rejects writes and ignores late notifications from an exited process until restart', async () => {
    const bridge = new FakeTauriBridge();
    const transport = new TauriCodexTransport(null, bridge);
    const lines: string[] = [];
    transport.onLine((line) => lines.push(line));
    await transport.start();
    bridge.emit('codex-app-server://exit', { generation: 1, code: 70, signal: null });
    bridge.emit('codex-app-server://stdout', { generation: 1, line: '{"method":"account/updated"}' });

    expect(lines).toEqual([]);
    await expect(transport.send('{"method":"account/read"}')).rejects.toThrow('not running');
    await transport.start();
    bridge.emit('codex-app-server://stdout', { generation: 2, line: 'current' });
    expect(lines).toEqual(['current']);
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

  it('delivers an immediate exit emitted before the start response resolves', async () => {
    const bridge = new DeferredStartBridge();
    const transport = new TauriCodexTransport(null, bridge);
    const exits: Array<{ code: number | null; signal: string | null }> = [];
    transport.onExit((exit) => exits.push(exit));

    const starting = transport.start();
    await bridge.startObserved;
    bridge.emit('codex-app-server://exit', { generation: 4, code: 70, signal: null });
    bridge.resolveStart(4);
    await starting;

    expect(exits).toEqual([{ code: 70, signal: null }]);
  });

  it('replays immediate stdout and exit events in arrival order', async () => {
    const bridge = new DeferredStartBridge();
    const transport = new TauriCodexTransport(null, bridge);
    const events: string[] = [];
    transport.onLine((line) => events.push(`line:${line}`));
    transport.onExit((exit) => events.push(`exit:${exit.code}`));

    const starting = transport.start();
    await bridge.startObserved;
    bridge.emit('codex-app-server://stdout', { generation: 5, line: 'ready' });
    bridge.emit('codex-app-server://exit', { generation: 5, code: 70, signal: null });
    bridge.resolveStart(5);
    await starting;

    expect(events).toEqual(['line:ready', 'exit:70']);
  });

  it('discards buffered events from stale process generations', async () => {
    const bridge = new DeferredStartBridge();
    const transport = new TauriCodexTransport(null, bridge);
    const events: string[] = [];
    transport.onLine((line) => events.push(`line:${line}`));
    transport.onExit((exit) => events.push(`exit:${exit.code}`));

    const starting = transport.start();
    await bridge.startObserved;
    bridge.emit('codex-app-server://stdout', { generation: 5, line: 'stale' });
    bridge.emit('codex-app-server://exit', { generation: 5, code: 70, signal: null });
    bridge.emit('codex-app-server://stdout', { generation: 6, line: 'current' });
    bridge.emit('codex-app-server://exit', { generation: 6, code: 0, signal: null });
    bridge.resolveStart(6);
    await starting;

    expect(events).toEqual(['line:current', 'exit:0']);
  });

  it.each(['stop', 'dispose'] as const)('clears buffered startup events on %s', async (operation) => {
    const bridge = new DeferredStartBridge();
    const transport = new TauriCodexTransport(null, bridge);
    const lines: string[] = [];
    transport.onLine((line) => lines.push(line));

    const starting = transport.start();
    await bridge.startObserved;
    bridge.emit('codex-app-server://stdout', { generation: 7, line: 'must-not-replay' });
    await transport[operation]();
    bridge.resolveStart(7);
    await starting;

    expect(lines).toEqual([]);
    expect(bridge.listenerCount('codex-app-server://stdout')).toBe(0);
  });

  it('applies a saved Codex path immediately and restarts safely without an app restart', async () => {
    const bridge = new FakeTauriBridge();
    const transport = new TauriCodexTransport(null, bridge);
    await transport.start();

    await transport.setConfiguredPath('/saved/codex');
    await transport.start();

    expect(bridge.commands).toContainEqual({
      command: 'stop_codex_app_server', args: { generation: 1 },
    });
    expect(bridge.commands.filter(({ command }) => command === 'start_codex_app_server').at(-1))
      .toEqual({ command: 'start_codex_app_server', args: { configuredPath: '/saved/codex' } });
  });

  it('waits for a pending path-change stop before binding the restarted process', async () => {
    const bridge = new DeferredStopBridge();
    const transport = new TauriCodexTransport(null, bridge);
    const lines: string[] = [];
    transport.onLine((line) => lines.push(line));
    await transport.start();

    const savingPath = transport.setConfiguredPath('/other/codex');
    await bridge.stopObserved;
    const restarting = transport.start();
    await Promise.resolve();
    const startsBeforeStopCompleted = bridge.commands.filter(({ command }) => command === 'start_codex_app_server').length;
    bridge.finishStop();
    await Promise.all([savingPath, restarting]);
    bridge.emit('codex-app-server://stdout', { generation: 2, line: 'current' });

    expect(startsBeforeStopCompleted).toBe(1);
    expect(lines).toEqual(['current']);
    expect(bridge.listenerCount('codex-app-server://stdout')).toBe(1);
  });
});

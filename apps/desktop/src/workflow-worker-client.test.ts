import { describe, expect, it } from 'vitest';
import {
  TauriWorkflowWorkerClient,
  type WorkflowWorkerBridge,
} from './workflow-worker-client.js';

class FakeBridge implements WorkflowWorkerBridge {
  readonly commands: Array<{ command: string; args?: Record<string, unknown> }> = [];
  private readonly listeners = new Map<string, Set<(event: { payload: unknown }) => void>>();
  private generation = 0;

  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    this.commands.push({ command, args });
    if (command === 'start_worker_sidecar') {
      this.generation += 1;
      return { generation: this.generation, pid: 42, protocolVersion: 1 } as T;
    }
    if (command === 'send_worker_sidecar_line') {
      const request = JSON.parse(String(args?.line)) as { id: number; method: string };
      const result = request.method === 'system.health'
        ? { protocolVersion: 1, worker: 'digital-twin-workflow-worker', status: 'ready' }
        : {};
      queueMicrotask(() => this.emit('workflow-worker://stdout', {
        generation: args?.generation,
        line: `${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`,
      }));
    }
    return undefined as T;
  }

  async listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void> {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(handler as (event: { payload: unknown }) => void);
    this.listeners.set(event, listeners);
    return () => listeners.delete(handler as (event: { payload: unknown }) => void);
  }

  emit(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener({ payload });
  }
}

describe('Tauri workflow Worker client', () => {
  it('starts the embedded sidecar and completes a versioned health request over JSON-RPC', async () => {
    const bridge = new FakeBridge();
    const client = new TauriWorkflowWorkerClient(bridge);

    await expect(client.health()).resolves.toEqual({
      protocolVersion: 1,
      worker: 'digital-twin-workflow-worker',
      status: 'ready',
    });

    expect(bridge.commands.map(({ command }) => command)).toEqual([
      'start_worker_sidecar',
      'send_worker_sidecar_line',
    ]);
    expect(bridge.commands[1]?.args).toMatchObject({ generation: 1 });
    expect(String(bridge.commands[1]?.args?.line)).not.toContain('\n');
  });

  it('reassembles chunked stdout and reports JSON-RPC errors without hanging', async () => {
    class ChunkedBridge extends FakeBridge {
      override async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
        if (command !== 'send_worker_sidecar_line') return super.invoke(command, args);
        this.commands.push({ command, args });
        const request = JSON.parse(String(args?.line)) as { id: number };
        const response = JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32601, message: 'Method not found' },
        });
        queueMicrotask(() => {
          this.emit('workflow-worker://stdout', { generation: 1, line: response.slice(0, 17) });
          this.emit('workflow-worker://stdout', { generation: 1, line: `${response.slice(17)}\n` });
        });
        return undefined as T;
      }
    }

    const client = new TauriWorkflowWorkerClient(new ChunkedBridge());
    await expect(client.request('unknown.method')).rejects.toThrow('Method not found');
  });

  it('rejects an in-flight request when the owned Worker exits and restarts on the next call', async () => {
    class ExitBridge extends FakeBridge {
      shouldExit = true;
      override async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
        if (command !== 'send_worker_sidecar_line') return super.invoke(command, args);
        this.commands.push({ command, args });
        if (this.shouldExit) {
          this.shouldExit = false;
          queueMicrotask(() => this.emit('workflow-worker://exit', {
            generation: args?.generation,
            code: 86,
            signal: null,
          }));
          return undefined as T;
        }
        const request = JSON.parse(String(args?.line)) as { id: number };
        queueMicrotask(() => this.emit('workflow-worker://stdout', {
          generation: args?.generation,
          line: `${JSON.stringify({
            jsonrpc: '2.0', id: request.id,
            result: { protocolVersion: 1, worker: 'digital-twin-workflow-worker', status: 'ready' },
          })}\n`,
        }));
        return undefined as T;
      }
    }

    const bridge = new ExitBridge();
    const client = new TauriWorkflowWorkerClient(bridge);
    await expect(client.health()).rejects.toThrow('exited unexpectedly');
    await expect(client.health()).resolves.toMatchObject({ status: 'ready' });
    expect(bridge.commands.filter(({ command }) => command === 'start_worker_sidecar')).toHaveLength(2);
  });

  it('exposes typed production PPT create, restore, execute and snapshot RPC calls', async () => {
    class PipelineBridge extends FakeBridge {
      override async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
        if (command !== 'send_worker_sidecar_line') return super.invoke(command, args);
        this.commands.push({ command, args });
        const request = JSON.parse(String(args?.line)) as { id: number; method: string; params: unknown };
        queueMicrotask(() => this.emit('workflow-worker://stdout', {
          generation: args?.generation,
          line: `${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { method: request.method, params: request.params } })}\n`,
        }));
        return undefined as T;
      }
    }
    const client = new TauriWorkflowWorkerClient(new PipelineBridge());
    const pipeline = { schemaVersion: 1, revision: 1, project: { id: 'project-1' } } as never;
    await expect(client.createProject({
      id: 'project-1', name: '项目', goal: '目标', createdAt: 'now', preferenceSnapshot: [],
    })).resolves.toMatchObject({ method: 'ppt.project.create' });
    await expect(client.restoreProject(pipeline)).resolves.toMatchObject({ method: 'ppt.project.restore' });
    await expect(client.executeProject('project-1', { kind: 'outline.approve', at: 'now' })).resolves.toMatchObject({ method: 'ppt.project.execute' });
    await expect(client.snapshotProject('project-1')).resolves.toMatchObject({ method: 'ppt.project.snapshot' });
  });
});

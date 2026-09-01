import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface TauriBridge {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void>;
}

interface CodexProcessStarted {
  binaryPath: string;
  generation: number;
}

interface CodexLineEvent {
  generation: number;
  line: string;
}

interface CodexExit {
  code: number | null;
  signal: string | null;
}

interface CodexExitEvent extends CodexExit {
  generation: number;
}

const defaultBridge: TauriBridge = {
  invoke,
  listen: (event, handler) => listen(event, handler),
};

export class TauriCodexTransport {
  private readonly lineListeners = new Set<(line: string) => void>();
  private readonly exitListeners = new Set<(detail: CodexExit) => void>();
  private binding: Promise<void> | null = null;
  private unlisteners: Array<() => void> = [];
  private activeGeneration: number | null = null;

  constructor(
    private readonly configuredPath: string | null,
    private readonly bridge: TauriBridge = defaultBridge,
  ) {}

  async start(): Promise<void> {
    await this.bindEvents();
    this.activeGeneration = null;
    const started = await this.bridge.invoke<CodexProcessStarted>('start_codex_app_server', {
      configuredPath: this.configuredPath,
    });
    this.activeGeneration = started.generation;
  }

  async send(line: string): Promise<void> {
    if (this.activeGeneration === null) throw new Error('Codex App Server is not running');
    await this.bridge.invoke<void>('send_codex_app_server_line', {
      generation: this.activeGeneration,
      line,
    });
  }

  async stop(): Promise<void> {
    const generation = this.activeGeneration;
    this.activeGeneration = null;
    try {
      if (generation !== null) {
        await this.bridge.invoke<void>('stop_codex_app_server', { generation });
      }
    } finally {
      await this.unbindEvents();
    }
  }

  async dispose(): Promise<void> {
    await this.stop();
    this.lineListeners.clear();
    this.exitListeners.clear();
  }

  onLine(listener: (line: string) => void): () => void {
    this.lineListeners.add(listener);
    return () => this.lineListeners.delete(listener);
  }

  onExit(listener: (detail: CodexExit) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  private bindEvents(): Promise<void> {
    if (!this.binding) {
      this.binding = Promise.all([
        this.bridge.listen<CodexLineEvent>('codex-app-server://stdout', ({ payload }) => {
          if (payload.generation !== this.activeGeneration) return;
          for (const listener of this.lineListeners) listener(payload.line);
        }),
        this.bridge.listen<CodexExitEvent>('codex-app-server://exit', ({ payload }) => {
          if (payload.generation !== this.activeGeneration) return;
          const { code, signal } = payload;
          for (const listener of this.exitListeners) listener({ code, signal });
        }),
      ]).then((unlisteners) => {
        this.unlisteners = unlisteners;
      });
    }
    return this.binding;
  }

  private async unbindEvents(): Promise<void> {
    await this.binding;
    for (const unlisten of this.unlisteners.splice(0)) unlisten();
    this.binding = null;
  }
}

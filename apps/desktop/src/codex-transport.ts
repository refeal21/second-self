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

type CodexProcessEvent =
  | { type: 'line'; payload: CodexLineEvent }
  | { type: 'exit'; payload: CodexExitEvent };

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
  private startAttempt = 0;
  private pendingStartEvents: CodexProcessEvent[] | null = null;

  constructor(
    private configuredPath: string | null,
    private readonly bridge: TauriBridge = defaultBridge,
  ) {}

  async setConfiguredPath(path: string | null): Promise<void> {
    const normalized = path?.trim() || null;
    if (normalized === this.configuredPath) return;
    this.configuredPath = normalized;
    if (this.activeGeneration !== null || this.pendingStartEvents !== null) {
      await this.stop();
    }
  }

  async start(): Promise<void> {
    const attempt = ++this.startAttempt;
    await this.bindEvents();
    if (attempt !== this.startAttempt) return;
    this.activeGeneration = null;
    this.pendingStartEvents = [];
    let started: CodexProcessStarted;
    try {
      started = await this.bridge.invoke<CodexProcessStarted>('start_codex_app_server', {
        configuredPath: this.configuredPath,
      });
    } catch (error) {
      if (attempt === this.startAttempt) this.pendingStartEvents = null;
      throw error;
    }
    if (attempt !== this.startAttempt) {
      await this.bridge.invoke<void>('stop_codex_app_server', { generation: started.generation });
      return;
    }

    const bufferedEvents = this.pendingStartEvents ?? [];
    this.pendingStartEvents = null;
    this.activeGeneration = started.generation;
    for (const event of bufferedEvents) {
      if (event.payload.generation === started.generation) this.dispatch(event);
    }
  }

  async send(line: string): Promise<void> {
    if (this.activeGeneration === null) throw new Error('Codex App Server is not running');
    await this.bridge.invoke<void>('send_codex_app_server_line', {
      generation: this.activeGeneration,
      line,
    });
  }

  async stop(): Promise<void> {
    this.startAttempt += 1;
    const generation = this.activeGeneration;
    this.activeGeneration = null;
    this.pendingStartEvents = null;
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
          this.receive({ type: 'line', payload });
        }),
        this.bridge.listen<CodexExitEvent>('codex-app-server://exit', ({ payload }) => {
          this.receive({ type: 'exit', payload });
        }),
      ]).then((unlisteners) => {
        this.unlisteners = unlisteners;
      });
    }
    return this.binding;
  }

  private receive(event: CodexProcessEvent): void {
    if (event.payload.generation === this.activeGeneration) {
      this.dispatch(event);
    } else if (this.pendingStartEvents !== null) {
      this.pendingStartEvents.push(event);
    }
  }

  private dispatch(event: CodexProcessEvent): void {
    if (event.type === 'line') {
      for (const listener of this.lineListeners) listener(event.payload.line);
      return;
    }
    const { code, signal } = event.payload;
    for (const listener of this.exitListeners) listener({ code, signal });
  }

  private async unbindEvents(): Promise<void> {
    await this.binding;
    for (const unlisten of this.unlisteners.splice(0)) unlisten();
    this.binding = null;
  }
}

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface TauriBridge {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void>;
}

interface CodexProcessStarted {
  binaryPath: string;
}

interface CodexLineEvent {
  line: string;
}

interface CodexExitEvent {
  code: number | null;
  signal: string | null;
}

const defaultBridge: TauriBridge = {
  invoke,
  listen: (event, handler) => listen(event, handler),
};

export class TauriCodexTransport {
  private readonly lineListeners = new Set<(line: string) => void>();
  private readonly exitListeners = new Set<(detail: CodexExitEvent) => void>();
  private binding: Promise<void> | null = null;

  constructor(
    private readonly configuredPath: string | null,
    private readonly bridge: TauriBridge = defaultBridge,
  ) {}

  async start(): Promise<void> {
    await this.bindEvents();
    await this.bridge.invoke<CodexProcessStarted>('start_codex_app_server', {
      configuredPath: this.configuredPath,
    });
  }

  async send(line: string): Promise<void> {
    await this.bridge.invoke<void>('send_codex_app_server_line', { line });
  }

  async stop(): Promise<void> {
    await this.bridge.invoke<void>('stop_codex_app_server');
  }

  onLine(listener: (line: string) => void): () => void {
    this.lineListeners.add(listener);
    return () => this.lineListeners.delete(listener);
  }

  onExit(listener: (detail: CodexExitEvent) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  private bindEvents(): Promise<void> {
    if (!this.binding) {
      this.binding = Promise.all([
        this.bridge.listen<CodexLineEvent>('codex-app-server://stdout', ({ payload }) => {
          for (const listener of this.lineListeners) listener(payload.line);
        }),
        this.bridge.listen<CodexExitEvent>('codex-app-server://exit', ({ payload }) => {
          for (const listener of this.exitListeners) listener(payload);
        }),
      ]).then(() => undefined);
    }
    return this.binding;
  }
}

export type JsonRpcId = number | string;

export interface JsonRpcMessage {
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface AppServerExit {
  code: number | null;
  signal: string | null;
}

export interface AppServerTransport {
  start(): Promise<void>;
  send(line: string): Promise<void>;
  onLine(listener: (line: string) => void): () => void;
  onExit(listener: (detail: AppServerExit) => void): () => void;
}

export interface ChatGptAccount {
  type: 'chatgpt';
  email: string | null;
  planType: string;
}

interface AccountReadResponse {
  account: ChatGptAccount | { type: string } | null;
  requiresOpenaiAuth: boolean;
}

interface ChatGptLoginResponse {
  type: 'chatgpt';
  loginId: string;
  authUrl: string;
}

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

export class CodexAppServerClient {
  private nextRequestId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private connected = false;
  private transportBound = false;
  private readonly serverMessageListeners = new Set<(message: JsonRpcMessage) => void>();
  private readonly exitListeners = new Set<(detail: AppServerExit) => void>();

  constructor(private readonly transport: AppServerTransport) {}

  async connect(): Promise<void> {
    if (this.connected) return;

    if (!this.transportBound) {
      this.transport.onLine((line) => this.receiveLine(line));
      this.transport.onExit((detail) => this.receiveExit(detail));
      this.transportBound = true;
    }
    await this.transport.start();
    await this.request('initialize', {
      clientInfo: {
        name: 'digital-twin-workbench',
        title: 'Digital Twin Workbench',
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
      },
    });
    await this.notify('initialized');
    this.connected = true;
  }

  async readAccount(): Promise<ChatGptAccount | null> {
    const response = await this.request<AccountReadResponse>('account/read', {
      refreshToken: false,
    });

    return response.account?.type === 'chatgpt'
      ? response.account as ChatGptAccount
      : null;
  }

  async startChatGptLogin(): Promise<{ loginId: string; authUrl: string }> {
    const response = await this.request<ChatGptLoginResponse>('account/login/start', {
      type: 'chatgpt',
      useHostedLoginSuccessPage: true,
      appBrand: 'chatgpt',
    });

    if (response.type !== 'chatgpt') {
      throw new Error('Codex App Server returned an unsupported login flow');
    }

    return { loginId: response.loginId, authUrl: response.authUrl };
  }

  async startThread(cwd: string): Promise<string> {
    const response = await this.request<{ thread: { id: string } }>('thread/start', {
      cwd,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
    });
    return response.thread.id;
  }

  async resumeThread(threadId: string): Promise<string> {
    const response = await this.request<{ thread: { id: string } }>('thread/resume', {
      threadId,
    });
    return response.thread.id;
  }

  async startTurn(threadId: string, text: string): Promise<string> {
    const response = await this.request<{ turn: { id: string } }>('turn/start', {
      threadId,
      input: [{ type: 'text', text, text_elements: [] }],
    });
    return response.turn.id;
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.request('turn/interrupt', { threadId, turnId });
  }

  onServerMessage(listener: (message: JsonRpcMessage) => void): () => void {
    this.serverMessageListeners.add(listener);
    return () => this.serverMessageListeners.delete(listener);
  }

  onExit(listener: (detail: AppServerExit) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  async respond(id: JsonRpcId, result: unknown): Promise<void> {
    await this.transport.send(JSON.stringify({ id, result }));
  }

  async reconnect(): Promise<void> {
    this.connected = false;
    this.rejectPending('Codex App Server connection was restarted');
    await this.connect();
  }

  private async request<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextRequestId++;
    const response = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
    });

    try {
      await this.transport.send(JSON.stringify({ id, method, params }));
    } catch (error) {
      this.pending.delete(id);
      throw error;
    }

    return response;
  }

  private notify(method: string, params?: unknown): Promise<void> {
    return this.transport.send(JSON.stringify(
      params === undefined ? { method } : { method, params },
    ));
  }

  private receiveLine(line: string): void {
    const message = JSON.parse(line) as JsonRpcMessage;
    if (message.method !== undefined) {
      for (const listener of this.serverMessageListeners) listener(message);
      return;
    }
    if (message.id === undefined) return;

    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);

    if (message.error) {
      pending.reject(new Error(message.error.message));
    } else {
      pending.resolve(message.result);
    }
  }

  private receiveExit(detail: AppServerExit): void {
    this.connected = false;
    this.rejectPending('Codex App Server exited');
    for (const listener of this.exitListeners) listener(detail);
  }

  private rejectPending(message: string): void {
    for (const pending of this.pending.values()) pending.reject(new Error(message));
    this.pending.clear();
  }
}

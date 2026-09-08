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

export type AuthState =
  | { status: 'unknown' }
  | { status: 'login_pending'; loginId: string; authUrl: string }
  | { status: 'login_succeeded'; loginId: string }
  | { status: 'authenticated'; authMode: 'chatgpt'; planType: string | null }
  | { status: 'login_failed'; loginId: string; error: string }
  | { status: 'invalidated'; reason: string }
  | { status: 'logged_out' };

interface AccountReadResponse {
  account: ChatGptAccount | { type: string } | null;
  requiresOpenaiAuth: boolean;
}

interface ChatGptLoginResponse {
  type: 'chatgpt';
  loginId: string;
  authUrl: string;
}

export interface ModelProviderCapabilities {
  namespaceTools: boolean;
  imageGeneration: boolean;
  webSearch: boolean;
}

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

export class CodexAppServerClient {
  private nextRequestId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private connected = false;
  private connectPromise: Promise<void> | null = null;
  private lifecycleVersion = 0;
  private disposed = false;
  private transportBound = false;
  private transportUnsubscribers: Array<() => void> = [];
  private readonly serverMessageListeners = new Set<(message: JsonRpcMessage) => void>();
  private readonly exitListeners = new Set<(detail: AppServerExit) => void>();
  private readonly authStateListeners = new Set<(state: AuthState) => void>();
  private authState: AuthState = { status: 'unknown' };

  constructor(private readonly transport: AppServerTransport) {}

  async connect(): Promise<void> {
    if (this.disposed) throw new Error('Codex App Server client was disposed');
    if (this.connected) return;
    if (this.connectPromise) return this.connectPromise;

    const attempt = this.performConnect(this.lifecycleVersion);
    this.connectPromise = attempt;
    try {
      await attempt;
    } finally {
      if (this.connectPromise === attempt) this.connectPromise = null;
    }
  }

  private async performConnect(lifecycleVersion: number): Promise<void> {

    if (!this.transportBound) {
      this.transportUnsubscribers = [
        this.transport.onLine((line) => this.receiveLine(line)),
        this.transport.onExit((detail) => this.receiveExit(detail)),
      ];
      this.transportBound = true;
    }
    await this.transport.start();
    this.assertActiveLifecycle(lifecycleVersion);
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
    this.assertActiveLifecycle(lifecycleVersion);
    await this.notify('initialized');
    this.assertActiveLifecycle(lifecycleVersion);
    this.connected = true;
  }

  async readAccount(): Promise<ChatGptAccount | null> {
    const response = await this.request<AccountReadResponse>('account/read', {
      refreshToken: false,
    });

    if (response.account?.type === 'chatgpt') {
      const account = response.account as ChatGptAccount;
      this.setAuthState({
        status: 'authenticated',
        authMode: 'chatgpt',
        planType: account.planType,
      });
      return account;
    }

    this.setAuthState(response.account === null
      ? { status: 'logged_out' }
      : { status: 'invalidated', reason: `Unsupported Codex account type: ${response.account.type}` });
    return null;
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

    const login = { loginId: response.loginId, authUrl: response.authUrl };
    this.setAuthState({ status: 'login_pending', ...login });
    return login;
  }

  async startThread(cwd: string): Promise<string> {
    const response = await this.request<{ thread: { id: string } }>('thread/start', {
      cwd,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
    });
    return response.thread.id;
  }

  async readModelProviderCapabilities(): Promise<unknown> {
    return this.request('modelProvider/capabilities/read', {});
  }

  async startImageThread(cwd: string): Promise<string> {
    const response = await this.request<{ thread: { id: string } }>('thread/start', {
      cwd,
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: 'read-only',
      ephemeral: true,
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

  onAuthState(listener: (state: AuthState) => void): () => void {
    this.authStateListeners.add(listener);
    return () => this.authStateListeners.delete(listener);
  }

  getAuthState(): AuthState {
    return { ...this.authState };
  }

  async respond(id: JsonRpcId, result: unknown): Promise<void> {
    await this.transport.send(JSON.stringify({ id, result }));
  }

  async reconnect(): Promise<void> {
    this.connected = false;
    this.rejectPending('Codex App Server connection was restarted');
    await this.connect();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifecycleVersion += 1;
    for (const unsubscribe of this.transportUnsubscribers.splice(0)) unsubscribe();
    this.transportBound = false;
    this.connected = false;
    this.connectPromise = null;
    this.rejectPending('Codex App Server client was disposed');
    this.serverMessageListeners.clear();
    this.exitListeners.clear();
    this.authStateListeners.clear();
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
      this.receiveAuthNotification(message);
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
    this.lifecycleVersion += 1;
    this.connected = false;
    this.rejectPending('Codex App Server exited');
    for (const listener of this.exitListeners) listener(detail);
  }

  private rejectPending(message: string): void {
    for (const pending of this.pending.values()) pending.reject(new Error(message));
    this.pending.clear();
  }

  private receiveAuthNotification(message: JsonRpcMessage): void {
    const params = asRecord(message.params);
    if (!params) return;

    if (message.method === 'account/login/completed') {
      if (this.authState.status !== 'login_pending') return;
      const loginId = typeof params.loginId === 'string' ? params.loginId : null;
      if (loginId !== null && loginId !== this.authState.loginId) return;

      this.setAuthState(params.success === true
        ? { status: 'login_succeeded', loginId: this.authState.loginId }
        : {
            status: 'login_failed',
            loginId: this.authState.loginId,
            error: typeof params.error === 'string' ? params.error : 'ChatGPT login failed',
          });
      return;
    }

    if (message.method === 'account/updated') {
      const authMode = typeof params.authMode === 'string' ? params.authMode : null;
      if (authMode === null) {
        this.setAuthState({ status: 'logged_out' });
      } else if (authMode === 'chatgpt') {
        this.setAuthState({
          status: 'authenticated',
          authMode,
          planType: typeof params.planType === 'string' ? params.planType : null,
        });
      } else {
        this.setAuthState({
          status: 'invalidated',
          reason: `Unsupported Codex authentication mode: ${authMode}`,
        });
      }
    }
  }

  private setAuthState(state: AuthState): void {
    this.authState = state;
    for (const listener of this.authStateListeners) listener(this.getAuthState());
  }

  private assertActiveLifecycle(lifecycleVersion: number): void {
    if (this.disposed || lifecycleVersion !== this.lifecycleVersion) {
      throw new Error(this.disposed
        ? 'Codex App Server client was disposed'
        : 'Codex App Server connection was superseded');
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : null;
}

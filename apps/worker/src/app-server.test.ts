import { describe, expect, it } from 'vitest';
import {
  CodexAppServerClient,
  type AppServerTransport,
  type JsonRpcMessage,
} from './app-server.js';

class FakeAppServerTransport implements AppServerTransport {
  readonly sent: JsonRpcMessage[] = [];
  starts = 0;
  private readonly lineListeners = new Set<(line: string) => void>();
  private readonly exitListeners = new Set<(detail: { code: number | null; signal: string | null }) => void>();

  constructor(
    private readonly respond: (message: JsonRpcMessage) => unknown = () => ({}),
  ) {}

  async start(): Promise<void> {
    this.starts += 1;
  }

  async send(line: string): Promise<void> {
    const message = JSON.parse(line) as JsonRpcMessage;
    this.sent.push(message);
    if ('id' in message && message.id !== undefined) {
      const result = this.respond(message);
      queueMicrotask(() => {
        for (const listener of this.lineListeners) {
          listener(JSON.stringify({ id: message.id, result }));
        }
      });
    }
  }

  onLine(listener: (line: string) => void): () => void {
    this.lineListeners.add(listener);
    return () => { this.lineListeners.delete(listener); };
  }

  onExit(listener: (detail: { code: number | null; signal: string | null }) => void): () => void {
    this.exitListeners.add(listener);
    return () => { this.exitListeners.delete(listener); };
  }

  emit(message: JsonRpcMessage): void {
    for (const listener of this.lineListeners) listener(JSON.stringify(message));
  }

  get subscriptionCount(): number {
    return this.lineListeners.size + this.exitListeners.size;
  }
}

const initializeResponse = {
  userAgent: 'codex/0.151.0-alpha.7.2',
  codexHome: '/tmp/codex-home',
  platformFamily: 'unix',
  platformOs: 'macos',
};

class DeferredStartTransport implements AppServerTransport {
  readonly sent: JsonRpcMessage[] = [];
  private readonly lineListeners = new Set<(line: string) => void>();
  private readonly exitListeners = new Set<(detail: { code: number | null; signal: string | null }) => void>();
  private releaseStart: (() => void) | undefined;

  start(): Promise<void> {
    return new Promise((resolve) => { this.releaseStart = resolve; });
  }

  async send(line: string): Promise<void> {
    this.sent.push(JSON.parse(line) as JsonRpcMessage);
    if (this.lineListeners.size === 0) throw new Error('Transport has no line subscriber');
  }

  onLine(listener: (line: string) => void): () => void {
    this.lineListeners.add(listener);
    return () => { this.lineListeners.delete(listener); };
  }

  onExit(listener: (detail: { code: number | null; signal: string | null }) => void): () => void {
    this.exitListeners.add(listener);
    return () => { this.exitListeners.delete(listener); };
  }

  release(): void {
    this.releaseStart?.();
  }

  get subscriptionCount(): number {
    return this.lineListeners.size + this.exitListeners.size;
  }
}

describe('Codex App Server connection', () => {
  it('shares one handshake across concurrent connect callers', async () => {
    const transport = new FakeAppServerTransport(() => initializeResponse);
    const client = new CodexAppServerClient(transport);

    await Promise.all([client.connect(), client.connect(), client.connect()]);

    expect(transport.starts).toBe(1);
    expect(transport.sent.filter((message) => message.method === 'initialize')).toHaveLength(1);
    expect(transport.sent.filter((message) => message.method === 'initialized')).toHaveLength(1);
  });

  it('does not continue a pending handshake after disposal', async () => {
    const transport = new DeferredStartTransport();
    const client = new CodexAppServerClient(transport);
    const connecting = client.connect();
    await Promise.resolve();

    client.dispose();
    transport.release();

    await expect(connecting).rejects.toThrow('Codex App Server client was disposed');
    expect(transport.sent).toHaveLength(0);
    expect(transport.subscriptionCount).toBe(0);
  });

  it('initializes over JSONL before sending the initialized notification', async () => {
    const transport = new FakeAppServerTransport(() => initializeResponse);
    const client = new CodexAppServerClient(transport);

    await client.connect();

    expect(transport.sent).toEqual([
      {
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: {
            name: 'digital-twin-workbench',
            title: 'Digital Twin Workbench',
            version: '0.1.0',
          },
          capabilities: {
            experimentalApi: false,
            requestAttestation: false,
          },
        },
      },
      { method: 'initialized' },
    ]);
  });

  it('reads the current account without requesting token refresh', async () => {
    const transport = new FakeAppServerTransport((message) => (
      message.method === 'account/read'
        ? {
            account: { type: 'chatgpt', email: 'person@example.com', planType: 'plus' },
            requiresOpenaiAuth: true,
          }
        : {}
    ));
    const client = new CodexAppServerClient(transport);
    await client.connect();

    const account = await client.readAccount();

    expect(account).toEqual({ type: 'chatgpt', email: 'person@example.com', planType: 'plus' });
    expect(transport.sent.at(-1)).toEqual({
      id: 2,
      method: 'account/read',
      params: { refreshToken: false },
    });
  });

  it('starts only the hosted ChatGPT browser login flow', async () => {
    const transport = new FakeAppServerTransport((message) => (
      message.method === 'account/login/start'
        ? { type: 'chatgpt', loginId: 'login-1', authUrl: 'https://auth.example/login-1' }
        : {}
    ));
    const client = new CodexAppServerClient(transport);
    await client.connect();

    const login = await client.startChatGptLogin();

    expect(login).toEqual({ loginId: 'login-1', authUrl: 'https://auth.example/login-1' });
    expect(transport.sent.at(-1)).toEqual({
      id: 2,
      method: 'account/login/start',
      params: {
        type: 'chatgpt',
        useHostedLoginSuccessPage: true,
        appBrand: 'chatgpt',
      },
    });
    expect(client.getAuthState()).toEqual({
      status: 'login_pending',
      loginId: 'login-1',
      authUrl: 'https://auth.example/login-1',
    });
  });

  it('tracks successful login completion and the authenticated account update', async () => {
    const transport = new FakeAppServerTransport((message) => (
      message.method === 'account/login/start'
        ? { type: 'chatgpt', loginId: 'login-1', authUrl: 'https://auth.example/login-1' }
        : initializeResponse
    ));
    const client = new CodexAppServerClient(transport);
    await client.connect();
    await client.startChatGptLogin();

    transport.emit({
      method: 'account/login/completed',
      params: {
        loginId: 'login-1',
        success: true,
        error: null,
        onboardingEntrypoint: null,
      },
    });
    expect(client.getAuthState()).toEqual({ status: 'login_succeeded', loginId: 'login-1' });

    transport.emit({
      method: 'account/updated',
      params: { authMode: 'chatgpt', planType: 'plus' },
    });
    expect(client.getAuthState()).toEqual({
      status: 'authenticated',
      authMode: 'chatgpt',
      planType: 'plus',
    });
  });

  it('surfaces a failed browser login without retaining credentials', async () => {
    const transport = new FakeAppServerTransport((message) => (
      message.method === 'account/login/start'
        ? { type: 'chatgpt', loginId: 'login-1', authUrl: 'https://auth.example/login-1' }
        : initializeResponse
    ));
    const client = new CodexAppServerClient(transport);
    await client.connect();
    await client.startChatGptLogin();

    transport.emit({
      method: 'account/login/completed',
      params: {
        loginId: 'login-1',
        success: false,
        error: 'Browser login was denied',
        onboardingEntrypoint: null,
      },
    });

    expect(client.getAuthState()).toEqual({
      status: 'login_failed',
      loginId: 'login-1',
      error: 'Browser login was denied',
    });
  });

  it('invalidates unsupported authentication modes and handles logout', async () => {
    const transport = new FakeAppServerTransport(() => initializeResponse);
    const client = new CodexAppServerClient(transport);
    await client.connect();

    transport.emit({
      method: 'account/updated',
      params: { authMode: 'apikey', planType: null },
    });
    expect(client.getAuthState()).toEqual({
      status: 'invalidated',
      reason: 'Unsupported Codex authentication mode: apikey',
    });

    transport.emit({
      method: 'account/updated',
      params: { authMode: null, planType: null },
    });
    expect(client.getAuthState()).toEqual({ status: 'logged_out' });
  });

  it('ignores a stale login completion after a newer login invalidates it', async () => {
    let loginNumber = 0;
    const transport = new FakeAppServerTransport((message) => {
      if (message.method !== 'account/login/start') return initializeResponse;
      loginNumber += 1;
      return {
        type: 'chatgpt',
        loginId: `login-${loginNumber}`,
        authUrl: `https://auth.example/login-${loginNumber}`,
      };
    });
    const client = new CodexAppServerClient(transport);
    await client.connect();
    await client.startChatGptLogin();
    await client.startChatGptLogin();

    transport.emit({
      method: 'account/login/completed',
      params: {
        loginId: 'login-1',
        success: false,
        error: 'Old login expired',
        onboardingEntrypoint: null,
      },
    });

    expect(client.getAuthState()).toEqual({
      status: 'login_pending',
      loginId: 'login-2',
      authUrl: 'https://auth.example/login-2',
    });
  });
});

describe('Codex App Server task protocol', () => {
  it('starts and resumes durable threads using the stable methods', async () => {
    const transport = new FakeAppServerTransport((message) => {
      if (message.method === 'thread/start' || message.method === 'thread/resume') {
        return { thread: { id: 'thread-1' } };
      }
      return initializeResponse;
    });
    const client = new CodexAppServerClient(transport);
    await client.connect();

    expect(await client.startThread('/workspace')).toBe('thread-1');
    expect(transport.sent.at(-1)).toEqual({
      id: 2,
      method: 'thread/start',
      params: {
        cwd: '/workspace',
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
      },
    });

    expect(await client.resumeThread('thread-1')).toBe('thread-1');
    expect(transport.sent.at(-1)).toEqual({
      id: 3,
      method: 'thread/resume',
      params: { threadId: 'thread-1' },
    });
  });

  it('starts and interrupts a text turn', async () => {
    const transport = new FakeAppServerTransport((message) => (
      message.method === 'turn/start'
        ? { turn: { id: 'turn-1' } }
        : initializeResponse
    ));
    const client = new CodexAppServerClient(transport);
    await client.connect();

    expect(await client.startTurn('thread-1', 'Draft an outline.')).toBe('turn-1');
    expect(transport.sent.at(-1)).toEqual({
      id: 2,
      method: 'turn/start',
      params: {
        threadId: 'thread-1',
        input: [{ type: 'text', text: 'Draft an outline.', text_elements: [] }],
      },
    });

    await client.interruptTurn('thread-1', 'turn-1');
    expect(transport.sent.at(-1)).toEqual({
      id: 3,
      method: 'turn/interrupt',
      params: { threadId: 'thread-1', turnId: 'turn-1' },
    });
  });

  it('parses streamed assistant deltas and terminal turn notifications', async () => {
    const transport = new FakeAppServerTransport(() => initializeResponse);
    const client = new CodexAppServerClient(transport);
    const received: JsonRpcMessage[] = [];
    client.onServerMessage((message) => received.push(message));
    await client.connect();

    transport.emit({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: 'Hello' },
    });
    transport.emit({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'completed', error: null },
      },
    });

    expect(received).toEqual([
      {
        method: 'item/agentMessage/delta',
        params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: 'Hello' },
      },
      {
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { id: 'turn-1', status: 'completed', error: null },
        },
      },
    ]);
  });

  it('disposes transport and public event subscriptions', async () => {
    const transport = new FakeAppServerTransport(() => initializeResponse);
    const client = new CodexAppServerClient(transport);
    let received = 0;
    client.onServerMessage(() => { received += 1; });
    client.onExit(() => { received += 1; });
    client.onAuthState(() => { received += 1; });
    await client.connect();

    client.dispose();
    transport.emit({ method: 'account/updated', params: { authMode: null, planType: null } });

    expect(transport.subscriptionCount).toBe(0);
    expect(received).toBe(0);
  });
});

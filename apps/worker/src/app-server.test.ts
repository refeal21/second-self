import { describe, expect, it } from 'vitest';
import {
  CodexAppServerClient,
  type AppServerTransport,
  type JsonRpcMessage,
} from './app-server.js';

class FakeAppServerTransport implements AppServerTransport {
  readonly sent: JsonRpcMessage[] = [];
  private lineListener: ((line: string) => void) | undefined;
  private exitListener: ((detail: { code: number | null; signal: string | null }) => void) | undefined;

  constructor(
    private readonly respond: (message: JsonRpcMessage) => unknown = () => ({}),
  ) {}

  async start(): Promise<void> {}

  async send(line: string): Promise<void> {
    const message = JSON.parse(line) as JsonRpcMessage;
    this.sent.push(message);
    if ('id' in message && message.id !== undefined) {
      const result = this.respond(message);
      queueMicrotask(() => this.lineListener?.(JSON.stringify({ id: message.id, result })));
    }
  }

  onLine(listener: (line: string) => void): () => void {
    this.lineListener = listener;
    return () => { this.lineListener = undefined; };
  }

  onExit(listener: (detail: { code: number | null; signal: string | null }) => void): () => void {
    this.exitListener = listener;
    return () => { this.exitListener = undefined; };
  }

  emit(message: JsonRpcMessage): void {
    this.lineListener?.(JSON.stringify(message));
  }
}

const initializeResponse = {
  userAgent: 'codex/0.151.0-alpha.7.2',
  codexHome: '/tmp/codex-home',
  platformFamily: 'unix',
  platformOs: 'macos',
};

describe('Codex App Server connection', () => {
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
});

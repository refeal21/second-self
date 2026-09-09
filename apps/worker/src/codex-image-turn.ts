import {
  CodexAppServerClient,
  type JsonRpcMessage,
} from './app-server.js';

export interface CodexImageTurnRequest {
  cwd: string;
  prompt: string;
  onProgress?: (message: string) => void;
}

export interface CodexImageTurnResult {
  imageBase64: string;
  provider?: {
    threadId?: string;
    turnId?: string;
    itemId?: string;
  };
}

export interface CodexImageTurnOptions {
  timeoutMs?: number;
  maxImageBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
const DEFAULT_MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_BUFFERED_THREAD_EVENTS = 100;

export class CodexImageTurnRunner {
  private readonly timeoutMs: number;
  private readonly maxImageBytes: number;

  constructor(
    private readonly client: CodexAppServerClient,
    options: CodexImageTurnOptions = {},
  ) {
    this.timeoutMs = positiveFinite(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.maxImageBytes = positiveFinite(options.maxImageBytes, DEFAULT_MAX_IMAGE_BYTES);
  }

  generate(request: CodexImageTurnRequest): Promise<CodexImageTurnResult> {
    let expired = false;
    let threadId: string | null = null;
    let turnId: string | null = null;
    let settleEvents: ((outcome: TurnOutcome) => void) | null = null;
    const buffered: JsonRpcMessage[] = [];
    const images: unknown[] = [];
    const report = (message: string) => progress(request, message);

    const events = new Promise<TurnOutcome>((resolve) => { settleEvents = resolve; });
    const onMessage = (message: JsonRpcMessage) => {
      const params = record(message.params);
      if (!params || typeof params.threadId !== 'string') return;
      if (threadId === null || params.threadId !== threadId) return;
      if (turnId === null) {
        if (isPendingTurnMessage(message)
          && buffered.length < MAX_BUFFERED_THREAD_EVENTS) buffered.push(message);
        return;
      }
      inspectTurnMessage(message, threadId, turnId, images, settleEvents!, report);
    };
    const onExit = () => {
      settleEvents?.({ error: new Error('Codex App Server 在原生 ImageGen 生成期间退出，项目未更改。(exited)') });
    };
    const stopMessage = this.client.onServerMessage(onMessage);
    const stopExit = this.client.onExit(onExit);

    let cleanupTimer = () => {};
    const timeout = new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => {
        expired = true;
        if (threadId && turnId) void this.client.interruptTurn(threadId, turnId).catch(() => {});
        reject(new Error('原生 ImageGen 生成超时，项目未更改。(timed out)'));
      }, this.timeoutMs);
      cleanupTimer = () => clearTimeout(timer);
    });

    const checkDeadline = () => {
      if (expired) throw new Error('原生 ImageGen 生成超时，项目未更改。(timed out)');
    };
    const operation = (async (): Promise<CodexImageTurnResult> => {
      progress(request, '正在连接本机 Codex…');
      await this.client.connect();
      checkDeadline();
      const capability = record(await this.client.readModelProviderCapabilities());
      checkDeadline();
      if (typeof capability?.namespaceTools !== 'boolean'
        || typeof capability.imageGeneration !== 'boolean'
        || typeof capability.webSearch !== 'boolean'
        || capability.imageGeneration !== true) {
        throw new Error('当前 Codex 不支持原生 ImageGen，项目未更改。(ImageGen capability unavailable or malformed)');
      }

      progress(request, '正在准备原生 ImageGen 会话…');
      threadId = await this.client.startImageThread(request.cwd);
      checkDeadline();
      const startedTurnId = await this.client.startTurn(threadId, request.prompt);
      turnId = startedTurnId;
      if (expired) {
        void this.client.interruptTurn(threadId, turnId).catch(() => {});
      }
      checkDeadline();
      report('等待 Codex 调用图片生成工具…');
      for (const message of buffered.splice(0)) {
        inspectTurnMessage(message, threadId, turnId, images, settleEvents!, report);
      }
      const outcome = await events;
      checkDeadline();
      if (outcome.error) throw outcome.error;
      if (images.length === 0) throw new Error('Codex 原生 ImageGen 未返回图片，项目未更改。(did not return an image)');
      if (images.length !== 1) throw new Error('Codex 原生 ImageGen 返回了多张图片，项目未更改。(multiple images)');
      const imageBase64 = validateImageItem(images[0], this.maxImageBytes);
      const image = record(images[0]);
      const provider: NonNullable<CodexImageTurnResult['provider']> = {
        threadId,
        turnId,
      };
      if (typeof image?.id === 'string' && image.id.length > 0) {
        provider.itemId = image.id;
      }
      progress(request, 'ImageGen 已返回视觉候选。');
      return { imageBase64, provider };
    })();

    return Promise.race([operation, timeout]).finally(() => {
      cleanupTimer();
      stopMessage();
      stopExit();
    });
  }
}

interface TurnOutcome { error?: Error }

function isPendingTurnMessage(message: JsonRpcMessage): boolean {
  const params = record(message.params);
  if (!params) return false;
  if (message.method === 'item/started' || message.method === 'item/completed') {
    return typeof params.turnId === 'string'
      && record(params.item)?.type === 'imageGeneration';
  }
  if (message.method === 'error') return typeof params.turnId === 'string';
  if (message.method === 'turn/completed') return typeof record(params.turn)?.id === 'string';
  return false;
}

function inspectTurnMessage(
  message: JsonRpcMessage,
  threadId: string,
  turnId: string,
  images: unknown[],
  settle: (outcome: TurnOutcome) => void,
  onProgress: (message: string) => void,
): void {
  const params = record(message.params);
  if (!params || params.threadId !== threadId) return;
  if (message.method === 'item/started') {
    if (params.turnId !== turnId) return;
    const item = record(params.item);
    if (item?.type === 'imageGeneration') onProgress('ImageGen 正在生成图片…');
    return;
  }
  if (message.method === 'item/completed') {
    if (params.turnId !== turnId) return;
    const item = record(params.item);
    if (item?.type === 'imageGeneration') images.push(item);
    return;
  }
  if (message.method === 'error') {
    if (params.turnId !== turnId || params.willRetry === true) return;
    const error = record(params.error);
    settle({ error: new Error(typeof error?.message === 'string' ? error.message : 'Codex 原生 ImageGen 任务失败，项目未更改。') });
    return;
  }
  if (message.method !== 'turn/completed') return;
  const turn = record(params.turn);
  if (turn?.id !== turnId) return;
  if (turn.status !== 'completed') {
    const error = record(turn.error);
    settle({ error: new Error(typeof error?.message === 'string' ? error.message : `Codex 原生 ImageGen 任务未完成：${String(turn.status)}`) });
    return;
  }
  settle({});
}

function validateImageItem(value: unknown, maxImageBytes: number): string {
  const item = record(value);
  const failure = record(item?.failure);
  if (failure?.type === 'usageLimitExceeded') {
    throw new Error(`原生 ImageGen 额度已用尽，项目未更改。(usage limit exceeded${typeof failure.limitId === 'string' ? `: ${failure.limitId}` : ''})`);
  }
  if (!item || item.status !== 'completed' || item.failure !== null || typeof item.result !== 'string') {
    throw new Error('Codex ImageGen returned a failed or malformed image item');
  }
  const prefix = 'data:image/png;base64,';
  const imageBase64 = item.result.startsWith(prefix) ? item.result.slice(prefix.length) : item.result;
  const maxEncodedLength = Math.ceil(maxImageBytes / 3) * 4;
  if (imageBase64.length > maxEncodedLength) throw new Error('Codex ImageGen 图片过大，项目未更改。(too large)');
  if (!isBase64(imageBase64)) throw new Error('Codex ImageGen 返回了无效的 base64 图片数据，项目未更改。(malformed base64)');
  const padding = imageBase64.endsWith('==') ? 2 : imageBase64.endsWith('=') ? 1 : 0;
  const bytes = (imageBase64.length / 4) * 3 - padding;
  if (bytes > maxImageBytes) throw new Error('Codex ImageGen 图片过大，项目未更改。(too large)');
  return imageBase64;
}

function isBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  for (let index = 0; index < value.length - padding; index += 1) {
    const code = value.charCodeAt(index);
    const alphaNumeric = (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57);
    if (!alphaNumeric && code !== 43 && code !== 47) return false;
  }
  for (let index = value.length - padding; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) return false;
  }
  return true;
}

function progress(request: CodexImageTurnRequest, message: string): void {
  try { request.onProgress?.(message); } catch { /* Progress observers cannot change generation. */ }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}

function positiveFinite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

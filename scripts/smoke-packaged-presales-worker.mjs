// Offline package acceptance only: no native app, real provider, network or profile.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';

const binary = process.argv[2];
assert.ok(binary && isAbsolute(binary), 'Pass an absolute packaged Worker path');
const scratch = await mkdtemp(join(tmpdir(), 'presales-package-smoke-'));
const workers = [];
const sha256 = value => createHash('sha256').update(value).digest('hex');

function start(args, handle = () => {}) {
  // The child cannot find Node/Codex through PATH and inherits no account settings.
  const child = spawn(binary, args, { cwd: scratch, env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const messages = [];
  let failure;
  let stderr = '';
  let exited = false;
  const exit = new Promise(resolve => child.on('exit', (code, signal) => { exited = true; resolve({ code, signal }); }));
  child.on('error', error => { failure = error; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const send = message => child.stdin.write(`${JSON.stringify(message)}\n`);
  createInterface({ input: child.stdout }).on('line', line => {
    try { const message = JSON.parse(line); messages.push(message); handle(message, send); }
    catch (error) { failure = error; }
  });
  const worker = {
    child, messages, send,
    async wait(predicate) {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (failure) throw failure;
        const found = messages.find(predicate);
        if (found) return found;
        if (exited) throw Error(`Unexpected Worker exit: ${stderr}`);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw Error(`Worker response timeout: ${JSON.stringify(messages)} ${stderr}`);
    },
    async call(id, method, params) { send({ jsonrpc: '2.0', id, method, params }); return this.wait(m => m.id === id); },
    async close() {
      if (!exited) child.stdin.end();
      let timer;
      const result = await Promise.race([exit, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Worker did not close')), 5000); })]).finally(() => clearTimeout(timer));
      assert.deepEqual(result, { code: 0, signal: null });
      if (failure) throw failure;
      return { exit: result, stderr };
    },
  };
  workers.push(worker);
  return worker;
}

try {
  // Create a genuine in-memory checkpoint, not a hand-built accepted snapshot.
  const seed = start([]);
  const created = await seed.call(1, 'ppt.project.create', {
    id: 'project-packaged-v3-offline', name: '离线打包边界', goal: '仅验证离线协议',
    createdAt: '2026-09-14T00:00:00.000Z', preferenceSnapshot: [],
  });
  assert.ok(created.result?.pipeline, JSON.stringify(created));
  const seedExit = await seed.close();
  const validator = start(['--presales-validate']);
  const compact = JSON.stringify(created.result.pipeline);
  const spaced = JSON.stringify(created.result.pipeline, null, 2);
  const validations = [];
  for (const [id, snapshot] of [['compact', compact], ['spaced', spaced]]) {
    const response = await validator.call(id, 'presales.legacy.validate', { generation: 7, snapshot });
    const result = response.result;
    assert.equal(result?.generation, 7, JSON.stringify(response));
    assert.equal(result.validation.validator, 'native-pipeline-checkpoint-v1');
    assert.equal(result.validation.snapshotSha256, sha256(snapshot));
    assert.equal(result.validation.byteLength, Buffer.byteLength(snapshot));
    assert.equal(result.validation.projectId, 'project-packaged-v3-offline');
    validations.push(result.validation);
  }
  assert.notEqual(validations[0].snapshotSha256, validations[1].snapshotSha256);
  const forged = structuredClone(created.result.pipeline);
  forged.project.workflowStatus = 'completed';
  forged.revision = 99;
  assert.equal((await validator.call('forged', 'presales.legacy.validate', { generation: 7, snapshot: JSON.stringify(forged) })).error?.code, -32602);
  assert.equal((await validator.call('forbidden', 'presales/start', { generation: 7, snapshot: compact })).error?.code, -32601);
  const validatorExit = await validator.close();

  const methods = [];
  let nativeStarts = 0;
  const replies = {
    initialize: { userAgent: 'synthetic-package-smoke' },
    'account/read': { account: { type: 'chatgpt', email: 'synthetic@example.invalid', planType: 'pro' }, requiresOpenaiAuth: true },
    'config/read': { config: { model_provider: 'openai' }, origins: {}, layers: null },
    'configRequirements/read': { requirements: null },
    'model/list': { data: [{ id: 'synthetic', model: 'synthetic-model', isDefault: true, inputModalities: ['text', 'image'] }], nextCursor: null },
    'modelProvider/capabilities/read': { namespaceTools: true, imageGeneration: true, webSearch: false },
  };
  const runtime = start(['--presales-runtime'], (message, send) => {
    if (!message.method?.startsWith('native/')) return;
    assert.equal(message.params.generation, 1);
    if (message.method === 'native/provider/start') {
      nativeStarts++;
      send({ id: message.id, result: { cwd: scratch } });
      return;
    }
    assert.equal(message.method, 'native/provider/send', 'No native file/input/model execution authorized');
    const rpc = JSON.parse(message.params.line);
    methods.push(rpc.method);
    assert.ok(rpc.method === 'initialized' || Object.hasOwn(replies, rpc.method), `Unexpected provider method ${rpc.method}`);
    send({ id: message.id, result: {} });
    if (rpc.id !== undefined) send({ method: 'presales/provider/line', params: { generation: 1, line: JSON.stringify({ id: rpc.id, result: replies[rpc.method] }) } });
  });
  const initial = await runtime.call('initial', 'presales/status', { generation: 1 });
  assert.equal(initial.result?.available, false);
  assert.equal(initial.result?.active, 0);
  const capable = await runtime.wait(m => m.method === 'presales/capabilities' && m.params.available === true);
  assert.deepEqual(capable.params, { generation: 1, available: true, capabilities: { generation: true, referenceEditing: true } });
  assert.match((await runtime.call('old-generation', 'presales/status', { generation: 2 })).error?.message, /Old process generation/);
  assert.match((await runtime.call('legacy-rejected', 'ppt.project.create', { generation: 1 })).error?.message, /Unknown private runtime method/);
  runtime.send({ method: 'presales/provider/lost', params: { generation: 1 } });
  const revoked = await runtime.wait(m => m.method === 'presales/capabilities' && m.params.available === false);
  assert.equal(revoked.params.capabilities.generation, false);
  assert.equal(revoked.params.capabilities.referenceEditing, false);
  const runtimeExit = await runtime.close();
  assert.equal(nativeStarts, 1);
  assert.deepEqual(methods, ['initialize', 'initialized', 'account/read', 'config/read', 'configRequirements/read', 'model/list', 'modelProvider/capabilities/read']);
  assert.deepEqual(await readdir(scratch), [], 'Offline smoke must not create workspace files');
  console.log(JSON.stringify({
    observedAt: new Date().toISOString(), binary, sha256: sha256(await readFile(binary)),
    scope: 'Packaged SEA; fake native/provider replies only; no GUI, real account, model turn, HTTP listener or editable conversion',
    validation: { accepted: validations, forgedRejected: true, runtimeMethodRejected: true },
    runtime: { initial: initial.result, capable: capable.params, revoked: revoked.params, oldGenerationRejected: true, legacyMethodRejected: true, nativeStarts, syntheticProviderMethods: methods, threadOrTurnCalls: 0 },
    emptyScratch: true, processes: { seed: seedExit, validator: validatorExit, runtime: runtimeExit },
  }, null, 2));
} finally {
  for (const { child } of workers) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await rm(scratch, { recursive: true, force: true });
}

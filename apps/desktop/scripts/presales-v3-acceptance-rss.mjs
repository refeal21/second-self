/** Sample the synthetic coordinator, native test and owned helpers, never the live app. */
/* global process */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const binary = process.env.PRESALES_TEST_BINARY;
if (!binary) throw Error('Set PRESALES_TEST_BINARY to the freshly compiled Rust lib test executable.');
const output = resolve(root, 'artifacts/qa/presales-v3');
await mkdir(output, { recursive: true });
const test = spawn(binary, [
  'presales_v3::import_tests::acceptance_tests::five_page_acceptance_concurrency_review_revisions_reopen_and_exact_delivery',
  '--exact', '--nocapture',
], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
const testExit = once(test, 'exit');
const sampler = spawn(resolve(root, 'apps/desktop/src-tauri/target/debug/process-rss-sampler'), [
  // The coordinator remains alive for the sampler's final capture after test exit.
  // Measurement overhead (this Node process and the sampler) is included, not subtracted.
  '--root-pid', String(process.pid), '--output', resolve(output, 'native-synthetic-rss.json'),
], { cwd: root, stdio: ['pipe', 'inherit', 'inherit'] });
const samplerExit = once(sampler, 'exit');
let log = '', pending = '';
test.stdout.on('data', chunk => { log += chunk; });
test.stderr.on('data', chunk => {
  log += chunk; pending += chunk;
  const lines = pending.split('\n'); pending = lines.pop();
  for (const line of lines) {
    const match = line.match(/^acceptance-window: (.+)$/);
    if (match) sampler.stdin.write(JSON.stringify({ operation: match[1] }) + '\n');
  }
});
try {
  const [code] = await testExit;
  await writeFile(resolve(output, 'native-synthetic-rss-test.log'), log);
  assert.equal(code, 0, log);
} finally { sampler.stdin.end(JSON.stringify({ stop: true }) + '\n'); }
const [sampleCode] = await samplerExit;
assert.equal(sampleCode, 0);
const report = JSON.parse(await readFile(resolve(output, 'native-synthetic-rss.json'), 'utf8'));
assert(report.sampleCount > 0);
process.stdout.write(JSON.stringify({
  rootPid: report.rootPid, sampleCount: report.sampleCount, sampledMaxRssMiB: report.peakRssMiB,
  operationWindows: report.operationEvents.map(e => e.operation), intervalMs: 100,
  roles: ['Node acceptance coordinator', 'Rust RSS sampler (measurement overhead included)', 'Rust native test host/SQLite/vault', 'synthetic Worker Node/SEA fixture preparation', 'private Worker runtime/tsx helpers'],
  exclusions: ['native GUI/WebKit', 'real Codex/ImageGen provider', 'reparented helpers', 'between-sample spikes', 'physical/true peak memory'],
  claim: 'sampled synthetic acceptance harness process-tree RSS, including measurement overhead',
}, null, 2) + '\n');

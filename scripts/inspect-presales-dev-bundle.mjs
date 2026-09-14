// Read-only package identity evidence. This never signs or launches the app.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const bundle = process.argv[2];
assert.ok(bundle && isAbsolute(bundle), 'Pass an absolute development bundle path');
const repository = resolve(import.meta.dirname, '..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const files = [];
async function scan(dir = '') {
  const entries = await readdir(join(bundle, dir), { withFileTypes: true });
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await scan(path);
    else {
      const bytes = await readFile(join(bundle, path));
      files.push({ path, bytes: bytes.length, sha256: digest(bytes) });
    }
  }
}
await scan();
const inspect = command => {
  const result = spawnSync(command[0], command.slice(1), { encoding: 'utf8' });
  if (result.error) throw result.error;
  return { command, status: result.status, stdout: result.stdout, stderr: result.stderr };
};
const main = join(bundle, 'Contents/MacOS/digital-twin-desktop');
const worker = join(bundle, 'Contents/MacOS/digital-twin-worker');
const license = await readFile(join(bundle, 'Contents/Resources/licenses/node-runtime/LICENSE-and-third-party-notices.txt'));
const nodeLicense = await readFile(resolve(dirname(process.execPath), '../LICENSE'));
const sourceWorker = await readFile(join(repository, 'apps/desktop/src-tauri/binaries/digital-twin-worker-aarch64-apple-darwin'));
assert.ok(license.equals(nodeLicense), 'Bundle license must match the inspection Node distribution');
assert.equal(digest(sourceWorker), digest(await readFile(worker)), 'Packaged Worker must match freshly built SEA');
const checks = [
  ['plutil', '-p', join(bundle, 'Contents/Info.plist')],
  ['file', main, worker],
  ['codesign', '--verify', '--deep', '--strict', '--verbose=2', bundle],
  ['codesign', '-dv', '--verbose=4', bundle],
  ['codesign', '--verify', '--strict', '--verbose=2', worker],
  ['codesign', '-dv', '--verbose=4', worker],
  ['codesign', '-d', '--entitlements', '-', main],
  ['codesign', '-d', '--entitlements', '-', worker],
  ['du', '-sk', bundle],
].map(inspect);
console.log(JSON.stringify({
  observedAt: new Date().toISOString(),
  inspectedCheckoutCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
  bundle, files, totalFileBytes: files.reduce((sum, file) => sum + file.bytes, 0),
  treeManifestSha256: digest(JSON.stringify(files)),
  treeDigestDefinition: 'sha256(JSON.stringify(ordered entries {path,bytes,sha256})); not an archive byte hash',
  nodeVersion: process.version, matchingNodeLicense: true, workerMatchesFreshSEA: true,
  versionText: await readFile(join(bundle, 'Contents/Resources/licenses/node-runtime/VERSION.txt'), 'utf8'), checks,
}, null, 2));
assert.ok(checks.every(check => check.status === 0), 'One or more bundle checks failed; inspect recorded results');

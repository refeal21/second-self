import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildDirectory = join(repository, 'artifacts', 'build', 'worker-sidecar');
const binaryDirectory = join(repository, 'apps', 'desktop', 'src-tauri', 'binaries');
const triple = execFileSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' }).trim();
if (!triple) throw new Error('rustc did not report a host target triple');
const extension = process.platform === 'win32' ? '.exe' : '';
const outputBinary = join(binaryDirectory, `digital-twin-worker-${triple}${extension}`);
const bundledJavaScript = join(buildDirectory, 'worker-sidecar.cjs');
const seaBlob = join(buildDirectory, 'worker-sidecar.blob');
const seaConfig = join(buildDirectory, 'sea-config.json');
const runtimeResourceDirectory = join(repository, 'apps', 'desktop', 'src-tauri', 'resources', 'node-runtime');
const nodeDistributionRoot = resolve(dirname(process.execPath), '..');
const nodeLicenseSource = join(nodeDistributionRoot, 'LICENSE');

await rm(buildDirectory, { recursive: true, force: true });
await mkdir(buildDirectory, { recursive: true });
await mkdir(binaryDirectory, { recursive: true });
await rm(runtimeResourceDirectory, { recursive: true, force: true });
await mkdir(runtimeResourceDirectory, { recursive: true });
const nodeLicense = await readFile(nodeLicenseSource, 'utf8').catch(() => {
  throw new Error(`The matching Node distribution LICENSE is missing: ${nodeLicenseSource}`);
});
if (!nodeLicense.includes('third-party software notices')) {
  throw new Error('Node distribution LICENSE does not contain its bundled third-party notices');
}
await writeFile(join(runtimeResourceDirectory, 'LICENSE-and-third-party-notices.txt'), nodeLicense);
await writeFile(join(runtimeResourceDirectory, 'VERSION.txt'), `${process.version}\n`);
await build({
  entryPoints: [join(repository, 'apps', 'worker', 'src', 'sidecar-cli.ts')],
  outfile: bundledJavaScript,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: false,
  minify: true,
});
await writeFile(
  seaConfig,
  JSON.stringify({
    main: bundledJavaScript,
    output: seaBlob,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
  }),
);
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });
await copyFile(process.execPath, outputBinary);
if (process.platform === 'darwin') {
  execFileSync('codesign', ['--remove-signature', outputBinary], { stdio: 'ignore' });
}
const postject = join(repository, 'node_modules', '.bin', `postject${process.platform === 'win32' ? '.cmd' : ''}`);
const platformInjectionArguments =
  process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : [];
execFileSync(
  postject,
  [
    outputBinary,
    'NODE_SEA_BLOB',
    seaBlob,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    ...platformInjectionArguments,
  ],
  { stdio: 'inherit' },
);
await chmod(outputBinary, 0o755);
if (process.platform === 'darwin') {
  execFileSync('codesign', ['--force', '--sign', '-', outputBinary], { stdio: 'inherit' });
}
console.log(outputBinary);

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const COMPILER_SOURCE = resolve(REPO_ROOT, 'scripts/compile-presales-skill.mjs');
const GENERATED_PATH = 'apps/worker/src/presales/skill.generated.ts';
const METADATA_PATH = 'apps/worker/src/presales/skill.metadata.generated.json';
const SKILL_ROOT = 'apps/worker/skills/presales-ppt';

const fixtureRoots: string[] = [];

function writeFixtureFile(root: string, path: string, contents: string): void {
  const absolutePath = resolve(root, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents, 'utf8');
}

function createFixture(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'presales-skill-build-'));
  fixtureRoots.push(root);

  expect(existsSync(COMPILER_SOURCE), 'compiler must be implemented').toBe(true);
  writeFixtureFile(
    root,
    'scripts/compile-presales-skill.mjs',
    readFileSync(COMPILER_SOURCE, 'utf8'),
  );
  writeFixtureFile(
    root,
    `${SKILL_ROOT}/SKILL.md`,
    [
      '---',
      'name: presales-ppt',
      'description: Use when planning evidence-bound presales presentations.',
      'license: MIT',
      'metadata:',
      '  version: "1.0.0"',
      '---',
      '',
      '# Shared rules',
      '',
      'Use only confirmed project evidence.',
      '',
    ].join('\n'),
  );
  writeFixtureFile(
    root,
    `${SKILL_ROOT}/references/outline.md`,
    '# Outline\n\nMap goals to modules.\n',
  );
  writeFixtureFile(
    root,
    `${SKILL_ROOT}/references/details.md`,
    '# Details\n\nBind each visible label once.\n',
  );
  writeFixtureFile(
    root,
    `${SKILL_ROOT}/references/visual.md`,
    '# Visual\n\nDesign a complete slide.\n',
  );
  writeFixtureFile(
    root,
    `${SKILL_ROOT}/sources.json`,
    `${JSON.stringify(
      {
        sources: [
          {
            name: 'Synthetic upstream',
            repository: 'https://example.invalid/synthetic',
            commit: '0123456789abcdef0123456789abcdef01234567',
            license: 'MIT',
            references: ['guide.md'],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  return root;
}

function runCompiler(root: string, args: string[] = [], cwd = root) {
  return spawnSync(
    process.execPath,
    [resolve(root, 'scripts/compile-presales-skill.mjs'), ...args],
    { cwd, encoding: 'utf8' },
  );
}

function readGenerated(root: string): string {
  return readFileSync(resolve(root, GENERATED_PATH), 'utf8');
}

function readMetadata(root: string): string {
  return readFileSync(resolve(root, METADATA_PATH), 'utf8');
}

function parseGenerated(root: string): {
  id: string;
  version: string;
  sha256: string;
  sourceHashes: Record<string, string>;
  stages: Record<string, string>;
} {
  const source = readGenerated(root);
  const prefix = 'export const PRESALES_SKILL = ';
  expect(source.startsWith(prefix)).toBe(true);
  expect(source.endsWith(' as const;\n')).toBe(true);
  return JSON.parse(source.slice(prefix.length, -' as const;\n'.length));
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('presales skill compiler', () => {
  it('produces byte-identical output across repeated builds', () => {
    const fixture = createFixture();

    expect(runCompiler(fixture).status).toBe(0);
    const first = readGenerated(fixture);
    const firstMetadata = readMetadata(fixture);
    expect(runCompiler(fixture).status).toBe(0);

    expect(readGenerated(fixture)).toBe(first);
    expect(readMetadata(fixture)).toBe(firstMetadata);
  });

  it('resolves the default repository root from the compiler location', () => {
    const fixture = createFixture();
    const unrelatedCwd = mkdtempSync(resolve(tmpdir(), 'presales-other-cwd-'));
    fixtureRoots.push(unrelatedCwd);

    const result = runCompiler(fixture, [], unrelatedCwd);

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(resolve(fixture, GENERATED_PATH))).toBe(true);
    expect(existsSync(resolve(fixture, METADATA_PATH))).toBe(true);
    expect(existsSync(resolve(unrelatedCwd, GENERATED_PATH))).toBe(false);
    expect(existsSync(resolve(unrelatedCwd, METADATA_PATH))).toBe(false);
  });

  it('check detects a changed skill without updating generated output', () => {
    const fixture = createFixture();
    expect(runCompiler(fixture).status).toBe(0);
    const before = readGenerated(fixture);
    const beforeMetadata = readMetadata(fixture);
    writeFixtureFile(
      fixture,
      `${SKILL_ROOT}/references/details.md`,
      '# Details\n\nScene label changed.\n',
    );

    const checked = runCompiler(fixture, ['--check']);

    expect(checked.status).not.toBe(0);
    expect(readGenerated(fixture)).toBe(before);
    expect(readMetadata(fixture)).toBe(beforeMetadata);
  });

  it.each([
    ['bundle', GENERATED_PATH],
    ['metadata', METADATA_PATH],
  ])('check detects missing %s output without recreating files', (_case, path) => {
    const fixture = createFixture();
    expect(runCompiler(fixture).status).toBe(0);
    rmSync(resolve(fixture, path));

    const checked = runCompiler(fixture, ['--check']);

    expect(checked.status).not.toBe(0);
    expect(existsSync(resolve(fixture, path))).toBe(false);
  });

  it('emits native metadata with the exact bundle identity', () => {
    const fixture = createFixture();
    expect(runCompiler(fixture).status).toBe(0);

    const bundle = parseGenerated(fixture);
    const metadata = JSON.parse(readMetadata(fixture)) as Record<string, unknown>;

    expect(metadata).toEqual({
      id: bundle.id,
      version: bundle.version,
      sha256: bundle.sha256,
    });
  });

  it('check detects stale metadata without rewriting either output', () => {
    const fixture = createFixture();
    expect(runCompiler(fixture).status).toBe(0);
    const bundle = readGenerated(fixture);
    writeFixtureFile(fixture, METADATA_PATH, '{"stale":true}\n');

    const checked = runCompiler(fixture, ['--check']);

    expect(checked.status).not.toBe(0);
    expect(readGenerated(fixture)).toBe(bundle);
    expect(readMetadata(fixture)).toBe('{"stale":true}\n');
  });

  it('fails when a required stage reference is missing', () => {
    const fixture = createFixture();
    rmSync(resolve(fixture, `${SKILL_ROOT}/references/visual.md`));

    const result = runCompiler(fixture);

    expect(result.status).not.toBe(0);
    expect(existsSync(resolve(fixture, GENERATED_PATH))).toBe(false);
  });

  it('updates exact source hashes and the bundle hash when metadata changes', () => {
    const fixture = createFixture();
    expect(runCompiler(fixture).status).toBe(0);
    const before = parseGenerated(fixture);
    const metadataPath = `${SKILL_ROOT}/sources.json`;
    const changedMetadata = `${JSON.stringify(
      {
        sources: [
          {
            name: 'Synthetic upstream',
            repository: 'https://example.invalid/synthetic',
            commit: 'fedcba9876543210fedcba9876543210fedcba98',
            license: 'MIT',
            references: ['guide.md'],
          },
        ],
      },
      null,
      2,
    )}\n`;
    writeFixtureFile(fixture, metadataPath, changedMetadata);

    expect(runCompiler(fixture).status).toBe(0);
    const after = parseGenerated(fixture);

    expect(after.sourceHashes[metadataPath]).toBe(
      createHash('sha256').update(changedMetadata, 'utf8').digest('hex'),
    );
    expect(after.sourceHashes[metadataPath]).not.toBe(
      before.sourceHashes[metadataPath],
    );
    expect(after.sha256).not.toBe(before.sha256);
    expect(Object.keys(after.sourceHashes)).toEqual([
      `${SKILL_ROOT}/SKILL.md`,
      `${SKILL_ROOT}/references/outline.md`,
      `${SKILL_ROOT}/references/details.md`,
      `${SKILL_ROOT}/references/visual.md`,
      metadataPath,
    ]);
  });

  it.each([
    ['missing frontmatter', '# Not a manifest\n'],
    [
      'wrong package id',
      '---\nname: other-skill\ndescription: Use when testing.\nmetadata:\n  version: "1.0.0"\n---\n',
    ],
    [
      'wrong package version',
      '---\nname: presales-ppt\ndescription: Use when testing.\nmetadata:\n  version: "2.0.0"\n---\n',
    ],
  ])('rejects a malformed manifest: %s', (_case, manifest) => {
    const fixture = createFixture();
    writeFixtureFile(fixture, `${SKILL_ROOT}/SKILL.md`, manifest);

    const result = runCompiler(fixture);

    expect(result.status).not.toBe(0);
    expect(existsSync(resolve(fixture, GENERATED_PATH))).toBe(false);
  });

  it('rejects source metadata paths that traverse outside the package', () => {
    const fixture = createFixture();
    writeFixtureFile(
      fixture,
      `${SKILL_ROOT}/sources.json`,
      `${JSON.stringify({
        sources: [
          {
            name: 'Synthetic upstream',
            repository: 'https://example.invalid/synthetic',
            commit: '0123456789abcdef0123456789abcdef01234567',
            license: 'MIT',
            references: ['../escape.md'],
          },
        ],
      })}\n`,
    );

    const result = runCompiler(fixture);

    expect(result.status).not.toBe(0);
    expect(existsSync(resolve(fixture, GENERATED_PATH))).toBe(false);
  });

  it('rejects a whitespace-only source reference', () => {
    const fixture = createFixture();
    writeFixtureFile(
      fixture,
      `${SKILL_ROOT}/sources.json`,
      `${JSON.stringify({
        sources: [
          {
            name: 'Synthetic upstream',
            repository: 'https://example.invalid/synthetic',
            commit: '0123456789abcdef0123456789abcdef01234567',
            license: 'MIT',
            references: ['   '],
          },
        ],
      })}\n`,
    );

    const result = runCompiler(fixture);

    expect(result.status).not.toBe(0);
    expect(existsSync(resolve(fixture, GENERATED_PATH))).toBe(false);
  });

  it('rejects an HTTPS repository value without a hostname', () => {
    const fixture = createFixture();
    writeFixtureFile(
      fixture,
      `${SKILL_ROOT}/sources.json`,
      `${JSON.stringify({
        sources: [
          {
            name: 'Synthetic upstream',
            repository: 'https://',
            commit: '0123456789abcdef0123456789abcdef01234567',
            license: 'MIT',
            references: ['guide.md'],
          },
        ],
      })}\n`,
    );

    const result = runCompiler(fixture);

    expect(result.status).not.toBe(0);
    expect(existsSync(resolve(fixture, GENERATED_PATH))).toBe(false);
  });

  it('combines shared instructions with each stage reference', () => {
    const fixture = createFixture();

    expect(runCompiler(fixture).status).toBe(0);
    const generated = parseGenerated(fixture);

    expect(generated.id).toBe('presales-ppt');
    expect(generated.version).toBe('1.0.0');
    expect(generated.stages.outline).toContain('Use only confirmed project evidence.');
    expect(generated.stages.outline).toContain('Map goals to modules.');
    expect(generated.stages.details).toContain('Bind each visible label once.');
    expect(generated.stages.visual).toContain('Design a complete slide.');
  });
});

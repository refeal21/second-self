import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

const PACKAGE_ID = 'presales-ppt';
const PACKAGE_VERSION = '1.0.0';
const SKILL_DIRECTORY = 'apps/worker/skills/presales-ppt';
const OUTPUT_PATH = 'apps/worker/src/presales/skill.generated.ts';
const SOURCE_PATHS = [
  `${SKILL_DIRECTORY}/SKILL.md`,
  `${SKILL_DIRECTORY}/references/outline.md`,
  `${SKILL_DIRECTORY}/references/details.md`,
  `${SKILL_DIRECTORY}/references/visual.md`,
  `${SKILL_DIRECTORY}/sources.json`,
];

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  let check = false;
  let root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--check') {
      check = true;
      continue;
    }
    if (argument === '--root') {
      const value = argv[index + 1];
      if (!value || !isAbsolute(value)) {
        fail('--root requires an absolute repository path');
      }
      root = value;
      index += 1;
      continue;
    }
    fail(`Unknown argument: ${argument}`);
  }

  return { check, root };
}

function readUtf8(root, relativePath) {
  let bytes;
  try {
    bytes = readFileSync(resolve(root, relativePath));
  } catch {
    fail(`Missing required source: ${relativePath}`);
  }

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail(`Source is not valid UTF-8: ${relativePath}`);
  }

  return { bytes, text };
}

function scalarValue(raw, field) {
  const value = raw.trim();
  if (!value) fail(`Manifest ${field} must not be empty`);
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    if (value.at(-1) !== quote || value.length < 2) {
      fail(`Manifest ${field} has malformed quoting`);
    }
    return value.slice(1, -1);
  }
  if (/[[\]{}]/u.test(value)) {
    fail(`Manifest ${field} must be a scalar`);
  }
  return value;
}

function parseManifest(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(source);
  if (!match) fail('SKILL.md has malformed YAML frontmatter');

  const manifest = {};
  let inMetadata = false;
  for (const line of match[1].split(/\r?\n/u)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;

    const metadataEntry = /^ {2}([a-z][a-z0-9-]*):\s*(.*)$/u.exec(line);
    if (metadataEntry) {
      if (!inMetadata || metadataEntry[1] !== 'version' || manifest.version) {
        fail(`Unsupported manifest metadata: ${line.trim()}`);
      }
      manifest.version = scalarValue(metadataEntry[2], 'metadata.version');
      continue;
    }

    const topLevel = /^([a-z][a-z0-9-]*):\s*(.*)$/u.exec(line);
    if (!topLevel) fail(`Malformed manifest line: ${line}`);
    const [, key, rawValue] = topLevel;
    if (!['name', 'description', 'license', 'metadata'].includes(key)) {
      fail(`Unsupported manifest field: ${key}`);
    }
    if (Object.hasOwn(manifest, key)) fail(`Duplicate manifest field: ${key}`);
    if (key === 'metadata') {
      if (rawValue.trim()) fail('Manifest metadata must be a mapping');
      manifest.metadata = true;
      inMetadata = true;
      continue;
    }
    manifest[key] = scalarValue(rawValue, key);
    inMetadata = false;
  }

  if (manifest.name !== PACKAGE_ID) {
    fail(`Manifest name must be ${PACKAGE_ID}`);
  }
  if (manifest.version !== PACKAGE_VERSION) {
    fail(`Manifest metadata.version must be ${PACKAGE_VERSION}`);
  }
  if (typeof manifest.description !== 'string') {
    fail('Manifest description is required');
  }

  return source.slice(match[0].length).trim();
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validateReferencePath(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    fail(`Unsafe source reference path: ${String(value)}`);
  }
}

function validateSourceMetadata(source) {
  let metadata;
  try {
    metadata = JSON.parse(source);
  } catch {
    fail('sources.json must contain valid JSON');
  }
  if (!isPlainObject(metadata) || !hasExactKeys(metadata, ['sources'])) {
    fail('sources.json must contain only a sources array');
  }
  if (!Array.isArray(metadata.sources) || metadata.sources.length === 0) {
    fail('sources.json sources must be a non-empty array');
  }

  const seenNames = new Set();
  for (const entry of metadata.sources) {
    if (
      !isPlainObject(entry) ||
      !hasExactKeys(entry, ['name', 'repository', 'commit', 'license', 'references'])
    ) {
      fail('Each source must define name, repository, commit, license, and references');
    }
    if (typeof entry.name !== 'string' || !entry.name.trim() || seenNames.has(entry.name)) {
      fail('Source names must be non-empty and unique');
    }
    seenNames.add(entry.name);
    if (typeof entry.repository !== 'string' || !entry.repository.startsWith('https://')) {
      fail(`Source repository must be an HTTPS URL: ${entry.name}`);
    }
    if (typeof entry.commit !== 'string' || !/^[0-9a-f]{40}$/u.test(entry.commit)) {
      fail(`Source commit must be a full lowercase SHA-1: ${entry.name}`);
    }
    if (entry.license !== 'MIT') {
      fail(`Source license must be MIT: ${entry.name}`);
    }
    if (!Array.isArray(entry.references) || entry.references.length === 0) {
      fail(`Source references must be a non-empty array: ${entry.name}`);
    }
    const seenReferences = new Set();
    for (const reference of entry.references) {
      validateReferencePath(reference);
      if (seenReferences.has(reference)) {
        fail(`Duplicate source reference: ${entry.name}/${reference}`);
      }
      seenReferences.add(reference);
    }
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function compile(root) {
  const sources = new Map(
    SOURCE_PATHS.map((relativePath) => [relativePath, readUtf8(root, relativePath)]),
  );
  const entrypoint = sources.get(`${SKILL_DIRECTORY}/SKILL.md`);
  const metadata = sources.get(`${SKILL_DIRECTORY}/sources.json`);
  if (!entrypoint || !metadata) fail('Internal source manifest error');

  const sharedBody = parseManifest(entrypoint.text);
  validateSourceMetadata(metadata.text);

  const sourceHashes = {};
  for (const relativePath of SOURCE_PATHS) {
    sourceHashes[relativePath] = sha256(sources.get(relativePath).bytes);
  }

  const stages = {};
  for (const stage of ['outline', 'details', 'visual']) {
    const reference = sources.get(`${SKILL_DIRECTORY}/references/${stage}.md`);
    if (!reference) fail(`Internal stage source error: ${stage}`);
    stages[stage] = `${sharedBody}\n\n${reference.text.trim()}\n`;
  }

  const payload = {
    id: PACKAGE_ID,
    version: PACKAGE_VERSION,
    sourceHashes,
    stages,
  };
  const bundle = {
    id: payload.id,
    version: payload.version,
    sha256: sha256(JSON.stringify(payload)),
    sourceHashes: payload.sourceHashes,
    stages: payload.stages,
  };
  return `export const PRESALES_SKILL = ${JSON.stringify(bundle, null, 2)} as const;\n`;
}

function main() {
  const { check, root } = parseArguments(process.argv.slice(2));
  const expected = compile(root);
  const output = resolve(root, OUTPUT_PATH);

  if (check) {
    let current;
    try {
      current = readFileSync(output, 'utf8');
    } catch {
      fail(`Generated output is missing: ${OUTPUT_PATH}`);
    }
    if (current !== expected) fail(`Generated output is stale: ${OUTPUT_PATH}`);
    return;
  }

  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, expected, 'utf8');
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`compile-presales-skill: ${message}\n`);
  process.exitCode = 1;
}

import { XMLParser, XMLValidator } from 'fast-xml-parser';
import JSZip from 'jszip';
import type { TemplateStyleInspection } from './visual-style.js';

const MAX_PPTX_BYTES = 50 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 4_096;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const MAX_XML_BYTES = 1024 * 1024;
const MAX_REFERENCED_PARTS = 2_048;
const MAX_CANDIDATE_COLORS = 64;
const CONFIRMATION_WARNING =
  'Palette candidates are suggestions and require explicit user confirmation.';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  parseTagValue: false,
  processEntities: false,
  trimValues: false,
});

interface Relationship {
  id: string;
  type: string;
  target: string;
  external: boolean;
}

interface ZipMetadata {
  compressedSize?: number;
  uncompressedSize?: number;
}

type InspectedZipObject = JSZip.JSZipObject & {
  unsafeOriginalName?: string;
  _data?: ZipMetadata;
};

/** Inspects only the supplied in-memory PPTX. It performs no HTTP or filesystem IO. */
export async function inspectTemplateStyle(
  contentsBase64: string,
): Promise<TemplateStyleInspection> {
  assertBoundedBase64(contentsBase64);
  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(contentsBase64, {
      base64: true,
      checkCRC32: false,
      createFolders: false,
    });
  } catch {
    throw new Error('Template must be a valid PPTX ZIP archive');
  }
  validateArchiveMetadata(archive);

  const warnings: string[] = [];
  const parts = new ReferencedPartReader(archive, warnings);
  const presentationPath = 'ppt/presentation.xml';
  const presentation = await parts.xml(presentationPath);
  const presentationRelationships = await parts.relationships(presentationPath);
  const slideIds = collectElements(presentation, 'sldId')
    .map((node) => attribute(node, 'r:id'))
    .filter((value): value is string => value !== null);
  if (slideIds.length > 1_000) {
    throw new Error('PPTX contains too many referenced slides');
  }

  const presentationRels = relationshipMap(presentationRelationships);
  const slidePaths: string[] = [];
  for (const id of slideIds) {
    const relationship = presentationRels.get(id);
    if (!relationship || !relationship.type.endsWith('/slide')) {
      warnings.push(`Referenced slide relationship ${id} is missing or invalid.`);
      continue;
    }
    const target = resolveRelationshipTarget(
      presentationPath,
      relationship,
      warnings,
    );
    if (target) slidePaths.push(target);
  }

  const counts = new Map<string, number>();
  for (const slidePath of slidePaths) {
    const slide = await parts.xml(slidePath);
    const slideRelationships = await parts.relationships(slidePath);
    const layoutPath = singleRelatedPart(
      slidePath,
      slideRelationships,
      '/slideLayout',
      warnings,
    );
    const layout = layoutPath && archive.file(layoutPath)
      ? await parts.xml(layoutPath)
      : null;
    const layoutRelationships = layoutPath && layout
      ? await parts.relationships(layoutPath)
      : [];
    const masterPath = layoutPath
      ? singleRelatedPart(
          layoutPath,
          layoutRelationships,
          '/slideMaster',
          warnings,
        )
      : null;
    const master = masterPath && archive.file(masterPath)
      ? await parts.xml(masterPath)
      : null;
    const masterRelationships = masterPath && master
      ? await parts.relationships(masterPath)
      : [];
    const themePath = masterPath
      ? singleRelatedPart(masterPath, masterRelationships, '/theme', warnings)
      : null;
    const theme = themePath && archive.file(themePath)
      ? await parts.xml(themePath)
      : null;
    const themeColors = theme ? themePalette(theme) : new Map<string, string>();
    const aliases = master ? colorAliases(master) : defaultColorAliases();

    // Theme definitions are mappings only: colors count when referenced by
    // actual slide/layout/master visual content, never merely because Office's
    // default theme lists them.
    countVisibleColorReferences(slide, themeColors, aliases, counts, true);
    if (layout) countVisibleColorReferences(layout, themeColors, aliases, counts, false);
    if (master) countVisibleColorReferences(master, themeColors, aliases, counts, false);
  }

  const colors = [...counts.entries()]
    .sort(([leftColor, leftCount], [rightColor, rightCount]) =>
      rightCount - leftCount || leftColor.localeCompare(rightColor))
    .slice(0, MAX_CANDIDATE_COLORS)
    .map(([color, count]) => ({ color, count }));
  if (colors.length === 0) {
    warnings.push('No visible RGB palette candidates were found in referenced style parts.');
  }
  if (counts.size > MAX_CANDIDATE_COLORS) {
    warnings.push(`Only the ${MAX_CANDIDATE_COLORS} most frequent palette candidates are shown.`);
  }
  warnings.push(CONFIRMATION_WARNING);
  return { colors, slideCount: slidePaths.length, warnings: unique(warnings) };
}

class ReferencedPartReader {
  private readonly xmlCache = new Map<string, Promise<unknown>>();
  private readonly relationshipCache = new Map<string, Promise<Relationship[]>>();
  private readonly referencedPaths = new Set<string>();

  constructor(
    private readonly archive: JSZip,
    private readonly warnings: string[],
  ) {}

  xml(path: string): Promise<unknown> {
    const cached = this.xmlCache.get(path);
    if (cached) return cached;
    this.track(path);
    const pending = readXml(this.archive, path);
    this.xmlCache.set(path, pending);
    return pending;
  }

  relationships(sourcePath: string): Promise<Relationship[]> {
    const path = relationshipPartPath(sourcePath);
    const cached = this.relationshipCache.get(path);
    if (cached) return cached;
    if (!this.archive.file(path)) return Promise.resolve([]);
    const pending = this.xml(path).then((document) =>
      parseRelationships(document, path, this.warnings));
    this.relationshipCache.set(path, pending);
    return pending;
  }

  private track(path: string): void {
    if (this.referencedPaths.has(path)) return;
    if (this.referencedPaths.size >= MAX_REFERENCED_PARTS) {
      throw new Error('PPTX contains too many referenced style parts');
    }
    this.referencedPaths.add(path);
  }
}

function validateArchiveMetadata(archive: JSZip): void {
  const entries = Object.values(archive.files) as InspectedZipObject[];
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new Error('PPTX ZIP contains too many entries');
  }
  let totalUncompressed = 0;
  for (const entry of entries) {
    const originalName = entry.unsafeOriginalName ?? entry.name;
    if (!safeArchivePath(originalName)) {
      throw new Error('PPTX ZIP contains an unsafe archive path');
    }
    if (/^(?:ppt\/)?vbaProject\.bin$/iu.test(entry.name)
      || /\/vbaProject\.bin$/iu.test(entry.name)) {
      throw new Error('Macro-enabled PPTX templates are not supported');
    }
    if (entry.dir) continue;
    const uncompressed = entry._data?.uncompressedSize;
    const compressed = entry._data?.compressedSize;
    if (!Number.isSafeInteger(uncompressed) || !Number.isSafeInteger(compressed)
      || (uncompressed as number) < 0 || (compressed as number) < 0) {
      throw new Error('PPTX ZIP entry size metadata is invalid');
    }
    totalUncompressed += uncompressed as number;
    if (!Number.isSafeInteger(totalUncompressed)
      || totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new Error('PPTX ZIP total uncompressed size is too large');
    }
    if (/\.xml(?:\.rels)?$/iu.test(entry.name)
      && (uncompressed as number) > MAX_XML_BYTES) {
      throw new Error('PPTX XML inflation size is too large');
    }
  }
}

async function readXml(archive: JSZip, path: string): Promise<unknown> {
  const entry = archive.file(path) as InspectedZipObject | null;
  if (!entry) throw new Error(`PPTX is missing referenced XML part: ${path}`);
  if ((entry._data?.uncompressedSize ?? MAX_XML_BYTES + 1) > MAX_XML_BYTES) {
    throw new Error('PPTX XML inflation size is too large');
  }
  const xml = await entry.async('string');
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/iu.test(xml)) {
    throw new Error('PPTX XML must not contain DOCTYPE or entity declarations');
  }
  const validation = XMLValidator.validate(xml);
  if (validation !== true) throw new Error(`PPTX contains malformed XML: ${path}`);
  return xmlParser.parse(xml) as unknown;
}

function parseRelationships(
  document: unknown,
  path: string,
  warnings: string[],
): Relationship[] {
  const relationships: Relationship[] = [];
  for (const item of collectElements(document, 'Relationship')) {
    const id = attribute(item, 'Id');
    const type = attribute(item, 'Type');
    const target = attribute(item, 'Target');
    if (!id || !type || !target) {
      warnings.push(`Malformed relationship ignored in ${path}.`);
      continue;
    }
    const external = attribute(item, 'TargetMode')?.toLowerCase() === 'external';
    if (external) warnings.push(`External relationship ignored in ${path}.`);
    relationships.push({ id, type, target, external });
  }
  return relationships;
}

function singleRelatedPart(
  sourcePath: string,
  relationships: Relationship[],
  typeSuffix: string,
  warnings: string[],
): string | null {
  const matches = relationships.filter(({ type }) => type.endsWith(typeSuffix));
  for (const relationship of matches) {
    const target = resolveRelationshipTarget(sourcePath, relationship, warnings);
    if (target) return target;
  }
  return null;
}

function resolveRelationshipTarget(
  sourcePath: string,
  relationship: Relationship,
  warnings: string[],
): string | null {
  if (relationship.external) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(relationship.target);
  } catch {
    throw new Error('PPTX relationship contains an invalid target encoding');
  }
  if (decoded.includes('\\') || decoded.startsWith('/')
    || decoded.includes('?') || decoded.includes('#')
    || /^[a-z][a-z0-9+.-]*:/iu.test(decoded)) {
    warnings.push(`Unsafe relationship target ignored from ${sourcePath}.`);
    return null;
  }
  const parts = sourcePath.split('/');
  parts.pop();
  for (const segment of decoded.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) throw new Error('PPTX relationship target escapes the archive');
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  const result = parts.join('/');
  if (!safeArchivePath(result)) throw new Error('PPTX relationship target is unsafe');
  return result;
}

function relationshipPartPath(sourcePath: string): string {
  const parts = sourcePath.split('/');
  const file = parts.pop();
  return [...parts, '_rels', `${file}.rels`].join('/');
}

function relationshipMap(relationships: Relationship[]): Map<string, Relationship> {
  const result = new Map<string, Relationship>();
  for (const relationship of relationships) {
    if (result.has(relationship.id)) {
      throw new Error('PPTX contains duplicate relationship IDs');
    }
    result.set(relationship.id, relationship);
  }
  return result;
}

function themePalette(theme: unknown): Map<string, string> {
  const scheme = collectElements(theme, 'clrScheme')[0];
  const result = new Map<string, string>();
  if (!scheme) return result;
  for (const [key, value] of Object.entries(scheme)) {
    if (key.startsWith('@_')) continue;
    const role = localName(key);
    const color = firstConcreteColor(value);
    if (color) result.set(role, color);
  }
  return result;
}

function colorAliases(master: unknown): Map<string, string> {
  const aliases = defaultColorAliases();
  const map = collectElements(master, 'clrMap')[0];
  if (!map) return aliases;
  for (const role of ['bg1', 'tx1', 'bg2', 'tx2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink']) {
    const value = attribute(map, role);
    if (value) aliases.set(role, value);
  }
  return aliases;
}

function defaultColorAliases(): Map<string, string> {
  return new Map([
    ['bg1', 'lt1'],
    ['tx1', 'dk1'],
    ['bg2', 'lt2'],
    ['tx2', 'dk2'],
  ]);
}

function countVisibleColorReferences(
  document: unknown,
  themeColors: Map<string, string>,
  aliases: Map<string, string>,
  counts: Map<string, number>,
  includePlaceholderShapes: boolean,
): void {
  for (const canvas of collectElements(document, 'cSld')) {
    walkVisibleColors(canvas, [], includePlaceholderShapes, (name, value) => {
      countColorNode(name, value, themeColors, aliases, counts);
    });
    countActiveStyleReferences(
      canvas,
      themeColors,
      aliases,
      counts,
      includePlaceholderShapes,
    );
  }
}

function countActiveStyleReferences(
  canvas: Record<string, unknown>,
  themeColors: Map<string, string>,
  aliases: Map<string, string>,
  counts: Map<string, number>,
  includePlaceholderShapes: boolean,
): void {
  for (const backgroundReference of collectElements(canvas, 'bgRef')) {
    countReferenceColors(backgroundReference, themeColors, aliases, counts);
  }
  // Layout/master placeholder and shape style references are inheritance
  // defaults. Count their concrete cSld formatting above, but let the actual
  // slide decide whether a shape-level style reference is active.
  if (!includePlaceholderShapes) return;
  for (const shapeName of ['sp', 'cxnSp', 'graphicFrame']) {
    for (const shape of collectElements(canvas, shapeName)) {
      if (!includePlaceholderShapes && collectElements(shape, 'ph').length > 0) {
        continue;
      }
      const properties = directElement(shape, 'spPr');
      const style = directElement(shape, 'style');
      if (!style) continue;
      if (!hasDirectElement(properties, [
        'noFill',
        'solidFill',
        'gradFill',
        'blipFill',
        'pattFill',
        'grpFill',
      ])) {
        for (const reference of directElements(style, 'fillRef')) {
          countReferenceColors(reference, themeColors, aliases, counts);
        }
      }
      if (!hasDirectElement(properties, ['ln'])) {
        for (const reference of directElements(style, 'lnRef')) {
          countReferenceColors(reference, themeColors, aliases, counts);
        }
      }
      if (!hasDirectElement(properties, ['effectLst', 'effectDag'])) {
        for (const reference of directElements(style, 'effectRef')) {
          countReferenceColors(reference, themeColors, aliases, counts);
        }
      }
    }
  }
}

function countReferenceColors(
  reference: Record<string, unknown>,
  themeColors: Map<string, string>,
  aliases: Map<string, string>,
  counts: Map<string, number>,
): void {
  const index = Number(attribute(reference, 'idx'));
  if (!Number.isFinite(index) || index <= 0) return;
  walk(reference, (name, value) => {
    if (name === 'srgbClr' || name === 'sysClr' || name === 'schemeClr') {
      countColorNode(name, value, themeColors, aliases, counts);
    }
  });
}

function countColorNode(
  name: string,
  value: unknown,
  themeColors: Map<string, string>,
  aliases: Map<string, string>,
  counts: Map<string, number>,
): void {
  let color: string | null = null;
  if (name === 'srgbClr') color = rgb(attribute(value, 'val'));
  else if (name === 'sysClr') color = rgb(attribute(value, 'lastClr'));
  else if (name === 'schemeClr') {
    const role = attribute(value, 'val');
    if (role && role !== 'phClr') {
      color = themeColors.get(aliases.get(role) ?? role) ?? null;
    }
  }
  if (color) counts.set(color, (counts.get(color) ?? 0) + 1);
}

function walkVisibleColors(
  value: unknown,
  ancestors: readonly string[],
  includePlaceholderShapes: boolean,
  visit: (localElementName: string, value: unknown) => void,
): void {
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith('@_')) continue;
    const name = localName(key);
    const children = Array.isArray(child) ? child : [child];
    for (const item of children) {
      if (!includePlaceholderShapes
        && ['sp', 'cxnSp', 'graphicFrame'].includes(name)
        && collectElements(item, 'ph').length > 0) {
        continue;
      }
      const nextAncestors = [...ancestors, name];
      if (isConcreteVisibleColor(name, ancestors)) visit(name, item);
      walkVisibleColors(item, nextAncestors, includePlaceholderShapes, visit);
    }
  }
}

function isConcreteVisibleColor(name: string, ancestors: readonly string[]): boolean {
  if (name !== 'srgbClr' && name !== 'sysClr' && name !== 'schemeClr') return false;
  if (ancestors.some((ancestor) =>
    ['style', 'fillRef', 'lnRef', 'effectRef', 'fontRef'].includes(ancestor))) {
    return false;
  }
  return ancestors.some((ancestor) => [
    'solidFill',
    'gradFill',
    'ln',
    'duotone',
    'outerShdw',
    'innerShdw',
    'prstShdw',
    'glow',
  ].includes(ancestor));
}

function directElement(
  value: Record<string, unknown>,
  wanted: string,
): Record<string, unknown> | null {
  return directElements(value, wanted)[0] ?? null;
}

function directElements(
  value: Record<string, unknown>,
  wanted: string,
): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (localName(key) !== wanted) continue;
    const children = Array.isArray(child) ? child : [child];
    for (const item of children) if (isObject(item)) result.push(item);
  }
  return result;
}

function hasDirectElement(
  value: Record<string, unknown> | null,
  names: readonly string[],
): boolean {
  return value !== null && Object.keys(value).some((key) => names.includes(localName(key)));
}

function firstConcreteColor(value: unknown): string | null {
  let result: string | null = null;
  walk(value, (name, node) => {
    if (result) return;
    if (name === 'srgbClr') result = rgb(attribute(node, 'val'));
    else if (name === 'sysClr') result = rgb(attribute(node, 'lastClr'));
  });
  return result;
}

function collectElements(value: unknown, wanted: string): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  walk(value, (name, node) => {
    if (name === wanted && isObject(node)) result.push(node);
  });
  return result;
}

function walk(
  value: unknown,
  visit: (localElementName: string, value: unknown) => void,
): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith('@_')) continue;
    if (Array.isArray(child)) {
      for (const item of child) {
        visit(localName(key), item);
        walk(item, visit);
      }
    } else {
      visit(localName(key), child);
      walk(child, visit);
    }
  }
}

function attribute(value: unknown, name: string): string | null {
  if (!isObject(value)) return null;
  const candidate = value[`@_${name}`];
  return typeof candidate === 'string' ? candidate : null;
}

function localName(name: string): string {
  return name.slice(name.lastIndexOf(':') + 1);
}

function rgb(value: string | null): string | null {
  return value && /^[0-9a-f]{6}$/iu.test(value) ? `#${value.toUpperCase()}` : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeArchivePath(path: string): boolean {
  return path.length > 0 && !path.startsWith('/') && !path.includes('\\')
    && !path.split('/').some((segment) => segment === '..' || segment === '.');
}

function assertBoundedBase64(value: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) {
    throw new Error('Template PPTX contentsBase64 must be valid base64');
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const decodedBytes = (value.length / 4) * 3 - padding;
  if (decodedBytes > MAX_PPTX_BYTES) throw new Error('Template PPTX exceeds the 50 MiB limit');
  for (let index = 0; index < value.length - padding; index += 1) {
    const code = value.charCodeAt(index);
    const alphaNumeric = (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57);
    if (!alphaNumeric && code !== 43 && code !== 47) {
      throw new Error('Template PPTX contentsBase64 must be valid base64');
    }
  }
  for (let index = value.length - padding; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) {
      throw new Error('Template PPTX contentsBase64 must be valid base64');
    }
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

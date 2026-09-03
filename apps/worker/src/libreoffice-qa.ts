import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, delimiter, extname, isAbsolute, join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { PNG } from 'pngjs';
import JSZip from 'jszip';
import {
  writeArtifactOrAdoptExact,
  type WorkspaceArtifactAccess,
} from './workspace-artifacts.js';

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export interface CommandRunOptions {
  timeoutMs: number;
  maxOutputBytes: number;
  env?: Readonly<Record<string, string>>;
}

export interface CommandRunner {
  canExecute(command: string): Promise<boolean>;
  run(
    command: string,
    args: readonly string[],
    options: CommandRunOptions,
  ): Promise<CommandResult>;
}

export class LocalCommandRunner implements CommandRunner {
  async canExecute(command: string): Promise<boolean> {
    const candidates = isAbsolute(command)
      ? [command]
      : (process.env.PATH ?? '')
          .split(delimiter)
          .filter(Boolean)
          .map((directory) => join(directory, command));
    for (const candidate of candidates) {
      try {
        await access(candidate, constants.X_OK);
        return true;
      } catch {
        // Continue to the next configured PATH entry.
      }
    }
    return false;
  }

  run(
    command: string,
    args: readonly string[],
    options: CommandRunOptions,
  ): Promise<CommandResult> {
    return new Promise((resolve) => {
      const useProcessGroup = process.platform !== 'win32';
      const child = spawn(command, [...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...options.env },
        detached: useProcessGroup,
      });
      const byteLimit = Math.max(0, Math.floor(options.maxOutputBytes));
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let settled = false;
      let timedOut = false;
      let killTimer: NodeJS.Timeout | undefined;
      let settleTimer: NodeJS.Timeout | undefined;
      let timeoutKillIssued = false;
      let pendingTimeoutResult:
        | Pick<CommandResult, 'exitCode' | 'timedOut'>
        | undefined;
      const appendBounded = (
        current: Buffer<ArrayBufferLike>,
        chunk: Buffer<ArrayBufferLike>,
      ): Buffer<ArrayBufferLike> => {
        const combined = Buffer.concat([current, chunk]);
        return combined.byteLength <= byteLimit
          ? combined
          : combined.subarray(combined.byteLength - byteLimit);
      };
      const decode = (value: Buffer<ArrayBufferLike>): string => {
        let decoded = value.toString('utf8');
        while (Buffer.byteLength(decoded) > byteLimit)
          decoded = decoded.slice(1);
        return decoded;
      };
      child.stdout.on('data', (chunk: Buffer<ArrayBufferLike>) => {
        stdout = appendBounded(stdout, chunk);
      });
      child.stderr.on('data', (chunk: Buffer<ArrayBufferLike>) => {
        stderr = appendBounded(stderr, chunk);
      });
      const terminate = (signal: NodeJS.Signals): void => {
        try {
          if (useProcessGroup && child.pid) {
            process.kill(-child.pid, signal);
            return;
          }
          child.kill(signal);
        } catch {
          try {
            child.kill(signal);
          } catch {
            // The root child may already have closed while its process group remains.
          }
        }
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        terminate('SIGTERM');
        killTimer = setTimeout(() => {
          timeoutKillIssued = true;
          terminate('SIGKILL');
          if (pendingTimeoutResult) finish(pendingTimeoutResult);
        }, 200);
        killTimer.unref();
        settleTimer = setTimeout(() => {
          if (settled) return;
          child.stdout.destroy();
          child.stderr.destroy();
          finish({ exitCode: 124, timedOut: true });
        }, 350);
        settleTimer.unref();
      }, options.timeoutMs);
      timeout.unref();
      const finish = (
        result: Pick<CommandResult, 'exitCode' | 'timedOut'>,
      ): void => {
        if (settled) return;
        if (timedOut && useProcessGroup && !timeoutKillIssued) {
          pendingTimeoutResult = result;
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        if (settleTimer) clearTimeout(settleTimer);
        resolve({ ...result, stdout: decode(stdout), stderr: decode(stderr) });
      };
      child.on('error', (error) => {
        stderr = appendBounded(stderr, Buffer.from(error.message));
        finish({
          exitCode: 127,
          timedOut,
        });
      });
      child.on('close', (code) => {
        finish({ exitCode: timedOut ? 124 : (code ?? 1), timedOut });
      });
    });
  }
}

export interface RenderedPageComparison {
  path: string;
  blank: boolean;
  differenceScore?: number;
  approvedVisualPath?: string;
}

export interface RenderedPageComparator {
  compare(
    pages: readonly { path: string; contents: Uint8Array }[],
    approvedVisuals?: readonly { path: string; contents: Uint8Array }[],
  ): Promise<readonly RenderedPageComparison[]>;
}

export class PngPixelPageComparator implements RenderedPageComparator {
  async compare(
    pages: readonly { path: string; contents: Uint8Array }[],
    approvedVisuals?: readonly { path: string; contents: Uint8Array }[],
  ) {
    if (approvedVisuals && approvedVisuals.length !== pages.length) {
      throw new Error('Approved visuals must map one-to-one to rendered pages');
    }
    return pages.map((page, index) => {
      const png = PNG.sync.read(Buffer.from(page.contents));
      let minimum = 255;
      let maximum = 0;
      let sum = 0;
      let samples = 0;
      for (let offset = 0; offset < png.data.length; offset += 4) {
        const alpha = png.data[offset + 3]! / 255;
        for (let channel = 0; channel < 3; channel += 1) {
          const composited = Math.round(
            png.data[offset + channel]! * alpha + 255 * (1 - alpha),
          );
          minimum = Math.min(minimum, composited);
          maximum = Math.max(maximum, composited);
          sum += composited;
          samples += 1;
        }
      }
      const mean = samples === 0 ? 255 : sum / samples;
      const approved = approvedVisuals?.[index];
      return {
        path: page.path,
        blank: mean >= 245 && maximum - minimum <= 16,
        ...(approved ? {
          approvedVisualPath: approved.path,
          differenceScore: pixelDifference(png, PNG.sync.read(Buffer.from(approved.contents))),
        } : {}),
      };
    });
  }
}

/** @deprecated Use PngPixelPageComparator. */
export class NonEmptyPageComparator extends PngPixelPageComparator {}

export interface LibreOfficeQaOptions {
  configuredSoffice?: string;
  bundledSoffice?: readonly string[];
  pdfRenderers?: readonly string[];
  commandTimeoutMs?: number;
  maxCommandOutputBytes?: number;
  maxVisualDifferenceScore?: number;
  ooxmlInspector?: (contents: Uint8Array) => Promise<PptxOoxmlInspection>;
}

export interface QaRunInput {
  projectId: string;
  pptxPath: string;
  expectedPageCount: number;
  round: number;
  exportSha256: string;
  specVersionId: string;
  visualVersionIds: Readonly<Record<string, string>>;
  approvedVisualPaths?: readonly string[];
}

export interface LibreOfficeQaReport {
  status: 'passed' | 'failed' | 'blocked';
  round: number;
  projectId: string;
  exportPath: string;
  exportSha256: string;
  specVersionId: string;
  visualVersionIds: Readonly<Record<string, string>>;
  sofficePath: string | null;
  rendererPath: string | null;
  pdfPath: string | null;
  renderedPages: readonly string[];
  expectedPageCount: number;
  actualPageCount: number;
  blankPages: readonly number[];
  comparisons: readonly RenderedPageComparison[];
  issues: readonly string[];
  fontChecks?: readonly { font: string; available: boolean }[];
  outOfBoundsObjects?: readonly string[];
  cropIssues?: readonly string[];
  missingResources?: readonly string[];
  jsonReportPath: string;
  textReportPath: string;
}

export interface QaRunner {
  run(input: QaRunInput): Promise<LibreOfficeQaReport>;
  reissueValidatedReport?(report: LibreOfficeQaReport): LibreOfficeQaReport;
}

const authenticQaReports = new WeakSet<LibreOfficeQaReport>();

export function isAuthenticQaReport(report: LibreOfficeQaReport): boolean {
  return authenticQaReports.has(report);
}

const defaultBundledSoffice = [
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  '/Applications/LibreOfficeDev.app/Contents/MacOS/soffice',
  'soffice',
];

export class LibreOfficeQa implements QaRunner {
  readonly #commands: CommandRunner;
  readonly #artifacts: WorkspaceArtifactAccess;
  readonly #comparator: RenderedPageComparator;
  readonly #options: LibreOfficeQaOptions;

  constructor(
    commands: CommandRunner,
    artifacts: WorkspaceArtifactAccess,
    comparator: RenderedPageComparator = new PngPixelPageComparator(),
    options: LibreOfficeQaOptions = {},
  ) {
    this.#commands = commands;
    this.#artifacts = artifacts;
    this.#comparator = comparator;
    this.#options = options;
  }

  readonly run = async (input: QaRunInput): Promise<LibreOfficeQaReport> => {
    try {
      return await this.#runChecked(input);
    } catch (error) {
      return this.#persist(
        input,
        await this.#report(input, {
          status: 'failed',
          issues: [
            `QA command or validation failed: ${error instanceof Error ? error.message : String(error)}`,
          ],
        }),
      );
    }
  };

  readonly reissueValidatedReport = (
    report: LibreOfficeQaReport,
  ): LibreOfficeQaReport => {
    const reissued = deepFreeze(structuredClone(report));
    authenticQaReports.add(reissued);
    return reissued;
  };

  async #runChecked(input: QaRunInput): Promise<LibreOfficeQaReport> {
    if (
      isAbsolute(input.pptxPath) ||
      input.pptxPath.includes('\\') ||
      input.pptxPath.split('/').some((part) => part === '.' || part === '..') ||
      !input.pptxPath.startsWith('exports/') ||
      !/\.pptx$/i.test(input.pptxPath)
    ) {
      return this.#persist(
        input,
        await this.#report(input, {
          issues: ['PPTX input must be inside project exports'],
        }),
      );
    }
    const pptxPath = await this.#artifacts.resolvePath(
      input.projectId,
      input.pptxPath,
    );
    const pptxBytes = await this.#artifacts.read(
      input.projectId,
      input.pptxPath,
    );
    const actualHash = createHash('sha256').update(pptxBytes).digest('hex');
    if (actualHash !== input.exportSha256) {
      return this.#persist(
        input,
        await this.#report(input, {
          status: 'failed',
          issues: ['PPTX input hash does not match validated export receipt'],
        }),
      );
    }
    const runDirectoryRelative = `qa/run-${input.round}`;
    const qaDirectory = await this.#artifacts.ensureDirectory(
      input.projectId,
      runDirectoryRelative,
    );
    const profileDirectory = await this.#artifacts.ensureDirectory(
      input.projectId,
      `${runDirectoryRelative}/profile`,
    );
    const tempDirectory = await this.#artifacts.ensureDirectory(
      input.projectId,
      `${runDirectoryRelative}/temp`,
    );
    const soffice = await this.#firstExecutable([
      this.#options.configuredSoffice,
      ...(this.#options.bundledSoffice ?? defaultBundledSoffice),
    ]);
    if (!soffice) {
      return this.#persist(
        input,
        await this.#report(input, {
          issues: ['LibreOffice soffice executable is unavailable'],
        }),
      );
    }
    const renderer = await this.#firstExecutable(
      this.#options.pdfRenderers ?? ['pdftoppm'],
    );
    if (!renderer) {
      return this.#persist(
        input,
        await this.#report(input, {
          sofficePath: soffice,
          issues: ['A PDF page renderer is unavailable'],
        }),
      );
    }
    const inspection = await (this.#options.ooxmlInspector ?? inspectPptxOoxml)(pptxBytes);
    const fontChecks = await Promise.all(
      inspection.fonts.map(async (font) => ({
        font,
        available: await isFontAvailable(font),
      })),
    );
    const structuralIssues = [
      ...(inspection.slideCount !== input.expectedPageCount
        ? [`OOXML slide count mismatch: expected ${input.expectedPageCount}, found ${inspection.slideCount}`]
        : []),
      ...inspection.missingResources.map((path) => `Missing OOXML resource: ${path}`),
      ...inspection.outOfBoundsObjects.map((id) => `Out-of-bounds slide object: ${id}`),
      ...inspection.cropIssues.map((id) => `Invalid image crop: ${id}`),
      ...fontChecks.filter(({ available }) => !available).map(({ font }) => `Unavailable font: ${font}`),
    ];
    const fontEnvironment =
      process.platform === 'darwin'
        ? await this.#macFontEnvironment(
            input.projectId,
            runDirectoryRelative,
          )
        : {};
    const commandOptions: CommandRunOptions = {
      timeoutMs: this.#options.commandTimeoutMs ?? 30_000,
      maxOutputBytes: this.#options.maxCommandOutputBytes ?? 64_000,
      env: { TMPDIR: tempDirectory, ...fontEnvironment },
    };
    const conversion = await this.#commands.run(
      soffice,
      [
        `-env:UserInstallation=${pathToFileURL(profileDirectory).href}`,
        '--headless',
        '--convert-to',
        'pdf',
        '--outdir',
        qaDirectory,
        pptxPath,
      ],
      commandOptions,
    );
    const stem = basename(pptxPath, extname(pptxPath));
    const pdfPath = join(qaDirectory, `${stem}.pdf`);
    if (conversion.exitCode !== 0 || conversion.timedOut) {
      return this.#persist(
        input,
        await this.#report(input, {
          sofficePath: soffice,
          rendererPath: renderer,
          pdfPath,
          status: 'failed',
          issues: [commandFailure('LibreOffice conversion', conversion)],
        }),
      );
    }
    const renderPrefix = join(qaDirectory, 'rendered');
    const rendering = await this.#commands.run(
      renderer,
      ['-png', '-r', '144', pdfPath, renderPrefix],
      commandOptions,
    );
    if (rendering.exitCode !== 0 || rendering.timedOut) {
      return this.#persist(
        input,
        await this.#report(input, {
          sofficePath: soffice,
          rendererPath: renderer,
          pdfPath,
          status: 'failed',
          issues: [commandFailure('PDF rendering', rendering)],
        }),
      );
    }
    const pageNames = (
      await this.#artifacts.list(input.projectId, runDirectoryRelative)
    )
      .filter((name) => /^rendered-\d+\.png$/.test(name))
      .sort(numericPageOrder);
    const pages = await Promise.all(
      pageNames.map(async (name) => ({
        path: await this.#artifacts.resolvePath(
          input.projectId,
          `${runDirectoryRelative}/${name}`,
        ),
        contents: await this.#artifacts.read(
          input.projectId,
          `${runDirectoryRelative}/${name}`,
        ),
      })),
    );
    const approvedVisuals = input.approvedVisualPaths
      ? await Promise.all(input.approvedVisualPaths.map(async (path) => ({
          path: await this.#artifacts.resolvePath(input.projectId, path),
          contents: await this.#artifacts.read(input.projectId, path),
        })))
      : undefined;
    const comparisons = await this.#comparator.compare(pages, approvedVisuals);
    if (comparisons.length !== pages.length) {
      throw new Error(
        'Rendered-page comparator must return one result per page',
      );
    }
    const blankPages = comparisons.flatMap((comparison, index) =>
      comparison.blank ? [index + 1] : [],
    );
    const issues = [
      ...structuralIssues,
      ...(pages.length !== input.expectedPageCount
        ? [
            `Page count mismatch: expected ${input.expectedPageCount}, rendered ${pages.length}`,
          ]
        : []),
      ...(blankPages.length > 0
        ? [`Blank rendered pages: ${blankPages.join(', ')}`]
        : []),
      ...comparisons.flatMap((comparison, index) =>
        comparison.differenceScore !== undefined &&
        comparison.differenceScore > (this.#options.maxVisualDifferenceScore ?? 0.6)
          ? [`Visual difference exceeds threshold on page ${index + 1}: ${comparison.differenceScore}`]
          : []),
    ];
    return this.#persist(
      input,
      await this.#report(input, {
        status: issues.length === 0 ? 'passed' : 'failed',
        sofficePath: soffice,
        rendererPath: renderer,
        pdfPath,
        renderedPages: pages.map(({ path }) => path),
        actualPageCount: pages.length,
        blankPages,
        comparisons,
        fontChecks,
        outOfBoundsObjects: inspection.outOfBoundsObjects,
        cropIssues: inspection.cropIssues,
        missingResources: inspection.missingResources,
        issues,
      }),
    );
  }

  async #firstExecutable(
    candidates: readonly (string | undefined)[],
  ): Promise<string | null> {
    for (const candidate of [
      ...new Set(candidates.filter((value): value is string => Boolean(value))),
    ]) {
      if (await this.#commands.canExecute(candidate)) return candidate;
    }
    return null;
  }

  async #macFontEnvironment(
    projectId: string,
    runDirectoryRelative: string,
  ): Promise<Readonly<Record<'FONTCONFIG_FILE', string>>> {
    const cache = await this.#artifacts.ensureDirectory(
      projectId,
      `${runDirectoryRelative}/font-cache`,
    );
    const relativePath = `${runDirectoryRelative}/fontconfig.xml`;
    const contents = [
      '<?xml version="1.0"?>',
      '<!DOCTYPE fontconfig SYSTEM "fonts.dtd">',
      '<fontconfig>',
      '  <dir>/System/Library/Fonts</dir>',
      '  <dir>/System/Library/Fonts/Supplemental</dir>',
      '  <dir>/Library/Fonts</dir>',
      `  <cachedir>${escapeXml(cache)}</cachedir>`,
      '</fontconfig>',
      '',
    ].join('\n');
    await writeArtifactOrAdoptExact(
      this.#artifacts,
      projectId,
      relativePath,
      contents,
    );
    return {
      FONTCONFIG_FILE: await this.#artifacts.resolvePath(
        projectId,
        relativePath,
      ),
    };
  }

  async #report(
    input: QaRunInput,
    values: Partial<LibreOfficeQaReport>,
  ): Promise<LibreOfficeQaReport> {
    return {
      status: 'blocked',
      round: input.round,
      projectId: input.projectId,
      exportPath: input.pptxPath,
      exportSha256: input.exportSha256,
      specVersionId: input.specVersionId,
      visualVersionIds: structuredClone(input.visualVersionIds),
      sofficePath: null,
      rendererPath: null,
      pdfPath: null,
      renderedPages: [],
      expectedPageCount: input.expectedPageCount,
      actualPageCount: 0,
      blankPages: [],
      comparisons: [],
      issues: [],
      jsonReportPath: await this.#artifacts.resolvePath(
        input.projectId,
        `qa/qa-round-${input.round}.json`,
      ),
      textReportPath: await this.#artifacts.resolvePath(
        input.projectId,
        `qa/qa-round-${input.round}.txt`,
      ),
      ...values,
    };
  }

  async #persist(
    input: QaRunInput,
    report: LibreOfficeQaReport,
  ): Promise<LibreOfficeQaReport> {
    const readableSummary = formatQaReadableSummary(report);
    const relativePath = `qa/qa-round-${input.round}.json`;
    const readablePath = `qa/qa-round-${input.round}.txt`;
    const serialized = JSON.stringify({ ...report, readableSummary }, null, 2);
    await writeArtifactOrAdoptExact(
      this.#artifacts,
      input.projectId,
      readablePath,
      `${readableSummary}\n`,
    );
    try {
      await this.#artifacts.write(input.projectId, relativePath, serialized);
    } catch (error) {
      const persisted = await this.#artifacts
        .read(input.projectId, relativePath)
        .catch(() => undefined);
      if (
        !persisted ||
        !Buffer.from(persisted).equals(Buffer.from(serialized, 'utf8'))
      ) {
        throw error;
      }
    }
    const frozen = deepFreeze(report);
    authenticQaReports.add(frozen);
    return frozen;
  }
}

function pixelDifference(rendered: PNG, approved: PNG): number {
  let difference = 0;
  let samples = 0;
  for (let y = 0; y < rendered.height; y += 1) {
    const approvedY = Math.min(approved.height - 1, Math.floor(y * approved.height / rendered.height));
    for (let x = 0; x < rendered.width; x += 1) {
      const approvedX = Math.min(approved.width - 1, Math.floor(x * approved.width / rendered.width));
      const renderedOffset = (y * rendered.width + x) * 4;
      const approvedOffset = (approvedY * approved.width + approvedX) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        difference += Math.abs(rendered.data[renderedOffset + channel]! - approved.data[approvedOffset + channel]!);
        samples += 1;
      }
    }
  }
  return samples === 0 ? 1 : Number((difference / (samples * 255)).toFixed(6));
}

export interface PptxOoxmlInspection {
  slideCount: number;
  fonts: readonly string[];
  missingResources: readonly string[];
  outOfBoundsObjects: readonly string[];
  cropIssues: readonly string[];
}

export async function inspectPptxOoxml(contents: Uint8Array): Promise<PptxOoxmlInspection> {
  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(contents);
  } catch {
    return {
      slideCount: 0,
      fonts: [],
      missingResources: ['invalid-or-unreadable-pptx-package'],
      outOfBoundsObjects: [],
      cropIssues: [],
    };
  }
  const slideNames = Object.keys(archive.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort(numericPageOrder);
  const presentation = await archive.file('ppt/presentation.xml')?.async('string') ?? '';
  const size = presentation.match(/<p:sldSz[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/);
  const slideWidth = Number(size?.[1] ?? 12_192_000);
  const slideHeight = Number(size?.[2] ?? 6_858_000);
  const fonts = new Set<string>();
  const outOfBoundsObjects: string[] = [];
  const cropIssues: string[] = [];
  for (const name of slideNames) {
    const xml = await archive.file(name)!.async('string');
    for (const match of xml.matchAll(/\btypeface="([^"]+)"/g)) {
      if (match[1] && !match[1].startsWith('+')) fonts.add(unescapeXml(match[1]));
    }
    let objectIndex = 0;
    for (const match of xml.matchAll(/<a:xfrm[^>]*>[\s\S]*?<a:off\s+x="(-?\d+)"\s+y="(-?\d+)"\s*\/>[\s\S]*?<a:ext\s+cx="(-?\d+)"\s+cy="(-?\d+)"\s*\/>[\s\S]*?<\/a:xfrm>/g)) {
      objectIndex += 1;
      const [x, y, width, height] = match.slice(1).map(Number);
      if (x! < 0 || y! < 0 || width! < 0 || height! < 0 || x! + width! > slideWidth || y! + height! > slideHeight) {
        outOfBoundsObjects.push(`${name}#${objectIndex}`);
      }
    }
    let cropIndex = 0;
    for (const match of xml.matchAll(/<a:srcRect\b([^>]*)\/>/g)) {
      cropIndex += 1;
      const values: Record<string, number> = Object.fromEntries(
        [...match[1]!.matchAll(/\b([ltrb])="(-?\d+)"/g)].map((item) => [item[1]!, Number(item[2])]),
      );
      const leftRight = (values.l ?? 0) + (values.r ?? 0);
      const topBottom = (values.t ?? 0) + (values.b ?? 0);
      if (Object.values(values).some((value) => value < 0 || value > 100_000) || leftRight >= 100_000 || topBottom >= 100_000) {
        cropIssues.push(`${name}#crop-${cropIndex}`);
      }
    }
  }

  const missingResources = new Set<string>();
  for (const relationshipName of Object.keys(archive.files).filter((name) => name.endsWith('.rels'))) {
    const xml = await archive.file(relationshipName)!.async('string');
    const marker = '/_rels/';
    const markerIndex = relationshipName.lastIndexOf(marker);
    const ownerDirectory = markerIndex >= 0
      ? relationshipName.slice(0, markerIndex)
      : relationshipName.startsWith('_rels/') ? '' : null;
    if (ownerDirectory === null) continue;
    for (const relationship of xml.matchAll(/<Relationship\b([^>]*)\/>/g)) {
      const attributes = relationship[1]!;
      if (/\bTargetMode="External"/.test(attributes)) continue;
      const target = attributes.match(/\bTarget="([^"]+)"/)?.[1];
      if (!target) continue;
      const resolved = target.startsWith('/')
        ? target.slice(1)
        : posix.normalize(posix.join(ownerDirectory, target));
      if (!archive.file(resolved)) missingResources.add(resolved);
    }
  }
  return {
    slideCount: slideNames.length,
    fonts: [...fonts].sort(),
    missingResources: [...missingResources].sort(),
    outOfBoundsObjects,
    cropIssues,
  };
}

async function isFontAvailable(font: string): Promise<boolean> {
  const normalized = font.toLowerCase();
  if (['arial', 'helvetica', 'times new roman', 'courier new'].includes(normalized)) return true;
  if (process.platform === 'darwin') {
    const fileNames: Record<string, string[]> = {
      'hiragino sans gb': ['Hiragino Sans GB.ttc'],
      'pingfang sc': ['PingFang.ttc'],
    };
    for (const fileName of fileNames[normalized] ?? []) {
      for (const directory of ['/System/Library/Fonts', '/System/Library/Fonts/Supplemental', '/Library/Fonts']) {
        try { await access(join(directory, fileName)); return true; } catch { /* continue */ }
      }
    }
  }
  return false;
}

function unescapeXml(value: string): string {
  return value.replaceAll('&quot;', '"').replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function commandFailure(label: string, result: CommandResult): string {
  if (result.timedOut) return `${label} timed out`;
  return `${label} failed: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`;
}

function numericPageOrder(left: string, right: string): number {
  const page = (value: string) =>
    Number(value.match(/(\d+)(?=\.[^.]+$)/)?.[1] ?? Number.MAX_SAFE_INTEGER);
  return page(left) - page(right);
}

export function formatQaReadableSummary(report: LibreOfficeQaReport): string {
  return [
    `LibreOffice QA round ${report.round}: ${report.status}`,
    `Export: ${report.exportPath} (${report.exportSha256})`,
    `Pages: ${report.actualPageCount}/${report.expectedPageCount}`,
    ...(report.blankPages.length > 0
      ? [`Blank rendered pages: ${report.blankPages.join(', ')}`]
      : []),
    ...report.comparisons.flatMap((comparison, index) =>
      comparison.differenceScore === undefined
        ? []
        : [`Page ${index + 1} visual difference: ${comparison.differenceScore} (${comparison.approvedVisualPath ?? 'no approved visual'})`]),
    ...(report.fontChecks?.map(({ font, available }) => `Font ${font}: ${available ? 'available' : 'missing'}`) ?? []),
    ...report.issues,
  ].join('\n');
}

export interface PptRepairer {
  repair(input: {
    projectId: string;
    pptxPath: string;
    round: number;
    qaReport: LibreOfficeQaReport;
  }): Promise<{ pptxPath: string; exportSha256: string }>;
}

export interface QaRepairOutcome {
  status: LibreOfficeQaReport['status'];
  pptxPath: string;
  repairRounds: number;
  reports: readonly LibreOfficeQaReport[];
}

export class QaRepairOrchestrator {
  constructor(
    private readonly qa: QaRunner,
    private readonly repairer: PptRepairer,
  ) {}

  async run(input: Omit<QaRunInput, 'round'>): Promise<QaRepairOutcome> {
    let pptxPath = input.pptxPath;
    let exportSha256 = input.exportSha256;
    const reports: LibreOfficeQaReport[] = [];
    let report = await this.qa.run({
      ...input,
      pptxPath,
      exportSha256,
      round: 1,
    });
    reports.push(report);
    let repairRounds = 0;
    while (report.status === 'failed' && repairRounds < 2) {
      repairRounds += 1;
      const repaired = await this.repairer.repair({
        projectId: input.projectId,
        pptxPath,
        round: repairRounds,
        qaReport: report,
      });
      pptxPath = repaired.pptxPath;
      exportSha256 = repaired.exportSha256;
      report = await this.qa.run({
        ...input,
        pptxPath,
        exportSha256,
        round: repairRounds + 1,
      });
      reports.push(report);
    }
    return { status: report.status, pptxPath, repairRounds, reports };
  }
}

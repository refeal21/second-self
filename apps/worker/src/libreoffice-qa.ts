import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, delimiter, extname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { PNG } from 'pngjs';
import type { WorkspaceArtifactAccess } from './workspace-artifacts.js';

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
      const child = spawn(command, [...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...options.env },
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;
      const appendBounded = (current: string, chunk: string): string =>
        `${current}${chunk}`.slice(-options.maxOutputBytes);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout = appendBounded(stdout, chunk);
      });
      child.stderr.on('data', (chunk: string) => {
        stderr = appendBounded(stderr, chunk);
      });
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!settled) child.kill('SIGKILL');
        }, 500).unref();
      }, options.timeoutMs);
      timeout.unref();
      const finish = (result: CommandResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      };
      child.on('error', (error) => {
        finish({
          exitCode: 127,
          stdout,
          stderr: appendBounded(stderr, error.message),
          timedOut,
        });
      });
      child.on('close', (code) => {
        finish({ exitCode: code ?? 1, stdout, stderr, timedOut });
      });
    });
  }
}

export interface RenderedPageComparison {
  path: string;
  blank: boolean;
  differenceScore?: number;
}

export interface RenderedPageComparator {
  compare(
    pages: readonly { path: string; contents: Uint8Array }[],
  ): Promise<readonly RenderedPageComparison[]>;
}

export class PngPixelPageComparator implements RenderedPageComparator {
  async compare(pages: readonly { path: string; contents: Uint8Array }[]) {
    return pages.map((page) => {
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
      return {
        path: page.path,
        blank: mean >= 245 && maximum - minimum <= 16,
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
}

export interface QaRunInput {
  projectId: string;
  pptxPath: string;
  expectedPageCount: number;
  round: number;
  exportSha256: string;
  specVersionId: string;
  visualVersionIds: Readonly<Record<string, string>>;
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
  jsonReportPath: string;
  textReportPath: string;
}

export interface QaRunner {
  run(input: QaRunInput): Promise<LibreOfficeQaReport>;
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
  constructor(
    private readonly commands: CommandRunner,
    private readonly artifacts: WorkspaceArtifactAccess,
    private readonly comparator: RenderedPageComparator = new PngPixelPageComparator(),
    private readonly options: LibreOfficeQaOptions = {},
  ) {}

  async run(input: QaRunInput): Promise<LibreOfficeQaReport> {
    try {
      return await this.runChecked(input);
    } catch (error) {
      return this.persist(
        input,
        await this.report(input, {
          status: 'failed',
          issues: [
            `QA command or validation failed: ${error instanceof Error ? error.message : String(error)}`,
          ],
        }),
      );
    }
  }

  private async runChecked(input: QaRunInput): Promise<LibreOfficeQaReport> {
    if (
      isAbsolute(input.pptxPath) ||
      input.pptxPath.includes('\\') ||
      input.pptxPath.split('/').some((part) => part === '.' || part === '..') ||
      !input.pptxPath.startsWith('exports/') ||
      !/\.pptx$/i.test(input.pptxPath)
    ) {
      return this.persist(
        input,
        await this.report(input, {
          issues: ['PPTX input must be inside project exports'],
        }),
      );
    }
    const pptxPath = await this.artifacts.resolvePath(
      input.projectId,
      input.pptxPath,
    );
    const pptxBytes = await this.artifacts.read(
      input.projectId,
      input.pptxPath,
    );
    const actualHash = createHash('sha256').update(pptxBytes).digest('hex');
    if (actualHash !== input.exportSha256) {
      return this.persist(
        input,
        await this.report(input, {
          status: 'failed',
          issues: ['PPTX input hash does not match validated export receipt'],
        }),
      );
    }
    const runDirectoryRelative = `qa/run-${input.round}`;
    const qaDirectory = await this.artifacts.ensureDirectory(
      input.projectId,
      runDirectoryRelative,
    );
    const profileDirectory = await this.artifacts.ensureDirectory(
      input.projectId,
      `${runDirectoryRelative}/profile`,
    );
    const tempDirectory = await this.artifacts.ensureDirectory(
      input.projectId,
      `${runDirectoryRelative}/temp`,
    );
    const soffice = await this.firstExecutable([
      this.options.configuredSoffice,
      ...(this.options.bundledSoffice ?? defaultBundledSoffice),
    ]);
    if (!soffice) {
      return this.persist(
        input,
        await this.report(input, {
          issues: ['LibreOffice soffice executable is unavailable'],
        }),
      );
    }
    const renderer = await this.firstExecutable(
      this.options.pdfRenderers ?? ['pdftoppm'],
    );
    if (!renderer) {
      return this.persist(
        input,
        await this.report(input, {
          sofficePath: soffice,
          issues: ['A PDF page renderer is unavailable'],
        }),
      );
    }
    const commandOptions: CommandRunOptions = {
      timeoutMs: this.options.commandTimeoutMs ?? 30_000,
      maxOutputBytes: this.options.maxCommandOutputBytes ?? 64_000,
      env: { TMPDIR: tempDirectory },
    };
    const conversion = await this.commands.run(
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
      return this.persist(
        input,
        await this.report(input, {
          sofficePath: soffice,
          rendererPath: renderer,
          pdfPath,
          status: 'failed',
          issues: [commandFailure('LibreOffice conversion', conversion)],
        }),
      );
    }
    const renderPrefix = join(qaDirectory, 'rendered');
    const rendering = await this.commands.run(
      renderer,
      ['-png', '-r', '144', pdfPath, renderPrefix],
      commandOptions,
    );
    if (rendering.exitCode !== 0 || rendering.timedOut) {
      return this.persist(
        input,
        await this.report(input, {
          sofficePath: soffice,
          rendererPath: renderer,
          pdfPath,
          status: 'failed',
          issues: [commandFailure('PDF rendering', rendering)],
        }),
      );
    }
    const pageNames = (
      await this.artifacts.list(input.projectId, runDirectoryRelative)
    )
      .filter((name) => /^rendered-\d+\.png$/.test(name))
      .sort(numericPageOrder);
    const pages = await Promise.all(
      pageNames.map(async (name) => ({
        path: await this.artifacts.resolvePath(
          input.projectId,
          `${runDirectoryRelative}/${name}`,
        ),
        contents: await this.artifacts.read(
          input.projectId,
          `${runDirectoryRelative}/${name}`,
        ),
      })),
    );
    const comparisons = await this.comparator.compare(pages);
    if (comparisons.length !== pages.length) {
      throw new Error(
        'Rendered-page comparator must return one result per page',
      );
    }
    const blankPages = comparisons.flatMap((comparison, index) =>
      comparison.blank ? [index + 1] : [],
    );
    const issues = [
      ...(pages.length !== input.expectedPageCount
        ? [
            `Page count mismatch: expected ${input.expectedPageCount}, rendered ${pages.length}`,
          ]
        : []),
      ...(blankPages.length > 0
        ? [`Blank rendered pages: ${blankPages.join(', ')}`]
        : []),
    ];
    return this.persist(
      input,
      await this.report(input, {
        status: issues.length === 0 ? 'passed' : 'failed',
        sofficePath: soffice,
        rendererPath: renderer,
        pdfPath,
        renderedPages: pages.map(({ path }) => path),
        actualPageCount: pages.length,
        blankPages,
        comparisons,
        issues,
      }),
    );
  }

  private async firstExecutable(
    candidates: readonly (string | undefined)[],
  ): Promise<string | null> {
    for (const candidate of [
      ...new Set(candidates.filter((value): value is string => Boolean(value))),
    ]) {
      if (await this.commands.canExecute(candidate)) return candidate;
    }
    return null;
  }

  private async report(
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
      jsonReportPath: await this.artifacts.resolvePath(
        input.projectId,
        `qa/qa-round-${input.round}.json`,
      ),
      textReportPath: await this.artifacts.resolvePath(
        input.projectId,
        `qa/qa-round-${input.round}.txt`,
      ),
      ...values,
    };
  }

  private async persist(
    input: QaRunInput,
    report: LibreOfficeQaReport,
  ): Promise<LibreOfficeQaReport> {
    await this.artifacts.write(
      input.projectId,
      `qa/qa-round-${input.round}.json`,
      JSON.stringify(report, null, 2),
    );
    await this.artifacts.write(
      input.projectId,
      `qa/qa-round-${input.round}.txt`,
      textReport(report),
    );
    const frozen = deepFreeze(report);
    authenticQaReports.add(frozen);
    return frozen;
  }
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
    Number(value.match(/(\d+)\.png$/)?.[1] ?? Number.MAX_SAFE_INTEGER);
  return page(left) - page(right);
}

function textReport(report: LibreOfficeQaReport): string {
  return [
    `LibreOffice QA round ${report.round}: ${report.status}`,
    `Export: ${report.exportPath} (${report.exportSha256})`,
    `Pages: ${report.actualPageCount}/${report.expectedPageCount}`,
    ...(report.blankPages.length > 0
      ? [`Blank rendered pages: ${report.blankPages.join(', ')}`]
      : []),
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

import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, delimiter, isAbsolute, join } from 'node:path';
import { spawn } from 'node:child_process';
import type { WorkspaceArtifactAccess } from './workspace-artifacts.js';

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  canExecute(command: string): Promise<boolean>;
  run(command: string, args: readonly string[]): Promise<CommandResult>;
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

  run(command: string, args: readonly string[]): Promise<CommandResult> {
    return new Promise((resolve) => {
      const child = spawn(command, [...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        resolve({ exitCode: 127, stdout, stderr: `${stderr}${error.message}` });
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        resolve({ exitCode: code ?? 1, stdout, stderr });
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

export class NonEmptyPageComparator implements RenderedPageComparator {
  async compare(pages: readonly { path: string; contents: Uint8Array }[]) {
    return pages.map((page) => ({
      path: page.path,
      blank: page.contents.byteLength === 0,
    }));
  }
}

export interface LibreOfficeQaOptions {
  configuredSoffice?: string;
  bundledSoffice?: readonly string[];
  pdfRenderers?: readonly string[];
}

export interface QaRunInput {
  projectId: string;
  pptxPath: string;
  expectedPageCount: number;
  round: number;
}

export interface LibreOfficeQaReport {
  status: 'passed' | 'failed' | 'blocked';
  round: number;
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

const defaultBundledSoffice = [
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  '/Applications/LibreOfficeDev.app/Contents/MacOS/soffice',
  'soffice',
];

export class LibreOfficeQa implements QaRunner {
  constructor(
    private readonly commands: CommandRunner,
    private readonly artifacts: WorkspaceArtifactAccess,
    private readonly comparator: RenderedPageComparator = new NonEmptyPageComparator(),
    private readonly options: LibreOfficeQaOptions = {},
  ) {}

  async run(input: QaRunInput): Promise<LibreOfficeQaReport> {
    const soffice = await this.firstExecutable([
      this.options.configuredSoffice,
      ...(this.options.bundledSoffice ?? defaultBundledSoffice),
    ]);
    if (!soffice) {
      return this.persist(
        input,
        this.report(input, {
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
        this.report(input, {
          sofficePath: soffice,
          issues: ['A PDF page renderer is unavailable'],
        }),
      );
    }

    const qaDirectory = this.artifacts.resolvePath(input.projectId, 'qa');
    const conversion = await this.commands.run(soffice, [
      '--headless',
      '--convert-to',
      'pdf',
      '--outdir',
      qaDirectory,
      input.pptxPath,
    ]);
    const pdfPath = join(
      qaDirectory,
      `${basename(input.pptxPath, '.pptx')}.pdf`,
    );
    if (conversion.exitCode !== 0) {
      return this.persist(
        input,
        this.report(input, {
          sofficePath: soffice,
          rendererPath: renderer,
          pdfPath,
          status: 'failed',
          issues: [
            `LibreOffice conversion failed: ${conversion.stderr || conversion.stdout}`,
          ],
        }),
      );
    }

    const renderPrefix = join(qaDirectory, `rendered-round-${input.round}`);
    const rendering = await this.commands.run(renderer, [
      '-png',
      '-r',
      '144',
      pdfPath,
      renderPrefix,
    ]);
    if (rendering.exitCode !== 0) {
      return this.persist(
        input,
        this.report(input, {
          sofficePath: soffice,
          rendererPath: renderer,
          pdfPath,
          status: 'failed',
          issues: [
            `PDF rendering failed: ${rendering.stderr || rendering.stdout}`,
          ],
        }),
      );
    }

    const prefix = `rendered-round-${input.round}-`;
    const pageNames = (await this.artifacts.list(input.projectId, 'qa'))
      .filter((name) => name.startsWith(prefix) && name.endsWith('.png'))
      .sort(numericPageOrder);
    const pages = await Promise.all(
      pageNames.map(async (name) => ({
        path: this.artifacts.resolvePath(input.projectId, `qa/${name}`),
        contents: await this.artifacts.read(input.projectId, `qa/${name}`),
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
      this.report(input, {
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

  private report(
    input: QaRunInput,
    values: Partial<LibreOfficeQaReport>,
  ): LibreOfficeQaReport {
    return {
      status: 'blocked',
      round: input.round,
      sofficePath: null,
      rendererPath: null,
      pdfPath: null,
      renderedPages: [],
      expectedPageCount: input.expectedPageCount,
      actualPageCount: 0,
      blankPages: [],
      comparisons: [],
      issues: [],
      jsonReportPath: this.artifacts.resolvePath(
        input.projectId,
        `qa/qa-round-${input.round}.json`,
      ),
      textReportPath: this.artifacts.resolvePath(
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
    return report;
  }
}

function numericPageOrder(left: string, right: string): number {
  const page = (value: string) =>
    Number(value.match(/(\d+)\.png$/)?.[1] ?? Number.MAX_SAFE_INTEGER);
  return page(left) - page(right);
}

function textReport(report: LibreOfficeQaReport): string {
  return [
    `LibreOffice QA round ${report.round}: ${report.status}`,
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
  }): Promise<string>;
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
    const reports: LibreOfficeQaReport[] = [];
    let report = await this.qa.run({ ...input, pptxPath, round: 1 });
    reports.push(report);
    let repairRounds = 0;

    while (report.status === 'failed' && repairRounds < 2) {
      repairRounds += 1;
      pptxPath = await this.repairer.repair({
        projectId: input.projectId,
        pptxPath,
        round: repairRounds,
        qaReport: report,
      });
      report = await this.qa.run({
        ...input,
        pptxPath,
        round: repairRounds + 1,
      });
      reports.push(report);
    }

    return { status: report.status, pptxPath, repairRounds, reports };
  }
}

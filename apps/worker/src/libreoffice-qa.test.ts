import { describe, expect, it } from 'vitest';
import {
  LibreOfficeQa,
  QaRepairOrchestrator,
  type CommandResult,
  type CommandRunner,
  type LibreOfficeQaReport,
  type PptRepairer,
  type QaRunInput,
  type QaRunner,
  type RenderedPageComparator,
  type WorkspaceArtifactAccess,
} from './index.js';

class FakeCommandRunner implements CommandRunner {
  readonly commands: Array<{ command: string; args: readonly string[] }> = [];

  constructor(private readonly executable: readonly string[]) {}

  async canExecute(command: string): Promise<boolean> {
    return this.executable.includes(command);
  }

  async run(command: string, args: readonly string[]): Promise<CommandResult> {
    this.commands.push({ command, args: [...args] });
    return { exitCode: 0, stdout: '', stderr: '' };
  }
}

class MemoryArtifactAccess implements WorkspaceArtifactAccess {
  readonly writes = new Map<string, string | Uint8Array>();
  readonly files = new Map<string, Uint8Array>();

  async initializeProject(): Promise<void> {}

  resolvePath(projectId: string, relativePath: string): string {
    return `/workspace/${projectId}/${relativePath}`;
  }

  async write(
    projectId: string,
    path: string,
    contents: string | Uint8Array,
  ): Promise<string> {
    this.writes.set(`${projectId}/${path}`, contents);
    return this.resolvePath(projectId, path);
  }

  async read(projectId: string, path: string): Promise<Uint8Array> {
    const value = this.files.get(`${projectId}/${path}`);
    if (!value) throw new Error(`Missing fixture: ${path}`);
    return value;
  }

  async list(projectId: string, directory: string): Promise<readonly string[]> {
    const prefix = `${projectId}/${directory}/`;
    return [...this.files.keys()]
      .filter((path) => path.startsWith(prefix))
      .map((path) => path.slice(prefix.length));
  }
}

class DeterministicComparator implements RenderedPageComparator {
  async compare(pages: readonly { path: string; contents: Uint8Array }[]) {
    return pages.map((page, index) => ({
      path: page.path,
      blank: index === 1,
      differenceScore: index * 0.25,
    }));
  }
}

describe('LibreOffice presentation QA', () => {
  it('detects bundled soffice, converts and renders headlessly, then writes JSON and text reports', async () => {
    const commands = new FakeCommandRunner([
      '/Applications/LibreOffice.app/Contents/MacOS/soffice',
      'pdftoppm',
    ]);
    const artifacts = new MemoryArtifactAccess();
    artifacts.files.set(
      'project-1/qa/rendered-round-1-1.png',
      new Uint8Array([1]),
    );
    artifacts.files.set(
      'project-1/qa/rendered-round-1-2.png',
      new Uint8Array([2]),
    );
    const qa = new LibreOfficeQa(
      commands,
      artifacts,
      new DeterministicComparator(),
      {
        configuredSoffice: '/configured/missing-soffice',
        bundledSoffice: [
          '/Applications/LibreOffice.app/Contents/MacOS/soffice',
        ],
        pdfRenderers: ['pdftoppm'],
      },
    );

    const report = await qa.run({
      projectId: 'project-1',
      pptxPath: '/workspace/project-1/exports/deck.pptx',
      expectedPageCount: 2,
      round: 1,
    });

    expect(commands.commands).toEqual([
      {
        command: '/Applications/LibreOffice.app/Contents/MacOS/soffice',
        args: [
          '--headless',
          '--convert-to',
          'pdf',
          '--outdir',
          '/workspace/project-1/qa',
          '/workspace/project-1/exports/deck.pptx',
        ],
      },
      {
        command: 'pdftoppm',
        args: [
          '-png',
          '-r',
          '144',
          '/workspace/project-1/qa/deck.pdf',
          '/workspace/project-1/qa/rendered-round-1',
        ],
      },
    ]);
    expect(report).toMatchObject({
      status: 'failed',
      sofficePath: '/Applications/LibreOffice.app/Contents/MacOS/soffice',
      rendererPath: 'pdftoppm',
      expectedPageCount: 2,
      actualPageCount: 2,
      blankPages: [2],
      comparisons: [{ differenceScore: 0 }, { differenceScore: 0.25 }],
    });
    expect(artifacts.writes.has('project-1/qa/qa-round-1.json')).toBe(true);
    expect(
      String(artifacts.writes.get('project-1/qa/qa-round-1.txt')),
    ).toContain('Blank rendered pages: 2');
  });

  it('returns a capability-unavailable report without attempting conversion when soffice is absent', async () => {
    const commands = new FakeCommandRunner(['pdftoppm']);
    const artifacts = new MemoryArtifactAccess();
    const qa = new LibreOfficeQa(
      commands,
      artifacts,
      new DeterministicComparator(),
      {
        configuredSoffice: '/configured/missing-soffice',
        bundledSoffice: ['/bundled/missing-soffice'],
        pdfRenderers: ['pdftoppm'],
      },
    );

    const report = await qa.run({
      projectId: 'project-1',
      pptxPath: '/workspace/project-1/exports/deck.pptx',
      expectedPageCount: 1,
      round: 1,
    });

    expect(report).toMatchObject({
      status: 'blocked',
      issues: ['LibreOffice soffice executable is unavailable'],
    });
    expect(commands.commands).toHaveLength(0);
    expect(artifacts.writes.has('project-1/qa/qa-round-1.json')).toBe(true);
  });
});

class AlwaysFailingQa implements QaRunner {
  readonly rounds: number[] = [];

  async run(input: QaRunInput): Promise<LibreOfficeQaReport> {
    this.rounds.push(input.round);
    return {
      status: 'failed',
      round: input.round,
      sofficePath: 'soffice',
      rendererPath: 'pdftoppm',
      pdfPath: `/qa/round-${input.round}.pdf`,
      renderedPages: [],
      expectedPageCount: input.expectedPageCount,
      actualPageCount: 0,
      blankPages: [],
      comparisons: [],
      issues: ['Page count mismatch'],
      jsonReportPath: `/qa/round-${input.round}.json`,
      textReportPath: `/qa/round-${input.round}.txt`,
    };
  }
}

class FakeRepairer implements PptRepairer {
  readonly rounds: number[] = [];

  async repair(input: { round: number }): Promise<string> {
    this.rounds.push(input.round);
    return `/workspace/project-1/exports/deck-repair-${input.round}.pptx`;
  }
}

describe('QA repair orchestration', () => {
  it('caps automated repair at two rounds even when QA keeps failing', async () => {
    const qa = new AlwaysFailingQa();
    const repairer = new FakeRepairer();
    const orchestrator = new QaRepairOrchestrator(qa, repairer);

    const outcome = await orchestrator.run({
      projectId: 'project-1',
      pptxPath: '/workspace/project-1/exports/deck.pptx',
      expectedPageCount: 2,
    });

    expect(outcome.status).toBe('failed');
    expect(repairer.rounds).toEqual([1, 2]);
    expect(qa.rounds).toEqual([1, 2, 3]);
    expect(outcome.repairRounds).toBe(2);
  });
});

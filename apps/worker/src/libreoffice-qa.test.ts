import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import {
  LibreOfficeQa,
  LocalCommandRunner,
  inspectPptxOoxml,
  PngPixelPageComparator,
  QaRepairOrchestrator,
  type CommandResult,
  type CommandRunner,
  type CommandRunOptions,
  type LibreOfficeQaReport,
  type PptRepairer,
  type QaRunInput,
  type QaRunner,
  type RenderedPageComparator,
  type WorkspaceArtifactAccess,
} from './index.js';

class FakeCommandRunner implements CommandRunner {
  readonly commands: Array<{
    command: string;
    args: readonly string[];
    options: CommandRunOptions;
  }> = [];

  constructor(private readonly executable: readonly string[]) {}

  async canExecute(command: string): Promise<boolean> {
    return this.executable.includes(command);
  }

  async run(
    command: string,
    args: readonly string[],
    options: CommandRunOptions,
  ): Promise<CommandResult> {
    this.commands.push({ command, args: [...args], options });
    return { exitCode: 0, stdout: '', stderr: '' };
  }
}

class MemoryArtifactAccess implements WorkspaceArtifactAccess {
  readonly writes = new Map<string, string | Uint8Array>();
  readonly files = new Map<string, Uint8Array>();

  async initializeProject(): Promise<void> {}

  async resolvePath(projectId: string, relativePath: string): Promise<string> {
    return `/workspace/${projectId}/${relativePath}`;
  }

  async projectDirectory(projectId: string): Promise<string> {
    return `/workspace/${projectId}`;
  }

  async ensureDirectory(
    projectId: string,
    relativePath: string,
  ): Promise<string> {
    return this.resolvePath(projectId, relativePath);
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

class CreateOnlyQaArtifacts extends MemoryArtifactAccess {
  override async write(
    projectId: string,
    path: string,
    contents: string | Uint8Array,
  ): Promise<string> {
    const key = `${projectId}/${path}`;
    if (this.writes.has(key)) throw new Error(`already exists: ${key}`);
    return super.write(projectId, path, contents);
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
  const exportBytes = new Uint8Array([80, 75, 3, 4]);
  const receipt = {
    exportSha256: createHash('sha256').update(exportBytes).digest('hex'),
    specVersionId: 'project-1-slide-specs-v1',
    visualVersionIds: { 'slide-1': 'project-1-visual-slide-1-v1' },
  } as const;

  it('decodes PNG pixels and flags white/near-uniform pages while retaining visible pages', async () => {
    const png = (pixels: readonly [number, number, number, number][]) => {
      const image = new PNG({ width: 2, height: 2 });
      pixels.forEach((pixel, index) => image.data.set(pixel, index * 4));
      return PNG.sync.write(image);
    };
    const white: [number, number, number, number] = [255, 255, 255, 255];
    const comparator = new PngPixelPageComparator();

    const results = await comparator.compare([
      { path: 'white.png', contents: png([white, white, white, white]) },
      {
        path: 'near.png',
        contents: png([
          [250, 250, 250, 255],
          [252, 252, 252, 255],
          [249, 249, 249, 255],
          [251, 251, 251, 255],
        ]),
      },
      {
        path: 'visible.png',
        contents: png([white, white, white, [10, 40, 180, 255]]),
      },
    ]);

    expect(results.map(({ blank }) => blank)).toEqual([true, true, false]);
  });

  it('compares each rendered page with its distinct approved full-slide PNG', async () => {
    const solid = (red: number, green: number, blue: number) => {
      const image = new PNG({ width: 2, height: 2 });
      for (let offset = 0; offset < image.data.length; offset += 4) image.data.set([red, green, blue, 255], offset);
      return PNG.sync.write(image);
    };
    const comparator = new PngPixelPageComparator();
    const results = await comparator.compare(
      [
        { path: 'rendered-1.png', contents: solid(20, 40, 60) },
        { path: 'rendered-2.png', contents: solid(200, 210, 220) },
      ],
      [
        { path: 'approved-cover.png', contents: solid(20, 40, 60) },
        { path: 'approved-summary.png', contents: solid(100, 110, 120) },
      ],
    );
    expect(results[0]).toMatchObject({ approvedVisualPath: 'approved-cover.png', differenceScore: 0 });
    expect(results[1]?.differenceScore).toBeGreaterThan(0.3);
  });

  it('detects missing OOXML resources, out-of-bounds objects and invalid crops', async () => {
    const archive = new JSZip();
    archive.file('ppt/presentation.xml', '<p:presentation><p:sldSz cx="1000" cy="500"/></p:presentation>');
    archive.file('ppt/slides/slide1.xml', [
      '<p:sld><p:sp><a:xfrm><a:off x="900" y="10"/><a:ext cx="200" cy="100"/></a:xfrm>',
      '<a:rPr typeface="Missing Board Font"/><a:t>可编辑标题</a:t><a:srcRect l="60000" r="50000"/></p:sp>',
      '<p:pic/><a:tbl/><c:chart/></p:sld>',
    ].join(''));
    archive.file('ppt/media/image1.png', new Uint8Array([1, 2, 3]));
    archive.file('ppt/slides/_rels/slide1.xml.rels', [
      '<Relationships><Relationship Id="rId1" Target="../media/missing.png"/>',
      '<Relationship Id="rId2" Target="../media/image1.png"/></Relationships>',
    ].join(''));

    const result = await inspectPptxOoxml(await archive.generateAsync({ type: 'uint8array' }));

    expect(result).toMatchObject({ slideCount: 1, fonts: ['Missing Board Font'] });
    expect(result.missingResources).toContain('ppt/media/missing.png');
    expect(result.outOfBoundsObjects).toEqual(['ppt/slides/slide1.xml#1']);
    expect(result.cropIssues).toEqual(['ppt/slides/slide1.xml#crop-1']);
    expect(result.mediaCount).toBe(1);
    expect(result.slideEvidence).toEqual([{
      imageCount: 1,
      textValues: ['可编辑标题'],
      tableCount: 1,
      chartCount: 1,
      shapeCount: 1,
    }]);
  });

  it('detects bundled soffice, converts and renders headlessly, then writes one atomic QA bundle', async () => {
    const commands = new FakeCommandRunner([
      '/Applications/LibreOffice.app/Contents/MacOS/soffice',
      'pdftoppm',
    ]);
    const artifacts = new MemoryArtifactAccess();
    artifacts.files.set('project-1/exports/deck.pptx', exportBytes);
    artifacts.files.set(
      'project-1/qa/run-1/rendered-1.png',
      new Uint8Array([1]),
    );
    artifacts.files.set(
      'project-1/qa/run-1/rendered-2.png',
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
      pptxPath: 'exports/deck.pptx',
      expectedPageCount: 2,
      round: 1,
      ...receipt,
    });

    expect(commands.commands[0]).toMatchObject({
      command: '/Applications/LibreOffice.app/Contents/MacOS/soffice',
      args: expect.arrayContaining([
        '-env:UserInstallation=file:///workspace/project-1/qa/run-1/profile',
        '--headless',
        '/workspace/project-1/exports/deck.pptx',
      ]),
      options: {
        timeoutMs: 30_000,
        maxOutputBytes: 64_000,
        env: {
          TMPDIR: '/workspace/project-1/qa/run-1/temp',
          FONTCONFIG_FILE: '/workspace/project-1/qa/run-1/fontconfig.xml',
        },
      },
    });
    expect(commands.commands[1]).toMatchObject({
      command: 'pdftoppm',
      args: expect.arrayContaining([
        '/workspace/project-1/qa/run-1/deck.pdf',
        '/workspace/project-1/qa/run-1/rendered',
      ]),
    });
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
      String(artifacts.writes.get('project-1/qa/run-1/fontconfig.xml')),
    ).toContain('/System/Library/Fonts/Supplemental');
    expect(artifacts.writes.has('project-1/qa/qa-round-1.txt')).toBe(true);
    expect(
      String(artifacts.writes.get('project-1/qa/qa-round-1.json')),
    ).toContain('Blank rendered pages: 2');
  });

  it('persists create-only QA output with one atomic report write when execution is unavailable', async () => {
    const artifacts = new CreateOnlyQaArtifacts();
    artifacts.files.set('project-1/exports/deck.pptx', exportBytes);
    const qa = new LibreOfficeQa(
      new FakeCommandRunner([]),
      artifacts,
      new DeterministicComparator(),
      { bundledSoffice: [], pdfRenderers: [] },
    );

    const report = await qa.run({
      projectId: 'project-1',
      pptxPath: 'exports/deck.pptx',
      expectedPageCount: 1,
      round: 1,
      ...receipt,
    });

    expect(report.status).toBe('blocked');
    expect([...artifacts.writes.keys()]).toEqual([
      'project-1/qa/qa-round-1.txt',
      'project-1/qa/qa-round-1.json',
    ]);
    expect(report.textReportPath).toBe('/workspace/project-1/qa/qa-round-1.txt');
  });

  it('returns a capability-unavailable report without attempting conversion when soffice is absent', async () => {
    const commands = new FakeCommandRunner(['pdftoppm']);
    const artifacts = new MemoryArtifactAccess();
    artifacts.files.set('project-1/exports/deck.pptx', exportBytes);
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
      pptxPath: 'exports/deck.pptx',
      expectedPageCount: 1,
      round: 1,
      ...receipt,
    });

    expect(report).toMatchObject({
      status: 'blocked',
      issues: ['LibreOffice soffice executable is unavailable'],
    });
    expect(commands.commands).toHaveLength(0);
    expect(artifacts.writes.has('project-1/qa/qa-round-1.json')).toBe(true);
  });

  it('rejects initial PPTX paths outside project exports and persists the failure', async () => {
    const commands = new FakeCommandRunner(['soffice', 'pdftoppm']);
    const artifacts = new MemoryArtifactAccess();
    const report = await new LibreOfficeQa(commands, artifacts).run({
      projectId: 'project-1',
      pptxPath: '/tmp/forged.pptx',
      expectedPageCount: 1,
      round: 1,
      ...receipt,
    });

    expect(report).toMatchObject({ status: 'blocked' });
    expect(report.issues.join(' ')).toContain('project exports');
    expect(commands.commands).toHaveLength(0);
    expect(artifacts.writes.has('project-1/qa/qa-round-1.json')).toBe(true);
  });

  it('turns command exceptions and timeouts into persisted failed reports', async () => {
    const artifacts = new MemoryArtifactAccess();
    artifacts.files.set('project-1/exports/deck.pptx', exportBytes);
    const throwing: CommandRunner = {
      canExecute: async () => true,
      run: async () => {
        throw new Error('spawn exploded');
      },
    };
    const thrown = await new LibreOfficeQa(throwing, artifacts).run({
      projectId: 'project-1',
      pptxPath: 'exports/deck.pptx',
      expectedPageCount: 1,
      round: 1,
      ...receipt,
    });
    expect(thrown).toMatchObject({ status: 'failed' });
    expect(thrown.issues.join(' ')).toContain('spawn exploded');

    const timedOut: CommandRunner = {
      canExecute: async () => true,
      run: async () => ({
        exitCode: 124,
        stdout: '',
        stderr: 'timed out',
        timedOut: true,
      }),
    };
    artifacts.files.set('project-2/exports/deck.pptx', exportBytes);
    const timeoutReport = await new LibreOfficeQa(timedOut, artifacts).run({
      projectId: 'project-2',
      pptxPath: 'exports/deck.pptx',
      expectedPageCount: 1,
      round: 1,
      ...receipt,
    });
    expect(timeoutReport).toMatchObject({ status: 'failed' });
    expect(timeoutReport.issues.join(' ')).toContain('timed out');
  });
});

describe('local command runner process boundaries', () => {
  it('caps multibyte stdout and stderr by bytes', async () => {
    const result = await new LocalCommandRunner().run(
      process.execPath,
      [
        '-e',
        'process.stdout.write("😀".repeat(20));process.stderr.write("界".repeat(20))',
      ],
      { timeoutMs: 2_000, maxOutputBytes: 8 },
    );

    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(8);
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(8);
  });

  it('settles promptly after timeout even when a descendant inherited output pipes', async () => {
    const started = Date.now();
    const result = await new LocalCommandRunner().run(
      process.execPath,
      [
        '-e',
        'require("node:child_process").spawn(process.execPath,["-e","setTimeout(()=>{},800)"],{stdio:["ignore","inherit","inherit"]});setInterval(()=>{},1000)',
      ],
      { timeoutMs: 50, maxOutputBytes: 1024 },
    );

    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('kills a TERM-ignoring detached-group descendant before resolving a timed-out root close', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qa-timeout-group-'));
    const pidPath = join(directory, 'descendant.pid');
    let descendantPid: number | undefined;
    try {
      const result = await new LocalCommandRunner().run(
        process.execPath,
        [
          '-e',
          [
            'const { spawn } = require("node:child_process");',
            'const { writeFileSync } = require("node:fs");',
            'const child = spawn(process.execPath, ["-e", "process.on(\'SIGTERM\', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });',
            'writeFileSync(process.env.DESCENDANT_PID_PATH, String(child.pid));',
            'process.on("SIGTERM", () => process.exit(0));',
            'setInterval(() => {}, 1000);',
          ].join(''),
        ],
        {
          timeoutMs: 100,
          maxOutputBytes: 1024,
          env: { DESCENDANT_PID_PATH: pidPath },
        },
      );
      descendantPid = Number(await readFile(pidPath, 'utf8'));

      expect(result.timedOut).toBe(true);
      expect(Number.isInteger(descendantPid)).toBe(true);
      const deadline = Date.now() + 500;
      let alive = true;
      while (alive && Date.now() < deadline) {
        try {
          process.kill(descendantPid, 0);
          await new Promise((resolve) => setTimeout(resolve, 10));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          alive = false;
        }
      }
      expect(alive).toBe(false);
    } finally {
      if (descendantPid) {
        try {
          process.kill(descendantPid, 'SIGKILL');
        } catch {
          // The expected path has already reaped the descendant.
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
});

class AlwaysFailingQa implements QaRunner {
  readonly rounds: number[] = [];

  async run(input: QaRunInput): Promise<LibreOfficeQaReport> {
    this.rounds.push(input.round);
    return {
      status: 'failed',
      round: input.round,
      projectId: input.projectId,
      exportPath: input.pptxPath,
      exportSha256: input.exportSha256,
      specVersionId: input.specVersionId,
      visualVersionIds: input.visualVersionIds,
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

  async repair(input: { round: number }) {
    this.rounds.push(input.round);
    return {
      pptxPath: `exports/deck-repair-${input.round}.pptx`,
      exportSha256: `${input.round}`.repeat(64),
    };
  }
}

describe('QA repair orchestration', () => {
  it('caps automated repair at two rounds even when QA keeps failing', async () => {
    const qa = new AlwaysFailingQa();
    const repairer = new FakeRepairer();
    const orchestrator = new QaRepairOrchestrator(qa, repairer);

    const outcome = await orchestrator.run({
      projectId: 'project-1',
      pptxPath: 'exports/deck.pptx',
      expectedPageCount: 2,
      exportSha256: 'a'.repeat(64),
      specVersionId: 'project-1-slide-specs-v1',
      visualVersionIds: { 'slide-1': 'project-1-visual-slide-1-v1' },
    });

    expect(outcome.status).toBe('failed');
    expect(repairer.rounds).toEqual([1, 2]);
    expect(qa.rounds).toEqual([1, 2, 3]);
    expect(outcome.repairRounds).toBe(2);
  });
});

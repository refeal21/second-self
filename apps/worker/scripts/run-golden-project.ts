import { rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGoldenProject } from '../src/golden-project.js';

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const workspaceRoot = join(repositoryRoot, 'artifacts', 'qa', 'golden-project');
await rm(workspaceRoot, { recursive: true, force: true });
const result = await runGoldenProject({
  fixtureRoot: join(repositoryRoot, 'fixtures', 'golden-project'),
  workspaceRoot,
});
process.stdout.write(
  `${JSON.stringify(
    {
      ...result,
      pptxPath: result.pptxPath.replace(`${repositoryRoot}/`, ''),
      sourceMapPath: result.sourceMapPath.replace(`${repositoryRoot}/`, ''),
      readableQaPath: result.readableQaPath.replace(`${repositoryRoot}/`, ''),
      approvedVisualPaths: result.approvedVisualPaths.map((path) =>
        path.replace(`${repositoryRoot}/`, ''),
      ),
    },
    null,
    2,
  )}\n`,
);

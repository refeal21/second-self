/** Offline cross-language fixture writer: real runtime actions, no provider. */
import { readFileSync } from 'node:fs';
import { NativePptRpcRuntime } from '../native-pipeline.js';
import { sourceAnalysis, scenarioOutline, scenarioDetails } from './fixtures.test-support.js';

const input = JSON.parse(readFileSync(0, 'utf8'));
const runtime = new NativePptRpcRuntime({ imageGenAvailable: false });
await runtime.restore(input.pipeline);
const projectId = input.pipeline.project.id;
const at = '2026-09-14T00:00:00.000Z';
const sourceId = input.pipeline.sources[0].id;
const contextResult = await runtime.execute(projectId, { kind: 'context.update', at,
  context: { taskBrief: 'Preserve the confirmed synthetic brief', sourceInstructions: { [sourceId]: 'Use confirmed observations only' }, outlineRequirements: 'One scenario page' } });
const replaceSource = <T>(v: T): T => JSON.parse(JSON.stringify(v).replaceAll('source-a', sourceId));
const outline = replaceSource(scenarioOutline());
const details = replaceSource(scenarioDetails());
const actions = [
  { kind: 'analysis.commit', at, requestId: 'analysis-copy', output: replaceSource(sourceAnalysis()) },
  { kind: 'outline.submit', at, outline: outline.outline },
  { kind: 'outline.approve', at },
  { kind: 'details.submit', at, specs: details.specs },
  { kind: 'details.approve', at },
  { kind: 'visual.replace', at, slideId: 'scenario-1', imageBase64: input.png1, altText: 'Synthetic first slide' },
  { kind: 'visual.approve', at, slideId: 'scenario-1' },
  { kind: 'visual.reopen', at, slideId: 'scenario-1' },
  { kind: 'visual.replace', at, slideId: 'scenario-1', imageBase64: input.png2, altText: 'Synthetic revised slide' },
  { kind: 'visual.approve', at, slideId: 'scenario-1' },
] as const;
const results = [];
for (const action of actions) results.push(await runtime.execute(projectId, action));
// A separate real v2 branch starts before details approval; it is never mixed
// with the visual approval history above or asserted to be a paired checkpoint.
const before = results[3]!.pipeline;
await runtime.restore(before);
const revised = structuredClone(outline.outline);
revised.slides[0]!.purpose = 'An explicitly revised synthetic purpose';
const pending = await runtime.execute(projectId, { kind: 'outline.revision.save', at,
  expectedRevision: before.revision, revisionId: 'copy-revision-v2',
  baseOutlineVersionId: before.outline!.version.id, outline: revised, specs: details.specs });
results.push(pending);
results.push(await runtime.execute(projectId, { kind: 'outline.revision.approve', at,
  expectedRevision: pending.pipeline.revision, revisionId: 'copy-revision-v2',
  baseOutlineVersionId: before.outline!.version.id }));
process.stdout.write(JSON.stringify({ contextResult, results, pair: { schemaVersion: 1, outline, details } }));

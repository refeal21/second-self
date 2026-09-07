import { describe, expect, it } from 'vitest';
import { createNativePipeline } from '../../worker/src/native-pipeline.js';
import { getPromptContext, promptContextError } from './ppt-prompts.js';

const pipeline = createNativePipeline({ id: 'project-prompts', name: '方案', goal: '说明价值', createdAt: 'now' });
pipeline.sources.push({ id: 'source-1', fileName: '参考.pptx', relativePath: 'sources/source-1.bin', mediaType: 'application/octet-stream', sha256: 'a'.repeat(64), byteLength: 10 });

describe('PPT instruction validation', () => {
  it('rejects oversized Chinese instructions by UTF-8 bytes and accepts the boundary', () => {
    const context = getPromptContext(pipeline);
    expect(promptContextError(pipeline, { ...context, taskBrief: '中'.repeat(6666) + 'ab' })).toBeNull();
    expect(promptContextError(pipeline, { ...context, taskBrief: '中'.repeat(6667) })).toBeTruthy();
    expect(promptContextError(pipeline, { ...context, outlineRequirements: 'x'.repeat(20001) })).toBeTruthy();
    expect(promptContextError(pipeline, { ...context, sourceInstructions: { 'source-1': '中'.repeat(3334) } })).toBeTruthy();
    expect(promptContextError(pipeline, { ...context, sourceInstructions: { 'source-1': 'x'.repeat(10000) } })).toBeNull();
  });
  it('rejects file instructions referring to sources that are not attached', () => {
    expect(promptContextError(pipeline, { ...getPromptContext(pipeline), sourceInstructions: { 'source-missing': '使用这个文件' } })).toBeTruthy();
  });
});

import { describe, expect, it } from 'vitest';
import {
  parseVisualGenerationRecord,
  parseVisualGenerationRequest,
  parseVisualStyleProfile,
  parseVisualStyleState,
  type VisualGenerationRecord,
  type VisualGenerationRequest,
  type VisualStyleProfile,
  type VisualStyleState,
} from './visual-style.js';

const templateSha = 'a'.repeat(64);
const profile: VisualStyleProfile = {
  primaryColor: '#7B2D26',
  backgroundColor: '#F7F0E8',
  textColor: '#201A17',
  accentColors: ['#D69E2E', '#4F6D5E'],
  instructions: '温暖、克制，使用细线分隔。',
  template: {
    fileName: '北投模板.pptx',
    sha256: templateSha,
    relativePath: `visuals/style-templates/${templateSha}.pptx`,
  },
};
const state: VisualStyleState = { revision: 2, profile, locked: false };
const request: VisualGenerationRequest = {
  id: 'visual-request-1',
  projectId: 'project-1',
  expectedRevision: 12,
  styleRevision: 2,
  slideId: 'slide-1',
  kind: 'imagegen',
  prompt: '完整页面提示',
  feedback: '缩小装饰元素',
  promptVersion: 'full-slide-v1',
};

describe('browser-safe visual style contracts', () => {
  it('accepts the frozen profile and state shape without changing values', () => {
    expect(parseVisualStyleProfile(profile)).toEqual(profile);
    expect(parseVisualStyleState(state)).toEqual(state);
  });

  it.each([
    ['role color without #RRGGBB', { ...profile, primaryColor: '7B2D26' }],
    ['role color with alpha', { ...profile, textColor: '#201A17FF' }],
    ['non-hex accent', { ...profile, accentColors: ['#GGGGGG'] }],
    ['more than eight accents', { ...profile, accentColors: Array(9).fill('#112233') }],
    ['more than 4000 instructions characters', { ...profile, instructions: '界'.repeat(4001) }],
    ['unknown profile field', { ...profile, automatic: true }],
    ['template path not derived from hash', { ...profile, template: { ...profile.template!, relativePath: 'sources/template.pptx' } }],
    ['template filename with a path', { ...profile, template: { ...profile.template!, fileName: '../template.pptx' } }],
  ])('rejects %s', (_label, value) => {
    expect(() => parseVisualStyleProfile(value)).toThrow(/visual style/i);
  });

  it('rejects malformed style state rather than applying defaults', () => {
    expect(() => parseVisualStyleState({ ...state, revision: -1 })).toThrow(/visual style/i);
    expect(() => parseVisualStyleState({ ...state, locked: 'no' })).toThrow(/visual style/i);
    expect(() => parseVisualStyleState({ ...state, extra: true })).toThrow(/visual style/i);
  });
});

describe('visual generation request and record contracts', () => {
  it('accepts bounded complete request and receipt records', () => {
    const record: VisualGenerationRecord = {
      ...request,
      createdAt: '2026-09-09T01:02:03.000Z',
      promptSha256: 'b'.repeat(64),
      specSha256: 'c'.repeat(64),
      style: state,
      receipt: {
        relativePath: 'visuals/slide-1-v1.png',
        sha256: 'd'.repeat(64),
        committedRevision: 13,
        createdAt: '2026-09-09T01:03:00.000Z',
        provider: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1' },
      },
    };

    expect(parseVisualGenerationRequest(request)).toEqual(request);
    expect(parseVisualGenerationRecord(record)).toEqual(record);
  });

  it('enforces confirmed request byte limits and exact fields', () => {
    expect(() => parseVisualGenerationRequest({ ...request, prompt: '界'.repeat(65_537) }))
      .toThrow(/visual generation request/i);
    expect(() => parseVisualGenerationRequest({ ...request, feedback: '界'.repeat(5_462) }))
      .toThrow(/visual generation request/i);
    expect(() => parseVisualGenerationRequest({ ...request, extra: true }))
      .toThrow(/visual generation request/i);
  });

  it('allows an empty prompt only for durable upload records', () => {
    expect(parseVisualGenerationRequest({
      ...request,
      kind: 'upload',
      prompt: '',
      feedback: '',
      promptVersion: 'upload-v1',
    })).toMatchObject({ kind: 'upload', prompt: '' });
    expect(() => parseVisualGenerationRequest({ ...request, prompt: '' }))
      .toThrow(/visual generation request prompt/i);
  });

  it('does not require or fabricate provider identifiers in a receipt', () => {
    const record = {
      ...request,
      createdAt: '2026-09-09T01:02:03.000Z',
      promptSha256: 'b'.repeat(64),
      specSha256: 'c'.repeat(64),
      style: state,
      receipt: {
        relativePath: 'visuals/slide-1-v1.png',
        sha256: 'd'.repeat(64),
        committedRevision: 13,
        createdAt: '2026-09-09T01:03:00.000Z',
        provider: {},
      },
    };

    expect(parseVisualGenerationRecord(record).receipt?.provider).toEqual({});
  });
});

import { describe, expect, it } from 'vitest';
import { resolveWorkspaceWritePath } from './paths.js';

describe('workspace write paths', () => {
  it('allows a nested artifact but rejects traversal outside the workspace', () => {
    expect(resolveWorkspaceWritePath('/workspace', '/workspace/projects/a/slide.png'))
      .toBe('/workspace/projects/a/slide.png');
    expect(() => resolveWorkspaceWritePath('/workspace', '/workspace/../secrets.txt'))
      .toThrow('outside the workspace');
  });

  it('resolves relative artifact paths from the workspace root', () => {
    expect(resolveWorkspaceWritePath('/workspace', 'projects/a/slide.png'))
      .toBe('/workspace/projects/a/slide.png');
  });
});

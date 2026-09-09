import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('workspace breakpoint contract', () => {
  it('keeps persistent native workflow notices in document flow, outside the preview', () => {
    const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
    const rule = css.match(/\.native-workspace > \.app-notice\s*\{([^}]+)\}/)?.[1];
    expect(rule).toBeDefined();
    expect(rule).toMatch(/position:\s*static/);
    expect(rule).toMatch(/flex-shrink:\s*0/);
    expect(rule).toMatch(/overflow-y:\s*auto/);
  });
  it('keeps 956px compact and starts the three-column layout at 957px', () => {
    const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
    expect(css).toContain('@media (max-width: 956px)');
    expect(css).toContain('@media (min-width: 957px)');
  });
});

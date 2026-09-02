import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('workspace breakpoint contract', () => {
  it('keeps 956px compact and starts the three-column layout at 957px', () => {
    const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
    expect(css).toContain('@media (max-width: 956px)');
    expect(css).toContain('@media (min-width: 957px)');
  });
});

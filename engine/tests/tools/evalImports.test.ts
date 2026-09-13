/** `modoki_eval`'s second-module-instance warning (#1155) — the pure half. The tool wiring (a
 *  warning block after the value, a "could not check" line on a failed lookup) is covered through
 *  the real registered tool in liveCoverage.test.ts. */

import { describe, it, expect } from 'vitest';
import { literalImportSpecs, secondInstanceWarning, MAX_CHECKED_IMPORTS } from '../../tools/modoki-mcp/src/evalImports';

describe('literalImportSpecs', () => {
  it('finds URL-shaped literal imports in all three quote styles', () => {
    const code = `const a = await import('/@fs/x/a.ts');
      const b = await import("/packages/b.ts?x=1");
      const c = await import(\`http://127.0.0.1:5177/c.ts\`);`;
    expect(literalImportSpecs(code)).toEqual(['/@fs/x/a.ts', '/packages/b.ts?x=1', 'http://127.0.0.1:5177/c.ts']);
  });

  it('skips a bare specifier, a protocol-relative URL, an interpolated template and a non-literal', () => {
    const code = "import('three'); import('//cdn/x.js'); import(`/packages/${name}.ts`); import(url); import ('/ok.ts')";
    expect(literalImportSpecs(code)).toEqual(['/ok.ts']);
  });

  it('does not count modoki.import(…) — the sanctioned route — or any other member call named import', () => {
    expect(literalImportSpecs("await modoki.import('/@fs/x/a.ts'); api.import('/b.ts'); reimport('/c.ts'); await import('/d.ts')"))
      .toEqual(['/d.ts']);
  });

  it('dedupes, and stops at the cap', () => {
    const many = Array.from({ length: MAX_CHECKED_IMPORTS + 3 }, (_, i) => `import('/m${i}.ts')`).join(';');
    expect(literalImportSpecs(`import('/a.ts'); import('/a.ts')`)).toEqual(['/a.ts']);
    expect(literalImportSpecs(many)).toHaveLength(MAX_CHECKED_IMPORTS);
  });
});

describe('secondInstanceWarning', () => {
  const answer = { url: '/packages/a.ts', file: '/repo/engine/packages/a.ts', inGraph: true };

  it('says nothing for the canonical URL, with or without the page origin', () => {
    expect(secondInstanceWarning('/packages/a.ts', answer)).toBeNull();
    expect(secondInstanceWarning('http://127.0.0.1:5177/packages/a.ts', answer)).toBeNull();
  });

  it('warns for a different spelling, naming the canonical URL and the sanctioned route', () => {
    const w = secondInstanceWarning('/@fs/repo/engine/packages/a.ts', answer);
    expect(w).toMatch(/SECOND instance/);
    expect(w).toContain("'/packages/a.ts'");
    expect(w).toContain("modoki.import('/@fs/repo/engine/packages/a.ts')");
  });

  it('warns for a stale spelling of a hot-updated module (the ?t= is part of the identity)', () => {
    expect(secondInstanceWarning('/packages/a.ts', { ...answer, url: '/packages/a.ts?t=99' })).toMatch(/SECOND instance/);
  });

  it('percent-escapes compare decoded, as the module map does — `%20` is not a second instance', () => {
    const spaced = { url: '/@fs/C:/Users/John Doe/x.ts', file: 'C:/Users/John Doe/x.ts', inGraph: true };
    expect(secondInstanceWarning('/@fs/C:/Users/John%20Doe/x.ts', spaced)).toBeNull();
  });

  it('says nothing when the app never loaded the file — no instance for a copy to disagree with', () => {
    expect(secondInstanceWarning('/@fs/repo/engine/packages/a.ts', { ...answer, inGraph: false })).toBeNull();
  });
});

/** msdfWorkerAssetStrip (#1356) — @zappar/msdf-generator's `new URL("./worker.js", import.meta.url)`
 *  fallback makes the bundler emit the RAW worker, whose bare `comlink` import cannot start in a
 *  browser. The plugin turns the fallback into a throw, and refuses a shape it does not recognise
 *  rather than silently letting the emission back in. */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { isMsdfGeneratorEntryId, stripMsdfWorkerAssetUrl } from '../../plugins/msdfWorkerAssetStrip';

// Resolved by path, not require.resolve: the package's exports map only offers `import`.
const ENTRY = path.resolve(__dirname, '../../../node_modules/@zappar/msdf-generator/dist/index.js');

describe('msdfWorkerAssetStrip', () => {
  it('rewrites the worker fallback in the INSTALLED msdf-generator', () => {
    const out = stripMsdfWorkerAssetUrl(fs.readFileSync(ENTRY, 'utf8'));
    // Unlike the ktx2 twin, a null here is a failure: the installed lib is known to carry the
    // fallback, so "nothing to rewrite" would mean the pattern stopped matching it.
    expect(out).not.toBeNull();
    expect(out).not.toContain('import.meta.url');
    expect(out).toContain('this.workerUrl = config.workerUrl || (() => { throw new Error(');
  });

  it('turns the fallback into a throw that names the fix', () => {
    const out = stripMsdfWorkerAssetUrl('const u = c.workerUrl || new URL( \'./worker.js\', import.meta.url ).href;');
    expect(out).not.toBeNull();
    const fallback = out!.replace(/^const u = c\.workerUrl \|\| /, '').replace(/;$/, '');
    expect(() => new Function(`return ${fallback}`)()).toThrow(/no workerUrl was given.*#1356/);
  });

  it('refuses a source whose import.meta.url survives the rewrite', () => {
    const changed = 'this.workerUrl = config.workerUrl || new URL("./worker.mjs", import.meta.url).href;';
    expect(() => stripMsdfWorkerAssetUrl(changed)).toThrow(/still references `import.meta.url`/);
  });

  it('leaves a source with nothing to rewrite alone', () => {
    expect(stripMsdfWorkerAssetUrl('export class MSDF {}')).toBeNull();
  });

  it('matches only the msdf-generator entry module id', () => {
    expect(isMsdfGeneratorEntryId('/r/node_modules/@zappar/msdf-generator/dist/index.js')).toBe(true);
    expect(isMsdfGeneratorEntryId('C:\\r\\node_modules\\@zappar\\msdf-generator\\dist\\index.js?v=1')).toBe(true);
    expect(isMsdfGeneratorEntryId('/r/node_modules/@zappar/msdf-generator/dist/worker.js')).toBe(false);
    expect(isMsdfGeneratorEntryId('/r/node_modules/other/dist/index.js')).toBe(false);
  });
});

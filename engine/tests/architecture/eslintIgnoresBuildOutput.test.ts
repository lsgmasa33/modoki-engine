/** Guard: `npm run lint` ignores generated build output, so a local build cannot turn the
 *  pre-push gate red for a reason that has nothing to do with your change.
 *
 *  The failure this pins is quiet and confusing rather than dramatic. `.gitignore` lists
 *  `ads/` (the playable-ad export) alongside `dist/`, but eslint's ignore list did not — and
 *  the two only disagree VISIBLY under a narrow condition, which is why it survived: a
 *  COMPLETED playable build inlines everything into a single HTML and leaves no JS behind, so
 *  lint stays green. An ABORTED one strands a minified `ads/assets/index-*.js`, and lint then
 *  reports tens of thousands of errors in bundled vendor code (measured: 33,482 from one
 *  interrupted build) pointing at files the developer never wrote. `npm run verify` fails, and
 *  the obvious reading — "my change broke lint" — is wrong.
 *
 *  This asserts against the REAL config via eslint's own resolution, not against the text of
 *  the ignores array: an entry can be present and still not match (a glob missing its leading
 *  recursive segment), which the text form would happily vouch for. */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { ESLint } from 'eslint';

const repoRoot = path.resolve(__dirname, '../../..');

describe('eslint ignores generated build output', () => {
  const eslint = new ESLint({ overrideConfigFile: path.join(repoRoot, 'engine/eslint.config.js') });

  // Each is a gitignored build artifact that has (or can have) lintable JS in it.
  const generated = [
    'games/3d-test/ads/assets/index-BUipsJNt.js', // playable-ad export — the one that bit
    'games/3d-test/dist/assets/index-abc123.js',  // web/native build output
    'engine/packages/modoki/dist/index.js',
  ];

  it.each(generated)('ignores %s', async (rel) => {
    expect(await eslint.isPathIgnored(path.join(repoRoot, rel))).toBe(true);
  });

  // The distinguishing observation: without this, an ignore list of `**/*` would pass every
  // assertion above while silently linting nothing at all.
  it.each([
    'engine/plugins/buildStepShell.ts',
    'engine/packages/modoki/src/runtime/core/rng.ts',
  ])('still LINTS real source: %s', async (rel) => {
    expect(await eslint.isPathIgnored(path.join(repoRoot, rel))).toBe(false);
  });
});

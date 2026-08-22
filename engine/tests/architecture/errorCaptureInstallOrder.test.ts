import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The global error capture (#275) must be installed by a SIDE-EFFECT IMPORT placed above
 * `./App.tsx`, not by a call in `main.tsx`'s body.
 *
 * ⚠️ THE DISTINCTION IS THE WHOLE BUG, and it is invisible at a glance. ES module imports are
 * hoisted and evaluated in source order BEFORE any statement of the importing module runs, so
 * `installGlobalErrorHandlers()` written as main.tsx's first statement still executes after
 * `./App.tsx` and its entire transitive graph — the runtime barrel, PixiJS, three, every game
 * trait registration. A top-level throw anywhere in there was uncovered, and that failure reaches
 * a player as a blank screen on launch with nothing reported: exactly the invisible launch-day
 * crash the phase exists to end. It shipped that way for one commit.
 *
 * ⚠️ This guard PARSES the import list rather than grepping the file, because the file explains
 * itself in a comment naming both `installErrorCapture` and `App.tsx` — a text match would be
 * satisfied by the explanation of the rule instead of the rule.
 */

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../app');
const MAIN = path.join(appDir, 'main.tsx');

/** Import specifiers in source order, with comments and strings-in-comments removed. */
function importSpecifiers(src: string): string[] {
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/^\s*\/\/.*$/, ''))
    .join('\n');
  return [...code.matchAll(/^\s*import\s+(?:[^'"]*?from\s*)?['"]([^'"]+)['"]/gm)].map((m) => m[1]);
}

describe('global error capture install order (#275)', () => {
  const src = fs.readFileSync(MAIN, 'utf8');
  const specs = importSpecifiers(src);

  it('imports ./installErrorCapture before ./App.tsx', () => {
    const capture = specs.findIndex((s) => s.includes('installErrorCapture'));
    const app = specs.findIndex((s) => s.includes('App.tsx'));
    expect(capture, 'main.tsx must import ./installErrorCapture').toBeGreaterThanOrEqual(0);
    expect(app, 'main.tsx must import ./App.tsx').toBeGreaterThanOrEqual(0);
    expect(
      capture,
      `./installErrorCapture must be imported BEFORE ./App.tsx (it is at ${capture}, App.tsx at ${app}). ` +
        `Imports evaluate in source order, so anything above App.tsx is the only code that runs ` +
        `before App.tsx's module graph — which is where a launch-killing top-level throw lives.`,
    ).toBeLessThan(app);
  });

  it('does NOT install by calling the function from main.tsx\'s body', () => {
    const body = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((l) => l.replace(/^\s*\/\/.*$/, ''))
      .filter((l) => !/^\s*import\s/.test(l))
      .join('\n');
    expect(
      /installGlobalErrorHandlers\s*\(/.test(body),
      'main.tsx must not CALL installGlobalErrorHandlers() — a statement runs after every import, ' +
        'which is too late. The side-effect import ./installErrorCapture is the install.',
    ).toBe(false);
  });

  it('installErrorCapture actually calls the installer, and pulls in nothing else', () => {
    const capture = fs.readFileSync(path.join(appDir, 'installErrorCapture.ts'), 'utf8');
    expect(/^\s*installGlobalErrorHandlers\s*\(\s*\)\s*;?\s*$/m.test(capture)).toBe(true);
    // Anything this module imports is itself evaluated uncovered, so the list stays at one.
    expect(importSpecifiers(capture)).toEqual(['@modoki/engine/runtime']);
  });
});

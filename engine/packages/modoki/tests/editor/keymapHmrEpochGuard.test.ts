/** Keymap HMR-epoch guard.
 *
 *  React Fast Refresh re-renders a panel but does NOT re-run a `useEffect` with static
 *  deps (measured: module re-evaluated 3→4, component re-rendered 2→4, effect 2→2). So a
 *  panel that registers keymap bindings from such an effect keeps its ORIGINAL bindings
 *  forever — adding a binding or changing a `keys`/`when` silently does nothing until a
 *  manual reload. That cost a full session once: a fix was measured four times as "not
 *  working" when it was correct and the modules were stale.
 *
 *  The remedy is a convention — key the registration effect on `useHmrEpoch()` — and a
 *  convention with nothing enforcing it decays. This guard fails the build when a NEW
 *  registrar appears without it, in the same spirit as the determinism guard: an EXPLICIT,
 *  reviewed allowlist, never a silent pass.
 *
 *  See docs/editor-hmr.md. */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const EDITOR = join(fileURLToPath(new URL('.', import.meta.url)), '../../src/editor');

/** Registrars deliberately exempt from the epoch, each for a documented reason.
 *  Empty today — every known registrar is keyed on the epoch. */
const ALLOW_NO_EPOCH = new Set<string>([
  // e.g. 'panels/Foo.tsx',  // reason it genuinely cannot go stale
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

/** Slice out each `useEffect(` body, brace-balanced, together with its dep array — good
 *  enough for a lint-style guard and far cheaper than a real parser. */
function effectBlocks(src: string): string[] {
  const blocks: string[] = [];
  const re = /useEffect\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    blocks.push(src.slice(m.index, i + 1));
  }
  return blocks;
}

/** The dependency array of a `useEffect(...)` block — the text of the final `[...]`
 *  argument — or null if the effect has none (which is itself an offence here). */
function depsOf(block: string): string | null {
  const close = block.lastIndexOf(')');
  const open = block.lastIndexOf('[', close);
  if (open < 0) return null;
  const end = block.indexOf(']', open);
  return end < 0 ? null : block.slice(open, end + 1);
}

describe('keymap registrars are HMR-epoch keyed', () => {
  it('every useEffect that calls register() depends on the HMR epoch', () => {
    const offenders: string[] = [];
    for (const file of walk(EDITOR)) {
      const rel = relative(EDITOR, file).split('\\').join('/');
      if (ALLOW_NO_EPOCH.has(rel)) continue;
      const src = readFileSync(file, 'utf8');
      // Only files that actually pull in the keymap registry can register bindings.
      if (!/from ['"][^'"]*input\/keymap['"]/.test(src)) continue;
      for (const block of effectBlocks(src)) {
        if (!/\bregister\(\s*\{/.test(block)) continue;
        // Test the DEP ARRAY, not the whole block — the effects carry an explanatory
        // comment mentioning `hmrEpoch`, so a substring search over the body silently
        // passes even after the dep is removed. (Caught by mutating a real registrar.)
        if (!/hmrEpoch/.test(depsOf(block) ?? '')) {
          offenders.push(rel);
          break;
        }
      }
    }
    expect(
      offenders,
      'these register keymap bindings from an effect that Fast Refresh will not re-run — ' +
      'add `const hmrEpoch = useHmrEpoch()` and put `hmrEpoch` in the dep array ' +
      '(see docs/editor-hmr.md), or allowlist with a reason',
    ).toEqual([]);
  });

  it('GUARD: the scan actually finds the known registrars (else the check is vacuous)', () => {
    // Without this, a broken walk/regex would make the assertion above pass by finding
    // nothing at all — the same vacuity trap the HMR plugin test hit.
    const found = walk(EDITOR).filter((f) => {
      const src = readFileSync(f, 'utf8');
      return /from ['"][^'"]*input\/keymap['"]/.test(src)
        && effectBlocks(src).some((b) => /\bregister\(\s*\{/.test(b));
    });
    expect(found.length).toBeGreaterThanOrEqual(6);
  });
});

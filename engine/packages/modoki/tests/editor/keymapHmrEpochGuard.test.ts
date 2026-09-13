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
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoFiles } from '../../../../scripts/repoCorpus.mjs';

const EDITOR = join(fileURLToPath(new URL('.', import.meta.url)), '../../src/editor');

/* ⚠️ **No `ALLOW_NO_EPOCH` list (#1140).** It was EMPTY, and its first row would have pardoned a whole
 *  FILE — every registrar it would ever hold. A registrar that genuinely cannot go stale goes through
 *  `assertExemptionLedger`, counted. Since the clean tree reports zero either way, the classifier is
 *  pinned on synthetic source below. */

function walk(dir: string, out: string[] = []): string[] {
  out.push(...repoFiles({
    under: dir,
    match: (rel) => {
      const name = rel.split('/').pop() ?? rel;
      return /\.tsx?$/.test(name) && !/\.test\./.test(name);
    },
    floor: 20,
  }).map(({ abs }) => abs));
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

/** Does this source register keymap bindings from an effect whose DEP ARRAY lacks `hmrEpoch`? */
function hasEpochlessRegistrar(src: string): boolean {
  // Only files that actually pull in the keymap registry can register bindings.
  if (!/from ['"][^'"]*input\/keymap['"]/.test(src)) return false;
  // Test the DEP ARRAY, not the whole block — the effects carry an explanatory comment mentioning
  // `hmrEpoch`, so a substring search over the body silently passes even after the dep is
  // removed. (Caught by mutating a real registrar.)
  return effectBlocks(src).some((block) => /\bregister\(\s*\{/.test(block) && !/hmrEpoch/.test(depsOf(block) ?? ''));
}

describe('keymap registrars are HMR-epoch keyed', () => {
  it('the classifier flags a registrar without the epoch dep, and passes one with it', () => {
    const head = "import { register } from '../input/keymap';\n";
    const keyed = `${head}useEffect(() => { register({ id: 'a' }); /* hmrEpoch */ }, [hmrEpoch]);`;
    const unkeyed = `${head}useEffect(() => { register({ id: 'a' }); /* hmrEpoch */ }, []);`;
    expect(hasEpochlessRegistrar(keyed)).toBe(false);
    expect(hasEpochlessRegistrar(unkeyed)).toBe(true);
    expect(hasEpochlessRegistrar(unkeyed.replace(head, ''))).toBe(false); // no keymap import
  });

  it('every useEffect that calls register() depends on the HMR epoch', () => {
    const offenders: string[] = [];
    for (const file of walk(EDITOR)) {
      const rel = relative(EDITOR, file).split('\\').join('/');
      if (hasEpochlessRegistrar(readFileSync(file, 'utf8'))) offenders.push(rel);
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

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
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoFiles } from '../../../../scripts/repoCorpus.mjs';
import { readScannedSource } from '../helpers/sourceScanner';
import { accessPath, callsTo, functionBodyOf, importsIn, objectLiteralKeys, parseSource, ts, unwrapValue } from '../helpers/sourceAst';

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

/** Every `useEffect(…)` whose callback registers keymap bindings — a `register({ … })` call inside it.
 *
 *  ⚠️ **The effect and its dep array are NODES (#1195).** This used to slice each `useEffect(` out by
 *  counting parentheses from the call and take "the last `[…]` before the last `)`" as its deps. A
 *  `(` inside a string kept the count above zero, so that effect's slice swallowed the NEXT effect and
 *  read the neighbour's `[hmrEpoch]` as its own: `console.log(':-(')` in an effect with `[]` deps
 *  passed. Measured as a false pass before the move; it is the fixture below. */
function registrarEffects(sf: ts.SourceFile): ts.CallExpression[] {
  return callsTo(sf, 'useEffect').filter((effect) => {
    const body = functionBodyOf(effect.arguments[0]);
    return !!body && callsTo(body, 'register').some((r) => objectLiteralKeys(r.arguments[0]) !== undefined);
  });
}

/** Does the effect's DEP ARRAY name `hmrEpoch`? No dep array at all is an offence too. */
function depsHaveEpoch(effect: ts.CallExpression): boolean {
  const deps = effect.arguments[1] && unwrapValue(effect.arguments[1]);
  if (!deps || !ts.isArrayLiteralExpression(deps)) return false;
  return deps.elements.some((el) => accessPath(el)?.split('.').pop() === 'hmrEpoch');
}

/** Only files that import the keymap registry can register bindings. */
const importsKeymap = (sf: ts.SourceFile): boolean =>
  importsIn(sf).some((e) => e.kind === 'import' && /(^|\/)input\/keymap$/.test(e.spec));

/** Does this source register keymap bindings from an effect whose DEP ARRAY lacks `hmrEpoch`? */
function hasEpochlessRegistrar(src: string, label = 'probe.tsx'): boolean {
  const sf = parseSource(src, label);
  if (!importsKeymap(sf)) return false;
  // The DEP ARRAY, not the whole effect — the effects carry an explanatory comment mentioning
  // `hmrEpoch`, so a substring search over the body silently passes even after the dep is removed.
  // (Caught by mutating a real registrar.)
  return registrarEffects(sf).some((effect) => !depsHaveEpoch(effect));
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

  it('a bracket inside a string does not hand an effect its NEIGHBOUR\'s deps (#1195)', () => {
    // The issue's probe, verbatim: the first effect's deps are `[]`, the offence, and the `(` in its
    // string made the old paren count swallow the second effect and read `[hmrEpoch]` as its own.
    const head = "import { register } from '../input/keymap';\n";
    const probe = `${head}useEffect(() => { console.log(':-('); register({ key: 'a' }); }, []);\n`
      + "useEffect(() => { register({ key: 'b' }); }, [hmrEpoch]);\n";
    expect(hasEpochlessRegistrar(probe)).toBe(true);
    // And the accept side: both keyed, with the same string.
    expect(hasEpochlessRegistrar(probe.replace(', []);', ', [hmrEpoch]);'))).toBe(false);
    // No dep array at all runs every render and still counts as unkeyed.
    expect(hasEpochlessRegistrar(`${head}useEffect(() => { register({ key: 'c' }); });`)).toBe(true);
  });

  it('every useEffect that calls register() depends on the HMR epoch', () => {
    const offenders: string[] = [];
    for (const file of walk(EDITOR)) {
      const rel = relative(EDITOR, file).split('\\').join('/');
      if (hasEpochlessRegistrar(readScannedSource(file).code, file)) offenders.push(rel);
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
      const sf = parseSource(readScannedSource(f).code, f);
      return importsKeymap(sf) && registrarEffects(sf).length > 0;
    });
    expect(found.length).toBeGreaterThanOrEqual(6);
  });
});

/** #950 — `deriveUnscannedRoots` is the helper two architecture guards use to say "and here is
 *  everything I do NOT scan". Nothing tested it, and it returned roots that CONTAINED the scan
 *  dirs, so a guard's own complement re-scanned what it had already policed and reported each
 *  offender twice — the second time under a message telling the reader the instance was somewhere
 *  the guard does not look.
 *
 *  ⚠️ **Both consumers were green throughout.** Neither has an offender inside its own `SCAN_DIRS`
 *  — that is what those guards exist to ensure — so there was nothing to double-report and the
 *  overlap was invisible. Green by being satisfied, not by the derivation being right. It surfaced
 *  only when a THIRD guard's mutation check deliberately put an offender inside `SCAN_DIRS`.
 *
 *  That is why these assertions are about the DERIVATION's own properties rather than about either
 *  guard's verdict: a test that only checked "the guards are green" would have passed the whole
 *  time the helper was wrong. */
import { describe, it, expect } from 'vitest';
import { deriveUnscannedRoots } from '../helpers/unscannedRoots';

/** The real `SCAN_DIRS` both consumers use. Nested on purpose — the defect needs a scanDir that
 *  lives SEVERAL levels below a root, which is what makes the walk exhaust. */
const SCAN_DIRS = [
  'engine/packages/modoki/src/runtime',
  'engine/packages/modoki/src/editor',
  'engine/app',
];

const contains = (root: string, d: string) => d === root || d.startsWith(`${root}/`);

describe('deriveUnscannedRoots (#950)', () => {
  const roots = deriveUnscannedRoots(SCAN_DIRS);

  it('THE INVARIANT: no returned root contains a scan dir', () => {
    // The whole defect in one assertion. `engine` and `engine/packages/modoki` were both returned,
    // and between them they contain all three SCAN_DIRS.
    const offenders = roots.filter((r) => SCAN_DIRS.some((d) => contains(r, d)));
    expect(offenders).toEqual([]);
  });

  it('a file directly under a partially-scanned root is its OWN root', () => {
    // The exhausted walk. `engine/vite.config.ts` has one iteration; every scanDir still starts
    // with `engine/`, so the break never fires and the loop ends having proved the OPPOSITE of
    // what keeping `dir` assumes. No directory is an honest answer, so the file is.
    expect(roots).toContain('engine/vite.config.ts');
    expect(roots).not.toContain('engine');
  });

  it('ACCEPT: an ordinarily-bounded file still yields its DIRECTORY, not itself', () => {
    // The case that always worked, and the one a careless fix breaks by returning `rel` always —
    // which would make the complement a list of every file in the repo.
    expect(roots).toContain('engine/plugins');
    expect(roots.some((r) => r.startsWith('engine/plugins/'))).toBe(false);
  });

  it('ACCEPT: a scanDir with unscanned SIBLINGS still yields the sibling directory', () => {
    // `.../src/three` sits beside the two scanned `src` subdirs, so the walk must stop THERE
    // rather than at `src` (which contains them) or at the file.
    expect(roots).toContain('engine/packages/modoki/src/three');
  });

  it('nothing is dropped and nothing is double-covered: exactly one root per file', () => {
    // The property the docblock claims — "the honest complement". A file covered by ZERO roots is
    // the hole the previous rewrite existed to close; a file covered by TWO is #950 itself, since
    // an over-broad root necessarily overlaps a correct narrower one.
    const inside = (rel: string) => SCAN_DIRS.some((d) => contains(d, rel) || rel.startsWith(`${d}/`));
    const sample = [
      'engine/vite.config.ts',
      'engine/plugins/backend/deviceCdp.ts',
      'engine/packages/modoki/src/three/traits/Light.ts',
      'engine/electron/main.ts',
    ].filter((r) => !inside(r));
    for (const rel of sample) {
      const covering = roots.filter((r) => rel === r || rel.startsWith(`${r}/`));
      expect(covering, `${rel} should be covered by exactly one unscanned root`).toHaveLength(1);
    }
  });

  it('a scanned file is covered by NO unscanned root — the two sets do not overlap', () => {
    const scanned = 'engine/app/main.tsx';
    expect(roots.filter((r) => scanned === r || scanned.startsWith(`${r}/`))).toEqual([]);
  });
});

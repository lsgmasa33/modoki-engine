/** Every interaction-handle provider must name the DOM element its handles live in.
 *
 *  `computeHandles` (app/debug/handlesDump.ts) occlusion-checks a handle ONLY when its
 *  provider supplies `owner`; a provider that omits it gets `occlusionChecked:false` and
 *  contributes to `occlusionUnchecked` instead of a silently wrong "not occluded". That is
 *  the honest fallback, but as a steady state it is a hole — and it was the whole hole: no
 *  Canvas2D/SVG provider supplied an owner, so a keyframe, a bone, a collider vertex and a
 *  3D gizmo axis were all un-hit-tested.
 *
 *  It cost a wrong bug report. QA-SVIEW-0003 was filed as "dragging a LIGHT's 3D translate
 *  gizmo does nothing while a mesh in the same scene moves" — a plausible lights regression.
 *  Measured on 2026-08-18 (games/anim-bug, Scene canvas 256px wide) the light was fine: its
 *  gizmo's +x aim point is the object origin plus a FIXED 52px screen offset, which put it at
 *  x=305 — 49px past the canvas edge and inside the Assets panel — so the trusted click went
 *  to that panel, and `modoki_drag_handle` answered ok:true with a resolved from/to. The mesh
 *  happened to project further left. With an owner the same call reports `occluded:true` and
 *  names the cover.
 *
 *  A source guard rather than a behavioural one because these providers live inside large
 *  panel components' mount effects: nothing can invoke them without a real viewport, so the
 *  only way a new provider cannot quietly rejoin the hole is to check the source. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';

const SRC_ROOTS = [
  join(__dirname, '../../packages/modoki/src'),
  join(__dirname, '../../app'),
];

/** Handle literals that deliberately stay unchecked, each with the reason it would LIE if wired.
 *
 *  ⚠️ **Keyed `<file>::<kind>` and pardoning ONE literal each (#1123).** This was a
 *  `Record<fileSuffix, reason>`, and the enforcement was INVERTED: an exempt file had to have every
 *  literal LACK `owner:`. That is exact against a stale exemption — wiring the handle turns it red
 *  immediately, better than most guards manage — but it is **perverse under a PARTIAL fix**. A file
 *  with two literals that wires one goes RED, so the cheapest way to stay green is to wire neither;
 *  and a SECOND, unrelated unowned literal added to that file passed silently, which is the grain
 *  defect. Measured 2026-09-12 on work-ai2: 21 literals, exactly one without `owner:`.
 *
 *  The ledger gets both directions without the perversity: wiring the exempt literal makes its row
 *  over-blessed ("blesses 1, found 0"), and a new unowned literal anywhere — including in this same
 *  file — is unexcused. */
const EXEMPT = [
  {
    item: "engine/packages/modoki/src/editor/panels/UIResizeOverlay.tsx::'resize-handle'",
    reason: 'the 8 resize handles sit ON the entity element but are DRIVEN by sibling overlay divs '
      + 'drawn on top of it; owning the entity element would report every handle as occluded by '
      + 'its own grab affordance. Wiring it needs the overlay divs themselves, which the provider '
      + 'does not hold. (One LITERAL, inside a HANDLES.map() that yields the 8 runtime handles.)',
  },
] as const;

/** The `kind:` string a literal declares — what distinguishes two literals in one file. */
function kindOf(lit: string): string {
  // ⚠️ `?? [, 'x']` is a SPARSE array and `no-sparse-arrays` is an eslint ERROR here, not a warning —
  // green under vitest and red only in the lint leg. `<unparsed>` matches no row, so an unreadable
  // literal fails loudly as unexcused rather than slipping through; `handleLiterals` already requires
  // a string `kind`, so it should be unreachable.
  return /\bkind: ('[^']*')/.exec(lit)?.[1] ?? '<unparsed>';
}

/** Every `.ts`/`.tsx` under `SRC_ROOTS`, via the shared corpus producer (#799/#771/#805 Phase 4).
 *  Floored well under the 855 measured today. */
/** ⚠️ Returns `repoFiles()`'s own `rel` alongside `abs`, and the ledger keys on `rel`.
 *
 *  The first cut derived a key by stripping whichever `SRC_ROOTS` prefix matched an ABSOLUTE path.
 *  Two problems, both flagged by review. (1) It swapped a repo-relative SUFFIX match for an
 *  absolute-root PREFIX match, which is newly sensitive to things the suffix was immune to: `abs`'s
 *  root comes from `git rev-parse --show-toplevel` while the root came from `__dirname`, and a
 *  drive-letter case difference or an 8.3 form on the `win` clone breaks a prefix and not a suffix —
 *  the 2026-08-18 Windows incident shape. (2) The two `SRC_ROOTS` can yield the SAME root-relative
 *  key (`debug/x.tsx` from both `engine/app/debug/` and `packages/modoki/src/debug/`), so one row
 *  would pardon both files and a failure could not say which it meant. `rel` is already POSIX and
 *  repo-unique, and it is what `keymapOwnership` and `abandonmentIsShared` key on. */
function sourceFiles(): Array<{ rel: string; abs: string }> {
  return repoFiles({
    under: SRC_ROOTS, match: /\.tsx?$/, exclude: ['node_modules', 'dist'], floor: 600,
  });
}

/** Every object literal that builds an InteractionHandle, found by anchoring on the `kind:`
 *  field and brace-matching outward. Anchoring on the LITERAL rather than on the
 *  `registerHandleProvider(` call is what lets this see a provider passed by reference
 *  (agentBridge registers `chromeHandles`, whose literals live in another file). */
function handleLiterals(src: string): string[] {
  const out: string[] = [];
  for (let i = src.indexOf('kind:'); i !== -1; i = src.indexOf('kind:', i + 1)) {
    // Walk back to the opening brace of the enclosing literal.
    let depth = 0, start = -1;
    for (let j = i; j >= 0; j--) {
      const c = src[j];
      if (c === '}') depth++;
      else if (c === '{') { if (depth === 0) { start = j; break; } depth--; }
    }
    if (start < 0) continue;
    let d = 0, end = -1;
    for (let j = start; j < src.length; j++) {
      const c = src[j];
      if (c === '{') d++;
      else if (c === '}') { d--; if (d === 0) { end = j; break; } }
    }
    if (end < 0) continue;
    const lit = src.slice(start, end + 1);
    // An InteractionHandle always carries kind + editor + x + y. Anything else that happens
    // to have a `kind:` field (a discriminated union, a draw-state record) is not one.
    // An InteractionHandle literal always carries id + a string `kind` + a string `editor`
    // + x + y. Requiring the two STRING fields is what keeps a JSX/style object whose
    // brace-walk happened to swallow a `kind:` out of the set.
    if (/\bid:/.test(lit) && /\bkind: '/.test(lit) && /\beditor: '/.test(lit)
        && /\bx:/.test(lit) && /\by:/.test(lit)) out.push(lit);
  }
  return out;
}

describe('interaction-handle providers name their owning element', () => {
  const files = sourceFiles()
    // The registry declares the field; the dump reads it. Neither builds a handle.
    .filter(({ rel }) => !/interactionHandles\.ts$|handlesDump\.ts$/.test(rel))
    .map(({ rel, abs }) => ({ rel, src: readFileSync(abs, 'utf8') }))
    // Only a file that names the type builds one — cheap prefilter, and it keeps the
    // brace-walk away from unrelated panels entirely.
    .filter(({ src }) => src.includes('InteractionHandle'))
    .map(({ rel, src }) => ({ rel, literals: handleLiterals(src) }))
    .filter(({ literals }) => literals.length > 0);

  it('finds the handle literals at all (a refactor must not make this vacuous)', () => {
    expect(files.length).toBeGreaterThanOrEqual(9);
    expect(files.reduce((n, f) => n + f.literals.length, 0)).toBeGreaterThanOrEqual(15);
  });

  it('every handle literal names its owning element', () => {
    // ⚠️ Rows key on `repoFiles()`'s `rel` — already POSIX, already repo-unique. The old per-file
    // compare had to normalise separators by hand because it built its own path; see `sourceFiles()`
    // for why deriving one is the wrong move here (CI, 2026-08-18).
    assertExemptionLedger({
      label: 'EXEMPT in handleProviderOwner',
      population: files.flatMap(({ rel, literals }) => literals
        .filter((lit) => !lit.includes('owner:'))
        .map((lit) => ({ item: `${rel}::${kindOf(lit)}`, site: `${rel} — kind ${kindOf(lit)}` }))),
      exempt: EXEMPT,
      // 1 measured 2026-09-12, which is also the pardon — so wiring it trips this floor rather than
      // the over-blessed arm. Read it that way. The detector-broke check is the sibling test above,
      // which floors total literals at 15 and providing files at 9.
      floor: 1,
      fix: 'a provider that omits `owner` gets occlusionChecked:false, so its handles are never '
        + 'hit-tested and a covered handle reports as clickable — which cost a wrong bug report '
        + '(QA-SVIEW-0003). Pass the DOM element the handles live in as `owner`.',
    });
  });
});

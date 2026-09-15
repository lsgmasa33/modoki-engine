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
import { join } from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';
import { findNodes, objectLiteralKeys, parseSource, printedText, propertyValue, stringValueOf, ts } from '@modoki/engine/testing/sourceAst';
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

/** The `kind` a literal declares — what distinguishes two literals in one file: a string quoted
 *  (`'resize-handle'`), and a computed kind as its printed code in parentheses
 *  (`(el.getAttribute(UI_KIND_ATTR) ?? el.tagName.toLowerCase())`). */
function kindOf(lit: ts.ObjectLiteralExpression): string {
  const value = propertyValue(lit, 'kind');
  const kind = value && ts.isExpression(value) ? stringValueOf(value) : undefined;
  return kind !== undefined ? `'${kind}'` : `(${value ? printedText(value) : '?'})`;
}

/** Does a handle literal name its owning element — its OWN `owner` key, not one in a nested literal? */
const isOwned = (lit: ts.ObjectLiteralExpression): boolean => objectLiteralKeys(lit)!.includes('owner');

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

/** Every object literal that builds an InteractionHandle: its OWN keys include `id`, `kind`, `x`, `y` and a
 *  string `editor`. Anchoring on the LITERAL rather than on the `registerHandleProvider(` call is what lets
 *  this see a provider passed by reference (agentBridge registers `chromeHandles`, whose literals live in
 *  another file). Requiring the STRING `editor` keeps a discriminated union or a draw-state record that
 *  merely has a `kind` out of the set.
 *
 *  ⚠️ **The literal is a NODE (#1195).** It was found by walking back from each `kind:` to an unbalanced
 *  `{` and brace-matching forward, then testing `\bid:`/`\bx:`/`owner:` anywhere in that TEXT — so a
 *  NESTED literal's `owner:` (or a string holding a brace) could vouch for the handle around it.
 *
 *  ⚠️ **`kind` may be computed.** Both the text form and the parser's first cut required a STRING `kind`,
 *  which silently excluded the `chromeHandles` literal this docblock names — its `kind` is
 *  `el.getAttribute(UI_KIND_ATTR) ?? …` — so deleting its `owner` passed (#1195 P1 review). */
function handleLiterals(sf: ts.SourceFile): ts.ObjectLiteralExpression[] {
  return findNodes(sf, ts.isObjectLiteralExpression).filter((lit) => {
    const keys = new Set(objectLiteralKeys(lit));
    const editor = propertyValue(lit, 'editor');
    return keys.has('id') && keys.has('kind') && keys.has('x') && keys.has('y')
      && !!editor && ts.isExpression(editor) && stringValueOf(editor) !== undefined;
  });
}

describe('interaction-handle providers name their owning element', () => {
  const files = sourceFiles()
    // The registry declares the field; the dump reads it. Neither builds a handle.
    .filter(({ rel }) => !/interactionHandles\.ts$|handlesDump\.ts$/.test(rel))
    .map(({ rel, abs }) => ({ rel, abs, src: readScannedSource(abs).code }))
    // Only a file that names the type builds one — cheap prefilter, and it keeps the
    // parse away from unrelated panels entirely.
    .filter(({ src }) => src.includes('InteractionHandle'))
    .map(({ rel, abs, src }) => ({ rel, literals: handleLiterals(parseSource(src, abs)) }))
    .filter(({ literals }) => literals.length > 0);

  it('finds the handle literals at all (a refactor must not make this vacuous)', () => {
    expect(files.length).toBeGreaterThanOrEqual(9);
    expect(files.reduce((n, f) => n + f.literals.length, 0)).toBeGreaterThanOrEqual(15);
  });

  it('reads a handle literal\'s OWN keys — a nested literal\'s `owner` does not vouch for it (#1195)', () => {
    const sf = parseSource([
      "const a = { id: 'a', kind: 'k', editor: 'e', x: 1, y: 2, meta: { owner: el, label: '{' } };",
      "const b = { id: 'b', kind: 'k2', editor: 'e', x: 1, y: 2, owner: el };",
      "const notAHandle = { kind: 'k3', x: 1, y: 2 };",
      "const computed = { id, kind: el.getAttribute('k') ?? 'div', editor: 'chrome', x: 1, y: 2 };",
    ].join('\n'), 'probe.ts');
    const lits = handleLiterals(sf);
    expect(lits.map(kindOf)).toEqual(["'k'", "'k2'", "(el.getAttribute('k') ?? 'div')"]);
    expect(lits.filter((lit) => !isOwned(lit)).map(kindOf)).toEqual(["'k'", "(el.getAttribute('k') ?? 'div')"]);
  });

  it('every handle literal names its owning element', () => {
    // ⚠️ Rows key on `repoFiles()`'s `rel` — already POSIX, already repo-unique. The old per-file
    // compare had to normalise separators by hand because it built its own path; see `sourceFiles()`
    // for why deriving one is the wrong move here (CI, 2026-08-18).
    assertExemptionLedger({
      label: 'EXEMPT in handleProviderOwner',
      population: files.flatMap(({ rel, literals }) => literals
        .filter((lit) => !isOwned(lit))
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

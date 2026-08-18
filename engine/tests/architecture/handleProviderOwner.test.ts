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
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC_ROOTS = [
  join(__dirname, '../../packages/modoki/src'),
  join(__dirname, '../../app'),
];

/** Providers that deliberately stay unchecked, each with the reason it would LIE if wired.
 *  Keyed by the file's repo-relative suffix. */
const EXEMPT: Record<string, string> = {
  'editor/panels/UIResizeOverlay.tsx':
    'the 8 resize handles sit ON the entity element but are DRIVEN by sibling overlay divs '
    + 'drawn on top of it; owning the entity element would report every handle as occluded by '
    + 'its own grab affordance. Wiring it needs the overlay divs themselves, which the provider '
    + 'does not hold.',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
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
  const files = SRC_ROOTS.flatMap((r) => walk(r))
    // The registry declares the field; the dump reads it. Neither builds a handle.
    .filter((f) => !/interactionHandles\.ts$|handlesDump\.ts$/.test(f))
    .map((f) => ({ file: f, src: readFileSync(f, 'utf8') }))
    // Only a file that names the type builds one — cheap prefilter, and it keeps the
    // brace-walk away from unrelated panels entirely.
    .filter(({ src }) => src.includes('InteractionHandle'))
    .map(({ file, src }) => ({ file, literals: handleLiterals(src) }))
    .filter(({ literals }) => literals.length > 0);

  it('finds the handle literals at all (a refactor must not make this vacuous)', () => {
    expect(files.length).toBeGreaterThanOrEqual(9);
    expect(files.reduce((n, f) => n + f.literals.length, 0)).toBeGreaterThanOrEqual(15);
  });

  it.each(files.map(({ file }) => file))('%s', (file) => {
    const { literals } = files.find((f) => f.file === file)!;
    const exemptKey = Object.keys(EXEMPT).find((k) => file.endsWith(k));
    for (const lit of literals) {
      // An exemption that has since been wired is stale — delete the EXEMPT entry.
      if (exemptKey) expect(lit).not.toContain('owner:');
      else expect(lit).toContain('owner:');
    }
  });
});

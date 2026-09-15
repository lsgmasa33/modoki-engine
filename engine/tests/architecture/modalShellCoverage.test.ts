/** Every full-screen editor modal draws its backdrop through the ONE modal shell (#1270).
 *
 *  WHY. The shell is where a modal tells the keymap it is there: mounting `ModalShell` (or opening
 *  `openDomModalShell`) pushes a MODAL overlay, which blocks every editor shortcut and the relayed
 *  menu underneath. Seventeen dialogs once drew their own `position:fixed; inset:0` backdrop and none
 *  of them registered, so Delete or ⌘Z under a Replace prompt edited the scene that prompt was about
 *  to write. A new dialog hand-rolling its backdrop is the obvious thing to write and brings that
 *  back silently — it looks identical and every other test stays green. So this reads SOURCE.
 *
 *  What it cannot see: a backdrop built some other way (`top:0;left:0;right:0;bottom:0`, `100vw`, a
 *  CSS class, a style object assembled from a spread). It covers `position` fixed with `inset` 0 in
 *  one style object (brace-matched, so nested values and `${…}` between them do not hide the pair)
 *  or one cssText string — the spellings every editor modal used. */

import { describe, it, expect } from 'vitest';
import { readScannedSource } from '@modoki/engine/testing';
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const EDITOR = 'engine/packages/modoki/src/editor';

/** A `position:fixed` in a cssText string, with `inset:0` in the same string. */
const CSS_TEXT = [
  /position:\s*fixed\s*;[^'"`]*?\binset:\s*0\b/,
  /\binset:\s*0\s*;[^'"`]*?position:\s*fixed\b/,
];

/** `position: 'fixed'` and `inset: 0` in the SAME object literal, in either order and whatever sits
 *  between them. Brace-MATCHED rather than `[^{}]*`: a style object can hold a nested value or a
 *  `${…}` template, and a character class that stops at the first brace would read past the object
 *  it is in — or miss the pair entirely — while the guard reports a clean scan. */
function sameObjectBackdrop(code: string): boolean {
  for (const m of code.matchAll(/position:\s*['"]fixed['"]/g)) {
    let depth = 0, start = m.index;
    // Walk back to the `{` that opens the object this property sits in.
    while (start > 0) {
      const ch = code[--start];
      if (ch === '}') depth++;
      else if (ch === '{') { if (depth === 0) break; depth--; }
    }
    let end = m.index + m[0].length;
    depth = 0;
    while (end < code.length) {
      const ch = code[end++];
      if (ch === '{') depth++;
      else if (ch === '}') { if (depth === 0) break; depth--; }
    }
    if (/\binset:\s*0\b/.test(code.slice(start, end))) return true;
  }
  return false;
}

/** The shell itself — the one place a modal backdrop is defined. */
const SANCTIONED = [`${EDITOR}/components/modalBackdrop.ts`];

/** Files allowed to draw one anyway, each with the reason. */
const EXEMPT = [
  { item: `${EDITOR}/panels/FontPicker.tsx`, reason: 'a POPOVER, not a modal: a transparent click-catcher behind a floating list. It pushes a popover overlay (useOverlayEscape), which by design leaves unbound chords to the editor' },
  { item: `${EDITOR}/panels/SpritePicker.tsx`, reason: 'a POPOVER, not a modal — same shape as FontPicker' },
];

/** The dialogs #1270 moved onto the shell. Pinned so a detector that silently matched nothing cannot
 *  pass by finding no backdrops at all. */
const ON_THE_SHELL: Record<string, number> = {
  'EditorApp.tsx': 5, // SaveLayoutAs, LoadLayout, Import / SceneLoad / Build progress
  'panels/ApplyPrefabDialog.tsx': 1, 'panels/Assets.tsx': 1, 'panels/BuildSupportDialog.tsx': 1,
  'panels/CleanupAssetsDialog.tsx': 1, 'panels/FindReferencesDialog.tsx': 1, 'panels/NineSliceEditor.tsx': 1,
  'panels/OtaKeysDialog.tsx': 1, 'panels/ProjectSettingsDialog.tsx': 1, 'panels/PublishOtaDialog.tsx': 1,
  'panels/SpriteEditor.tsx': 1, 'panels/animation/AddPropertyPicker.tsx': 1, 'panels/animation/BindAnimatorPicker.tsx': 1,
};

const drawsBackdrop = (code: string) => sameObjectBackdrop(code) || CSS_TEXT.some((re) => re.test(code));

describe('editor modals use the one modal shell (#1270)', () => {
  const files = repoFiles({ under: EDITOR, match: /\.tsx?$/, floor: 150 });

  it('no file draws its own full-screen backdrop beyond the shell and the exempt popovers — and every row still earns itself', () => {
    const population = files
      .filter(({ abs }) => drawsBackdrop(readScannedSource(abs).code))
      .map(({ rel }) => ({ item: rel, site: rel }));
    assertExemptionLedger({
      label: 'EXEMPT in modalShellCoverage',
      population,
      exempt: EXEMPT,
      sanctioned: SANCTIONED,
      // The goal state of the exempt list is empty, so the floor bounds the SCAN, not the hits.
      scanned: files.length,
      floor: 150,
      fix: 'Draw the backdrop with <ModalShell> (components/ModalShell.tsx), or openDomModalShell outside React — a hand-rolled one registers no modal, so the editor underneath keeps taking keys and menu commands (#1270).',
    });
  });

  it('the migrated dialogs render the shell, and saveDialog opens the DOM form', () => {
    const byRel = new Map(files.map((f) => [f.rel, f.abs]));
    for (const [rel, n] of Object.entries(ON_THE_SHELL)) {
      expect(readScannedSource(byRel.get(`${EDITOR}/${rel}`)!).code.match(/<ModalShell\b/g)?.length ?? 0, rel).toBe(n);
    }
    expect(readScannedSource(byRel.get(`${EDITOR}/utils/saveDialog.ts`)!).code).toMatch(/\bopenDomModalShell\(/);
  });

  it('the detector detects both spellings the old dialogs used', () => {
    expect(drawsBackdrop(`<div style={{ position: 'fixed', inset: 0, zIndex: 9999 }}>`)).toBe(true);
    expect(drawsBackdrop(`el.style.cssText = 'position:fixed;inset:0;z-index:99999'`)).toBe(true);
    expect(drawsBackdrop(`<div style={{ position: 'fixed', zIndex: 9999, inset: 0 }}>`)).toBe(true);
    expect(drawsBackdrop(`<div style={{ inset: 0, position: 'fixed' }}>`)).toBe(true);
    expect(drawsBackdrop(`<div style={{ position: 'fixed', left: 4, top: 8 }}>`)).toBe(false);
    // Two different objects on one line are not one backdrop.
    expect(drawsBackdrop(`<a style={{ position: 'fixed', left: 4 }} /><b style={{ inset: 0 }} />`)).toBe(false);
    // …and a brace between the two properties does not hide them from each other.
    expect(drawsBackdrop("<div style={{ position: 'fixed', top: `${y}px`, inset: 0 }}>")).toBe(true);
    expect(drawsBackdrop("<div style={{ position: 'fixed', transform: t({ x }), inset: 0 }}>")).toBe(true);
    expect(drawsBackdrop("<div style={{ position: 'fixed', pad: { inset: 0 } }}>")).toBe(true); // nested counts: still one object tree
  });
});

/** Which editor modals may be dismissed by clicking the overlay — and which may NOT.
 *
 *  WHY (owner, 2026-08-18). Every modal in the editor wired its backdrop to `onClose`. For a
 *  one-shot picker that is right: dismissing IS the cancel and nothing is lost. For a modal that
 *  holds UNSAVED WORK it is destructive — a stray click outside the 9-slice editor closed it and
 *  threw away every border edit, with no confirmation and nothing on screen distinguishing that
 *  from a successful Save. It was reported as "editing the 9-slice doesn't change the Inspector
 *  values", and reproduced by accident while investigating: an off-target click landed on the
 *  backdrop and the dialog vanished.
 *
 *  The split is by whether a dismiss can LOSE something, so the guard encodes it both ways —
 *  a bare list of "don't dismiss" files would say nothing about the pickers, and the next modal
 *  to be written is the one that needs the rule stated. */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';
import { findNodes, parseSource, ts } from '@modoki/engine/testing/sourceAst';

const SRC = path.resolve(__dirname, '../../packages/modoki/src/editor');

/** Modals holding unsaved editable state: the backdrop MUST NOT close them. */
const MUST_NOT_DISMISS = [
  'panels/NineSliceEditor.tsx',   // border insets, discarded on close
  'panels/SpriteEditor.tsx',      // slice rects, discarded on close
];

/** One-shot pickers/prompts: dismissing IS the cancel, and taking it away would be a
 *  regression in feel. Listed so the rule reads as a decision, not as an oversight. */
const MAY_DISMISS = [
  'panels/SpritePicker.tsx',
  'panels/animation/AddPropertyPicker.tsx',
  'panels/animation/BindAnimatorPicker.tsx',
];

const read = (rel: string) => readScannedSource(path.join(SRC, rel)).code;

/** Does this source wire a backdrop dismiss? Two shapes:
 *
 *  - a `<ModalShell … onDismiss={…}>` — every full-screen modal since #1270 draws its backdrop through
 *    the shell (`modalShellCoverage.test.ts`), so its dismiss is that one prop. Read from the PARSE,
 *    not a regex over the tag: an `onDismiss={() => a > b && close()}` puts a `>` inside the tag, which
 *    is where a `<[^>]*>` scan stops reading.
 *  - a plain `<div>` click-catcher wired to the close callback — the popover pickers (`SpritePicker`),
 *    which are not modals and keep their own transparent backdrop. Scans whole opening tags so
 *    ATTRIBUTE ORDER does not matter: `SpritePicker` writes `onClick` before `style`, and an
 *    order-sensitive regex read that as "does not dismiss", i.e. as a pass. */
function backdropDismisses(src: string): boolean {
  // Parsed only when there is a shell to find: the `<div>` samples below are tag fragments, not a file.
  const sf = src.includes('ModalShell') ? parseSource(src, 'modal.tsx') : null;
  const shells = !sf ? [] : findNodes(sf, (n): n is ts.JsxOpeningElement | ts.JsxSelfClosingElement =>
    (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && n.tagName.getText(sf!) === 'ModalShell');
  for (const shell of shells) {
    const prop = shell.attributes.properties.find((a) => ts.isJsxAttribute(a) && a.name.getText(sf!) === 'onDismiss');
    if (prop) return true;
  }
  for (const tag of src.match(/<div[^>]*>/g) ?? []) {
    const isBackdrop = tag.includes('style={overlay}') || /inset: 0/.test(tag);
    if (isBackdrop && /onClick=\{on(Close|Cancel)\}/.test(tag)) return true;
  }
  return false;
}

describe('editor modal dismiss scope', () => {
  for (const rel of MUST_NOT_DISMISS) {
    it(`${rel} does NOT close on a backdrop click — it holds unsaved work`, () => {
      expect(backdropDismisses(read(rel))).toBe(false);
    });

    it(`${rel} still offers an explicit way out`, () => {
      // Removing the backdrop dismiss must not strand the dialog: a modal with no Cancel and
      // no Escape would be a worse bug than the one being fixed.
      expect(read(rel)).toMatch(/>Cancel</);
    });
  }

  for (const rel of MAY_DISMISS) {
    it(`${rel} keeps its backdrop dismiss — a picker's dismiss is its cancel`, () => {
      expect(backdropDismisses(read(rel))).toBe(true);
    });
  }

  it('the detector actually detects — a matcher that matched nothing would vouch for the bug', () => {
    // The `MAY_DISMISS` expectations above are the live proof that `backdropDismisses` returns
    // true for the real thing; this pins the negative direction on a hand-written sample, so a
    // regex that silently stops matching fails HERE rather than turning every case green.
    expect(backdropDismisses('<div style={overlay} onClick={onClose}>')).toBe(true);
    expect(backdropDismisses('<div onClick={onClose} style={overlay}>')).toBe(true);  // order-independent
    expect(backdropDismisses('<div style={overlay}>')).toBe(false);
    expect(backdropDismisses('const a = <ModalShell kind="x" onDismiss={onClose}><b /></ModalShell>;')).toBe(true);
    expect(backdropDismisses('const a = <ModalShell kind="x" onDismiss={() => n > 0 && close()}><b /></ModalShell>;')).toBe(true);
    expect(backdropDismisses('const a = <ModalShell kind="x"><b /></ModalShell>;')).toBe(false);
  });
});

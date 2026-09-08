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

/** The backdrop is the JSX element carrying the full-screen overlay style; a dismiss wires its
 *  onClick straight to the close callback. Scans whole opening tags so ATTRIBUTE ORDER does not
 *  matter — `SpritePicker` writes `onClick` before `style`, and an order-sensitive regex read
 *  that as "does not dismiss", i.e. as a pass. Covers both the shared `style={overlay}` form and
 *  the inline `position:'fixed', inset:0` form the layout prompts use. */
function backdropDismisses(src: string): boolean {
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
  });
});

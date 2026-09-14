// @vitest-environment jsdom
/** #1182 — the editor's pointer ingestion scope: only a press inside the Game panel's play area
 *  (`[data-game-view-area]`) starts a game gesture. Covers the policy on its own, then the policy
 *  installed into the REAL `pointerSource`, which is the pairing `EditorApp` makes. The capture
 *  routing a live panel sees is covered in the running editor, since jsdom cannot route by capture. */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stripComments } from '../helpers/sourceScanner';
import { isGamePointerTarget, GAME_VIEW_AREA_SELECTOR } from '../../src/editor/input/gamePointerScope';
import { setPointerIngestScope } from '../../src/runtime/core/pointerBlockers';
import { pointerSource } from '../../src/runtime/input/pointerSource';
import { createInputFrame, computePointerEdge } from '../../src/runtime/core/inputActions';

/** An editor-shaped document: a Game panel with toolbar + play area, and a modal portalled to body. */
function editorDom() {
  const panel = document.createElement('div');
  const toolbar = document.createElement('div');
  const area = document.createElement('div');
  area.setAttribute('data-game-view-area', '');
  const canvas = document.createElement('canvas');
  area.appendChild(canvas);
  panel.append(toolbar, area);
  const modalCanvas = document.createElement('canvas');
  document.body.append(panel, modalCanvas);
  return { toolbar, area, canvas, modalCanvas };
}

afterEach(() => {
  pointerSource.detach();
  setPointerIngestScope(null);
  document.body.innerHTML = '';
});

describe('isGamePointerTarget', () => {
  it('accepts the play area and anything inside it', () => {
    const { area, canvas } = editorDom();
    expect(isGamePointerTarget(area)).toBe(true);
    expect(isGamePointerTarget(canvas)).toBe(true);
  });

  it("rejects the Game panel's own toolbar and a modal portalled outside the panel", () => {
    const { toolbar, modalCanvas } = editorDom();
    expect(isGamePointerTarget(toolbar)).toBe(false);
    expect(isGamePointerTarget(modalCanvas)).toBe(false);
  });

  it('rejects a target that is not an element', () => {
    expect(isGamePointerTarget(window)).toBe(false);
    expect(isGamePointerTarget(document)).toBe(false);
    expect(isGamePointerTarget(null)).toBe(false);
  });

  it('GameView still stamps the marker this policy reads', () => {
    // The attribute is written as JSX in GameView.tsx, so renaming it there would silently put
    // every press out of scope and kill game input in the editor. Nothing else would notice.
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../src/editor/rendering/GameView.tsx'), 'utf8');
    const attr = GAME_VIEW_AREA_SELECTOR.slice(1, -1);
    expect(src).toMatch(new RegExp(`<div[^>]*\\b${attr}\\b`));
  });
});

describe('EditorApp wiring', () => {
  it('installs the policy beside the input gate and clears it on unmount', () => {
    // EditorApp is a .tsx panel host and is not mounted in jsdom, so this pins the two lines the
    // live check covers. Without the install, panels are captured again. Without the cleanup, a
    // scope that outlives the editor in the same window drops EVERY press outside a play area that
    // no longer exists. Block and line comments are stripped first, so a commented-out call does
    // not satisfy it. It cannot tell WHERE in the effect the calls sit; the live check owns that.
    const src = stripComments(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../src/editor/EditorApp.tsx'), 'utf8'));
    expect(src).toMatch(/setPointerIngestScope\(\s*isGamePointerTarget\s*\)/);
    expect(src).toMatch(/setPointerIngestScope\(\s*null\s*\)/);
  });
});

describe('installed into the real pointerSource', () => {
  it('a modal press is neither latched nor captured, while a press on the game canvas is both', () => {
    const { canvas, modalCanvas } = editorDom();
    const gameCapture = vi.fn();
    const modalCapture = vi.fn();
    Object.assign(canvas, { setPointerCapture: gameCapture });
    Object.assign(modalCanvas, { setPointerCapture: modalCapture });
    setPointerIngestScope(isGamePointerTarget);
    pointerSource.attach();
    const prev = { down: false };
    const fire = (type: string, target: EventTarget, pointerId: number) => {
      const ev = new MouseEvent(type, { clientX: 5, clientY: 5, bubbles: true });
      (ev as unknown as { pointerId: number }).pointerId = pointerId;
      target.dispatchEvent(ev);
    };
    const sample = () => { const f = createInputFrame(); pointerSource.sample(f); computePointerEdge(f, prev); return f; };

    fire('pointerdown', modalCanvas, 1);
    expect(modalCapture).not.toHaveBeenCalled();
    expect(sample().pointer.pressed).toBe(false);
    fire('pointerup', modalCanvas, 1);

    fire('pointerdown', canvas, 2);
    expect(gameCapture).toHaveBeenCalledWith(2);
    expect(sample().pointer.pressed).toBe(true);
  });
});

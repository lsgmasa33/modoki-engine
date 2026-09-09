/** @vitest-environment jsdom */
import { describe, it, expect } from 'vitest';
import {
  resolvePreviewPick, classifyPreviewElement, readPreviewStack, isPaintOpaque,
  resolveHostBoundedPick, hostRelationOf,
  type PreviewStackEntry,
} from '../../src/editor/panels/uiPreviewPick';

// ── resolvePreviewPick (pure — no DOM) ──

describe('resolvePreviewPick', () => {
  it('a decorative UI element over a genuine 2D hit: the 2D entity wins', () => {
    const stack: PreviewStackEntry[] = [
      { kind: 'ui', entityId: 33, opaque: false }, // HintCatcher, decorative
      { kind: '2d', canvasEntityId: 5 },
    ];
    const pick = resolvePreviewPick(stack, () => 42); // Cell_1_1
    expect(pick).toEqual({ kind: '2d', id: 42 });
  });

  it('an opaque UI panel over a 2D hit: paint order wins, the panel wins', () => {
    const stack: PreviewStackEntry[] = [
      { kind: 'ui', entityId: 33, opaque: true },
      { kind: '2d', canvasEntityId: 5 },
    ];
    const pick = resolvePreviewPick(stack, () => 42);
    expect(pick).toEqual({ kind: 'ui', id: 33 });
  });

  it('a decorative UI element over EMPTY 2D space: the UI element still wins (no regression)', () => {
    const stack: PreviewStackEntry[] = [
      { kind: 'ui', entityId: 33, opaque: false },
      { kind: '2d', canvasEntityId: 5 },
    ];
    const pick = resolvePreviewPick(stack, () => null); // pick2D misses
    expect(pick).toEqual({ kind: 'ui', id: 33 });
  });

  it('an empty stack resolves to null', () => {
    expect(resolvePreviewPick([], () => null)).toBeNull();
  });

  it('descends through a nested decorative-then-opaque UI chain to the opaque one', () => {
    const stack: PreviewStackEntry[] = [
      { kind: 'ui', entityId: 1, opaque: false },
      { kind: 'ui', entityId: 2, opaque: false },
      { kind: 'ui', entityId: 3, opaque: true },
    ];
    const pick = resolvePreviewPick(stack, () => null);
    expect(pick).toEqual({ kind: 'ui', id: 3 });
  });

  it('a decorative element on top of a 2D miss, then an opaque element below: the opaque one wins', () => {
    const stack: PreviewStackEntry[] = [
      { kind: 'ui', entityId: 1, opaque: false },
      { kind: '2d', canvasEntityId: 5 },
      { kind: 'ui', entityId: 2, opaque: true },
    ];
    const pick = resolvePreviewPick(stack, () => null);
    expect(pick).toEqual({ kind: 'ui', id: 2 });
  });

  // ── #999/#1001: the same host bound the real-click path carries ──
  //
  // This resolver is priority 20, so it owns modoki_tap's PREDICTION, while a real click on the
  // canvas runs the priority-10 pickEntityAtViewportPoint. Without the bound here the two are two
  // policies: the tool refuses a reachable entity as "occluded", and reports ok for one the click
  // never lands on -- exactly what screenPick.ts's header forbids.

  it('an OPAQUE ancestor of a missed canvas loses to the canvas host (chess: ChessRoot over BoardViewport)', () => {
    // The winner being opaque is the whole point: chess's ChessRoot is a solid 0x1A1A2E and still
    // escapes, so the bound cannot be expressed as an opacity rule. Court's GameRoot, painting
    // nothing, takes the identical path -- which is why isPaintOpaque looked implicated in three
    // reports and was implicated in none.
    const stack: PreviewStackEntry[] = [
      { kind: '2d', canvasEntityId: 11 },              // BoardViewport's pick canvas, misses
      { kind: 'ui', entityId: 2, opaque: true },       // ChessRoot, an ANCESTOR of 11
    ];
    const pick = resolvePreviewPick(stack, () => null, (uiId, canvasId) => uiId === 2 && canvasId === 11);
    expect(pick).toEqual({ kind: 'ui', id: 11 });
  });

  it('a DECORATIVE element above the canvas keeps its claim over the host (#337 is not regressed)', () => {
    // #337's stated behaviour: a fully-transparent full-bleed container over empty 2D space stays
    // selectable. It is genuinely AT the point, whereas the ancestor is only behind it -- so the
    // bound must not swallow it. This is the case that decides where the bound sits in the loop.
    const stack: PreviewStackEntry[] = [
      { kind: 'ui', entityId: 33, opaque: false },     // HintCatcher-shaped overlay, above
      { kind: '2d', canvasEntityId: 11 },              // misses
      { kind: 'ui', entityId: 2, opaque: true },       // ancestor of 11
    ];
    const pick = resolvePreviewPick(stack, () => null, (uiId, canvasId) => uiId === 2 && canvasId === 11);
    expect(pick).toEqual({ kind: 'ui', id: 33 });
  });

  // Regression guard only — it passes with the bound present AND deleted, because the 2D hit
  // returns before any `ui` entry is examined. Kept, but it is not one of the cases that pin the
  // fix (opus-reviewer, close-out §2d).
  it('an ancestor of a canvas that HIT is never reached — the 2D entity still wins', () => {
    const stack: PreviewStackEntry[] = [
      { kind: '2d', canvasEntityId: 11 },
      { kind: 'ui', entityId: 2, opaque: true },
    ];
    const pick = resolvePreviewPick(stack, () => 71, () => true);
    expect(pick).toEqual({ kind: '2d', id: 71 });
  });

  it('an UNRELATED opaque element below a missed canvas still wins — the bound is not "UI always loses"', () => {
    const stack: PreviewStackEntry[] = [
      { kind: '2d', canvasEntityId: 11 },
      { kind: 'ui', entityId: 40, opaque: true },      // a sibling panel, NOT an ancestor of 11
    ];
    const pick = resolvePreviewPick(stack, () => null, () => false);
    expect(pick).toEqual({ kind: 'ui', id: 40 });
  });

  it('binds against the TOPMOST missed canvas only, so it cannot answer for one the click never touched', () => {
    // opus-reviewer, close-out §2d. Two canvases miss; the opaque `7` contains ONLY the lower one
    // (11), not the topmost (50). A real click is delivered to canvas 50's pick surface, and its
    // handler calls pickUnderlyingUIEntity(x, y, 50) with that id alone -- 7 does not contain 50,
    // so the real click keeps its own answer and selects 7.
    //
    // The first version of this bound tested `missedCanvases.some(...)` and answered
    // `missedCanvases[0]`, i.e. it bound because of 11 and then reported 50 -- a canvas the click
    // never touched, AND a disagreement with the real click, in exactly the shape the bound exists
    // to remove. Reachable with two overlapping Canvas2D hosts in different subtrees (a full-bleed
    // FX canvas over a board panel); no fixture has one, so only this test covers it.
    const stack: PreviewStackEntry[] = [
      { kind: '2d', canvasEntityId: 50 },          // topmost, misses
      { kind: '2d', canvasEntityId: 11 },          // below it, also misses
      { kind: 'ui', entityId: 7, opaque: true },   // ancestor of 11 ONLY
    ];
    const pick = resolvePreviewPick(stack, () => null, (uiId, canvasId) => uiId === 7 && canvasId === 11);
    expect(pick).toEqual({ kind: 'ui', id: 7 });
  });

  it('defaults to the old behaviour when no ancestor test is supplied', () => {
    // The parameter is optional so every existing caller and test keeps its meaning.
    const stack: PreviewStackEntry[] = [
      { kind: '2d', canvasEntityId: 11 },
      { kind: 'ui', entityId: 2, opaque: true },
    ];
    expect(resolvePreviewPick(stack, () => null)).toEqual({ kind: 'ui', id: 2 });
  });
});

// ── classifyPreviewElement / readPreviewStack (jsdom DOM) ──

describe('classifyPreviewElement', () => {
  it('a transparent-background UI element is not opaque', () => {
    const el = document.createElement('div');
    el.setAttribute('data-entity-id', '7');
    el.style.backgroundColor = 'transparent';
    const entry = classifyPreviewElement(el);
    expect(entry).toEqual({ kind: 'ui', entityId: 7, opaque: false });
  });

  it('a colored-background UI element is opaque', () => {
    const el = document.createElement('div');
    el.setAttribute('data-entity-id', '7');
    el.style.backgroundColor = 'rgba(0,0,0,0.8)';
    const entry = classifyPreviewElement(el);
    expect(entry).toEqual({ kind: 'ui', entityId: 7, opaque: true });
  });

  // #337: Court's HintCatcher paints backgroundOpacity 0.01 purely as a full-bleed click-catcher
  // — imperceptible, not a real panel. A strict alpha>0 test would still let it beat a genuine 2D
  // hit underneath, reproducing the exact bug the issue was filed against.
  it('a near-zero-alpha background (a click-catcher, not a visible panel) is not opaque', () => {
    const el = document.createElement('div');
    el.setAttribute('data-entity-id', '7');
    el.style.backgroundColor = 'rgba(10,20,30,0.01)';
    const entry = classifyPreviewElement(el);
    expect(entry).toEqual({ kind: 'ui', entityId: 7, opaque: false });
  });

  it('a genuinely visible low-alpha dim scrim (e.g. 0.16) is still opaque', () => {
    const el = document.createElement('div');
    el.setAttribute('data-entity-id', '7');
    el.style.backgroundColor = 'rgba(0,0,0,0.16)';
    const entry = classifyPreviewElement(el);
    expect(entry).toEqual({ kind: 'ui', entityId: 7, opaque: true });
  });

  it('opacity:0 is not opaque regardless of background', () => {
    const el = document.createElement('div');
    el.setAttribute('data-entity-id', '7');
    el.style.backgroundColor = 'rgb(255,0,0)';
    el.style.opacity = '0';
    const entry = classifyPreviewElement(el);
    expect(entry).toEqual({ kind: 'ui', entityId: 7, opaque: false });
  });

  it('a UI element with direct text content is opaque', () => {
    const el = document.createElement('div');
    el.setAttribute('data-entity-id', '7');
    el.appendChild(document.createTextNode('Score: 12'));
    const entry = classifyPreviewElement(el);
    expect(entry).toEqual({ kind: 'ui', entityId: 7, opaque: true });
  });

  it('a role="switch" UIToggle track is opaque regardless of its background', () => {
    const el = document.createElement('div');
    el.setAttribute('data-entity-id', '7');
    el.setAttribute('role', 'switch');
    const entry = classifyPreviewElement(el);
    expect(entry).toEqual({ kind: 'ui', entityId: 7, opaque: true });
  });

  // opus-reviewer, #337 close-out: `NineSliceImage` (a bordered sprite — most of Court's
  // dialog/card art, e.g. SolvedPanel/RulesPanel/NarrationBand) renders as an aria-hidden,
  // pointerEvents:'none' CHILD of the host div, not a CSS background on the host itself — so
  // without a marker every 9-sliced panel read as fully decorative and lost to whatever 2D
  // entity happened to be behind it. This was a real, verified regression, not a hypothetical.
  it('a host with no own background/text but a nine-slice child paint layer is opaque', () => {
    const el = document.createElement('div');
    el.setAttribute('data-entity-id', '7');
    const nineSlice = document.createElement('div');
    nineSlice.setAttribute('aria-hidden', '');
    nineSlice.setAttribute('data-ui-paint', 'nine-slice');
    el.appendChild(nineSlice);
    expect(isPaintOpaque(el)).toBe(true);
    expect(classifyPreviewElement(el)).toEqual({ kind: 'ui', entityId: 7, opaque: true });
  });

  it('a host with a video-mount child paint layer is opaque', () => {
    const el = document.createElement('div');
    el.setAttribute('data-entity-id', '7');
    const video = document.createElement('div');
    video.setAttribute('data-modoki-ui-video', '3');
    video.setAttribute('data-ui-paint', 'video');
    el.appendChild(video);
    expect(isPaintOpaque(el)).toBe(true);
  });

  it('a host whose text is wrapped in an AnimatedText span (playing a TextAnimation) is still opaque', () => {
    const el = document.createElement('div');
    el.setAttribute('data-entity-id', '7');
    // AnimatedText wraps the text in its OWN <span> — the text is no longer a direct text-node
    // child of the host, which is exactly why the generic direct-text-node check above misses it.
    const span = document.createElement('span');
    span.setAttribute('data-ui-paint', 'text');
    span.appendChild(document.createTextNode('Score: 12'));
    el.appendChild(span);
    expect(isPaintOpaque(el)).toBe(true);
  });

  it('a NESTED UI entity\'s own decorative paint layer does NOT bubble up to its ancestor', () => {
    const ancestor = document.createElement('div');
    ancestor.setAttribute('data-entity-id', '7'); // e.g. a plain layout container — no own paint
    const child = document.createElement('div');
    child.setAttribute('data-entity-id', '8'); // a genuinely separate, addressable UI entity
    const nineSlice = document.createElement('div');
    nineSlice.setAttribute('data-ui-paint', 'nine-slice');
    child.appendChild(nineSlice);
    ancestor.appendChild(child);
    // The ancestor itself paints nothing of its own — the marker belongs to the nested entity.
    expect(isPaintOpaque(ancestor)).toBe(false);
    // The nested entity, classified on its own, IS opaque.
    expect(isPaintOpaque(child)).toBe(true);
  });

  // opus-reviewer, #337 close-out: MIN_PERCEPTIBLE_ALPHA must gate the EFFECTIVE alpha (own
  // opacity × background alpha), not background alpha alone — otherwise the exact HintCatcher
  // case reproduces again, just authored through the `opacity` field instead of
  // `backgroundOpacity`.
  it('a solid background at near-zero element opacity is not opaque (effective alpha, not background alpha alone)', () => {
    const el = document.createElement('div');
    el.setAttribute('data-entity-id', '7');
    el.style.backgroundColor = 'rgb(255,0,0)'; // background alone reads fully opaque
    el.style.opacity = '0.02'; // but the element itself is nearly invisible
    expect(isPaintOpaque(el)).toBe(false);
  });

  it('a low element opacity combined with a low background alpha multiplies below the threshold', () => {
    const el = document.createElement('div');
    el.setAttribute('data-entity-id', '7');
    el.style.backgroundColor = 'rgba(0,0,0,0.08)'; // alone, above MIN_PERCEPTIBLE_ALPHA (0.05)
    el.style.opacity = '0.5'; // effective: 0.08 * 0.5 = 0.04, below the threshold
    expect(isPaintOpaque(el)).toBe(false);
  });

  it('near-zero element opacity suppresses even a naturally-opaque tag (input) or role=switch', () => {
    const input = document.createElement('input');
    input.setAttribute('data-entity-id', '7');
    input.style.opacity = '0.01';
    expect(isPaintOpaque(input)).toBe(false);

    const toggle = document.createElement('div');
    toggle.setAttribute('data-entity-id', '8');
    toggle.setAttribute('role', 'switch');
    toggle.style.opacity = '0.01';
    expect(isPaintOpaque(toggle)).toBe(false);
  });

  // opus-reviewer, #337 close-out (2nd pass, VERIFIED mechanically): CSS `opacity` on an
  // ANCESTOR fades the whole subtree, and `elementsFromPoint` returns a low-opacity ancestor's
  // descendants unchanged (opacity does not affect hit-testing) — so a container authored at
  // `opacity:0.02` with an ORDINARY, fully-opaque child reproduces the exact HintCatcher case one
  // level down: the child's OWN computed opacity reads `1`, so the earlier element-local-only gate
  // missed it entirely.
  it('a near-invisible ANCESTOR suppresses a normal-opacity child (composited, not element-local, opacity)', () => {
    const container = document.createElement('div');
    container.setAttribute('data-entity-id', '7');
    container.style.opacity = '0.02'; // the whole subtree is imperceptible
    const child = document.createElement('div');
    child.setAttribute('data-entity-id', '8');
    child.style.backgroundColor = 'rgb(255,0,0)'; // solid, fully opaque ON ITS OWN
    // child.style.opacity is unset (computed '1') — the bug this test pins is specifically that
    // the element's OWN opacity alone is not enough; the ancestor's must be composited in too.
    container.appendChild(child);
    expect(isPaintOpaque(child)).toBe(false);
  });

  it('a genuinely visible ancestor does not suppress an opaque child (no false negative)', () => {
    const container = document.createElement('div');
    container.setAttribute('data-entity-id', '7');
    container.style.opacity = '1';
    const child = document.createElement('div');
    child.setAttribute('data-entity-id', '8');
    child.style.backgroundColor = 'rgb(255,0,0)';
    container.appendChild(child);
    expect(isPaintOpaque(child)).toBe(true);
  });

  it('composited opacity STOPS at the "ui" preview frame boundary, not the document root', () => {
    const frame = document.createElement('div');
    frame.setAttribute('data-ui-preview-frame', '');
    frame.style.opacity = '0.01'; // irrelevant — outside the reconciliation, must not count
    const child = document.createElement('div');
    child.setAttribute('data-entity-id', '8');
    child.style.backgroundColor = 'rgb(255,0,0)';
    frame.appendChild(child);
    expect(isPaintOpaque(child)).toBe(true);
  });

  it('a [data-2d-pick] canvas classifies as a 2d layer with its canvas-entity-id', () => {
    const el = document.createElement('canvas');
    el.setAttribute('data-2d-pick', '');
    el.setAttribute('data-canvas-entity-id', '5');
    expect(classifyPreviewElement(el)).toEqual({ kind: '2d', canvasEntityId: 5 });
  });

  it('a [data-canvas2d-mount] wrapper is not decision-bearing (null — keep descending)', () => {
    const el = document.createElement('div');
    el.setAttribute('data-canvas2d-mount', '');
    expect(classifyPreviewElement(el)).toBeNull();
  });

  it('an unrelated element (no attributes) is null', () => {
    const el = document.createElement('div');
    expect(classifyPreviewElement(el)).toBeNull();
  });
});

describe('readPreviewStack', () => {
  it('classifies an injected elements-at-point stack, dropping non-decision layers', () => {
    const ui = document.createElement('div');
    ui.setAttribute('data-entity-id', '33');
    const mount = document.createElement('div');
    mount.setAttribute('data-canvas2d-mount', '');
    const pick = document.createElement('canvas');
    pick.setAttribute('data-2d-pick', '');
    pick.setAttribute('data-canvas-entity-id', '5');
    const stack = readPreviewStack(10, 10, () => [ui, mount, pick]);
    expect(stack).toEqual([
      { kind: 'ui', entityId: 33, opaque: false },
      { kind: '2d', canvasEntityId: 5 },
    ]);
  });
});

// ── #999/#1001: a 2D miss must not escape upward past its canvas host ──
//
// The defect these cover: a Canvas2D host is a LEAF in the UI tree, so UINode gives it
// `pointerEvents:'none'` and no onClick, and `elementFromPoint` skips straight past it to the
// nearest ancestor that handles clicks — the UI root. Reproduced in wordweave (#999), court
// (#1001) and chess, with the winner's own opacity irrelevant in all three.

describe('resolveHostBoundedPick', () => {
  it('an ANCESTOR of the host is an escape — the host wins (the #999/#1001 defect)', () => {
    // court: picked GameRoot(7) while the host was 2D Canvas(8); chess: ChessRoot(2) over
    // BoardViewport(11). Both skipped exactly one level, which is the signature of the escape.
    expect(resolveHostBoundedPick(7, 8, 'ancestor-of-host')).toBe(8);
  });

  // ⚠️ There is deliberately NO `('host')` case here. With `pickedId === hostEntityId` both
  // arms of the ternary return the same number, so it passes under a mutant that always binds --
  // it measures nothing the 'unrelated' case does not. Deleted rather than banked after the
  // mutation check caught it. `hostRelationOf`'s own 'host' case below DOES discriminate, and is
  // kept: removing its early return reddens it, because querySelector does not match self.

  it('an UNRELATED subtree keeps its own answer — this is what leaves the Three.js and deselect fall-throughs alone', () => {
    // Also stands in for a DESCENDANT of the host (the "true underlying UI child" showing through
    // a transparent canvas): it does not contain the host either, so it reports 'unrelated' too,
    // and must survive untouched. That is the case pickUnderlyingUIEntity's neutralization exists
    // for. A separate literal-swapped copy of this case was deleted -- same discriminating power.
    expect(resolveHostBoundedPick(99, 8, 'unrelated')).toBe(99);
  });

  it('a total miss stays a miss — it must not be turned into a host selection', () => {
    // Guards the deselect path: null in, null out, whatever the relation says.
    expect(resolveHostBoundedPick(null, 8, 'ancestor-of-host')).toBeNull();
  });

  it('no host (a canvas outside any UI node) leaves the pick untouched', () => {
    expect(resolveHostBoundedPick(7, null, 'ancestor-of-host')).toBe(7);
  });
});

describe('hostRelationOf', () => {
  const mk = (id: number) => {
    const el = document.createElement('div');
    el.setAttribute('data-entity-id', String(id));
    return el;
  };

  it('reports ancestor-of-host when the picked element CONTAINS the host', () => {
    const root = mk(2);          // ChessRoot
    const host = mk(11);         // BoardViewport
    root.appendChild(host);
    expect(hostRelationOf(root, 2, 11)).toBe('ancestor-of-host');
  });

  it('reports host when the picked id IS the host', () => {
    expect(hostRelationOf(mk(11), 11, 11)).toBe('host');
  });

  it('reports unrelated for a sibling subtree that does not contain the host', () => {
    const sibling = mk(4);       // StatusText, elsewhere in the tree
    expect(hostRelationOf(sibling, 4, 11)).toBe('unrelated');
  });

  it('a DESCENDANT of the host is unrelated to the escape test, so it keeps its own answer', () => {
    const child = mk(12);        // a UI child showing through the canvas
    expect(hostRelationOf(child, 12, 11)).toBe('unrelated');
  });

  it('⚠️ scopes the host lookup to the picked element\'s OWN subtree, so the Game panel\'s copy of the same host cannot answer for the SceneView', () => {
    // The editor mounts the same UI host in BOTH the SceneView preview and the Game panel, so a
    // document-wide `[data-entity-id="11"]` lookup returns whichever copy comes FIRST in document
    // order — which is not necessarily the one the click landed in.
    //
    // ⚠️ The ORDER here is the whole test. The Game panel's copy is inserted FIRST, so a
    // document-scoped implementation resolves the host to THAT copy, finds the SceneView's root
    // does not contain it, and reports 'unrelated' — silently losing a genuine escape and putting
    // #999/#1001 straight back. The subtree-scoped implementation looks only inside the element
    // that was actually picked and correctly reports 'ancestor-of-host'.
    //
    // An earlier version of this test asserted the mirror case ('unrelated' when only the Game
    // panel has the host) and PASSED under the document-scoped bug — it could not fail for the
    // reason it was written. Caught by mutation check, kept as this note.
    const gameRoot = mk(2);
    gameRoot.appendChild(mk(11));   // the OTHER panel's copy, first in document order
    const sceneRoot = mk(2);
    sceneRoot.appendChild(mk(11));  // the copy the click actually landed in
    document.body.append(gameRoot, sceneRoot);
    try {
      expect(hostRelationOf(sceneRoot, 2, 11)).toBe('ancestor-of-host');
    } finally {
      gameRoot.remove();
      sceneRoot.remove();
    }
  });
});

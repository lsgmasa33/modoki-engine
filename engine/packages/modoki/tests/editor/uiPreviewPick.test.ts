/** @vitest-environment jsdom */
import { describe, it, expect } from 'vitest';
import {
  resolvePreviewPick, classifyPreviewElement, readPreviewStack, isPaintOpaque,
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

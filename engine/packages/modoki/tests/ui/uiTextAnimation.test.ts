/** uiTextAnimation — the whole-element CSS realization of TextAnimation effects for
 *  the DOM UI layer. Pure mapping (effect + params → CSS animation shorthand). */

import { describe, it, expect } from 'vitest';
import { uiTextAnimation, type UITextAnimParams } from '../../src/runtime/ui/uiTextAnimation';

const p = (o: Partial<UITextAnimParams>): UITextAnimParams =>
  ({ effect: 'none', speed: 1, amplitude: 0.1, frequency: 1, loop: true, ...o });

describe('uiTextAnimation', () => {
  it('returns null for none / unknown effects', () => {
    expect(uiTextAnimation(p({ effect: 'none' }))).toBeNull();
    expect(uiTextAnimation(p({ effect: 'bogus' }))).toBeNull();
  });

  it('maps periodic effects to an infinite animation with amp in em', () => {
    const r = uiTextAnimation(p({ effect: 'wave', speed: 0.5, amplitude: 0.25 }))!;
    expect(r.animation).toContain('mdk-ui-float');
    expect(r.animation).toContain('infinite');
    expect(r.animation).toContain('2.000s'); // 1 / 0.5
    // em, not px: the amplitude IS the em multiple, so no fontSize resolution step (#245).
    expect(r.amp).toBeCloseTo(0.25, 5);
  });

  it('rainbow is a clipped-gradient cycle (extra span style), no translate amplitude', () => {
    const r = uiTextAnimation(p({ effect: 'rainbow', speed: 0.4 }))!;
    expect(r.animation).toContain('mdk-ui-rainbow');
    expect(r.animation).toContain('infinite');
    expect(r.amp).toBe(0);
    expect(r.style?.WebkitBackgroundClip).toBe('text');
    expect(r.style?.color).toBe('transparent');
    // motion effects add no extra style
    expect(uiTextAnimation(p({ effect: 'wave' }))!.style).toBeUndefined();
  });

  it('rainbow hugs its text, so short strings see the WHOLE spectrum (#657)', () => {
    // The gradient's positioning area is the span's BOX, not the glyphs, and the span is
    // `display: block` (#646) so it fills its container. Measured on "SCORE" in a 600px host at
    // 42px: ink/box was 0.249 — about a quarter of the rainbow, roughly red→orange — in the
    // ordinary flex case, and #646 made the two non-flex contexts (`-webkit-box` under maxLines,
    // and AutoFitText's span) match it at 0.249 where they had been 1.000. `fit-content`
    // restores 1.000 in all three.
    //
    // Asserted here rather than left to the pixel measurement because the CSS property is the
    // only part a headless test can see, and dropping it is a silent regression: the effect
    // keeps animating and simply stops showing most of its colours.
    const r = uiTextAnimation(p({ effect: 'rainbow' }))!;
    expect(r.style?.width).toBe('fit-content');
    // The gradient is still clipped to the glyphs — fit-content sizes the box, it does not
    // replace the clip, and losing either one breaks the effect in a different way.
    expect(r.style?.backgroundClip).toBe('text');
    expect(r.style?.backgroundSize).toBe('200% auto');
  });

  it('a shrink-wrapped rainbow carries the authored textAlign (#657 follow-up)', () => {
    // ⚠️ MEASURED ON SCREEN, and it caught a regression the plain fix shipped with.
    // `text-align` centres INLINE content inside a box; once the span is `display: block` +
    // `fit-content` the box is only as wide as its glyphs, so `text-align` has nothing left to
    // centre and the box sits flush at the start of the line — a centred "SCORE" jumped to the
    // left edge. Auto margins are what position a shrink-to-fit BLOCK, so they are what has to
    // carry the alignment across.
    expect(uiTextAnimation(p({ effect: 'rainbow' }), 'center')!.style?.marginInline).toBe('auto');
    expect(uiTextAnimation(p({ effect: 'rainbow' }), 'right')!.style?.marginLeft).toBe('auto');
    // Left/start must add NOTHING — the default position is already correct, and an auto margin
    // there would move text that was never broken.
    const left = uiTextAnimation(p({ effect: 'rainbow' }), 'left')!.style!;
    expect(left.marginInline).toBeUndefined();
    expect(left.marginLeft).toBeUndefined();
    // Omitted textAlign behaves like left, not like a crash.
    expect(uiTextAnimation(p({ effect: 'rainbow' }))!.style?.marginInline).toBeUndefined();
    // The alignment must not leak onto a non-gradient effect, which has no style at all.
    expect(uiTextAnimation(p({ effect: 'wave' }), 'center')!.style).toBeUndefined();
  });

  it('fade one-shot: no loop → runs once and holds (forwards); loop → pulse (alternate)', () => {
    const once = uiTextAnimation(p({ effect: 'fade', loop: false }))!;
    expect(once.animation).toContain('mdk-ui-fade');
    expect(once.animation).toContain(' 1 '); // iteration count 1
    expect(once.animation).toContain('forwards');
    const loop = uiTextAnimation(p({ effect: 'fade', loop: true }))!;
    expect(loop.animation).toContain('infinite');
    expect(loop.animation).toContain('alternate');
  });

  it('duration scales inversely with speed (clamped)', () => {
    expect(uiTextAnimation(p({ effect: 'wave', speed: 2 }))!.animation).toContain('0.500s');
    expect(uiTextAnimation(p({ effect: 'wave', speed: 0 }))!.animation).toContain('10.000s'); // clamp 0.1
  });

  it('typewriter is a per-character reveal (not a whole-element animation)', () => {
    const r = uiTextAnimation(p({ effect: 'typewriter', speed: 1 }))!;
    expect(r.perChar).toBeDefined();
    expect(r.animation).toBe('');   // renderer builds a per-glyph animation, not a shorthand
    expect(r.amp).toBe(0);
    expect(r.style).toBeUndefined();
    // whole-element effects carry no perChar block
    expect(uiTextAnimation(p({ effect: 'wave' }))!.perChar).toBeUndefined();
  });

  it('typewriter stagger scales inversely with speed (clamped) and passes loop through', () => {
    expect(uiTextAnimation(p({ effect: 'typewriter', speed: 1 }))!.perChar!.staggerSec).toBeCloseTo(0.09, 5);
    expect(uiTextAnimation(p({ effect: 'typewriter', speed: 3 }))!.perChar!.staggerSec).toBeCloseTo(0.03, 5);
    expect(uiTextAnimation(p({ effect: 'typewriter', speed: 0 }))!.perChar!.staggerSec).toBeCloseTo(0.9, 5); // clamp 0.1
    expect(uiTextAnimation(p({ effect: 'typewriter', loop: true }))!.perChar!.loop).toBe(true);
    expect(uiTextAnimation(p({ effect: 'typewriter', loop: false }))!.perChar!.loop).toBe(false);
  });

  it('typewriter fadeIn passes through; undefined defaults to true (fade)', () => {
    expect(uiTextAnimation(p({ effect: 'typewriter', fadeIn: true }))!.perChar!.fadeIn).toBe(true);
    expect(uiTextAnimation(p({ effect: 'typewriter', fadeIn: false }))!.perChar!.fadeIn).toBe(false);
    // omitted → treated as fade (matches the trait default)
    const q = { effect: 'typewriter', speed: 1, amplitude: 0, frequency: 0, loop: true };
    expect(uiTextAnimation(q)!.perChar!.fadeIn).toBe(true);
  });
});

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

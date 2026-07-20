/** The Inspector's component clipboard. Its whole job is to hand out values that are
 *  ISOLATED from the entity they came from and from every entity pasted onto — the
 *  copy/paste feature is otherwise a silent cross-entity mutation bug.
 *
 *  `readTraitDataFull` returns LIVE references into a trait's store, and
 *  `cloneTraitValues` keeps the original reference for anything `structuredClone`
 *  refuses (a class instance, a function). Sharing that reference is worse than losing
 *  the field, so the clipboard drops such fields at copy time. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  cloneCopyableValues, setTraitClipboard, getTraitClipboard, subscribeTraitClipboard,
  isTraitCopyable,
} from '../../src/editor/panels/traitClipboard';
import type { TraitMeta } from '../../src/runtime/ecs/traitRegistry';

const meta = (name: string, category: string) => ({ name, category } as unknown as TraitMeta);

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  setTraitClipboard('__reset__', { x: 1 }); // leave a known entry between tests
});
afterEach(() => { warn.mockRestore(); });

describe('cloneCopyableValues', () => {
  it('deep-clones plain values so the source can be mutated afterwards', () => {
    const src = { clips: { roll: { fps: 12 } } };
    const { values, dropped } = cloneCopyableValues(src);
    expect(dropped).toEqual([]);
    expect(values.clips).not.toBe(src.clips);
    (src.clips.roll as { fps: number }).fps = 60;
    expect((values.clips as any).roll.fps).toBe(12);
  });

  it('drops fields structuredClone refuses instead of aliasing them', () => {
    // Functions are the real non-cloneable case. Keeping the original reference (which
    // cloneTraitValues' fallback does) would make the clipboard, the source entity, and
    // every pasted entity share one object.
    const src = { hp: 5, onHit: () => {}, weak: new WeakMap() };
    const { values, dropped } = cloneCopyableValues(src);
    expect(values).toEqual({ hp: 5 });
    expect(dropped.sort()).toEqual(['onHit', 'weak']);
  });

  it('a class instance is cloned but LOSES its prototype (not aliased, but not intact)', () => {
    // structuredClone doesn't throw on a class instance — it copies own enumerable props
    // into a plain object. So there's no aliasing, but methods are gone. Traits are meant
    // to hold plain data; this pins what happens if one ever doesn't.
    class Live { constructor(public n = 1) {} bump() { this.n++; } }
    const { values, dropped } = cloneCopyableValues({ live: new Live() });
    expect(dropped).toEqual([]);
    expect(values.live).toEqual({ n: 1 });
    expect(values.live).not.toBeInstanceOf(Live);
  });

  it('never returns a reference held by the input', () => {
    const nested = { a: [1, 2, 3] };
    const { values } = cloneCopyableValues({ nested });
    expect(values.nested).not.toBe(nested);
    expect((values.nested as any).a).not.toBe(nested.a);
  });
});

describe('setTraitClipboard', () => {
  it('stores a clone — mutating the source afterwards cannot reach the clipboard', () => {
    const src = { clips: { roll: { fps: 12 } } };
    setTraitClipboard('SpriteAnim', src);
    (src.clips.roll as { fps: number }).fps = 99;
    expect((getTraitClipboard()!.values.clips as any).roll.fps).toBe(12);
  });

  it('warns and drops non-copyable fields, keeping the rest', () => {
    setTraitClipboard('Weird', { hp: 5, fn: () => {} });
    expect(getTraitClipboard()).toEqual({ traitName: 'Weird', values: { hp: 5 } });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('fn'));
  });

  it('REGRESSION: refuses an empty entry rather than enabling a no-op Paste', () => {
    // A `{}` entry under a real trait name still matches the section's trait, so
    // "Paste Component Values" would enable and then write nothing.
    setTraitClipboard('Health', { hp: 1 });
    setTraitClipboard('Health', {});
    expect(getTraitClipboard()).toEqual({ traitName: 'Health', values: { hp: 1 } }); // unchanged
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('nothing copyable'));
  });

  it('refuses an entry whose every field was dropped as non-copyable', () => {
    const before = getTraitClipboard();
    setTraitClipboard('AllFns', { a: () => {}, b: () => {} });
    expect(getTraitClipboard()).toEqual(before);
  });

  it('notifies subscribers on a successful copy, and not on a refused one', () => {
    const fn = vi.fn();
    const unsub = subscribeTraitClipboard(fn);
    setTraitClipboard('Health', { hp: 1 });
    expect(fn).toHaveBeenCalledTimes(1);
    setTraitClipboard('Health', {});          // refused
    expect(fn).toHaveBeenCalledTimes(1);
    unsub();
    setTraitClipboard('Health', { hp: 2 });
    expect(fn).toHaveBeenCalledTimes(1);      // unsubscribed
  });
});

describe('isTraitCopyable', () => {
  it('accepts plain components', () => {
    expect(isTraitCopyable(meta('Health', 'component'))).toBe(true);
    expect(isTraitCopyable(meta('Transform', 'component'))).toBe(true);
  });

  it('rejects identity-bearing traits — pasting a guid would corrupt the GUID index', () => {
    expect(isTraitCopyable(meta('EntityAttributes', 'component'))).toBe(false);
    expect(isTraitCopyable(meta('PrefabInstance', 'component'))).toBe(false);
  });

  it('rejects tags and resources (no values to copy)', () => {
    expect(isTraitCopyable(meta('Frozen', 'tag'))).toBe(false);
    expect(isTraitCopyable(meta('Time', 'resource'))).toBe(false);
  });
});

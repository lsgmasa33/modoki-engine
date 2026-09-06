/** sceneChrome — the engine's generic chrome pusher, lifted out of Court's game code in #632
 *  Tier 3 (`runtime/ui/sceneChrome.ts`). Exercises the two rules its own banner states —
 *  diff-before-write, resolve-by-name-and-re-resolve — against a REAL koota world via
 *  `createTestWorld`, plus the self-heal and world-swap mechanics that make the shared name
 *  cache safe to reuse across scene loads. */
import { describe, it, expect, beforeEach, afterEach, onTestFinished, vi } from 'vitest';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { UIElement } from '../../src/runtime/traits/UIElement';
import { UIAnchor } from '../../src/runtime/traits/UIAnchor';
import { UIToggle } from '../../src/runtime/traits/UIToggle';
import { Animator } from '../../src/runtime/traits/Animator';
import { EntityAttributes } from '../../src/runtime/core/traits/EntityAttributes';
import { isUIDirty, clearUIDirty } from '../../src/runtime/core/uiDirty';
import {
  patchUI, patchToggle, restartClip, findChromeEntity, resetSceneChromeCache, patchAnchorPct,
} from '../../src/runtime/ui/sceneChrome';

let tw: TestWorld | undefined;
beforeEach(() => { tw = createTestWorld(); });
afterEach(() => { resetSceneChromeCache(); tw?.dispose(); tw = undefined; });

/** Read a named entity's current `UIElement` back out of the world — the same shape Court's own
 *  `sceneChrome.test.ts` uses, so a `patchUI` write is proven by a read, not by return value alone. */
function readToggle(name: string): Record<string, unknown> | undefined {
  let out: Record<string, unknown> | undefined;
  tw!.world.query(EntityAttributes, UIToggle).forEach((e) => {
    if (e.get(EntityAttributes)?.name === name) out = { ...(e.get(UIToggle) as Record<string, unknown>) };
  });
  return out;
}

function read(name: string): Record<string, unknown> | undefined {
  let out: Record<string, unknown> | undefined;
  tw!.world.query(EntityAttributes, UIElement).forEach((e) => {
    if (e.get(EntityAttributes)?.name === name) out = { ...(e.get(UIElement) as Record<string, unknown>) };
  });
  return out;
}

/** `read`'s twin for `UIAnchor`, for the `patchAnchorPct` tests below. */
function readAnchor(name: string): Record<string, unknown> | undefined {
  let out: Record<string, unknown> | undefined;
  tw!.world.query(EntityAttributes, UIAnchor).forEach((e) => {
    if (e.get(EntityAttributes)?.name === name) out = { ...(e.get(UIAnchor) as Record<string, unknown>) };
  });
  return out;
}

describe('patchUI', () => {
  it('writes a changed value and reports that it wrote', () => {
    tw!.spawn(UIElement({ text: 'old' }), EntityAttributes({ name: 'Label' }));
    expect(patchUI(tw!.world, 'Label', { text: 'new' })).toBe(true);
    expect(read('Label')?.text).toBe('new');
  });

  it('does NOT write when every field already matches — the diff rule', () => {
    // Without this, every frame would `set` + `markUIDirty()` and rebuild the whole UI projection.
    tw!.spawn(UIElement({ text: 'same' }), EntityAttributes({ name: 'Label' }));
    expect(patchUI(tw!.world, 'Label', { text: 'same' })).toBe(false);
  });

  // ⚠️ The module's banner calls `markUIDirty()` a CORRECTNESS issue, not plumbing: without it
  // the projection keeps serving old values and nothing reaches the screen. Nothing asserted it
  // until this test — deleting the `markUIDirty()` call left every other assertion in this file
  // satisfied, because `read()` queries the traits directly and bypasses the projection entirely.
  it('marks the UI tree dirty when it writes, and NOT when it skips', () => {
    tw!.spawn(UIElement({ text: 'old' }), EntityAttributes({ name: 'Label' }));

    clearUIDirty();
    expect(patchUI(tw!.world, 'Label', { text: 'new' })).toBe(true);
    expect(isUIDirty(), 'a real write must dirty the tree or the screen never rebuilds').toBe(true);

    // The other half of the same rule, and the reason the diff exists: a no-op must NOT dirty,
    // or a per-frame chrome sweep reprojects the whole tree every frame.
    clearUIDirty();
    expect(patchUI(tw!.world, 'Label', { text: 'new' })).toBe(false);
    expect(isUIDirty(), 'a skipped write must leave the tree clean').toBe(false);
  });
});

describe('patchUI — backgroundColor/backgroundOpacity (defect fix)', () => {
  // The render-time paint gate lives at `ui/UINode.tsx:267`:
  //   if (node.backgroundOpacity > 0) style.backgroundColor = hexToRgba(...);
  // and it sits inside `UINodeInner`, a React component — not reachable from this headless,
  // no-renderer test, and the brief for this test forbids faking one. What IS verifiable here is
  // the TRAIT PAIR `patchUI` writes, which is the gate's actual input: `backgroundColor` with no
  // `backgroundOpacity` leaves the paint gate closed (opacity stays at its silent-no-op default,
  // 0 — traits/UIElement.ts:164); supplying both opens it.
  it('backgroundColor alone leaves backgroundOpacity at the silent-no-op default (0)', () => {
    tw!.spawn(UIElement({}), EntityAttributes({ name: 'Panel' }));
    expect(patchUI(tw!.world, 'Panel', { backgroundColor: 0xff0000 })).toBe(true);
    const panel = read('Panel')!;
    expect(panel.backgroundColor).toBe(0xff0000);
    expect(panel.backgroundOpacity, 'unchanged from the trait default — this is what the gate reads as "off"').toBe(0);
  });

  it('backgroundColor + backgroundOpacity together writes the pair the paint gate needs', () => {
    tw!.spawn(UIElement({}), EntityAttributes({ name: 'Panel' }));
    expect(patchUI(tw!.world, 'Panel', { backgroundColor: 0xff0000, backgroundOpacity: 1 })).toBe(true);
    const panel = read('Panel')!;
    expect(panel.backgroundColor).toBe(0xff0000);
    expect(panel.backgroundOpacity).toBe(1);
  });
});

describe('patchUI — a present-but-undefined key means "leave it alone"', () => {
  // Every ChromeUIPatch field is optional, so `{ isVisible: flags.show }` with an undefined
  // `flags.show` is ordinary caller code. koota's SoA setter tests `if ('key' in value)`, not
  // whether the value is defined, so without the skip in patchEntity the spread writes a real
  // `undefined` — and `UINode` renders null for a falsy `isVisible`, taking the whole subtree
  // with it, permanently (the next identical call diffs as unchanged and writes nothing).
  it('does not write undefined over a real value, and does not report a write', () => {
    tw!.spawn(UIElement({ isVisible: true, text: 'keep' }), EntityAttributes({ name: 'Panel' }));
    clearUIDirty();
    expect(patchUI(tw!.world, 'Panel', { isVisible: undefined })).toBe(false);
    expect(read('Panel')!.isVisible, 'undefined must not blank the element').toBe(true);
    expect(isUIDirty(), 'a no-op must not reproject the tree').toBe(false);
  });

  it('still writes the defined keys alongside an undefined one', () => {
    tw!.spawn(UIElement({ isVisible: true, text: 'old' }), EntityAttributes({ name: 'Panel' }));
    expect(patchUI(tw!.world, 'Panel', { text: 'new', isVisible: undefined })).toBe(true);
    const panel = read('Panel')!;
    expect(panel.text).toBe('new');
    expect(panel.isVisible, 'the undefined key stayed untouched').toBe(true);
  });
});

describe('patchUI — borderColor/borderWidth (the sibling trap the first fix missed)', () => {
  // Same shape as the backgroundColor/backgroundOpacity pair above, and it survived the fix that
  // closed that one. The render-time gate is `ui/UINode.tsx`:
  //   if (node.borderWidth) { style.borderWidth = ...; style.borderColor = hexToRgba(...); }
  // `UIElement.borderWidth` defaults to 0, so a patched `borderColor` alone paints NOTHING while
  // reporting a successful write. Not reachable from a headless test (the gate is inside a React
  // component), so — as with the background pair — what is asserted here is the TRAIT PAIR that
  // gate reads.
  it('borderColor alone leaves borderWidth at the gate-closed default (0)', () => {
    tw!.spawn(UIElement({}), EntityAttributes({ name: 'Card' }));
    expect(patchUI(tw!.world, 'Card', { borderColor: 0x00ff00 })).toBe(true);
    const card = read('Card')!;
    expect(card.borderColor).toBe(0x00ff00);
    expect(card.borderWidth, 'unchanged from the trait default — the gate reads this as "no border"').toBe(0);
  });

  it('borderColor + borderWidth together writes the pair the border gate needs', () => {
    tw!.spawn(UIElement({}), EntityAttributes({ name: 'Card' }));
    expect(patchUI(tw!.world, 'Card', { borderColor: 0x00ff00, borderWidth: 2 })).toBe(true);
    const card = read('Card')!;
    expect(card.borderColor).toBe(0x00ff00);
    expect(card.borderWidth).toBe(2);
  });

  it('borderOpacity is patchable — fading a border must not need element `opacity`', () => {
    // `opacity` would fade the element's CHILDREN too; that non-equivalence is the same argument
    // that put `backgroundOpacity` on this interface.
    tw!.spawn(UIElement({}), EntityAttributes({ name: 'Card' }));
    expect(patchUI(tw!.world, 'Card', { borderColor: 0x00ff00, borderWidth: 2, borderOpacity: 0.5 })).toBe(true);
    expect(read('Card')!.borderOpacity).toBe(0.5);
  });
});

describe('patchToggle', () => {
  it('writes UIToggle, not UIElement', () => {
    tw!.spawn(UIElement({ text: 'keep-me' }), UIToggle({ value: false }), EntityAttributes({ name: 'Switch' }));
    expect(patchToggle(tw!.world, 'Switch', { value: true })).toBe(true);

    let toggle: Record<string, unknown> | undefined;
    tw!.world.query(EntityAttributes, UIToggle).forEach((e) => {
      if (e.get(EntityAttributes)?.name === 'Switch') toggle = { ...(e.get(UIToggle) as Record<string, unknown>) };
    });
    expect(toggle?.value).toBe(true);
    // The other trait on the same entity is untouched — `patchToggle` must not fall through to
    // `patchUI`'s trait, and vice versa.
    expect(read('Switch')?.text).toBe('keep-me');
  });

  it('does NOT write when the value already matches — the diff rule applies here too', () => {
    // `patchUI` had this guard from the start; its twin did not, so `patchToggle`'s diff could be
    // deleted with the whole file still green.
    tw!.spawn(UIToggle({ value: true }), EntityAttributes({ name: 'Switch' }));
    clearUIDirty();
    expect(patchToggle(tw!.world, 'Switch', { value: true })).toBe(false);
    expect(isUIDirty(), 'an unchanged toggle write must not reproject the tree').toBe(false);
  });

  // ⚠️ The `defined` filter landed in patchEntity AND patchToggle in the same commit, and only
  // patchEntity got tests — reverting patchToggle's two lines alone left `verify` green. The
  // consequence here is one trait over from the `isVisible` case above and just as permanent:
  // `patchToggle(w, 'SoundSwitch', { value: prefs?.sound })` with an undefined `prefs` writes a
  // real `undefined` into `UIToggle.value`, the switch renders off, and the next identical call
  // diffs as unchanged so it never recovers.
  it('does not write undefined over a real value, and does not report a write', () => {
    tw!.spawn(UIToggle({ value: true }), EntityAttributes({ name: 'Switch' }));
    clearUIDirty();
    expect(patchToggle(tw!.world, 'Switch', { value: undefined })).toBe(false);
    expect(readToggle('Switch')!.value, 'undefined must not clear the toggle').toBe(true);
    expect(isUIDirty(), 'a no-op must not reproject the tree').toBe(false);
  });

  it('still writes the defined keys alongside an undefined one', () => {
    tw!.spawn(UIToggle({ value: false, trackOnColor: 0x111111 }), EntityAttributes({ name: 'Switch' }));
    expect(patchToggle(tw!.world, 'Switch', { trackOnColor: 0x222222, value: undefined })).toBe(true);
    const toggle = readToggle('Switch')!;
    expect(toggle.trackOnColor).toBe(0x222222);
    expect(toggle.value, 'the undefined key stayed untouched').toBe(false);
  });
});

describe('restartClip', () => {
  it('is NOT diffed — writes even when the playhead is already at the target (playing: true, time: 0)', () => {
    // ⚠️ Spawned mid-clip and PAUSED on purpose. `Animator`'s own defaults are `time: 0` /
    // `playing: true`, so spawning `Animator({})` and then asserting those two values proves
    // nothing — a `restartClip` that wrote nothing at all would pass. Starting away from the
    // target is what makes the post-state assertions below real.
    tw!.spawn(Animator({ time: 5, playing: false }), EntityAttributes({ name: 'Intro' }))
    const entity = findChromeEntity(tw!.world, 'Intro')!;
    // koota entities are branded numbers, and `.set` lives on `Number.prototype` (see the
    // onWorldSwap test's banner below) — `vi.spyOn` refuses to spy a primitive directly, so the
    // spy goes on the prototype method itself. Nothing else in this test calls `.set` on any
    // entity, so every call the spy records here is a `restartClip` write.
    // koota augments Number.prototype at runtime; its declaration merging is not visible here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const setSpy = vi.spyOn(Number.prototype as any, 'set');
    // Restored explicitly: this vitest config sets no `restoreMocks`, so without this the spy
    // stays installed on a GLOBAL prototype for every describe that follows in this file.
    onTestFinished(() => setSpy.mockRestore());

    expect(restartClip(tw!.world, 'Intro')).toBe(true);
    expect(setSpy, 'first call writes').toHaveBeenCalledTimes(1);
    // The playhead is ALREADY at the value this call is about to write — a diffed function (like
    // `patchUI`) would see no change and skip the write. `restartClip` must not: a re-show landing
    // on the same frame must still restart the clip, or it silently never plays.
    expect(restartClip(tw!.world, 'Intro')).toBe(true);
    expect(setSpy, 'second call writes too — no diff gate skipped it').toHaveBeenCalledTimes(2);

    const anim = entity.get(Animator)!;
    expect(anim.time).toBe(0);
    expect(anim.playing).toBe(true);
  });
});

describe('patchAnchorPct', () => {
  it('writes left/top/bottom onto UIAnchor as percentages', () => {
    tw!.spawn(UIAnchor({}), EntityAttributes({ name: 'Banner' }));
    expect(patchAnchorPct(tw!.world, 'Banner', { leftPct: 5, topPct: 10, bottomPct: 3.73 })).toBe(true);
    const anchor = readAnchor('Banner')!;
    expect(anchor.left).toBe(5);
    expect(anchor.leftUnit).toBe('%');
    expect(anchor.top).toBe(10);
    expect(anchor.topUnit).toBe('%');
    expect(anchor.bottom).toBe(3.73);
    expect(anchor.bottomUnit).toBe('%');
  });

  it('does NOT write, and returns false, when the change is inside the 0.01 deadband', () => {
    tw!.spawn(UIAnchor({ bottom: 3.73, bottomUnit: '%' }), EntityAttributes({ name: 'Banner' }));
    clearUIDirty();
    // 0.005 under the 0.01 deadband — sub-pixel churn `patchAnchorPct`'s own doc comment says a
    // per-frame lift must not re-project the whole UI tree over.
    expect(patchAnchorPct(tw!.world, 'Banner', { bottomPct: 3.735 })).toBe(false);
    expect(readAnchor('Banner')!.bottom, 'the deadbanded value must not overwrite the stored one').toBe(3.73);
    expect(isUIDirty(), 'a deadbanded no-op must not reproject the tree').toBe(false);
  });

  it('a change past the deadband still writes', () => {
    tw!.spawn(UIAnchor({ bottom: 3.73, bottomUnit: '%' }), EntityAttributes({ name: 'Banner' }));
    expect(patchAnchorPct(tw!.world, 'Banner', { bottomPct: 4.5 })).toBe(true);
    expect(readAnchor('Banner')!.bottom).toBe(4.5);
  });

  it('returns false, and writes nothing, when the entity is missing', () => {
    expect(patchAnchorPct(tw!.world, 'NoSuchEntity', { bottomPct: 5 })).toBe(false);
  });

  it('returns false, and writes nothing, when the entity has no UIAnchor', () => {
    tw!.spawn(UIElement({ text: 'no anchor here' }), EntityAttributes({ name: 'Plain' }));
    clearUIDirty();
    expect(patchAnchorPct(tw!.world, 'Plain', { bottomPct: 5 })).toBe(false);
    expect(isUIDirty()).toBe(false);
  });

  // rightPct — #806: the horizontal-letterbox inset a stretched/right-anchored element needs, and
  // which the scene cannot author (it's a runtime fact about how much letterbox exists this frame).
  it('writes right onto UIAnchor as a percentage', () => {
    tw!.spawn(UIAnchor({}), EntityAttributes({ name: 'Banner' }));
    expect(patchAnchorPct(tw!.world, 'Banner', { rightPct: 12.5 })).toBe(true);
    const anchor = readAnchor('Banner')!;
    expect(anchor.right).toBe(12.5);
    expect(anchor.rightUnit).toBe('%');
  });

  it('does NOT write, and returns false, when a rightPct change is inside the 0.01 deadband', () => {
    tw!.spawn(UIAnchor({ right: 12.5, rightUnit: '%' }), EntityAttributes({ name: 'Banner' }));
    clearUIDirty();
    expect(patchAnchorPct(tw!.world, 'Banner', { rightPct: 12.505 })).toBe(false);
    expect(readAnchor('Banner')!.right, 'the deadbanded value must not overwrite the stored one').toBe(12.5);
    expect(isUIDirty(), 'a deadbanded no-op must not reproject the tree').toBe(false);
  });
});

describe('findChromeEntity — self-heal', () => {
  it('a cached name whose entity was destroyed falls back to the scan, not the dead one', () => {
    const first = tw!.spawn(UIElement({ text: 'first' }), EntityAttributes({ name: 'Ghost' }));
    expect(findChromeEntity(tw!.world, 'Ghost')).not.toBeNull(); // populates the cache with `first`

    first.destroy();
    const second = tw!.spawn(UIElement({ text: 'second' }), EntityAttributes({ name: 'Ghost' }));

    const found = findChromeEntity(tw!.world, 'Ghost');
    expect(found).not.toBeNull();
    // koota entities are branded numbers (id+generation+worldId) — destroying `first` and
    // respawning under the same name gives `second` a DIFFERENT number (same slot, incremented
    // generation), so identity equality is a real, not coincidental, check here.
    expect(found).toBe(second);
    expect(found!.get(UIElement)?.text).toBe('second');
  });
});

describe('findChromeEntity — the onWorldSwap clear', () => {
  it('a name cached before a swap is not served from the stale entry after it', () => {
    // koota allocates world ids from a LIFO free list, so disposing a world and immediately
    // creating another hands the SAME world id back; a fresh `createTestWorld()` + one `spawn()`
    // then lands on the identical (worldId, entityId, generation) bit pattern the first did,
    // because both start from a freshly reset entity index. Verified empirically before writing
    // this test: the raw entity NUMBER for the Nth entity spawned is bit-for-bit IDENTICAL across
    // the two worlds. That means the self-heal's own `world.has()` check cannot tell a cached
    // entry from `first` apart from a genuine hit in `second` — only clearing `byName` on the
    // swap forces a real re-scan instead of a coincidental fast-path return.
    const first = createTestWorld();
    first.spawn(UIElement({}), EntityAttributes({ name: 'Echo' }));
    const firstHandle = findChromeEntity(first.world, 'Echo'); // populates byName with the number that will recur
    expect(firstHandle).not.toBeNull();
    first.dispose();

    const second = createTestWorld();
    second.spawn(UIElement({}), EntityAttributes({ name: 'Echo' })); // same relative spawn order → same number

    // ⚠️ ASSERT the premise rather than resting on the prose above. This test can only tell
    // "a fresh scan ran" from "a coincidental cache hit" while the recycled handle is still
    // ACCEPTED by the second world — that is what makes the stale entry a live hazard the
    // `onWorldSwap` clear has to defuse. If a koota bump makes id allocation FIFO, or adds a
    // per-world epoch to the entity number, `world.has()` goes false, the scan runs for an
    // unrelated reason, and the `querySpy` assertion below would keep passing while proving
    // NOTHING. Without this line that regression is silent.
    expect(second.world.has(firstHandle!), 'koota no longer recycles the entity number — this test '
      + 'has stopped discriminating and its querySpy assertion below is now vacuous').toBe(true);

    const querySpy = vi.spyOn(second.world, 'query');

    const found = findChromeEntity(second.world, 'Echo');

    expect(found).not.toBeNull();
    // The behavioural proof: a fresh scan actually ran. Without the `onWorldSwap` clear, the
    // stale `byName` entry from `first` would satisfy `world.has()` + the name check on the very
    // same (recycled) number and return WITHOUT ever calling `query` — the cache would still be
    // "serving the old entity" in the sense that matters: it would short-circuit the resolution a
    // fresh scene load is supposed to force, for however long it took a name collision to arise.
    expect(querySpy, 'a scan ran instead of the stale entry short-circuiting it').toHaveBeenCalled();

    second.dispose();
  });
});

/**
 * #1097 — a staged entity's FIRST frame must already be posed by its Animator.
 *
 * `animationSystem` pushes no pose while `getAnimationClip` returns null, and that getter only
 * STARTS a fetch on a miss. So unless the scene acquire has already loaded the clip, the first
 * frames of a new world paint the entity's AUTHORED values — Court's `BoardPage`/`ChromeRoot`/
 * `AdBannerSlot` at `UIElement.opacity` 1 behind a fade-in whose first key is 0 (measured: 3 sim
 * frames cold, 0 warm; games/court/intro.md § the pre-pose window).
 *
 * These drive the REAL `sceneManager.loadScene` (only `fetch` is stubbed), then run ONE
 * `animationSystem` pass — the spawn tick — and read the pose. Nothing about the mechanism is
 * mocked: the preload lives in the scene acquire, so a test that seeded the cache itself would stay
 * green with the preload deleted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  sceneManager, getCurrentWorld, animationSystem, UIElement, EntityAttributes, registerAsset, newGuid,
  clearAnimationClipCache, getAnimationClip,
} from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';

const CLIP_PATH = '/assets/anim/preload-fade-in.anim.json';

function fadeInClip(id: string) {
  return {
    id, name: 'fade-in', duration: 0.5, frameRate: 60, loop: false,
    tracks: [{ path: '', trait: 'UIElement', field: 'opacity', type: 'number',
      keys: [{ t: 0, v: 0 }, { t: 0.5, v: 1 }] }],
  };
}

/** One UI entity staged like Court's BoardPage: authored opacity left at the default (1), an
 *  Animator whose only clip starts at opacity 0, not playing (the timeline starts it later). */
function stagedScene(clipGuid: string) {
  return {
    id: newGuid(), version: 1, resources: [],
    entities: [{
      id: 1, name: 'Staged',
      traits: {
        EntityAttributes: { name: 'Staged', layer: 'ui', guid: newGuid() },
        UIElement: { width: 50, height: 50 },
        Animator: { clips: JSON.stringify([{ name: 'fade-in', clip: clipGuid }]), clip: 'fade-in', playing: false, loop: false },
      },
    }],
  };
}

function stagedOpacity(): number | undefined {
  const world = getCurrentWorld();
  let op: number | undefined;
  world.query(EntityAttributes, UIElement).forEach((e) => {
    if (e.get(EntityAttributes)?.name === 'Staged') op = (e.get(UIElement) as { opacity?: number }).opacity ?? 1;
  });
  return op;
}

describe('#1097 — Animator clips are preloaded at scene load', () => {
  let clipGuid: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    registerAllTraits();
    clearAnimationClipCache();
    clipGuid = newGuid();
    registerAsset(clipGuid, CLIP_PATH, 'animation');
    fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith(CLIP_PATH)) {
        return new Response(JSON.stringify(fadeInClip(clipGuid)), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearAnimationClipCache();
  });

  it('the spawn tick poses the entity at the clip\'s first key, not its authored opacity', async () => {
    // Hold the clip's fetch open, so "the load WAITED for the clip" is observable. A stub that settles
    // in microtasks cannot tell an awaited preload from a fire-and-forget one: `loadScene` has enough
    // awaits after the acquire that a merely-STARTED fetch lands before it resolves (review-found —
    // `void loadAnimationClipNow(...)` passed the first version of this test).
    let releaseClip!: () => void;
    const clipGate = new Promise<void>((r) => { releaseClip = r; });
    fetchMock.mockImplementation(async (url: RequestInfo | URL) => {
      if (!String(url).endsWith(CLIP_PATH)) return new Response('not found', { status: 404 });
      await clipGate;
      return new Response(JSON.stringify(fadeInClip(clipGuid)), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    let settled = false;
    const load = sceneManager.loadScene('/assets/scenes/preload-test.scene.json', { preloaded: stagedScene(clipGuid) as never })
      .then(() => { settled = true; });
    for (let i = 0; i < 50 && !settled; i++) await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false); // the swap is parked on the clip
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith(CLIP_PATH))).toBe(true);

    releaseClip();
    await load;

    // Precondition of a posed first frame: the clip is ALREADY resolvable, synchronously.
    expect(getAnimationClip(clipGuid, { load: false })).not.toBeNull();

    expect(stagedOpacity()).toBe(1); // authored — nothing has run yet
    animationSystem(getCurrentWorld());
    expect(stagedOpacity()).toBe(0);
  });

  it('a clip that fails to load does not fail or block the scene load — the entity just stays unposed', async () => {
    fetchMock.mockImplementation(async () => new Response('boom', { status: 500 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(
        sceneManager.loadScene('/assets/scenes/preload-fail.scene.json', { preloaded: stagedScene(clipGuid) as never }),
      ).resolves.toBeUndefined();
      expect(stagedOpacity()).toBe(1);
      animationSystem(getCurrentWorld());
      expect(stagedOpacity()).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });
});

/** createEditor scene-load fallback helpers (Missing Tests #2).
 *
 *  The editor's scene boot tries: stored last-scene → config.scenePath → initWorld
 *  → empty-camera. These pure helpers underpin that chain — the per-project
 *  last-scene key scoping, the de-duplicated candidate list, and the
 *  rendererReady timeout that must always clear its setTimeout. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  lastSceneKey,
  resolveSceneCandidates,
  resolveBootSceneOverride,
  canonicalBootScenePath,
  loadFirstScene,
  awaitRendererReady,
  RENDERER_READY_TIMEOUT_MS,
  RENDERER_READY_SOFT_TIMEOUT_MS,
} from '../../src/editor/createEditor';
import type { SceneLoadOutcome } from '../../src/editor/scene/serialize';
import { sceneManager } from '../../src/runtime/scene/SceneManager';
import { registerAsset, clearManifest } from '../../src/runtime/loaders/assetManifest';

describe('lastSceneKey (per-project scoping)', () => {
  it('scopes by config.name so one project never leaks into another', () => {
    expect(lastSceneKey('3d-test')).toBe('modoki-last-scene:3d-test');
    expect(lastSceneKey('alien-animal')).toBe('modoki-last-scene:alien-animal');
    expect(lastSceneKey('3d-test')).not.toBe(lastSceneKey('alien-animal'));
  });
  it('falls back to "default" for an unnamed project', () => {
    expect(lastSceneKey(undefined)).toBe('modoki-last-scene:default');
    expect(lastSceneKey('')).toBe('modoki-last-scene:default');
  });
});

describe('resolveSceneCandidates (fallback order)', () => {
  it('orders last-scene first, then config default', () => {
    expect(resolveSceneCandidates('/a/last.json', '/a/default.json'))
      .toEqual(['/a/last.json', '/a/default.json']);
  });
  it('drops falsy entries (no stored last-scene → just the default)', () => {
    expect(resolveSceneCandidates(null, '/a/default.json')).toEqual(['/a/default.json']);
    expect(resolveSceneCandidates(undefined, '/a/default.json')).toEqual(['/a/default.json']);
    expect(resolveSceneCandidates('', '/a/default.json')).toEqual(['/a/default.json']);
  });
  it('collapses a last-scene that equals the default to a single candidate', () => {
    expect(resolveSceneCandidates('/a/x.json', '/a/x.json')).toEqual(['/a/x.json']);
  });
  it('returns an empty list when neither is set (→ initWorld/empty-camera path)', () => {
    expect(resolveSceneCandidates(null, undefined)).toEqual([]);
  });
});

describe('resolveBootSceneOverride (issue #43 — --scene / MODOKI_SCENE launch override)', () => {
  // The fixture uses the `<name>.scene.json` DOUBLE extension every real project uses.
  // It did not (single `.json`) until QA-PROJECT-0003, and that is precisely why a
  // green suite sat on top of a bare-name override that could never match in practice.
  // One legacy single-extension entry stays so both strips are covered.
  const SCENES = [
    '/assets/scenes/Level-0001.scene.json',
    '/assets/scenes/Level-0002.scene.json',
    '/assets/scenes/main.scene.json',
    '/assets/scenes/legacy.json',
  ];

  it('returns a path candidate verbatim, no lookup (contains a slash)', () => {
    expect(resolveBootSceneOverride('/assets/scenes/Level-0002.scene.json', SCENES)).toBe('/assets/scenes/Level-0002.scene.json');
    // Not even present in the list — still passed through untouched.
    expect(resolveBootSceneOverride('/assets/scenes/not-in-manifest.scene.json', SCENES)).toBe('/assets/scenes/not-in-manifest.scene.json');
  });

  it('returns a bare filename verbatim, no lookup (ends in .json)', () => {
    expect(resolveBootSceneOverride('Level-0002.scene.json', SCENES)).toBe('Level-0002.scene.json');
  });

  it('matches a bare name against a *.scene.json file (QA-PROJECT-0003)', () => {
    expect(resolveBootSceneOverride('Level-0002', SCENES)).toBe('/assets/scenes/Level-0002.scene.json');
  });

  it('still matches a bare name against a legacy single-extension *.json file', () => {
    expect(resolveBootSceneOverride('legacy', SCENES)).toBe('/assets/scenes/legacy.json');
  });

  it('matches a bare name case-insensitively against the scene list', () => {
    expect(resolveBootSceneOverride('level-0002', SCENES)).toBe('/assets/scenes/Level-0002.scene.json');
    expect(resolveBootSceneOverride('LEVEL-0002', SCENES)).toBe('/assets/scenes/Level-0002.scene.json');
    expect(resolveBootSceneOverride('main', SCENES)).toBe('/assets/scenes/main.scene.json');
  });

  it('falls through to null when the name matches nothing (typo)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveBootSceneOverride('Level-9999', SCENES)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("'Level-9999' matched no scene"));
    warn.mockRestore();
  });

  it('refuses to guess on an ambiguous name (>1 match) rather than first-matching', () => {
    const dupes = ['/assets/scenes/foo.json', '/other-root/scenes/foo.json'];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveBootSceneOverride('foo', dupes)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("'foo' is ambiguous"));
    warn.mockRestore();
  });

  it('returns null for a null/empty/undefined override (no warning — nothing was asked for)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveBootSceneOverride(null, SCENES)).toBeNull();
    expect(resolveBootSceneOverride(undefined, SCENES)).toBeNull();
    expect(resolveBootSceneOverride('', SCENES)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('precedence: the resolved override goes in FRONT of the normal candidates, which stay behind it', () => {
    // Ordering is asserted through resolveSceneCandidates — the production function that
    // decides it — so this cannot pass while the real boot order drifts.
    const resolved = resolveBootSceneOverride('level-0002', SCENES);
    expect(resolveSceneCandidates('/assets/scenes/last-opened.json', '/assets/scenes/config-default.json', resolved)).toEqual([
      '/assets/scenes/Level-0002.scene.json',
      '/assets/scenes/last-opened.json',
      '/assets/scenes/config-default.json',
    ]);
  });

  it('an override that FAILED to resolve leaves the normal candidate order untouched', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const resolved = resolveBootSceneOverride('Level-9999', SCENES); // null — typo
    expect(resolveSceneCandidates('/assets/scenes/last-opened.json', '/assets/scenes/config-default.json', resolved)).toEqual([
      '/assets/scenes/last-opened.json',
      '/assets/scenes/config-default.json',
    ]);
    warn.mockRestore();
  });

  it('an override EQUAL to the remembered scene collapses rather than duplicating', () => {
    expect(resolveSceneCandidates('/assets/scenes/main.json', '/assets/scenes/config-default.json', '/assets/scenes/main.json')).toEqual([
      '/assets/scenes/main.json',
      '/assets/scenes/config-default.json',
    ]);
  });
});

describe('canonicalBootScenePath (gap #2 — boot the working-copy scene, not a bundle copy)', () => {
  const SCENE_GUID = '4bc54ae4-c5e5-4832-9c44-d45dcaa7412c';
  const CANON = '/assets/scenes/tropical-island.json';
  const BUNDLE = '/assets/tropical-island-DC3lOki3.json';

  const jsonResponse = (body: unknown, ok = true, status = 200): Response =>
    ({ ok, status, json: async () => body } as unknown as Response);

  beforeEach(() => clearManifest());

  it('maps a hashed bundle path to the canonical working-copy path via the scene GUID', async () => {
    registerAsset(SCENE_GUID, CANON, 'scene');
    const doFetch = vi.fn(async () => jsonResponse({ id: SCENE_GUID }));
    expect(await canonicalBootScenePath(BUNDLE, doFetch as never)).toBe(CANON);
    expect(doFetch).toHaveBeenCalledWith(BUNDLE, { cache: 'no-store' });
  });

  it('returns a candidate ALREADY registered in the manifest without fetching', async () => {
    registerAsset(SCENE_GUID, CANON, 'scene');
    const doFetch = vi.fn();
    expect(await canonicalBootScenePath(CANON, doFetch as never)).toBe(CANON);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it('falls back to the raw candidate when the scene GUID is not in the manifest', async () => {
    const doFetch = vi.fn(async () => jsonResponse({ id: SCENE_GUID })); // empty manifest
    expect(await canonicalBootScenePath(BUNDLE, doFetch as never)).toBe(BUNDLE);
  });

  it('falls back to the raw candidate on a non-OK fetch (e.g. stale hash 404)', async () => {
    registerAsset(SCENE_GUID, CANON, 'scene');
    const doFetch = vi.fn(async () => jsonResponse(null, false, 404));
    expect(await canonicalBootScenePath(BUNDLE, doFetch as never)).toBe(BUNDLE);
  });

  it('falls back to the raw candidate when the fetch throws', async () => {
    registerAsset(SCENE_GUID, CANON, 'scene');
    const doFetch = vi.fn(async () => { throw new Error('network'); });
    expect(await canonicalBootScenePath(BUNDLE, doFetch as never)).toBe(BUNDLE);
  });

  it('falls back to the raw candidate when the scene file id is missing or not a GUID', async () => {
    registerAsset(SCENE_GUID, CANON, 'scene');
    expect(await canonicalBootScenePath(BUNDLE, (async () => jsonResponse({ id: 'nope' })) as never)).toBe(BUNDLE);
    expect(await canonicalBootScenePath(BUNDLE, (async () => jsonResponse({})) as never)).toBe(BUNDLE);
  });

  /** Regression: on Windows, a `/@fs/<abs>` request for a file on a DIFFERENT DRIVE
   *  than the running Vite process's cwd silently 404s inside Vite's raw-fs `sirv`
   *  middleware and falls through to the SPA `index.html` (200 OK, not a real 404) —
   *  so a plain fetch-then-map approach can never distinguish "denied" from "success".
   *  A `/@fs/.../runtime/assets/...` candidate is rewritten to `/assets/...` directly,
   *  with NO fetch at all, so this can't happen. */
  it('rewrites a `/@fs/<abs>/runtime/assets/...` candidate to `/assets/...` without fetching', async () => {
    registerAsset(SCENE_GUID, '/assets/scenes/main.json', 'scene');
    const FS_PATH = '/@fs/E:/Projects/modoki/demos/postfx-demo/runtime/assets/scenes/main.json';
    const doFetch = vi.fn();
    expect(await canonicalBootScenePath(FS_PATH, doFetch as never)).toBe('/assets/scenes/main.json');
    expect(doFetch).not.toHaveBeenCalled();
  });

  /** findAssetRoots serves THREE roots ending in `/runtime/assets/`: `/assets` (the open
   *  project), `/modoki/assets` (engine built-ins) and `/<root>/<id>/assets` (every other
   *  project). The regex matches all three, so an unconfirmed rewrite would remap the
   *  latter two onto a same-named file under the OPEN project — a silent wrong-file load,
   *  strictly worse than the boot failure the rewrite exists to prevent. The manifest
   *  check is what rules that out, so pin it: no registration → no rewrite. */
  it('does NOT rewrite when the target is not registered for the open project', async () => {
    // Manifest is empty for `/assets/scenes/main.json` → the rewrite must be discarded.
    const OTHER_PROJECT = '/@fs/E:/Projects/modoki/games/some-other-game/runtime/assets/scenes/main.json';
    const doFetch = vi.fn(async () => jsonResponse(null, false, 404));
    expect(await canonicalBootScenePath(OTHER_PROJECT, doFetch as never)).toBe(OTHER_PROJECT);
  });

  it('does not rewrite a foreign-root candidate when its tail is unregistered', async () => {
    // The engine's built-ins live under `/modoki/assets`, not `/assets`. With nothing
    // registered at the rewritten tail, the candidate is left alone rather than being
    // remapped onto the open project.
    registerAsset(SCENE_GUID, '/modoki/assets/scenes/white.json', 'scene');
    const ENGINE_BUILTIN = '/@fs/E:/Projects/modoki/engine/packages/modoki/src/runtime/assets/scenes/white.json';
    const doFetch = vi.fn(async () => jsonResponse(null, false, 404));
    expect(await canonicalBootScenePath(ENGINE_BUILTIN, doFetch as never)).toBe(ENGINE_BUILTIN);
  });

  it('leaves a `/@fs/...` candidate with no `runtime/assets` segment untouched (falls through to fetch)', async () => {
    const doFetch = vi.fn(async () => jsonResponse(null, false, 404));
    const FS_PATH = '/@fs/E:/Projects/modoki/demos/postfx-demo/game.ts';
    expect(await canonicalBootScenePath(FS_PATH, doFetch as never)).toBe(FS_PATH);
    expect(doFetch).toHaveBeenCalledWith(FS_PATH, { cache: 'no-store' });
  });

  /** Closes the "KNOWN LIMITATION" above: when the open project's root is known,
   *  disambiguate by ORIGIN instead of manifest name-match — no fetch, no manifest
   *  dependency, so it can't race a cold-boot manifest that hasn't caught up yet. */
  describe('origin-based confirmation (projectRoot param)', () => {
    it('rewrites when the `/@fs/<abs>` prefix is inside the open project root — no manifest, no fetch', async () => {
      const FS_PATH = '/@fs/E:/Projects/modoki/games/sling/runtime/assets/scenes/Lvl-0001.json';
      const doFetch = vi.fn();
      const result = await canonicalBootScenePath(FS_PATH, doFetch as never, 'E:\\Projects\\modoki\\games\\sling');
      expect(result).toBe('/assets/scenes/Lvl-0001.json');
      expect(doFetch).not.toHaveBeenCalled();
    });

    it('does NOT rewrite a sibling project even if the manifest would have matched it by name', async () => {
      registerAsset(SCENE_GUID, '/assets/scenes/main.json', 'scene');
      const OTHER_PROJECT = '/@fs/E:/Projects/modoki/games/some-other-game/runtime/assets/scenes/main.json';
      const doFetch = vi.fn();
      const result = await canonicalBootScenePath(OTHER_PROJECT, doFetch as never, 'E:\\Projects\\modoki\\games\\sling');
      expect(result).toBe(OTHER_PROJECT);
      expect(doFetch).not.toHaveBeenCalled();
    });

    it('is segment-aware — a prefix-sharing sibling folder is not treated as inside the root', async () => {
      const FS_PATH = '/@fs/E:/Projects/modoki/games/sling-evil/runtime/assets/scenes/main.json';
      const result = await canonicalBootScenePath(FS_PATH, (async () => jsonResponse(null, false, 404)) as never, 'E:\\Projects\\modoki\\games\\sling');
      expect(result).toBe(FS_PATH);
    });

    it('is case-insensitive and separator-insensitive (Windows drive letter, slash direction)', async () => {
      const FS_PATH = '/@fs/e:/Projects/Modoki/Games/SLING/runtime/assets/scenes/Lvl-0001.json';
      const doFetch = vi.fn();
      const result = await canonicalBootScenePath(FS_PATH, doFetch as never, 'E:\\projects\\modoki\\games\\sling');
      expect(result).toBe('/assets/scenes/Lvl-0001.json');
      expect(doFetch).not.toHaveBeenCalled();
    });

    it('falls back to the manifest-based check when projectRoot is not supplied', async () => {
      registerAsset(SCENE_GUID, '/assets/scenes/main.json', 'scene');
      const FS_PATH = '/@fs/E:/Projects/modoki/demos/postfx-demo/runtime/assets/scenes/main.json';
      const doFetch = vi.fn();
      expect(await canonicalBootScenePath(FS_PATH, doFetch as never)).toBe('/assets/scenes/main.json');
      expect(doFetch).not.toHaveBeenCalled();
    });
  });
});

describe('loadFirstScene (boot loop: canonicalize → load, raw fallback)', () => {
  const BUNDLE = '/assets/tropical-island-DC3lOki3.json';
  const CANON = '/assets/scenes/tropical-island.json';

  it('canonicalizes a candidate and loads the canonical path', async () => {
    const canonicalize = vi.fn(async () => CANON);
    const load = vi.fn(async (): Promise<SceneLoadOutcome> => 'loaded');
    expect(await loadFirstScene([BUNDLE], { canonicalize, load })).toBe(CANON);
    expect(canonicalize).toHaveBeenCalledWith(BUNDLE);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith(CANON);
  });

  it('falls back to the RAW candidate when the canonical path fails to load', async () => {
    const canonicalize = vi.fn(async () => CANON);
    const load = vi.fn(async (p: string): Promise<SceneLoadOutcome> => (p === BUNDLE ? 'loaded' : 'failed')); // canonical fails, raw loads
    expect(await loadFirstScene([BUNDLE], { canonicalize, load })).toBe(BUNDLE);
    expect(load).toHaveBeenNthCalledWith(1, CANON);
    expect(load).toHaveBeenNthCalledWith(2, BUNDLE);
  });

  /** Regression: a THROWING candidate used to abort the whole fallback chain.
   *  loadScene rejects (rather than returning false) when the host serves the dev
   *  server's SPA index.html instead of the scene JSON — `JSON.parse` throws
   *  `Unexpected token '<'`. That escaped the loop, so the next candidate was never
   *  tried and editor boot died. Real case: a stale `/@fs/<abs>` last-scene for a
   *  project on a different Windows drive (vitejs/vite#12816). */
  const HTML_ERR = new SyntaxError(`Unexpected token '<', "<!doctype "... is not valid JSON`);

  it('advances to the next candidate when a candidate THROWS (SPA html fallback)', async () => {
    const STALE = '/@fs/C:/Users/x/Desktop/test/runtime/assets/scenes/main.json';
    const canonicalize = vi.fn(async (p: string) => p);
    const load = vi.fn(async (p: string): Promise<SceneLoadOutcome> => {
      if (p === STALE) throw HTML_ERR; // dev server served index.html
      return 'loaded';
    });
    expect(await loadFirstScene([STALE, CANON], { canonicalize, load })).toBe(CANON);
    expect(load).toHaveBeenNthCalledWith(1, STALE);
    expect(load).toHaveBeenNthCalledWith(2, CANON);
  });

  it('returns null (does not reject) when EVERY candidate throws', async () => {
    const canonicalize = vi.fn(async (p: string) => p);
    const load = vi.fn(async (): Promise<SceneLoadOutcome> => { throw HTML_ERR; });
    await expect(loadFirstScene([BUNDLE, CANON], { canonicalize, load })).resolves.toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
  });

  /** #91 — a boot that RECOVERS on a later candidate must leave no console.error behind.
   *  `smoke-packaged.sh` and `assert-app-renders.sh` both fail on ANY renderer console error,
   *  so a stale remembered scene path could fail a packaging gate for a reason that has
   *  nothing to do with the commit under test. Misses are `warn`; only a total failure is an
   *  `error`. */
  it('logs NO console.error when a later candidate recovers the boot', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const canonicalize = vi.fn(async (p: string) => p);
      const load = vi.fn(async (p: string): Promise<SceneLoadOutcome> => (p === CANON ? 'loaded' : 'failed'));
      expect(await loadFirstScene([BUNDLE, CANON], { canonicalize, load })).toBe(CANON);
      expect(err).not.toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });

  /** ZERO candidates means "no scene configured/remembered" (a fresh project, or the e2e
   *  harness — measured: every e2e spec boots this way), not a failure. Nothing was tried, so
   *  an error here would recreate the very false-failure #91 is about, given both packaging
   *  gates fail on ANY console error. */
  it('logs NOTHING when there are no candidates at all', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const canonicalize = vi.fn(async (p: string) => p);
      const load = vi.fn(async (): Promise<SceneLoadOutcome> => 'loaded');
      expect(await loadFirstScene([], { canonicalize, load })).toBeNull();
      expect(load).not.toHaveBeenCalled();
      expect(err).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      err.mockRestore();
      warn.mockRestore();
    }
  });

  it('logs exactly ONE console.error, naming every candidate, when they all miss', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const canonicalize = vi.fn(async (p: string) => p);
      const load = vi.fn(async (): Promise<SceneLoadOutcome> => 'failed');
      expect(await loadFirstScene([BUNDLE, CANON], { canonicalize, load })).toBeNull();
      expect(err).toHaveBeenCalledTimes(1);
      const msg = String(err.mock.calls[0]?.[0]);
      expect(msg).toContain(BUNDLE);
      expect(msg).toContain(CANON);
    } finally {
      err.mockRestore();
    }
  });

  it('falls back to the RAW candidate when the CANONICAL one throws', async () => {
    const canonicalize = vi.fn(async () => CANON);
    const load = vi.fn(async (p: string): Promise<SceneLoadOutcome> => {
      if (p === CANON) throw HTML_ERR;
      return 'loaded';
    });
    expect(await loadFirstScene([BUNDLE], { canonicalize, load })).toBe(BUNDLE);
  });

  it('survives a THROWING canonicalize by using the raw candidate', async () => {
    const canonicalize = vi.fn(async () => { throw new Error('network down'); });
    const load = vi.fn(async (): Promise<SceneLoadOutcome> => 'loaded');
    expect(await loadFirstScene([BUNDLE], { canonicalize, load })).toBe(BUNDLE);
    expect(load).toHaveBeenCalledWith(BUNDLE);
  });

  it('does NOT double-load when the candidate is already canonical', async () => {
    const canonicalize = vi.fn(async (p: string) => p); // already canonical
    const load = vi.fn(async (): Promise<SceneLoadOutcome> => 'failed');
    expect(await loadFirstScene([CANON], { canonicalize, load })).toBeNull();
    expect(load).toHaveBeenCalledTimes(1); // no raw-fallback retry (canonical === candidate)
  });

  it('advances to the next candidate when both canonical and raw fail', async () => {
    const canonicalize = vi.fn(async (p: string) => `${p}#canon`);
    const order: string[] = [];
    const load = vi.fn(async (p: string): Promise<SceneLoadOutcome> => { order.push(p); return p === '/b.json#canon' ? 'loaded' : 'failed'; });
    expect(await loadFirstScene(['/a.json', '/b.json'], { canonicalize, load })).toBe('/b.json#canon');
    // a canonical, a raw, then b canonical (succeeds → stops before b raw).
    expect(order).toEqual(['/a.json#canon', '/a.json', '/b.json#canon']);
  });

  it('stops at the first success without touching later candidates', async () => {
    const canonicalize = vi.fn(async (p: string) => p);
    const load = vi.fn(async (): Promise<SceneLoadOutcome> => 'loaded');
    expect(await loadFirstScene([CANON, '/other.json'], { canonicalize, load })).toBe(CANON);
    expect(canonicalize).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('returns null when no candidate loads (→ initWorld/empty-camera path)', async () => {
    const canonicalize = vi.fn(async (p: string) => p);
    const load = vi.fn(async (): Promise<SceneLoadOutcome> => 'failed');
    expect(await loadFirstScene(['/a.json', '/b.json'], { canonicalize, load })).toBeNull();
    expect(await loadFirstScene([], { canonicalize, load })).toBeNull();
  });

  /** #495: a candidate that comes back 'superseded' (another load — an agent op, a rapid
   *  second boot — won the swap first) must STOP the fallback walk, not treat it as a miss
   *  and try the next candidate. Continuing would load a THIRD scene over whichever one
   *  actually won. */
  it('stops the walk on a "superseded" candidate — does NOT try the next one', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const canonicalize = vi.fn(async (p: string) => p);
      const load = vi.fn(async (): Promise<SceneLoadOutcome> => 'superseded');
      expect(await loadFirstScene([BUNDLE, CANON], { canonicalize, load })).toBeNull();
      expect(load).toHaveBeenCalledTimes(1); // never reached the second candidate
      expect(info).toHaveBeenCalledTimes(1);
      expect(String(info.mock.calls[0]?.[0])).toContain(BUNDLE);
    } finally {
      info.mockRestore();
    }
  });

  /** #495, the half that is NOT about stopping the walk: what a supersede RESOLVES TO.
   *  `null` means "no candidate loaded" to this function's caller, which answers it by running
   *  `config.initWorld()` and `setCurrentScenePath(candidates[last])` — destroying the world the
   *  WINNING load just installed and then naming a scene that is not loaded. That is strictly
   *  worse than the reporting bug #495 is about, so a supersede must resolve to the scene that
   *  actually won whenever there is one. `null` survives only for "nothing is loaded at all",
   *  which is precisely when initWorld IS the right answer. */
  it('a superseded candidate resolves to the scene that actually WON, not null (#495)', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const cur = vi.spyOn(sceneManager, 'getCurrent').mockReturnValue({ id: 9, path: '/winner.scene.json', state: 'active' } as never);
    try {
      const canonicalize = vi.fn(async (p: string) => p);
      const load = vi.fn(async (): Promise<SceneLoadOutcome> => 'superseded');
      expect(await loadFirstScene([BUNDLE, CANON], { canonicalize, load })).toBe('/winner.scene.json');
      expect(String(info.mock.calls[0]?.[0])).toContain('/winner.scene.json');
    } finally {
      info.mockRestore();
      cur.mockRestore();
    }
  });

  it('a supersede with NOTHING active still resolves null — initWorld is the right answer there (#495)', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const cur = vi.spyOn(sceneManager, 'getCurrent').mockReturnValue(null as never);
    try {
      const canonicalize = vi.fn(async (p: string) => p);
      const load = vi.fn(async (): Promise<SceneLoadOutcome> => 'superseded');
      expect(await loadFirstScene([BUNDLE], { canonicalize, load })).toBeNull();
    } finally {
      info.mockRestore();
      cur.mockRestore();
    }
  });

  it('a "superseded" RAW-candidate retry also stops the walk', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const canonicalize = vi.fn(async () => CANON);
      const load = vi.fn(async (p: string): Promise<SceneLoadOutcome> => (p === CANON ? 'failed' : 'superseded'));
      expect(await loadFirstScene([BUNDLE, '/other.json'], { canonicalize, load })).toBeNull();
      expect(load).toHaveBeenNthCalledWith(1, CANON);
      expect(load).toHaveBeenNthCalledWith(2, BUNDLE);
      expect(load).toHaveBeenCalledTimes(2); // never reached '/other.json'
      expect(info).toHaveBeenCalledTimes(1);
    } finally {
      info.mockRestore();
    }
  });
});

describe('awaitRendererReady', () => {
  it('resolves when ready settles first and clears BOTH pending timers (soft + hard)', async () => {
    let n = 0;
    const setT = vi.fn(() => (++n) as unknown as ReturnType<typeof setTimeout>);
    const clearT = vi.fn();
    await awaitRendererReady(Promise.resolve(), 120_000, { setTimeout: setT as never, clearTimeout: clearT as never });
    // Two timers are armed (hard cap + soft warning) and BOTH are cleared on success.
    expect(setT).toHaveBeenCalledTimes(2);
    expect(clearT).toHaveBeenCalledTimes(2);
    expect(clearT.mock.calls.map((c) => c[0]).sort()).toEqual([1, 2]);
  });

  it('rejects when the HARD timeout fires — the soft warning does NOT settle the race', async () => {
    const cbs = new Map<number, () => void>(); // delay → cb (handle == delay)
    const setT = vi.fn((cb: () => void, delay: number) => { cbs.set(delay, cb); return delay as unknown as ReturnType<typeof setTimeout>; });
    const clearT = vi.fn();
    const onSoftTimeout = vi.fn();
    const p = awaitRendererReady(new Promise(() => {}), 120_000, { setTimeout: setT as never, clearTimeout: clearT as never }, { softTimeoutMs: 15_000, onSoftTimeout });
    cbs.get(15_000)!();  // soft deadline elapses first — a warning, NOT a rejection
    expect(onSoftTimeout).toHaveBeenCalledTimes(1);
    cbs.get(120_000)!(); // hard deadline elapses — THIS rejects
    await expect(p).rejects.toThrow(/rendererReady did not resolve within 120000ms/);
    expect(clearT).toHaveBeenCalledTimes(2); // both handles cleared, no dangling timer
  });

  it('a definitive init FAILURE rejects immediately, without burning the cold-start budget', async () => {
    // The wedge this closes: renderer creation threw at ~1.5s, but nothing could distinguish
    // "failed" from "still warming up", so the editor sat blank for the full 120s before
    // saying anything. A failure signal must short-circuit the budget outright.
    const setT = vi.fn((_cb: () => void, delay: number) => delay as unknown as ReturnType<typeof setTimeout>);
    const clearT = vi.fn();
    const failed = Promise.resolve(new Error('WebGPU adapter unavailable'));

    const p = awaitRendererReady(
      new Promise(() => {}), // never ready
      120_000,
      { setTimeout: setT as never, clearTimeout: clearT as never },
      { failed, progress: () => 'creating renderer (attempt 4)' },
    );

    // Rejects on the FAILURE, not the timeout — and carries the real cause, not a guess.
    await expect(p).rejects.toThrow(/renderer init FAILED/);
    await expect(p).rejects.toThrow(/WebGPU adapter unavailable/);
    // No timer was left pending; the hard deadline never got a chance to fire.
    expect(clearT).toHaveBeenCalledTimes(2);
  });

  it('a pending failure promise does not disturb the happy path', async () => {
    const setT = vi.fn((_cb: () => void, delay: number) => delay as unknown as ReturnType<typeof setTimeout>);
    const clearT = vi.fn();
    await awaitRendererReady(
      Promise.resolve(), 120_000,
      { setTimeout: setT as never, clearTimeout: clearT as never },
      { failed: new Promise<Error>(() => {}) }, // never fails — the normal case
    );
    expect(clearT).toHaveBeenCalledTimes(2);
  });

  it('the timeout message reports measured progress instead of asserting a cause', async () => {
    const cbs = new Map<number, () => void>();
    const setT = vi.fn((cb: () => void, delay: number) => { cbs.set(delay, cb); return delay as unknown as ReturnType<typeof setTimeout>; });
    const clearT = vi.fn();
    const p = awaitRendererReady(
      new Promise(() => {}), 120_000,
      { setTimeout: setT as never, clearTimeout: clearT as never },
      { softTimeoutMs: 15_000, onSoftTimeout: () => {}, progress: () => 'viewport effect never entered' },
    );
    cbs.get(120_000)!();
    // The old text claimed "SceneView never called setActiveRenderer" and pointed at a console
    // level the failure was never logged at. Facts only now.
    await expect(p).rejects.toThrow(/Last renderer bring-up progress: viewport effect never entered/);
    await expect(p).rejects.not.toThrow(/Check the browser console/);
  });

  it('fails FAST when no viewport ever began renderer creation', async () => {
    // "Nothing started" and "renderer is slow" used to be indistinguishable, so the
    // never-started case waited out the full 120s cold-start budget for no reason.
    const cbs = new Map<number, () => void>();
    const setT = vi.fn((cb: () => void, delay: number) => { cbs.set(delay, cb); return delay as unknown as ReturnType<typeof setTimeout>; });
    const clearT = vi.fn();
    const p = awaitRendererReady(
      new Promise(() => {}), 120_000,
      { setTimeout: setT as never, clearTimeout: clearT as never },
      { hasViewportBegun: () => false, noViewportMs: 12_000 },
    );
    cbs.get(12_000)!(); // the SHORT deadline, not the 120s one
    await expect(p).rejects.toThrow(/no 3D viewport began renderer creation within 12000ms/);
    await expect(p).rejects.toThrow(/NOT a slow cold start/);
    // The scene-load gate this message used to guard was removed (docs/editor.md,
    // `createEditor()`) — the scene loads regardless of a viewport, so the message must no
    // longer claim otherwise.
    await expect(p).rejects.not.toThrow(/no scene can load/);
    await expect(p).rejects.not.toThrow(/scene could load/);
  });

  it('suppresses the no-viewport rejection entirely when shouldWarnNoViewport() returns false', async () => {
    // A 2D/UI-only project (resolved `build.modules.render3d === false`) should never see "no
    // 3D viewport" — it's noise, not diagnosis (Phase 2.5). Suppressing must not reject with a
    // DIFFERENT message either — the promise should simply never settle via this branch.
    const cbs = new Map<number, () => void>();
    const setT = vi.fn((cb: () => void, delay: number) => { cbs.set(delay, cb); return delay as unknown as ReturnType<typeof setTimeout>; });
    const clearT = vi.fn();
    let resolveReady: () => void = () => {};
    const ready = new Promise<void>((r) => { resolveReady = r; });
    const p = awaitRendererReady(
      ready, 120_000,
      { setTimeout: setT as never, clearTimeout: clearT as never },
      { hasViewportBegun: () => false, noViewportMs: 12_000, shouldWarnNoViewport: () => false },
    );
    cbs.get(12_000)!(); // fires, but suppressed — must not reject
    resolveReady();     // settle via the `ready` branch instead
    await expect(p).resolves.toBeUndefined();
  });

  it('still fires the no-viewport rejection when shouldWarnNoViewport() returns true', async () => {
    const cbs = new Map<number, () => void>();
    const setT = vi.fn((cb: () => void, delay: number) => { cbs.set(delay, cb); return delay as unknown as ReturnType<typeof setTimeout>; });
    const clearT = vi.fn();
    const p = awaitRendererReady(
      new Promise(() => {}), 120_000,
      { setTimeout: setT as never, clearTimeout: clearT as never },
      { hasViewportBegun: () => false, noViewportMs: 12_000, shouldWarnNoViewport: () => true },
    );
    cbs.get(12_000)!();
    await expect(p).rejects.toThrow(/no 3D viewport began renderer creation within 12000ms/);
  });

  it('warns by default (fail-open) when shouldWarnNoViewport is omitted — the old behaviour', async () => {
    const cbs = new Map<number, () => void>();
    const setT = vi.fn((cb: () => void, delay: number) => { cbs.set(delay, cb); return delay as unknown as ReturnType<typeof setTimeout>; });
    const clearT = vi.fn();
    const p = awaitRendererReady(
      new Promise(() => {}), 120_000,
      { setTimeout: setT as never, clearTimeout: clearT as never },
      { hasViewportBegun: () => false, noViewportMs: 12_000 },
    );
    cbs.get(12_000)!();
    await expect(p).rejects.toThrow(/no 3D viewport began renderer creation/);
  });

  it('suppression also silences the SOFT (15s) nudge when no viewport is expected', async () => {
    // Observed live on a render3d:false project (games/court): the 12s message was correctly
    // suppressed, but the DEFAULT onSoftTimeout still fired at 15s — a real gap, since the
    // owner's ask was "no warnings at all" for a 2D-only project, not "just the 12s one".
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cbs = new Map<number, () => void>();
    const setT = vi.fn((cb: () => void, delay: number) => { cbs.set(delay, cb); return delay as unknown as ReturnType<typeof setTimeout>; });
    const clearT = vi.fn();
    const p = awaitRendererReady(
      new Promise(() => {}), 120_000,
      { setTimeout: setT as never, clearTimeout: clearT as never },
      { softTimeoutMs: 15_000, hasViewportBegun: () => false, shouldWarnNoViewport: () => false },
    );
    cbs.get(15_000)!(); // the soft deadline fires, but must stay silent
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    void p; // never settles via any branch in this test — deliberately left pending
  });

  it('suppression also silences the HARD (120s) cap when no viewport is expected', async () => {
    const cbs = new Map<number, () => void>();
    const setT = vi.fn((cb: () => void, delay: number) => { cbs.set(delay, cb); return delay as unknown as ReturnType<typeof setTimeout>; });
    const clearT = vi.fn();
    let resolveReady: () => void = () => {};
    const ready = new Promise<void>((r) => { resolveReady = r; });
    const p = awaitRendererReady(
      ready, 120_000,
      { setTimeout: setT as never, clearTimeout: clearT as never },
      { hasViewportBegun: () => false, shouldWarnNoViewport: () => false },
    );
    cbs.get(120_000)!(); // the hard cap fires, but must not reject
    resolveReady();      // settle via the `ready` branch instead, proving nothing rejected first
    await expect(p).resolves.toBeUndefined();
  });

  it('suppression LIFTS once a viewport begins — soft/hard reporting resumes for that attempt', async () => {
    // Per the owner's decision: a viewport that DOES start (e.g. the user opens a Scene panel
    // on a 2D project anyway) makes renderer health relevant again.
    let viewportBegan = false;
    const cbs = new Map<number, () => void>();
    const setT = vi.fn((cb: () => void, delay: number) => { cbs.set(delay, cb); return delay as unknown as ReturnType<typeof setTimeout>; });
    const clearT = vi.fn();
    const p = awaitRendererReady(
      new Promise(() => {}), 120_000,
      { setTimeout: setT as never, clearTimeout: clearT as never },
      { hasViewportBegun: () => viewportBegan, shouldWarnNoViewport: () => false },
    );
    viewportBegan = true; // a viewport started AFTER boot, before the hard cap fires
    cbs.get(120_000)!();
    await expect(p).rejects.toThrow(/rendererReady did not resolve within 120000ms/);
  });

  it('does NOT fail fast when bring-up is genuinely underway — the long budget still applies', async () => {
    // The whole point of splitting the budgets: a slow-but-progressing cold start must keep
    // its generous allowance. Firing the short deadline here would re-break the original bug.
    const cbs = new Map<number, () => void>();
    const setT = vi.fn((cb: () => void, delay: number) => { cbs.set(delay, cb); return delay as unknown as ReturnType<typeof setTimeout>; });
    const clearT = vi.fn();
    let resolveReady: () => void = () => {};
    const ready = new Promise<void>((r) => { resolveReady = r; });
    const p = awaitRendererReady(
      ready, 120_000,
      { setTimeout: setT as never, clearTimeout: clearT as never },
      { hasViewportBegun: () => true, noViewportMs: 12_000 },
    );
    cbs.get(12_000)!();   // elapses, but a viewport IS working — must NOT reject
    resolveReady();       // the slow cold start eventually finishes
    await expect(p).resolves.toBeUndefined();
  });

  it('the SOFT warning fires but a slow cold start still RECOVERS (does not abort the scene load)', async () => {
    const cbs = new Map<number, () => void>();
    const setT = vi.fn((cb: () => void, delay: number) => { cbs.set(delay, cb); return delay as unknown as ReturnType<typeof setTimeout>; });
    const clearT = vi.fn();
    const onSoftTimeout = vi.fn();
    let resolveReady: () => void = () => {};
    const ready = new Promise<void>((r) => { resolveReady = r; });
    const p = awaitRendererReady(ready, 120_000, { setTimeout: setT as never, clearTimeout: clearT as never }, { softTimeoutMs: 15_000, onSoftTimeout });
    cbs.get(15_000)!();  // soft deadline elapses — renderer still warming up (cold dep-optimize)
    expect(onSoftTimeout).toHaveBeenCalledTimes(1);
    resolveReady();      // …then the renderer finally readies before the hard cap
    await expect(p).resolves.toBeUndefined(); // recovered — NOT rejected
  });

  it('still clears BOTH timers when ready settles AFTER being slow (no dangling timer)', async () => {
    let resolveReady: () => void = () => {};
    const ready = new Promise<void>((r) => { resolveReady = r; });
    let n = 0;
    const setT = vi.fn(() => (++n) as unknown as ReturnType<typeof setTimeout>);
    const clearT = vi.fn();
    const p = awaitRendererReady(ready, 120_000, { setTimeout: setT as never, clearTimeout: clearT as never });
    resolveReady(); // late but before the (mocked, never-fired) deadline
    await p;
    expect(clearT.mock.calls.map((c) => c[0]).sort()).toEqual([1, 2]);
  });

  it('defaults to a generous 120s HARD deadline with a 15s SOFT warning', () => {
    expect(RENDERER_READY_TIMEOUT_MS).toBe(120_000);
    expect(RENDERER_READY_SOFT_TIMEOUT_MS).toBe(15_000);
  });

  // Regression: the DEFAULT timers must be globalThis-bound. Calling the real default
  // path (no injected timers) on a ready promise once threw "Illegal invocation" in the
  // browser because `timers.setTimeout(...)` ran with `this === timers`. The injected-timer
  // tests above can't catch this — they never use the default. This one does.
  it('works with the real default timers (no injected timers) — no Illegal invocation', async () => {
    await expect(awaitRendererReady(Promise.resolve())).resolves.toBeUndefined();
  });
});

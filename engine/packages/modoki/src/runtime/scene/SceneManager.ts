/** SceneManager — orchestrates async scene loading with two-world isolation.
 *
 *  Lifecycle of `loadScene(path)`:
 *  1. Cancel any in-flight load (release its acquired resources, drop its world)
 *  2. Allocate a fresh sceneId + nextWorld
 *  3. Fetch the scene JSON, run migrations
 *  4. Acquire all resources from the manifest in parallel (Promise.all)
 *  5. Spawn entities into nextWorld via loadSceneFile (entities are dormant
 *     because nextWorld isn't the active world — no system runs against it)
 *  6. Atomic swap:
 *      a. (Phase 5) Serialize persistent entities from mainWorld + respawn into nextWorld
 *      b. setCurrentWorld(nextWorld) — fires onWorldSwap; renderers clear caches
 *      c. releaseAllForScene(oldSceneId) — refcounts drop; resources only
 *         held by the old scene get disposed
 *  7. Resolve the promise
 *
 *  Concurrency: cancel-and-replace. Only one preload in flight; calling
 *  loadScene() while another is loading aborts the in-flight load.
 *
 *  Failure: if any step fails, release the next-scene's acquired resources and
 *  reject the promise. The current scene is untouched.
 */

import { createWorld, type World, type Entity } from 'koota';
import { setCurrentWorld, getCurrentWorld, registerEntity } from '../core/ecs/world';
import { getAllTraits } from '../core/ecs/traitRegistry';
import { resolveKootaSchema } from './sceneSchema';
import { resolveSceneChain, type SceneRef, type FetchSceneMeta } from './sceneChain';
import { emit } from '../core/journal';
import { clearAllOverrideMarks, getOverrideMarkSet, markOverride } from '../loaders/overrideMarks';
import { SCENE_FORMAT_VERSION } from '../core/version';

import { Persistent } from '../traits/Persistent';
import { Time } from '../core/traits/Time';
import { Transient } from '../traits/Transient';
import { Input } from '../traits/Input';
import {
  acquireMaterial, acquireMesh, acquireModel, acquirePrefab, acquireEnvironment,
  releaseAllForScene, getCachedPrefab,
  type SceneId,
} from '../loaders/meshTemplateCache';
import { acquireRiggedModel } from '../loaders/riggedModelCache';
import { acquireAudio } from '../loaders/audioBufferCache';
import { acquireFont } from '../loaders/fontAtlasLoader';
import { registerAsset, isGuid, resolveRef, resolveGuidToPath, getAudioLoadType } from '../loaders/assetManifest';
import { loadTimelineNow } from '../loaders/timelineCache';
import { collectTimelineAudioRefs, collectTimelineControlRefs } from '../timeline/types';
import { ASSET_FETCH_INIT } from '../loaders/assetFetch';
import { assetUrl } from '../loaders/assetUrl';
import {
  loadSceneFile,
  collectResourceRefsFromEntities,
  instantiatePrefabIntoWorld,
  type SceneData,
  type SceneResourceRef,
  type SceneEntityEntry,
} from '../loaders/loadSceneFile';
import {
  disposeActiveSceneManagers, initSceneManagersFor,
  disposeActiveGameManagers, initGameManagersFor, getActiveGameId,
} from '../managers/managerRegistry';

export type SceneState = 'loading' | 'ready' | 'active' | 'unloading';

export interface Scene {
  readonly id: SceneId;
  readonly path: string;
  readonly state: SceneState;
}

export interface LoadOptions {
  /** Reports progress as resources finish loading. */
  onProgress?: (loaded: number, total: number) => void;
  /** External abort signal — caller can cancel via AbortController. */
  signal?: AbortSignal;
  /** Pre-parsed scene data — skips the network fetch. Used by the dev hot-reload
   *  path, which already fetched the file to validate it (avoids a second GET). */
  preloaded?: SceneData;
  /** The game this scene belongs to, for game-scoped manager lifecycle. Set it
   *  on a real game switch (production routes through `App.tsx`, which knows the
   *  id) so game-scoped managers swap. Omit for in-game scene swaps and editor
   *  loads — the id is then derived from the scene path (a dev-only fallback;
   *  production paths can be hashed) and, if underivable, the active game is left
   *  unchanged so cross-scene managers persist (e.g. Station↔Warp). Pass `null`
   *  to explicitly clear the active game (e.g. returning to the menu). */
  gameId?: string | null;
  /** Base-scene guids to treat as NOT kept even though their guid matches the old
   *  chain — i.e. force them into toDrop+toLoad so they re-fetch from disk instead
   *  of being carried from the in-memory snapshot. A base scene's own guid never
   *  changes when its FILE is edited, so a normal reload of the primary always
   *  treats it as "kept" and never sees the edit (A7, base-scene-and-persistence-
   *  plan.md) — this is the escape hatch. Used by the dev-server hot-reload path
   *  when the changed file is a base, not the primary itself. */
  forceReloadBases?: string[];
}

/** Derive a project id from a scene path by the `games/<id>/` or `demos/<id>/`
 *  project convention (the two project roots — see engine/scripts/projectRoots.mjs).
 *  Reliable under the dev server (unhashed asset URLs); returns null when the
 *  path doesn't carry a project segment (hashed production URLs, a standalone flat
 *  project whose assets serve at /assets, the menu, a prefab-edit world). Callers
 *  that know the id should pass `opts.gameId` instead of relying on this. */
export function gameIdFromScenePath(path: string): string | null {
  const m = path.match(/(?:^|\/)(?:games|demos)\/([^/]+)\//);
  return m ? m[1] : null;
}

/** Called after the staging world is fully populated but BEFORE setCurrentWorld
 *  fires. Renderers use this hook to pre-warm shader programs (compileAsync),
 *  so the first frame after swap doesn't stutter. Errors are logged and swallowed. */
export type BeforeSwapHook = (stagingWorld: World) => Promise<void>;

/** A currently-loaded scene's bookkeeping. `createdAt` is the FILE's own creation
 *  stamp (scene-loading.md, Phase 1) — captured here at load time from
 *  the raw parsed JSON (an untyped field; not part of `SceneData`) so a later save
 *  can re-emit the ORIGINAL value instead of `serializeScene` unconditionally
 *  minting a fresh one. Absent for a scene with no prior stamp (e.g. one authored
 *  before this field existed) — `serializeScene` mints a fresh one only in that
 *  case. */
export type LoadedSceneEntry = { path: string; guid: string; role: 'primary' | 'base'; baseScene?: string; createdAt?: string };

/** Public surface of the {@link sceneManager} singleton. See the module doc above. */
export interface SceneManager {
  /** Register an async hook that runs after entities are spawned into the
   *  staging world but before the atomic swap. Use for shader prewarm. */
  registerBeforeSwap(hook: BeforeSwapHook): void;
  /** Remove a previously-registered beforeSwap hook. */
  unregisterBeforeSwap(hook: BeforeSwapHook): void;
  /** Register a callback to run after a specific scene loads (by path or substring match).
   *  Use '*' as path to match all scenes. */
  registerSceneCallback(pathPattern: string, callback: () => void): void;
  /** Remove a previously registered scene callback. */
  unregisterSceneCallback(pathPattern: string): void;
  /** The currently-active scene. null until the first loadScene() resolves.
   *  Returns the PRIMARY scene — the one `loadScene(path)` was called with, as
   *  opposed to a base loaded additively alongside it. */
  getCurrent(): Scene | null;
  /** Every scene currently loaded into the active world — the primary plus any
   *  base scenes in its chain. */
  getLoadedScenes(): ReadonlyMap<SceneId, LoadedSceneEntry>;
  /** The `baseScene` guid ref of the currently-active scene, if any. */
  getCurrentBaseScene(): string | undefined;
  /** The scene currently preloading (if any). */
  getNext(): Scene | null;
  /** Load a scene file. Cancels any in-flight load. Resolves when the swap is
   *  complete and the new scene is active. Rejects if the load fails or is
   *  aborted (the current scene remains untouched on failure). */
  loadScene(path: string, opts?: LoadOptions): Promise<void>;
  /** For tests + shutdown. Releases everything and resets the manager. */
  unloadAll(): Promise<void>;
  /** For tests: reset the sceneId counter so test runs are deterministic. */
  resetForTesting(): void;
}

class SceneManagerImpl implements SceneManager {
  // Multi-scene internals (base-scene plan, Phase 2). With no scene ever declaring
  // `baseScene` yet, every load populates exactly one entry with role 'primary' —
  // behaviourally identical to the old single `currentScene` field. Phase 5 is what
  // actually populates more than one entry (a resolved chain).
  private loadedScenes = new Map<SceneId, LoadedSceneEntry>();
  private primaryId: SceneId | null = null;
  // The active scene's `baseScene` ref (base-scene persistence), if any. Not yet
  // wired into the load/carry pipeline (that's Phase 5) — Phase 1 only threads
  // the format field through so the editor can read/round-trip it.
  private currentBaseScene: string | undefined;
  private nextLoad: { id: SceneId; path: string; controller: AbortController } | null = null;
  private nextSceneId: SceneId = 1;
  // Both registries below are APP-LIFETIME singletons owned by their registrant's
  // lifecycle, NOT scene-scoped — `unloadAll` deliberately does not blanket-clear them
  // (the beforeSwap hooks are register/unregister-paired in the Scene2D/Scene3D React
  // effects; clearing them on a teardown would orphan a still-mounted component's hook).
  // For a reaction that should live and die with a scene, use the Manager registry
  // (initSceneManagersFor / disposeActiveSceneManagers), which disposes correctly. A
  // future per-scene caller of registerSceneCallback WITHOUT a matching unregister would
  // leak — prefer a Manager. (scene-managers F7)
  private sceneCallbacks = new Map<string, () => void>();
  private beforeSwapHooks: BeforeSwapHook[] = [];
  // Which base-scene guids are known (from a prior FRESH load) to contain a prefab
  // instance — checked against `keptBaseGuids` on the NEXT load so the Phase 5
  // "editor bookkeeping may not survive a carry" warning fires at the moment the
  // carry actually happens, not on every fresh load (a base with a prefab instance
  // used to warn on every single editor boot, whether or not a carry ever followed).
  private basesWithPrefabInstance = new Set<string>();

  /** Register an async hook that runs after entities are spawned into the
   *  staging world but before the atomic swap. Use for shader prewarm. */
  registerBeforeSwap(hook: BeforeSwapHook) {
    this.beforeSwapHooks.push(hook);
  }

  /** Remove a previously-registered beforeSwap hook. */
  unregisterBeforeSwap(hook: BeforeSwapHook) {
    const idx = this.beforeSwapHooks.indexOf(hook);
    if (idx >= 0) this.beforeSwapHooks.splice(idx, 1);
  }

  private async fireBeforeSwapHooks(stagingWorld: World) {
    for (const hook of this.beforeSwapHooks) {
      try {
        await hook(stagingWorld);
      } catch (e) {
        console.warn('[SceneManager] beforeSwap hook failed:', e);
      }
    }
  }

  /** Register a callback to run after a specific scene loads (by path or substring match).
   *  Use '*' as path to match all scenes. */
  registerSceneCallback(pathPattern: string, callback: () => void) {
    this.sceneCallbacks.set(pathPattern, callback);
  }

  /** Remove a previously registered scene callback. */
  unregisterSceneCallback(pathPattern: string) {
    this.sceneCallbacks.delete(pathPattern);
  }

  private fireSceneCallbacks(scenePath: string) {
    for (const [pattern, cb] of this.sceneCallbacks) {
      if (pattern === '*' || scenePath.includes(pattern)) {
        try { cb(); } catch (e) { console.warn(`[SceneManager] onSceneLoaded callback failed:`, e); }
      }
    }
  }

  /** The currently-active scene. null until the first loadScene() resolves.
   *  Returns the PRIMARY scene — the one `loadScene(path)` was called with, as
   *  opposed to a base loaded additively alongside it. NavigationManager and other
   *  real callers depend on this signature/meaning staying exactly as-is. */
  getCurrent(): Scene | null {
    if (this.primaryId === null) return null;
    const entry = this.loadedScenes.get(this.primaryId);
    if (!entry) return null;
    return { id: this.primaryId, path: entry.path, state: 'active' };
  }

  /** Every scene currently loaded into the active world — the primary plus any
   *  base scenes in its chain (Phase 5 populates more than one entry; today every
   *  load is a chain of one). Each entry's own `baseScene` (Phase 12, M1's
   *  prerequisite) is what a NESTED base's own re-emit reads — `currentBaseScene`
   *  below only ever answers for the primary. */
  getLoadedScenes(): ReadonlyMap<SceneId, LoadedSceneEntry> {
    return this.loadedScenes;
  }

  /** The `baseScene` guid ref of the currently-active scene, if any. */
  getCurrentBaseScene(): string | undefined {
    return this.currentBaseScene;
  }

  /** The scene currently preloading (if any). */
  getNext(): Scene | null {
    if (!this.nextLoad) return null;
    return { id: this.nextLoad.id, path: this.nextLoad.path, state: 'loading' };
  }

  /** Load a scene file. Cancels any in-flight load. Resolves when the swap is
   *  complete and the new scene is active. Rejects if the load fails or is
   *  aborted (the current scene remains untouched on failure). */
  async loadScene(path: string, opts: LoadOptions = {}): Promise<void> {
    // 1. Cancel in-flight load
    if (this.nextLoad) {
      this.nextLoad.controller.abort();
      releaseAllForScene(this.nextLoad.id);
      this.nextLoad = null;
    }

    // 2. Allocate the PRIMARY's sceneId + AbortController. Base scenes newly
    // entering the chain each get their own id further below (step 6).
    const id = this.nextSceneId++;
    const controller = new AbortController();
    this.nextLoad = { id, path, controller };

    // Allow caller to abort externally
    const externalAbort = () => controller.abort();
    opts.signal?.addEventListener('abort', externalAbort);

    // Track the staging world so we can destroy it if loading fails partway
    let nextWorld: World | null = null;
    // Every sceneId allocated THIS attempt (primary + any newly-loaded bases) —
    // the failure/abort cleanup below must release all of them, not just the
    // primary's.
    const allocatedSceneIds: SceneId[] = [id];

    try {
      // 3. Fetch + parse the PRIMARY's scene JSON (or use caller-supplied preloaded data)
      let data: SceneData;
      if (opts.preloaded) {
        // F3: treat `preloaded` as caller-owned + read-only. The per-scene resource
        // pipeline below (step 6) mutates `resources`/`version` in place, so
        // shallow-clone first — otherwise the dev-server / agent-bridge caller that
        // holds onto the same parsed object after this call gets a silently
        // rewritten `resources` (the full transitive prefab walk, not what it
        // passed) and a bumped `version`. A shallow clone is enough: only
        // top-level fields are overwritten (whole-array / scalar replacement, not
        // deep edits), and the migration chain likewise reassigns whole fields.
        data = { ...opts.preloaded };
      } else {
        // assetUrl() is a no-op in dev/native (BASE_URL '/'), prefixes for sub-path web
        // hosting, and resolves to the inlined blob: URL in a playable single-file build.
        const res = await fetch(assetUrl(path), { signal: controller.signal, ...ASSET_FETCH_INIT });
        if (!res.ok) throw new Error(`Failed to fetch scene "${path}": HTTP ${res.status}`);
        data = await res.json();
      }
      // Register scene id in the manifest so the editor can recover it on save
      const sceneGuid = (data as { id?: string }).id;
      if (sceneGuid && isGuid(sceneGuid)) registerAsset(sceneGuid, path, 'scene');
      // The chain walk needs SOME stable identity even for a malformed/legacy
      // scene with no `id` — fall back to a path-derived tag rather than an empty
      // string (empty would falsely collide across every such scene).
      const primaryGuid = sceneGuid && isGuid(sceneGuid) ? sceneGuid : `path:${path}`;

      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');

      // 4. Resolve the base-scene chain (base-scene persistence). `rawSceneCache`
      // avoids double-fetching a base scene's file between chain resolution here
      // and the actual per-scene load in step 6 — the primary is seeded directly
      // from `data` (already fetched/preloaded), so its own link never re-fetches.
      const rawSceneCache = new Map<string, SceneData>([[path, data]]);
      let chainCallCount = 0;
      const fetchSceneMeta: FetchSceneMeta = async (locator) => {
        if (chainCallCount++ === 0) {
          // First call is always the primary — resolveSceneChain's own contract.
          return { guid: primaryGuid, path, baseScene: data.baseScene };
        }
        const basePath = isGuid(locator) ? resolveGuidToPath(locator) : locator;
        if (!basePath) return null;
        let cached = rawSceneCache.get(basePath);
        if (!cached) {
          try {
            const res = await fetch(assetUrl(basePath), { signal: controller.signal, ...ASSET_FETCH_INIT });
            if (!res.ok) return null;
            cached = await res.json();
          } catch {
            return null;
          }
          rawSceneCache.set(basePath, cached!);
        }
        const g = (cached as { id?: string }).id;
        // Register this base hop's guid→path mapping the same way the primary's
        // own is registered above — the manifest scanner's periodic rescan is the
        // ONLY other source for a base's mapping, and a transient rescan miss
        // (e.g. racing a saveAll write) would otherwise make a LATER chain walk
        // fail to resolve a base this same process already fetched successfully.
        if (g && isGuid(g)) registerAsset(g, basePath, 'scene');
        return { guid: g && isGuid(g) ? g : `path:${basePath}`, path: basePath, baseScene: cached!.baseScene };
      };
      const { chain: newChain, warnings: chainWarnings } = await resolveSceneChain(path, fetchSceneMeta);
      for (const w of chainWarnings) console.warn(w);

      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');

      // The primary is always the chain's LAST entry (resolveSceneChain's
      // contract). It always resolves — the primary's own link is seeded
      // directly above — but fall back defensively rather than crash if that
      // contract were ever violated.
      const primaryRef: SceneRef = newChain[newChain.length - 1] ?? { path, guid: primaryGuid };
      const baseRefs = newChain.slice(0, -1); // root-most first; empty when no baseScene chain

      // 5. Diff against the currently-loaded chain (by GUID) — kept/toLoad/toDrop,
      // the same set-intersection the resource refcount already does per-scene.
      // The PRIMARY is ALWAYS freshly (re)loaded — a fresh instantiation of the
      // scene being navigated to — never treated as "kept", even if its guid
      // happens to match the old primary's; that mirrors today's unconditional-
      // reload behavior for a same-path reload.
      const oldEntries = [...this.loadedScenes.entries()];
      const oldGuidToSceneId = new Map(oldEntries.map(([sid, e]) => [e.guid, sid]));
      const forceReload = new Set(opts.forceReloadBases ?? []);
      const keptBaseGuids = new Set<string>();
      const keptSceneIds = new Set<SceneId>();
      for (const ref of baseRefs) {
        if (forceReload.has(ref.guid)) continue; // A7 escape hatch — treat as toDrop+toLoad
        const oldSid = oldGuidToSceneId.get(ref.guid);
        if (oldSid !== undefined) {
          keptBaseGuids.add(ref.guid);
          keptSceneIds.add(oldSid);
          // This is the actual moment the Phase 5 limitation bites: `ref` is being
          // CARRIED (kept from the old chain) rather than freshly reloaded, so if a
          // prior fresh load saw a prefab instance in it, its editor bookkeeping is
          // about to be flattened away by the carry respawn below. Warning here
          // (instead of on every fresh load) means this only fires when it's true.
          if (this.basesWithPrefabInstance.has(ref.guid)) {
            console.warn(
              `[SceneManager] Base scene "${ref.path}" contains a prefab instance — its editor ` +
              `instance bookkeeping does not survive this carry (this base is kept, not freshly ` +
              `reloaded, across the swap). (scene-loading.md Phase 5 known limitation).`,
            );
          }
        }
      }
      const toLoadRefs: SceneRef[] = [...baseRefs.filter((r) => !keptBaseGuids.has(r.guid)), primaryRef];
      const toDropSceneIds = oldEntries.filter(([sid]) => !keptSceneIds.has(sid)).map(([sid]) => sid);

      // Allocate a sceneId per toLoad entry — the primary reuses `id` (allocated
      // in step 2); every base newly entering the chain gets its own fresh id, so
      // `releaseAllForScene` stays per-scene and cross-chain resource sharing
      // survives exactly as today.
      const sceneIdByPath = new Map<string, SceneId>([[primaryRef.path, id]]);
      for (const ref of toLoadRefs) {
        if (ref === primaryRef) continue;
        const sid = this.nextSceneId++;
        sceneIdByPath.set(ref.path, sid);
        allocatedSceneIds.push(sid);
      }

      // 6. Build the full resource set for EACH toLoad scene (mirrors the
      // single-scene pipeline this generalizes — see collectSceneResourceRefs).
      // Resolved up front, before acquiring anything, so the combined progress
      // total is known before the first onProgress call.
      const perSceneRefs = new Map<string, SceneResourceRef[]>();
      const preparedSceneData = new Map<string, SceneData>();
      for (const ref of toLoadRefs) {
        const sceneData = ref === primaryRef ? data : rawSceneCache.get(ref.path)!;
        const sid = sceneIdByPath.get(ref.path)!;
        const refs = await this.collectSceneResourceRefs(sid, sceneData, controller);
        perSceneRefs.set(ref.path, refs);
        preparedSceneData.set(ref.path, sceneData);
      }

      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');

      const totalResources = [...perSceneRefs.values()].reduce((sum, r) => sum + r.length, 0);
      let loadedCount = 0;
      opts.onProgress?.(0, totalResources);
      // Prefabs already fetched by collectSceneResourceRefs; re-acquiring is a
      // no-op via the cache but ensures the refcount is set. Remaining resources
      // (models, meshes, materials, environments, fonts) fetch here in parallel,
      // one scene at a time (parallel WITHIN a scene, same as today).
      for (const ref of toLoadRefs) {
        const sid = sceneIdByPath.get(ref.path)!;
        await Promise.all(perSceneRefs.get(ref.path)!.map(async (r) => {
          await acquireResource(sid, r);
          loadedCount++;
          opts.onProgress?.(loadedCount, totalResources);
        }));
      }

      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');

      // 7. Carry: snapshot entities tagged Persistent (any scene, unchanged
      // mechanism) OR whose sourceScene is a KEPT base scene — the generalization
      // this phase adds (Phase 3's provenance stamp is what makes this possible).
      // Done early so the genuinely-Persistent subset's resources can be acquired
      // under a live scene id before the post-swap release, exactly as today;
      // kept-base entities need no such re-acquire — their resources are already
      // held under their own (unchanged, untouched-by-this-swap) sceneId.
      const carriedSnapshots = snapshotPersistentEntities(getCurrentWorld(), keptBaseGuids);
      // Capture each carried entity's override marks NOW, while the OLD world is
      // still alive and its marks intact — `clearAllOverrideMarks()` below drops
      // them, and the respawn has nothing to re-seed from (a carried snapshot is
      // FLATTENED: it has no `overrides` map, which is why `instantiatePrefabIntoWorld`
      // — the only place marks are normally seeded from a file — never runs on this
      // path). Keyed by OLD ecs id; re-seeded against the fresh ids that the carry's
      // `onEntitySpawned` hands back, which is the same old→new remap the A8 fix uses
      // for parentId/rootInstanceId. Without this, an authored override on a carried
      // instance serializes as "no override" and reverts to the prefab's bare defaults
      // on the next load (A9 defect 2 —
      // docs/reviews/a9-carried-instance-overrides-investigation.md).
      const carriedMarks = new Map<number, string[]>();
      for (const entry of carriedSnapshots) {
        const set = getOverrideMarkSet(entry.id);
        if (set && set.size > 0) carriedMarks.set(entry.id, [...set]);
      }
      const persistentOnlySnapshots = carriedSnapshots.filter((e) => e.traits['Persistent'] === true);
      const persistentResources = collectResourceRefsFromEntities(persistentOnlySnapshots);
      await Promise.all(persistentResources.map((ref) => acquireResource(id, ref)));

      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');

      // 8. Filter each toLoad scene's data to drop entries that collide with a
      // carried entity's guid (unchanged mechanism — the persistent-shadows-the-
      // scene-file dedup — applied per toLoad scene now instead of just the primary),
      // THEN drop entries that collide with a guid an EARLIER scene in this same
      // chain already spawned (A4 — a half-thinned level sharing guids with the
      // base being extracted from it). `seenChainGuids` accumulates across the
      // loop, in `toLoadRefs`' own root-most-base-first/primary-last order.
      const seenChainGuids = new Set<string>();
      for (const ref of toLoadRefs) {
        const sd = filterPersistentDuplicates(preparedSceneData.get(ref.path)!, carriedSnapshots);
        preparedSceneData.set(ref.path, filterDuplicateChainGuids(sd, seenChainGuids, ref.path));
      }

      // 9. Create the staging world and spawn every toLoad scene into it, in
      // chain order (root-most base FIRST, primary LAST — resolveSceneChain's
      // contract, so the level's own entities win). Stamps
      // EntityAttributes.sourceScene on everything a BASE scene spawns (the
      // primary's entities keep the schema default '' — Phase 3's load-bearing
      // "empty means primary" rule).
      nextWorld = createWorld();
      // Override marks are keyed by raw ecs id, so they must be dropped when the
      // WORLD changes — once, here, rather than once per `loadSceneFile` call. A
      // chain loads N scene files into this ONE world (bases first, primary last),
      // so a per-call clear had the primary wiping the marks the base had just
      // seeded, and every chained/carried prefab instance then serialized with
      // EMPTY overrides (A9 defect 1 — see the `clearMarks` docblock in
      // loadSceneFile.ts). Every loadSceneFile call below therefore passes
      // `clearMarks: false`.
      clearAllOverrideMarks();
      const stagingWorld = nextWorld; // captured for closures so TS narrows from null
      const eaMeta = getAllTraits().find((m) => m.name === 'EntityAttributes');
      const piMeta = getAllTraits().find((m) => m.name === 'PrefabInstance');

      for (const ref of toLoadRefs) {
        const sid = sceneIdByPath.get(ref.path)!;
        const sceneData = preparedSceneData.get(ref.path)!;
        const isPrimary = ref === primaryRef;
        const beforeIds = new Set<number>();
        for (const e of stagingWorld.entities) beforeIds.add((e as unknown as { id(): number }).id());

        await loadSceneFile(sceneData, {
          world: stagingWorld,
          clearMarks: false, // once-per-world clear above owns this (A9 defect 1)
          fetchPrefab: async (prefabPath: string) => {
            // Use the refcounted prefab cache (already acquired in step 6)
            const cached = getCachedPrefab(prefabPath);
            if (cached) return cached as object;
            // Fallback for prefabs not in the manifest (legacy scenes)
            await acquirePrefab(sid, prefabPath);
            return (getCachedPrefab(prefabPath) as object) ?? null;
          },
          onInstantiatePrefab: async (source, parentId, rootTransform, _oldEntityId, rootExtraTraits, overrides, structure, nestedOverrides, rootGuid, rootEditorFolder) => {
            // The prefab was already fetched + cached by fetchPrefab; spawn it
            // into the staging world (not the active world). Pass source so the
            // spawned entities get PrefabInstance traits for editor identification.
            // `overrides` carries per-localId field-level edits captured at save time;
            // `nestedOverrides` carries scene-level edits on the prefab's own nested instances.
            const cached = getCachedPrefab(source);
            if (!cached) { console.warn(`[SceneManager] Prefab not in cache: ${source}`); return; }
            const rootEcsId = instantiatePrefabIntoWorld(
              stagingWorld,
              cached as { entities: { localId?: number; traits: Record<string, unknown> }[]; rootLocalId?: number },
              parentId,
              rootTransform,
              source,
              overrides,
              structure,
              undefined,
              nestedOverrides,
            );
            // Re-apply the scene-authored stable guid to the instance root. The prefab
            // template clears member guids, so the freshly-spawned root has none; without
            // this it stays unaddressable and deriveInstanceMemberGuids (run later in
            // loadSceneFile) has no anchor for the instance's members. Set BEFORE that
            // pass so the root becomes the anchor.
            // Re-apply the scene-authored root guid AND the editor Hierarchy folder tag
            // to the instance root. Both live on the root's EntityAttributes but flow
            // outside the prefab template (the template clears member guids and has no
            // folder), so set them here in one pass.
            if (rootEcsId && (rootGuid || rootEditorFolder)) {
              if (eaMeta) {
                for (const e of stagingWorld.entities) {
                  const ent = e as unknown as { id(): number; has(t: unknown): boolean; get(t: unknown): Record<string, unknown>; set(t: unknown, d: unknown): void };
                  if (ent.id() !== rootEcsId) continue;
                  if (ent.has(eaMeta.trait)) {
                    const patch: Record<string, unknown> = {};
                    if (rootGuid) patch.guid = rootGuid;
                    if (rootEditorFolder) patch.editorFolder = rootEditorFolder;
                    ent.set(eaMeta.trait, { ...ent.get(eaMeta.trait), ...patch });
                  }
                  break;
                }
              }
            }
            // Apply scene-level trait customizations on the prefab root (e.g. Rotate3D
            // the user added in the editor). Without this, anything beyond the prefab's
            // own traits would be dropped on every reload.
            if (rootEcsId && rootExtraTraits) {
              const allTraitsMeta = (await import('../core/ecs/traitRegistry')).getAllTraits();
              for (const e of stagingWorld.entities) {
                if ((e as unknown as { id(): number }).id() !== rootEcsId) continue;
                for (const [name, traitData] of Object.entries(rootExtraTraits)) {
                  const meta = allTraitsMeta.find((m) => m.name === name);
                  if (!meta) continue;
                  const ent = e as unknown as {
                    has: (t: unknown) => boolean;
                    add: (instance: unknown) => void;
                    set: (t: unknown, data: unknown) => void;
                  };
                  const isTag = meta.category === 'tag' || traitData === true;
                  if (ent.has(meta.trait)) {
                    // Trait already exists from the prefab — overwrite values from scene.
                    if (!isTag) ent.set(meta.trait, traitData as Record<string, unknown>);
                  } else {
                    if (isTag) ent.add((meta.trait as () => unknown)());
                    else ent.add((meta.trait as (d: Record<string, unknown>) => unknown)(traitData as Record<string, unknown>));
                  }
                }
                break;
              }
            }
          },
          onDeletePlaceholder: (entityId) => {
            // The placeholder lives in stagingWorld; destroy it so the prefab
            // children replace it cleanly. koota entities are primitive numbers
            // (packed worldId/generation/id) with prototype methods, so we must
            // compare via entity.id() (unpacked local id) — comparing the raw
            // packed value never matches the local id loadSceneFile passes us.
            for (const e of stagingWorld.entities) {
              if ((e as unknown as { id(): number }).id() === entityId) {
                (e as unknown as { destroy(): void }).destroy();
                break;
              }
            }
          },
          loadModels: false, // already preloaded above
        });

        if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');

        // Stamp sourceScene on every entity THIS scene just spawned (a post-pass
        // diff against beforeIds, rather than hooking every spawn path, so prefab-
        // instantiated entities — which don't go through loadSceneFile's own
        // onEntitySpawned — are covered too). The primary's entities keep the
        // schema default ''.
        if (!isPrimary && eaMeta) {
          let sawPrefabInstance = false;
          for (const e of stagingWorld.entities) {
            const ent = e as unknown as { id(): number; has(t: unknown): boolean; get(t: unknown): Record<string, unknown>; set(t: unknown, d: unknown): void };
            const eid = ent.id();
            if (beforeIds.has(eid)) continue; // spawned by an earlier scene in the chain
            if (piMeta && ent.has(piMeta.trait)) sawPrefabInstance = true;
            if (!ent.has(eaMeta.trait)) continue;
            ent.set(eaMeta.trait, { ...ent.get(eaMeta.trait), sourceScene: ref.guid });
          }
          // Record rather than warn here — a base with a prefab instance is safe on
          // ITS OWN fresh load (instantiatePrefabIntoWorld ran normally, full editor
          // bookkeeping intact); the Phase 5 limitation only bites on a LATER load
          // that CARRIES this same base instead of reloading it. That check (and the
          // actual warning) lives where `keptBaseGuids` is computed, above.
          if (sawPrefabInstance) this.basesWithPrefabInstance.add(ref.guid);
          else this.basesWithPrefabInstance.delete(ref.guid); // no longer has one — stale flag would false-warn later
        }
      }

      // Respawn the carried snapshot (Persistent-tagged entities from ANY prior
      // scene, plus every entity from a KEPT base scene) into the staging world
      // BEFORE the Time/Input singleton fallback below — a carried Time (the
      // headline case: a kept base scene's Time entity) already satisfies the
      // fallback's "has one" check. Reversing this order would spawn a FRESH
      // default Time first (no scene in toLoadRefs necessarily has one — a base
      // scene's Time is normally CARRIED, not freshly loaded) and then respawn
      // the carried one on top of it: two Time entities, exactly the live bug
      // this phase's headline gate exists to catch (getTime is queryFirst,
      // timeSystem is query().updateEach — an arbitrary winner for every read AND
      // a double setJournalTick every frame). One combined entity list, one call.
      if (carriedSnapshots.length > 0) {
        await loadSceneFile(
          // Snapshots come from the live (already-migrated) world, so tag them
          // current — an older version would re-run migrations needlessly.
          { version: SCENE_FORMAT_VERSION, resources: [], entities: carriedSnapshots },
          {
            world: nextWorld,
            clearMarks: false, // once-per-world clear above owns this (A9 defect 1)
            fetchPrefab: async () => null, // flattened snapshots never carry a `prefab` ref
            loadModels: false,
            // Re-seed the marks captured off the dying world, per entity, against
            // its FRESH id (A9 defect 2). Attribution is per-(oldId → entity), never
            // a bulk replay — mis-attributing bookkeeping across entities is exactly
            // the cross-contamination that got an earlier A8 attempt reverted.
            onEntitySpawned: (entity: { id(): number }, oldId: number) => {
              const keys = carriedMarks.get(oldId);
              if (!keys) return;
              for (const key of keys) {
                const dot = key.indexOf('.'); // key is `${trait}.${field}`
                if (dot <= 0) continue;
                markOverride(entity.id(), key.slice(0, dot), key.slice(dot + 1));
              }
            },
          },
        );
      }

      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');

      // Guard: warn on cross-scene parenting (an entity parented to an entity
      // from a DIFFERENT sourceScene). Breaks save provenance (Phase 6 filtering
      // above keys off an entity's OWN sourceScene, not its parent's — a foreign
      // child of a kept entity would silently vanish on the next save of either
      // scene) and teardown (a scene-scoped subtree walk expects to stay within
      // one scene). Warn-and-degrade, matching the chain resolver's own cycle
      // handling — never fail the load over it.
      if (eaMeta) {
        const attrById = new Map<number, Record<string, unknown>>();
        for (const e of stagingWorld.entities) {
          const ent = e as unknown as { id(): number; has(t: unknown): boolean; get(t: unknown): Record<string, unknown> };
          if (ent.has(eaMeta.trait)) attrById.set(ent.id(), ent.get(eaMeta.trait));
        }
        for (const [, attr] of attrById) {
          const parentId = (attr.parentId as number) ?? 0;
          if (!parentId) continue;
          const parentAttr = attrById.get(parentId);
          if (!parentAttr) continue;
          const ownSource = (attr.sourceScene as string) || '';
          const parentSource = (parentAttr.sourceScene as string) || '';
          if (ownSource !== parentSource) {
            console.warn(
              `[SceneManager] Cross-scene parenting: entity "${attr.name}" (sourceScene="${ownSource || 'primary'}") ` +
              `is parented to an entity from sourceScene="${parentSource || 'primary'}" — this breaks save ` +
              `provenance and teardown (scene-loading.md Phase 6 guard).`,
            );
          }
        }
      }

      // Time is a global resource — make sure the combined world has one even if
      // no scene in the chain included the singleton entity (freshly loaded OR
      // carried above). Otherwise getTime() returns null and any system that
      // depends on delta (rotate3DSystem etc.) is a no-op.
      let hasTime = false;
      stagingWorld.query(Time).updateEach(() => { hasTime = true; });
      if (!hasTime) {
        // Transient: this singleton is MATERIALIZED here, not authored — so it must
        // never be written back to whichever scene happens to be saved next. Without
        // the tag a save silently GREW any scene lacking a Time entity by one
        // (measured on ui-focus-demo.json, 9 → 10 entities, docs/todo.md), which is a
        // counter-example to the A10 "a no-op save is a no-op" invariant. Worse for a
        // BASE scene: the foreign-entity filter in serialize.ts skips any entity
        // without EntityAttributes, and this one has none, so it lands in EVERY file
        // saved while it exists rather than being confined to the primary.
        //
        // This does NOT stop a scene from AUTHORING its own Time (that's the point of
        // `timeScale` not being marked runtimeOnly, and of hosting the resource in a
        // shared BASE scene): a Time that came from a file has no Transient tag and
        // serializes normally. The tag distinguishes PROVENANCE, which is the only
        // thing that can tell the two apart — an authored Time sitting at the default
        // timeScale is byte-identical to this one, so no value-based rule could.
        // Re-materialized on every chain load that needs it, so nothing is lost.
        const ent = stagingWorld.spawn(Time(), Transient);
        registerEntity(ent, stagingWorld);
      }

      // Input is likewise a global resource — ensure the combined world has the
      // singleton so the app-pipeline inputSystem has a target to write and
      // consumers (character input, UI focus) can read it. Runtime-only; never
      // authored into a scene file.
      let hasInput = false;
      stagingWorld.query(Input).updateEach(() => { hasInput = true; });
      if (!hasInput) {
        const ent = stagingWorld.spawn(Input());
        registerEntity(ent, stagingWorld);
      }

      // Prewarm: let renderers compile shaders against the staging world BEFORE
      // we flip setCurrentWorld. This eliminates the first-frame shader-compile
      // stutter after swap. Hooks are best-effort — failures are logged and the
      // swap proceeds anyway.
      await this.fireBeforeSwapHooks(nextWorld);

      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');

      // 10. Atomic swap.
      const oldPath = (this.primaryId !== null ? this.loadedScenes.get(this.primaryId)?.path : undefined) ?? '';
      const oldWorld = getCurrentWorld();
      const promotedWorld = nextWorld;

      // Rebuild loadedScenes BEFORE setCurrentWorld below — setCurrentWorld fires
      // onWorldSwap synchronously, and the Hierarchy panel's onWorldSwap handler
      // reads sceneManager.getLoadedScenes() to label each scene group. If the
      // rebuild ran after the swap, that read would catch the map mid-flight
      // (still holding the OLD scene's entries), so a base scene's group label
      // would miss its guid → path lookup and fall back to rendering the raw
      // guid instead of "Base". A KEPT entry survives untouched (same sceneId/
      // role — it never left, so nothing about it changed); every DROPPED entry
      // is removed; every toLoad entry is inserted fresh with its freshly-
      // allocated sceneId. With no scene declaring `baseScene`, toDropSceneIds is
      // exactly the old primary and toLoadRefs is exactly the new primary —
      // byte-identical to the old single-entry replacement.
      for (const sid of toDropSceneIds) this.loadedScenes.delete(sid);
      for (const ref of toLoadRefs) {
        const sid = sceneIdByPath.get(ref.path)!;
        // Each entry's OWN baseScene ref (Phase 12, M1's prerequisite) — a KEPT base's
        // entry already carries this from its own earlier load, untouched. Without it,
        // serializing a NESTED base (one that itself has a base) would delete that
        // base's own baseScene ref on save — A3's failure mode, one link up the chain.
        const sceneData = preparedSceneData.get(ref.path);
        // createdAt is an untyped field on the raw parsed JSON (not part of `SceneData`,
        // same pattern as the `id`/guid read at step 3 above) — carried through
        // `filterPersistentDuplicates`/`filterDuplicateChainGuids`'s `{...data, ...}`
        // spreads untouched. Phase 1, scene-loading.md.
        const createdAt = (sceneData as { createdAt?: string } | undefined)?.createdAt;
        this.loadedScenes.set(sid, {
          path: ref.path, guid: ref.guid, role: ref === primaryRef ? 'primary' : 'base',
          baseScene: sceneData?.baseScene, createdAt,
        });
      }
      this.primaryId = id;
      this.currentBaseScene = data.baseScene;
      this.nextLoad = null;

      setCurrentWorld(promotedWorld); // fires onWorldSwap → renderers clear caches
      nextWorld = null; // ownership transferred to current; do not destroy in catch

      // Percept (J3): journal the scene activation into the now-active world — a
      // fresh load vs. a swap from a previous scene. Engine-authored → `@`-sigil.
      if (oldPath) emit('@scene-swapped', { from: oldPath, to: path }, promotedWorld);
      else emit('@scene-loaded', { path }, promotedWorld);

      // Resolve the game this scene belongs to. Explicit `opts.gameId` (a real
      // game switch) wins; otherwise derive from the path (dev fallback). A null
      // derivation means "unknown" — keep the current game so cross-scene
      // managers persist across in-game swaps (Station↔Warp). `opts.gameId: null`
      // explicitly clears it (back to the menu).
      const nextGameId = opts.gameId !== undefined
        ? opts.gameId
        : (gameIdFromScenePath(path) ?? getActiveGameId());
      const gameChanged = nextGameId !== getActiveGameId();

      // Dispose the previous PRIMARY's scene-scoped managers before the old world
      // is torn down; if the GAME is also changing, dispose its game-scoped
      // managers too (they survive in-game swaps, but not a game change). Base
      // scenes have no scene-scoped manager registry entry of their own — this
      // stays keyed on the primary path, unchanged. Pass the OLD world — still
      // alive until the destroy below — so a dispose() that cleans up world-bound
      // state hits the right world, not the freshly-promoted one. Awaited so a
      // manager whose async init is still in flight is disposed only after that
      // init settles.
      if (gameChanged) await disposeActiveGameManagers({ world: oldWorld, scenePath: oldPath });
      await disposeActiveSceneManagers({ world: oldWorld, scenePath: oldPath });

      // Release resources for every DROPPED scene (old-only). Anything KEPT
      // survives via its own (unchanged) refcount — releaseAllForScene only
      // touches ITS OWN sceneId's ownership, so a resource shared with a kept
      // scene is untouched.
      for (const sid of toDropSceneIds) releaseAllForScene(sid);

      // Free the old world's slot in koota's worldId pool. koota caps total
      // worlds at 16; without this, every scene swap permanently consumes a
      // slot and the engine breaks after ~16 swaps.
      if (oldWorld !== promotedWorld) {
        try { oldWorld.destroy(); } catch (e) { console.warn('[SceneManager] Failed to destroy old world:', e); }
      }

      // 11. Fire per-scene callbacks for dynamic entity spawning
      this.fireSceneCallbacks(path);

      // Activate the new game's game-scoped managers (only when the game changed;
      // an in-game swap keeps them running), then the new scene's scene-scoped
      // managers. Awaited so async init (e.g. entity spawning) completes before
      // loadScene resolves.
      if (gameChanged) await initGameManagersFor(nextGameId, path);
      await initSceneManagersFor(path);

      // 12. Done
    } catch (err) {
      // Failure or abort — clean up every sceneId allocated THIS attempt (the
      // primary plus any base newly entering the chain).
      for (const sid of allocatedSceneIds) releaseAllForScene(sid);
      if (nextWorld) {
        try { nextWorld.destroy(); } catch { /* ignore */ }
      }
      if (this.nextLoad?.id === id) this.nextLoad = null;
      throw err;
    } finally {
      opts.signal?.removeEventListener('abort', externalAbort);
    }
  }

  /** Build the full resource-ref list for ONE scene's data — the per-scene
   *  pipeline `loadScene` runs once per entry in `toLoadRefs` (base-scene
   *  persistence, Phase 5): seed from the scene's own `resources` + a full
   *  entity walk (the file is a hint; the walk is authoritative — a stale
   *  manifest may be missing entries like HDRs added after first
   *  serialization), pull in timeline-referenced audio/prefab refs, then
   *  iteratively walk prefabs (fetched + cached under `sceneId`) for THEIR OWN
   *  nested resources. Mutates `sceneData.resources`/`.version` in place.
   *
   *  Does NOT acquire anything — that's a separate pass in the caller so every
   *  toLoad scene's total is known before the first onProgress call. Without
   *  the prefab walk, resources nested inside a prefab (e.g. a grass mesh +
   *  material + texture) would load lazily from the render loop, causing
   *  visible pop-in on first view. */
  private async collectSceneResourceRefs(
    sceneId: SceneId,
    sceneData: SceneData,
    controller: AbortController,
  ): Promise<SceneResourceRef[]> {
    const seen = new Set<string>();
    const allRefs: SceneResourceRef[] = [];
    const addRef = (ref: SceneResourceRef) => {
      const key = `${ref.type}:${ref.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      allRefs.push(ref);
      return true;
    };
    for (const ref of sceneData.resources ?? []) addRef(ref);
    for (const ref of collectResourceRefsFromEntities(sceneData.entities)) addRef(ref);

    // Fetch timelines and add their transitively-referenced inner GUIDs — invisible to the
    // entity collector. AUDIO cues (audio tracks) and PREFABS (control tracks) need adding;
    // animation-track clips are NAMES resolved via the target Animator's own bank (already
    // collected above), so those already have an owner. This runs BEFORE the prefab walk below
    // so a control track's prefab is seeded into `prefabQueue` and its own nested resources
    // (.mesh.json geometry / .mat.json / textures) are acquired scene-scoped like any other
    // prefab dep — otherwise the spawned prefab would render fallback/pop-in and its GPU deps
    // would go untracked at teardown.
    for (const tRef of allRefs.filter(r => r.type === 'timeline')) {
      const def = await loadTimelineNow(tRef.path);
      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (!def) continue;
      for (const cueRef of collectTimelineAudioRefs(def)) {
        const audioPath = isGuid(cueRef) ? resolveRef(cueRef) : cueRef;
        if (audioPath) addRef({ type: 'audio', path: audioPath });
      }
      // Prefab resources carry the GUID (not a resolved path) — matching the entity collector's
      // PrefabInstance.source refs, since acquirePrefab resolves the GUID itself. (Audio above
      // carries the resolved path; the two resource kinds differ by convention.)
      for (const prefabRef of collectTimelineControlRefs(def)) {
        if (prefabRef) addRef({ type: 'prefab', path: prefabRef });
      }
    }

    // Iteratively fetch prefabs and walk them for nested refs. Seeds from every prefab ref
    // discovered so far — scene entities AND control-track prefabs above.
    const prefabQueue: string[] = allRefs.filter(r => r.type === 'prefab').map(r => r.path);
    const prefabProcessed = new Set<string>();
    while (prefabQueue.length > 0) {
      const prefabPath = prefabQueue.shift()!;
      if (prefabProcessed.has(prefabPath)) continue;
      prefabProcessed.add(prefabPath);
      // Acquire fetches the prefab JSON into the cache under this sceneId.
      await acquirePrefab(sceneId, prefabPath);
      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const cached = getCachedPrefab(prefabPath) as { entities?: SceneEntityEntry[] } | null;
      if (!cached?.entities) continue;
      // Walk the prefab's entities — same collector as scene entities.
      const nested = collectResourceRefsFromEntities(cached.entities);
      for (const ref of nested) {
        if (addRef(ref) && ref.type === 'prefab') prefabQueue.push(ref.path);
      }
    }

    // Persist the merged manifest back onto the scene data so downstream code
    // (the respawn call above, telemetry) sees the full picture.
    sceneData.resources = allRefs;
    sceneData.version = Math.max(sceneData.version ?? 6, 6);
    return allRefs;
  }

  /** For tests + shutdown. Releases everything and resets the manager.
   *
   *  Async (F1): a normal scene swap disposes the active scene/game managers and
   *  re-resolves the active scope (loadScene lines ~437-459); `unloadAll` is the
   *  asymmetric teardown path, so it must do the same or every active manager's
   *  dispose() is skipped — TimeManager/NavigationManager keep their onWorldSwap /
   *  registerReadSource subscriptions live, scene/game managers keep their owned
   *  UIActions registered, and the registry's activeScenePath/activeGameId module
   *  state stays stale (a later loadScene then mis-computes `gameChanged`). We
   *  dispose against the CURRENT (still-alive) world before swapping in the empty
   *  one, then clear both active scopes. */
  async unloadAll(): Promise<void> {
    if (this.nextLoad) {
      this.nextLoad.controller.abort();
      releaseAllForScene(this.nextLoad.id);
      this.nextLoad = null;
    }

    // Dispose active managers against the world they were running on, before it
    // is replaced below. Order mirrors the swap path: game scope first, then
    // scene scope. Pass the still-current world + path so a dispose() that tears
    // down world-bound state hits the right world.
    const oldWorld = getCurrentWorld();
    const oldPath = (this.primaryId !== null ? this.loadedScenes.get(this.primaryId)?.path : undefined) ?? '';
    await disposeActiveGameManagers({ world: oldWorld, scenePath: oldPath });
    await disposeActiveSceneManagers({ world: oldWorld, scenePath: oldPath });

    // Reset the registry's active scope state so a subsequent loadScene (or a
    // post-teardown registerManager) doesn't see a stale activeGameId /
    // activeScenePath. managerRegistry exposes no dedicated reset, so drive it
    // through its existing public surface: initGameManagersFor(null) sets
    // activeGameId = null and activates nothing (it early-returns on null);
    // initSceneManagersFor('') sets activeScenePath = ''. The latter can spuriously
    // (re)activate a scene manager that has no `scenes` filter (matches any path),
    // so dispose scene managers once more afterward to leave everything inactive.
    await initGameManagersFor(null, '');
    await initSceneManagersFor('');
    await disposeActiveSceneManagers({ world: oldWorld, scenePath: '' });

    // Release every loaded scene (today, a chain of one — Phase 5 is what makes
    // this map hold more than the primary).
    for (const sceneId of this.loadedScenes.keys()) releaseAllForScene(sceneId);
    this.loadedScenes.clear();
    this.primaryId = null;
    this.currentBaseScene = undefined;
    // Hand the world registry a fresh empty world so subsequent code doesn't
    // see stale entities. Tests typically reset modules instead.
    setCurrentWorld(createWorld());
  }

  /** For tests: reset the sceneId counter so test runs are deterministic. */
  resetForTesting(): void {
    this.nextSceneId = 1;
    this.loadedScenes.clear();
    this.primaryId = null;
    this.currentBaseScene = undefined;
    this.nextLoad = null;
    this.basesWithPrefabInstance.clear();
  }
}

/** Drop scene-file entries whose root entity has the same EntityAttributes.guid
 *  as a runtime-persistent entity. The persistent entity will be respawned into
 *  the staging world after loadSceneFile runs, so we exclude any scene-file root
 *  whose guid matches (and its entire descendant subtree) to avoid duplicates.
 *
 *  Matching is guid-only — entity names are not considered. This avoids the
 *  silent-shadowing bug where an unrelated scene root with the same name as a
 *  persistent entity would be dropped.
 *
 *  Persistent entities are root-only (enforced by `markPersistent`), so we only
 *  need to compare against scene roots — children of a persistent root come
 *  along when the subtree is respawned. */
export function filterPersistentDuplicates(
  data: SceneData,
  persistentSnapshots: SceneEntityEntry[],
): SceneData {
  // Collect guids from persistent root snapshots. Guid lives on EntityAttributes;
  // we keep the legacy Persistent.guid path as a fallback for snapshots taken
  // from pre-migration worlds (e.g. tests with mocked traits).
  const persistentGuids = new Set<string>();
  for (const snap of persistentSnapshots) {
    if (!('Persistent' in snap.traits)) continue;
    const ea = snap.traits['EntityAttributes'] as Record<string, unknown> | undefined;
    // Defensive: only roots should be persistent
    if (ea && ((ea.parentId as number) ?? 0) !== 0) continue;
    let guid = (ea?.guid as string) || '';
    if (!guid) {
      const p = snap.traits['Persistent'];
      if (p && typeof p === 'object') guid = ((p as Record<string, unknown>).guid as string) || '';
    }
    if (!guid) {
      console.warn('[SceneManager] Persistent snapshot has empty guid — was markPersistent bypassed?');
      continue;
    }
    persistentGuids.add(guid);
  }
  if (persistentGuids.size === 0) return data;

  // Scene root entries whose EntityAttributes.guid matches — these (and their
  // subtrees) are excluded.
  const excludedIds = new Set<number>();
  const childrenByParent = new Map<number, number[]>();
  for (const entry of data.entities) {
    const ea = entry.traits['EntityAttributes'] as Record<string, unknown> | undefined;
    const parentId = (ea?.parentId as number) ?? 0;
    if (parentId !== 0) {
      let arr = childrenByParent.get(parentId);
      if (!arr) { arr = []; childrenByParent.set(parentId, arr); }
      arr.push(entry.id);
    }
  }
  for (const entry of data.entities) {
    const ea = entry.traits['EntityAttributes'] as Record<string, unknown> | undefined;
    const parentId = (ea?.parentId as number) ?? 0;
    if (parentId !== 0) continue; // not a root
    if (!('Persistent' in entry.traits)) continue;
    let guid = (ea?.guid as string) || '';
    if (!guid) {
      const p = entry.traits['Persistent'];
      if (p && typeof p === 'object') guid = ((p as Record<string, unknown>).guid as string) || '';
    }
    if (!guid || !persistentGuids.has(guid)) continue;
    const stack = [entry.id];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (excludedIds.has(id)) continue;
      excludedIds.add(id);
      const children = childrenByParent.get(id);
      if (children) stack.push(...children);
    }
  }

  if (excludedIds.size === 0) return data;

  const names = data.entities
    .filter((e) => excludedIds.has(e.id))
    .map((e) => (e.traits['EntityAttributes'] as Record<string, unknown> | undefined)?.name ?? `id:${e.id}`)
    .join(', ');
  console.debug(`[SceneManager] Persistent shadowing dropped ${excludedIds.size} scene entities: ${names}`);

  return {
    ...data,
    entities: data.entities.filter((e) => !excludedIds.has(e.id)),
  };
}

/** Guard against two chain scenes spawning the same guid (base-scene-and-
 *  persistence-plan.md finding A4): before a game's levels are thinned down to
 *  their `FieldSource` + tuning (Phase 10), a level file duplicated from
 *  another still shares ALL its guids with the base being extracted from it.
 *  Nothing else in the pipeline detects a duplicate guid across additively-
 *  loaded scenes, and two live entities answering to the same guid means an
 *  arbitrary winner for every `findEntityByGuid` lookup.
 *
 *  Called once per `toLoadRefs` entry, in chain order (root-most base first,
 *  primary last) — `seenGuids` accumulates across calls, so the FIRST scene to
 *  spawn a guid keeps it and every later collision is warned about and dropped
 *  (whole subtree, mirroring `filterPersistentDuplicates`). Root-only
 *  comparison, same precedent as `filterPersistentDuplicates` above — a
 *  collision in this scenario is a whole level having been duplicated
 *  wholesale, so the roots collide and their subtrees ride along. */
export function filterDuplicateChainGuids(
  data: SceneData,
  seenGuids: Set<string>,
  scenePath: string,
): SceneData {
  const excludedIds = new Set<number>();
  const childrenByParent = new Map<number, number[]>();
  for (const entry of data.entities) {
    const ea = entry.traits['EntityAttributes'] as Record<string, unknown> | undefined;
    const parentId = (ea?.parentId as number) ?? 0;
    if (parentId !== 0) {
      let arr = childrenByParent.get(parentId);
      if (!arr) { arr = []; childrenByParent.set(parentId, arr); }
      arr.push(entry.id);
    }
  }
  for (const entry of data.entities) {
    const ea = entry.traits['EntityAttributes'] as Record<string, unknown> | undefined;
    const parentId = (ea?.parentId as number) ?? 0;
    if (parentId !== 0) continue; // not a root — dropped as part of its root's subtree below
    const guid = (ea?.guid as string) || entry.guid || '';
    if (!guid) continue;
    if (seenGuids.has(guid)) {
      console.warn(`[SceneManager] Duplicate guid "${guid}" in "${scenePath}" collides with an already-loaded chain scene — skipping this entity (scene-loading.md A4).`);
      const stack = [entry.id];
      while (stack.length > 0) {
        const id = stack.pop()!;
        if (excludedIds.has(id)) continue;
        excludedIds.add(id);
        const children = childrenByParent.get(id);
        if (children) stack.push(...children);
      }
    } else {
      seenGuids.add(guid);
    }
  }
  if (excludedIds.size === 0) return data;
  return { ...data, entities: data.entities.filter((e) => !excludedIds.has(e.id)) };
}

/** The field set a carried entity is snapshotted with: the union of the trait's
 *  koota `.schema` keys and its registered Inspector `fields`. The koota schema
 *  is the authoritative serialized set (see `buildSceneSchema`) — `meta.fields`
 *  is a curated SUBSET, so using it alone silently drops real state (e.g.
 *  `Time.timeScale`, which is in Time's schema but not its Inspector fields, and
 *  AoS fields like `AnimationLibrary.animSets`). `runtimeOnly` is deliberately
 *  ignored: that flag gates *scene-file* serialization, and carrying runtime
 *  state across a swap is the entire point of a snapshot. */
export function snapshotFieldNames(meta: { trait: unknown; fields: Record<string, unknown> }): string[] {
  const koota = resolveKootaSchema(meta.trait);
  if (!koota) return Object.keys(meta.fields);
  const names = new Set(Object.keys(koota));
  for (const key of Object.keys(meta.fields)) names.add(key);
  return [...names];
}

/** Walk a world for entities to CARRY across a swap, collect each carried root's
 *  full child subtree (via EntityAttributes.parentId), and serialize every entity
 *  in those subtrees to the same SceneEntityEntry format that loadSceneFile
 *  consumes. The output can be fed straight back into loadSceneFile to respawn
 *  the entities in another world.
 *
 *  A root is carried if it's tagged Persistent (must be a root — enforced by
 *  markPersistent) OR (base-scene plan, Phase 5) it's a scene root (parentId 0)
 *  whose EntityAttributes.sourceScene is in `keptBaseGuids` — a base scene the
 *  new chain is keeping loaded. A kept base's DESCENDANTS aren't matched
 *  separately here; they ride along via the same subtree walk below, keyed off
 *  THEIR OWN sourceScene stamp (set at spawn time for every entity a scene
 *  spawns, not just its roots) — not inferred from their root. */
function snapshotPersistentEntities(world: World, keptBaseGuids: Set<string> = new Set()): SceneEntityEntry[] {
  const allTraits = getAllTraits();
  const attrMeta = allTraits.find((m) => m.name === 'EntityAttributes');

  // Step 1: collect carried root entity ids.
  const carriedRootIds: number[] = [];
  try {
    world.query(Persistent).updateEach((_: unknown[], entity: Entity) => {
      carriedRootIds.push(entity.id());
    });
  } catch {
    // Persistent trait not registered in this world — fine, the base-scene carry
    // below (if any) is independent of it; keep going rather than early-return.
  }

  if (attrMeta && keptBaseGuids.size > 0) {
    world.query(attrMeta.trait).updateEach(([attr]: Record<string, unknown>[], entity: Entity) => {
      if ((attr.parentId as number ?? 0) === 0 && keptBaseGuids.has(attr.sourceScene as string)) {
        carriedRootIds.push(entity.id());
      }
    });
  }

  if (carriedRootIds.length === 0) return [];

  // Step 2: walk each root + its descendants via parentId. Build a flat list
  // of (oldId → SceneEntityEntry) for serialization.
  const allEntityRecords: { id: number; parentId: number }[] = [];
  if (attrMeta) {
    world.query(attrMeta.trait).updateEach(([attr]: Record<string, unknown>[], entity: Entity) => {
      allEntityRecords.push({
        id: entity.id(),
        parentId: (attr.parentId as number) ?? 0,
      });
    });
  }

  // Build child index: parentId → child ids
  const childrenByParent = new Map<number, number[]>();
  for (const rec of allEntityRecords) {
    if (rec.parentId === 0) continue;
    let arr = childrenByParent.get(rec.parentId);
    if (!arr) { arr = []; childrenByParent.set(rec.parentId, arr); }
    arr.push(rec.id);
  }

  // BFS from each carried root to collect the full subtree
  const subtreeIds = new Set<number>();
  for (const rootId of carriedRootIds) {
    const queue = [rootId];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (subtreeIds.has(id)) continue;
      subtreeIds.add(id);
      const children = childrenByParent.get(id);
      if (children) queue.push(...children);
    }
  }

  // Step 3: serialize each entity in the subtrees. Read trait data via koota
  // entity.has() / entity.get() — these work on entities from any world.
  const entriesById = new Map<number, SceneEntityEntry>();
  // We need to map entity id → entity object so we can call has/get. Walk Transform
  // (every entity has it) or fall back to walking each registered trait.
  const tfMeta = allTraits.find((m) => m.name === 'Transform');
  const idToEntity = new Map<number, Entity>();

  if (tfMeta) {
    world.query(tfMeta.trait).updateEach((_: unknown[], entity: Entity) => {
      if (subtreeIds.has(entity.id())) idToEntity.set(entity.id(), entity);
    });
  }
  // Catch any entity in the subtree without Transform (e.g. UI-only) by also
  // walking via EntityAttributes
  if (attrMeta) {
    world.query(attrMeta.trait).updateEach((_: unknown[], entity: Entity) => {
      if (subtreeIds.has(entity.id()) && !idToEntity.has(entity.id())) idToEntity.set(entity.id(), entity);
    });
  }

  for (const id of subtreeIds) {
    const entity = idToEntity.get(id);
    if (!entity) continue;
    const entry: SceneEntityEntry = { id, traits: {} };
    for (const meta of allTraits) {
      let has = false;
      try { has = entity.has(meta.trait); } catch { /* trait not registered in this world */ }
      if (!has) continue;
      if (meta.category === 'tag') {
        entry.traits[meta.name] = true;
        continue;
      }
      const data = entity.get(meta.trait) as Record<string, unknown> | undefined;
      if (!data) continue;
      const traitData: Record<string, unknown> = {};
      for (const key of snapshotFieldNames(meta)) {
        traitData[key] = data[key];
      }
      entry.traits[meta.name] = traitData;
    }
    entriesById.set(id, entry);
  }

  // Return in ECS-ID order, not BFS/subtree order (scene-loading.md,
  // Phase 3 — the owner-chosen fix for the "carry" half of the entity-order churn
  // Phase 0 measured). This array becomes `loadSceneFile`'s spawn order for these
  // entities (SceneManager.ts's carry-respawn call passes it straight through as
  // `data.entities`), which in turn is the array order `serializeScene` later
  // reproduces on save. A COLD load spawns a scene's entities in FILE order —
  // ecs ids are handed out sequentially by a fresh world's allocator — so id
  // order and file order coincide there. Reproducing that same id order here
  // means a base scene saved after being CARRIED across a swap comes out in the
  // same order as one saved after a cold load, instead of BFS's subtree-grouped
  // order (which regroups by root→children and doesn't match the file at all).
  // Parent-before-child is NOT required: `loadSceneFile` spawns every entity in
  // pass 1, then resolves every `parentId` in pass 2, after the full array has
  // already been spawned — order-independent by construction.
  return [...entriesById.values()].sort((a, b) => a.id - b.id);
}

/** Dispatch to the right typed acquire function based on resource type. */
async function acquireResource(sceneId: SceneId, ref: SceneResourceRef): Promise<void> {
  switch (ref.type) {
    case 'model':    return acquireModel(sceneId, ref.path, ref.postprocessor);
    case 'riggedModel': return acquireRiggedModel(sceneId, ref.path);
    case 'mesh':     return acquireMesh(sceneId, ref.path);
    case 'material': return acquireMaterial(sceneId, ref.path);
    case 'texture':
      // 2D sprites + UI images. Lazy-loaded by the 2D/DOM renderer (PixiJS
      // texture cache / CSS background), not preloaded here. Listed as a
      // resource so the build tree-shaker keeps the file.
      return;
    case 'prefab':   return acquirePrefab(sceneId, ref.path);
    case 'particle':
      // `.particle.json` effects referenced by ParticleEmitter entities. The per-frame
      // particle sync lazy-loads + caches the def via getParticleEffect (retrying until
      // ready), so no preload is needed here. Listed as a resource so the build
      // tree-shaker keeps the file; the acquire is a no-op (mirrors texture/font).
      return;
    case 'animation':
      // `.anim.json` clips referenced by Animator entities. The animation system
      // lazy-loads + caches the clip via getAnimationClip (retrying until ready),
      // so no preload is needed. Listed as a resource for the build tree-shaker.
      return;
    case 'timeline':
      // `.timeline.json` sequences referenced by Director entities. Fetched above (the
      // transitive-ref walk) to pull out audio cues; the timelineSystem lazy-loads +
      // caches the def via getTimeline (retrying until ready), so no preload is needed
      // here. Listed as a resource for the build tree-shaker (mirrors animation).
      return;
    case 'animset':
      // `.animset.json` per-clip params referenced by SkeletalAnimator entities.
      // driveAnimator lazy-loads + caches the set via resolveAnimSetParams
      // (retrying until ready), so no preload is needed. Listed as a resource for
      // the build tree-shaker (mirrors animation/particle).
      return;
    case 'spriteanim':
      // `.spriteanim.json` flipbook clip sets referenced by SpriteAnimator.clipSet.
      // spriteAnimationSystem lazy-loads + caches the set via activeSpriteClip
      // (retrying until ready), so no preload is needed. Listed as a resource for
      // the build tree-shaker (mirrors animset/animation/particle).
      return;
    case 'rig2d':
      // `.rig2d.json` 2D skinning rigs referenced by SkinnedSprite2D.rig. skin2DSystem
      // lazy-loads + caches the rig via getRig2D (retrying until ready), so no preload is
      // needed. Listed as a resource for the build tree-shaker (mirrors spriteanim). Phase 1:
      // not yet scene-scoped refcounted (nor is its texture) — a documented follow-up.
      return;
    case 'shader':
      // `.shader.json` 2D custom materials referenced by Renderable2D.material. Scene2D's
      // material pass lazy-loads + caches the compiled program via ensureSpriteMaterial
      // (clearing on world swap), so no preload here. Listed as a resource for the build
      // tree-shaker (mirrors rig2d/spriteanim). Pre-warm can't go through the Scene2D-owned
      // cache (the swap clears it after acquire); a scene-scoped 2D-material cache is a
      // documented follow-up if pop-in matters.
      return;
    case 'font':
      // Two kinds share this resource type. A GUID ref is an SDF font (Text3D/
      // Text2D.font) — acquire it scene-scoped so it's loaded BEFORE the old scene
      // is released (cross-swap survival) and refcounted via releaseFontsForScene.
      // A non-GUID ref is a CSS family NAME (UIElement.fontFamily), loaded globally
      // via the FontFace loader (loadAllFonts) — no scene-scoped hold needed.
      if (isGuid(ref.path)) { await acquireFont(sceneId, ref.path); }
      return;
    case 'environment':
      // Preload the HDR so the first frame of the new scene has correct PBR
      // lighting via image-based lighting. Previously this was loaded lazily
      // by syncEnvironment, which caused ~500 ms of dark silhouettes on swap.
      return acquireEnvironment(sceneId, ref.path);
    case 'audio':
      // Preload short SFX (loadType 'buffer', the default) so the first play has
      // no decode latency; 'stream' clips register ownership only (played via
      // HTMLMediaElement, never decoded). Headless: a no-op that still owns.
      return acquireAudio(sceneId, ref.path, getAudioLoadType(ref.path));
    default:
      console.warn(`[SceneManager] Unknown resource type: ${(ref as { type: string }).type}`);
  }
}

/** The singleton SceneManager. Importers should generally just call sceneManager.loadScene(). */
export const sceneManager: SceneManager = new SceneManagerImpl();

/** The id of the currently-loaded scene (for scene-scoped resource ownership from
 *  the renderers — e.g. the Text sync acquiring a font not yet in the manifest).
 *  undefined before the first scene loads. */
export function getCurrentSceneId(): number | undefined {
  return sceneManager.getCurrent()?.id;
}

// Expose for debug console: window.__sceneManager
if (typeof window !== 'undefined') {
  (window as Window & { __sceneManager?: SceneManager }).__sceneManager = sceneManager;
}

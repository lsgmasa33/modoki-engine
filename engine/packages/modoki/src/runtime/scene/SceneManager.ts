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
 *      c. releaseAllForScene(currentScene.id) — refcounts drop; resources only
 *         held by current scene get disposed
 *  7. Resolve the promise
 *
 *  Concurrency: cancel-and-replace. Only one preload in flight; calling
 *  loadScene() while another is loading aborts the in-flight load.
 *
 *  Failure: if any step fails, release the next-scene's acquired resources and
 *  reject the promise. The current scene is untouched.
 */

import { createWorld, type World, type Entity } from 'koota';
import { setCurrentWorld, getCurrentWorld, registerEntity } from '../ecs/world';
import { getAllTraits } from '../ecs/traitRegistry';
import { emit } from '../systems/journal';
import { SCENE_FORMAT_VERSION } from '../version';

import { Persistent } from '../traits/Persistent';
import { Time } from '../traits/Time';
import { Input } from '../traits/Input';
import {
  acquireMaterial, acquireMesh, acquireModel, acquirePrefab, acquireEnvironment,
  releaseAllForScene, getCachedPrefab,
  type SceneId,
} from '../loaders/meshTemplateCache';
import { acquireRiggedModel } from '../loaders/riggedModelCache';
import { acquireAudio } from '../loaders/audioBufferCache';
import { acquireFont } from '../rendering/text/fontAtlasLoader';
import { registerAsset, isGuid, resolveRef, getAudioLoadType } from '../loaders/assetManifest';
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

class SceneManagerImpl {
  private currentScene: { id: SceneId; path: string } | null = null;
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

  /** The currently-active scene. null until the first loadScene() resolves. */
  getCurrent(): Scene | null {
    if (!this.currentScene) return null;
    return { id: this.currentScene.id, path: this.currentScene.path, state: 'active' };
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

    // 2. Allocate sceneId + AbortController
    const id = this.nextSceneId++;
    const controller = new AbortController();
    this.nextLoad = { id, path, controller };

    // Allow caller to abort externally
    const externalAbort = () => controller.abort();
    opts.signal?.addEventListener('abort', externalAbort);

    // Track the staging world so we can destroy it if loading fails partway
    let nextWorld: World | null = null;

    try {
      // 3. Fetch + parse scene JSON (or use caller-supplied preloaded data)
      let data: SceneData;
      if (opts.preloaded) {
        // F3: treat `preloaded` as caller-owned + read-only. We mutate `data`
        // below (data.resources / data.version, and loadSceneFile's in-place
        // migration chain), so shallow-clone first — otherwise the dev-server /
        // agent-bridge caller that holds onto the same parsed object after this
        // call gets a silently rewritten `resources` (the full transitive prefab
        // walk, not what it passed) and a bumped `version`. A shallow clone is
        // enough: the only top-level fields we overwrite are `resources` and
        // `version` (whole-array / scalar replacement, not deep edits), and the
        // migration chain likewise reassigns whole fields on the clone.
        data = { ...opts.preloaded };
      } else {
        // assetUrl() is a no-op in dev/native (BASE_URL '/'), prefixes for sub-path web
        // hosting, and resolves to the inlined blob: URL in a playable single-file build.
        const res = await fetch(assetUrl(path), { signal: controller.signal, ...ASSET_FETCH_INIT });
        if (!res.ok) throw new Error(`Failed to fetch scene "${path}": HTTP ${res.status}`);
        data = await res.json();
      }
      // Register scene id in the manifest so the editor can recover it on save
      const sceneId = (data as { id?: string }).id;
      if (sceneId && isGuid(sceneId)) registerAsset(sceneId, path, 'scene');

      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');

      // 4. Build the full resource set. Strategy:
      //    (a) Seed from data.resources + entity walk (scene file is a hint;
      //        entity walk is authoritative — a stale manifest may be missing
      //        entries like HDRs added after first serialization).
      //    (b) Fetch every prefab referenced so far, then walk its nested
      //        entities to discover their resources (mesh.json/mat.json/etc).
      //    (c) Repeat (b) until no new prefabs appear (nested prefabs).
      //    (d) acquireResource for every non-prefab ref in parallel.
      //
      //    Without this, resources nested inside prefabs (like the grass
      //    mesh + Material_002 + grass texture in tropical-island) load
      //    lazily from the render loop, causing visible pop-in on first view.
      const seen = new Set<string>();
      const allRefs: SceneResourceRef[] = [];
      const addRef = (ref: SceneResourceRef) => {
        const key = `${ref.type}:${ref.path}`;
        if (seen.has(key)) return false;
        seen.add(key);
        allRefs.push(ref);
        return true;
      };
      for (const ref of data.resources ?? []) addRef(ref);
      for (const ref of collectResourceRefsFromEntities(data.entities)) addRef(ref);

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
      // discovered so far — scene entities, persistent entities, AND control-track prefabs above.
      const prefabQueue: string[] = allRefs.filter(r => r.type === 'prefab').map(r => r.path);
      const prefabProcessed = new Set<string>();
      while (prefabQueue.length > 0) {
        const prefabPath = prefabQueue.shift()!;
        if (prefabProcessed.has(prefabPath)) continue;
        prefabProcessed.add(prefabPath);
        // Acquire fetches the prefab JSON into the cache under this sceneId.
        await acquirePrefab(id, prefabPath);
        if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const cached = getCachedPrefab(prefabPath) as { entities?: SceneEntityEntry[] } | null;
        if (!cached?.entities) continue;
        // Walk the prefab's entities — same collector as scene entities.
        const nested = collectResourceRefsFromEntities(cached.entities);
        for (const ref of nested) {
          if (addRef(ref) && ref.type === 'prefab') prefabQueue.push(ref.path);
        }
      }

      // Persist the merged manifest back so downstream code (loadSceneFile
      // for persistent entities, telemetry) sees the full picture.
      data.resources = allRefs;
      data.version = Math.max(data.version ?? 6, 6);

      const resources = allRefs;
      let loaded = 0;
      const total = resources.length;
      opts.onProgress?.(0, total);

      // Prefabs already fetched above; re-acquiring is a no-op via the cache
      // but ensures the refcount is set. Remaining resources (models, meshes,
      // materials, environments, fonts) fetch here in parallel.
      await Promise.all(resources.map(async (ref) => {
        await acquireResource(id, ref);
        loaded++;
        opts.onProgress?.(loaded, total);
      }));

      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');

      // 5. Snapshot persistent entities from the current world BEFORE creating
      //    the next world. We do this early so we can also acquire their resources
      //    under the new sceneId, ensuring they survive the post-swap release.
      const persistentSnapshots = snapshotPersistentEntities(getCurrentWorld());

      // Acquire any resources that persistent entities reference, under the new
      // scene's id. If a resource is also in the new scene's manifest, this is
      // a no-op (refcount already incremented). If it's only used by a persistent
      // entity, this prevents it from being disposed during the post-swap release.
      const persistentResources = collectResourceRefsFromEntities(persistentSnapshots);
      await Promise.all(persistentResources.map((ref) => acquireResource(id, ref)));

      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');

      // 6. Filter the scene data to remove entries that collide with persistent
      //    entities. Without this, both the respawned persistent entity and the
      //    scene-file entity with the matching Persistent guid would end up in
      //    the new world. The persistent shadows the scene file: any scene root
      //    whose Persistent.guid matches a runtime-persistent guid has its
      //    entire subtree skipped.
      const filteredData = filterPersistentDuplicates(data, persistentSnapshots);

      // 7. Create the staging world and spawn the new scene's entities
      nextWorld = createWorld();

      const stagingWorld = nextWorld; // captured for closures so TS narrows from null
      await loadSceneFile(filteredData, {
        world: stagingWorld,
        fetchPrefab: async (prefabPath: string) => {
          // Use the refcounted prefab cache (already acquired in step 4)
          const cached = getCachedPrefab(prefabPath);
          if (cached) return cached as object;
          // Fallback for prefabs not in the manifest (legacy scenes)
          await acquirePrefab(id, prefabPath);
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
            const eaMeta = getAllTraits().find((m) => m.name === 'EntityAttributes');
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
            const allTraitsMeta = (await import('../ecs/traitRegistry')).getAllTraits();
            for (const e of stagingWorld.entities) {
              if ((e as unknown as { id(): number }).id() !== rootEcsId) continue;
              for (const [name, data] of Object.entries(rootExtraTraits)) {
                const meta = allTraitsMeta.find((m) => m.name === name);
                if (!meta) continue;
                const ent = e as unknown as {
                  has: (t: unknown) => boolean;
                  add: (instance: unknown) => void;
                  set: (t: unknown, data: unknown) => void;
                };
                const isTag = meta.category === 'tag' || data === true;
                if (ent.has(meta.trait)) {
                  // Trait already exists from the prefab — overwrite values from scene.
                  if (!isTag) ent.set(meta.trait, data as Record<string, unknown>);
                } else {
                  if (isTag) ent.add((meta.trait as () => unknown)());
                  else ent.add((meta.trait as (d: Record<string, unknown>) => unknown)(data as Record<string, unknown>));
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

      // Time is a global resource — make sure every scene has one even if the
      // file didn't include the singleton entity. Otherwise getTime() returns
      // null and any system that depends on delta (rotate3DSystem etc.) is a no-op.
      let hasTime = false;
      stagingWorld.query(Time).updateEach(() => { hasTime = true; });
      if (!hasTime) {
        const ent = stagingWorld.spawn(Time());
        registerEntity(ent, stagingWorld);
      }

      // Input is likewise a global resource — ensure every scene has the singleton
      // so the app-pipeline inputSystem has a target to write and consumers (character
      // input, UI focus) can read it. Runtime-only; never authored into a scene file.
      let hasInput = false;
      stagingWorld.query(Input).updateEach(() => { hasInput = true; });
      if (!hasInput) {
        const ent = stagingWorld.spawn(Input());
        registerEntity(ent, stagingWorld);
      }

      // Respawn persistent entities into the staging world. They will then be
      // present when the swap happens, with the same trait data but new entity ids.
      if (persistentSnapshots.length > 0) {
        await loadSceneFile(
          // Snapshots come from the live (already-migrated) world, so tag them
          // current — an older version would re-run migrations needlessly.
          { version: SCENE_FORMAT_VERSION, resources: [], entities: persistentSnapshots },
          {
            world: nextWorld,
            fetchPrefab: async () => null, // persistent entities never carry prefab refs (rare case)
            loadModels: false,
          },
        );
      }

      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');

      // Prewarm: let renderers compile shaders against the staging world BEFORE
      // we flip setCurrentWorld. This eliminates the first-frame shader-compile
      // stutter after swap. Hooks are best-effort — failures are logged and the
      // swap proceeds anyway.
      await this.fireBeforeSwapHooks(nextWorld);

      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');

      // 8. Atomic swap.
      const oldSceneId = this.currentScene?.id;
      const oldPath = this.currentScene?.path ?? '';
      const oldWorld = getCurrentWorld();
      const promotedWorld = nextWorld;

      setCurrentWorld(promotedWorld); // fires onWorldSwap → renderers clear caches
      nextWorld = null; // ownership transferred to current; do not destroy in catch

      this.currentScene = { id, path };
      this.nextLoad = null;

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

      // Dispose the previous scene's scene-scoped managers before the old world
      // is torn down; if the GAME is also changing, dispose its game-scoped
      // managers too (they survive in-game swaps, but not a game change). Pass
      // the OLD world — still alive until the destroy below — so a dispose() that
      // cleans up world-bound state hits the right world, not the freshly-
      // promoted one. Awaited so a manager whose async init is still in flight is
      // disposed only after that init settles.
      if (gameChanged) await disposeActiveGameManagers({ world: oldWorld, scenePath: oldPath });
      await disposeActiveSceneManagers({ world: oldWorld, scenePath: oldPath });

      // Release resources from the old scene. Anything still held by the new
      // scene survives via refcount.
      if (oldSceneId !== undefined) releaseAllForScene(oldSceneId);

      // Free the old world's slot in koota's worldId pool. koota caps total
      // worlds at 16; without this, every scene swap permanently consumes a
      // slot and the engine breaks after ~16 swaps.
      if (oldWorld !== promotedWorld) {
        try { oldWorld.destroy(); } catch (e) { console.warn('[SceneManager] Failed to destroy old world:', e); }
      }

      // 8. Fire per-scene callbacks for dynamic entity spawning
      this.fireSceneCallbacks(path);

      // Activate the new game's game-scoped managers (only when the game changed;
      // an in-game swap keeps them running), then the new scene's scene-scoped
      // managers. Awaited so async init (e.g. entity spawning) completes before
      // loadScene resolves.
      if (gameChanged) await initGameManagersFor(nextGameId, path);
      await initSceneManagersFor(path);

      // 9. Done
    } catch (err) {
      // Failure or abort — clean up the next-scene's allocations
      releaseAllForScene(id);
      if (nextWorld) {
        try { nextWorld.destroy(); } catch { /* ignore */ }
      }
      if (this.nextLoad?.id === id) this.nextLoad = null;
      throw err;
    } finally {
      opts.signal?.removeEventListener('abort', externalAbort);
    }
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
    const oldPath = this.currentScene?.path ?? '';
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

    if (this.currentScene) {
      releaseAllForScene(this.currentScene.id);
      this.currentScene = null;
    }
    // Hand the world registry a fresh empty world so subsequent code doesn't
    // see stale entities. Tests typically reset modules instead.
    setCurrentWorld(createWorld());
  }

  /** For tests: reset the sceneId counter so test runs are deterministic. */
  resetForTesting(): void {
    this.nextSceneId = 1;
    this.currentScene = null;
    this.nextLoad = null;
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

/** Walk a world for entities tagged Persistent (must be roots), collect each
 *  root + its full child subtree (via EntityAttributes.parentId), and serialize
 *  every entity in those subtrees to the same SceneEntityEntry format that
 *  loadSceneFile consumes. The output can be fed straight back into loadSceneFile
 *  to respawn the entities in another world. */
function snapshotPersistentEntities(world: World): SceneEntityEntry[] {
  const allTraits = getAllTraits();
  const attrMeta = allTraits.find((m) => m.name === 'EntityAttributes');

  // Step 1: collect persistent root entity ids
  const persistentRootIds: number[] = [];
  try {
    world.query(Persistent).updateEach((_: unknown[], entity: Entity) => {
      persistentRootIds.push(entity.id());
    });
  } catch {
    // Persistent trait not registered in this world — nothing to do
    return [];
  }

  if (persistentRootIds.length === 0) return [];

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

  // BFS from each persistent root to collect the full subtree
  const subtreeIds = new Set<number>();
  for (const rootId of persistentRootIds) {
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
      for (const key of Object.keys(meta.fields)) {
        traitData[key] = data[key];
      }
      entry.traits[meta.name] = traitData;
    }
    entriesById.set(id, entry);
  }

  // Return in BFS order so loadSceneFile's parentId remap works correctly
  // (parents are spawned before children — actually loadSceneFile remaps after,
  // so order doesn't strictly matter, but it's nicer for debugging).
  return [...entriesById.values()];
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
export const sceneManager = new SceneManagerImpl();

/** The id of the currently-loaded scene (for scene-scoped resource ownership from
 *  the renderers — e.g. the Text sync acquiring a font not yet in the manifest).
 *  undefined before the first scene loads. */
export function getCurrentSceneId(): number | undefined {
  return (sceneManager as unknown as { currentScene: { id: number } | null }).currentScene?.id;
}

// Expose for debug console: window.__sceneManager
if (typeof window !== 'undefined') {
  (window as Window & { __sceneManager?: SceneManagerImpl }).__sceneManager = sceneManager;
}

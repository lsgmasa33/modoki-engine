// HMR: `_customPanels`/`_gameView`/`_extraMenus`/`_projectSettings` below are written ONLY
// by createEditor(), which app/editor/setup.ts calls once at bootstrap. A module swap
// resets them to empty with nothing to repopulate them, and EditorApp reads
// getGameViewComponent() at MODULE scope — so the Game panel silently falls back to a stub.
// The returned component's identity also can't be swapped into the mounted tree (App.tsx
// resolved it through React.lazy). Reload instead; see input/keymap.ts for the pattern.
if (import.meta.hot) import.meta.hot.accept(() => { window.location.reload(); });

/** createEditor — factory that returns a configured React editor component.
 *  Games call this with their config, postprocessors, traits, and custom panels. */

import React from 'react';
import type { GameConfig } from '../runtime/core/config';
import type { EditorPanelDef } from '../runtime/core/gameDefinition';
import type { TraitMeta } from '../runtime/core/ecs/traitRegistry';
import { registerModelPostprocessor, type ModelPostprocessor } from '../runtime/loaders/modelPostprocessorRegistry';
import { registerTrait } from '../runtime/core/ecs/traitRegistry';
import { setGameConfig } from '../runtime/core/config';
import { getCurrentWorld, spawnEntity } from '../runtime/core/ecs/world';
import { Camera } from '../runtime/traits/Camera';
import { Transform } from '../runtime/core/traits/Transform';
import { EntityAttributes } from '../runtime/core/traits/EntityAttributes';
import { loadScene, setCurrentScenePath, setScenePersistenceProject, lastSceneKey } from './scene/serialize';
import { registerSelectionRestore } from './store/selectionRestore';
import { registerLastAnimationClipPersistence, restoreLastAnimationClip } from './animation/lastAnimationClip';
import { registerLastSkinRigPersistence, restoreLastSkinRig } from './panels/lastSkinRig';
import { registerBuiltinCreatableAssets } from './panels/builtinCreatableAssets';
import { ensureManifestLoaded, loadManifestJson, getGuidForPath, resolveGuidToPath, isGuid, getAllAssets } from '../runtime/loaders/assetManifest';
import { backendFetch } from './backend/editorBackend';
import { rendererReady } from '../runtime/loaders/textureResolver';
import { rendererInitFailedPromise, getRendererProgress, hasViewportBegunInit } from '../runtime/core/activeRenderer';
import { installConsoleCapture } from './consoleCapture';
import { useEditorStore } from './store/editorStore';
import { assetSetSignature } from './assetSetSignature';

/** Last asset-set signature the Assets panel was refreshed on (see assetSetSignature
 *  for why we dedupe rather than refresh on every broadcast). */
let lastAssetSig: string | null = null;

// ── Phase 2.5: resolved `build.modules.render3d` fact ─────────────────────────────────────
// Fetched once at boot (see `sceneReady` below) via `/api/build-modules`, which resolves
// `'auto' | boolean` server-side (a Node-only scene scan the browser can't run itself).
// Exposed so the renderer-health watchdog can suppress its "no 3D viewport" warning for a
// project that doesn't render 3D at all, and so `modoki_get_editor_state`'s `rendererGate`
// (`app/editor/agentEditorOps.ts`) can explain WHY. `undefined` until the fetch resolves, or
// forever on failure — callers must treat that as "unknown" (fail OPEN: still warn), never as
// `false`.
let resolvedRender3d: boolean | undefined;
export function getResolvedRender3d(): boolean | undefined {
  return resolvedRender3d;
}

// `lastSceneKey` now lives in scene/serialize (single source shared with the writer,
// setCurrentScenePath). Re-exported here for existing test imports.
export { lastSceneKey };

/** Build the ordered, de-duplicated list of scene paths to try, most-preferred
 *  first: a launch-scoped `--scene` override (issue #43, already resolved by
 *  `resolveBootSceneOverride`), then the stored last-opened scene, then the project's
 *  configured default. Falsy entries are dropped and duplicates collapsed (a last-scene
 *  equal to the default yields a single candidate).
 *
 *  The override is PREPENDED, never substituted — that is what makes a bad override
 *  degrade to the remembered scene via `loadFirstScene`'s existing 404 self-heal instead
 *  of booting a blank world. Keeping the precedence here (rather than combining at the
 *  call site) is deliberate: it is the one place the boot order is decided, so a test can
 *  actually pin it. Pure — exported for unit testing. */
export function resolveSceneCandidates(
  lastScene: string | null | undefined,
  configScenePath: string | undefined,
  overrideScene?: string | null,
): string[] {
  return [...new Set(
    [overrideScene, lastScene, configScenePath].filter((p): p is string => !!p),
  )];
}

/** Resolve a `--scene`/`MODOKI_SCENE` boot override (issue #43) to a scene path, or
 *  `null` if it doesn't resolve — a typo, no match, or an ambiguous name. `null` tells
 *  the caller to fall through to the normal last-scene/config.scenePath candidates
 *  rather than booting a blank world.
 *
 *  Accepts EITHER a path (contains `/` or ends in `.json` — used as-is, no lookup)
 *  OR a bare name (`Level-0002`), matched case-insensitively against `sceneList`'s
 *  basenames with the `.json` extension stripped — that's what an agent actually
 *  types on the command line.
 *
 *  An ambiguous name (>1 match) is refused rather than guessed, matching this repo's
 *  rule that an ambiguous NAME lookup is refused everywhere rather than first-matched
 *  (the same rule `{name}` entity addressing follows). Pure — exported for unit
 *  testing; the caller supplies `sceneList` (the open project's registered scene
 *  paths) since resolution here must not depend on the manifest module directly. */
export function resolveBootSceneOverride(override: string | null | undefined, sceneList: string[]): string | null {
  if (!override) return null;
  if (override.includes('/') || override.toLowerCase().endsWith('.json')) return override;
  const target = override.toLowerCase();
  const matches = sceneList.filter((p) => {
    const base = (p.split('/').pop() ?? p).replace(/\.json$/i, '');
    return base.toLowerCase() === target;
  });
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    console.warn(`[Editor] --scene override '${override}' matched no scene. Available scenes: ${sceneList.length ? sceneList.join(', ') : '(none)'}`);
  } else {
    console.warn(`[Editor] --scene override '${override}' is ambiguous — matches: ${matches.join(', ')}. Pass a full path to disambiguate.`);
  }
  return null;
}

/** Map a boot-scene candidate to its canonical working-copy path before loading.
 *
 *  A BUILT editor (cloud host, packaged Electron) gets `config.scenePath` from a
 *  Vite `?url` import — a HASHED, bundled COPY of the scene baked into the editor
 *  dist (`/assets/tropical-island-DC3lOki3.json`), NOT the working-copy file. If
 *  the editor boots that path, the loaded scene's path never matches the asset
 *  watcher's working-copy broadcast (`/assets/scenes/tropical-island.json`), so an
 *  external/agent/git edit to the auto-loaded scene doesn't hot-reload and a save
 *  doesn't round-trip — cloud-editor gap #2. (Scenes opened via the Scenes panel
 *  already use the canonical path, so they round-trip; only the *first auto-load*
 *  was affected.) The manifest already maps the scene's GUID → its canonical
 *  working-copy path, so resolve through it and boot that instead.
 *
 *  Cheap path: a candidate already registered in the manifest (a Scenes-panel
 *  path, or a prior canonical `lastScene`) is returned untouched — no fetch.
 *  Otherwise fetch the candidate once, read its scene `id` (GUID), and map it to
 *  the canonical manifest path. ANY failure (non-OK fetch, missing/non-GUID id,
 *  unregistered scene) falls back to the raw candidate, preserving the dev `?url`
 *  behaviour. Requires the manifest to be loaded first. The `doFetch` injection
 *  point exists for unit testing. */
// Matches a dev-mode `/@fs/<abs>/runtime/assets/<rest>` candidate — produced when
// config.ts's `?url` import resolves OUTSIDE Vite's root — capturing `<rest>` so it can
// be rewritten to the asset-scanner's `/assets/<rest>` convention for the OPEN project
// (flat-project layout: `<projectRoot>/runtime/assets` → `/assets`).
//
// ⚠️ The match alone does NOT prove the file belongs to the open project. findAssetRoots
// serves THREE roots that all end in `/runtime/assets/`: `/assets` (the open project),
// `/modoki/assets` (the engine's built-ins), and `/<root>/<id>/assets` (every OTHER
// project in a multi-project repo). Rewriting any of the latter two to `/assets/…` would
// silently point at a same-named file under the open project — a wrong-file load, which
// is worse than the boot failure this rewrite exists to prevent. So the rewrite must be
// CONFIRMED — by origin when we have the open project's root, else by manifest name match
// (see canonicalBootScenePath) — before it is used.
const FS_RUNTIME_ASSETS_RE = /^\/@fs\/(.*)\/runtime\/assets\/(.+)$/;

/** Normalize a filesystem path for a Windows-safe prefix comparison: forward slashes,
 *  lowercase (Windows paths are case-insensitive), no trailing separator. */
function normalizeFsPath(p: string): string {
  const s = p.replace(/\\/g, '/').toLowerCase();
  return s.length > 1 && s.endsWith('/') ? s.slice(0, -1) : s;
}

/** Segment-aware: is `child` the same path as, or inside, `parent`? Avoids a bare
 *  `startsWith` false-positive on a prefix-sharing sibling (`sling` vs `sling-evil`). */
function isWithinPath(child: string, parent: string): boolean {
  const c = normalizeFsPath(child), p = normalizeFsPath(parent);
  return c === p || c.startsWith(`${p}/`);
}

export async function canonicalBootScenePath(
  scenePath: string,
  doFetch: typeof fetch = fetch,
  projectRoot?: string,
): Promise<string> {
  // Already a registered manifest path (the working-copy canonical) → nothing to do.
  if (getGuidForPath(scenePath)) return scenePath;
  // A `/@fs/<abs>/runtime/assets/<rest>` candidate is ALREADY the working-copy file, so
  // map it to `/assets/<rest>` instead of fetching it. That sidesteps a Windows-only Vite
  // bug: `/@fs/`'s raw-static-file middleware strips the drive letter and serves via a
  // root-relative `sirv`, so a project on a DIFFERENT DRIVE than the running Vite
  // process's cwd 404s internally and silently falls through to the SPA `index.html`
  // (a 200 OK `<!doctype …>` body) — which is why fetching it can't be trusted at all.
  const fsMatch = scenePath.match(FS_RUNTIME_ASSETS_RE);
  if (fsMatch) {
    const [, absPrefix, rest] = fsMatch;
    const openProjectPath = `/assets/${rest}`;
    // Prefer disambiguating by ORIGIN — does the `/@fs/<abs>` prefix actually sit inside the
    // open project's root? This is strictly safer than the manifest check below (it can't be
    // fooled by a same-named file in a sibling project or the engine's built-ins) and doesn't
    // depend on the manifest having caught up yet, which the manifest-only check below could
    // race on a cold boot. `projectRoot` is optional (backward-compatible: a caller that can't
    // supply it — e.g. no `/api/identity` reachable yet — falls through to the manifest check).
    if (projectRoot) {
      return isWithinPath(absPrefix, projectRoot) ? openProjectPath : scenePath;
    }
    // No project root available: fall back to the OLD name-based check. Only accept the
    // rewrite when the manifest actually registers it; an unregistered rewrite is discarded
    // and we fall through, so the worst case stays the pre-existing boot failure rather than
    // becoming a silent wrong-file load. KNOWN LIMITATION (when projectRoot is absent): this
    // disambiguates by NAME, not origin — a foreign-root candidate whose tail happens to match
    // a registered file of the open project would still be accepted as that file.
    if (getGuidForPath(openProjectPath)) return openProjectPath;
  }
  try {
    const res = await doFetch(scenePath, { cache: 'no-store' });
    if (!res.ok) return scenePath;
    const data = (await res.json()) as { id?: unknown };
    const id = typeof data?.id === 'string' ? data.id : null;
    if (id && isGuid(id)) {
      const canonical = resolveGuidToPath(id);
      if (canonical && canonical !== scenePath) return canonical;
    }
  } catch {
    /* fall back to the raw candidate */
  }
  return scenePath;
}

/** Load the first candidate that loads, canonicalizing each to its working-copy
 *  path first (gap #2) and falling back to the RAW candidate if the canonical
 *  form fails — so a host that can't serve the working copy still boots the
 *  always-present baked bundle copy instead of dropping to an empty world.
 *  Returns the path actually loaded, or null if none did. Pure over its injected
 *  collaborators — exported for unit testing. */
export async function loadFirstScene(
  candidates: string[],
  deps: { canonicalize: (p: string) => Promise<string>; load: (p: string) => Promise<boolean> },
): Promise<string | null> {
  // A candidate that THROWS must not abort the fallback chain. `load` rejects (it
  // does not merely return false) whenever the host serves something that isn't the
  // scene JSON — most commonly the dev server's SPA index.html fallback, which makes
  // JSON.parse throw `Unexpected token '<'`. That escaped this loop, so the very
  // fallback the loop exists to provide never ran and editor boot died on the first
  // bad candidate. Real case: a stale `/@fs/<abs>` last-scene pointing at a project
  // on a DIFFERENT Windows drive — Vite's html-fallback middleware refuses such
  // paths (vitejs/vite#12816, closed as not-planned), so it 404s to index.html while
  // the project's own `/assets/...` candidate right behind it would have loaded.
  const tryLoad = async (p: string): Promise<boolean> => {
    try {
      return await deps.load(p);
    } catch (err) {
      console.warn(`[Editor] Scene at ${p} failed to load, trying next fallback…`, err);
      return false;
    }
  };
  for (const candidate of candidates) {
    // Canonicalization is best-effort: fall back to the raw candidate if it throws.
    let canonical = candidate;
    try {
      canonical = await deps.canonicalize(candidate);
    } catch {
      // canonical is already `candidate` (the declaration default).
    }
    if (await tryLoad(canonical)) return canonical;
    if (canonical !== candidate && (await tryLoad(candidate))) return candidate;
    console.warn(`[Editor] Scene not found at ${candidate}, trying next fallback…`);
  }
  // EVERY candidate missed — that IS a real failure, and it is the only one worth an `error`.
  // Individual misses log at `warn` (loadScene's `probing` flag), because a boot that recovers
  // on a later candidate is healthy and must not leave red in the console (#91).
  //
  // ZERO candidates is NOT that failure: it means no scene was configured or remembered at all
  // (a fresh project, or the e2e harness), and the caller's initWorld/empty-camera path handles
  // it by design. Nothing was tried, so nothing failed — and logging it as an error here would
  // recreate the exact false-failure this issue is about, since `smoke-packaged.sh` and
  // `assert-app-renders.sh` fail on ANY renderer console error. (Measured: the e2e suite boots
  // with 0 candidates on every spec.)
  if (candidates.length > 0) {
    console.error(
      `[Editor] Failed to load a scene: all ${candidates.length} boot candidate(s) missed `
      + `(${candidates.join(', ')}). Booting an empty world.`,
    );
  }
  return null;
}

/** HARD deadline for `rendererReady` to fire (SceneView calling setActiveRenderer).
 *  Beyond this we surface a failure instead of hanging forever. Deliberately generous:
 *  a PACKAGED first-launch-after-update clears the Vite dep-cache, and the cold
 *  re-optimize + first WebGPU/WGSL compile can take a LONG time on a slow machine
 *  (observed >50s on Windows with Defender scanning every chunk). The old 15s cap
 *  ABORTED that legitimate cold start — the scene load rejected and the user got a
 *  blank world + a scary "scene load failed" until they reloaded (which is fast
 *  because the cache is then warm). 120s comfortably covers the cold path while still
 *  eventually surfacing a genuinely dead renderer (a real WebGPU/WebGL init failure). */
export const RENDERER_READY_TIMEOUT_MS = 120_000;

/** SOFT deadline: at this point the renderer usually IS ready, so if it isn't we emit a
 *  NON-FATAL warning (kept waiting up to the hard cap) — otherwise a slow cold start is a
 *  silent blank screen for up to two minutes. This is the old hard value, repurposed as a
 *  progress signal (it forwards to the packaged main.log for diagnosis). */
export const RENDERER_READY_SOFT_TIMEOUT_MS = 15_000;

/** Deadline for ANY viewport to at least BEGIN renderer creation.
 *
 *  Distinct from the two budgets above because it answers a different question. Those ask
 *  "has the renderer finished?", which a cold Vite dep-optimize can legitimately stretch to
 *  a minute or more. This asks "has anything even STARTED?", which does not depend on GPU or
 *  bundler speed at all — only on a viewport mounting and running its effect. Measured on a
 *  normal boot, that happens at ~1.0s; 12s is ~12x headroom. Past it, waiting the remaining
 *  108s cannot help, because nothing is in flight to finish. */
export const NO_VIEWPORT_TIMEOUT_MS = 12_000;

/** Await `ready`, but reject if it doesn't settle within `timeoutMs` (the HARD cap). A
 *  non-fatal soft warning fires at `softTimeoutMs` and we KEEP waiting — a slow-but-fine
 *  cold start (Vite dep-optimize / GPU warm-up) recovers instead of aborting the scene load.
 *  Both pending timers are ALWAYS cleared once the race settles (success OR hard timeout) so
 *  a slow-then-eventually-ready renderer doesn't leave a dangling timer (which under Node/test
 *  would also keep the process alive). Pure (timer-injectable) — exported for unit testing. */
export async function awaitRendererReady(
  ready: Promise<unknown>,
  timeoutMs: number = RENDERER_READY_TIMEOUT_MS,
  // NOTE: `failed` is injected (defaulted below) so this stays a pure, unit-testable race.
  // NOTE: the defaults MUST be bound to globalThis. A bare `{ setTimeout, clearTimeout }`
  // is invoked as `timers.setTimeout(...)` → `this === timers`, which browsers reject with
  // "Illegal invocation" (the real scene-load path, not exercised by injected fake timers).
  timers: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  },
  opts: {
    softTimeoutMs?: number;
    onSoftTimeout?: () => void;
    /** Resolves ONLY on a definitive renderer-init failure. Racing it is what turns a
     *  two-minute silent wait into a sub-second, correctly-attributed error. */
    failed?: Promise<Error>;
    /** Last known bring-up progress, quoted in the timeout message. */
    progress?: () => string;
    /** Has any viewport begun renderer creation? Enables the fast no-viewport deadline. */
    hasViewportBegun?: () => boolean;
    /** Deadline for the above (default `NO_VIEWPORT_TIMEOUT_MS`). */
    noViewportMs?: number;
    /** Should the ENTIRE watchdog actually warn about a missing viewport — the 12s
     *  fast-fail, the 15s soft-timeout nudge, AND the 120s hard-cap message alike? Injected so
     *  this function stays a pure, timer-injectable race — the caller (createEditor's boot
     *  sequence) decides based on whether the project renders 3D at all (see Phase 2.5,
     *  `/api/build-modules`); telling a 2D-only project ANY flavor of "renderer isn't ready" is
     *  noise, not diagnosis — the owner confirmed this after seeing the 15s nudge fire live on a
     *  render3d:false project even though the 12s message was correctly suppressed. Defaults to
     *  always-warn when omitted, i.e. the old behaviour.
     *
     *  Suppression lifts the instant `hasViewportBegun()` turns true — a viewport that DOES
     *  start (e.g. the user opens a Scene panel on a 2D project anyway) makes renderer health
     *  relevant again, so normal soft/hard-cap reporting resumes for that attempt. When
     *  suppressed, the soft/hard timers still fire on schedule but simply skip their side
     *  effect — the hard-cap's promise branch just never settles (mirrors the no-viewport
     *  branch below), which is harmless: nothing awaits it exclusively. */
    shouldWarnNoViewport?: () => boolean;
  } = {},
): Promise<void> {
  // True when the caller says "don't warn" AND no viewport has begun yet. Re-checked at every
  // firing point (not cached) since `hasViewportBegun` can flip true between them.
  const suppressed = () =>
    !!opts.shouldWarnNoViewport && !opts.shouldWarnNoViewport() && !(opts.hasViewportBegun?.() ?? false);

  const softMs = Math.min(opts.softTimeoutMs ?? RENDERER_READY_SOFT_TIMEOUT_MS, timeoutMs);
  const onSoftTimeout = opts.onSoftTimeout ?? (() => console.warn(
    `[Editor] renderer still initializing after ${softMs}ms — a cold Vite dep-optimize / GPU ` +
    `warm-up (common on the FIRST launch after an update, especially on Windows) can take a while. ` +
    `Waiting up to ${timeoutMs}ms before giving up…`,
  ));
  let hardId: ReturnType<typeof setTimeout> | undefined;
  const rendererTimeout = new Promise<never>((_, reject) => {
    hardId = timers.setTimeout(() => {
      if (suppressed()) return; // no viewport expected, none began — the long budget was moot
      // Report the last thing bring-up actually managed, rather than asserting a cause. The
      // old message flatly claimed "SceneView never called setActiveRenderer" and told the
      // reader to look for a WebGPU/WebGL init error — which SceneView logged at WARN level,
      // so anyone filtering the console to `error` (as the message implies) found nothing.
      reject(new Error(
        `[Editor] rendererReady did not resolve within ${timeoutMs}ms. ` +
        `Last renderer bring-up progress: ${opts.progress?.() ?? 'unknown'}. ` +
        `The 3D viewport never registered a renderer, so nothing will render in the Scene/Game ` +
        `panels (the scene's entity data still loads normally).`,
      ));
    }, timeoutMs);
  });
  // A definitive init failure short-circuits the whole budget.
  const failedRace = opts.failed
    ? opts.failed.then((e) => {
        throw new Error(
          `[Editor] renderer init FAILED — the 3D viewport could not create a renderer, so ` +
          `nothing will render in the Scene/Game panels (the scene's entity data still loads ` +
          `normally). This is not a slow start; it will not resolve on its own. Cause: ${e.message}`,
          { cause: e },
        );
      })
    : null;
  // Fast, DISTINGUISHABLE failure: nothing ever started. Only armed when the caller can
  // answer the question — a caller that can't keeps exactly the old behaviour.
  let noViewportId: ReturnType<typeof setTimeout> | undefined;
  const noViewportRace = opts.hasViewportBegun
    ? new Promise<never>((_, reject) => {
        noViewportId = timers.setTimeout(() => {
          if (opts.hasViewportBegun!()) return; // bring-up IS underway — let the long budget run
          // The project may not render 3D at all (Phase 2.5) — telling it "no 3D viewport" would
          // be noise, not diagnosis. Suppressing here just means this promise never settles; the
          // hard-cap budget above keeps running underneath (also suppressed — see `suppressed`).
          if (suppressed()) return;
          reject(new Error(
            `[Editor] no 3D viewport began renderer creation within ` +
            `${opts.noViewportMs ?? NO_VIEWPORT_TIMEOUT_MS}ms — nothing will render in the ` +
            `Scene/Game panels until one is open. The scene itself loads normally. This is NOT a ` +
            `slow cold start — nothing has started, so waiting longer cannot help. Open a Scene ` +
            `or Game panel from the Window menu.`,
          ));
        }, opts.noViewportMs ?? NO_VIEWPORT_TIMEOUT_MS);
      })
    : null;
  const softId = timers.setTimeout(() => { if (!suppressed()) onSoftTimeout(); }, softMs);
  try {
    const racers: Promise<unknown>[] = [ready, rendererTimeout];
    if (failedRace) racers.push(failedRace);
    if (noViewportRace) racers.push(noViewportRace);
    await Promise.race(racers);
  } finally {
    if (hardId !== undefined) timers.clearTimeout(hardId);
    if (noViewportId !== undefined) timers.clearTimeout(noViewportId);
    timers.clearTimeout(softId);
  }
}

/** A single editable field in the Project Settings window. `key` is a dot-path
 *  into the settings object (e.g. "build.webBucket"). */
export interface ProjectSettingsField {
  key: string;
  label: string;
  type: 'text' | 'number' | 'checkbox' | 'select' | 'combo' | 'string-list' | 'physics-layers' | 'path' | 'scene-list' | 'module-toggles' | 'quality-tiers' | 'readonly-text';
  /** Options for `select` fields, and suggestions for a `combo` (free-text +
   *  datalist) field — the stored value is the option's `value`. */
  options?: { value: string; label: string }[];
  placeholder?: string;
  help?: string;
  /** For `path` fields — whether the Browse… button picks a file or a folder. */
  pathMode?: 'file' | 'folder';
  /** `readonly-text` renders a disabled input showing the current value — for a
   *  setting that's DERIVED (e.g. `ota.publicKey`, written by a dedicated flow
   *  like the OTA Keys dialog), never hand-typed. Still persisted through the
   *  normal save path; the form just never offers an editable control for it. */
  /** Conditional visibility: show this field only when the current value at
   *  `key` (a dot-path into the settings object) is one of `in`. Used e.g. to
   *  show the GCS/CDN fields only in the matching web-deploy mode. */
  showIf?: { key: string; in: string[] };
}

/** One group of fields inside a Project Settings tab. */
export interface ProjectSettingsGroup {
  title: string;
  fields: ProjectSettingsField[];
}

/** One tab in the Project Settings window (e.g. General, Web, iOS). */
export interface ProjectSettingsTab {
  title: string;
  groups: ProjectSettingsGroup[];
}

/** Project-specific Project Settings definition, injected by the host so the
 *  reusable engine stays free of project-specific fields. */
export interface ProjectSettingsSchema {
  tabs: ProjectSettingsTab[];
  /** Fetch the current values (e.g. GET /api/project-settings). */
  load: () => Promise<Record<string, unknown>>;
  /** Persist values on Apply. Resolve `true` on success, or a MESSAGE explaining
   *  the refusal so the dialog can show it. The backend rejects a save for reasons
   *  the user can act on (an unsafe build field, a hand-edited config that no longer
   *  parses); returning a bare `false` for those left the dialog silently refusing
   *  to close with the reason stranded in the console. */
  save: (values: Record<string, unknown>) => Promise<boolean | string>;
  /** Open a native file/folder chooser for `path` fields. Resolves the chosen
   *  path (project-relative when inside the project, else absolute), or null on
   *  cancel/unsupported. Host-provided so the package stays backend-agnostic. */
  pickPath?: (mode: 'file' | 'folder') => Promise<string | null>;
}

export interface EditorOptions {
  /** Game configuration */
  config: GameConfig;
  /** The open project's game id (e.g. "space-console"). Used to activate the
   *  project's game-scoped managers on boot — the canonical working-copy scene
   *  path the editor boots (gap #2) has no `/games/<id>/` segment for SceneManager
   *  to derive it from. Distinct from `config.name` (the display name). */
  gameId?: string;
  /** Game-specific model postprocessors */
  postprocessors?: { id: string; postprocessor: ModelPostprocessor }[];
  /** Game-specific trait registrations */
  traits?: (TraitMeta & { priority?: number })[];
  /** Game-specific editor panels (id/name/component + optional openByDefault/dockLocation) */
  panels?: EditorPanelDef[];
  /** Game View component (renders the live game preview) */
  gameView?: React.ComponentType;
  /** Extra menus to add to the editor menu bar (e.g., Build) */
  extraMenus?: Record<string, ExtraMenuItem[]>;
  /** Project Settings window schema + persistence (adds File → Project Settings). */
  projectSettings?: ProjectSettingsSchema;
}

/** One host-provided menu item. `submenu` is one level deep — see `BarMenuItem`, whose shape this
 *  mirrors minus the fields only the bar itself sets. */
export interface ExtraMenuItem {
  label: string;
  action?: () => void;
  separator?: boolean;
  disabled?: boolean;
  shortcut?: string;
  checked?: boolean;
  submenu?: ExtraMenuItem[];
}

/** Registry of custom panels added by the game */
let _customPanels: EditorPanelDef[] = [];
let _gameView: React.ComponentType | null = null;
let _extraMenus: EditorOptions['extraMenus'] = {};
let _projectSettings: ProjectSettingsSchema | null = null;

export function getCustomPanels() { return _customPanels; }
export function getGameViewComponent() { return _gameView; }
export function getExtraMenus() { return _extraMenus; }

// ── Updatable extra menus ────────────────────────────────────────────────────────────────────
// `createEditor` runs ONCE, so anything a menu label depends on that is not known at setup time
// (the Build menu's device listing — two `xcrun` shell-outs we must not block boot on) can never
// reach the menu without a way to replace the registry afterwards. A version counter + external
// store, rather than React state, because the producer is the app-level setup module, which is
// outside the component tree entirely.
let _extraMenusVersion = 0;
const _extraMenuListeners = new Set<() => void>();

/** Replace the host's extra menus and notify the menu bar. Whole-registry, not a patch: the caller
 *  owns the shape it registered, and a merge here would make "remove an item" unexpressible. */
export function setExtraMenus(menus: NonNullable<EditorOptions['extraMenus']>): void {
  _extraMenus = menus;
  _extraMenusVersion++;
  for (const l of _extraMenuListeners) l();
}

export function subscribeExtraMenus(cb: () => void): () => void {
  _extraMenuListeners.add(cb);
  return () => { _extraMenuListeners.delete(cb); };
}

export function getExtraMenusVersion(): number { return _extraMenusVersion; }
export function getProjectSettings() { return _projectSettings; }

export function createEditor(options: EditorOptions): React.ComponentType {
  // Capture console output + uncaught errors/rejections at the VERY START of
  // editor launch, before any lazy panel bundle (incl. Console) loads — so no
  // early-init log or error is missed. Idempotent.
  installConsoleCapture();

  // Register game config
  setGameConfig(options.config);

  // Dev-only: expose a window bridge so E2E (Playwright) tests can observe
  // selection + trait state. Stripped from production builds via DEV gate.
  if (import.meta.env.DEV) {
    import('./devTestBridge').then((m) => m.installEditorTestBridge());
  }

  // Register game-specific model postprocessors
  for (const { id, postprocessor } of options.postprocessors || []) {
    registerModelPostprocessor(id, postprocessor);
  }

  // Register game-specific traits
  for (const traitDef of options.traits || []) {
    registerTrait(traitDef);
  }

  // Store custom panels, game view, and extra menus for EditorApp to pick up
  _customPanels = options.panels || [];
  _gameView = options.gameView || null;
  _extraMenus = options.extraMenus || {};
  _projectSettings = options.projectSettings || null;

  // Register the Assets panel's built-in "Create X" menu entries (Scene, Material,
  // Animation, …). Idempotent — safe if createEditor() ever runs twice in a session.
  registerBuiltinCreatableAssets();

  // Subscribe to world swaps to restore the editor's selection across scene loads
  registerSelectionRestore();
  // Mirror the open animation clip to localStorage (restored below once the scene loads).
  registerLastAnimationClipPersistence();
  // Mirror the open .rig2d rig to localStorage (restored below once the manifest loads).
  registerLastSkinRigPersistence();
  // Tell the scene-path writer which project we're in, so every scene switch persists
  // the PER-PROJECT last-scene key that we restore from on the next launch.
  setScenePersistenceProject(options.config.name);

  // Keep the guid → path map current when the asset scanner detects a file
  // move/rename. Editor-scoped (ELECTRON_PLAN Phase 1): gated on __MODOKI_EDITOR__;
  // the transport is the HMR socket today (Phase 2 swaps it for IPC under Electron).
  if (__MODOKI_EDITOR__ && import.meta.hot) {
    import.meta.hot.on('asset-manifest-updated', (data: unknown) => {
      try {
        const manifest = data as Parameters<typeof loadManifestJson>[0];
        loadManifestJson(manifest);
        // Auto-refresh the Assets panel when the set of files on disk changes
        // (Finder drops, Create Prefab, external edits, deletes/renames) so the
        // user never has to hit Refresh. assetSetSignature dedupes the watcher's
        // self-echo to avoid a refresh→fetch→rebuild→refresh loop.
        const sig = assetSetSignature(manifest?.assets);
        if (sig !== lastAssetSig) {
          lastAssetSig = sig;
          useEditorStore.getState().refreshAssets();
        }
      } catch (e) { console.warn('[Editor] manifest update failed:', e); }
    });
  }

  // Fire-and-forget: resolve `build.modules.render3d` for the open project, for the
  // renderer-health watchdog below. Not awaited anywhere on the scene-load path — the
  // watchdog's no-viewport deadline is ≥2s out, comfortably more slack than this needs.
  void backendFetch('/api/build-modules')
    .then((r) => (r.ok ? r.json() : null))
    .then((data: { modules?: Record<string, boolean> } | null) => {
      resolvedRender3d = data?.modules?.render3d;
    })
    .catch(() => { /* fails open: resolvedRender3d stays undefined → the watchdog still warns */ });

  // Scene loading: try last opened scene, then config.scenePath, then initWorld. This runs
  // in parallel with the React app mounting and no longer waits on any 3D viewport/renderer
  // existing — entity data, prefabs, and non-KTX2 textures load the moment the asset manifest
  // is up. The one real dependency (three's KTX2Loader needing GPU caps before `loadAsync`)
  // is a narrower, terminating gate of its own now: `ensureKtx2Caps()`
  // (`runtime/loaders/textureResolver.ts`), which every KTX2-touching load site awaits
  // individually rather than the whole scene load blocking up front. See `docs/editor.md`
  // (`createEditor()`) and `docs/textures.md` ("Runtime resolution") for the full rationale.
  const sceneReady = (async () => {
    // Populate the guid → path map BEFORE loading any scene — otherwise every
    // GUID ref resolves to undefined (missing meshes, black materials). The
    // editor has no game-shell boot, so this is the only place it gets loaded.
    await ensureManifestLoaded(options.config.assetManifest || '/assets.manifest.json');

    // The open project's absolute root, so canonicalBootScenePath can disambiguate a
    // `/@fs/<abs>/runtime/assets/...` boot candidate by ORIGIN (is <abs> actually inside
    // this project?) instead of by manifest name-match alone — closes the "KNOWN
    // LIMITATION" gap that let a same-named sibling-project/engine-builtin file be
    // silently accepted. Best-effort: `/api/identity` is the main-process backend's own
    // route (always reachable under Electron), but a failure here just falls back to the
    // old name-based check in canonicalBootScenePath, never blocks boot.
    const projectRoot = await backendFetch('/api/identity')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { projectRoot?: string } | null) => data?.projectRoot)
      .catch(() => undefined);

    // Re-open the .rig2d the user was last editing in the Skin panel. A rig is a
    // scene-independent asset (loaded by path, sprites resolved via the manifest), so
    // restore it here — right after the manifest, before the scene — not gated on which
    // scene loads. Sets the store; the Skin panel shows it whenever it next mounts.
    restoreLastSkinRig();

    // Scope the "last opened scene" by project (config.name) — otherwise the key
    // is global and one project's scene (e.g. 3d-test's "2D Animation.json")
    // leaks into every other project, which then 404s. As a second guard, fall
    // back to this project's own config.scenePath when the stored scene fails to
    // load (stale/deleted, or a leaked path from before this fix): a wrong
    // last-scene self-heals to the project default instead of a blank world.
    const LAST_SCENE_KEY = lastSceneKey(options.config.name);
    const lastScene = localStorage.getItem(LAST_SCENE_KEY);

    // ── Issue #43: a launch-scoped `--scene`/MODOKI_SCENE override, read from main via
    //    /api/boot-scene. Best-effort like the /api/identity fetch above — a missing route
    //    (older/packaged main) must never block boot. STICKY for the whole editor process
    //    (main doesn't clear it), so this also applies across a Fast-Refresh reload. ──
    const bootSceneOverride = await backendFetch('/api/boot-scene')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { scene?: string | null } | null) => data?.scene ?? null)
      .catch(() => null);
    const sceneList = getAllAssets().filter((a) => a.type === 'scene').map((a) => a.path);
    const resolvedOverride = resolveBootSceneOverride(bootSceneOverride, sceneList);
    // Precompute the override's canonical form (best-effort) purely so the don't-clobber
    // check below can recognize it after loadFirstScene canonicalizes it again internally.
    let canonicalOverride: string | null = null;
    if (resolvedOverride) {
      canonicalOverride = await canonicalBootScenePath(resolvedOverride, fetch, projectRoot).catch(() => resolvedOverride);
    }

    // The override slots in FRONT of the normal candidates — never replaces them — so a
    // bad/missing override degrades to the remembered scene (or config default) rather
    // than a blank world. That ordering lives in resolveSceneCandidates, not here.
    const candidates = resolveSceneCandidates(lastScene, options.config.scenePath, resolvedOverride);

    // Boot the working-copy scene, not a hashed bundle copy, so saves +
    // external-edit hot-reload round-trip in a built/cloud editor (gap #2); pass
    // the project's game id so its game-scoped managers activate (the canonical
    // path carries no `/games/<id>/` segment to derive it from).
    const loadedPath = await loadFirstScene(candidates, {
      canonicalize: (p) => canonicalBootScenePath(p, fetch, projectRoot),
      // `probing`: a miss on one candidate is a normal step of the fallback walk, not an error
      // (#91) — loadFirstScene raises the single real error if they ALL miss.
      load: (p) => loadScene(p, options.gameId, { probing: true }),
    });
    if (loadedPath) {
      // Don't clobber the remembered scene with a one-off override (#43) — a `--scene` launch
      // must not change where the human's NEXT bare launch lands, or an agent's throwaway
      // launch silently moves them.
      //
      // NOT-ENOUGH-TO-SKIP-THE-WRITE, measured: `loadScene()` calls `setCurrentScenePath()`
      // (scene/serialize.ts), which writes this very key on EVERY scene switch — so by the time
      // we get here the override has ALREADY been persisted, and merely omitting a write here
      // changes nothing. Confirmed by tracing `Storage.setItem` across a real boot with a
      // `--scene` override: setCurrentScenePath fires first with the OVERRIDE's path, so the
      // prior value has to be put back explicitly rather than just left alone.
      //
      // Only the PER-PROJECT key is restored. The unscoped legacy `modoki-last-scene` is a
      // "scene currently open" proxy for SceneView's prefab-return and devTestBridge, so it must
      // keep tracking the scene actually loaded — rewinding that one would send prefab-return to
      // a scene the user is not in.
      const cameFromOverride = resolvedOverride != null && (loadedPath === resolvedOverride || loadedPath === canonicalOverride);
      if (cameFromOverride) {
        if (lastScene) localStorage.setItem(LAST_SCENE_KEY, lastScene);
        else localStorage.removeItem(LAST_SCENE_KEY);
      } else {
        // The override missed (typo/ambiguous) and boot fell through to the remembered or
        // default candidate — that IS a normal boot, so persist it as usual.
        localStorage.setItem(LAST_SCENE_KEY, loadedPath);
      }
      // Re-open the clip the user was editing last time (same scene only).
      restoreLastAnimationClip();
      return;
    }
    const scenePath = candidates[candidates.length - 1] ?? null;

    // Try initWorld (game-provided setup)
    if (options.config.initWorld) {
      options.config.initWorld();
      if (scenePath) setCurrentScenePath(scenePath);
      return;
    }

    // Empty scene: just a camera
    spawnEntity(getCurrentWorld(),
      Transform({ x: 0, y: 5, z: 10 }),
      Camera({ fov: 60 }),
      EntityAttributes({ name: 'Camera', sortOrder: 0 }),
    );
    console.log('[Editor] Created empty scene with default camera');
  })();

  // Lazy-import EditorApp. sceneReady no longer depends on it mounting (that dependency was
  // the renderer gate this plan removed), but EditorApp still owns the SceneView/GameView that
  // WOULD register a renderer, so it must still mount for the watchdog below to have any
  // chance of seeing one. The empty initial world renders fine for a fraction of a second
  // until the scene populates entities. sceneReady is awaited here only to keep the promise
  // rejection visible — a real failure (e.g. a scene file 404) is still worth logging loudly.
  sceneReady.catch((e) => console.error('[Editor] scene load failed:', e));

  // Renderer-health watchdog — no longer on the scene-load critical path (the scene's entity
  // data loads regardless of whether any 3D viewport exists). Always reports a DEFINITIVE
  // renderer init failure fast (a viewport actually tried and threw — a real error, never
  // suppressed). Otherwise — once `resolvedRender3d` settles false and no viewport ever begins
  // — the fast (12s), soft (15s), and hard-cap (120s) "nothing is rendering" messages are ALL
  // suppressed: a 2D-only project should see zero renderer-health noise. Suppression lifts the
  // moment a viewport DOES begin (e.g. the user opens one anyway).
  void awaitRendererReady(rendererReady, RENDERER_READY_TIMEOUT_MS, undefined, {
    failed: rendererInitFailedPromise(),
    progress: getRendererProgress,
    hasViewportBegun: hasViewportBegunInit,
    shouldWarnNoViewport: () => resolvedRender3d !== false,
  }).catch((e) => console.warn(`[Editor] ${(e as Error).message}`));

  const LazyEditor = React.lazy(() => import('./EditorApp'));

  const EditorWrapper: React.FC = () => (
    <React.Suspense fallback={<div style={{ background: '#1a1a2e', color: '#555', display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100vw', height: '100vh' }}>Loading editor...</div>}>
      <LazyEditor />
    </React.Suspense>
  );

  return EditorWrapper;
}

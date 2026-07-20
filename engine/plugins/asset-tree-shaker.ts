/** Static asset tree-shaker for production builds.
 *
 *  Walks every scene JSON under discovered asset roots, follows the reference
 *  graph (scene → prefab → mesh → material → texture), resolves font families
 *  to physical files, seeds a project-level keep-list, and returns the set of
 *  virtual asset paths that must ship. Everything else is dropped by the
 *  Vite `writeBundle` hook.
 *
 *  Dev mode is untouched — this runs only during `vite build`. */

import fs from 'fs';
import path from 'path';
import { readAssetGuid, type AssetRoot } from './vite-asset-scanner';
import { readMetaSidecar } from './meta-sidecar';
import { parseFontFilename } from '../packages/modoki/src/runtime/loaders/fontNaming';
import { classifyJsonAssetSuffix, BINARY_EXT_TYPE } from './assetTypes';
import { REF_FIELDS_BY_TRAIT } from '../packages/modoki/src/runtime/scene/sceneValidation';
import { MATERIAL_TEXTURE_SLOTS } from '../packages/modoki/src/runtime/assets/materialTextureSlots';
import { resolveTextureType } from '../packages/modoki/src/runtime/loaders/textureSettings';
import { ULTRAHDR_VARIANT_SUFFIX } from '../packages/modoki/src/runtime/loaders/environmentSettings';
import { deriveGuid } from '../packages/modoki/src/runtime/loaders/assetRefRules';
import { parseAnimClipBank } from '../packages/modoki/src/runtime/animation/animClipBank';

/** UUID v4 shape — matches the runtime assetManifest GUID_RE. */
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isGuid(s: string): boolean { return GUID_RE.test(s); }

// ── Types ──────────────────────────────────────────────

export interface TreeShakeResult {
  /** Virtual URL paths (e.g. "/games/3d-test/assets/models/tropical-island/island.glb") to ship. */
  kept: Set<string>;
  stats: TreeShakeStats;
  warnings: string[];
  /** Virtual URL paths that exist on disk but were not reached. Informational only. */
  orphans: string[];
  /** Per-orphan detail (path + asset type + byte size) — powers the editor's
   *  "Clean Up Unused Assets" dialog. Same set as `orphans`, enriched. */
  orphanDetails: OrphanDetail[];
}

export interface OrphanDetail {
  /** Virtual URL path, e.g. "/games/x/assets/textures/unused.png". */
  path: string;
  /** Classified asset type (texture/model/material/mesh/scene/…). */
  type: string;
  /** File size in bytes. */
  bytes: number;
}

export interface TreeShakeStats {
  scenes: number;
  keptByType: Record<string, number>;
  totalByType: Record<string, number>;
  keptBytes: number;
  droppedBytes: number;
}

interface KeepListFile {
  keep?: string[];
}

// ── File type detection ───────────────────────────────

// Shippable extensions: the shared binary asset kinds (BINARY_EXT_TYPE) + JSON
// assets + shader source. Derived so a new binary type added to the single source
// of truth is enumerated as shippable here without a second edit.
const TYPEABLE_EXTS = new Set([
  ...Object.keys(BINARY_EXT_TYPE),
  '.json',
  '.wgsl', '.glsl',
]);

function classify(virtualPath: string): string {
  if (virtualPath.endsWith('.meta.json')) return 'meta';
  // Committed UltraHDR variant (`<src>.hdr~ultrahdr.jpg`) — a DERIVED file next to its
  // source HDR, NOT a texture. Mirrors the scanner's detectType() exclusion so the two
  // classifiers stay in lockstep (else it'd be logged as a dropped/orphan texture).
  if (virtualPath.endsWith(ULTRAHDR_VARIANT_SUFFIX)) return 'other';
  // Shared JSON asset-kind classifier (see plugins/assetTypes.ts) — the single
  // list the scanner's detectType() also uses, so the two can't drift. Adding a
  // JSON asset kind there classifies it in BOTH, and buildGuidIndex reads its
  // top-level `id` (an unknown-json would be skipped there and shaken out).
  const jsonAssetType = classifyJsonAssetSuffix(virtualPath);
  if (jsonAssetType) return jsonAssetType;
  if (virtualPath.endsWith('.json')) {
    if (/\/scenes\//.test(virtualPath) || virtualPath.endsWith('/scene.json')) return 'scene';
    return 'unknown-json';
  }
  const ext = path.extname(virtualPath).toLowerCase();
  // Shared binary classifier (assetTypes.ts) — same table the scanner's EXT_TYPE
  // derives from, so a new shippable binary type can't be 'other' here (which would
  // strip its GUID from the index and drop it from the prod build) while shipping in dev.
  const binaryType = BINARY_EXT_TYPE[ext];
  if (binaryType) return binaryType;
  if (ext === '.wgsl' || ext === '.glsl') return 'shader-src'; // shader source, not a runtime asset
  return 'other';
}

// ── Path resolution ───────────────────────────────────

function virtualToAbs(virtualPath: string, roots: AssetRoot[]): string | null {
  const cleaned = virtualPath.startsWith('/') ? virtualPath : '/' + virtualPath;
  for (const root of roots) {
    if (cleaned.startsWith(root.urlPrefix + '/')) {
      const rel = cleaned.substring(root.urlPrefix.length + 1);
      const abs = path.resolve(root.absDir, rel);
      if (!abs.startsWith(root.absDir)) return null; // traversal
      return abs;
    }
  }
  return null;
}

function absToVirtual(absPath: string, roots: AssetRoot[]): string | null {
  for (const root of roots) {
    if (absPath.startsWith(root.absDir + path.sep) || absPath === root.absDir) {
      const rel = path.relative(root.absDir, absPath).replace(/\\/g, '/');
      return rel ? `${root.urlPrefix}/${rel}` : root.urlPrefix;
    }
  }
  return null;
}

// ── Filesystem walkers ────────────────────────────────

function listFilesUnder(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listFilesUnder(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

function findSceneFiles(roots: AssetRoot[]): string[] {
  // Virtual paths of every scene JSON in every root. Seeds the walk.
  const scenes: string[] = [];
  for (const root of roots) {
    // Only scenes live under a `/scenes/` directory by convention.
    const scenesDir = path.join(root.absDir, 'scenes');
    if (!fs.existsSync(scenesDir)) continue;
    for (const file of listFilesUnder(scenesDir)) {
      if (!file.endsWith('.json') || file.endsWith('.meta.json')) continue;
      const virtual = absToVirtual(file, roots);
      if (virtual) scenes.push(virtual);
    }
  }
  return scenes.sort();
}

// ── Reference extraction ──────────────────────────────

/** Accumulated state while walking. Collected families are resolved to font
 *  files at the end of the walk. */
interface WalkState {
  keep: Set<string>;
  fontFamilies: Set<string>;
  warnings: string[];
  queue: { virtualPath: string; referencedBy: string }[];
  /** guid (lowercase) → virtual path. Refs on disk are GUIDs post-migration;
   *  resolve them to paths before walking. */
  guidIndex: Map<string, string>;
}

function pushRef(state: WalkState, type: string, value: unknown, referencedBy: string): void {
  if (typeof value !== 'string' || !value) return;

  if (type === 'font-family') {
    state.fontFamilies.add(value);
    return;
  }

  // Resolve GUID refs to their virtual path. After the migration, every scene/
  // prefab/mesh/material reference is a GUID, not a path.
  let pathValue = value;
  if (isGuid(value)) {
    const resolved = state.guidIndex.get(value.toLowerCase());
    if (!resolved) {
      state.warnings.push(`unresolved GUID ref: ${value} (referenced by ${referencedBy})`);
      return;
    }
    pathValue = resolved;
  }

  // All other refs must be virtual paths (start with /). Symbolic names like
  // primitive sprites ("cube") fall through here and are correctly ignored.
  if (!pathValue.startsWith('/')) return;
  if (state.keep.has(pathValue)) return; // already queued or done
  state.keep.add(pathValue);
  state.queue.push({ virtualPath: pathValue, referencedBy });
}

/** Build a guid → virtual-path index over every shippable asset. Mirrors the
 *  runtime manifest: JSON assets carry a top-level `id`; binary assets carry a
 *  `.meta.json` sidecar. Reuses readAssetGuid from the scanner so both pipelines
 *  read ids the same way. */
function buildGuidIndex(roots: AssetRoot[]): Map<string, string> {
  const index = new Map<string, string>();
  // Collected in the first pass, applied after: a packed atlas MEMBER's slice GUID is
  // redirected from its parent texture (mapped below) to the ATLAS file, so the ref
  // keeps the atlas (+ its generated pages) and the now-redundant source texture is
  // dropped from the prod build unless some OTHER ref (whole-texture sprite, material,
  // an unpacked sibling slice) keeps it.
  const atlasMemberOverrides: Array<{ memberGuid: string; atlasVirtual: string }> = [];
  for (const { virtual, abs } of listAllShippableFiles(roots)) {
    const type = classify(virtual);
    if (type === 'meta' || type === 'unknown-json' || type === 'other') continue;
    const guid = readAssetGuid(abs, type);
    if (guid) index.set(guid.toLowerCase(), virtual);
    // Sliced sprites have no file of their own — their GUIDs live in the texture's
    // `.meta.json` `sprites[]`. Map each slice GUID → the PARENT TEXTURE's virtual
    // path so a `Renderable2D.sprite` ref keeps the texture (else a texture whose
    // only refs are via sprite GUIDs would be tree-shaken out of the prod build).
    if (type === 'texture') {
      const meta = readMetaSidecar(abs) as Parameters<typeof resolveTextureType>[0] & { sprites?: Array<{ guid?: string }> };
      if (Array.isArray(meta.sprites)) {
        for (const s of meta.sprites) {
          if (s.guid && isGuid(s.guid)) index.set(s.guid.toLowerCase(), virtual);
        }
      }
      // The scanner auto-emits a whole-image `'sprite'` for every 2D/UI texture whose
      // GUID is `deriveGuid('sprite:'+textureGuid)` — it's NOT in `meta.sprites[]`, so
      // map it here too, else a texture referenced only via its default sprite (the
      // sprites-only 2D policy — every migrated Renderable2D/rig ref) is shaken out.
      if (guid && (resolveTextureType(meta) === '2d' || resolveTextureType(meta) === 'ui')) {
        index.set(deriveGuid('sprite:' + guid).toLowerCase(), virtual);
      }
    }
    // A built atlas: redirect each member sprite GUID to this atlas file so a kept
    // member keeps the atlas (+ its generated pages) and drops the now-redundant
    // source texture. Read the AUTHORED `members[]` (not the packed `atlasCache.frames`)
    // so this works on a CLEAN build too — the frames don't exist until the atlas-shaker
    // packs, which only runs for atlases already in the keep-set.
    if (type === 'atlas') {
      const src = (() => { try { return JSON.parse(fs.readFileSync(abs, 'utf-8')) as { members?: unknown[] }; } catch { return {}; } })();
      for (const m of src.members ?? []) {
        if (typeof m === 'string' && isGuid(m)) atlasMemberOverrides.push({ memberGuid: m, atlasVirtual: virtual });
      }
    }
  }
  // Apply atlas overrides last so they win over the slice→texture mapping regardless of
  // file iteration order.
  for (const { memberGuid, atlasVirtual } of atlasMemberOverrides) {
    index.set(memberGuid.toLowerCase(), atlasVirtual);
  }
  return index;
}

/** Probe a single trait-bag ({ TraitName: { …fields } }) for asset refs. Used for
 *  both an entity's own `traits` and a prefab-instance's per-localId `overrides`
 *  values — an override can introduce a NEW ref the base prefab lacks (e.g. the
 *  bar instance sets Animator.clip → wave.anim only in its override), so it must be
 *  walked too or that asset is silently shaken out of the prod build. */
function probeTraitRefs(traits: Record<string, unknown>, state: WalkState, referencedBy: string): void {
  // Scalar asset-ref fields are data-driven from REF_FIELDS_BY_TRAIT — the SAME
  // registry the scene validator uses (runtime/scene/sceneValidation.ts). Keeping
  // this generic instead of hand-listing each trait is what stops the classic drift
  // where a new ref field ships in dev but is silently tree-shaken out of prod
  // (exactly how Animator.clip once broke): adding the field to the registry now
  // covers validation AND the build keep-set in one edit. pushRef ignores
  // non-guid/non-path values (primitive sprite keywords, '') and is idempotent, so
  // probing every registered field is safe. The asset-TYPE label is cosmetic here —
  // pushRef keeps a file by its resolved path regardless of the label.
  for (const [traitName, fields] of Object.entries(REF_FIELDS_BY_TRAIT)) {
    const t = traits[traitName] as Record<string, unknown> | undefined;
    if (!t || typeof t !== 'object') continue;
    for (const field of fields) pushRef(state, 'asset', t[field], referencedBy);
  }

  // ── Refs that are NOT a scalar guid field, so they can't live in the registry ──

  // UIElement.fontFamily is a CSS family NAME, not an asset guid — resolved to
  // physical font files at the end of the walk via the dedicated 'font-family' kind.
  const ui = traits['UIElement'] as Record<string, unknown> | undefined;
  if (ui && typeof ui === 'object') {
    pushRef(state, 'font-family', ui.fontFamily, referencedBy);
  }

  // AnimationLibrary (P6) → shared cross-model clips: an ARRAY of .animset.json
  // guids. Each animset's `source` GLB is followed at queue time by processAnimSet,
  // so the library GLB ships even though no SkinnedModel references it directly.
  const animLib = traits['AnimationLibrary'] as Record<string, unknown> | undefined;
  if (animLib && typeof animLib === 'object' && Array.isArray(animLib.animSets)) {
    for (const ref of animLib.animSets) pushRef(state, 'asset', ref, referencedBy);
  }

  // MaterialInstance overrides with kind:'texture' carry a per-instance `ref` (a
  // sprite/texture guid bound to a 2D shader's extra sampler) — nested in the overrides
  // array, so not a scalar registry field. Follow each or the swapped-in texture is
  // shaken out of prod (the 2D sampler would 404).
  const mi = traits['MaterialInstance'] as Record<string, unknown> | undefined;
  if (mi && typeof mi === 'object' && Array.isArray(mi.overrides)) {
    for (const o of mi.overrides) {
      const ov = o as { kind?: string; ref?: unknown };
      if (ov?.kind === 'texture') pushRef(state, 'texture', ov.ref, referencedBy);
    }
  }

  // Animator.clips — the named keyframe-clip bank, a JSON-string `[{name, clip, …}]` of
  // `.anim.json` GUIDs (the active `clip` is a NAME, not a ref, so it's NOT in the registry
  // above). Parse here so an OVERRIDE-only bank (a prefab instance introducing clips the base
  // prefab lacks) survives — probeTraitRefs is the only walker of override bags.
  const animator = traits['Animator'] as Record<string, unknown> | undefined;
  if (animator && typeof animator === 'object') {
    for (const c of parseAnimClipBank(animator.clips)) pushRef(state, 'asset', c.clip, referencedBy);
  }
}

function extractEntityRefs(
  entry: { traits?: Record<string, unknown>; prefab?: string; overrides?: Record<string, unknown> },
  state: WalkState,
  referencedBy: string,
): void {
  probeTraitRefs((entry.traits ?? {}) as Record<string, unknown>, state, referencedBy);

  // A prefab-instance's `overrides` map is { localId: { TraitName: { …fields } } }.
  // Each value is a trait-bag that can carry asset refs the base prefab lacks — walk
  // them like a trait-bag so an override-only ref (e.g. Animator.clip → wave.anim on
  // the bar instance) isn't shaken out.
  if (entry.overrides && typeof entry.overrides === 'object') {
    for (const bag of Object.values(entry.overrides)) {
      if (bag && typeof bag === 'object') probeTraitRefs(bag as Record<string, unknown>, state, referencedBy);
    }
  }

  if (entry.prefab) pushRef(state, 'prefab', entry.prefab, referencedBy);
}

function processSceneOrPrefab(json: unknown, state: WalkState, referencedBy: string): void {
  if (!json || typeof json !== 'object') return;
  const data = json as {
    resources?: { path?: string; type?: string }[];
    entities?: { traits?: Record<string, unknown>; prefab?: string; overrides?: Record<string, unknown> }[];
  };

  // v6+ scenes carry an explicit resources[] array. Treat each as a ref.
  if (Array.isArray(data.resources)) {
    for (const ref of data.resources) {
      if (ref?.type === 'font') {
        pushRef(state, 'font-family', ref.path, referencedBy);
      } else if (ref?.path) {
        pushRef(state, 'asset', ref.path, referencedBy);
      }
    }
  }

  // Walk entities regardless — catches fields not yet in resources[] and
  // works for pre-v6 scenes and for prefab JSON files.
  if (Array.isArray(data.entities)) {
    for (const entry of data.entities) extractEntityRefs(entry, state, referencedBy);
  }
}

function processMesh(json: unknown, state: WalkState, referencedBy: string): void {
  if (!json || typeof json !== 'object') return;
  const data = json as { model?: string; material?: string };
  pushRef(state, 'model', data.model, referencedBy);
  pushRef(state, 'material', data.material, referencedBy);
}

function processMaterial(json: unknown, state: WalkState, referencedBy: string): void {
  if (!json || typeof json !== 'object') return;
  const data = json as Record<string, unknown>;
  // Material texture slots — sourced from MATERIAL_TEXTURE_SLOTS, the single list
  // the runtime material loader (meshTemplateCache loadInto) and the editor schema
  // also derive from. Probing the wrong names silently shakes a referenced map out
  // of the build and the material loses it at runtime (this is exactly how
  // station/fighter shipped without their normal/roughness/metalness maps) — deriving
  // from one list is what stops that drift. The legacy Three.js `…Map` aliases are
  // kept as harmless forward-compat probes (not currently emitted).
  const MAP_FIELDS = [
    ...MATERIAL_TEXTURE_SLOTS,
    'map', 'normalMap', 'roughnessMap', 'metalnessMap',
    'aoMap', 'emissiveMap', 'alphaMap', 'bumpMap', 'displacementMap',
    'lightMap', 'envMap',
  ];
  for (const field of MAP_FIELDS) {
    pushRef(state, 'texture', data[field], referencedBy);
  }
  // A custom material may reference a file-based shader asset (.shader.json).
  // Code-shader names (e.g. "space-console/holo") aren't paths/guids and are
  // correctly ignored by pushRef.
  pushRef(state, 'shader', data.shader, referencedBy);
  // Custom-shader `texture` params hold asset refs inside `params`. Walk every
  // string param value as a generic asset ref; pushRef ignores non-guid/non-path
  // strings (e.g. enum-like params), so only real asset refs are kept.
  const params = data.params;
  if (params && typeof params === 'object') {
    for (const v of Object.values(params as Record<string, unknown>)) {
      if (typeof v === 'string') pushRef(state, 'asset', v, referencedBy);
    }
  }
}

function processParticle(json: unknown, state: WalkState, referencedBy: string): void {
  if (!json || typeof json !== 'object') return;
  const data = json as { render?: { texture?: unknown } };
  // A particle effect optionally references a sprite-sheet/texture asset under
  // render.texture. When empty the renderer uses a built-in soft round particle.
  const render = data.render;
  if (render && typeof render === 'object') {
    pushRef(state, 'texture', render.texture, referencedBy);
  }
}

/** A .animset.json (skeletal per-clip params, P5/P6) names a `source` GLB that
 *  holds the actual clips. For an AnimationLibrary, that GLB may not be referenced
 *  by any SkinnedModel — so following the animset → source keeps the clip GLB in
 *  the build (otherwise it's tree-shaken out and the library 404s at runtime). */
function processAnimSet(json: unknown, state: WalkState, referencedBy: string): void {
  if (!json || typeof json !== 'object') return;
  const data = json as { source?: unknown };
  pushRef(state, 'model', data.source, referencedBy);
}

/** A `.spriteanim.json` set references its frames as sprite-slice GUIDs inside
 *  each clip. Follow them so the parent sprite-sheet texture is kept — a sheet
 *  reachable ONLY through an animation (no direct Renderable2D.sprite ref) would
 *  otherwise be shaken out and the flipbook 404s at runtime (mirrors processAnimSet). */
function processSpriteAnim(json: unknown, state: WalkState, referencedBy: string): void {
  if (!json || typeof json !== 'object') return;
  const data = json as { clips?: Record<string, { frames?: unknown[] }> };
  if (!data.clips || typeof data.clips !== 'object') return;
  for (const clip of Object.values(data.clips)) {
    if (clip && Array.isArray(clip.frames)) for (const f of clip.frames) pushRef(state, 'sprite', f, referencedBy);
  }
}

/** A `.rig2d.json` (2D skinning rig) references its part textures as sprite
 *  GUIDs. Follow them so the body-part textures are kept — a texture reachable
 *  ONLY through a rig (no direct Renderable2D.sprite ref) would otherwise be
 *  shaken out and the skinned sprite renders invisible (mirrors processSpriteAnim).
 *  Both rig schemas carry sprite refs (see rig2dCache normalizeRig): v1 = a single
 *  top-level `sprite`; v2 = a `parts[]` list each with its own `sprite`. `mesh`
 *  (top-level or per-part) is inline geometry, not an asset ref. */
function processRig2D(json: unknown, state: WalkState, referencedBy: string): void {
  if (!json || typeof json !== 'object') return;
  const data = json as { sprite?: unknown; parts?: Array<{ sprite?: unknown }> };
  pushRef(state, 'sprite', data.sprite, referencedBy); // v1 top-level
  if (Array.isArray(data.parts)) {
    for (const part of data.parts) pushRef(state, 'sprite', part?.sprite, referencedBy); // v2
  }
}

/** A `.timeline.json` (Director sequence) references inner GUIDs the entity walk can't see:
 *  audio-cue GUIDs (audio tracks) and PREFAB GUIDs (control tracks). Follow both so an asset
 *  reachable ONLY through a timeline (no other reference) is kept — otherwise it's shaken out of
 *  prod and cueClip / the control spawn 404s at the marker. Mirrors SceneManager's runtime walk
 *  (collectTimelineAudioRefs + collectTimelineControlRefs). Animation-track clips are NAMES
 *  resolved via the target Animator bank (kept by processAnimator), so they're not followed here. */
function processTimeline(json: unknown, state: WalkState, referencedBy: string): void {
  if (!json || typeof json !== 'object') return;
  const data = json as { tracks?: Array<{ type?: string; cues?: Array<{ clip?: unknown }>; clips?: Array<{ prefab?: unknown }> }> };
  if (!Array.isArray(data.tracks)) return;
  for (const track of data.tracks) {
    if (track?.type === 'audio' && Array.isArray(track.cues)) {
      for (const cue of track.cues) pushRef(state, 'asset', cue?.clip, referencedBy);
    }
    if (track?.type === 'control' && Array.isArray(track.clips)) {
      for (const clip of track.clips) pushRef(state, 'asset', clip?.prefab, referencedBy);
    }
  }
}

/** A shader manifest's raw bodies live in sibling .wgsl / .glsl files referenced
 *  by path convention, not by guid — keep whichever exist so the backend-matched
 *  variant ships. Also follow the manifest's `texture`-typed params: a `space:'2d'`
 *  shader's extra samplers bind those params' `default` GUIDs at runtime (Scene2D),
 *  so without this they'd be tree-shaken out of prod and the sampler would 404. */
function processShader(virtualPath: string, state: WalkState, roots: AssetRoot[]): void {
  for (const ext of ['wgsl', 'glsl'] as const) {
    const sibling = virtualPath.replace(/\.shader\.json$/i, `.${ext}`);
    if (state.keep.has(sibling)) continue;
    const abs = virtualToAbs(sibling, roots);
    if (abs && fs.existsSync(abs)) state.keep.add(sibling);
  }
  // Follow `texture` param defaults (the shape is `{ key: { type, default, ... } }`).
  const abs = virtualToAbs(virtualPath, roots);
  if (!abs || !fs.existsSync(abs)) return;
  try {
    const json = JSON.parse(fs.readFileSync(abs, 'utf-8')) as { params?: Record<string, unknown> };
    for (const p of Object.values(json.params ?? {})) {
      const param = p as { type?: string; default?: unknown };
      if (param?.type === 'texture' && typeof param.default === 'string') pushRef(state, 'texture', param.default, virtualPath);
    }
  } catch (e) {
    state.warnings.push(`failed to parse shader: ${virtualPath} — ${(e as Error).message}`);
  }
}

// ── Font family resolution ────────────────────────────

function resolveFontsByFamily(
  families: Set<string>,
  roots: AssetRoot[],
  warnings: string[],
): string[] {
  if (families.size === 0) return [];

  const kept: string[] = [];
  const matchedFamilies = new Set<string>();

  for (const root of roots) {
    // Fonts live under /<root>/fonts/ by convention.
    const fontsDir = path.join(root.absDir, 'fonts');
    if (!fs.existsSync(fontsDir)) continue;

    for (const abs of listFilesUnder(fontsDir)) {
      const ext = path.extname(abs).toLowerCase();
      if (!['.ttf', '.otf', '.woff', '.woff2'].includes(ext)) continue;

      const info = parseFontFilename(abs);
      if (families.has(info.family)) {
        const virtual = absToVirtual(abs, roots);
        if (virtual) {
          kept.push(virtual);
          matchedFamilies.add(info.family);
        }
      }
    }
  }

  for (const family of families) {
    if (!matchedFamilies.has(family)) {
      warnings.push(`font family "${family}" has no matching files on disk`);
    }
  }

  return kept;
}

// ── Keep-list loader ──────────────────────────────────

function loadKeepList(projectRoot: string, roots: AssetRoot[]): string[] {
  const keepPath = path.join(projectRoot, 'asset-keep.json');
  if (!fs.existsSync(keepPath)) return [];

  const raw = fs.readFileSync(keepPath, 'utf-8');
  let parsed: KeepListFile;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`asset-keep.json is not valid JSON: ${(e as Error).message}`);
  }

  const entries = Array.isArray(parsed.keep) ? parsed.keep : [];
  const missing: string[] = [];
  for (const entry of entries) {
    const abs = virtualToAbs(entry, roots);
    if (!abs || !fs.existsSync(abs)) missing.push(entry);
  }
  if (missing.length > 0) {
    throw new Error(
      `asset-keep.json references files that do not exist:\n  ${missing.join('\n  ')}\n` +
      `Fix the paths in asset-keep.json or remove the stale entries.`
    );
  }

  return entries;
}

// ── Main entry point ──────────────────────────────────

export function computeKeptAssets(projectRoot: string, roots: AssetRoot[]): TreeShakeResult {
  const state: WalkState = {
    keep: new Set(),
    fontFamilies: new Set(),
    warnings: [],
    queue: [],
    guidIndex: buildGuidIndex(roots),
  };

  // Seed: project keep-list (fails loudly on missing files).
  const keepList = loadKeepList(projectRoot, roots);
  for (const entry of keepList) {
    // Keep-list entries are WALKED (queued), not kept as bare leaves: listing a
    // scene / prefab / mesh / material pulls its whole transitive dependency subtree.
    // This is what makes an explicit keep useful for a code-spawned prefab that the
    // scene graph can't reach (e.g. sling's field kit, instantiated only by
    // rebuildField from a .level.json) — listing the prefab keeps its meshes +
    // materials + textures too, instead of silently shipping a prefab whose grass GLBs
    // got dropped. Non-walkable types (textures, GLBs, audio) are leaves in the queue
    // processing anyway, so queuing them is a harmless no-op.
    if (!state.keep.has(entry)) {
      state.keep.add(entry);
      state.queue.push({ virtualPath: entry, referencedBy: '<keep-list>' });
    }
  }

  // Seed: every scene file found on disk.
  const scenes = findSceneFiles(roots);
  for (const scene of scenes) {
    if (!state.keep.has(scene)) {
      state.keep.add(scene);
      state.queue.push({ virtualPath: scene, referencedBy: '<root>' });
    }
  }

  // Work the queue. For JSON files, parse and extract refs. Non-JSON files
  // are leaves.
  while (state.queue.length > 0) {
    const { virtualPath, referencedBy } = state.queue.shift()!;
    const abs = virtualToAbs(virtualPath, roots);
    if (!abs) {
      state.warnings.push(`unresolvable path: ${virtualPath} (referenced by ${referencedBy})`);
      continue;
    }
    if (!fs.existsSync(abs)) {
      state.warnings.push(`missing file: ${virtualPath} (referenced by ${referencedBy})`);
      continue;
    }

    const type = classify(virtualPath);
    if (type === 'meta') continue;

    if (type === 'scene' || type === 'prefab') {
      try {
        const json = JSON.parse(fs.readFileSync(abs, 'utf-8'));
        processSceneOrPrefab(json, state, virtualPath);
      } catch (e) {
        state.warnings.push(`failed to parse ${type}: ${virtualPath} — ${(e as Error).message}`);
      }
    } else if (type === 'mesh') {
      try {
        const json = JSON.parse(fs.readFileSync(abs, 'utf-8'));
        processMesh(json, state, virtualPath);
      } catch (e) {
        state.warnings.push(`failed to parse mesh: ${virtualPath} — ${(e as Error).message}`);
      }
    } else if (type === 'material') {
      try {
        const json = JSON.parse(fs.readFileSync(abs, 'utf-8'));
        processMaterial(json, state, virtualPath);
      } catch (e) {
        state.warnings.push(`failed to parse material: ${virtualPath} — ${(e as Error).message}`);
      }
    } else if (type === 'shader') {
      processShader(virtualPath, state, roots);
    } else if (type === 'particle') {
      try {
        const json = JSON.parse(fs.readFileSync(abs, 'utf-8'));
        processParticle(json, state, virtualPath);
      } catch (e) {
        state.warnings.push(`failed to parse particle: ${virtualPath} — ${(e as Error).message}`);
      }
    } else if (type === 'animset') {
      try {
        const json = JSON.parse(fs.readFileSync(abs, 'utf-8'));
        processAnimSet(json, state, virtualPath);
      } catch (e) {
        state.warnings.push(`failed to parse animset: ${virtualPath} — ${(e as Error).message}`);
      }
    } else if (type === 'spriteanim') {
      try {
        const json = JSON.parse(fs.readFileSync(abs, 'utf-8'));
        processSpriteAnim(json, state, virtualPath);
      } catch (e) {
        state.warnings.push(`failed to parse spriteanim: ${virtualPath} — ${(e as Error).message}`);
      }
    } else if (type === 'rig2d') {
      try {
        const json = JSON.parse(fs.readFileSync(abs, 'utf-8'));
        processRig2D(json, state, virtualPath);
      } catch (e) {
        state.warnings.push(`failed to parse rig2d: ${virtualPath} — ${(e as Error).message}`);
      }
    } else if (type === 'timeline') {
      try {
        const json = JSON.parse(fs.readFileSync(abs, 'utf-8'));
        processTimeline(json, state, virtualPath);
      } catch (e) {
        state.warnings.push(`failed to parse timeline: ${virtualPath} — ${(e as Error).message}`);
      }
    }
    // All other types (model, texture, environment, font, shader-src, unknown-json) are leaves.
  }

  // Resolve font families → actual files.
  const fontFiles = resolveFontsByFamily(state.fontFamilies, roots, state.warnings);
  for (const virtual of fontFiles) state.keep.add(virtual);

  // Compute stats + orphan list by enumerating every shippable file under every root.
  // Normalize both sides to NFC because macOS APFS may return NFD filenames from
  // readdir while the walker queued NFC-form paths from JSON references.
  const allShippable = listAllShippableFiles(roots);
  const keepNfc = new Set<string>();
  for (const p of state.keep) keepNfc.add(p.normalize('NFC'));

  const keptByType: Record<string, number> = {};
  const totalByType: Record<string, number> = {};
  let keptBytes = 0;
  let droppedBytes = 0;
  const orphans: string[] = [];
  const orphanDetails: OrphanDetail[] = [];

  for (const { virtual, abs } of allShippable) {
    const type = classify(virtual);
    if (type === 'meta') continue;
    totalByType[type] = (totalByType[type] ?? 0) + 1;
    const size = safeStat(abs);
    if (keepNfc.has(virtual.normalize('NFC'))) {
      keptByType[type] = (keptByType[type] ?? 0) + 1;
      keptBytes += size;
    } else {
      droppedBytes += size;
      orphans.push(virtual);
      orphanDetails.push({ path: virtual, type, bytes: size });
    }
  }

  // Drop any keep-set entries that didn't match a shippable file on disk. The
  // walker may have queued references to nonexistent paths — warnings already
  // logged — so prune them so downstream copying doesn't fail.
  for (const virtual of Array.from(state.keep)) {
    const abs = virtualToAbs(virtual, roots);
    if (!abs || !fs.existsSync(abs)) state.keep.delete(virtual);
  }

  return {
    kept: state.keep,
    stats: {
      scenes: scenes.length,
      keptByType,
      totalByType,
      keptBytes,
      droppedBytes,
    },
    warnings: state.warnings,
    orphans,
    orphanDetails,
  };
}

// ── Helpers ───────────────────────────────────────────

function listAllShippableFiles(roots: AssetRoot[]): { virtual: string; abs: string }[] {
  const out: { virtual: string; abs: string }[] = [];
  for (const root of roots) {
    for (const abs of listFilesUnder(root.absDir)) {
      const ext = path.extname(abs).toLowerCase();
      // Skip source files and Vite-irrelevant files.
      if (['.ts', '.tsx', '.js', '.jsx', '.css', '.md', '.txt'].includes(ext)) continue;
      if (abs.endsWith('.meta.json')) continue;
      // Only count files the scanner would otherwise copy.
      if (!TYPEABLE_EXTS.has(ext)) continue;
      const virtual = absToVirtual(abs, roots);
      if (virtual) out.push({ virtual, abs });
    }
  }
  return out;
}

function safeStat(abs: string): number {
  try {
    return fs.statSync(abs).size;
  } catch {
    return 0;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Prefab edit mode — open a prefab *in isolation* in the Scene viewport, edit
 *  its entities directly, and save back to the `.prefab.json`.
 *
 *  Implemented on top of the existing scene-swap machinery: we synthesize an
 *  in-memory scene that contains the prefab's entities expanded as PLAIN entities
 *  (no PrefabInstance trait — you're editing the template itself, not an instance)
 *  plus throwaway lights + an HDR environment so the prefab is visible. On save we
 *  serialize the prefab subtree back out, excluding the scaffold entities. */

import { onGuidRemap, remapGuidMapKeys } from '../../runtime/core/ecs/guidRemap';
import type { Entity, World } from 'koota';
import type { PrefabFile, PrefabEntity } from './prefab';
import { localIdCounter } from '../../runtime/core/localIdCounter';
import { unresolvedRefOf } from '../../runtime/core/unresolvedPrefabRef';
import { channelsOf } from '../../runtime/loaders/unresolvedPrefabRefs';
import { PREFAB_EDIT_LOCAL_GUID_PREFIX, PREFAB_EDIT_ROOT_GUID, SCAFFOLD_PREFIX } from './prefabEditGuids';
import { serializePrefab, warnInertPrefabSizes, setPrefabCache, getCachedPrefabSync, preloadNestedPrefabs } from './prefab';
import { commitPrefabWrite, prefabTextIsDocument } from './prefabCommit';
import { runtimeExcludedMessage } from './authoringScope';
import { collectResourceRefs, getCurrentScenePath, saveScene, loadScene, prepareWorldSwitch, markSceneSaved, worldHasUnsavedEdits, lastSceneKey, getScenePersistenceProject, type SerializedEntity } from './serialize';
import { getEditVersion } from '../undo/undoManager';
import { sceneManager, type SceneLoadResult } from '../../runtime/scene/SceneManager';
import { withAdoption, adoptionCount, endPrefabEditInPlace, beginWorldRequest, editorStateCurrent, SCENE_SWITCH_LANDING } from './sceneAdoption';
import { PREFAB_EDIT_SCENE_PREFIX, isPrefabEditWorld } from './prefabEditWorld';
import type { SceneData, SceneEntityEntry, AddedEntity } from '../../runtime/loaders/loadSceneFile';
import { useEditorStore } from '../store/editorStore';
import { getCurrentWorld } from '../../runtime/core/ecs/world';
import { linkOwnerBeforeMove } from '../../runtime/core/ecs/identityParents';
import { whyWorldNotAuthored } from './authoredWorld';
import { canEdit } from '../../runtime/core/playState';
import { SCENE_FORMAT_VERSION } from '../../runtime/core/version';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { getGuidForPath, resolveRef } from '../../runtime/loaders/assetManifest';
import { capturePrefabRead } from './prefabRead';
import { parseAssetJson } from '../../runtime/loaders/assetFetch';
import { isPrefabDocument } from '../../runtime/loaders/prefabRoot';
import { migrateUIAnchorZIndexStructured } from '../../runtime/loaders/uiAnchorZIndexMigration';
import { deriveMemberGuid, durableGuid, mapStringValues, memberPathSteps } from '../../runtime/core/assetRefRules';
import { isMemberToken, parseMemberToken, type MemberStep } from '../../runtime/core/templateRefs';

/** Guid prefix stamped on EVERY member of the synthetic edit scene, carrying that member's
 *  ORIGINAL localId (`__prefab_edit_local__7`).
 *
 *  Why a sentinel guid and not the entity id: the loader reassigns ECS ids densely, so the
 *  file's numbering is already lost by the time the edit world exists (measured — sling's
 *  FieldCorner has `drip` at localId 4 and it loads as ecsId 2). localIds are the address
 *  space a SCENE's prefab-instance `overrides` are keyed in, so letting a re-save renumber
 *  them silently drops those overrides. Riding on `guid` is safe because serializePrefab
 *  CLEARS EntityAttributes.guid on every row it writes — a template carries no per-instance
 *  identity — so the sentinel can never reach the file. */
export { PREFAB_EDIT_LOCAL_GUID_PREFIX, PREFAB_EDIT_ROOT_GUID };
/** Default HDR for the edit-mode environment (wooden_motel_2k — already in the
 *  asset manifest). Purely scaffolding; never written into the prefab. */
export const PREFAB_EDIT_HDR_GUID = '984275f1-3ebd-4848-927f-012595c76500';
/** Path prefix of the synthetic in-memory scene used for prefab-edit mode. The
 *  live scene being one of these is the ground truth for "am I editing a prefab". */
export { PREFAB_EDIT_SCENE_PREFIX, isPrefabEditWorld } from './prefabEditWorld';
/** Scaffold entity ids — far above any prefab localId so they never collide. */
const SCAFFOLD_BASE = 1_000_000;
/** Name prefix marking transient edit-mode scaffolding (lights + HDR) — defined in the leaf `prefabEditGuids.ts`. */
export { SCAFFOLD_PREFIX };

const scaffoldEntities = (): SceneEntityEntry[] => [
  {
    id: SCAFFOLD_BASE + 1,
    name: `${SCAFFOLD_PREFIX}KeyLight`,
    traits: {
      Transform: { x: 5, y: 10, z: 5, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 },
      EntityAttributes: { name: `${SCAFFOLD_PREFIX}KeyLight`, isActive: true, sortOrder: 70, parentId: 0, layer: '3d', guid: '' },
      Light: { lightType: 'directional', color: 0xffffff, intensity: 3, targetX: 0, targetY: 0, targetZ: 0, distance: 0, angle: 0.5, penumbra: 0, castShadow: false },
    },
  },
  {
    id: SCAFFOLD_BASE + 2,
    name: `${SCAFFOLD_PREFIX}Ambient`,
    traits: {
      Transform: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 },
      EntityAttributes: { name: `${SCAFFOLD_PREFIX}Ambient`, isActive: true, sortOrder: 50, parentId: 0, layer: '3d', guid: '' },
      Light: { lightType: 'ambient', color: 0xffffff, intensity: 1.2, targetX: 0, targetY: 0, targetZ: 0, distance: 0, angle: 0.5, penumbra: 0, castShadow: false },
    },
  },
  // The HDR is purely lighting scaffolding (IBL). Only include it when the guid
  // actually resolves in THIS project's asset manifest — the engine can't assume any
  // specific project ships it, and an unresolvable hdrPath logs a "[MeshCache] Unknown
  // asset guid" warning every time prefab-edit opens. KeyLight + Ambient above still
  // light the preview when the HDR is absent.
  ...(resolveRef(PREFAB_EDIT_HDR_GUID) ? [{
    id: SCAFFOLD_BASE + 3,
    name: `${SCAFFOLD_PREFIX}HDR`,
    traits: {
      EntityAttributes: { name: `${SCAFFOLD_PREFIX}HDR`, isActive: true, sortOrder: 30, parentId: 0, layer: '', guid: '' },
      Environment: { hdrPath: PREFAB_EDIT_HDR_GUID, intensity: 1, showAsBackground: false, backgroundIntensity: 1, backgroundBlurriness: 0 },
    },
  }] : []) as SceneEntityEntry[],
];

/** Build a synthetic scene that renders `prefab` in isolation. Prefab entities
 *  become plain scene entities (localId → entity id; parentId is already a
 *  localId). Nested-prefab rows (phase 3) keep their `prefab`/override fields so
 *  the loader expands them as nested instances. */
/** Scaffold ids for the 2D host, above the 3D ones so the two sets never collide. */
const SCAFFOLD_CANVAS_ID = SCAFFOLD_BASE + 4;
const SCAFFOLD_STAGE_ID = SCAFFOLD_BASE + 5;

/**
 * Does this prefab draw in the 2D layer? `Renderable2D`/`Text2D` are rendered by a `Canvas2D` HOST
 * and by nothing else, so without one they are perfectly correct in the ECS and invisible on screen.
 */
function hasContent2D(prefab: PrefabFile): boolean {
  return prefab.entities.some((e) => e.traits && ('Renderable2D' in e.traits || 'Text2D' in e.traits));
}

/**
 * The 2D scaffolding: a full-screen `Canvas2D` host plus a centring stage, injected ONLY for a prefab
 * that actually draws in 2D (the 3D lights and HDR above are the mirror image of this).
 *
 * ⚠️ **Without this, a 2D prefab opens completely blank** — every entity present, every trait right,
 * nothing drawn, because `Renderable2D` is only ever rendered by a `Canvas2D` host and edit mode
 * scaffolded a 3D world only. Reported against Court's tray-badge prefab, and it would hit any 2D
 * prefab in any project.
 *
 * **Why a STAGE and not just the canvas.** A `Canvas2D`'s design space has its origin at the TOP-LEFT,
 * while a prefab is authored around its own origin — so parenting the root straight to the canvas puts
 * it in the corner with three quadrants off-screen. The stage is a plain offset entity that moves the
 * content's centre to the canvas's centre, which keeps the prefab's authored transforms untouched.
 * Nudging the ROOT's own Transform instead would be a preview that edits the asset.
 *
 * **Why the reference resolution is derived and not the 1080x1920 default.** A badge ~200 design px
 * across inside a 1080-wide box is 18% of the view — technically visible, useless to tune. Framing the
 * canvas to the content is the 2D equivalent of the 3D preview pointing its camera at the model.
 *
 * ⚠️ **Re-parenting the root is SAFE, and it is worth knowing why rather than trusting it.**
 * `serializePrefab` remaps every `parentId` through `ecsToLocal.get(id) || 0`; a scaffold entity is not
 * part of the prefab, so it is absent from that map and the root's parent normalises back to **0** on
 * save. The stage therefore cannot leak into the file.
 */
function scaffold2DEntities(prefab: PrefabFile): SceneEntityEntry[] {
  // Content bounds in the prefab's own space. `Renderable2D.width`/`height` are HALF-extents for
  // primitives; a Text2D has no measurable extent headlessly, so its font size stands in for one.
  let minX = 0, maxX = 0, minY = 0, maxY = 0;
  for (const e of prefab.entities) {
    const t = (e.traits?.Transform ?? {}) as Record<string, number>;
    const r2 = e.traits?.Renderable2D as Record<string, number> | undefined;
    const tx = e.traits?.Text2D as Record<string, number> | undefined;
    if (!r2 && !tx) continue;
    const x = t.x ?? 0, y = t.y ?? 0;
    const hw = r2 ? (r2.width ?? 0) : (tx?.fontSize ?? 0) / 2;
    const hh = r2 ? (r2.height ?? 0) : (tx?.fontSize ?? 0) / 2;
    minX = Math.min(minX, x - hw); maxX = Math.max(maxX, x + hw);
    minY = Math.min(minY, y - hh); maxY = Math.max(maxY, y + hh);
  }
  // Pad so the content does not touch the edges, and floor it so a tiny or empty prefab still gets a
  // sane box instead of a degenerate one (a zero reference resolution divides by zero downstream).
  const PAD = 1.6, FLOOR = 64;
  const w = Math.max(maxX - minX, FLOOR), h = Math.max(maxY - minY, FLOOR);
  const refW = Math.round(w * PAD), refH = Math.round(h * PAD);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  return [
    {
      id: SCAFFOLD_CANVAS_ID,
      name: `${SCAFFOLD_PREFIX}Canvas2D`,
      traits: {
        RenderableUI: true,
        EntityAttributes: { name: `${SCAFFOLD_PREFIX}Canvas2D`, isActive: true, sortOrder: 10, parentId: 0, layer: 'ui', guid: '' },
        UIElement: { width: 100, height: 100 },
        UIAnchor: {},
        // `contain` so the whole framed box is visible whatever shape the panel is — cropping the
        // thing you opened the editor to look at would defeat the point.
        Canvas2D: { referenceWidth: refW, referenceHeight: refH, scaleMode: 'contain' },
      },
    },
    {
      id: SCAFFOLD_STAGE_ID,
      name: `${SCAFFOLD_PREFIX}Stage`,
      traits: {
        Transform: { x: refW / 2 - cx, y: refH / 2 - cy, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 },
        EntityAttributes: { name: `${SCAFFOLD_PREFIX}Stage`, isActive: true, sortOrder: 11, parentId: SCAFFOLD_CANVAS_ID, layer: '2d', guid: '' },
      },
    },
  ];
}

/** The guid the edit world gives the member at `path` below the prefab's root (#1352). A flat row is its
 *  own sentinel. Past a nested row, the rest derives from that row's sentinel, because the row is a
 *  top-level scene instance here. `null` when the path names no row.
 *
 *  ⚠️ **In the prefab EDIT world, derivation stays the SOLE rule — never a fallback behind stored
 *  member rows** (#1468 Phase 2B). Scene v16 stores a member's guid and derives only what no row
 *  names; this world does the opposite on purpose, and the reason is that it has no scene:
 *
 *  - There is no `SceneEntityEntry` to hold rows. The edit world is scaffolding plus the prefab's own
 *    rows, assembled by `buildPrefabEditScene` and never written to disk as a scene.
 *  - Its guids are SENTINELS, not identities — `__prefab-edit-local-<localId>` — whose entire job is
 *    to smuggle localIds through a round trip so `collectPreservedLocalIds` can read them back. A row
 *    pinning one would pin a value that is meaningless outside this session.
 *  - The document being edited is the one the rows would be ABOUT. Storing identity for a template's
 *    own nodes inside that template is the circularity `nodeGuid` already answers, on the row itself.
 *
 *  So a reader looking for the v16 fallback here should stop looking: it is deliberately absent, and
 *  the sentinel was deliberately NOT retired (#1468 design record). */
function editGuidAt(prefab: PrefabFile, path: readonly MemberStep[]): string | null {
  const sentinel = (localId: number) => localId === prefab.rootLocalId ? PREFAB_EDIT_ROOT_GUID : `${PREFAB_EDIT_LOCAL_GUID_PREFIX}${localId}`;
  if (!path.length) return sentinel(prefab.rootLocalId);
  const rows = new Map(prefab.entities.map((e) => [e.localId, e]));
  for (let i = 0; i < path.length; i++) {
    const row = typeof path[i] === 'number' ? rows.get(path[i] as number) : undefined;
    if (!row) return null;
    if (row.prefab) return i === path.length - 1 ? sentinel(row.localId) : deriveMemberGuid(sentinel(row.localId), path.slice(i + 1));
    if (i === path.length - 1) return sentinel(row.localId);
  }
  return null;
}

/** A payload `depth` frames below the prefab's root, with every member token that climbs back to the
 *  root replaced by the edit world's guid for it. The edit world flattens the root's own rows into
 *  plain scene entities, so no instantiate call there has the root as a frame. A token relative to an
 *  inner frame is left for the loader, which expands that row as a scene instance.
 *
 *  A REFERENCE node (an `added` node carrying `prefab`) is not in this payload's frame: its payload is in its
 *  own instance's, applied by a top call of its own, as the loader's `rebaseAddedTokens` leaves it. So it is
 *  mapped at ITS depth, one below this (`editReferenceNodeRefs`) — counted from this depth, a `^` that only
 *  reaches the node's root would read as one reaching the prefab's (#1538). A `^` that does climb out of the node
 *  to the prefab's root is rewritten like any other (#1541); one reaching only a frame between is the loader's. */
function editWorldRefs(prefab: PrefabFile, value: unknown, depth: number): unknown {
  const mapped = mapStringValues(value, (s) => {
    const t = isMemberToken(s) ? parseMemberToken(s) : null;
    if (!t || t.up !== depth) return s;
    return editGuidAt(prefab, t.path) ?? s;
  }, isReferenceNode);
  return swapReferenceNodes(mapped, (n) => editReferenceNodeRefs(prefab, n, depth + 1));
}

/** A reference node's own payload, its root `depth` frames below the prefab's root: each channel at the depth of the
 *  frame it applies in, as a row's are (`buildPrefabEditScene`). */
function editReferenceNodeRefs(prefab: PrefabFile, n: AddedEntity, depth: number): AddedEntity {
  const at = <T,>(v: T, d: number): T => editWorldRefs(prefab, v, d) as T;
  const byPath = <T,>(paths: Record<string, T> | undefined) =>
    paths && Object.fromEntries(Object.entries(paths).map(([k, v]) => [k, at(v, depth + k.split('.').length)]));
  return {
    ...n,
    traits: at(n.traits, depth),
    children: at(n.children, depth),
    ...(n.overrides ? { overrides: at(n.overrides, depth) } : {}),
    ...(n.added ? { added: at(n.added, depth) } : {}),
    ...(n.nestedOverrides ? { nestedOverrides: byPath(n.nestedOverrides) } : {}),
    ...(n.nestedStructure ? { nestedStructure: byPath(n.nestedStructure) } : {}),
    ...(n.members ? { members: byRowDepth(n.members, n.prefab, (v, d) => at(v, depth - 1 + d)) } : {}),
  };
}

/** `value` with every reference node in it (they sit in node lists: `added`, `children`, a row's `own`) replaced by
 *  `fn(node)`. Copy-on-write, like `mapStringValues`. */
function swapReferenceNodes(value: unknown, fn: (n: AddedEntity) => AddedEntity): unknown {
  if (Array.isArray(value)) {
    const out = value.map((v) => (v && typeof v === 'object' && isReferenceNode(v) ? fn(v as AddedEntity) : swapReferenceNodes(v, fn)));
    return out.some((v, i) => v !== value[i]) ? out : value;
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return value;
  let out: Record<string, unknown> | undefined;
  for (const [k, v] of Object.entries(value)) {
    const w = swapReferenceNodes(v, fn);
    if (w === v) continue;
    out ??= { ...(value as Record<string, unknown>) };
    Object.defineProperty(out, k, { value: w, enumerable: true, writable: true, configurable: true });
  }
  return out ?? value;
}

/** An `added` node carrying `prefab` — told apart by the node's own shape, since a trait's field bag may hold a
 *  `prefab` string too (a spawner's), and that bag's tokens must still be rewritten. */
function isReferenceNode(v: object): boolean {
  const n = v as { prefab?: unknown; parentLocalId?: unknown; children?: unknown };
  return !Array.isArray(v) && typeof n.prefab === 'string' && typeof n.parentLocalId === 'number' && Array.isArray(n.children);
}

/** `paths` with each entry mapped at its depth below the prefab's root: 1 for the row, plus one per path step. */
function byPathDepth<T>(paths: Record<string, T> | undefined, fn: (v: T, depth: number) => unknown): Record<string, T> | undefined {
  if (!paths) return paths;
  return Object.fromEntries(Object.entries(paths).map(([k, v]) => [k, fn(v, 1 + k.split('.').length) as T]));
}

/** A prefab row's `members` (#1533) with each row mapped at the depth of the frame it applies in — {@link byPathDepth}
 *  for the identity-keyed channel. A row applies in the frame its key names a member of (the key less its last
 *  component), except a nested ROOT's row, which lands at that root and so applies in the root's own frame; only the
 *  documents on the way tell the two apart, so they are walked from the row's prefab. */
function byRowDepth<T>(rows: Record<string, T> | undefined, rowPrefab: string | undefined, fn: (v: T, depth: number) => unknown): Record<string, T> | undefined {
  if (!rows) return rows;
  const depthOf = (key: string): number => {
    let doc = rowPrefab ? getCachedPrefabSync(rowPrefab) : null;
    let depth = 1;
    const parts = key.split('/').slice(1);
    for (let i = 0; i < parts.length && doc; i++) {
      const nested = doc.entities.find((e) => e.nodeGuid === parts[i] && e.prefab && e.localId !== (doc!.rootLocalId ?? 1));
      if (!nested) break;
      depth++;
      doc = getCachedPrefabSync(nested.prefab!);
    }
    return depth;
  };
  return Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, fn(v, depthOf(k)) as T]));
}

/** Show the prefab's own moves (#1437) in the loaded edit world: each member goes under its target, found by
 *  the guids the edit world gives both. A linked member (inside a nested row's instance) keeps deriving from
 *  the row parent it left, as a loaded move does — read from its document (`identityParents.ts`), with an
 *  owned nested root's owner linked first; a flat row is plain here, and the save puts it back under its
 *  original row parent (`serializePrefab`'s `rowParents`). A move naming nothing is reported and left out. */
export function applyEditWorldMoves(prefab: PrefabFile): void {
  if (!prefab.moved) return;
  const eaMeta = getTraitByName('EntityAttributes');
  const piMeta = getTraitByName('PrefabInstance');
  if (!eaMeta) return;
  const byGuid = new Map<string, Entity>();
  for (const e of getCurrentWorld().entities) {
    const g = e.has(eaMeta.trait) ? (e.get(eaMeta.trait) as { guid?: string }).guid : '';
    if (g) byGuid.set(g, e);
  }
  for (const [key, token] of Object.entries(prefab.moved)) {
    const t = parseMemberToken(token);
    const memberGuid = editGuidAt(prefab, memberPathSteps(key));
    const targetGuid = t && !t.up ? editGuidAt(prefab, t.path) : null;
    const member = memberGuid ? byGuid.get(memberGuid) : undefined;
    const target = targetGuid ? byGuid.get(targetGuid) : undefined;
    if (!member || !target) { console.warn(`[PrefabEdit] the prefab's move of ${key} names nothing here; not shown`); continue; }
    if (piMeta && member.has(piMeta.trait)) linkOwnerBeforeMove(getCurrentWorld(), member.id());
    member.set(eaMeta.trait, { ...(member.get(eaMeta.trait) as { parentId?: number }), parentId: target.id() });
  }
}

export function buildPrefabEditScene(prefab: PrefabFile): SceneData {
  const entities: SceneEntityEntry[] = prefab.entities.map((pe) => {
    const traits = editWorldRefs(prefab, { ...pe.traits }, 0) as Record<string, Record<string, unknown> | boolean>;
    // Stamp the root so save can find it after id reassignment, and EVERY member with its
    // original localId so the save can put it back (see PREFAB_EDIT_LOCAL_GUID_PREFIX). The
    // root carries the root sentinel — findPrefabEditRoot keys off it — and its localId comes
    // from `rootLocalId`, which the save reads back the same way as any other member.
    {
      const ea = (typeof traits.EntityAttributes === 'object' ? traits.EntityAttributes : {}) as Record<string, unknown>;
      traits.EntityAttributes = {
        ...ea,
        guid: pe.localId === prefab.rootLocalId
          ? PREFAB_EDIT_ROOT_GUID
          : `${PREFAB_EDIT_LOCAL_GUID_PREFIX}${pe.localId}`,
      };
    }
    // Forward nested-instance rows (a child prefab reference + its diffs) so the
    // loader expands them as nested instances — you edit the child via its own
    // edit session, not inline here.
    return {
      id: pe.localId, name: pe.name, traits,
      // A nested row's instance root carries its sentinel as its STORED guid, so its members derive from it —
      // what `editGuidAt` names them by (#1352, #1437). Left to derive, the root anchored on the scene parent.
      ...(pe.prefab ? { guid: `${PREFAB_EDIT_LOCAL_GUID_PREFIX}${pe.localId}` } : {}),
      prefab: pe.prefab, overrides: editWorldRefs(prefab, pe.overrides, 1) as typeof pe.overrides,
      added: editWorldRefs(prefab, pe.added, 1) as typeof pe.added, removed: pe.removed, removedTraits: pe.removedTraits,
      // Both nested channels too (#1381): the row becomes a top-level scene entry here, the carrier
      // that already reads them, so the edit world shows the row as instances of it expand. The
      // save re-captures them from this live expansion (`planPrefabRows`).
      nestedOverrides: byPathDepth(pe.nestedOverrides, (v, d) => editWorldRefs(prefab, v, d)),
      nestedStructure: byPathDepth(pe.nestedStructure, (v, d) => editWorldRefs(prefab, v, d)),
      // …and its member rows (prefab v6, #1533), the outermost layer here as a scene entry's are.
      ...(pe.members ? { members: byRowDepth(pe.members, pe.prefab, (v, d) => editWorldRefs(prefab, v, d)) } : {}),
    };
  });
  entities.push(...scaffoldEntities());
  // 2D content needs a host to render into; 3D content does not. Injected only when the prefab
  // actually draws in 2D, so a 3D prefab's world is byte-for-byte what it was before.
  if (hasContent2D(prefab)) {
    entities.push(...scaffold2DEntities(prefab));
    // Re-parent the ROOT into the centring stage. Only the root: its descendants keep their authored
    // parents, so the subtree's internal layout is untouched.
    const root = entities.find((e) => e.id === prefab.rootLocalId);
    const ea = root && typeof root.traits.EntityAttributes === 'object'
      ? root.traits.EntityAttributes as Record<string, unknown> : undefined;
    if (ea) ea.parentId = SCAFFOLD_STAGE_ID;
  }
  // collectResourceRefs takes SerializedEntity[]; SceneEntityEntry is shape-compatible.
  const resources = collectResourceRefs(entities as unknown as SerializedEntity[]);
  return { version: SCENE_FORMAT_VERSION, resources, entities };
}

/**
 * Which scene should `exitPrefabEditing` go back to, given the currently-loaded scene path and the
 * return path already recorded by an outer prefab-edit session.
 *
 * ⚠️ **The current scene is NOT always a real scene.** Opening a prefab from INSIDE prefab-edit —
 * a nested prefab, or simply double-clicking another prefab in the Assets panel — leaves
 * `sceneManager.getCurrent()?.path` holding the SYNTHETIC `/__prefab-edit__/<guid>`. Recording that
 * as the return scene made exit try to LOAD it, which 404s (`no asset at /__prefab-edit__/… — the
 * dev server answered with index.html`) and strands the editor in the prefab world with no scene
 * path and no way back but opening one by hand. Observed, not theorised.
 *
 * The fix is to prefer the return path the OUTER session already recorded, so a chain of prefab
 * opens still lands on the real scene the chain started from. Note `openPrefabForEditing` already
 * got this distinction right one line above, for the save guard, by asking `getCurrentScenePath()`
 * (null in prefab-edit) instead — two sources for one question, disagreeing.
 */
export function resolveReturnScene(currentPath: string | null, recordedReturn: string | null): string | null {
  // Both candidates are filtered, not just the first: an older session could already have banked a
  // synthetic path in the store, and handing it back would recreate the dead end this exists to
  // close. Null is a SAFE answer here (exit simply clears the flag); a synthetic path is not.
  return [currentPath, recordedReturn]
    .find((p): p is string => !!p && !p.startsWith(PREFAB_EDIT_SCENE_PREFIX)) ?? null;
}

/** Open `asset` (a prefab) for isolated editing. Remembers the current scene so
 *  exitPrefabEdit can restore it. */
export async function openPrefabForEditing(
  asset: { path: string; name: string },
  opts: {
    /** Asked when the world still holds unsaved edits after the auto-save below (an untitled scene,
     *  or a save that failed) — resolve false to abort before the swap discards them. The HUMAN
     *  route passes the unsaved-work gate (#1419); the agent op refuses up front instead. */
    confirmDiscard?: (action: string) => Promise<boolean>;
    /** The caller already chose to DISCARD the world's unsaved edits (the agent's `discardUnsaved`): the auto-save below
     *  is skipped and the swap discards them, as `loadScene` does. Saving them wrote into the file the very work the
     *  caller said to throw away (#1745). */
    discardUnsaved?: boolean;
  } = {},
): Promise<EditOpenRefusal | undefined> {
  // Taken before the first await: a scene load, Create Scene or another edit-open requested after this one wins (#1700).
  const stillNewest = beginWorldRequest();
  // Refuses new undo steps for the whole switch, fetch included, and names the one in flight (#1579).
  const worldSwitch = prepareWorldSwitch({ takeDownEnvelope: true });
  try {
    // The undo in flight finishes BEFORE the fetch below (#1579 close-out review): an Apply undo installs the prefab
    // file, so a fetch during its write read the applied file and `setPrefabCache` overwrote the undo's restored copy —
    // the edit world was built from the applied document, and saving it put the Apply back on disk.
    if (worldSwitch.idle) await worldSwitch.idle;
    return await openPrefabForEditingSwitching(asset, opts, worldSwitch.ready, stillNewest);
  } finally {
    worldSwitch.release();
  }
}

async function openPrefabForEditingSwitching(
  asset: { path: string; name: string },
  opts: { confirmDiscard?: (action: string) => Promise<boolean>; discardUnsaved?: boolean },
  switchReady: () => Promise<void> | null,
  stillNewest: () => boolean,
): Promise<EditOpenRefusal | undefined> {
  // The read's token, taken before the fetch (#1752, `prefabRead.ts`): a write landing during it seats the newer document,
  // and seeding this one after it put the older bytes back in both caches — then built the edit world from them.
  const readAt = capturePrefabRead(asset.path);
  let prefab: PrefabFile;
  try {
    const res = await fetch(asset.path);
    prefab = await parseAssetJson(res, asset.path) as PrefabFile;
  } catch (e) {
    console.error('[PrefabEdit] fetch failed:', e);
    return;
  }
  // The shape check every other prefab read asks where it enters a cache (#1813, `isPrefabDocument`): this raw read seeds
  // both caches below and builds the edit world from `entities`, and a file without that shape threw out of the open.
  if (!isPrefabDocument(prefab)) {
    console.error(`[PrefabEdit] ${asset.path} is not a prefab document (no entities array of rows) — not opened`);
    return;
  }
  // This is a RAW fetch, not routed through getPrefabSource — that helper already runs this
  // migration (structured walk, see uiAnchorZIndexMigration.ts) on every load, but this path
  // bypasses it entirely, so it must run here too BEFORE setPrefabCache below, or the
  // un-migrated object poisons every later getPrefabSource read of this same guid for the
  // rest of the session.
  for (const entry of prefab.entities) migrateUIAnchorZIndexStructured(entry);
  const guid = prefab.id ?? getGuidForPath(asset.path) ?? asset.path;
  // Nothing is seeded by a request that no longer owns the switch (#1752): `setPrefabCache` rewrites the runtime cache
  // too, bumping the prefab's revision and re-spawning every pool built from it, for an open that will never happen.
  if (!stillNewest()) {
    console.warn(`[PrefabEdit] "${asset.name}" was not entered: a newer scene request was made while it waited`);
    return;
  }
  // …nor from bytes older than the file: refused, never re-read (owner, 2026-09-28) — the human opened this prefab, and
  // opening a version they did not see is not the answer to a write they may not know about either.
  if (!readAt()) return changedWhileOpening(asset.name);
  // Seed the editor prefab cache so override/apply paths resolve without a refetch,
  // and preload any nested children into the SAME (editor) cache — serializePrefab's
  // sync nested-instance detection reads it, so without this a nested instance would
  // flatten on save instead of round-tripping as a reference row.
  setPrefabCache(guid, prefab);
  // From here the token is the seed's own — the seed bumped the revision itself — and it is asked once more after the
  // save and the human's dialog below: a write landing there made `prefab` older than the file this world would edit.
  const seeded = capturePrefabRead(asset.path);
  // …and the session's OWN copy of what it opened (#1692): the save's precondition and its row numbering. Not the
  // cache entry — every prefab write re-seats that — and a COPY: the edit scene is built from `prefab`'s trait bags, and
  // the loader edits them in place (a legacy `CameraFrame.showGizmo` is stripped), which would make every save of such a
  // prefab look like a file changed on disk. Taken now, SEATED only once the swap has landed (below).
  const opened = JSON.parse(JSON.stringify(prefab)) as PrefabFile;
  await preloadNestedPrefabs(prefab);

  // Entering prefab-edit SWAPS the live world, and exitPrefabEdit reloads the return
  // scene FROM DISK (so its instances re-expand from the just-edited prefab — an
  // in-memory snapshot would defeat that purpose). Any unsaved edits in the current
  // scene would therefore be lost on return — most visibly the in-memory
  // PrefabInstance tags a just-created prefab applied to the live tree. Persist them
  // first so the round trip is non-destructive. Skip when there's no real scene file
  // to write to — an unsaved new scene, or already inside prefab-edit opening a
  // NESTED prefab (both have a null current path) — which would pop a Save-As picker.
  // The undo in flight finishes first (#1579), and then a preview envelope comes down, restored
  // (#1548 re-review): the swap below goes straight through SceneManager, so `loadScene`'s own takedown
  // never runs — the session was abandoned at the swap, a posed Persistent root rode the carry (before #1863 kept it to Play) into
  // prefab-edit and back, and the save just below was silently refused ("a preview session is open")
  // instead of persisting the round trip. The undo goes first because it reloads the world this save
  // writes and this swap replaces.
  const ready = switchReady();
  if (ready) await ready;
  // ⚠️ Both decisions come BEFORE the save, which is this route's one side effect on disk (#1745). A request superseded
  // while it waited does nothing: the newer one owns the world, and one that discarded it would find this older
  // request's save had written the discarded work into the file. A caller that asked to discard gets no save at all.
  if (!stillNewest()) {
    console.warn(`[PrefabEdit] "${asset.name}" was not entered: a newer scene request was made while it waited`);
    return;
  }
  // …and not over a world that is not savable (#1750; owner, 2026-09-28: refuse, never wait). Checked BEFORE the save:
  // in another route's tail the save wrote the incoming world into the outgoing scene's file (#1746 A2), and a refused
  // save used to be ignored, so the swap below then discarded the work it had failed to keep. Play armed while this
  // fetched is the same answer (the run mode), and swapping would put this edit world inside the Play world.
  const refused = refuseUnsavable(asset.name, opts);
  if (refused) return refused;
  if (getCurrentScenePath() && !opts.discardUnsaved) await saveScene();
  if (opts.confirmDiscard && worldHasUnsavedEdits() && !(await opts.confirmDiscard(`edit prefab ${asset.name}`))) return;
  // The REQUEST-order check `loadScene` makes after its `ready()` (#1700), here after the last await before the swap: a
  // newer request made while this one waited — the human's dialog above can stay open indefinitely — owns the world, and
  // swapping now would replace the newer scene with this older request's edit world. The world rule cannot see it: after
  // this swap the edit world IS current. Synchronous from here to `SceneManager`'s call inside `loadPrefabEditWorld`.
  if (!stillNewest()) {
    console.warn(`[PrefabEdit] "${asset.name}" was not entered: a newer scene request was made while it waited`);
    return;
  }
  // Again after the save and the human's dialog, which can stay open indefinitely: Play pressed meanwhile, or another
  // route's swap, is found here, with nothing from here to the swap that awaits.
  const late = refuseUnsavable(asset.name, opts);
  if (late) return late;
  if (!seeded()) return changedWhileOpening(asset.name);

  const returnScene = resolveReturnScene(
    sceneManager.getCurrent()?.path ?? null,
    useEditorStore.getState().prefabReturnScenePath ?? null,
  );
  const sceneData = buildPrefabEditScene(prefab);
  // One pending adoption around the swap (#1698). The owner reads the dirt still here after the save above (an untitled
  // scene, or a save that failed) — that work is discarded by this swap, and so is its undo stack (#1409) — and it
  // records the repair owed for leaving an edit world this one replaces (#1666): opening a prefab from INSIDE another's
  // edit world leaves that one as a scene load would.
  await withAdoption('prefab-edit-open', async (adoption) => {
    let loaded: SceneLoadResult;
    try {
      loaded = await loadPrefabEditWorld(guid, prefab, sceneData);
    } catch (e) {
      console.error('[PrefabEdit] failed to load edit scene:', e);
      return;
    }
    // Adopted only while this edit world is still the one on screen: a switch that replaced it during the swap's tail
    // adopts its own world, and entering this session over it would name a prefab that is not loaded. The path is
    // null so a scene save cannot target a real file; the edit world never carries a base; its undo stack is its OWN,
    // keyed by the synthetic path and dropped when the world is left (U27, #1704; the scene's is parked and restored
    // when Exit reloads it through `loadScene`); and the world IS its file — a clean baseline, like a load (#1409
    // review): without it a dirty flag from an untitled scene rode into the prefab world, which then read as unsaved. The flag goes up before the owed
    // repair runs, since the refresh skips the prefab it names — re-opening the same prefab refreshes nothing, it was
    // just fetched above.
    if (!adoption.offer({
      world: loaded.world, path: null, baseScene: 'none',
      history: { key: `${PREFAB_EDIT_SCENE_PREFIX}${guid}`, keptBaseGuids: loaded.keptBaseGuids },
      prefabEdit: { prefab: { path: asset.path, guid, name: prefab.name }, returnScene },
    })) {
      console.warn(`[PrefabEdit] "${prefab.name}" was not entered: another scene replaced its edit world while it loaded`);
      return;
    }
    // ⚠️ Seated here, once the session IS this prefab's, not at the fetch (#1692 close-out re-review): the gate above can
    // cancel this open and the swap can fail or be replaced — and the session still open (another prefab's) would be left
    // with no baseline, refusing every save, including the gate's own Save of it.
    editBaseline = { guid, doc: opened };
    console.log(`[PrefabEdit] editing "${prefab.name}"`);
  });
}

/** An edit-open refused because the world was not in a state to leave (#1750): `refused` is the reason, for a toast or an
 *  agent refusal. Nothing was written and nothing was swapped. */
export interface EditOpenRefusal { readonly refused: string }

/** The prefab was written while it was being opened (#1752): the copy in hand is older than the file. Worded for either
 *  writer — an outside change, or the human's own Save from the discard dialog when they re-open the prefab they are
 *  editing (close-out review), where "changed on disk" would blame someone else for their save. */
function changedWhileOpening(name: string): EditOpenRefusal {
  const refused = `"${name}" was saved while it was opening (by this editor or outside it), so it was not entered — open it again to edit the saved version`;
  console.warn(`[PrefabEdit] ${refused}`);
  return { refused };
}

/** Why an edit-open must not leave the world now, or null. A switch still landing (any route — a Stop's or a preview's
 *  restore included, whose own reason outranks the switch reason in `whyWorldNotAuthored`) and a run mode other than
 *  stopped refuse ALWAYS: this swap would supersede that switch, or land inside the Play world. Asked of the owner and the
 *  run mode directly, not by comparing the reason string, for that reason (close-out review). Any other posed-world
 *  reason refuses only when the edits would be kept, since the save that keeps them would be refused and the swap would
 *  then discard them; a caller that asked to discard them gets its swap. */
function refuseUnsavable(name: string, opts: { discardUnsaved?: boolean }): EditOpenRefusal | undefined {
  const landing = !editorStateCurrent();
  const why = whyWorldNotAuthored();
  if (!landing && (!why || (opts.discardUnsaved && canEdit()))) return undefined;
  const refused = landing
    ? `${SCENE_SWITCH_LANDING} — open the prefab again once it's open`
    : `the world is not in a state to leave (${why})`;
  console.warn(`[PrefabEdit] "${name}" was not entered: ${refused}`);
  return { refused };
}

/** Build the prefab-edit world for `prefab` (the document of the prefab `guid`) in place of the live world — the
 *  world half of `openPrefabForEditing`, which owns entering the session (history, dirty baseline, the store). */
export async function loadPrefabEditWorld(guid: string, prefab: PrefabFile, sceneData: SceneData = buildPrefabEditScene(prefab)): Promise<SceneLoadResult> {
  const loaded = await sceneManager.loadScene(`${PREFAB_EDIT_SCENE_PREFIX}${guid}`, { preloaded: sceneData });
  applyEditWorldMoves(prefab);
  return loaded;
}

/** Locate the live ECS id of the prefab root in the edit world (by sentinel guid). */
function findPrefabEditRoot(): number {
  const eaMeta = getTraitByName('EntityAttributes');
  if (!eaMeta) return 0;
  let rootId = 0;
  getCurrentWorld().query(eaMeta.trait).updateEach(([ea], entity) => {
    if ((ea as Record<string, unknown>).guid === PREFAB_EDIT_ROOT_GUID) rootId = entity.id();
  });
  return rootId;
}

/** Read the original localIds back out of the edit world: ecsId → the localId that member
 *  had in the file we opened. Members the user ADDED during the edit carry no sentinel and
 *  are simply absent, so serializePrefab allocates them fresh ids above the preserved ones.
 *  `rootLocalId` is passed separately because the root carries the root sentinel instead.
 *
 *  Exported for tests: this is the half of the localId-preservation fix that only a LIVE
 *  editor round-trip would otherwise exercise (buildPrefabEditScene writes the sentinels, a
 *  real scene load reassigns the ecs ids, and only then does this read them back). */
export function collectPreservedLocalIds(
  rootLocalId: number, rootEcsId: number,
  /** The prefab being edited: its saves' record (#1662) answers for a member the user added. */
  prefabGuid?: string,
  /** The document the save is written over. A remembered number is trusted only where this document has no row at it,
   *  or has that same row: a write OUTSIDE prefab edit (an Apply appends at max+1, a Replace renumbers, a checkout) can
   *  have given the number to another row since, and the member would take that row's identity (close-out review 3). */
  current?: PrefabFile,
): Map<number, number> {
  const map = new Map<number, number>();
  const eaMeta = getTraitByName('EntityAttributes');
  if (!eaMeta) return map;
  if (rootEcsId) map.set(rootEcsId, rootLocalId);
  const world = getCurrentWorld();
  const saved = prefabGuid ? sessionRowsByPrefab.get(prefabGuid)?.rows : undefined;
  const added: [number, number][] = [];
  world.query(eaMeta.trait).updateEach(([ea], entity) => {
    const guid = (ea as Record<string, unknown>).guid;
    if (typeof guid !== 'string') return;
    if (!guid.startsWith(PREFAB_EDIT_LOCAL_GUID_PREFIX)) {
      // A member ADDED in this session that an earlier save already wrote: the row it was written at (#1662).
      const at = saved?.get(guid);
      const there = at ? current?.entities.find((e) => e.localId === at.localId) : undefined;
      if (at && entity.id() !== rootEcsId && (!there || there.nodeGuid === at.nodeGuid)) added.push([entity.id(), at.localId]);
      return;
    }
    const localId = Number(guid.slice(PREFAB_EDIT_LOCAL_GUID_PREFIX.length));
    if (Number.isInteger(localId) && localId > 0) map.set(entity.id(), localId);
  });
  // An opened row's sentinel wins a number over a remembered one, and a number two remembered members claim goes to
  // neither — `localIdFloor` keeps both from happening, so this is the floor under it, never a guess.
  const held = new Set(map.values());
  const claims = new Map<number, number>();
  for (const [, lid] of added) claims.set(lid, (claims.get(lid) ?? 0) + 1);
  for (const [id, lid] of added) if (!held.has(lid) && claims.get(lid) === 1) map.set(id, lid);
  return map;
}

/** Per PREFAB, what its prefab-edit saves have written (#1662). An opened row carries its localId in its sentinel guid; a
 *  member the user ADDED has an ordinary guid, so without this every later save renumbered it above the preserved ids
 *  and minted it a fresh `nodeGuid`.
 *  - `rows`: live guid → the localId and `nodeGuid` a save gave it — every row a save wrote, and every row of each
 *    document an edit world was built from (by its sentinel guid). It answers for a member the LAST save no longer
 *    had: deleted, then brought back by an undo, which respawns it under its guid.
 *  - `floor`: the highest localId any of those has used, including each document's persisted high-water mark (#1774,
 *    `localIdCounter`). A new member is numbered above it, so a number a delete freed is never handed to another member
 *    while the deleted one can still come back (Unity never reuses a fileID either). Without it an undone delete met its
 *    own number on a newcomer: two rows at one localId. The record dies with the process; the mark in the file is what
 *    keeps a LATER session from handing the freed number out again (#1774).
 *  ⚠️ Keyed by the PREFAB, not the edit world, because what an undo can bring back outlives the world: Stop rebuilds it
 *  from a snapshot, so an entity from an earlier world can be respawned into a later one. Per world, each rebuild forgot
 *  every number and identity (close-out review 2). It lives as long as the editor process. Leaving prefab edit drops the
 *  prefab's undo history (U27 in `docs/prefabs.md`, #1704), so what it keeps across visits costs only gaps in the
 *  numbering.
 *  ⚠️ A write made OUTSIDE prefab edit between two visits (a rebuild over the file, #1782; a pre-v5 Replace; a checkout)
 *  can give a number this record remembers to another row. A remembered ADDED member then yields to the document
 *  (`collectPreservedLocalIds`' `current`). A SENTINEL cannot: `__prefab_edit_local__<n>` names row n of whichever
 *  document the entity came from. Only an undo from an earlier visit could bring such a row back, and that history is
 *  dropped on leave (#1704); the save still refuses a duplicate rather than guess. */
interface SessionRows { rows: Map<string, { localId: number; nodeGuid: string }>; floor: number }
const sessionRowsByPrefab = new Map<string, SessionRows>();
/** A row is keyed by the live entity's guid, and what it holds is WRITTEN — the nodeGuid a later save restores for a
 *  member deleted and brought back by an undo. An unpack or a detach inside prefab edit renames the edit world's
 *  entities (`applyGuidRemap`), so the record follows the rename or that restore misses (#1785). */
onGuidRemap('prefabEdit:sessionRows', (remap) => {
  for (const rec of sessionRowsByPrefab.values()) remapGuidMapKeys(rec.rows, remap);
});
/** The prefab each world has merged its opened rows into the record of. */
const seededWorlds = new WeakMap<World, string>();
/** The highest localId `doc` has ever used: below its high-water mark (#1774), which a file before v8 derives from its rows. */
const usedUpTo = (doc: PrefabFile): number => localIdCounter(doc) - 1;
/** Prefab `guid`'s record, with the rows of `opened` — the document `world` was built from — merged in once per world. */
function sessionRowsFor(world: World, guid: string, opened: PrefabFile): SessionRows {
  let rec = sessionRowsByPrefab.get(guid);
  if (!rec) { rec = { rows: new Map(), floor: 0 }; sessionRowsByPrefab.set(guid, rec); }
  if (seededWorlds.get(world) !== guid) {
    for (const e of opened.entities) {
      if (e.localId === opened.rootLocalId || !e.nodeGuid) continue;
      rec.rows.set(`${PREFAB_EDIT_LOCAL_GUID_PREFIX}${e.localId}`, { localId: e.localId, nodeGuid: e.nodeGuid });
    }
    rec.floor = Math.max(rec.floor, usedUpTo(opened));
    seededWorlds.set(world, guid);
  }
  return rec;
}
/** Record, after a save LANDED, where it wrote each member: `written` guid → localId, read at SERIALIZE time (an id read
 *  after the write's await could name an entity created in the meantime). */
function noteSessionRows(guid: string, written: ReadonlyMap<string, number>, doc: PrefabFile): void {
  const rec = sessionRowsByPrefab.get(guid);
  if (!rec) return;
  const nodeGuidAt = new Map(doc.entities.map((e) => [e.localId, e.nodeGuid ?? '']));
  for (const [g, localId] of written) rec.rows.set(g, { localId, nodeGuid: nodeGuidAt.get(localId) ?? '' });
  rec.floor = Math.max(rec.floor, usedUpTo(doc));
}
/** Test-only: the live session-row record, by prefab guid. */
export function _sessionRowsForTest(): Map<string, { rows: Map<string, { localId: number; nodeGuid: string }>; floor: number }> { return sessionRowsByPrefab; }
/** Test-only: forget every prefab's record, and the open session's baseline, as a fresh editor process has none. */
export function _resetPrefabEditSessionRows(): void { sessionRowsByPrefab.clear(); editBaseline = null; }
/** Test-only: seat the open session's baseline as `openPrefabForEditing` does once its world is adopted. */
export function _seatEditBaselineForTest(guid: string, doc: PrefabFile): void { editBaseline = { guid, doc }; }

/** The document the open prefab-edit session was expanded from, or last saved as (#1692) — what its save is conditional
 *  on, and what it numbers rows from. Set by `openPrefabForEditing` and by each save that lands; never by another
 *  writer, which is the point: the editor cache follows every write, so it cannot answer "what did THIS edit open". */
let editBaseline: { guid: string; doc: PrefabFile } | null = null;
/** {@link editBaseline} for `guid`, or null when the session open is another prefab's (or none). */
export function editBaselineFor(guid: string): PrefabFile | null {
  return editBaseline?.guid === guid ? editBaseline.doc : null;
}

/** A server route rewrote the prefab this edit has open, from `prior` to `doc` (#1751: `/api/prefab-member-paths`,
 *  run inside an Apply or its undo made IN this edit world, whose live repair is already on screen). The one writer
 *  other than this session's own saves that moves the baseline — and only while the session is open, and only when the
 *  baseline still described `prior`. Otherwise the save was refused as "changed on disk" against a file that holds
 *  exactly what the edit world shows. A baseline that described something else stays: that is a real outside change,
 *  and the save must still refuse over it. True when it moved. */
export function adoptRewrittenEditBaseline(guid: string, prior: string, doc: PrefabFile): boolean {
  if (!editBaseline || editBaseline.guid !== guid || !isPrefabEditWorld() || useEditorStore.getState().editingPrefab?.guid !== guid) return false;
  if (!prefabTextIsDocument(prior, editBaseline.doc)) return false;
  editBaseline = { guid, doc: JSON.parse(JSON.stringify(doc)) as PrefabFile };
  return true;
}

/** What a prefab edit-mode save did: whether the file was written, and every prefab validation warning
 *  `warnInertPrefabSizes` reported for it (empty unless `saved`). */
export interface PrefabEditSaveReport {
  saved: boolean;
  /** The prefab validation warnings the write reported — and, when `saved` is FALSE, the reason the
   *  backend refused (#1468). It used to be documented as "empty unless `saved`"; the format gate
   *  made a failed save something a human can act on, so the failure now has somewhere to say why. */
  warnings: string[];
  /** The file changed on disk since this edit opened it (or last saved it), and was left as it is (#1692): nothing
   *  was written, and the edit is still open and unsaved. Saving again with `overwrite` replaces what is there. */
  conflict?: boolean;
}

/** How a prefab-edit save treats a file that changed on disk under the open edit (#1692). */
export interface PrefabEditSaveOptions {
  /** Replace what is on disk without asking — the deliberate choice after being told (the agent's `overwrite`). */
  overwrite?: boolean;
  /** Ask whether to replace it (the human's Cmd+S and Exit's Save). Absent and not `overwrite`: refuse. */
  confirmOverwrite?: (name: string, path: string) => Promise<boolean>;
}

/** Save the in-progress prefab edit back to its `.prefab.json`. Returns true on success — the
 *  human paths (Cmd+S, the toolbar) only need that. `savePrefabEditReport` is the same save with
 *  the warnings kept, for the agent `edit-save` op (#1258).
 *
 *  ⚠️ Deliberately a wrapper and not a signature change to an object: an object is always truthy,
 *  so a caller still written `if (!(await savePrefabEdit()))` would compile and never see a failure. */
export async function savePrefabEdit(): Promise<boolean> {
  return (await savePrefabEditReport()).saved;
}

/** Save the in-progress prefab edit back to its `.prefab.json`. Serializes the
 *  prefab subtree (scaffold lights/HDR are excluded — they aren't descendants of
 *  the root). */
export async function savePrefabEditReport(opts: PrefabEditSaveOptions = {}): Promise<PrefabEditSaveReport> {
  const NOT_SAVED: PrefabEditSaveReport = { saved: false, warnings: [] };
  const { editingPrefab } = useEditorStore.getState();
  if (!editingPrefab) return NOT_SAVED;
  // TRANSIENCE guard, the prefab twin of `saveScene`'s (serialize.ts). Only ever WRITE authored
  // data: while scrub/preview/play is live the world holds preview mutations (a posed skeleton, a
  // control-spawned prefab, physics-settled positions), and this serializes the prefab subtree
  // straight out of that world — so a save now bakes them into the .prefab.json, and every scene
  // instantiating it inherits the pose.
  //
  // It lives HERE, not in the callers, for the reason the same guard lives inside `saveScene`:
  // every caller inherits it and none can forget. It was in exactly one caller — the Cmd+S
  // handler's `!canEdit()` early return — which meant the AGENT path (`prefab edit-save`) never
  // had it at all, and deleting that early return in #259 (so parked asset docs could still flush
  // during preview) removed the human's too. One guard, both paths. `isWorldAuthored`, not the run
  // mode, for the same reason as `saveScene` (#1548): an exit reads 'stopped' before its restore lands.
  const notAuthored = whyWorldNotAuthored();
  // #1750 R1: another prefab's edit-open is in its tail — its edit world is on screen while the flag above still names
  // THIS prefab, so the save wrote that prefab's world into this one's file (#1747). Refused, with the reason in the
  // report so Cmd+S and the agent both say it.
  if (notAuthored === SCENE_SWITCH_LANDING) {
    console.warn(`[PrefabEdit] "${editingPrefab.name}" was not saved — ${SCENE_SWITCH_LANDING}`);
    return { saved: false, warnings: [`${SCENE_SWITCH_LANDING} — save again once it's open`] };
  }
  if (notAuthored) {
    console.error(
      `[PrefabEdit] cannot save "${editingPrefab.name}" — ${notAuthored}. ` +
      'Saving now would bake preview/play mutations (a posed rig, a spawned prefab) into the prefab ' +
      'file, and every scene that instantiates it would inherit them. Exit preview / stop first.',
    );
    return NOT_SAVED;
  }
  const serialized = serializePrefabEditWorld(editingPrefab.guid);
  if ('error' in serialized) { console.error(`[PrefabEdit] cannot save "${editingPrefab.name}" — ${serialized.error}`); return NOT_SAVED; }
  const { prefab, runtimeExcluded, rows } = serialized;
  // The version `prefab` represents, captured BEFORE the write. `commitPrefabWrite` is a real fetch
  // to the dev server, and the human keeps working during it — a bone drag or an agent op lands as
  // an ordinary `pushAction`. Re-reading the version after the await would fold that edit into the
  // saved baseline without it ever being written; see markSceneSaved's doc comment for why that is
  // data loss and not a cosmetic flag (#573).
  const savedAtEditVersion = getEditVersion();
  // An authoring write, so it reports an inert size (#42, #1251) — warnInertPrefabSizes says why
  // the call sits here and not in commitPrefabWrite.
  const warnings = warnInertPrefabSizes(prefab, editingPrefab.guid);
  if (runtimeExcluded > 0) warnings.push(runtimeExcludedMessage(runtimeExcluded));
  // ONE step (#1692): written only over the document this edit was opened from — or last saved as — which is the session's
  // own baseline (`editBaselineFor`): it moves only with this save's own writes. A file changed under the edit (an Apply
  // from a carried instance, an outside edit, a `git pull`) is not overwritten unasked: silently, that lost the other
  // change for good.
  // No baseline: in the editor it is seated in the same run as the open's adoption, so this is a test harness's edit world
  // built without `openPrefabForEditing` (and HMR of this module reloads the page, so its state cannot be lost under a
  // live session). The editor cache is then the last record there is — conditional on it, rather than refusing a save
  // no session could ever make.
  const expected = editBaselineFor(editingPrefab.guid) ?? getCachedPrefabSync(editingPrefab.guid);
  if (!expected) return { saved: false, warnings: ['this edit has no record of the prefab it opened — re-open it and try again'] };
  let wrote = await commitPrefabWrite(editingPrefab.guid, prefab, { expected, overwrite: opts.overwrite });
  if (!wrote.ok && wrote.conflict && !opts.overwrite && opts.confirmOverwrite
    && await opts.confirmOverwrite(editingPrefab.name, editingPrefab.path)) {
    wrote = await commitPrefabWrite(editingPrefab.guid, prefab, { expected, overwrite: true });
  }
  if (!wrote.ok && wrote.conflict) {
    return {
      saved: false, conflict: true,
      warnings: [`${editingPrefab.path} changed on disk since this edit opened it, so it was not overwritten — the edit is still open and unsaved`],
    };
  }
  // ⚠️ Carry the backend's REASON out (#1468). The owner's ruling is refuse-to-SAVE-never-to-LOAD,
  // so a build will open a prefab a newer build wrote, edit it and press Cmd+S — the gate answers
  // 409 and, until this, the human got a `{saved:false}` with nothing on it: the server's own error
  // goes to the dev-server terminal, not the editor console. Reported through `warnings`, which the
  // agent `edit-save` op already surfaces and the human paths already read.
  if (!wrote.ok) return { saved: false, warnings: wrote.error ? [wrote.error] : [] };
  // The file holds this edit now: the next save is conditional on it, and numbers its rows from it. (Both caches were
  // seated by the commit itself.)
  editBaseline = { guid: editingPrefab.guid, doc: JSON.parse(JSON.stringify(prefab)) as PrefabFile };
  // …and where it put each member added this session, so the next save keeps that row and its identity (#1662).
  noteSessionRows(editingPrefab.guid, rows, prefab);
  // ⚠️ Re-baseline the dirty tracker. Without this the prefab-edit world stayed "unsaved" FOREVER
  // after a successful save: `hasUnsavedChanges()` compares the live edit version against
  // `_savedAtEditVersion`, and every other write path (`saveScene`, `loadScene`, `newScene`) moves
  // that baseline while this one did not.
  //
  // Not cosmetic. `edit-open` and `load_scene` both REFUSE on unsaved changes, so a single prefab
  // save wedged the editor into needing `force` to go anywhere; the dirty indicator never cleared,
  // which teaches the human to ignore it; and an agent reading `unsavedChanges` concluded the file
  // was stale when it was byte-identical to the live world. Reported by the owner — "I think I
  // saved it before you said it's stale, maybe we have a bug" — and confirmed by diffing the file
  // against the world rather than by trusting the flag, which is the only way to see it.
  markSceneSaved(savedAtEditVersion);
  console.log(`[PrefabEdit] saved "${prefab.name}" (${prefab.entities.length} entities)`);
  return { saved: true, warnings };
}

/** The live prefab-edit world as the document of the prefab `guid` — what Save writes. `runtimeExcluded` counts
 *  the runtime-spawned entities it left out. An `error` says why there is no document, phrased to follow
 *  "cannot save …". It writes no file and changes no entity; it does merge the rows this world was built from into the
 *  prefab's save record (#1662), which a save then extends. */
export function serializePrefabEditWorld(guid: string): { prefab: PrefabFile; runtimeExcluded: number; rows: ReadonlyMap<string, number> } | { error: string } {
  const rootId = findPrefabEditRoot();
  if (!rootId) return { error: 'prefab root not found' };

  // The file as it was when we opened it — or last saved it (`editBaselineFor`; the editor cache follows every
  // writer, #1692, so it can hold a document this world was never expanded from). It supplies
  // the two things a re-save must NOT re-derive from the live world: the existing localId
  // numbering, and the asset's own name. Refuse rather than fall back to renumbering — a
  // silent renumber drops every localId-keyed override in every scene that instantiates this
  // prefab, which is precisely the damage this path exists to avoid.
  // Outside a session (a harness serializing an edit world it built itself — see the save's same fallback), the editor
  // cache is the only record.
  const previous = editBaselineFor(guid) ?? getCachedPrefabSync(guid);
  if (!previous) {
    return {
      error: 'this edit has no record of the prefab it ' +
        'opened, so its localId numbering cannot be preserved. Saving now would renumber ' +
        'members and break every scene override keyed to them. Re-open the prefab and try again.',
    };
  }

  // A prefab containing a UIScrollView spawns pooled rows INSIDE the prefab-edit world (the pool
  // runs while stopped), so this save legitimately drops them — and says so, because this path
  // already has a `warnings` array the agent op surfaces and a console nobody reads (review F4).
  let runtimeExcluded = 0;
  let rowsById: ReadonlyMap<number, number> = new Map();
  const world = getCurrentWorld();
  const session = sessionRowsFor(world, guid, previous);
  const preservedLocalIds = collectPreservedLocalIds(previous.rootLocalId, rootId, guid, previous);
  // …and the node identity each of those rows already had (#1468). The edit world holds the document
  // as PLAIN entities with no prefab link, so the baseline file is the only thing that still knows
  // which row a given live entity is; without this every node would be re-minted on every Cmd+S, and
  // an identity that changes on each save is worse than none. A row of a pre-v5 document has no guid
  // to keep and is simply absent here, so the save mints it one — which is how a file migrates
  // (#1468 design record: on next save, never on load).
  const nodeGuidByLocalId = new Map(previous.entities.map((e) => [e.localId, e.nodeGuid ?? '']));
  const preserveNodeGuids = new Map<number, string>();
  const eaMeta = getTraitByName('EntityAttributes');
  const guidOf = new Map<number, string>();
  if (eaMeta) world.query(eaMeta.trait).updateEach(([ea], e) => { guidOf.set(e.id(), ((ea as { guid?: string }).guid) ?? ''); });
  for (const [ecsId, localId] of preservedLocalIds) {
    // The last save's row at that number; for a row that save no longer had (deleted since, and back by an undo), the
    // identity an earlier save of this session wrote it with (#1662).
    let g = nodeGuidByLocalId.get(localId);
    if (!g) {
      const row = session.rows.get(guidOf.get(ecsId) ?? '');
      if (row?.localId === localId) g = row.nodeGuid;
    }
    if (g) preserveNodeGuids.set(ecsId, g);
  }
  // A placeholder for a reference ROW whose prefab the load could not expand (#1699): the edit world holds nothing of
  // its frame, so the row is written from the file as read, the baseline, where only a capture could otherwise have
  // stood. The edit world's own entry for it went through `editWorldRefs`, so it is not the file's form.
  const unresolvedRows = new Map<number, PrefabEntity>();
  for (const e of world.entities as Iterable<Parameters<typeof unresolvedRefOf>[0] & { id(): number }>) {
    const ref = unresolvedRefOf(e);
    if (!ref) continue;
    // An added reference NODE whose prefab is missing: a template's own key node, or a pasted scene one. The template
    // capture leaves it out (`captureChild`), and the prefab-edit save has no baseline for a node, so writing on would
    // drop it and its edits silently. REFUSED, until the prefab resolves (#1738, owner ruling: refuse with a reason
    // rather than write a node the save cannot place). Writing it back would need the file's node matched in the same
    // frame, wherever a template node can hang (a row's `added`, a member row's, a plain node's `children`, a
    // `nestedStructure` slot) — the design fork #1738 member 2 left for later.
    // The reason says which prefab is missing and what is safe: a node the FILE declares (it has a template key) is
    // still on disk; a pasted one exists only in this edit.
    if (ref.kind === 'node') {
      const name = (ref.record.name as string | undefined) || 'a node';
      const missing = resolveRef(ref.source) ?? ref.source;
      const onDisk = typeof ref.record.key === 'string' && !!ref.record.key;
      return { error: onDisk
        ? `"${name}" references the prefab ${missing}, which is missing or has no root, so this save cannot write it. The prefab file on disk still has it unchanged. Restore that prefab and save again, or delete "${name}" to save without it`
        : `"${name}" is a pasted reference to the prefab ${missing}, which is missing or has no root, so this save cannot write it, and it exists only in this edit. Restore that prefab and save again, or delete "${name}" to save without it` };
    }
    const localId = preservedLocalIds.get(e.id());
    const row = localId === undefined ? undefined : previous.entities.find((r) => r.localId === localId && r.prefab === ref.source);
    if (row) { unresolvedRows.set(e.id(), structuredClone(row)); continue; }
    // A COPY (a duplicate or a paste) has no row of its own in the file. Its record is the edit world's entry, which
    // names a member of this prefab by this edit's ids, not by a member token, wherever `editWorldRefs` rewrote one. So
    // it is written as the row only when nothing in it was rewritten; otherwise the save refuses, as it does over any
    // row it cannot write truthfully.
    // A record copied from a SCENE (a paste of a scene placeholder) states member guids, which a template never holds
    // (I8, #1293: every instance would stamp one guid on its member), so any stated guid is refused as well.
    const channels = channelsOf(ref.record);
    const text = JSON.stringify(channels);
    if (text.includes(PREFAB_EDIT_LOCAL_GUID_PREFIX) || text.includes(PREFAB_EDIT_ROOT_GUID) || /"guid":"[^"]/.test(text)) {
      const name = (ref.record.name as string | undefined) || 'a copy';
      return { error: `"${name}" is a copy of a reference to a missing prefab whose edits carry identities a template cannot hold, and they cannot be written until that prefab resolves. Restore it, or delete the copy` };
    }
    unresolvedRows.set(e.id(), { localId: 0, name: '', prefab: ref.source, traits: {}, ...channels } as PrefabEntity);
  }
  const prefab = serializePrefab(rootId, guid, {
    unresolvedRows,
    preserveLocalIds: preservedLocalIds,
    preserveNodeGuids,
    name: previous.name,
    // A row the prefab's own move placed under a nested member keeps its original row parent (#1437).
    rowParents: new Map(previous.entities.map((e) => [e.localId, ((e.traits.EntityAttributes as { parentId?: number } | undefined)?.parentId) ?? 0])),
    onRuntimeExcluded: (n) => { runtimeExcluded = n; },
    onRows: (r) => { rowsById = r; },
    localIdFloor: session.floor,
  });
  // By guid, read NOW: the save records it only after its write's await, when an ecs id may name another entity.
  const rows = new Map<string, number>();
  for (const [ecsId, localId] of rowsById) {
    const g = durableGuid(guidOf.get(ecsId));
    if (g && g !== PREFAB_EDIT_ROOT_GUID) rows.set(g, localId);
  }
  if (!prefab) return { error: 'serialize produced no prefab' };
  // The last line under the numbering above: a document with two rows at one localId is refused, never written. Every
  // scene key naming that number would silently pick one of them.
  const seen = new Set<number>();
  const twice = prefab.entities.find((e) => (seen.has(e.localId) ? true : (seen.add(e.localId), false)));
  if (twice) return { error: `two rows would share localId ${twice.localId} ("${twice.name}"), so a scene override keyed to it could land on either` };
  return { prefab, runtimeExcluded, rows };
}

/** Leave prefab-edit mode: reload the scene the prefab was opened from — that
 *  re-instantiates every instance from the now-saved prefab file — then clear the
 *  edit-mode state. Falls back to the last-opened scene when there is no return
 *  path (entering prefab-edit from a project with no scene loaded).
 *
 *  Returns the scene path we returned to, or null when there was nothing to go
 *  back to (the store flag is cleared either way, so the editor is never left
 *  stuck in a prefab-edit mode with no prefab world). */
export async function exitPrefabEditing(): Promise<string | null> {
  const target = returnSceneTarget();
  const since = adoptionCount();
  if (target) await loadScene(target);
  // The flag is the adoption owner's to write (#1690, Exit variant). A world adopted since Exit began — the scene its
  // load landed, or an edit world another route opened in that load's tail — already owns it: the first cleared it and
  // recorded this prefab's repair, and the second must keep its own session. With no adoption since — no return scene,
  // or a load that installed nothing — the session ends here, in place, and owes its repair here. Judged by adoption,
  // not by the outcome: a load superseded by one that then failed reads 'superseded' and still adopted.
  await endPrefabEditInPlace(since);
  return target;
}

/** The scene an Exit from the current prefab edit would reload, or null for none: the one choice `exitPrefabEditing`
 *  makes, for anything that reports it ahead of the Exit. The agent edit-open's reply is one (#1806): it answered with the
 *  path current BEFORE the open, which is null inside another prefab's edit world, while this session's Exit went back
 *  to the scene the first open banked. */
export function returnSceneTarget(): string | null {
  const { prefabReturnScenePath } = useEditorStore.getState();
  // #478: was the UNSCOPED `modoki-last-scene` key — global across every project sharing this
  // origin, so a boot with no scene loaded still held the PREVIOUS project's path and this would
  // try to load it (a cross-project path that resolves to nothing). Read the same per-project key
  // `setCurrentScenePath` writes (scene/serialize.ts) instead.
  const stored = typeof localStorage !== 'undefined'
    ? localStorage.getItem(lastSceneKey(getScenePersistenceProject()))
    : null;
  // ⚠️ A synthetic `/__prefab-edit__/…` path is not a FILE — loading it 404s ("no asset at … the
  // dev server answered with index.html") and strands the editor in the prefab world with no scene.
  // `resolveReturnScene` keeps one out of the store in the first place; this skips it whichever
  // candidate carries it, so the fallback can never reintroduce the same dead end.
  return [prefabReturnScenePath, stored]
    .find((p): p is string => !!p && !p.startsWith(PREFAB_EDIT_SCENE_PREFIX)) ?? null;
}

/** True when the editor is currently in prefab-edit mode.
 *
 *  Ground truth is the LIVE scene being the synthetic prefab-edit world, not just
 *  the `editingPrefab` store flag — the flag can go stale if we return to a real
 *  scene without an explicit exit (e.g. a hot-reload-driven scene swap). A stale
 *  flag is dangerous: it routes Cmd+S to savePrefabEdit, which then can't find the
 *  prefab-edit root in the real world and errors ("prefab root not found"). When
 *  we detect the mismatch we self-heal by clearing the flag and report not-editing,
 *  so the save falls through to the normal scene save. */
export function isEditingPrefab(): boolean {
  if (useEditorStore.getState().editingPrefab === null) return false;
  if (isPrefabEditWorld()) return true;
  useEditorStore.getState().closePrefabEditor(); // stale flag — clear it
  return false;
}

// Dev-only debug handle so tooling can drive prefab-edit mode without the UI.
if (import.meta.env?.DEV && typeof window !== 'undefined') {
  (window as unknown as { __prefabEdit?: unknown }).__prefabEdit = { openPrefabForEditing, savePrefabEdit, exitPrefabEditing, isEditingPrefab };
}

/** The prefab fuzzer's editor harness (#1789): one real editor, a fixture per run, the watcher, and the world readers
 *  the ops and checks share.
 *
 *  REAL, not stood in for: the backend router (`backend.ts`), `SceneManager.loadScene`, both prefab caches, the asset
 *  manifest, the undo stack, the adoption owner, and the watcher's scene-changed handler (`initAgentBridge` over a
 *  stubbed Electron bridge). The test file installs the globals this needs (`fetch`, `window`, `localStorage`) BEFORE
 *  importing this module; see its header for what stays harness-blind. */

import {
  getAllEntities, getAllTraits, getTraitByName, readTraitData, findEntity, getCurrentWorld, setRunMode,
} from '@modoki/engine/runtime';
import { setActionCallback, pushAction } from '@modoki/engine/editor';
import { registerAllTraits } from '../../../app/ecs/registerTraits';
import { runAgentOp, initAgentBridge, peekSuppressedSceneReloads, releaseOutsideChanges } from '../../../app/debug/agentBridge';
import { registerEditorAgentOps } from '../../../app/editor/agentEditorOps';
import { registerAsset, clearManifest } from '../../../packages/modoki/src/runtime/loaders/assetManifest';
import { loadSceneReporting, saveScene } from '../../../packages/modoki/src/editor/scene/serialize';
import { installEditorPrefabCacheWarm } from '../../../packages/modoki/src/editor/scene/prefabCacheWarm';
import { clearDirtyAssets } from '../../../packages/modoki/src/editor/scene/dirtyAssets';
import { _resetHistoryContexts, activeHistoryKey, rekeyUntitledHistory, undoStepPending, breakUndoCoalescing } from '../../../packages/modoki/src/editor/undo/undoManager';
import { _resetSceneAdoptionForTests, adoptionsSettled } from '../../../packages/modoki/src/editor/scene/sceneAdoption';
import { isWorldReplacementInFlight } from '../../../packages/modoki/src/editor/scene/authoringSettle';
import { _resetPrefabEditSessionRows, isEditingPrefab } from '../../../packages/modoki/src/editor/scene/prefabEdit';
import { useEditorStore } from '../../../packages/modoki/src/editor/store/editorStore';
import { clearKeptMemberOrphans } from '../../../packages/modoki/src/runtime/loaders/loadSceneFile';
import { clearReservedLocalIds } from '../../../packages/modoki/src/runtime/core/localIdCounter';
import { getOverrideMarkSet } from '../../../packages/modoki/src/runtime/loaders/overrideMarks';
import { unresolvedRefOf } from '../../../packages/modoki/src/runtime/core/unresolvedPrefabRef';
import { REF_FIELDS_BY_TRAIT } from '../../../packages/modoki/src/runtime/loaders/sceneValidation';
import { SCENE_FORMAT_VERSION } from '../../../packages/modoki/src/runtime/core/version';
import { notifyListeners } from '../../../packages/modoki/src/runtime/core/notifyListeners';
import { frameRootDoc } from '../../../packages/modoki/src/runtime/core/ecs/identityParents';
import { templateKeyOf } from '../../../packages/modoki/src/runtime/core/templateIdentity';
import { ROOT_URL, type FuzzBackend } from './backend';
import { classifyJsonAssetPath } from '../../../packages/modoki/src/runtime/loaders/assetTypeClassifier';
import { fingerprintBytes, EDITOR_DELETE_FINGERPRINT } from '../../../plugins/editorWriteGuard';

type Handler = (data: unknown) => void;

/** The Electron bridge the watcher handler listens on, stubbed: `emit` is the main process's `send`. */
export const bridge = {
  handlers: new Map<string, Handler[]>(),
  on(event: string, cb: Handler) { bridge.handlers.set(event, [...(bridge.handlers.get(event) ?? []), cb]); },
  send() {},
  // Through the shared fan-out (#888): a handler that throws is reported on console.error, which fails the step.
  emit(event: string, data: unknown) { notifyListeners(bridge.handlers.get(event) ?? [], 'fuzz bridge', [data]); },
};

/** A Map-backed `localStorage`: `setCurrentScenePath` writes the last scene, and leaving prefab edit reads it back. */
export function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); }, clear: () => m.clear(), key: (i: number) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}

let booted = false;
/** Once per process: what the editor's boot does (traits, agent ops and their hooks, the cache warm, the bridge). */
export function boot(be: FuzzBackend): void {
  if (booted) return;
  booted = true;
  registerAllTraits();
  setActionCallback(pushAction);
  registerEditorAgentOps();
  installEditorPrefabCacheWarm();
  be.relay = (op, params) => runAgentOp(op, params);
  initAgentBridge();
  installSeededUuids();
}

// ── Per-run identity ─────────────────────────────────────────────────────────────────────────────────────────────

/** Every run gets its own guids and paths, so no cache entry, parked history or kept record from an earlier run can
 *  answer for this one (nothing resets the two prefab caches). The run's TAG is a hash of its op list plus how many
 *  times this process has run that list before: the first run of any list gets the same tag in every process, so a
 *  replay (`MODOKI_PREFAB_FUZZ_REPLAY`, a fresh process) is the run that failed, guid for guid. A process-wide counter
 *  gave the same list a different tag, and so different derived guids and guid tie-breaks, on every replay (review). */
let runCounter = 0;
const occurrences = new Map<string, number>();
const hex = (n: number, w: number) => n.toString(16).padStart(w, '0');
let runTag = 0;
let uuidCounter = 0;

/** FNV-1a over the list's JSON (32 bits), then its occurrence in the low 16: twelve hex digits, a guid's last group. */
export function tagFor(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0;
  const n = occurrences.get(key) ?? 0;
  occurrences.set(key, n + 1);
  return h * 0x10000 + (n & 0xffff);
}

/** `crypto.randomUUID` (every `newGuid`) as a per-run sequence: a counter in the FIRST group, the run's tag in the last.
 *  Deterministic per run, unique across runs, and a guid tie-break between a minted guid and a fixture guid (whose
 *  first groups are fixed) orders the same way on every replay. */
export function installSeededUuids(): void {
  const c = globalThis.crypto as unknown as { randomUUID: () => string };
  c.randomUUID = () => `${hex(0x10000000 + uuidCounter++, 8)}-0000-4000-8000-${hex(runTag, 12)}`;
}

export interface Fixture {
  run: number;
  /** This run's own folder: paths are per run too, since both caches and the manifest also key by path. */
  root: string;
  scenePath: string;
  sceneGuid: string;
  /** name → { guid, path } for the four fixture prefabs. */
  prefabs: Record<'Q' | 'P' | 'O' | 'H', { guid: string; path: string }>;
}

/** #1707's fixture (expansionTwinParity.test.ts), fresh guids per run: Q: QR → M. P: R → A → B and R → C, a row
 *  expanding Q whose overrides move M and whose member row states M.z. O: OR → N, a row expanding P that states
 *  something through every channel a template row carries, M.z among them through the legacy carrier (#1880 T1). H: one entity, the host a scene-added reference node hangs under. */
function fixtureDocs(f: Fixture, g: (k: number) => string) {
  const { Q, P, O, H } = f.prefabs;
  const row = (localId: number, name: string, parentId: number, nodeGuid: string, x = 0) => ({
    localId, name, nodeGuid, traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x, y: 0, z: 0 } },
  });
  const [gQR, gM, gR, gA, gB, gC, gOR, gN, gHR] = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(g);
  return {
    Q: { id: Q.guid, version: 5, name: 'Q', rootLocalId: 1, entities: [row(1, 'QR', 0, gQR), row(2, 'M', 1, gM, 1)] },
    P: { id: P.guid, version: 5, name: 'P', rootLocalId: 1, entities: [
      row(1, 'R', 0, gR), row(2, 'A', 1, gA, 2), row(3, 'B', 2, gB, 3),
      { localId: 4, name: 'C', nodeGuid: gC, prefab: Q.guid, traits: { EntityAttributes: { name: 'C', parentId: 1, guid: '' } },
        overrides: { 2: { Transform: { x: 4 } } },
        // M.z through a member ROW, the inner layer. O's row N states the same field through the legacy carrier, the outer
        // layer (#1880 T1: one field in two layers through both carriers, #1877 3b S4's shape). Outermost wins: 7 in O.
        members: { [`/${gM}`]: { traits: { Transform: { z: 9 } } } } },
    ] },
    O: { id: O.guid, version: 6, name: 'O', rootLocalId: 1, entities: [
      row(1, 'OR', 0, gOR),
      {
        localId: 2, name: 'N', nodeGuid: gN, prefab: P.guid, traits: { EntityAttributes: { name: 'N', parentId: 1, guid: '' } },
        overrides: { 2: { Transform: { y: 5 }, Rotate3D: { axis: 'y', speed: 2 } } },
        removedTraits: { 3: ['Transform'] },
        added: [{ parentLocalId: 2, guid: '', key: 'k-extra', name: 'Extra', traits: { EntityAttributes: { name: 'Extra', parentId: 0 }, Transform: { x: 6, y: 0, z: 0 } }, children: [] }],
        nestedOverrides: { 4: { 2: { Transform: { z: 7 } } } },
        members: { [`/${gC}/${gM}`]: { traits: { Transform: { y: 8 } } } },
      },
    ] },
    H: { id: H.guid, version: 5, name: 'H', rootLocalId: 1, entities: [row(1, 'HR', 0, gHR)] },
  };
}

export function newFixture(tag12: number): Fixture {
  const run = ++runCounter;
  const tag = hex(tag12, 12);
  const pg = (k: number) => `cccccccc-0000-4000-8${hex(k, 3)}-${tag}`;
  const root = `${ROOT_URL}/r${tag}`;
  const prefabs = {
    Q: { guid: pg(1), path: `${root}/prefabs/Q.prefab.json` },
    P: { guid: pg(2), path: `${root}/prefabs/P.prefab.json` },
    O: { guid: pg(3), path: `${root}/prefabs/O.prefab.json` },
    H: { guid: pg(4), path: `${root}/prefabs/H.prefab.json` },
  };
  return { run, root, scenePath: `${root}/scenes/Fuzz.json`, sceneGuid: `dddddddd-0000-4000-8000-${tag}`, prefabs };
}

// ── Settling ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Is anything still landing: an undo step or prefab write, a scene switch, a world replacement, a deferred reload? */
function busy(): string | null {
  if (undoStepPending() !== null) return 'an undo step or prefab write';
  if (adoptionsSettled() !== null) return 'a scene adoption';
  if (isWorldReplacementInFlight()) return 'a world replacement';
  if (peekSuppressedSceneReloads().length) return `deferred reloads ${peekSuppressedSceneReloads().join(', ')}`;
  return null;
}

/** Wait until nothing is landing, by event-loop turns, never by the clock: the backend is in-process and synchronous
 *  on disk, so everything an op started finishes within a bounded number of turns. Throws when it does not, which is a
 *  finding (a hang), not a timeout. */
export async function settle(maxTurns = 400): Promise<void> {
  let quiet = 0;
  let last: string | null = null;
  for (let i = 0; i < maxTurns; i++) {
    await new Promise<void>((r) => setImmediate(r));
    last = busy();
    quiet = last ? 0 : quiet + 1;
    if (quiet >= 3) return;
  }
  throw new Error(`harness: the editor never settled (${last ?? 'unknown'} still landing after ${maxTurns} turns)`);
}

// ── The watcher ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Is a change to a MARKED file the editor's own? As the host guard's `check` decides it (editorWriteGuard.ts, #1744,
 *  POSIX): a mark vouches for the bytes it hashed; a mark with no hash is TTL-only, and every flush here is inside the TTL;
 *  an absent file (`now` undefined) is the editor's only under its delete mark — a write-marked file gone is an outside
 *  delete. Keyed by path alone, an op's own save swallowed an outside write after it in the same op (#2009). */
export function editorOwns(mark: string | null, now: string | undefined): boolean {
  return mark === null || (now === undefined ? mark === EDITOR_DELETE_FINGERPRINT : mark === fingerprintBytes(now));
}

/** What the host's watcher does after a batch of file events (`vite-asset-scanner.ts`'s `flushPending`): rebuild the
 *  manifest and push it, then send `scene-changed` for each changed scene or prefab file that is NOT the editor's own
 *  write. Returns the files that raised a reload. */
export async function flushWatcher(be: FuzzBackend, before: Map<string, string>): Promise<string[]> {
  const after = be.snapshot();
  const changed: string[] = [];
  for (const [url, text] of after) if (before.get(url) !== text) changed.push(url);
  for (const url of before.keys()) if (!after.has(url)) changed.push(url);
  if (changed.length === 0) { be.marked.clear(); return []; }
  const assets: { guid: string; path: string; type: string }[] = [];
  for (const [url, text] of after) {
    if (!url.endsWith('.json')) continue;
    try {
      const id = (JSON.parse(text) as { id?: string }).id;
      if (id) assets.push({ guid: id, path: url, type: classifyJsonAssetPath(url) ?? 'scene' });
    } catch { /* unreadable: the host's scan skips it too */ }
  }
  bridge.emit('manifest-updated', { assets });
  const raised: string[] = [];
  for (const url of changed.sort()) {
    if (be.marked.has(url) && editorOwns(be.marked.get(url)!, after.get(url))) continue;
    raised.push(url);
    // Typed as the host's watcher types it (`classifySceneChange`, over the same classifier), so a particle or material
    // change reaches the asset branch (#1879 review 2, #6); the fuzzer itself only writes scenes and prefabs.
    bridge.emit('scene-changed', { urlPath: url, kind: classifyJsonAssetPath(url) ?? 'scene' });
  }
  be.marked.clear();
  // The watcher only HOLDS a change (#1879); the editor applies the batch on a focus gain or `modoki_refresh`, which is
  // this call. At once, as a refresh from an unfocused editor does: the fuzzer judges what a change does, not when.
  await releaseOutsideChanges();
  await settle();
  return raised;
}

// ── A run's start ────────────────────────────────────────────────────────────────────────────────────────────────

/** Reset what outlives a world (history, adoption, prefab edit, kept orphans, the manifest), write the fixture to a
 *  fresh disk and open its scene through the real load. The scene holds O (with an own edit on a nested member), P,
 *  H and a plain parent with a child. `setupNest` is the fixture's last step, run through the real instantiate: Q
 *  dropped under H's root, a scene-added reference node. */
export async function startRun(be: FuzzBackend, setupNest: (f: Fixture) => Promise<void>, key: string): Promise<Fixture> {
  setRunMode('stopped');
  _resetHistoryContexts();
  _resetSceneAdoptionForTests();
  _resetPrefabEditSessionRows();
  clearDirtyAssets(); // a document an undo parked (#1868) belongs to its own run
  clearKeptMemberOrphans();
  clearReservedLocalIds(); // #1933 S5: a replayed key reuses the fixture's guids
  useEditorStore.setState({ editingPrefab: null, showToast: () => {} } as never);
  be.reset();
  clearManifest();
  runTag = tagFor(key);
  uuidCounter = 0;
  const f = newFixture(runTag);
  const tag = hex(runTag, 12);
  const docs = fixtureDocs(f, (k) => `eeeeeeee-0000-4000-8${hex(k, 3)}-${tag}`);
  for (const k of ['Q', 'P', 'O', 'H'] as const) {
    be.write(f.prefabs[k].path, `${JSON.stringify(docs[k], null, 2)}\n`);
    registerAsset(f.prefabs[k].guid, f.prefabs[k].path, 'prefab');
  }
  const rg = (k: number) => `ffffffff-0000-4000-8${hex(k, 3)}-${tag}`;
  const tf = { x: 0, y: 0, z: 0 };
  const scene = {
    id: f.sceneGuid, version: SCENE_FORMAT_VERSION, name: 'Fuzz', createdAt: '2026-01-01T00:00:00.000Z', resources: [],
    entities: [
      { id: 1, prefab: f.prefabs.O.guid, guid: rg(1), traits: { EntityAttributes: { name: 'O1', parentId: 0 }, Transform: tf } },
      { id: 2, prefab: f.prefabs.P.guid, guid: rg(2), traits: { EntityAttributes: { name: 'P1', parentId: 0 }, Transform: { x: 3, y: 0, z: 0 } } },
      { id: 3, prefab: f.prefabs.H.guid, guid: rg(3), traits: { EntityAttributes: { name: 'H1', parentId: 0 }, Transform: tf } },
      { id: 4, traits: { EntityAttributes: { name: 'Plain', parentId: 0, guid: rg(4) }, Transform: tf } },
      { id: 5, traits: { EntityAttributes: { name: 'Leaf', parentId: 4, guid: rg(5) }, Transform: { x: 1, y: 0, z: 0 } } },
    ],
  };
  be.write(f.scenePath, `${JSON.stringify(scene, null, 2)}\n`);
  registerAsset(f.sceneGuid, f.scenePath, 'scene');
  be.marked.clear();
  const first = await loadSceneReporting(f.scenePath);
  if (first.outcome !== 'loaded') throw new Error(`harness: the fixture scene did not load (${first.outcome})`);
  await settle();
  await setupNest(f);
  const saved = await saveScene({ allowDialog: false });
  if (!saved.saved) throw new Error(`harness: the fixture scene did not save (${saved.reason})`);
  const again = await loadSceneReporting(f.scenePath);
  if (again.outcome !== 'loaded') throw new Error(`harness: the fixture scene did not reload (${again.outcome})`);
  await settle();
  // Empty the stacks but keep them named for the loaded scene, as production's are: left under '' the first adopt
  // (a reload, leaving prefab edit) swapped them out for the scene's empty stack, so no run undid across one.
  const historyKey = activeHistoryKey();
  _resetHistoryContexts();
  rekeyUntitledHistory(historyKey);
  breakUndoCoalescing();
  be.marked.clear();
  return f;
}

// ── World readers ────────────────────────────────────────────────────────────────────────────────────────────────

export interface PI { source: string; localId: number; nodeGuid: string; rootInstanceId: number }

export function piOf(id: number): PI | undefined {
  const meta = getTraitByName('PrefabInstance');
  return meta ? (readTraitData(id, meta) as unknown as PI | null) ?? undefined : undefined;
}

/** Authored entities (no resources), in id order: the candidate pool every op draws its target from. */
export function authored() {
  return getAllEntities().filter((e) => !e.isResource).sort((a, b) => a.id - b.id);
}

export const isInstanceRoot = (id: number) => { const pi = piOf(id); return !!pi && pi.rootInstanceId === id; };

export function editing(): boolean { return isEditingPrefab(); }

/** The guids of the live Missing Prefab placeholders (I18). Read off the marker itself: `UnresolvedPrefabRef` is not a
 *  registered trait, so `getAllEntities().traits` never lists it. */
export function placeholderGuids(): Set<string> {
  return new Set(getAllEntities().filter((e) => e.guid && unresolvedRefOf(findEntity(e.id) as never)).map((e) => e.guid!));
}

const GUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** The guids a live Missing Prefab placeholder's RECORD holds (the nodes the scene added under it, its rows) that name no
 *  live entity: what a respawn as a placeholder took in instead of spawning. A delete's undo does that in the SAME world
 *  (hunt seed 6356): a scene entity moved under an instance of a trashed prefab comes back inside the placeholder's
 *  record, not live, so the stack's entries recorded against it refuse (owner ruling R). */
export function swallowedGuids(): Set<string> {
  const all = getAllEntities();
  const live = new Set(all.map((e) => e.guid).filter(Boolean));
  const out = new Set<string>();
  for (const e of all) {
    const ref = e.guid ? unresolvedRefOf(findEntity(e.id) as never) : undefined;
    for (const g of ref ? JSON.stringify(ref.record).match(GUID_RE) ?? [] : []) if (!live.has(g)) out.add(g);
  }
  return out;
}

/** Every nested row a live frame's record says its expansion could NOT expand (#1790 ruling D, #1812: the child prefab
 *  was not there to expand), keyed `<frame root guid>:<localId>`. A world swap that adds one has dropped the rows that
 *  nested frame held, as the loader does by design when the prefab is gone (#1849). */
export function unexpandedRows(): Set<string> {
  const out = new Set<string>();
  const world = getCurrentWorld();
  for (const e of getAllEntities()) {
    const handle = e.guid ? findEntity(e.id) : null;
    const rec = handle ? frameRootDoc(world, handle) : undefined;
    for (const localId of rec?.unexpanded ?? []) out.add(`${e.guid}:${localId}`);
  }
  return out;
}

/** The world as a tree, keyed by guid: each entity's parent guid, sibling order, every trait's data (ECS ids read as
 *  guids), its override marks and its unresolved-prefab record. #1707's `tree()` plus the marks and the record. */
export function worldTree(): Record<string, unknown> {
  const all = getAllEntities().filter((e) => !e.isResource);
  const guidOf = new Map(all.map((e) => [e.id, e.guid || `<no guid: ${e.name}#${e.id}>`]));
  const out: Record<string, unknown> = {};
  for (const e of all) {
    const traits: Record<string, unknown> = {};
    for (const meta of getAllTraits()) {
      if (!e.traits.includes(meta.name)) continue;
      const data = readTraitData(e.id, meta);
      if (!data) { traits[meta.name] = true; continue; }
      const d = { ...(data as Record<string, unknown>) };
      if (meta.name === 'EntityAttributes') d.parentId = guidOf.get(d.parentId as number) ?? 0;
      if (meta.name === 'PrefabInstance') {
        d.rootInstanceId = guidOf.get(d.rootInstanceId as number) ?? 0;
        // A moved owned root's `ownerGuid` link is kept across an undo that puts it home (entityActions.ts, "Kept across
        // the undo"), is never serialized, and reads '' after a reload; `ownerOf` resolves the same owner either way. The
        // owner the entity hangs under is already in the tree as its parent.
        delete d.ownerGuid;
      }
      traits[meta.name] = d;
    }
    const ent = findEntity(e.id);
    // Only a member's marks mean anything (the save and the listing read them); a detached entity keeps its old marks
    // in memory and a reload drops them, which no reader can see.
    // Likewise a mark on a component the entity no longer has (added, then removed).
    // And a mark on a BLANK asset ref: the prefab writer drops `''` refs by design (a load reads '' and absent alike), so
    // a reload can never re-seed it, and no reader (the save, the listing) sees it (#1789's hunt, seed 1126).
    const blankRef = (m: string) => {
      const [trait, field] = m.split('.');
      if (!REF_FIELDS_BY_TRAIT[trait]?.includes(field)) return false;
      const meta = getTraitByName(trait);
      return !!meta && (readTraitData(e.id, meta) as Record<string, unknown> | null)?.[field] === '';
    };
    const marks = ent && e.traits.includes('PrefabInstance')
      ? [...(getOverrideMarkSet(ent as never) ?? [])].filter((m) => e.traits.includes(m.split('.')[0]) && !blankRef(m)).sort()
      : [];
    const unresolved = ent ? unresolvedRefOf(ent as never) : undefined;
    // A node's template key (`TemplateAddedKey`, #1809): not a registered trait, so the walk above never lists it, and a
    // reload or a rebuild that lost or re-minted one read as identical (#1877's fuzz blind spots, #1880 T1). A guid is
    // derived FROM the key, so a key change often shows as a guid change too, but not under a pinned guid.
    const templateKey = ent ? templateKeyOf(ent as never) : '';
    const key = guidOf.get(e.id)!;
    // A placeholder is compared by the prefab it names. Its record's FORM follows where it sits (a scene entry, or a node
    // under a parent), so a reparent legitimately turns one into the other; the byte-identity of a second save is what
    // holds the record's content.
    out[out[key] ? `${key}#dup${e.id}` : key] = { traits, marks, ...(templateKey ? { templateKey } : {}), ...(unresolved ? { unresolved: unresolved.source } : {}) };
  }
  return out;
}

export { getCurrentWorld };

/**
 * `projectInstance`: an instance's prefab chain plus its override list → its live entities (#2001 S5, #2028).
 *
 * Rule 2 (docs/prefabs.md § High-level rules): an instance IS its prefab plus its list, and ONE function builds the live
 * entities from the two. This is that function: the pure fold (`foldInstance`) says what the instance is, and realize
 * spawns it. Design: docs/plans/prefab-instance-model.md § 3.1, as amended by § 10 (binding; § 10.1 and § 10.4b for S5).
 *
 * ── What realize writes, and why each piece is here ──
 * - The nodes the fold names, each with its components as folded, under the parent the fold settles (a scene guid the
 *   fold cannot judge is realize's: the node stays at its row when the guid names nothing, § 10.4b).
 * - `PrefabInstance` on every node a document row supplies (the frame's source, the row's localId and identity, the frame
 *   root's id; a nested row's root also its row in the outer document), and `TemplateAddedKey` on a template-added node,
 *   exactly as the old spawner stamped them: every identity walk (`identityParents.ts`) and the old capture read them.
 * - A Missing/Damaged Prefab placeholder per frame the fold could not open (rule 9): a template reference node's carries
 *   its node as before (`spawnUnresolvedReference`); a nested ROW's is new (ruling D, the S2 oracle's measured change)
 *   and carries no record, since the row is its document's and every record about the frame stays in the list.
 * - The scene-owned nodes the list links, under their anchors, from the parse's content (`ownContent`): scene data,
 *   spawned as the old structure apply spawned it (a nested instance among them is a record of its own).
 * - Moves last, through the load's after-derive queue: a member's guid derives at its ROW (#1437), so it is spawned there
 *   and moved once every guid exists, and a removed row it sat under (`FoldedInstance.transit`) goes after the moves.
 *
 * ── The compatibility adapter (§ 10.1; deleted with the old stores in S8) ──
 * The old save still runs until S6, and reads stores today's spawner fed. Realize feeds them from the projection:
 * override marks from the list's own field records (`markRecords`), each frame's document record with the rows it could
 * not expand (`noteFrameDoc`, whose `unexpanded` the capture reads to tell an unexpanded row from a removed one), the
 * template-key candidates (`noteTemplateDoc`), a template reference node's own moves (`noteNodeMoves`), and the member-
 * token frames the derive resolves (`registerTemplateFrame`). The kept stores, pins and derived guids stay the settle's
 * (`settleEntryRows`), which every caller already runs after the spawn.
 */
import type { Entity, World } from 'koota';
import { findEntityById, indexEntityGuid, spawnEntity } from '../core/ecs/world';
import { getTraitByName } from '../core/ecs/traitRegistry';
import { TemplateAddedKey } from '../core/templateIdentity';
import { hasMemberToken } from '../core/templateRefs';
import { markRowPlaceholder } from '../core/unresolvedPrefabRef';
import { noteDamagedPrefab } from '../core/damagedPrefabs';
import { noteFrameDoc, noteNodeMoves, type TemplateDoc } from '../core/ecs/identityParents';
import { clearOverrideMarks, markOverride } from '../loaders/overrideMarks';
import { fieldFate } from '../loaders/overrideFate';
import { noteTemplateDoc } from '../loaders/templateKeyRecovery';
import { spawnUnresolvedReference } from '../loaders/unresolvedPrefabRefs';
import { nodeFrameAddress, rowFrameAddress } from '../loaders/frameAddress';
import { templateNodeRowMoves } from '../loaders/prefabOverrides';
import {
  applyStructureByLocalToEcs, queueRealizedDeletes, queueRealizedMissing, queueRealizedMove, registerTemplateFrame,
  type AddedEntity, type ExpansionReader,
} from '../loaders/loadSceneFile';
import { foldInstance, type FoldOptions } from './foldInstance';
import {
  ROOT_ROW_KEY, hasDerivedGuid, rawTemplateNodeOf,
  type DesiredNode, type FoldedInstance, type InstanceRecord, type Placeholder, type PrefabReader, type RecordTraits,
  type RowKey, type SceneOwnedNode,
} from './instanceRecord';

const LOG = '[projectInstance]';
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The frames a rebuild KEPT live (`keepingFrames`, #1862): by frame address, the prefab each was kept for. */
export interface KeptFrames {
  readonly frames: ReadonlyMap<string, string>;
  readonly met: Set<string>;
  readonly release: (address: string) => void;
}

export interface ProjectOptions {
  /** The ECS parent the instance root hangs under (its placement's parent, resolved by the caller); 0 at the top. */
  parentId: number;
  /** The content of each scene-owned node the list links, by guid: the parse's `ownContent`. */
  ownContent?: ReadonlyMap<string, SceneOwnedNode>;
  /** What a scene-owned nested instance among them reads its documents through (the expansion's reader). */
  expansionRead?: ExpansionReader;
  /** This instance's frame address in its scene (#1939, `frameAddress.ts`). */
  frame?: string;
  /** The frames a rebuild keeps live: a template reference node at one of them is not spawned again (#1862). */
  keptFrames?: KeptFrames;
  /** The frame root's `PrefabInstance.source`, when the caller states none (an expansion of an unnamed document): no
   *  `PrefabInstance` is stamped on that frame's members, as the old spawner stamped none. */
  unnamedSource?: string;
  /** The scene file's version, for a scene-owned nested instance among the linked nodes (its own parse). */
  sceneVersion?: number;
  fold?: FoldOptions;
}

export interface Projection {
  /** The instance root's ECS id; 0 when the source itself does not resolve (the caller keeps its own placeholder). */
  root: number;
  fold: FoldedInstance;
}

/** Fold `rec` over the documents `read` gives and spawn the result into `world` (mode `spawn`, § 3.1). */
export function projectInstance(world: World, rec: InstanceRecord, read: PrefabReader, opts: ProjectOptions): Projection {
  const fold = foldInstance(read, rec, opts.fold);
  const byKey = new Map<RowKey, Entity>();
  if (fold.placeholders.has(ROOT_ROW_KEY)) return { root: 0, fold };
  const eaMeta = getTraitByName('EntityAttributes');
  const piMeta = getTraitByName('PrefabInstance');

  // ── Frame addresses, and the frames a rebuild keeps live ──
  const frameNode = (key: RowKey): DesiredNode | Placeholder | undefined => fold.nodes.get(key) ?? fold.placeholders.get(key);
  const addresses = new Map<RowKey, string | undefined>([[ROOT_ROW_KEY, opts.frame]]);
  const addressOf = (key: RowKey): string | undefined => {
    if (addresses.has(key)) return addresses.get(key);
    addresses.set(key, undefined); // a loop answers "no address"
    const n = frameNode(key);
    const opens = n?.opens;
    const outer = opens ? addressOf(opens.outer) : undefined;
    const tk = n && 'templateKey' in n ? n.templateKey : undefined;
    const a = opens?.row ? rowFrameAddress(outer, opens.row.nodeGuid) : tk && outer ? nodeFrameAddress(outer, { key: tk }) : undefined;
    addresses.set(key, a);
    return a;
  };
  const skipped: RowKey[] = [];
  const isSkipped = (key: RowKey): boolean => skipped.some((k) => key === k || key.startsWith(`${k}/`));
  /** A template reference node's frame that a rebuild kept live is that node's expansion already: met, and not spawned.
   *  One kept for another prefab is released first (the document re-pointed the node, #1948 S1). As `spawnReferenceNode`. */
  const kept = (key: RowKey, source: string): boolean => {
    const k = opts.keptFrames;
    const a = k ? addressOf(key) : undefined;
    if (!k || !a || !k.frames.has(a)) return false;
    if (k.frames.get(a) === source) { k.met.add(a); return true; }
    k.release(a);
    return false;
  };
  for (const [key, n] of fold.nodes) if (key !== ROOT_ROW_KEY && n.templateKey && n.frame.rootKey === key && kept(key, n.frame.source)) skipped.push(key);
  for (const [key, ph] of fold.placeholders) if (ph.templateKey && kept(key, ph.source)) skipped.push(key);

  // ── Spawn every node (parentless; placed below, once every node exists) ──
  const spawned: [DesiredNode, Entity][] = [];
  const spawnNode = (n: DesiredNode): Entity | undefined => {
    const templatePlain = !!n.template && n.frame.rootKey !== n.key;
    // A template node's guid: the one the scene pins on its row (a row's `added` restating the node by key, § 5.2's pin),
    // else the one its template states. Stamped at the spawn, as the old spawner gave a stated node its guid
    // (`applyRootGuid`): the settle finds a reference node by it to pin the node's OWN rows, and runs before the derive. A
    // KEYLESS template node (a document admission never seeded) keeps the guid its template states, in every instance,
    // as the old spawner kept it (#1387's legacy case). A member INSIDE a template-added reference node's frame
    // (`…/a+<key>/…`) takes the guid its row pins the same way: the settle pins those rows only through a node an `added`
    // restates (today's form), and a v20 entry states them as rows of its own (#2028, P1 after a Create Prefab).
    const statedGuid = n.templateKey || n.template ? (rec.list.rows.get(n.key)?.guid ?? (n.template ? rawTemplateNodeOf(n.template)?.guid : undefined))
      : n.key.includes('/a+') ? rec.list.rows.get(n.key)?.guid : undefined;
    const args: unknown[] = [];
    let missing: Record<string, unknown> | undefined;
    for (const [name, data] of Object.entries(n.traits)) {
      const meta = getTraitByName(name);
      // A component this build does not register: kept for a template-added node, verbatim (#1933 N1b, #1948 F2); a
      // document row's stays in its document, as the old spawner left it.
      if (!meta) { if (templatePlain) (missing ??= {})[name] = data; continue; }
      if (meta.name === 'PrefabInstance') continue;
      if (data === true) { args.push(meta.trait()); continue; }
      const d: Record<string, unknown> = { ...data };
      // Parentless: placed below. A supplied node's guid is the derive's (pins and derivation, § 2.7); the root's is the
      // record's own.
      if (meta.name === 'EntityAttributes') { d.parentId = 0; d.guid = n.key === ROOT_ROW_KEY ? rec.rootGuid : statedGuid || ''; }
      args.push((meta.trait as (x: Record<string, unknown>) => unknown)(d));
    }
    if (piMeta && !templatePlain && n.frame.source !== opts.unnamedSource) {
      const row = n.key !== ROOT_ROW_KEY ? n.opens?.row : undefined;
      args.push((piMeta.trait as (x: Record<string, unknown>) => unknown)({
        source: n.frame.source, localId: n.localId ?? 0, nodeGuid: n.nodeGuid ?? '', rootInstanceId: 0,
        ...(row ? { parentLocalId: row.localId, parentNodeGuid: row.nodeGuid ?? '' } : {}),
      }));
    }
    // A node no registered component describes spawns nothing, as the old spawner skipped it (a world that registered no
    // traits gets no root, and its caller reads 0).
    if (!args.length) return undefined;
    if (n.templateKey) args.push(TemplateAddedKey({ key: n.templateKey }));
    const e = spawnEntity(world, ...(args as Parameters<World['spawn']>));
    clearOverrideMarks(e); // the 8-bit generation wraps — see overrideMarks.ts
    if (templatePlain) queueRealizedMissing(world, e, missing);
    return e;
  };
  for (const [key, n] of fold.nodes) {
    if (isSkipped(key)) continue;
    const e = spawnNode(n);
    if (!e) continue;
    byKey.set(key, e);
    spawned.push([n, e]);
  }
  const transit: Entity[] = [];
  for (const [key, n] of fold.transit ?? []) {
    if (isSkipped(key)) continue;
    const e = spawnNode(n);
    if (!e) continue;
    byKey.set(key, e);
    spawned.push([n, e]);
    transit.push(e);
  }
  const placeholders: [Placeholder, Entity][] = [];
  for (const [key, ph] of fold.placeholders) {
    if (isSkipped(key)) continue;
    if (ph.cycle && ph.node) { logCycle(ph, read); continue; }
    const row = rec.list.rows.get(key);
    const e = spawnPlaceholder(world, typeof row?.name === 'string' ? { ...ph, name: row.name } : ph, row?.guid, ph.node && ph.templateKey ? heldCopyOf(rec, ph.templateKey) : undefined);
    if (!e) continue;
    byKey.set(key, e);
    placeholders.push([ph, e]);
  }

  // ── Place each node, stamp its frame root, and queue the moves ──
  type Parent = DesiredNode['parent'];
  const parentIdOf = (p: Parent, inTopFrame: boolean): number => {
    if (p === null) return opts.parentId;
    if ('key' in p) return byKey.get(p.key)?.id() ?? 0;
    // `''`: the scene's top level for the instance's own frame, no parent in a nested one; the placement's parent: the
    // caller's. Any other guid is a move's target, queued below.
    if (p.guid === '' ) return inTopFrame ? opts.parentId : 0;
    if (p.guid === rec.placement.parent) return opts.parentId;
    return 0;
  };
  const setParent = (e: Entity, parentId: number): void => {
    if (eaMeta && e.has(eaMeta.trait)) e.set(eaMeta.trait, { ...(e.get(eaMeta.trait) as Record<string, unknown>), parentId });
  };
  for (const [n, e] of spawned) {
    const inTop = n.frame.rootKey === ROOT_ROW_KEY;
    const at = n.rowParent !== undefined ? n.rowParent : n.parent;
    setParent(e, parentIdOf(at, inTop));
    const frameRoot = byKey.get(n.frame.rootKey);
    if (piMeta && frameRoot && e.has(piMeta.trait)) e.set(piMeta.trait, { ...(e.get(piMeta.trait) as Record<string, unknown>), rootInstanceId: frameRoot.id() });
    if (n.rowParent === undefined || n.parent === null) continue;
    if ('key' in n.parent) { const to = byKey.get(n.parent.key); if (to) queueRealizedMove(world, e, to, LOG); }
    else if (n.parent.guid && n.parent.guid !== rec.placement.parent) queueRealizedMove(world, e, n.parent.guid, LOG);
    else setParent(e, parentIdOf(n.parent, inTop));
  }
  for (const [ph, e] of placeholders) setParent(e, parentIdOf(ph.parent ?? null, !ph.opens || ph.opens.outer === ROOT_ROW_KEY));
  queueRealizedDeletes(world, transit.map((e) => e.id()));

  // ── The scene-owned nodes the list links, under their anchors ──
  const anchorIds = new Map<number, number>();
  const added: AddedEntity[] = [];
  for (const [key, refs] of fold.anchors) {
    const at = isSkipped(key) ? undefined : byKey.get(key);
    if (!at) continue;
    const lid = anchorIds.size + 1;
    anchorIds.set(lid, at.id());
    for (const r of refs) {
      const content = opts.ownContent?.get(r.guid);
      if (content) added.push({ ...(content as AddedEntity), ...(hasDerivedGuid(content) ? { guid: '' } : {}), parentLocalId: lid });
    }
  }
  if (added.length) {
    applyStructureByLocalToEcs(world, anchorIds, { entities: [], rootLocalId: -1 }, { added }, new Set(rec.source ? [rec.source] : []), opts.expansionRead, () => opts.frame, opts.sceneVersion);
  }

  // ── The compatibility adapter (§ 10.1) ──
  markRecords(byKey, rec, new Set(placeholders.map(([, e]) => e)));
  noteFrames(world, read, fold, byKey, isSkipped, opts.unnamedSource);
  registerTokenFrames(world, fold, byKey);

  return { root: byKey.get(ROOT_ROW_KEY)?.id() ?? 0, fold };
}

/** The scene's whole copy of template reference node `key` the parse HELD (its prefab missing: `referenceCopy`), found in
 *  the record's held legacy channels at any depth — or undefined. */
function heldCopyOf(rec: InstanceRecord, key: string): AddedEntity | undefined {
  const seen = new Set<unknown>();
  const walk = (v: unknown): AddedEntity | undefined => {
    if (!v || typeof v !== 'object' || seen.has(v)) return undefined;
    seen.add(v);
    if (Array.isArray(v)) { for (const x of v) { const hit = walk(x); if (hit) return hit; } return undefined; }
    const o = v as Record<string, unknown>;
    if (typeof o.prefab === 'string' && o.key === key) return o as unknown as AddedEntity;
    for (const x of Object.values(o)) { const hit = walk(x); if (hit) return hit; }
    return undefined;
  };
  return walk(rec.held.pendingLegacy);
}

/** Today's refusal line for a reference node whose prefab contains itself (`refuseCyclicReferenceNode`, I16, #1817). */
function logCycle(ph: Placeholder, read: PrefabReader): void {
  const label = (id: string) => { const got = read(id); return `"${('doc' in got ? (got.doc as { name?: string }).name : undefined) ?? id}"`; };
  const name = ((ph.node?.traits as Record<string, unknown> | undefined)?.EntityAttributes as { name?: unknown } | undefined)?.name ?? ph.node?.name;
  const nodeLabel = [typeof name === 'string' && name ? `"${name}"` : '', (ph.node as { guid?: string } | undefined)?.guid || ph.node?.key || ''].filter(Boolean).join(' ');
  console.error(
    `[loadSceneFile] cycle: prefab ${label(ph.source)} contains itself (I16), so its reference node ${nodeLabel || '(unnamed)'} ` +
    `inside ${(ph.cycle ?? []).map(label).join(' › ')} is not expanded. A prefab-edit save of the file holding that node ` +
    `refuses until the node is removed.`,
  );
}

/** A placeholder entity for a frame the fold could not open (rule 9), or undefined when none can be spawned. `pin`: the
 *  guid the scene pins on its row — the row's identity, which its placeholder carries as the frame root would (ruling D;
 *  the derive fills only a guid nothing stated). The row's name pin rides in `ph.name` likewise. */
function spawnPlaceholder(world: World, ph: Placeholder, pin?: string, copy?: AddedEntity): Entity | undefined {
  if (ph.reason === 'damaged' && ph.text) noteDamagedPrefab([ph.source], ph.text);
  if (ph.node) {
    // A template reference node: the old spawner's placeholder, carrying the node as its template states it (#1699) — or
    // as the scene restates it (`copy`): its prefab missing, the copy is held whole (§ 5.2 `referenceCopy`), and the
    // compatibility save (§ 10.1) writes back what the placeholder carries, as the old spawner's placeholder carried it.
    const stated = copy ?? rawTemplateNodeOf(ph.node) ?? { prefab: ph.source, ...(ph.templateKey ? { key: ph.templateKey } : {}), name: ph.node.name, traits: ph.node.traits as AddedEntity['traits'], children: [] };
    const id = spawnUnresolvedReference(world, stated as never, 0);
    const e = id ? findEntityById(id, world) as Entity | undefined : undefined;
    // The pin is the entity's identity, not part of the record it carries (the template's statement of the node).
    const ea = getTraitByName('EntityAttributes');
    if (e && pin && ea) { e.set(ea.trait, { ...(e.get(ea.trait) as Record<string, unknown>), guid: pin }); indexEntityGuid(e as never, world); }
    return e;
  }
  const ea = getTraitByName('EntityAttributes');
  if (!ea || !ph.opens?.row) return undefined;
  const e = spawnEntity(world, (ea.trait as (x: Record<string, unknown>) => unknown)({
    name: ph.name || 'Missing Prefab', parentId: 0, ...(ph.sortOrder !== undefined ? { sortOrder: ph.sortOrder } : {}),
    ...(pin ? { guid: pin } : {}),
  }) as Parameters<World['spawn']>[0]);
  markRowPlaceholder(e as never, { source: ph.source, localId: ph.opens.row.localId, nodeGuid: ph.opens.row.nodeGuid ?? '', reason: ph.reason });
  return e;
}

/** Seed the override marks from the list (§ 10.1): every field the instance's own list records, as the old spawner
 *  marked every field the writer stated (#1914). A tag records as the empty field. Root default fields (name, order) are
 *  the placement's, which the caller marks: it knows whether the file stated them. */
function markRecords(byKey: ReadonlyMap<RowKey, Entity>, rec: InstanceRecord, placeholders: ReadonlySet<Entity>): void {
  for (const [key, row] of rec.list.rows) {
    const e = byKey.get(key);
    if (!e || placeholders.has(e)) continue;
    markTraits(e, row.traits);
  }
}

/** Mark the fields `traits` states on `e` (a record's, or the root's stated defaults). */
export function markTraits(e: Entity, traits: RecordTraits | undefined): void {
  for (const [name, data] of Object.entries(traits ?? {})) {
    const meta = getTraitByName(name);
    if (!meta) continue;
    if (meta.category === 'tag') { if (data) markOverride(e, name, ''); continue; }
    if (!isRecord(data)) continue;
    for (const field of Object.keys(data)) if (fieldFate(meta, field) === 'applies') markOverride(e, name, field);
  }
}

/** Each projected frame's document record (`noteFrameDoc`), with the nested rows it could not expand — a row placeholder
 *  stands there, which the old capture must still read as the document's row and not as a removal (#1812) — and its keys
 *  as heal candidates (`noteTemplateDoc`). Inner frames first, as the old recursion noted them. A template reference
 *  node's own moves go on its frame record (`noteNodeMoves`), which the old capture reads (#1543). */
function noteFrames(
  world: World, read: PrefabReader, fold: FoldedInstance, byKey: ReadonlyMap<RowKey, Entity>, isSkipped: (key: RowKey) => boolean,
  unnamedSource: string | undefined,
): void {
  const frames: DesiredNode[] = [];
  for (const [key, n] of fold.nodes) if (n.frame.rootKey === key && !isSkipped(key)) frames.push(n);
  for (const n of frames.reverse()) {
    const root = byKey.get(n.key);
    const got = read(n.frame.source);
    if (!root || !('doc' in got)) continue;
    const doc = got.doc as unknown as TemplateDoc;
    noteTemplateDoc(world, doc as never);
    if (n.frame.source === unnamedSource) continue;
    const unexpanded: number[] = [];
    for (const ph of fold.placeholders.values()) if (ph.opens?.row && ph.opens.outer === n.key) unexpanded.push(ph.opens.row.localId);
    noteFrameDoc(world, n.frame.source, doc, root, unexpanded);
    const raw = n.opens?.node ? rawTemplateNodeOf(n.opens.node) : undefined;
    // A v10 node states its moves on its own rows (#2001 S6), read back into the `templateMoved` spelling.
    const nodeMoves = {
      ...templateNodeRowMoves(raw, doc, (g) => { const r = read(g); return 'doc' in r ? r.doc : undefined; }),
      ...(raw?.templateMoved && isRecord(raw.templateMoved) ? raw.templateMoved as Record<string, string> : {}),
    };
    if (Object.keys(nodeMoves).length) noteNodeMoves(world, root, n.frame.source, doc, nodeMoves);
  }
}

/** The member-token frames the derive resolves (`registerTemplateFrame`): every frame whose tokens restart — the
 *  instance's own and each template reference node's (`spawnReferenceNode`'s top call) — innermost first, as the old
 *  calls closed their scopes, when any projected value holds a token. An inner frame resolves before the frame around it,
 *  so the outer pass finds guids where the inner tokens were. */
function registerTokenFrames(world: World, fold: FoldedInstance, byKey: ReadonlyMap<RowKey, Entity>): void {
  let any = false;
  for (const n of fold.nodes.values()) if (hasMemberToken(n.traits)) { any = true; break; }
  if (!any) return;
  const roots = [...fold.nodes.values()].filter((n) => n.key === ROOT_ROW_KEY || (n.template && n.frame.rootKey === n.key));
  roots.sort((a, b) => b.key.length - a.key.length);
  for (const n of roots) { const e = byKey.get(n.key); if (e) registerTemplateFrame(world, e.id()); }
}

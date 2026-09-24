/** The save half of scene v17's NODE rows (#1516): what a nested frame's live `added` nodes change
 *  against the nodes the prefab chain adds there, stated node by node and field by field.
 *
 *  Before v17 a member row's `added` was one statement for the whole list under a member, and it
 *  REPLACED the chain's (`foldMemberRowChannels`). So once the scene edited one template node the save
 *  wrote them all, and every untouched sibling was pinned: a later template change to it never reached
 *  the scene. This computes the statement that pins nothing it does not have to:
 *
 *  - a template node the scene EDITED → a node row holding only the fields that differ, the traits it
 *    added (`traits`), the ones it removed (`traitRemovals`) and its own children (`own`);
 *  - a template node the scene DELETED → a node row `{ removed: true }`;
 *  - a node the scene ADDED → `own` under its anchor member (appended on load, where `added` replaces);
 *  - an untouched template node → nothing, so the template keeps owning it.
 *
 *  ⚠️ **A template node matches only UNDER ITS OWN PARENT** — the member the chain anchors it to, or the
 *  template node whose `children` hold it. One found anywhere else was re-parented by the scene, and a
 *  re-parent UNLINKS it (owner, 2026-09-24): it is written as the scene's own node where it now sits, and
 *  the template's copy as removed, so only that node stops following the template — never its siblings.
 *  The rule is the same whether it went under a prefab member or under another template node.
 *
 *  **Falls back to the v16 whole-list statement** (`whole`) for an anchor it cannot state node by node:
 *  a chain node there with no template key (a file from before keys), a key used twice in the frame, or
 *  an edited template REFERENCE node (a nested instance a template row added), whose interior is a frame
 *  of its own and has no node-row address yet. The fallback pins that anchor's list exactly as v16 did,
 *  and nothing more.
 *
 *  Pure: the live-world questions (a node's template key, a field's schema default, reference node
 *  equality) are the caller's, passed in `deps`. */

import type { AddedEntity, SceneMemberRow } from '../../runtime/loaders/loadSceneFile';

export interface NodeDiffDeps {
  /** The template key of a LIVE node (scene form: it carries a guid, not a key), '' for the scene's own. */
  keyOf(node: AddedEntity): string;
  /** A trait field's schema default, or undefined when it has none. A field one side omits reads as this — the
   *  live capture drops default-valued fields, a template bag may state them. */
  defaultOf(trait: string, field: string): unknown;
  /** Do a live and a chain REFERENCE node state the same thing? */
  sameReference(live: AddedEntity, chain: AddedEntity): boolean;
  /** Field-value equality (the save's float tolerance). */
  equal(a: unknown, b: unknown): boolean;
}

export interface FrameAddedDiff {
  /** Template key → that node's row. */
  nodeRows: Map<string, SceneMemberRow>;
  /** Anchor member localId → the scene's own nodes under it (`parentLocalId` written as 0). */
  own: Map<number, AddedEntity[]>;
  /** Anchors whose whole live list must be written as v16 `added` instead. */
  whole: Set<number>;
}

/** Not a field edit: identity the load re-derives (`guid`) and the live ecs parent (`parentId`). */
const IDENTITY_FIELDS: Record<string, readonly string[]> = { EntityAttributes: ['guid', 'parentId'] };

export function diffFrameAdded(
  live: readonly AddedEntity[] | undefined,
  chain: readonly AddedEntity[] | undefined,
  deps: NodeDiffDeps,
): FrameAddedDiff {
  const out: FrameAddedDiff = { nodeRows: new Map(), own: new Map(), whole: new Set() };
  const liveNodes = live ?? [];
  const chainNodes = chain ?? [];
  const anchors = new Set([...liveNodes, ...chainNodes].map((n) => n.parentLocalId));

  // A key used twice anywhere in the frame's chain could not say which node a row is about.
  const seen = new Set<string>();
  let duplicate = false;
  const scan = (nodes: readonly AddedEntity[]) => {
    for (const n of nodes) {
      if (n.key) { if (seen.has(n.key)) duplicate = true; seen.add(n.key); }
      scan(n.children ?? []);
    }
  };
  scan(chainNodes);
  if (duplicate) {
    for (const a of anchors) if (chainNodes.some((n) => n.parentLocalId === a)) out.whole.add(a);
    for (const a of anchors) if (!out.whole.has(a)) out.own.set(a, ownForm(liveNodes.filter((n) => n.parentLocalId === a)));
    for (const [a, nodes] of out.own) if (!nodes.length) out.own.delete(a);
    return out;
  }

  const allKeyed = (nodes: readonly AddedEntity[]): boolean => nodes.every((n) => !!n.key && allKeyed(n.children ?? []));
  for (const anchor of anchors) {
    const chainAt = chainNodes.filter((n) => n.parentLocalId === anchor);
    const liveAt = liveNodes.filter((n) => n.parentLocalId === anchor);
    if (!allKeyed(chainAt)) { out.whole.add(anchor); continue; }
    const rows = new Map<string, SceneMemberRow>();
    const matched = matchList(liveAt, chainAt, rows, deps);
    if (!matched) { out.whole.add(anchor); continue; }
    for (const [k, r] of rows) out.nodeRows.set(k, r);
    if (matched.own.length) out.own.set(anchor, ownForm(matched.own));
  }
  return out;
}

/** Match one sibling list — the live nodes under a parent against the chain's under the SAME parent. The
 *  unmatched live nodes are the scene's own there; null when the list cannot be stated node by node. */
function matchList(
  live: readonly AddedEntity[], chain: readonly AddedEntity[], rows: Map<string, SceneMemberRow>, deps: NodeDiffDeps,
): { own: AddedEntity[] } | null {
  const byKey = new Map<string, AddedEntity>();
  const own: AddedEntity[] = [];
  const chainKeys = new Set(chain.map((c) => c.key!));
  for (const l of live) {
    const k = deps.keyOf(l);
    // Only a key the chain adds HERE: one from elsewhere in the frame is a re-parented node, and a second
    // live node with a key already taken is a copy. Both are the scene's own.
    if (k && chainKeys.has(k) && !byKey.has(k)) byKey.set(k, l);
    else own.push(l);
  }
  for (const c of chain) {
    const l = byKey.get(c.key!);
    if (!l) { rows.set(c.key!, { removed: true }); continue; }
    if (c.prefab || l.prefab) {
      if (c.prefab && l.prefab && deps.sameReference(l, c)) continue;
      return null;
    }
    const row = diffNode(l, c, rows, deps);
    if (!row) return null;
    if (Object.keys(row).length) rows.set(c.key!, row);
  }
  return { own };
}

/** One template node's row: its field edits, trait additions and removals, and its children. `{}` when
 *  untouched; null when its children cannot be stated node by node. */
function diffNode(l: AddedEntity, c: AddedEntity, rows: Map<string, SceneMemberRow>, deps: NodeDiffDeps): SceneMemberRow | null {
  const row: SceneMemberRow = {};
  const traits: Record<string, Record<string, unknown>> = {};
  const removals: Record<string, boolean> = {};
  const bagOf = (t: string, v: Record<string, unknown> | boolean): Record<string, unknown> => {
    const bag = v === true || !v || typeof v !== 'object' ? {} : { ...v };
    for (const f of IDENTITY_FIELDS[t] ?? []) delete bag[f];
    return bag;
  };
  const names = new Set([...Object.keys(l.traits ?? {}), ...Object.keys(c.traits ?? {})]);
  for (const t of names) {
    const lv = l.traits?.[t];
    const cv = c.traits?.[t];
    if (lv === undefined || lv === false) { if (cv !== undefined && cv !== false) removals[t] = true; continue; }
    if (cv === undefined || cv === false) { traits[t] = bagOf(t, lv); continue; }
    if (lv === true && cv === true) continue;
    const lo = bagOf(t, lv);
    const co = bagOf(t, cv);
    const delta: Record<string, unknown> = {};
    for (const f of new Set([...Object.keys(lo), ...Object.keys(co)])) {
      const a = f in lo ? lo[f] : deps.defaultOf(t, f);
      const b = f in co ? co[f] : deps.defaultOf(t, f);
      if (a !== undefined && !deps.equal(a, b)) delta[f] = a;
    }
    if (Object.keys(delta).length) traits[t] = delta;
  }
  if (Object.keys(traits).length) row.traits = traits;
  if (Object.keys(removals).length) row.traitRemovals = removals;
  const kids = matchList(l.children ?? [], c.children ?? [], rows, deps);
  if (!kids) return null;
  if (kids.own.length) row.own = ownForm(kids.own);
  return row;
}

/** The scene's own nodes as a row carries them: anchored by the row, so `parentLocalId` is 0. */
function ownForm(nodes: readonly AddedEntity[]): AddedEntity[] {
  return nodes.map((n) => ({ ...n, parentLocalId: 0 }));
}

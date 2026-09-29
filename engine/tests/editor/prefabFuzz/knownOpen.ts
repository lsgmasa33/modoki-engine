/** Known OPEN prefab bugs the fuzzer finds (#1789), and how verify mode lives with each until it is fixed.
 *
 *  `stops`: a seed whose first failure this predicate matches ends there as a pass (its prefix was checked). The
 *  predicate names the check AND the op shape that reaches it, so it cannot swallow an unrelated failure of the same
 *  check. (A second kind, a normalization verify mode applied while its issue was open, had one user — #1796's node-list
 *  order — and went with its fix.)
 *
 *  Every entry carries a minimized repro. The self-test in prefabFuzz.test.ts runs it and
 *  asserts it still fails as described: once the bug is fixed that test goes red, which forces the entry out. Keep an
 *  entry only while its issue is open. */

import type { Op } from './ops';
import type { StepFailure } from './runner';

export interface KnownOpen {
  issue: number;
  what: string;
  repro: Op[];
  /** The failure the repro must still produce (with this entry's tolerance off). */
  reproduces: (f: StepFailure) => boolean;
  stops?: (f: StepFailure, ops: readonly Op[]) => boolean;
}

/** The ONE node or entry a scene diff is about — not every guid in it (review: a path now carries its top-level entry's
 *  guid, so "any guid named" claimed a diff inside a dropped entry whichever node moved). A top-level entry gone, new
 *  or re-parented names itself in the path; a node gone from or new to a list names itself first in its value. */
/** The member-path node keys (`members//<nodeGuid>`) in a diff's path: which frame row of a tree the diff is inside. */
const memberKeys = (f: StepFailure) => [...f.detail.split(': ')[0].matchAll(/members\/\/([0-9a-f]{8}-[0-9a-f-]{27})/g)].map((m) => m[1]);

function diffSubject(f: StepFailure): string | undefined {
  const top = /^\/entities\/([0-9a-f]{8}-[0-9a-f-]{27})(: |\/traits\/EntityAttributes\/parentId: )/.exec(f.detail);
  if (top) return top[1];
  const m = /: (.*) vs (.*)$/.exec(f.detail);
  if (!m) return undefined;
  const side = m[2] === 'undefined' ? m[1] : m[1] === 'undefined' ? m[2] : '';
  return /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{0,12}/.exec(side)?.[0];
}
/** Whether op `kind` of this run introduced (a drop, a paste) or covered (a detach) that guid: keys a stop on the
 *  entity its mechanism's op touched, not on the op merely having run somewhere in the list (review: a planted redo
 *  regression that misplaced some other node was claimed by #1793 on the op list alone). */
const touchedBy = (f: StepFailure, kind: 'drop' | 'paste' | 'detach' | 'create', g: string | undefined) =>
  !!g && g.length >= 20 && !!f.touched?.[kind].some((t) => t.startsWith(g) || g.startsWith(t));

/** The op before the failure, reloads aside: for a route that shows at the next save→reload after the op that exposes it,
 *  keying on that op being LAST is what keeps a stop from claiming any later failure in a list that merely holds it. */
const lastOp = (ops: readonly Op[]) => ops.filter((o) => o.kind !== 'saveReload').at(-1)?.kind;

/** A node in a node list (or a template-added key's record, or a slot) that differs across the redo walk. */
const NODE_LIST_DIFF = /\/((own|added|children)(\/\d+)*|a\+k-[^/:]+): (\[?\{"(parentLocalId|own)":.* vs undefined$|undefined vs \[?\{"(parentLocalId|own)":)|\/(own|added|children)(\/\d+)+\/guid: "[^"]+" vs "[^"]+"$/;


// Retired by #1869, whose refusals (a supplied object is not moved, reordered, detached out of its instance or saved as
// a prefab of its own — Unity's rule) left their only route unreachable, and which a 300-seed hunt with the re-aimed ops
// and a sweep of legal variants did not re-find: #1792 (every route refused; closed), #1808, #1826, #1829, #1851, and one
// route each of #1796 (two: Create Prefab on a member), #1809 (Create Prefab on a member, then the directed Apply) and
// #1820 (Create Prefab's undo, on a member). Also a route #1796's fix unmasked (outsideEdit → reparent → createPrefab: its
// redo tagged, then a template-added node row read removed; kept under #1830, mechanism unconfirmed): with #1869 merged one
// of its draws lands on a refused gesture and it no longer reproduces.
/** The last three ops (reloads aside) are a delete, a SAVED prefab edit (`u[1] < 0.65` saves) and an undo: Delete's undo
 *  respawning a snapshot older than the template the edit saved. Adjacent, so a list that merely holds the three somewhere
 *  is not claimed (the planted-regression guard). */
const deleteThenSavedEditThenUndo = (ops: readonly Op[]) => {
  const [d, e, u] = ops.filter((o) => o.kind !== 'saveReload').slice(-3);
  return d?.kind === 'delete' && e?.kind === 'prefabEdit' && e.u[1] < 0.65 && u?.kind === 'undo';
};
const CHANGED_GUID = /\(an entity changed guid\)$/;

export const KNOWN_OPEN: KnownOpen[] = [
  {
    issue: 1820,
    what: "(close-out review) Delete's undo of a ROW of a frame that survives the delete, after a saved edit of that frame's template: the row respawns on the old document",
    // rebaseRespawned rebuilds frames whose OWN record is stale; a deleted member or owned nested root belongs to an enclosing
    // frame that leaving prefab edit already rebased, so no stale frame is left to see. Three OBSERVED routes (a value, a lost
    // entity, a parent link). Fix direction: the snapshot records the enclosing frame's document and the undo translates or
    // refuses. Keyed off the guid-change shape, which is #1809's.
    repro: [
      { kind: 'delete', u: [0.7, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'prefabEdit', u: [0.55, 0.1, 0, 0, 0, 0, 0, 0], inner: [{ kind: 'editField', u: [0.15, 0.5, 0.9, 0, 0, 0, 0, 0] }] },
      { kind: 'undo', u: [0, 0, 0, 0, 0, 0, 0, 0] },
    ],
    reproduces: (f) => f.check === 'save→reload is not the identity' && /\/traits\/Transform\/z: /.test(f.detail),
    stops: (f, ops) => f.check === 'save→reload is not the identity' && !CHANGED_GUID.test(f.detail) && deleteThenSavedEditThenUndo(ops),
  },
  {
    issue: 1820,
    what: "the same, where the respawned row's template dropped a member: the entity is lost on reload",
    repro: [
      { kind: 'delete', u: [0.4, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'prefabEdit', u: [0.55, 0.1, 0, 0, 0, 0, 0, 0], inner: [{ kind: 'delete', u: [0.15, 0.5, 0.5, 0, 0, 0, 0, 0] }] },
      { kind: 'undo', u: [0, 0, 0, 0, 0, 0, 0, 0] },
    ],
    reproduces: (f) => f.check === 'save→reload is not the identity' && /\(an entity was lost\)$/.test(f.detail),
    stops: (f, ops) => f.check === 'save→reload is not the identity' && !CHANGED_GUID.test(f.detail) && deleteThenSavedEditThenUndo(ops),
  },
  {
    issue: 1820,
    what: "the same, where the respawned row is an owned nested root: its parent link reverts on reload",
    repro: [
      { kind: 'delete', u: [0.3, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'prefabEdit', u: [0.3, 0.1, 0, 0, 0, 0, 0, 0], inner: [{ kind: 'delete', u: [0.15, 0.5, 0.5, 0, 0, 0, 0, 0] }] },
      { kind: 'undo', u: [0, 0, 0, 0, 0, 0, 0, 0] },
    ],
    reproduces: (f) => f.check === 'save→reload is not the identity' && /\/traits\/PrefabInstance\/parentLocalId: /.test(f.detail),
    stops: (f, ops) => f.check === 'save→reload is not the identity' && !CHANGED_GUID.test(f.detail) && deleteThenSavedEditThenUndo(ops),
  },
  {
    issue: 1809,
    what: "the anchor-row guid change, through Delete's undo after a saved prefab edit dropped the anchor row (close-out review)",
    repro: [
      { kind: 'delete', u: [0.02, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'prefabEdit', u: [0.55, 0.1, 0, 0, 0, 0, 0, 0], inner: [{ kind: 'delete', u: [0.15, 0.5, 0.5, 0, 0, 0, 0, 0] }] },
      { kind: 'undo', u: [0, 0, 0, 0, 0, 0, 0, 0] },
    ],
    reproduces: (f) => f.check === 'save→reload is not the identity' && CHANGED_GUID.test(f.detail),
    stops: (f, ops) => f.check === 'save→reload is not the identity' && CHANGED_GUID.test(f.detail) && deleteThenSavedEditThenUndo(ops),
  },
  {
    issue: 1809,
    what: "the same, through Detach's undo after a prefab-edit save deleted the anchor row (its rebase re-anchors, keeps the guid)",
    repro: [
      { kind: 'detach', u: [0.025726123247295618, 0.6438882742077112, 0.055156498216092587, 0.2290809666737914, 0.325337108457461, 0.7244618884287775, 0.937406157143414, 0.4990142297465354] },
      { kind: 'prefabEdit', u: [0.5476142126135528, 0.18346081534400582, 0.2778930668719113, 0.278214025311172, 0.27691279095597565, 0.6830818050075322, 0.0016407903749495745, 0.34888543910346925], inner: [{ kind: 'delete', u: [0.19734677020460367, 0.22199939331039786, 0.5219223950989544, 0.29861879511736333, 0.49865362676791847, 0.32312997709959745, 0.16570315975695848, 0.15814896672964096] }] },
      { kind: 'undo', u: [0.47763126995414495, 0.6631570672616363, 0.7647192350123078, 0.0125291314907372, 0.2069809422828257, 0.5996168968267739, 0.4597687148489058, 0.01827254961244762] },
    ],
    reproduces: (f) => f.check === 'save→reload is not the identity' && /\(an entity changed guid\)$/.test(f.detail),
    stops: (f, ops) => f.check === 'save→reload is not the identity' && /\(an entity changed guid\)$/.test(f.detail) && lastOp(ops) === 'undo' && (() => {
      const d = ops.findIndex((o) => o.kind === 'detach');
      const e = ops.findIndex((o, i) => i > d && o.kind === 'prefabEdit' && o.u[1] < 0.65 && !!o.inner?.some((x) => x.kind === 'delete'));
      return d >= 0 && e >= 0 && ops.slice(e + 1).some((o) => o.kind === 'undo');
    })(),
  },
  {
    issue: 1822,
    what: "Add Component re-adding a template-row trait on a nested member reconciles its marks against the effective base",
    repro: [
      { kind: 'removeComponent', u: [0.5, 0.5, 0, 0, 0, 0, 0, 0] },
      { kind: 'addComponent', u: [0.38, 0.1, 0, 0, 0, 0, 0, 0] },
    ],
    reproduces: (f) => f.check === 'save→reload is not the identity' && /\/marks\//.test(f.detail),
    // A remove, then an add, with no undo after the remove (#1800's shape, fixed).
    stops: (f, ops) => f.check === 'save→reload is not the identity'
      && /\/marks\/\d+: (undefined|"[^"]*") vs "(Rotate3D|Renderable3DPrimitive)\.[^"]+"$/.test(f.detail) && (() => {
        const r = ops.findIndex((o) => o.kind === 'removeComponent');
        return r >= 0 && ops.slice(r + 1).some((o) => o.kind === 'addComponent') && !ops.slice(r + 1).some((o) => o.kind === 'undo');
      })(),
  },
  {
    issue: 1830,
    what: "Create Prefab's redo mints a fresh TemplateAddedKey for a marker-less added node instead of the file's key",
    repro: [
      { kind: 'duplicate', u: [0.97, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'createPrefab', u: [0.14, 0.5, 0, 0, 0, 0, 0, 0] },
    ],
    reproduces: (f) => f.check === 'redo to the end does not restore the scene' && NODE_LIST_DIFF.test(f.detail),
    // A node of a tree Create Prefab tagged (touched.create) moved in a node list across the redo, and not a drop's node
    // (#1793).
    stops: (f, ops) => f.check === 'redo to the end does not restore the scene' && f.op === 'undo/redo to the ends'
      && NODE_LIST_DIFF.test(f.detail)
      && (touchedBy(f, 'create', diffSubject(f)) || memberKeys(f).some((k) => touchedBy(f, 'create', k)))
      && !(['drop', 'paste', 'detach'] as const).some((k) => touchedBy(f, k, diffSubject(f)))
      && ops.some((o) => o.kind === 'createPrefab'),
  },
];

/** Fixed bugs the fuzzer found: each repro must now PASS. A KNOWN_OPEN entry moves here when its issue is fixed, so
 *  the minimized failure stays a regression test (#1789: "every minimized failure becomes a normal regression test"). */
export const REGRESSIONS: { issue: number; what: string; repro: Op[] }[] = [
  {
    issue: 1820,
    what: "(close-out review) Create Prefab, a saved edit of the tree's template (a member added), undo, redo: the redo is REFUSED, not a re-link to stale rows",
    repro: [
      { kind: 'createPrefab', u: [0.1, 0.9, 0, 0, 0, 0, 0, 0] },
      { kind: 'prefabEdit', u: [0.55, 0.1, 0, 0, 0, 0, 0, 0], inner: [{ kind: 'duplicate', u: [0.15, 0.5, 0.5, 0, 0, 0, 0, 0] }] },
      { kind: 'undo', u: [0, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'redo', u: [0, 0, 0, 0, 0, 0, 0, 0] },
    ],
  },
  {
    issue: 1820,
    what: "(close-out review) Create Prefab, a saved edit of the tree's template (only a VALUE changed (the shape-only check missed it)), undo, redo: the redo is REFUSED, not a re-link to stale rows",
    repro: [
      { kind: 'createPrefab', u: [0.1, 0.9, 0, 0, 0, 0, 0, 0] },
      { kind: 'prefabEdit', u: [0.55, 0.1, 0, 0, 0, 0, 0, 0], inner: [{ kind: 'editField', u: [0.15, 0.9, 0.9, 0, 0, 0, 0, 0] }] },
      { kind: 'undo', u: [0, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'redo', u: [0, 0, 0, 0, 0, 0, 0, 0] },
    ],
  },
  {
    issue: 1820,
    what: "(close-out sweep) Delete's undo after a SAVED prefab edit (duplicate) respawns the deleted instance on the current template",
    repro: [
      { kind: 'delete', u: [0.02, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'prefabEdit', u: [0.3, 0.1, 0, 0, 0, 0, 0, 0], inner: [{ kind: 'duplicate', u: [0.5, 0.5, 0.5, 0, 0, 0, 0, 0] }] },
      { kind: 'undo', u: [0, 0, 0, 0, 0, 0, 0, 0] },
    ],
  },
  {
    issue: 1820,
    what: "(close-out sweep) Delete's undo after a SAVED prefab edit (addChild) respawns the deleted instance on the current template",
    repro: [
      { kind: 'delete', u: [0.02, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'prefabEdit', u: [0.3, 0.1, 0, 0, 0, 0, 0, 0], inner: [{ kind: 'addChild', u: [0.5, 0.5, 0.5, 0, 0, 0, 0, 0] }] },
      { kind: 'undo', u: [0, 0, 0, 0, 0, 0, 0, 0] },
    ],
  },
  {
    issue: 1820,
    what: "(close-out sweep) Delete's undo after a SAVED prefab edit (delete) respawns the deleted instance on the current template",
    repro: [
      { kind: 'delete', u: [0.02, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'prefabEdit', u: [0.3, 0.1, 0, 0, 0, 0, 0, 0], inner: [{ kind: 'delete', u: [0.5, 0.5, 0.5, 0, 0, 0, 0, 0] }] },
      { kind: 'undo', u: [0, 0, 0, 0, 0, 0, 0, 0] },
    ],
  },
  {
    issue: 1820,
    what: "(close-out sweep) Duplicate's redo after a SAVED prefab edit (duplicate) respawns the copy on the current template",
    repro: [
      { kind: 'duplicate', u: [0.02, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'undo', u: [0, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'prefabEdit', u: [0.3, 0.1, 0, 0, 0, 0, 0, 0], inner: [{ kind: 'duplicate', u: [0.5, 0.5, 0.5, 0, 0, 0, 0, 0] }] },
      { kind: 'redo', u: [0, 0, 0, 0, 0, 0, 0, 0] },
    ],
  },
  {
    issue: 1820,
    what: "(close-out sweep) Duplicate's redo after a SAVED prefab edit (addChild) respawns the copy on the current template",
    repro: [
      { kind: 'duplicate', u: [0.02, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'undo', u: [0, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'prefabEdit', u: [0.3, 0.1, 0, 0, 0, 0, 0, 0], inner: [{ kind: 'addChild', u: [0.5, 0.5, 0.5, 0, 0, 0, 0, 0] }] },
      { kind: 'redo', u: [0, 0, 0, 0, 0, 0, 0, 0] },
    ],
  },
  {
    issue: 1820,
    what: "(close-out sweep) Duplicate's redo after a SAVED prefab edit (delete) respawns the copy on the current template",
    repro: [
      { kind: 'duplicate', u: [0.02, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'undo', u: [0, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'prefabEdit', u: [0.3, 0.1, 0, 0, 0, 0, 0, 0], inner: [{ kind: 'delete', u: [0.5, 0.5, 0.5, 0, 0, 0, 0, 0] }] },
      { kind: 'redo', u: [0, 0, 0, 0, 0, 0, 0, 0] },
    ],
  },
  {
    issue: 1820,
    what: "Create Prefab over a tree holding a prefab instance (a legal pick after #1869), a SAVED prefab edit, then the create's undo re-links: the live tree gains the member the saved edit duplicated (a legal route, after #1869)",
    repro: [
      { kind: 'createPrefab', u: [0.02, 0.9, 0, 0, 0, 0, 0, 0] },
      { kind: 'prefabEdit', u: [0.3, 0.1, 0, 0, 0, 0, 0, 0], inner: [{ kind: 'duplicate', u: [0.5, 0.5, 0.5, 0, 0, 0, 0, 0] }] },
      { kind: 'undo', u: [0, 0, 0, 0, 0, 0, 0, 0] },
    ],
  },
  {
    issue: 1820,
    what: "Create Prefab over a tree holding a prefab instance (a legal pick after #1869), a SAVED prefab edit, then the create's undo re-links: the live tree gains the child the saved edit added (a legal route, after #1869)",
    repro: [
      { kind: 'createPrefab', u: [0.02, 0.9, 0, 0, 0, 0, 0, 0] },
      { kind: 'prefabEdit', u: [0.3, 0.1, 0, 0, 0, 0, 0, 0], inner: [{ kind: 'addChild', u: [0.5, 0.5, 0.5, 0, 0, 0, 0, 0] }] },
      { kind: 'undo', u: [0, 0, 0, 0, 0, 0, 0, 0] },
    ],
  },
  {
    issue: 1820,
    what: "Create Prefab over a tree holding a prefab instance (a legal pick after #1869), a SAVED prefab edit, then the create's undo re-links: the live tree loses the member the saved edit deleted (a legal route, after #1869)",
    repro: [
      { kind: 'createPrefab', u: [0.02, 0.9, 0, 0, 0, 0, 0, 0] },
      { kind: 'prefabEdit', u: [0.3, 0.1, 0, 0, 0, 0, 0, 0], inner: [{ kind: 'delete', u: [0.5, 0.5, 0.5, 0, 0, 0, 0, 0] }] },
      { kind: 'undo', u: [0, 0, 0, 0, 0, 0, 0, 0] },
    ],
  },
  {
    issue: 1820,
    what: "a paste of an instance copied before its template changed respawns the stale frame, and nothing rebases it",
    repro: [
      { kind: 'copy', u: [0.003, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'editField', u: [0.656, 0.0, 0.75, 0, 0, 0, 0, 0] },
      { kind: 'apply', u: [0.2, 0.1, 0, 0.9, 0, 0.9, 0, 0] },
      { kind: 'paste', u: [0.1, 0, 0, 0, 0, 0, 0, 0] },
    ],
  },
  {
    issue: 1820,
    what: "the same missing rebase, through Create Prefab's undo: it re-links the tree to its old template's stale expansion",
    repro: [
      { kind: 'createPrefab', u: [0.9428159724920988, 0.9500395997893065, 0.8217625359538943, 0.2986950015183538, 0.315559288719669, 0.43765105050988495, 0.01984696416184306, 0.9973117003683001] },
      { kind: 'createPrefab', u: [0.0017358909826725721, 0.3970535541884601, 0.538624168606475, 0.21942522306926548, 0.32584577915258706, 0.5943802592810243, 0.018516797805204988, 0.8010917166247964] },
      { kind: 'prefabEdit', u: [0.4197337697260082, 0.45629017311148345, 0.9499380351044238, 0.30179717764258385, 0.4023724365979433, 0.017604060005396605, 0.281649986281991, 0.47618820145726204], inner: [{ kind: 'instantiate', u: [0.7530755579937249, 0.7304247959982604, 0.6359159634448588, 0.5732636176981032, 0.24562921142205596, 0.715872710570693, 0.18062788620591164, 0.5258615149650723] }] },
      { kind: 'undo', u: [0.9111525018233806, 0.4756720804143697, 0.2995174073148519, 0.8736095151398331, 0.7850008409004658, 0.6371805649250746, 0.5273122461512685, 0.5875295428559184] },
    ],
  },
  {
    issue: 1820,
    what: "the same, through Paste's redo: the walk undoes and redoes a paste made before the template changed",
    repro: [
      { kind: 'instantiate', u: [0.611175028141588, 0.6514599523507059, 0.2609965375158936, 0.13653228152543306, 0.08117494895122945, 0.229994123801589, 0.19415682554244995, 0.2312458292581141] },
      { kind: 'prefabEdit', u: [0.0025320895947515965, 0.5545158837921917, 0.3194682211615145, 0.6602701237425208, 0.8647226733155549, 0.30973603832535446, 0.06382799847051501, 0.20962068950757384], inner: [] },
      { kind: 'reparent', u: [0.05289468914270401, 0.5114942493382841, 0.9024173587094992, 0.7742977037560195, 0.22715402184985578, 0.8201705161482096, 0.34489292302168906, 0.49780966504476964] },
      { kind: 'copy', u: [0.27074809931218624, 0.14453188236802816, 0.6524580360855907, 0.7346509259659797, 0.5130745004862547, 0.6953973234631121, 0.5576475753914565, 0.6048628408461809] },
      { kind: 'paste', u: [0.2788585058879107, 0.6411802317015827, 0.13857184490188956, 0.7241594886872917, 0.5755924703553319, 0.21859576366841793, 0.999815168324858, 0.40587658691219985] },
      { kind: 'prefabEdit', u: [0.6, 0.6434368717018515, 0.49586298945359886, 0.5223652205895633, 0.1734591640997678, 0.8727238741703331, 0.5582645458634943, 0.7902071727439761], inner: [{ kind: 'duplicate', u: [0.2632118870969862, 0.7401458392851055, 0.20006573991850019, 0.8598092638421804, 0.1768859124276787, 0.5392143279314041, 0.14166608965024352, 0.4079057138878852] }] },
      { kind: 'revert', u: [0.2899708952754736, 0.8689476081635803, 0.3784734313376248, 0.317490870365873, 0.01880230032838881, 0.8135771653614938, 0.9818330009002239, 0.4641318661160767] },
    ],
  },
  {
    issue: 1820,
    what: "a paste after an Apply removed a member of the copied instance keeps the member out (the body's member-lost repro)",
    repro: [
      { kind: 'delete', u: [0.831,  0,  0,  0,  0,  0,  0,  0] },
      { kind: 'copy', u: [0.003,  0,  0,  0,  0,  0,  0,  0] },
      { kind: 'apply', u: [0.78,  0.1,  0,  0.9,  0,  0.9,  0,  0] },
      { kind: 'paste', u: [0.577,  0.746,  0.068,  0.977,  0,  0,  0,  0] },
    ],
  },
  {
    issue: 1820,
    what: "(win seed 4483) copy, paste, Apply, paste: the second paste takes the nodes the Apply added",
    repro: [
      { kind: 'copy', u: [0.14698627777397633,  0.8868070221506059,  0.6764130680821836,  0.12952746218070388,  0.9193068437743932,  0.6101939009968191,  0.5648398445919156,  0.9099759007804096] },
      { kind: 'paste', u: [0.37339868303388357,  0.44922571652568877,  0.5820887528825551,  0.49615396675653756,  0.9435655698180199,  0.13738775975070894,  0.12296006875112653,  0.7920071498956531] },
      { kind: 'apply', u: [0.8779937496874481,  0.456387547776103,  0.8912423599977046,  0.7217436714563519,  0.495892170118168,  0.6126101936679333,  0.787758517311886,  0.608392120571807] },
      { kind: 'paste', u: [0.04270838829688728,  0.0985837762709707,  0.7681965220253915,  0.36397526366636157,  0.6696740563493222,  0.19381232536397874,  0.8067189394496381,  0.904827953549102] },
    ],
  },
  {
    issue: 1820,
    what: "(win seed 3166) a paste after a saved prefab-edit Duplicate takes the node it added",
    repro: [
      { kind: 'copy', u: [0.04884834960103035,  0.9628134244121611,  0.6216103117913008,  0.943275434197858,  0.3188887434080243,  0.49192826147191226,  0.01156065403483808,  0.1593283291440457] },
      { kind: 'prefabEdit', u: [0.6315673277713358,  0.14461058238521218,  0.11123886378481984,  0.7670094554778188,  0.8188522597774863,  0.0583918709307909,  0.013477355008944869,  0.12268179678358138], inner: [{ kind: 'duplicate', u: [0.2379663127940148, 0.45252525829710066, 0.1845254492945969, 0.7645223236177117, 0.5730074837338179, 0.899197322782129, 0.7565395457204431, 0.7873528709169477] }] },
      { kind: 'paste', u: [0.9393777602817863,  0.099418064346537,  0.08656460558995605,  0.9402495534159243,  0.2995231195818633,  0.0953779045958072,  0.24812181666493416,  0.1979106201324612] },
    ],
  },
  {
    issue: 1820,
    what: "(win seed 4174) a stale paste's parentId",
    repro: [
      { kind: 'instantiate', u: [0.817225489532575,  0.6150298537686467,  0.43410562071949244,  0.8474213990848511,  0.6080710273236036,  0.3496287034358829,  0.8644047558773309,  0.6105031108018011] },
      { kind: 'delete', u: [0.7614817498251796,  0.6651264014653862,  0.30778774223290384,  0.6466251155361533,  0.7594433417543769,  0.3746901412960142,  0.2749748737551272,  0.4335338482633233] },
      { kind: 'delete', u: [0.4055223378818482,  0.785919364541769,  0.9767264937981963,  0.07617654372006655,  0.9242184786126018,  0.44334669318050146,  0.9296723406296223,  0.5644315637182444] },
      { kind: 'copy', u: [0.08672260493040085,  0.0018634560983628035,  0.5823962264694273,  0.045332242269068956,  0.43199025304056704,  0.18286233744584024,  0.08787737437523901,  0.23212941782549024] },
      { kind: 'reparent', u: [0.8342625887598842,  0.4582651359960437,  0.7787502971477807,  0.6373671570327133,  0.9003852005116642,  0.5240210210904479,  0.5465208550449461,  0.62540562893264] },
      { kind: 'paste', u: [0.7858088326174766,  0.14560177107341588,  0.7896528092678636,  0.3082289642188698,  0.8933009491302073,  0.5416892601642758,  0.6897593471221626,  0.8406567722558975] },
      { kind: 'apply', u: [0.1184677709825337,  0.4642320699058473,  0.25585719337686896,  0.2426652645226568,  0.11545071564614773,  0.204954867484048,  0.5391937966924161,  0.16870146454311907] },
      { kind: 'paste', u: [0.21386439935304224,  0.6408156936522573,  0.15152453840710223,  0.8387568793259561,  0.10223349533043802,  0.4221818440128118,  0.686126304557547,  0.35632232297211885] },
    ],
  },
  {
    issue: 1820,
    what: "(win seed 3097) a stale paste's override marks",
    repro: [
      { kind: 'editField', u: [0.44951570802368224,  0.344752277713269,  0.999486313899979,  0.2983108488842845,  0.5319882414769381,  0.9581097902264446,  0.5708246517460793,  0.9445934095419943] },
      { kind: 'copy', u: [0.08305942406877875,  0.5127813585568219,  0.33668679813854396,  0.29134805290959775,  0.04606970283202827,  0.6994702997617424,  0.7973081469535828,  0.8558187852613628] },
      { kind: 'apply', u: [0.5542727666907012,  0.9195215618237853,  0.3982940942514688,  0.6734568581450731,  0.5898221214301884,  0.316782349254936,  0.16543398541398346,  0.34312310721725225] },
      { kind: 'paste', u: [0.8655595844611526,  0.11952090612612665,  0.3953531668521464,  0.2899504494853318,  0.147352792089805,  0.3629837108310312,  0.20817722426727414,  0.7508443302940577] },
    ],
  },
  {
    issue: 1820,
    what: "(win seed 3356) a stale paste's added component",
    repro: [
      { kind: 'addChild', u: [0.6022028226871043,  0.4916789522394538,  0.5374829324427992,  0.7261641579680145,  0.3992758134845644,  0.12593218218535185,  0.4906459131743759,  0.3929682292509824] },
      { kind: 'copy', u: [0.29138847370631993,  0.34229610906913877,  0.5704484961461276,  0.27208092506043613,  0.9787884801626205,  0.2521947417408228,  0.88076506042853,  0.6224663273897022] },
      { kind: 'reparent', u: [0.4728145166300237,  0.250552580691874,  0.9423649744130671,  0.6085743457078934,  0.5756158044096082,  0.7312585986219347,  0.18250082153826952,  0.6265484702307731] },
      { kind: 'addComponent', u: [0.08710776804946363,  0.0006227344274520874,  0.8525324119254947,  0.4319694945588708,  0.7389313839375973,  0.4417040063999593,  0.30046098539605737,  0.21890126774087548] },
      { kind: 'revert', u: [0.4148508314974606,  0.1469713319092989,  0.0740816555917263,  0.5004145568236709,  0.15684673166833818,  0.8724640819709748,  0.6221436758060008,  0.5350111455190927] },
      { kind: 'apply', u: [0.35009047063067555,  0.8993905920069665,  0.5499130950774997,  0.28416696353815496,  0.09081994113512337,  0.5930697214789689,  0.9242638661526144,  0.09549329965375364] },
      { kind: 'paste', u: [0.1993531279731542,  0.8867862697225064,  0.02726888144388795,  0.8469348920043558,  0.6183840627782047,  0.9696976784616709,  0.34751853812485933,  0.0024959484580904245] },
    ],
  },
  {
    issue: 1820,
    what: "(#1859, hunt seed 250) copy, outside edit, paste: the reload gains no entity",
    repro: [
      { kind: 'copy', u: [0.07701369072310627,  0.7822557620238513,  0.4572561925742775,  0.28865382075309753,  0.7458809961099178,  0.5401038848794997,  0.2584418347105384,  0.8851113333366811] },
      { kind: 'outsideEdit', u: [0.9907738657202572,  0.8173439735546708,  0.17939582420513034,  0.874272549059242,  0.2045294945128262,  0.5903447051532567,  0.7981432392261922,  0.7445750313345343] },
      { kind: 'paste', u: [0.22224835772067308,  0.7978167883120477,  0.6313734378200024,  0.970457072602585,  0.4196247239597142,  0.7648493445012718,  0.1068376547191292,  0.39006769354455173] },
    ],
  },
  {
    issue: 1796,
    what: "a Duplicate inside an instance: save → reload → save is byte-identical (nested node lists in sibling order)",
    repro: [
      { kind: 'duplicate', u: [0.38699243287555873, 0.5160500674974173, 0.7015982300508767, 0.7498073864262551, 0.12323614209890366, 0.09115325007587671, 0.3395281918346882, 0.4878639730159193] },
    ],
  },
  {
    issue: 1796,
    what: "Create Prefab's redo after a reload re-tags the tree it rewrote (collectTree in sibling order, as the write was)",
    repro: [
      { kind: 'duplicate', u: [0.0005, 0.7639, 0.1438, 0.6678, 0.7747, 0.344, 0.5285, 0.0697] },
      { kind: 'saveReload', u: [0.9055, 0.5241, 0.2558, 0.4764, 0.7382, 0.6179, 0.362, 0.2463] },
      { kind: 'createPrefab', u: [0.2822, 0.0907, 0.9868, 0.1901, 0.0497, 0.3445, 0.7354, 0.5284] },
      { kind: 'prefabEdit', u: [0.7606, 0.2686, 0.3478, 0.6593, 0.9336, 0.4852, 0.8874, 0.3418], inner: [] },
    ],
  },
  {
    issue: 1796,
    what: "the same redo, where the walk's scene diff showed the tree's added node missing",
    repro: [
      { kind: 'duplicate', u: [0.033303552540019155, 0.6072016530670226, 0.17860231618396938, 0.36060059955343604, 0.24519648379646242, 0.01585288904607296, 0.7660753296222538, 0.0734335642773658] },
      { kind: 'createPrefab', u: [0.20849957410246134, 0.6444018911570311, 0.005679936148226261, 0.3887866751756519, 0.5991325152572244, 0.022242528619244695, 0.49629448540508747, 0.33016981394030154] },
    ],
  },
  {
    issue: 1796,
    what: "the same redo after an outside edit and a reparent: Create Prefab's redo re-tags instead of refusing",
    repro: [
      { kind: 'outsideEdit', u: [0.6936206261161715, 0.17782395984977484, 0.5137411751784384, 0.7149697851855308, 0.9969790095929056, 0.16907001845538616, 0.6203795957844704, 0.5160340690053999] },
      { kind: 'reparent', u: [0.315277598798275, 0.917392787989229, 0.9138918148819357, 0.2863043069373816, 0.8894691378809512, 0.4289656088221818, 0.22244959813542664, 0.5512217737268656] },
      { kind: 'createPrefab', u: [0.9434425951912999, 0.18627188983373344, 0.7050830235239118, 0.7845574729144573, 0.4535193827468902, 0.8970362835098058, 0.007119981572031975, 0.06791658839210868] },
      { kind: 'reparent', u: [0.926001786487177, 0.07603803905658424, 0.059589676558971405, 0.6357310710009187, 0.21650824113748968, 0.9080651458352804, 0.8035988812334836, 0.2351431674323976] },
    ],
  },
  {
    issue: 1831,
    what: "(G1 M2) a prefab dropped under a Missing Prefab placeholder in prefab edit is refused, where the save wrote it as a row every expansion re-homed outside the instance (hunt seed 315, #1861)",
    repro: [
      { kind: 'apply', u: [0.3908089795149863, 0.03656577807851136, 0.12329709646292031, 0.19279956631362438, 0.7911372233647853, 0.42535790032707155, 0.9330323494505137, 0.2303955622483045] },
      { kind: 'trashPrefab', u: [0.8698484501801431, 0.9432446954306215, 0.7018947280012071, 0.41346723260357976, 0.47552838386036456, 0.08532690536230803, 0.5476820175535977, 0.7256320039741695] },
      { kind: 'prefabEdit', u: [0.2880415425170213, 0.275979372439906, 0.6388688392471522, 0.8064999668858945, 0.21602211706340313, 0.5039041882846504, 0.6194102934096009, 0.3749129925854504], inner: [{ kind: 'instantiate', u: [0.7795347538776696, 0.9812039197422564, 0.2718967793043703, 0.26789398794062436, 0.5382205301430076, 0.8254823936149478, 0.9744059327058494, 0.8570319171994925] }] },
    ],
  },
  {
    issue: 1831,
    what: "(harness, G1 M1) trash P, then instantiate O, which nests P: the live world holds kept P frames beside O's unexpanded P row, and the restored comparison lets that row come back expanded (hunt seed 351, #1856)",
    repro: [
      { kind: 'trashPrefab', u: [0.6031674689147621, 0.32979793287813663, 0.8048893548548222, 0.19987819739617407, 0.7723878214601427, 0.4218790833838284, 0.6704246983863413, 0.05371444392949343] },
      { kind: 'instantiate', u: [0.6069244958925992, 0.263748875586316, 0.16720971977338195, 0.9911824848968536, 0.17673206329345703, 0.3720341839361936, 0.936112288152799, 0.7757013773079962] },
    ],
  },
  {
    issue: 1831,
    what: "(harness, G1 M1) the same two ops (hunt seed 6030)",
    repro: [
      { kind: 'trashPrefab', u: [0.5406942241825163, 0.39389731688424945, 0.8374803350307047, 0.07660906296223402, 0.9091866982635111, 0.5265559710096568, 0.9305080221965909, 0.61383136222139] },
      { kind: 'instantiate', u: [0.4133435436524451, 0.964117540512234, 0.26380765507929027, 0.9943990514148027, 0.7428998670075089, 0.7959617732558399, 0.21524300938472152, 0.7997799264267087] },
    ],
  },
  {
    issue: 1831,
    what: "(harness, G1 M1/M5) a kept frame's reparent and Apply before the round trip, which then failed as M1 (hunt seed 5104)",
    repro: [
      { kind: 'prefabEdit', u: [0.8762713158503175, 0.03239666367881, 0.11954150861129165, 0.9196045729331672, 0.3753566930536181, 0.5589897979516536, 0.26667742733843625, 0.9626793242059648], inner: [{kind: 'delete', u: [0.4095847448334098, 0.32432481413707137, 0.2858915913384408, 0.7823276342824101, 0.36225294740870595, 0.9154196181334555, 0.005848549073562026, 0.35622050357051194]}, {kind: 'undo', u: [0.33388770720921457, 0.572215726133436, 0.012769023422151804, 0.13426355132833123, 0.418521893909201, 0.9623553154524416, 0.28858965658582747, 0.18201336916536093]}, {kind: 'redo', u: [0.5351214946713299, 0.5260254153981805, 0.0020173119846731424, 0.6366104746703058, 0.5911289998330176, 0.2582283711526543, 0.41223555197939277, 0.9923461589496583]}, {kind: 'redo', u: [0.7061207813676447, 0.712686057202518, 0.991152907256037, 0.697692945599556, 0.8350388244725764, 0.9191796996165067, 0.3809151416644454, 0.5443655350245535]}] },
      { kind: 'editField', u: [0.045991167426109314, 0.5878017456270754, 0.21571285114623606, 0.3114997963421047, 0.5819835742004216, 0.6850799140520394, 0.12637460720725358, 0.4519760166294873] },
      { kind: 'duplicate', u: [0.10059353895485401, 0.006679050391539931, 0.9929867913015187, 0.7155979296658188, 0.25997596280649304, 0.6217055763117969, 0.1602286531124264, 0.2099366073962301] },
      { kind: 'prefabEdit', u: [0.4946770647075027, 0.08963554375804961, 0.11988005670718849, 0.47806615428999066, 0.4943670672364533, 0.8456591481808573, 0.1978523787111044, 0.09641737351194024], inner: [{kind: 'addChild', u: [0.3295794085133821, 0.06753006344661117, 0.441060084849596, 0.97918571671471, 0.05289382766932249, 0.9141601929441094, 0.14959009736776352, 0.3073970442637801]}, {kind: 'editField', u: [0.9809581849258393, 0.4730609059333801, 0.7414809055626392, 0.2291955396067351, 0.3539408487267792, 0.977658994263038, 0.6914279204793274, 0.1953741475008428]}] },
      { kind: 'trashPrefab', u: [0.927127564093098, 0.10882858303375542, 0.22725477372296154, 0.06697932770475745, 0.8154001981019974, 0.6902474502567202, 0.020950040547177196, 0.6087567145004869] },
      { kind: 'cut', u: [0.5244958435650915, 0.35751769761554897, 0.6128346233163029, 0.5644878861494362, 0.9633544192183763, 0.9416227822657675, 0.2057135368231684, 0.3308452139608562] },
      { kind: 'reparent', u: [0.9881515316665173, 0.8432085886597633, 0.5545131105463952, 0.5713310174178332, 0.1701910716947168, 0.638417094014585, 0.023642008658498526, 0.31924578291364014] },
      { kind: 'apply', u: [0.07893647789023817, 0.6977124519180506, 0.8717663588467985, 0.20421823859214783, 0.30533649236895144, 0.28544130153022707, 0.782807320356369, 0.5060831271111965] },
      { kind: 'apply', u: [0.4923210346605629, 0.9308039348106831, 0.45492127956822515, 0.7001701316330582, 0.2540940591134131, 0.9144125154707581, 0.6177542523946613, 0.628542261198163] },
    ],
  },
  {
    issue: 1794,
    what: "Detach's undo after a rebuild (a save and reopen) puts the override marks back with the links",
    repro: [
      { kind: 'editField', u: [0.7083940990269184, 0.0169174384791404, 0.2565192203037441, 0.03183711925521493, 0.5653642797842622, 0.1326391918119043, 0.5866110895294696, 0.39626767858862877] },
      { kind: 'revert', u: [0.3251578959170729, 0.8732641767710447, 0.649110505823046, 0.5803064578212798, 0.13768295058980584, 0.8408704535104334, 0.08907407149672508, 0.48194432351738214] },
      { kind: 'saveReload', u: [0.2398991729132831, 0.9847583954688162, 0.29102227953262627, 0.02259724377654493, 0.9572306799236685, 0.4162498787045479, 0.40120429755188525, 0.5371022578328848] },
      { kind: 'detach', u: [0.15888716746121645, 0.28360947174951434, 0.40143896848894656, 0.5929380359593779, 0.02723632473498583, 0.1597168450243771, 0.8716024786699563, 0.2872234331443906] },
      { kind: 'saveReload', u: [0.2398991729132831, 0.9847583954688162, 0.29102227953262627, 0.02259724377654493, 0.9572306799236685, 0.4162498787045479, 0.40120429755188525, 0.5371022578328848] },
      { kind: 'undo', u: [0.1, 0, 0, 0, 0, 0, 0, 0] },
    ],
  },
  {
    issue: 1794,
    what: "the same, where the rebuild is a prefab-edit visit (discarded)",
    repro: [
      { kind: 'detach', u: [0.7311645969748497, 0.13434822508133948, 0.6695735612884164, 0.40467609371989965, 0.8146500582806766, 0.3963876867201179, 0.7728581817355007, 0.15376638155430555] },
      { kind: 'prefabEdit', u: [0.6097711462061852, 0.9679968729615211, 0.8896497702226043, 0.6608014917001128, 0.03871827572584152, 0.6533970246091485, 0.7404179510194808, 0.898593342397362], inner: [] },
      { kind: 'undo', u: [0.7791260068770498, 0.4710204261355102, 0.7423416944220662, 0.9686100308317691, 0.6743511268869042, 0.028107878752052784, 0.8965767938643694, 0.07950291177257895] },
    ],
  },
  {
    issue: 1800,
    what: "Remove Component's undo after a rebuild puts the trait's override marks back with its data",
    repro: [
      { kind: 'addComponent', u: [0.04622375639155507, 0.8679626227822155, 0.5392347774468362, 0.8630144654307514, 0.9499282059259713, 0.10872479528188705, 0.9486257375683635, 0.5012652326840907] },
      { kind: 'saveReload', u: [0.5743842197116464, 0.5823324527591467, 0.9513287632726133, 0.561390912393108, 0.5752703219186515, 0.47487166756764054, 0.751958251465112, 0.3308712081052363] },
      { kind: 'removeComponent', u: [0.00905785127542913, 0.22686874470673501, 0.2879236890003085, 0.24362082383595407, 0.6656269864179194, 0.9177013242151588, 0.7928349012508988, 0.6064457197207958] },
      { kind: 'saveReload', u: [0.3872559634037316, 0.8000171624589711, 0.39061477268114686, 0.859410464996472, 0.5958437048830092, 0.22173328371718526, 0.04321353812702, 0.29053033818490803] },
      { kind: 'undo', u: [0.1, 0.8564995671622455, 0.028990152990445495, 0.40797109180130064, 0.27484340965747833, 0.013096533715724945, 0.5823551893699914, 0.8294616998173296] },
    ],
  },
  {
    issue: 1853,
    what: "(= #1794) the walk back undoes a Detach after the harness's own rebuild, and the override on a nested member's node comes back (hunt seed 6087)",
    repro: [
      { kind: 'instantiate', u: [0.4958001433406025, 0.9933914628345519, 0.8621986652724445, 0.9129769320134073, 0.9550560568459332, 0.7320429892279208, 0.36834096908569336, 0.1779365090187639] },
      { kind: 'editField', u: [0.7658654053229839, 0.5828684126026928, 0.26566317467950284, 0.8645212210249156, 0.6982378463726491, 0.03960793744772673, 0.4703221304807812, 0.2528622676618397] },
      { kind: 'instantiate', u: [0.5470902191009372, 0.005061320029199123, 0.8217660302761942, 0.5680111183319241, 0.254648566711694, 0.44432157394476235, 0.9997235012706369, 0.18344404874369502] },
      { kind: 'saveReload', u: [0.4132570163346827, 0.22490270482376218, 0.5335985405836254, 0.862965201260522, 0.24294171226210892, 0.9383475778158754, 0.29503892874345183, 0.809835129417479] },
      { kind: 'delete', u: [0.0017916676588356495, 0.4368070533964783, 0.8778917125891894, 0.05161455343477428, 0.8438828259240836, 0.6449701045639813, 0.8938427921384573, 0.8314062415156513] },
      { kind: 'outsideEdit', u: [0.6400234792381525, 0.27181832725182176, 0.024887696374207735, 0.885961135616526, 0.0028845760971307755, 0.08188677625730634, 0.6887743698898703, 0.955180544173345] },
      { kind: 'detach', u: [0.08807741408236325, 0.10626039654016495, 0.9645472010597587, 0.26626585330814123, 0.6125111044384539, 0.8029847529251128, 0.07278828858397901, 0.2700370503589511] },
    ],
  },
  {
    issue: 1853,
    what: "(= #1794) the walk back undoes a Detach after the harness's own rebuild, and the override on a nested member's node comes back (hunt seed 6109)",
    repro: [
      { kind: 'editField', u: [0.9563650840427727, 0.6968450252898037, 0.1812881943769753, 0.6340484376996756, 0.029774640453979373, 0.3510514812078327, 0.9594724716152996, 0.3907597882207483] },
      { kind: 'saveReload', u: [0.7666770084761083, 0.32212803652510047, 0.10385906370356679, 0.45059898728504777, 0.8715650143567473, 0.2680442896671593, 0.9257945362478495, 0.10773271298967302] },
      { kind: 'editField', u: [0.48148609744384885, 0.4378839689306915, 0.8468391234055161, 0.875778567045927, 0.9129177483264357, 0.9822637075558305, 0.7713747576344758, 0.9594852416776121] },
      { kind: 'outsideEdit', u: [0.005989656783640385, 0.6633210831787437, 0.42878120532259345, 0.02379626384936273, 0.8184052540455014, 0.4503943717572838, 0.42990011954680085, 0.10540786129422486] },
      { kind: 'detach', u: [0.17269613104872406, 0.1615541041828692, 0.8668985774274915, 0.5546304748859257, 0.45013354416005313, 0.739486396079883, 0.4945334333460778, 0.46190282446332276] },
    ],
  },
  {
    issue: 1853,
    what: "(= #1794) the walk back undoes a Detach after the harness's own rebuild, and the override on a nested member's node comes back (hunt seed 6166)",
    repro: [
      { kind: 'instantiate', u: [0.1722705082502216, 0.20646521216258407, 0.9163745681289583, 0.35885839140973985, 0.4283213010057807, 0.27427971828728914, 0.1254317881539464, 0.002507308730855584] },
      { kind: 'delete', u: [0.14463656721636653, 0.6048953228164464, 0.9092781394720078, 0.16894183098338544, 0.9546529049985111, 0.9032158243935555, 0.20257026981562376, 0.7359322600532323] },
      { kind: 'createPrefab', u: [0.8730226962361485, 0.6883791282307357, 0.6404436810407788, 0.8511412811931223, 0.17764744814485312, 0.709213136928156, 0.13330397987738252, 0.916937600588426] },
      { kind: 'duplicate', u: [0.4656525554601103, 0.20829126378521323, 0.0716027794405818, 0.5933632892556489, 0.2648729970678687, 0.32750012422911823, 0.7723305667750537, 0.035795163828879595] },
      { kind: 'saveReload', u: [0.4827929309103638, 0.9892113711684942, 0.8611792554147542, 0.8838127790950239, 0.3285517916083336, 0.3393422008957714, 0.11388191627338529, 0.767454368295148] },
      { kind: 'editField', u: [0.4490274842828512, 0.22947565210051835, 0.4561280212365091, 0.660720840562135, 0.14500329224392772, 0.2295544403605163, 0.28763984935358167, 0.5483834692277014] },
      { kind: 'outsideEdit', u: [0.6765512053389102, 0.19844429777003825, 0.6794580353889614, 0.1354533825069666, 0.48677810351364315, 0.10395694524049759, 0.5247092535719275, 0.3334756614640355] },
      { kind: 'addChild', u: [0.4140205346047878, 0.35981202218681574, 0.8543530541937798, 0.007702372269704938, 0.045497375540435314, 0.3322739687282592, 0.9358643072191626, 0.30977208726108074] },
      { kind: 'reparent', u: [0.4875489401165396, 0.5909467614255846, 0.8027804822195321, 0.7197152033913881, 0.7314386477228254, 0.47457761969417334, 0.2133487220853567, 0.6024461854249239] },
      { kind: 'apply', u: [0.38637993414886296, 0.28908913722261786, 0.7344025261700153, 0.274497956270352, 0.3908881959505379, 0.7239622462075204, 0.1350111234933138, 0.43930516112595797] },
      { kind: 'undo', u: [0.6394226702395827, 0.3879869170486927, 0.795726546086371, 0.48083597561344504, 0.21863605896942317, 0.5768737194593996, 0.1447921812068671, 0.6521895630285144] },
      { kind: 'detach', u: [0.5321197928860784, 0.5939120119437575, 0.5392061555758119, 0.1088714967481792, 0.2929844402242452, 0.9944824411068112, 0.23206801898777485, 0.8049849283415824] },
    ],
  },
  {
    issue: 1831,
    what: "(= #1794) seed 63 with a save, a reopen and the Detach's undo appended: the next round trip keeps the marks",
    repro: [
      { kind: 'duplicate', u: [0.021626295056194067, 0.9448791488539428, 0.5488163251429796, 0.2074153374414891, 0.09146336675621569, 0.6330600001383573, 0.05427237902767956, 0.5054511388298124] },
      { kind: 'saveReload', u: [0.8530344092287123, 0.9759107395075262, 0.6467963447794318, 0.452473109588027, 0.5527505369391292, 0.907866015098989, 0.9856647453270853, 0.163215727545321] },
      { kind: 'renamePrefab', u: [0.39797093835659325, 0.9346814232412726, 0.19760007015429437, 0.4643807352986187, 0.25796109274961054, 0.020594365429133177, 0.717780799837783, 0.28149340650998056] },
      { kind: 'outsideEdit', u: [0.26882588444277644, 0.8606790986377746, 0.5751630233135074, 0.5883123665116727, 0.6345254555344582, 0.5665456287097186, 0.9513689226005226, 0.15337868151254952] },
      { kind: 'detach', u: [0.1446664254181087, 0.9234078116714954, 0.3712811500299722, 0.3836844807956368, 0.8891595841851085, 0.5820841509848833, 0.07788186823017895, 0.7306096281390637] },
      { kind: 'saveReload', u: [0.24, 0.98, 0.29, 0.02, 0.96, 0.42, 0.4, 0.54] },
      { kind: 'undo', u: [0.1, 0, 0, 0, 0, 0, 0, 0] },
    ],
  },
  {
    issue: 1831,
    what: "(= #1794) seed 107 with a save, a reopen and the Detach's undo appended: the next round trip keeps the marks",
    repro: [
      { kind: 'copy', u: [0.32529376936145127, 0.3525210786610842, 0.8291352614760399, 0.1429842715151608, 0.5948686129413545, 0.5451861249748617, 0.08171302964910865, 0.22260460956022143] },
      { kind: 'paste', u: [0.6029266156256199, 0.9945501068141311, 0.9572499892674387, 0.6824461920186877, 0.1936525320634246, 0.15427791187539697, 0.6963595051784068, 0.6199092876631767] },
      { kind: 'saveReload', u: [0.816602504812181, 0.9164635692723095, 0.9323501212056726, 0.78107467177324, 0.04326618672348559, 0.2757718206848949, 0.0005588340573012829, 0.8054400233086199] },
      { kind: 'renamePrefab', u: [0.009989902377128601, 0.1960589555092156, 0.3518118236679584, 0.9397004882339388, 0.9010002051945776, 0.7113523299340159, 0.7163461239542812, 0.18047817121259868] },
      { kind: 'outsideEdit', u: [0.8484079877380282, 0.2949926636647433, 0.007929783314466476, 0.673268812475726, 0.489887161180377, 0.19081966672092676, 0.6642701874952763, 0.6880893129855394] },
      { kind: 'duplicate', u: [0.337531310506165, 0.9653639036696404, 0.45448930794373155, 0.17932283855043352, 0.3504884091671556, 0.7672032655682415, 0.9019996160641313, 0.4930025930516422] },
      { kind: 'detach', u: [0.5541364219971001, 0.36246725684031844, 0.8192624447401613, 0.3963077152147889, 0.7086152834817767, 0.35569064202718437, 0.16836523916572332, 0.20946468762122095] },
      { kind: 'saveReload', u: [0.24, 0.98, 0.29, 0.02, 0.96, 0.42, 0.4, 0.54] },
      { kind: 'undo', u: [0.1, 0, 0, 0, 0, 0, 0, 0] },
    ],
  },
  {
    issue: 1795,
    what: "(harness) Create Prefab's undo refused after a prefab-edit save, in its tree-check wording: expected, and forgiven in the tainted segment (hunt seed 6103)",
    repro: [
      { kind: 'createPrefab', u: [0.24430793477222323, 0.5578774318564683, 0.44810137269087136, 0.10805997927673161, 0.10153932473622262, 0.8677448665257543, 0.9063538603950292, 0.1537257907912135] },
      { kind: 'prefabEdit', u: [0.21278736181557178, 0.1596795073710382, 0.2053778253030032, 0.339336343575269, 0.7885611937381327, 0.17296946281567216, 0.45481607667170465, 0.247781571932137], inner: [{ kind: 'addComponent', u: [0.2794236254412681, 0.437290902948007, 0.19698106171563268, 0.22118132980540395, 0.048200189135968685, 0.9753480581566691, 0.8320993515662849, 0.2162562918383628] }] },
    ],
  },
  {
    issue: 1837,
    what: "a Replace over a prefab from a different tree keeps localId 1 bound to the old root's node (I4), and the walk back through it passes (hunt seed 4980, Mac; it was #1821 route 2's repro until #1795 left the create's file in place)",
    repro: [
      { kind: 'detach', u: [0.24958215770311654, 0.44152918620966375, 0.8984461007639766, 0.7383312478195876, 0.5952132367528975, 0.7539820002857596, 0.7765414610039443, 0.2380422039423138] },
      { kind: 'reparent', u: [0.31711865961551666, 0.9896594546735287, 0.9932775064371526, 0.6025639378931373, 0.96449003694579, 0.06188184628263116, 0.9392736088484526, 0.22530514118261635] },
      { kind: 'duplicate', u: [0.6615225882269442, 0.2622203284408897, 0.5295452964492142, 0.9772655258420855, 0.8154521533288062, 0.8149651174899191, 0.37671069288626313, 0.9834790374152362] },
      { kind: 'duplicate', u: [0.3719844911247492, 0.3338841567747295, 0.46974579221569, 0.7407463123090565, 0.8855832503177226, 0.9122256592381746, 0.5009035964030772, 0.8939542740117759] },
      { kind: 'undo', u: [0.37838583951815963, 0.8508917058352381, 0.4453392345458269, 0.06471602735109627, 0.8773009078577161, 0.5875511111225933, 0.07360643381252885, 0.17861990840174258] },
      { kind: 'createPrefab', u: [0.8534675752744079, 0.015578718390315771, 0.9201763307210058, 0.44044428248889744, 0.736804960295558, 0.7156405262649059, 0.14698713622055948, 0.43389102374203503] },
      { kind: 'createPrefab', u: [0.9554856207687408, 0.0850175938103348, 0.9533656612038612, 0.9244284078013152, 0.7588050169870257, 0.5099546790588647, 0.520374397514388, 0.08186750300228596] },
    ],
  },
  {
    issue: 1849,
    what: "(harness) a swap that leaves a nested frame of a trashed prefab UNEXPANDED taints as ruling R — its members are gone, not placeholders (work-ai3 hunt seed 6191; #1849's seeds under prune). With the loader's delete eviction (#1834) the swap and the refusal fall in ONE `undo` op — the Apply's undo reloads, the next undo in the op refuses — so the taint is taken before the op's refusal is judged (#1862)",
    repro: [
      { kind: 'instantiate', u: [0.5197782325558364, 0.8788099023513496, 0.7218048402573913, 0.38950273185037076, 0.49659334821626544, 0.4644296036567539, 0.8073571014683694, 0.3525339278858155] },
      { kind: 'instantiate', u: [0.8885502920020372, 0.03978240699507296, 0.5181071648839861, 0.01798194320872426, 0.6372697676997632, 0.9517800977919251, 0.43241823813878, 0.5862065297551453] },
      { kind: 'trashPrefab', u: [0.5265531395561993, 0.37663424806669354, 0.6686670721974224, 0.4929392503108829, 0.6694031935185194, 0.0497262105345726, 0.9948387288022786, 0.4772849741857499] },
      { kind: 'addComponent', u: [0.44360926025547087, 0.2595970721449703, 0.6613509301096201, 0.8240651376545429, 0.5745828275103122, 0.27813824848271906, 0.13981691538356245, 0.9998946678824723] },
      { kind: 'detach', u: [0.45435963617637753, 0.11783441039733589, 0.7403156065847725, 0.474913319805637, 0.8912695015314966, 0.032363265519961715, 0.588015757733956, 0.0006292278412729502] },
      { kind: 'addChild', u: [0.2904052436351776, 0.22452195966616273, 0.4735311917029321, 0.24861586512997746, 0.6931021737400442, 0.4886781834065914, 0.7541276377160102, 0.19028105004690588] },
      { kind: 'apply', u: [0.21978989453054965, 0.5785240884870291, 0.895742590771988, 0.681806655600667, 0.5302156871184707, 0.1434090519323945, 0.16105769434943795, 0.7953095901757479] },
      { kind: 'undo', u: [0.5353207942098379, 0.513355860253796, 0.39604073972441256, 0.6545602204278111, 0.41435385402292013, 0.18229086161591113, 0.2827563155442476, 0.43774443259462714] },
      { kind: 'prefabEdit', u: [0.05231025302782655, 0.7457796058151871, 0.10294174845330417, 0.30545185203664005, 0.5674001208972186, 0.936231005936861, 0.7218729241285473, 0.39920026273466647], inner: [] },
    ],
  },
  {
    issue: 1856,
    what: 'prune on: trash → addChild → Apply — the Apply\'s fan-out no longer drops the trashed prefab\'s live nested frame (#1862\'s keep), so the comparison reload with the prefab restored gains nothing',
    repro: [
      { kind: 'trashPrefab', u: [0.9616053267382085, 0.8986614316236228, 0.8458665194921196, 0.10550301731564105, 0.36948610469698906, 0.10419670818373561, 0.14534811885096133, 0.3606053702533245] },
      { kind: 'addChild', u: [0.45433683576993644, 0.06991623109206557, 0.36247888510115445, 0.32349463854916394, 0.9636948064435273, 0.36620242870412767, 0.7672389638610184, 0.7997816174756736] },
      { kind: 'apply', u: [0.16332965740002692, 0.7464540000073612, 0.7259030696004629, 0.022606123005971313, 0.05862882686778903, 0.1499764914624393, 0.42986090295016766, 0.5521558525506407] },
    ],
  },
  {
    issue: 1850,
    what: 'a Missing Prefab placeholder of an entry that states its root\'s sortOrder as a root OVERRIDE loads with that sortOrder, so save→reload→save keeps the top-level order (prune on, after a trash)',
    repro: [
      { kind: 'addChild', u: [0.9957377251703292, 0.12976732291281223, 0.2103715562261641, 0.9275979360099882, 0.43928383802995086, 0.07324382080696523, 0.19927202980034053, 0.8402995807118714] },
      { kind: 'duplicate', u: [0.21626306232064962, 0.5490222787484527, 0.789051380706951, 0.16266263229772449, 0.5332405406516045, 0.12282868777401745, 0.042075154604390264, 0.1445559342391789] },
      { kind: 'addChild', u: [0.05152462935075164, 0.5596237492281944, 0.8935148431919515, 0.7301778043620288, 0.6726450177375227, 0.650408998830244, 0.8924802078399807, 0.5835450873710215] },
      { kind: 'duplicate', u: [0.049044220708310604, 0.3174614568706602, 0.8419715336058289, 0.9428341283928603, 0.7418814767152071, 0.5696394266560674, 0.8156659172382206, 0.15937778376974165] },
      { kind: 'trashPrefab', u: [0.6920298747718334, 0.7770941411145031, 0.7189049804583192, 0.4385903417132795, 0.2771018666680902, 0.34832038450986147, 0.43116552801802754, 0.15858133602887392] },
    ],
  },
  {
    issue: 1866,
    what: "an Apply promoting a live instance of a TRASHED prefab P into Q, which P nests, is refused: I16's reader falls back to the document P's live frame was expanded from, so Q → P → Q is never written (work-ai3 hunt seed 6031)",
    repro: [
      { kind: 'addChild', u: [0.4305641388054937, 0.46192985004745424, 0.9784602834843099, 0.21986035979352891, 0.9370753238908947, 0.33278186176903546, 0.1576756751164794, 0.07622262183576822] },
      { kind: 'renamePrefab', u: [0.4414735846221447, 0.24768190551549196, 0.7650708560831845, 0.8969545839354396, 0.78997323801741, 0.6095375462900847, 0.037518877536058426, 0.5313502037897706] },
      { kind: 'reparent', u: [0.09773839451372623, 0.4438950384501368, 0.8722896345425397, 0.9020806809421629, 0.11434697802178562, 0.6160023778211325, 0.45054174098186195, 0.5362555251922458] },
      { kind: 'trashPrefab', u: [0.4194636051543057, 0.9646944224368781, 0.330843408126384, 0.766133475350216, 0.5438984320499003, 0.3454324014019221, 0.15978657128289342, 0.37498119473457336] },
      { kind: 'apply', u: [0.9597498264629394, 0.5389002638403326, 0.10009014303795993, 0.33395626582205296, 0.46827784134075046, 0.47006455273367465, 0.577250886708498, 0.6762503273785114] },
    ],
  },
  {
    issue: 1795,
    what: "create, rename it, create at the freed name, walk: the first create's redo finds its document by guid (hunt seed 6029)",
    repro: [
      { kind: 'addChild', u: [0.47438800777308643, 0.6849050319287926, 0.018786048982292414, 0.41438902798108757, 0.01898742886260152, 0.7009683928918093, 0.10380097082816064, 0.5749734076671302] },
      { kind: 'saveReload', u: [0.9517920373473316, 0.6275642085820436, 0.6845347550697625, 0.034205432049930096, 0.9466571100056171, 0.9330003669019789, 0.9431702268775553, 0.853209639666602] },
      { kind: 'createPrefab', u: [0.954957535257563, 0.8790208585560322, 0.1273031032178551, 0.39226157404482365, 0.8768407960887998, 0.5753853456117213, 0.1393283517099917, 0.7638483592309058] },
      { kind: 'copy', u: [0.0819199294783175, 0.9390344275161624, 0.504217367619276, 0.8227947673294693, 0.1901625671889633, 0.71554422727786, 0.8023586187046021, 0.9949959618970752] },
      { kind: 'paste', u: [0.5775616799946874, 0.951425006147474, 0.29634487093426287, 0.9946444493252784, 0.8024187004193664, 0.6370631060563028, 0.5748223115224391, 0.7400542183313519] },
      { kind: 'delete', u: [0.2557223727926612, 0.6671593459323049, 0.3221927627455443, 0.3245999552309513, 0.780588896246627, 0.012352550867944956, 0.43838050751946867, 0.6093167993240058] },
      { kind: 'renamePrefab', u: [0.29367014579474926, 0.838569869985804, 0.744370064465329, 0.9900823086500168, 0.14166604191996157, 0.6773370199371129, 0.3684174786321819, 0.5982422344386578] },
      { kind: 'createPrefab', u: [0.33827525400556624, 0.7544570425525308, 0.698528251843527, 0.44618354621343315, 0.48049078905023634, 0.0021756314672529697, 0.017819779692217708, 0.9753832877613604] },
    ],
  },
  {
    issue: 1839,
    what: "(harness) outsideEdit wrote a plain row under a REFERENCE row, a shape no editor write produces — a false I7 (win's seed 3130)",
    repro: [
      { kind: 'prefabEdit', u: [0.31428628764115274, 0.3164791292510927, 0.8148758122697473, 0.44748169742524624, 0.9601324021350592, 0.8578238422051072, 0.6915884613990784, 0.03476591291837394], inner: [{ kind: 'duplicate', u: [0.12071382580325007, 0.9100820466410369, 0.5026753153651953, 0.5419060399290174, 0.20003260928206146, 0.6299601232167333, 0.03211430087685585, 0.5577229368500412] }] },
      { kind: 'outsideEdit', u: [0.36192806623876095, 0.3773991058114916, 0.6150501875672489, 0.5344666172750294, 0.6948157059960067, 0.4617444567847997, 0.43642105208709836, 0.91876904014498] },
      { kind: 'instantiate', u: [0.315802268916741, 0.5779164917767048, 0.9913183939643204, 0.28238313808105886, 0.5831954493187368, 0.08192095602862537, 0.1403615267481655, 0.9752809575293213] },
    ],
  },
  {
    issue: 1821,
    what: "Create Prefab's undo after an Apply into the new prefab was undone (fixed with #1795: the undo leaves the file, so there is no trash for a #1774 mark to refuse)",
    repro: [
      { kind: 'createPrefab', u: [0.2059, 0.5, 0, 0, 0, 0, 0, 0] },
      { kind: 'addChild', u: [0.5, 0.2059, 0.1, 0, 0, 0, 0, 0] },
      { kind: 'apply', u: [0.4375, 0.1, 0, 0.9, 0, 0, 0, 0] },
      { kind: 'undo', u: [0.9, 0, 0, 0, 0, 0, 0, 0] },
    ],
  },
  {
    issue: 1835,
    what: "Apply's undo after a Rename (not undoable, #1868 D2) reads the prefab where it is: the move route pushes the renderer's manifest before its repair, as the editor's does (#1828's second route, harness-shaped)",
    repro: [
      { kind: 'apply', u: [0.3302737674675882, 0.2567235822789371, 0.6868790478911251, 0.7366894891019911, 0.12275128113105893, 0.10771414311602712, 0.646984655642882, 0.9300033883191645] },
      { kind: 'renamePrefab', u: [0.2094005134422332, 0.4872707976028323, 0.2897710604593158, 0.9391268761828542, 0.4600680246949196, 0.9581016609445214, 0.701076986733824, 0.585580583428964] },
      { kind: 'detach', u: [0.16811815183609724, 0.4063933831639588, 0.7856829706579447, 0.2869127383455634, 0.6659100251272321, 0.9365419009700418, 0.5917436527088284, 0.9570457476656884] },
    ],
  },
  {
    issue: 1828,
    what: "the Hierarchy drop's redo after a Rename (not undoable, #1868 D2) finds the prefab by the document's guid (`placedPrefabPath`) and tags the instance by it, never a path (setPrefabSource takes the document)",
    repro: [
      { kind: 'instantiate', u: [0.12306458246894181, 0.659326083259657, 0.3238855139352381, 0.3017094286624342, 0.7389431328047067, 0.6331829989794642, 0.8944360001478344, 0.3325171605683863] },
      { kind: 'createPrefab', u: [0.15510661457665265, 0.9943042399827391, 0.9856164292432368, 0.310858246171847, 0.6426518538501114, 0.3538553356193006, 0.2786709980573505, 0.9714844699483365] },
      { kind: 'addChild', u: [0.5799607739318162, 0.2170702046714723, 0.5558724678121507, 0.6893410694319755, 0.011181237641721964, 0.44485651864670217, 0.8736847601830959, 0.8628021879121661] },
      { kind: 'renamePrefab', u: [0.09707820601761341, 0.14232445927336812, 0.9031931138597429, 0.3121798960492015, 0.3815521625801921, 0.3378106460440904, 0.31110939756035805, 0.10088769742287695] },
      { kind: 'prefabEdit', u: [0.5217692020814866, 0.24212318868376315, 0.6475640579592437, 0.7428316583391279, 0.8591179379727691, 0.2987568259704858, 0.37442863010801375, 0.12064710608683527], inner: [] },
      { kind: 'revert', u: [0.4475659942254424, 0.4263928036671132, 0.892479837173596, 0.5712739205919206, 0.016539404401555657, 0.49129072832874954, 0.5349354806821793, 0.03838557889685035] },
    ],
  },
  {
    issue: 1817,
    what: 'a prefab-edit drop of the edited prefab under a nested member is refused, and the save writes no self-containing file',
    repro: [
      { kind: 'prefabEdit', u: [0.3, 0.1, 0, 0, 0, 0, 0, 0], inner: [{ kind: 'instantiate', u: [0.3, 0.5, 0.7, 0, 0, 0, 0, 0] }] },
    ],
  },
  {
    issue: 1817,
    what: 'the same, under a layer-added node',
    repro: [
      { kind: 'prefabEdit', u: [0.3, 0.1, 0, 0, 0, 0, 0, 0], inner: [{ kind: 'instantiate', u: [0.3, 0.5, 0.95, 0, 0, 0, 0, 0] }] },
    ],
  },
  {
    issue: 1836,
    what: 'a prefab-edit reparent of the root is refused, so the delete after it cannot take the root out (seed 4535)',
    repro: [
      { kind: 'renamePrefab', u: [0.6519922227598727, 0.2114757765084505, 0.018607930978760123, 0.30942356470040977, 0.8359362620394677, 0.67055669776164, 0.9231131041888148, 0.44708462059497833] },
      { kind: 'prefabEdit', u: [0.6905049616470933, 0.5051443385891616, 0.16762249427847564, 0.8142847665585577, 0.8068818023893982, 0.18743133172392845, 0.5548743580002338, 0.7678781691938639], inner: [{ kind: 'reparent', u: [0.08123077405616641, 0.6606571737211198, 0.837768564466387, 0.4680335680022836, 0.47950352635234594, 0.8769256870727986, 0.06606265692971647, 0.9000267873052508] }, { kind: 'delete', u: [0.08093803143128753, 0.029633563244715333, 0.4261932633817196, 0.4423936535604298, 0.4413971840403974, 0.8836731656920165, 0.1854370052460581, 0.35569544485770166] }] },
    ],
  },
  {
    issue: 1836,
    what: 'the same in one prefab-edit op (seed 3884)',
    repro: [
      { kind: 'prefabEdit', u: [0.0952886319719255, 0.1324546616524458, 0.7667984003201127, 0.040486402809619904, 0.38836244866251945, 0.164681785274297, 0.0033743923995643854, 0.9235746308695525], inner: [{ kind: 'reparent', u: [0.11242076917551458, 0.3747843843884766, 0.34736537211574614, 0.746526314644143, 0.02761491690762341, 0.7988603033591062, 0.11750280298292637, 0.11291002365760505] }, { kind: 'delete', u: [0.056537609081715345, 0.7215519584715366, 0.9376734544057399, 0.17930406494997442, 0.7820167003665119, 0.6088943409267813, 0.12121632206253707, 0.8013442442752421] }] },
    ],
  },
  {
    issue: 1807,
    what: "Create Prefab's undo right after its file was renamed (not undoable, #1868 D2) untags through the manifest's new path",
    repro: [
      { kind: 'createPrefab', u: [0.2, 0.5, 0, 0, 0, 0, 0, 0] },
      { kind: 'renamePrefab', u: [0.7, 0.564, 0, 0, 0, 0, 0, 0] },
      { kind: 'undo', u: [0.4, 0.5, 0, 0, 0, 0, 0, 0] },
    ],
  },
  {
    issue: 1812,
    what: "a save writes a nested frame the load could not expand as removed once the editor cache holds its prefab",
    repro: [
      { kind: 'trashPrefab', u: [0.974, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'prefabEdit', u: [0.1, 0.9, 0, 0, 0, 0, 0, 0], inner: [] },
    ],
  },
  {
    issue: 1812,
    what: 'the same, where the world swap is the final save→reload (baseline seed 246)',
    // #1869: this Apply first moved a member within its frame (the fuzzer's retired directed branch), then applied every
    // key. A member no longer moves, so the repro applies every key (`u[1] = 0`) without the move.
    repro: [
      { kind: 'renamePrefab', u: [0.29216481326147914, 0.1476494751404971, 0.18551874696277082, 0.07410656800493598, 0.41970898350700736, 0.4152033708523959, 0.13034801022149622, 0.09932499984279275] },
      { kind: 'createPrefab', u: [0.5039114304818213, 0.255739972461015, 0.09370358125306666, 0.7442081868648529, 0.380464835325256, 0.46510340296663344, 0.25256184837780893, 0.05835147784091532] },
      { kind: 'apply', u: [0.34238993865437806, 0.8626079652458429, 0.7433561105281115, 0.5390893309377134, 0.11274192971177399, 0.7927570475731045, 0.18178777326829731, 0.45353098190389574] },
      { kind: 'delete', u: [0.06625497713685036, 0.47400090959854424, 0.5515744984149933, 0.7681468736846, 0.9731338797137141, 0.23174102697521448, 0.8072744118981063, 0.29941663425415754] },
      { kind: 'instantiate', u: [0.20119513431563973, 0.5657289137598127, 0.7211238443851471, 0.49647562275640666, 0.6243061849381775, 0.26464452408254147, 0.3661036011762917, 0.5965113013517112] },
      { kind: 'saveReload', u: [0.0573893568944186, 0.7971355733461678, 0.14437886117957532, 0.3072776247281581, 0.9758012674283236, 0.8816886597778648, 0.9357743547298014, 0.19664020952768624] },
      { kind: 'delete', u: [0.0669010104611516, 0.11636064387857914, 0.5872549663763493, 0.6053570182994008, 0.006638948572799563, 0.7421369452495128, 0.9577205339446664, 0.015151593368500471] },
      { kind: 'delete', u: [0.7079145491588861, 0.5272478302940726, 0.4790234782267362, 0.44434544374234974, 0.36253262870013714, 0.09312379360198975, 0.05239138635806739, 0.6635237485170364] },
      { kind: 'instantiate', u: [0.29211976029910147, 0.15278238710016012, 0.25975321140140295, 0.7465326695237309, 0.994651313405484, 0.5035853921435773, 0.6328171074856073, 0.6932727838866413] },
      { kind: 'prefabEdit', u: [0.3292363465297967, 0.798240183852613, 0.011706580873578787, 0.7644205500837415, 0.3508245141711086, 0.12864016951061785, 0.8345876485109329, 0.7216439375188202], inner: [] },
      { kind: 'trashPrefab', u: [0.4036154255736619, 0.43466546991840005, 0.38601681031286716, 0.2412711256183684, 0.09834549622610211, 0.639129497576505, 0.9453888835851103, 0.30100506939925253] },
      { kind: 'apply', u: [0.7839175323024392,  0,  0.42464192933402956,  0.6151037919335067,  0.8330991917755455,  0.19254334270954132,  0.9538525966927409,  0.8849528867285699] },
    ],
  },
  {
    issue: 1797,
    what: "Apply's write into an enclosing prefab states nextLocalId",
    repro: [
      { kind: 'reparent', u: [0.19745544902980328, 0.9284775732085109, 0.5860603547189385, 0.22611782955937088, 0.25675307563506067, 0.33752377540804446, 0.4600350330583751, 0.8438367047347128] },
      { kind: 'saveReload', u: [0.4955816750880331, 0.3304008231498301, 0.0743095432408154, 0.34028684766963124, 0.5970875050406903, 0.020840930752456188, 0.5537212470080703, 0.47318257577717304] },
      { kind: 'editField', u: [0.33866258268244565, 0.3408757250290364, 0.588245488004759, 0.5010231542401016, 0.12284281710162759, 0.16788704600185156, 0.06966154696419835, 0.14767667441628873] },
      { kind: 'apply', u: [0.6356004311237484, 0.23566313600167632, 0.1354613231960684, 0.24098156881518662, 0.43663930892944336, 0.9642775468528271, 0.4479197319597006, 0.6394356489181519] },
    ],
  },
  {
    issue: 1798,
    what: "the validator reads a compact entry's top-level guid (a child of a placeholder is not an orphan)",
    repro: [
      { kind: 'addChild', u: [0.8400129179935902, 0.47072196402586997, 0.8546695783734322, 0.5384382756892592, 0.7912890370935202, 0.9474262788426131, 0.8190620134118944, 0.5476701280567795] },
      { kind: 'duplicate', u: [0.08395724813453853, 0.5124020783696324, 0.0963418607134372, 0.3281203443184495, 0.6479879403486848, 0.0661356458440423, 0.3539451723918319, 0.9203498638235033] },
      { kind: 'delete', u: [0.3295891438610852, 0.6135888085700572, 0.5509396453853697, 0.4743896157015115, 0.5522417859174311, 0.7724654111079872, 0.03640387789346278, 0.3493649570737034] },
      { kind: 'duplicate', u: [0.12155674444511533, 0.3277325502131134, 0.8389609975274652, 0.7390714895445853, 0.4445467295590788, 0.6392863090150058, 0.4210883176419884, 0.6225011721253395] },
      { kind: 'trashPrefab', u: [0.031023554038256407, 0.8245022257324308, 0.3186694555915892, 0.4563527626451105, 0.0613121057394892, 0.6499785373453051, 0.7239432781934738, 0.2701634771656245] },
      { kind: 'addChild', u: [0.6957742967642844, 0.8604045836254954, 0.07128276745788753, 0.18332914565689862, 0.7442217774223536, 0.29817889304831624, 0.11375536606647074, 0.666205374756828] },
      { kind: 'delete', u: [0.9611131520941854, 0.5665881847962737, 0.99388741934672, 0.460568786598742, 0.4869730786886066, 0.4556502182967961, 0.1847134509589523, 0.4171289815567434] },
      { kind: 'delete', u: [0.11628153058700264, 0.2649255837313831, 0.9578696116805077, 0.2690436909906566, 0.48442695336416364, 0.6176841715350747, 0.8843859378248453, 0.29651732300408185] },
      { kind: 'prefabEdit', u: [0.08550754911266267, 0.17580716568045318, 0.49992706114426255, 0.3379638863261789, 0.5116101503372192, 0.6086981182452291, 0.6506540169939399, 0.689351754495874], inner: [] },
      { kind: 'reparent', u: [0.9714701315388083, 0.3523273344617337, 0.239267619792372, 0.6411985631566495, 0.8462079679593444, 0.059414628660306334, 0.5331373307853937, 0.8278629719279706] },
    ],
  },
];


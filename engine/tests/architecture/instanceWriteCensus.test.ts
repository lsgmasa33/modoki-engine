/** P4 as an ENTITY-write census (#2001 S4, #2014; design § 10.2, review R3(a)).
 *
 *  WHY ENTITY WRITES. The design's first P4 counted writers of the `InstanceRecord`. A writer that BYPASSES the door does
 *  not write the record by definition — it writes the live entity — so that census could not fail on the class it was
 *  cited against (review R3). This one counts the authoring surfaces' raw ECS write primitives instead: every production
 *  file under `editor/`, `app/editor/` and `app/debug/` whose code calls one is listed with EXACTLY the primitives it calls,
 *  and why its writes to a prefab-supplied entity either reach the door, mark the store stale (an op S7 moves onto
 *  records), or never touch an authored member. A new raw write fails here until its author says which.
 *
 *  What it cannot see: a write through a local alias of a trait handle (`e.set(ea, …)`), a game system at priority ≥ 200,
 *  an agent `eval`. Those are the save-time drift check's (`editor/instance/instanceDrift.ts`, review R3(b)). Comments are
 *  stripped, so a docblock naming a primitive is not a call. The I25 shadow (`tests/editor/prefabFuzz/shadow.ts`) is what
 *  proves a "door" row's writes actually reach the record. */

import { describe, it, expect } from 'vitest';
import { readScannedSource } from '@modoki/engine/testing';
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { fileURLToPath } from 'node:url';

/** The raw authoring write primitives, by name. `trait.*` is a write through a registered trait's handle. */
const PRIMITIVES: Record<string, RegExp> = {
  writeTraitField: /\bwriteTraitField\(/,
  writeTraitFieldMarked: /\bwriteTraitFieldMarked\(/,
  markOverride: /\bmarkOverride\(/,
  restoreOverrideMarks: /\brestoreOverrideMarks\(/,
  spawnEntity: /\bspawnEntity\(/,
  'trait.set': /\.set\(\s*[\w.]*\.trait\b/,
  'trait.add': /\.add\(\s*[\w.]*\.trait\b/,
  'trait.remove': /\.remove\(\s*[\w.]*\.trait\b/,
};
type Primitive = keyof typeof PRIMITIVES;

/** How a file's writes to a prefab-supplied entity stand against the door. */
type Standing =
  /** Its member writes call `instanceEdits` (`editor/instance/instanceEdits.ts`) — directly, or through the recorder. */
  | 'door'
  /** It is one of the ops S7 moves onto records, and it marks the store stale (`staleAround`, `markStale`). */
  | 'stale'
  /** It never writes an authored member's list-bearing state: identity (a guid, a scene stamp), a new non-instance
   *  entity, an edit world's or a device's own state, a live frame a commit records through the door. */
  | 'notAuthored';

const E = 'engine/packages/modoki/src/editor';
/** For a door row: the door entries its code must call (`instanceEdits.<verb>(`, or the recorder by name). */
type DoorCalls = string[];
const CENSUS: Record<string, { calls: Primitive[]; standing: Standing; why: string; markedIn?: string; doorCalls?: DoorCalls }> = {
  [`${E}/undo/entityActions.ts`]: {
    calls: ['writeTraitField', 'writeTraitFieldMarked', 'markOverride', 'restoreOverrideMarks', 'spawnEntity', 'trait.set', 'trait.add', 'trait.remove'],
    standing: 'door',
    doorCalls: ['instanceEdits.beginAddChild', 'instanceEdits.addChild', 'instanceEdits.afterCopy', 'instanceEdits.beginDelete',
      'instanceEdits.beginReparent', 'instanceEdits.beginRemoveComponent', 'instanceEdits.addComponent', 'instanceEdits.prepare'],
    why: 'every census writer of the review (create, duplicate, paste, delete, add/remove component, reparent and its '
      + 'compensated pose) calls its `instanceEdits` verb at commit; the raw writes in its undo/redo bodies run inside '
      + '`undoStep`, which marks the store stale',
  },
  [`${E}/undo/overrideMarkWrites.ts`]: {
    calls: ['writeTraitField', 'writeTraitFieldMarked', 'markOverride', 'restoreOverrideMarks'],
    standing: 'door', doorCalls: ['instanceEdits.setFields'],
    why: 'the recorder: `recordOverridesByDiff` calls `instanceEdits.setFields` before it marks, so every field writer '
      + '(Inspector, gizmo, UI handles, collider, renumber) reaches the door; `putMarkState`/`restoreMarks` run in undo bodies',
  },
  [`${E}/scene/uiHandleCommit.ts`]: {
    calls: ['trait.set'], standing: 'door', doorCalls: ['recordOverridesByDiff'],
    why: 'the raw set is the drag\'s live frames (`writeUIHandleValues`); the commit records through '
      + '`recordOverridesByDiff`, which calls the door (rule: a continuous gesture calls the door once, at commit, § 3.3)',
  },
  [`${E}/panels/SceneView.tsx`]: {
    calls: ['trait.set'], standing: 'door', doorCalls: ['markOverrideIfInstance'],
    why: 'collider point drags write live frames; `commitPoints` records through `markOverrideIfInstance` → the recorder → '
      + 'the door (§ 3.3, a continuous gesture)',
  },
  [`${E}/scene/prefabInstantiate.ts`]: {
    calls: ['spawnEntity', 'trait.set'], standing: 'door', doorCalls: ['instanceEdits.beginAddChild', 'instanceEdits.place'],
    why: 'a placement spawns the instance (and mints its root guid); `instantiatePrefabInstance` then calls '
      + '`instanceEdits.place`, which mints the record and links it into the member it lands under',
  },
  [`${E}/scene/prefabApplyStructure.ts`]: {
    calls: ['writeTraitField'], standing: 'stale', markedIn: `${E}/scene/prefabApply.ts`,
    why: 'Apply\'s structural writes; Apply (`applyToPrefabSelective`) and its fan-out (`refreshInstances`) mark the store '
      + 'stale until S7 moves Apply onto records',
  },
  [`${E}/scene/prefabBase.ts`]: {
    calls: ['markOverride'], standing: 'stale', markedIn: `${E}/scene/prefabLink.ts`,
    why: '`withLeftBehindRecorded` marks for the length of Create Prefab\'s capture and unmarks in `finally`; Create Prefab '
      + '(`tagCreatedPrefab`) marks the store stale',
  },
  [`${E}/scene/prefabLink.ts`]: {
    calls: ['restoreOverrideMarks', 'trait.set', 'trait.add', 'trait.remove'], standing: 'stale',
    why: 'Detach, re-attach, Create Prefab\'s tag and untag: each export is wrapped in `staleAround` (detach / createPrefab) '
      + 'until S7',
  },
  [`${E}/scene/prefabRebuild.ts`]: {
    calls: ['writeTraitField'], standing: 'stale',
    why: 'a rebuild/rebase respawns instances from the old capture; `rebuildStaleFrames` and `refreshInstances` mark the '
      + 'store stale when they rebuild anything',
  },
  [`${E}/scene/prefabReimport.ts`]: {
    calls: ['writeTraitField', 'trait.set'], standing: 'stale',
    why: 'an outside edit or git pull reimports prefabs into the open scene; both exports are wrapped in `staleAround` '
      + '(outsideEdit) until S7 reprojects instead',
  },
  [`${E}/scene/authoredSnapshot.ts`]: {
    calls: ['writeTraitField'], standing: 'stale',
    why: 'Stop restores the authored world (review R6); `restoreAuthoredSnapshot`/`restoreAuthoredEntities` are wrapped in '
      + '`staleAround` (stop) until S7 restores by reprojection',
  },
  [`${E}/scene/prefabEdit.ts`]: {
    calls: ['trait.set'], standing: 'notAuthored',
    why: '`applyEditWorldMoves` places nodes of the PREFAB-EDIT world, whose save is the template writer, not a scene '
      + 'instance\'s list; the I25 shadow does not judge an edit world',
  },
  [`${E}/scene/sceneDirty.ts`]: {
    calls: ['writeTraitField'], standing: 'notAuthored',
    why: 'stamps `EntityAttributes.sourceScene`, the base-scene provenance; § 10.4b keeps it out of every record, and it is '
      + 'no override',
  },
  [`${E}/scene/serialize.ts`]: {
    calls: ['spawnEntity', 'trait.set'], standing: 'notAuthored',
    why: 'the save\'s guid pass (`assignGuids`: identity, minted once, rule 5) and a new scene\'s default entities, which '
      + 'are no instance',
  },
  [`${E}/undo/entityRef.ts`]: {
    calls: ['writeTraitField'], standing: 'notAuthored',
    why: '`ensureGuid` mints an entity\'s durable guid: identity (rule 5), never an override',
  },
  [`${E}/panels/inspectorFields.tsx`]: {
    calls: ['trait.set'], standing: 'notAuthored',
    why: 'mints the guid an entity-ref field needs to point at (identity, rule 5)',
  },
  [`${E}/createEditor.tsx`]: {
    calls: ['spawnEntity'], standing: 'notAuthored',
    why: 'spawns the editor\'s default scene entities (camera, light), which are no prefab instance',
  },
  [`${E}/scene/modelImport.ts`]: {
    calls: ['spawnEntity'], standing: 'notAuthored',
    why: 'model import spawns temporary roots it serializes into a new asset and deletes; nothing joins an instance',
  },
  'engine/app/editor/agentEditorOps.ts': {
    calls: ['trait.set'], standing: 'notAuthored',
    why: 'not an ECS write: `byTrait.set(w.trait, …)` is a Map keyed by trait. Every agent write goes through '
      + '`writeTraitAsEditor` and the entityActions writers, which reach the door (rule 10)',
  },
  'engine/app/debug/liveMutate.ts': {
    calls: ['writeTraitField', 'trait.add'], standing: 'notAuthored',
    why: 'the DEVICE bridge\'s raw ops: they run on a device world, which no editor save writes (review § Census)',
  },
  'engine/app/debug/liveLifecycle.ts': {
    calls: ['spawnEntity', 'trait.set', 'trait.add'], standing: 'notAuthored',
    why: 'the device bridge\'s create/delete: a device world, which no editor save writes',
  },
};

const sources = (): { rel: string; abs: string }[] =>
  repoFiles({ under: 'engine', match: /\.tsx?$/, floor: 500 })
    .filter(({ rel }: { rel: string }) => /^engine[\\/](packages[\\/]modoki[\\/]src[\\/]editor|app[\\/](editor|debug))[\\/]/.test(rel))
    .filter(({ rel }: { rel: string }) => !/[\\/]tests?[\\/]|\.test\.tsx?$|[\\/]testing[\\/]|[\\/]dist[\\/]/.test(rel));

function census(): Map<string, Primitive[]> {
  const out = new Map<string, Primitive[]>();
  for (const { rel, abs } of sources()) {
    const { code } = readScannedSource(abs);
    const calls = (Object.keys(PRIMITIVES) as Primitive[]).filter((p) => PRIMITIVES[p].test(code));
    if (calls.length) out.set(rel.replace(/\\/g, '/'), calls);
  }
  return out;
}

describe('P4: every raw entity write of the authoring surfaces is accounted for against the door (#2014)', () => {
  it('the census matches the code, file by file and primitive by primitive', () => {
    // One occurrence per (file, primitive) the scan finds; each CENSUS row pays for the primitives it lists, with its
    // reason. Unpaid: a new raw writer — route it through `instanceEdits` (or mark the store stale, for an op S7 moves),
    // or add a row saying why it never writes a prefab-supplied entity. Over-paid: a row naming a write that is gone.
    const found = census();
    assertExemptionLedger({
      label: 'CENSUS in instanceWriteCensus (P4, #2014)',
      population: [...found].flatMap(([file, calls]) => calls.map((c) => ({ item: `${file}::${c}`, site: file }))),
      exempt: Object.entries(CENSUS).flatMap(([file, row]) => row.calls.map((c) => ({ item: `${file}::${c}`, reason: `${row.standing}: ${row.why}` }))),
      floor: 20,
      fix: 'route the write through `instanceEdits` (or `markStale`/`staleAround` for an op S7 moves onto records), or add a CENSUS row saying why it never writes a prefab-supplied entity',
    });
  });

  // A "door" or "stale" row is a claim about the code; pin the call that makes it true, so deleting it fails here too.
  it('each door row calls the door, and each stale row marks', () => {
    const marks = /\bstaleAround\(|\bmarkStale\(/;
    // The door directly, or the recorder that calls it (`recordOverridesByDiff` → `instanceEdits.setFields`). Each named
    // call, with the paren (a called-symbol guard must require it).
    const code = (rel: string) => readScannedSource(fileURLToPath(new URL(`../../../${rel}`, import.meta.url))).code;
    for (const [file, row] of Object.entries(CENSUS)) {
      if (row.standing === 'door') {
        expect(row.doorCalls?.length, `${file} is a door row naming no door call`).toBeGreaterThan(0);
        for (const c of row.doorCalls!) expect(new RegExp(`\\b${c.replace('.', '\\.')}\\(`).test(code(file)), `${file} no longer calls ${c}(`).toBe(true);
      }
      if (row.standing === 'stale') expect(marks.test(code(row.markedIn ?? file)), `${file} is a stale row but ${row.markedIn ?? 'it'} marks nothing`).toBe(true);
    }
  });

  it('the scan sees real writers — otherwise the census is vacuous', () => {
    expect(census().get(`${E}/undo/entityActions.ts`)?.length ?? 0).toBeGreaterThanOrEqual(6);
    expect(census().size).toBeGreaterThanOrEqual(15);
  });

  it('every row says why', () => {
    for (const [file, row] of Object.entries(CENSUS)) expect(row.why.length, `${file} has no reason`).toBeGreaterThan(40);
  });
});

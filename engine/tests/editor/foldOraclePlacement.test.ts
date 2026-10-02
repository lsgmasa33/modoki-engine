/** #2021: the P1 oracle's placement check (`foldOracle.ts` `placementDiverge`), pure. It holds the fold to the record by
 *  the rules (design § 10.4b, #2018's rulings): every own link in exactly one place, and every record under a Missing
 *  Prefab placeholder unused `unresolved`. Each case states a fold that breaks one rule; the fuzzer reaches the right
 *  shapes, but only the fold's own defects reach the wrong ones. */

import { describe, it, expect } from 'vitest';
import { placementDiverge } from './foldOracle';
import { parseInstanceRecord } from '../../packages/modoki/src/runtime/prefab/parseInstanceRecord';
import { foldInstance } from '../../packages/modoki/src/runtime/prefab/foldInstance';
import type { SceneEntityEntry } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';
import type { FoldedInstance, InstanceRecord, SceneTargetRecord, UnusedRecord, AddedNodeRef, DesiredNode, PrefabDoc, PrefabReader } from '../../packages/modoki/src/runtime/prefab/instanceRecord';

const rec = (rows: Record<string, SceneTargetRecord>, heldOwn?: Record<string, string[]>, pendingLegacy?: Record<string, unknown>): InstanceRecord => ({
  rootGuid: 'root', source: 'P', placement: { parent: '', sortOrder: 0, name: 'P' },
  list: { rows: new Map(Object.entries(rows)) },
  held: {
    ...(heldOwn ? { heldOwn: new Map(Object.entries(heldOwn).map(([k, gs]) => [k, gs.map((guid) => ({ guid }))])) } : {}),
    ...(pendingLegacy ? { pendingLegacy } : {}),
  } as InstanceRecord['held'],
});
const show = (v: unknown) => JSON.stringify(v);
const legacy = (key: string, path: string[], cause: UnusedRecord['cause']): UnusedRecord => ({ key, part: { kind: 'legacy', path }, cause });
const fold = (o: { nodes?: string[]; placeholders?: string[]; anchors?: Record<string, string[]>; unused?: UnusedRecord[] }): FoldedInstance => ({
  nodes: new Map((o.nodes ?? ['/']).map((k) => [k, { key: k } as DesiredNode])),
  placeholders: new Map((o.placeholders ?? []).map((k) => [k, { source: 'Q', reason: 'missing' as const }])),
  anchors: new Map(Object.entries(o.anchors ?? {}).map(([k, gs]) => [k, gs.map((guid): AddedNodeRef => ({ guid }))])),
  unused: o.unused ?? [],
});
const own = (key: string, guid: string, cause: UnusedRecord['cause']): UnusedRecord => ({ key, part: { kind: 'own', guid }, cause });
const field = (key: string, cause: UnusedRecord['cause']): UnusedRecord => ({ key, part: { kind: 'field', trait: 'Transform', field: 'x' }, cause });

describe('#2021 P1 oracle: each own link in exactly one place, by the rules', () => {
  it('on a projected member: anchored there', () => {
    const r = rec({ '/A': { own: [{ guid: 'n' }] } });
    expect(placementDiverge(fold({ nodes: ['/', '/A'], anchors: { '/A': ['n'] } }), r)).toEqual([]);
    // Neither (#2018's first route on a projected member), or anchored somewhere else.
    expect(placementDiverge(fold({ nodes: ['/', '/A'] }), r)).toEqual(['own link n: stated ["anchor /A"] placed []']);
    expect(placementDiverge(fold({ nodes: ['/', '/A'], anchors: { '/': ['n'] } }), r)).toEqual(['own link n: stated ["anchor /A"] placed ["anchor /"]']);
  });

  it('on a member the fold does not project: heldNode (B′)', () => {
    const r = rec({ '/A': { own: [{ guid: 'n' }] } });
    expect(placementDiverge(fold({ unused: [own('/A', 'n', 'heldNode')] }), r)).toEqual([]);
    expect(placementDiverge(fold({}), r)).toEqual(['own link n: stated ["unused /A heldNode"] placed []']);
    // `gone` would let Remove Unused take the user's node (rule 7).
    expect(placementDiverge(fold({ unused: [own('/A', 'n', 'gone')] }), r)).toHaveLength(1);
  });

  it('AT a placeholder: hangs from it — never held, never unresolved, never lost', () => {
    const r = rec({ '/R': { own: [{ guid: 'n' }] } });
    expect(placementDiverge(fold({ placeholders: ['/R'], anchors: { '/R': ['n'] } }), r)).toEqual([]);
    // The fold reports only placeholders no removal cut, so held here is a link the placeholder dropped.
    expect(placementDiverge(fold({ placeholders: ['/R'], unused: [own('/R', 'n', 'heldNode')] }), r)).toHaveLength(1);
    // A CUT placeholder is not reported: its links are under the instance's own removal, and held (hub, #2021).
    expect(placementDiverge(fold({ unused: [own('/R', 'n', 'heldNode')] }), r)).toEqual([]);
    expect(placementDiverge(fold({ placeholders: ['/R'], unused: [own('/R', 'n', 'unresolved')] }), r)).toHaveLength(1);
    expect(placementDiverge(fold({ placeholders: ['/R'] }), r)).toEqual(['own link n: stated ["anchor /R"] placed []']);
    // The instance's own root missing: the root placeholder is the anchor.
    expect(placementDiverge(fold({ nodes: [], placeholders: ['/'], anchors: { '/': ['n'] } }), rec({ '/': { own: [{ guid: 'n' }] } }))).toEqual([]);
  });

  it('INSIDE a placeholder\'s frame: unresolved (rule 9) — not anchored, not heldNode', () => {
    const r = rec({ '/R/M': { own: [{ guid: 'n' }] } });
    expect(placementDiverge(fold({ placeholders: ['/R'], unused: [own('/R/M', 'n', 'unresolved')] }), r)).toEqual([]);
    expect(placementDiverge(fold({ placeholders: ['/R'], unused: [own('/R/M', 'n', 'heldNode')] }), r)).toHaveLength(1);
    expect(placementDiverge(fold({ placeholders: ['/R'], anchors: { '/R/M': ['n'] } }), r)).toHaveLength(1);
    expect(placementDiverge(fold({ placeholders: ['/R'] }), r)).toEqual(['own link n: stated ["unused /R/M unresolved"] placed []']);
    // Under the ROOT placeholder, every row is inside.
    expect(placementDiverge(fold({ nodes: [], placeholders: ['/'], unused: [own('/A', 'n', 'unresolved')] }), rec({ '/A': { own: [{ guid: 'n' }] } }))).toEqual([]);
  });

  it('a held scene-owned node is heldNode', () => {
    const r = rec({}, { '/A': ['n'] });
    expect(placementDiverge(fold({ unused: [own('/A', 'n', 'heldNode')] }), r)).toEqual([]);
    expect(placementDiverge(fold({}), r)).toEqual(['own link n: stated ["unused /A heldNode"] placed []']);
  });

  it('never both, never twice (#2017\'s shape), and nothing the record does not state', () => {
    const r = rec({ '/A': { own: [{ guid: 'n' }] } });
    expect(placementDiverge(fold({ nodes: ['/', '/A'], anchors: { '/A': ['n'] }, unused: [own('/A', 'n', 'heldNode')] }), r)).toHaveLength(1);
    expect(placementDiverge(fold({ nodes: ['/', '/A'], anchors: { '/A': ['n', 'n'] } }), r)).toEqual(['own link n: stated ["anchor /A"] placed ["anchor /A","anchor /A"]']);
    expect(placementDiverge(fold({ nodes: ['/', '/A'], anchors: { '/A': ['n', 'x'] } }), r)).toEqual(['own link x: stated [] placed ["anchor /A"]']);
  });

  it('a node is one guid: a link and its held content are one node, a guid stated twice is #1937\'s', () => {
    // `heldOwn` holds the CONTENT of a linked node (the writer takes it from there): one node, one place.
    const r = rec({ '/A': { own: [{ guid: 'n' }] } }, { '/A': ['n'] });
    expect(placementDiverge(fold({ nodes: ['/', '/A'], anchors: { '/A': ['n'] } }), r)).toEqual([]);
    expect(placementDiverge(fold({ nodes: ['/', '/A'], anchors: { '/A': ['n'] }, unused: [own('/A', 'n', 'heldNode')] }), r)).toHaveLength(1);
    // Unlinked held content is placed by the same rules as a link: AT a placeholder it hangs from it.
    expect(placementDiverge(fold({ placeholders: ['/R'], anchors: { '/R': ['n'] } }), rec({}, { '/R': ['n'] }))).toEqual([]);
    expect(placementDiverge(fold({ placeholders: ['/R'], unused: [own('/R', 'n', 'heldNode')] }), rec({}, { '/R': ['n'] }))).toHaveLength(1);
    // Two rows stating one guid: a duplicate identifier (rule 5, I5) — what it means is #1937's, so it is not judged.
    const twice = rec({ '/A': { own: [{ guid: 'n' }] }, '/B': { own: [{ guid: 'n' }] } });
    expect(placementDiverge(fold({ nodes: ['/', '/A', '/B'], anchors: { '/A': ['n'], '/B': ['n'] } }), twice)).toEqual([]);
  });

  it('a scene-owned node in a held legacy row\'s `added` AT a placeholder hangs from it ("every file form", § 10.4b)', () => {
    const r = rec({}, undefined, { members: { '/R': { added: [{ guid: 'n', name: 'N', parentLocalId: 0, traits: {} }] } } });
    expect(placementDiverge(fold({ placeholders: ['/R'], anchors: { '/R': ['n'] } }), r)).toEqual([]);
    // Kept as a held legacy record instead (the v16 form, reported to ai3): hidden, where today shows it.
    expect(placementDiverge(fold({ placeholders: ['/R'], unused: [legacy('/R', ['members', '/R', 'added', '0'], 'unresolved')] }), r))
      .toEqual(['own link n: stated ["anchor /R"] placed ["unused /R unresolved"]']);
    // INSIDE the placeholder's frame it waits with the rest.
    const inside = rec({}, undefined, { members: { '/R/M': { added: [{ guid: 'n', name: 'N', parentLocalId: 0, traits: {} }] } } });
    expect(placementDiverge(fold({ placeholders: ['/R'], unused: [legacy('/R/M', ['members', '/R/M', 'added', '0'], 'unresolved')] }), inside)).toEqual([]);
  });
});

describe('#2021 P1 oracle: every record under a placeholder is unused unresolved', () => {
  it('at and inside the placeholder, part by part', () => {
    const r = rec({ '/R': { traits: { Transform: { x: 1 } } }, '/R/M': { traits: { Transform: { x: 1 } } } });
    expect(placementDiverge(fold({ placeholders: ['/R'], unused: [field('/R', 'unresolved'), field('/R/M', 'unresolved')] }), r)).toEqual([]);
    // Lost, or kept as `gone` (which Remove Unused would take: rule 7).
    expect(placementDiverge(fold({ placeholders: ['/R'], unused: [field('/R', 'unresolved')] }), r)).toEqual(['under a placeholder, not unused unresolved: /R/M Transform.x (unresolved)']);
    expect(placementDiverge(fold({ placeholders: ['/R'], unused: [field('/R', 'unresolved'), field('/R/M', 'gone')] }), r)).toEqual([
      'under a placeholder, not unused unresolved: /R/M Transform.x (unresolved)',
      'under a placeholder, unused but not stated: /R/M Transform.x (gone)',
    ]);
  });

  it('a `removed` AT a nested placeholder applies: it is not unused (hub, 2026-10-02)', () => {
    const r = rec({ '/R': { removed: false } });
    expect(placementDiverge(fold({ placeholders: ['/R'] }), r)).toEqual([]);
    expect(placementDiverge(fold({ placeholders: ['/R'], unused: [{ key: '/R', part: { kind: 'removed' }, cause: 'unresolved' }] }), r))
      .toEqual(['under a placeholder, unused but not stated: /R removed (unresolved)']);
    // Inside the frame, a removal waits with every other record.
    const inside = rec({ '/R/M': { removed: true } });
    expect(placementDiverge(fold({ placeholders: ['/R'], unused: [{ key: '/R/M', part: { kind: 'removed' }, cause: 'unresolved' }] }), inside)).toEqual([]);
  });

  it('nothing outside a placeholder is held to it', () => {
    const r = rec({ '/A': { traits: { Transform: { x: 1 } } }, '/RX': { traits: { Transform: { x: 1 } } } });
    // `/RX` is not under `/R` (a key prefix is not a frame).
    expect(placementDiverge(fold({ nodes: ['/', '/A', '/RX'], placeholders: ['/R'], unused: [field('/A', 'gone')] }), r)).toEqual([]);
  });
});

describe('#2021 P1 oracle: every held legacy statement under a placeholder is reported, unresolved', () => {
  const held = { overrides: { 1: { Transform: { x: 1 } } }, removed: [3] };
  it('the instance\'s own prefab missing: every statement', () => {
    const r = rec({}, undefined, held);
    const ok = [legacy('/', ['overrides', '1'], 'unresolved'), legacy('/', ['removed', '0'], 'unresolved')];
    expect(placementDiverge(fold({ nodes: [], placeholders: ['/'], unused: ok }), r)).toEqual([]);
    // Dropped (the review's mutation), or `gone` (Remove Unused would take it: rule 9).
    expect(placementDiverge(fold({ nodes: [], placeholders: ['/'], unused: [ok[0]!] }), r)).toEqual(['under a placeholder, held ["removed","0"] not reported']);
    expect(placementDiverge(fold({ nodes: [], placeholders: ['/'], unused: [ok[0]!, legacy('/', ['removed', '0'], 'gone')] }), r))
      .toEqual(['under a placeholder, held ["removed","0"] unused gone, not unresolved']);
    // A legacy record no held statement names.
    expect(placementDiverge(fold({ nodes: [], placeholders: ['/'], unused: [...ok, legacy('/', ['moved', 'x'], 'unresolved')] }), r))
      .toEqual(['unused legacy ["moved","x"] names no held statement']);
  });

  it('without the context that places it, a held node in a form that names no anchor row is unjudged (counted)', () => {
    const node = { guid: 'n', name: 'N', parentLocalId: 1, traits: {} };
    for (const [form, path] of [
      [{ added: [node] }, ['added', '0']],
      [{ nestedStructure: { 3: { added: [node] } } }, ['nestedStructure', '3', 'added', '0']],
    ] as const) {
      const r = rec({}, undefined, form as Record<string, unknown>);
      // Today's fold hides it as a held record; a fix that shows it ("every file form") anchors it. Neither is red.
      expect(placementDiverge(fold({ nodes: [], placeholders: ['/'], unused: [legacy('/', [...path], 'unresolved')] }), r), path.join('.')).toEqual([]);
      expect(placementDiverge(fold({ nodes: [], placeholders: ['/'], anchors: { '/': ['n'] } }), r), path.join('.')).toEqual([]);
      // Nor is its cause held to `unresolved`: what the node is there is the open question.
      expect(placementDiverge(fold({ nodes: [], placeholders: ['/'], unused: [legacy('/', [...path], 'heldNode')] }), r), path.join('.')).toEqual([]);
    }
  });

  it('an unjudged held node is still one node: shown once or held once, never neither, both or twice', () => {
    const r = rec({}, undefined, { added: [{ guid: 'n', name: 'N', parentLocalId: 1, traits: {} }] });
    const at = ['added', '0'];
    expect(placementDiverge(fold({ nodes: [], placeholders: ['/'] }), r)).toEqual(['held node n (["added","0"]): placed []']);
    expect(placementDiverge(fold({ nodes: [], placeholders: ['/'], anchors: { '/': ['n'] }, unused: [legacy('/', at, 'unresolved')] }), r)).toHaveLength(1);
    expect(placementDiverge(fold({ nodes: [], placeholders: ['/'], anchors: { '/': ['n', 'n'] } }), r)).toHaveLength(1);
  });

  it('a held node does not vouch for the rest of its statement', () => {
    // The slot holds a node AND a removal: the fold dropping the slot whole loses the removal, whatever the node is.
    const r = rec({}, undefined, { nestedStructure: { 3: { added: [{ guid: 'n', name: 'N', parentLocalId: 1, traits: {} }], removed: [5] } } });
    const node = legacy('/', ['nestedStructure', '3', 'added', '0'], 'unresolved');
    expect(placementDiverge(fold({ nodes: [], placeholders: ['/'], unused: [node, legacy('/', ['nestedStructure', '3', 'removed'], 'unresolved')] }), r)).toEqual([]);
    expect(placementDiverge(fold({ nodes: [], placeholders: ['/'], unused: [node] }), r)).toEqual(['under a placeholder, held ["nestedStructure","3"] not reported']);
  });

  it('a held CONTAINER that states nothing is no statement; any other channel\'s empty entry still is', () => {
    expect(placementDiverge(fold({ nodes: [], placeholders: ['/'] }), rec({}, undefined, { nestedStructure: { 3: {} } }))).toEqual([]);
    // The fold reports `overrides: {4: {}}` as one held record: the oracle must not call it unstated.
    expect(placementDiverge(fold({ nodes: [], placeholders: ['/'], unused: [legacy('/', ['overrides', '4'], 'unresolved')] }), rec({}, undefined, { overrides: { 4: {} } }))).toEqual([]);
  });

  it('a held member row under a placeholder; one outside it is not this check\'s', () => {
    const r = rec({}, undefined, { members: { '/R/M': { traits: { Transform: { x: 1 } } }, '/A': { traits: { Transform: { x: 1 } } } } });
    const atM = legacy('/R/M', ['members', '/R/M'], 'unresolved');
    expect(placementDiverge(fold({ nodes: ['/', '/A'], placeholders: ['/R'], unused: [atM, legacy('/', ['members', '/A'], 'gone')] }), r)).toEqual([]);
    expect(placementDiverge(fold({ nodes: ['/', '/A'], placeholders: ['/R'], unused: [legacy('/', ['members', '/A'], 'gone')] }), r))
      .toEqual(['under a placeholder, held ["members","/R/M"] not reported']);
  });
});

describe('#2030 P1 oracle: #2025\'s held forms are placed by the rules (hub rulings Q3, Q4)', () => {
  const node = (parentLocalId: number, guid = 'n') => ({ guid, name: guid.toUpperCase(), parentLocalId, traits: {} });
  const at = ['added', '0'];
  /** The entry as stored: its root forms are what Q3 is judged from (#2030 review), whatever the record says. */
  const owner = (rootLid: number | null, channels: Record<string, unknown>) => ({ traits: rootLid === null ? {} : { PrefabInstance: { localId: rootLid } }, ...channels });

  it('the entry-level legacy `added` under a missing root: AT it (`/`) when the entry states the root localId and the node names it', () => {
    const r = rec({}, undefined, { added: [node(1)] });
    const o = owner(1, { added: [node(1)] });
    expect(placementDiverge(fold({ nodes: [], placeholders: ['/'], anchors: { '/': ['n'] } }), r, { owner: o })).toEqual([]);
    // Held instead (the fold before #2025's Q3 fix): hidden, where every other form shows it.
    expect(placementDiverge(fold({ nodes: [], placeholders: ['/'], unused: [legacy('/', at, 'unresolved')] }), r, { owner: o }))
      .toEqual(['own link n: stated ["anchor /"] placed ["unused / unresolved"]']);
  });

  it('…judged from the STORED owner, not the record: a parse that links a node no ruling places at `/` is red', () => {
    // The parse links what it places at `/` as the `/` row's `own`. One linking BOTH nodes agrees with itself; the stored
    // owner says `m` names another localId, so it waits (#2030 review: the over-linking mutation passed the record).
    const o = owner(1, { added: [node(1), node(2, 'm')] });
    const overLinked = rec({ '/': { own: [{ guid: 'n' }, { guid: 'm' }] } });
    expect(placementDiverge(fold({ nodes: [], placeholders: ['/'], anchors: { '/': ['n', 'm'] } }), overLinked, { owner: o }))
      .toEqual(['own link m: stated ["unused / unresolved"] placed ["anchor /"]']);
    // The record a correct parse makes: `n` linked, `m` held where it was stated.
    const r = rec({ '/': { own: [{ guid: 'n' }] } }, undefined, { added: [node(2, 'm')] });
    expect(placementDiverge(fold({ nodes: [], placeholders: ['/'], anchors: { '/': ['n'] }, unused: [legacy('/', at, 'unresolved')] }), r, { owner: o })).toEqual([]);
    // A parse that links an owner's root node at another row: red, not a duplicate left unjudged (close-out review).
    expect(placementDiverge(fold({ nodes: [], placeholders: ['/'], anchors: { '/': ['n'] }, unused: [own('/R', 'm', 'unresolved')] }), rec({ '/': { own: [{ guid: 'n' }] }, '/R': { own: [{ guid: 'm' }] } }), { owner: o }))
      .toEqual(['own link m: stated at / by the owner, linked at /R by the parse', 'own link m: stated ["unused / unresolved"] placed ["unused /R unresolved"]']);
    // A parse that drops a node the owner states: placed nowhere.
    expect(placementDiverge(fold({ nodes: [], placeholders: ['/'], anchors: { '/': ['n'] } }), rec({ '/': { own: [{ guid: 'n' }] } }), { owner: o }))
      .toEqual(['own link m: stated ["unused / unresolved"] placed []']);
  });

  it('…and waits, unresolved, when it is not provably AT the root: no localId stated, another localId, or a whole `/` list', () => {
    for (const [what, rootLid, channels] of [
      ['no root localId stated (none is guessed, rule 5)', null, { added: [node(1)] }],
      ['anchored inside the missing frame', 1, { added: [node(2)] }],
      ['the held `/` row\'s whole list replaces it', 1, { added: [node(1)], members: { '/': { added: [] } } }],
    ] as const) {
      const r = rec({}, undefined, structuredClone(channels));
      const o = owner(rootLid, channels);
      const rowRec = what.includes('whole') ? [legacy('/', ['members', '/', 'added'], 'unresolved')] : [];
      expect(placementDiverge(fold({ nodes: [], placeholders: ['/'], unused: [legacy('/', at, 'unresolved'), ...rowRec] }), r, { owner: o }), what).toEqual([]);
      expect(placementDiverge(fold({ nodes: [], placeholders: ['/'], anchors: { '/': ['n'] }, unused: rowRec }), r, { owner: o }), what)
        .toEqual(['own link n: stated ["unused / unresolved"] placed ["anchor /"]']);
    }
    // A REMAINDER `/` row states no whole list: the node is at the root.
    const remainder = { added: [node(1)], members: { '/': { added: [], heldRemainder: true } } };
    const rem = rec({}, undefined, remainder);
    expect(placementDiverge(fold({ nodes: [], placeholders: ['/'], anchors: { '/': ['n'] }, unused: [legacy('/', ['members', '/', 'added'], 'unresolved')] }), rem, { owner: owner(1, remainder) })).toEqual([]);
  });

  it('…through today\'s parse and fold: the node naming the root shows at `/`, the other waits', () => {
    const entry = owner(1, { guid: 'root', prefab: 'P', added: [node(1), node(2, 'm')] }) as unknown as SceneEntityEntry;
    const read: PrefabReader = () => ({ missing: true });
    const { record } = parseInstanceRecord(entry, read, { sceneVersion: 19 });
    const f = foldInstance(read, record);
    expect(placementDiverge(f, record, { read, owner: entry })).toEqual([]);
    expect([...f.anchors.get('/') ?? []].map((r) => r.guid)).toEqual(['n']);
  });

  it('a node stating an EMPTY guid names nothing: the parse holds it, and the oracle does not call it a user node', () => {
    // Linked by its guid, `''` links nothing (the parser's rule at a missing root); a held record the fold reports, not a
    // node to place — at `/` it would be stated there, and red.
    const blank = { guid: '', name: 'B', parentLocalId: 1, traits: {} };
    const entry = owner(1, { guid: 'root', prefab: 'P', added: [blank] }) as unknown as SceneEntityEntry;
    const read: PrefabReader = () => ({ missing: true });
    const { record } = parseInstanceRecord(entry, read, { sceneVersion: 19 });
    const f = foldInstance(read, record);
    expect(f.anchors.get('/') ?? []).toEqual([]);
    expect(placementDiverge(f, record, { read, owner: entry })).toEqual([]);
  });

  it('…and a malformed root channel states no node: the file boundary keeps it verbatim, as the parse does', () => {
    // One element no reader takes sends the whole list to `unparsed` (malformedChannels.ts), so nothing in it links.
    const read: PrefabReader = () => ({ missing: true });
    for (const channels of [
      { added: [node(1), { guid: 'x', parentLocalId: 1 }] },
      { added: [node(1)], members: { '/': { added: [{ guid: 'y', name: 'Y' }] } } },
      { members: { '/': { own: [node(0, 'o'), { guid: 'z' }] } } },
    ]) {
      const entry = owner(1, { guid: 'root', prefab: 'P', ...channels }) as unknown as SceneEntityEntry;
      const { record } = parseInstanceRecord(entry, read, { sceneVersion: 19 });
      expect(placementDiverge(foldInstance(read, record), record, { read, owner: entry }), JSON.stringify(channels)).toEqual([]);
    }
  });

  it('…while the root\'s document loads, the entry-level form stays unjudged', () => {
    const r = rec({}, undefined, { added: [node(1)] });
    expect(placementDiverge(fold({ unused: [legacy('/', at, 'gone')] }), r, { owner: owner(1, { added: [node(1)] }) })).toEqual([]);
  });

  // P's row 5 (node R) references M; whether M loads decides the slot's placeholder.
  const P = { id: 'P', version: 5, rootLocalId: 1, entities: [{ localId: 1, nodeGuid: 'PR', parentLocalId: 0 }, { localId: 5, nodeGuid: 'R', parentLocalId: 1, prefab: 'M' }] };
  const M = { id: 'M', version: 5, rootLocalId: 1, entities: [{ localId: 1, nodeGuid: 'MR', parentLocalId: 0 }] };
  const reader = (docs: Record<string, unknown>): PrefabReader => (g) => (docs[g] ? { doc: docs[g] as PrefabDoc } : { missing: true });
  const slot = ['nestedStructure', '5', 'added', '0'];
  const slotRec = () => rec({}, undefined, { nestedStructure: { 5: { added: [node(1)] } } });

  it('a slot\'s node at a MISSING nested document waits unresolved, keyed at that placeholder row (Q4)', () => {
    const read = reader({ P });
    expect(placementDiverge(fold({ placeholders: ['/R'], unused: [legacy('/R', slot, 'unresolved')] }), slotRec(), { read })).toEqual([]);
    // Keyed at the instance root (the fold before #2025's Q4 fix), or shown at the row: both red.
    expect(placementDiverge(fold({ placeholders: ['/R'], unused: [legacy('/', slot, 'unresolved')] }), slotRec(), { read }))
      .toEqual(['own link n: stated ["unused /R unresolved"] placed ["unused / unresolved"]']);
    expect(placementDiverge(fold({ placeholders: ['/R'], anchors: { '/R': ['n'] } }), slotRec(), { read }))
      .toEqual(['own link n: stated ["unused /R unresolved"] placed ["anchor /R"]']);
    // A removal cut the row (the fold reports no placeholder): the user's node is kept, `heldNode`, at the same key.
    expect(placementDiverge(fold({ unused: [legacy('/R', slot, 'heldNode')] }), slotRec(), { read })).toEqual([]);
    // The instance's own document missing: inside the root's frame.
    expect(placementDiverge(fold({ nodes: [], placeholders: ['/'], unused: [legacy('/', slot, 'unresolved')] }), slotRec(), { read: reader({}) })).toEqual([]);
    expect(placementDiverge(fold({ nodes: [], placeholders: ['/'], unused: [legacy('/', slot, 'heldNode')] }), slotRec(), { read: reader({}) }))
      .toEqual(['own link n: stated ["unused / unresolved"] placed ["unused / heldNode"]']);
    // M loads: no ruling places a slot held there, so it is unjudged.
    expect(placementDiverge(fold({ unused: [legacy('/', slot, 'gone')] }), slotRec(), { read: reader({ P, M }) })).toEqual([]);
  });

  it('a held row\'s v17 `own` is placed like its `added`: inside the record that holds the row, or at the row', () => {
    const inside = rec({}, undefined, { members: { '/R/M': { own: [node(0)] } } });
    expect(placementDiverge(fold({ placeholders: ['/R'], unused: [legacy('/R/M', ['members', '/R/M'], 'unresolved')] }), inside)).toEqual([]);
    expect(placementDiverge(fold({ placeholders: ['/R'], unused: [legacy('/R/M', ['members', '/R/M', 'own'], 'unresolved')] }), inside)).toEqual([]);
    expect(placementDiverge(fold({ placeholders: ['/R'] }), inside)).toEqual(['own link n: stated ["unused /R/M unresolved"] placed []', 'under a placeholder, held ["members","/R/M"] not reported']);
    // A held `added` is reported node by node: one record for the whole row (or its list) places none of them.
    const two = rec({}, undefined, { members: { '/R/M': { added: [node(0), node(0, 'm')] } } });
    const each = [legacy('/R/M', ['members', '/R/M', 'added', '0'], 'unresolved'), legacy('/R/M', ['members', '/R/M', 'added', '1'], 'unresolved')];
    expect(placementDiverge(fold({ placeholders: ['/R'], unused: each }), two)).toEqual([]);
    for (const whole of [['members', '/R/M'], ['members', '/R/M', 'added']]) {
      expect(placementDiverge(fold({ placeholders: ['/R'], unused: [legacy('/R/M', whole, 'unresolved')] }), two), show(whole))
        .toEqual(['own link n: stated ["unused /R/M unresolved"] placed []', 'own link m: stated ["unused /R/M unresolved"] placed []']);
    }
    // AT a missing root (Q3, B4): it shows at `/`, and is not held.
    const atRoot = rec({}, undefined, { members: { '/': { own: [node(0)] } } });
    expect(placementDiverge(fold({ nodes: [], placeholders: ['/'], unused: [legacy('/', ['members', '/'], 'unresolved')] }), atRoot))
      .toEqual(['own link n: stated ["anchor /"] placed ["unused / unresolved"]']);
  });
});

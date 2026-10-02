/** #2008 (#2001 S3): the instance-record WRITER, over hand-built records.
 *
 *  The corpus and fuzz round-trip (P2, `parse(serialize(rec)) ≡ rec`) lands once S1's parser is on main (hub, 2026-10-02).
 *  These pin each rule the writer carries on its own: what it writes, where, in which order, and what it never writes. */

import { describe, it, expect } from 'vitest';
import {
  serializeInstanceRecord, serializeTemplateOwner, serializeTemplateDocHeld, type MemberIdentity, type SerializeContext, type TemplateRowJson,
} from '../../src/runtime/prefab/serializeInstanceRecord';
import type {
  InstanceRecord, SceneOwnedNode, SceneTargetRecord, TemplateTargetRecord,
} from '../../src/runtime/prefab/instanceRecord';

const ROOT = '00000000-0000-4000-8000-000000000001';
const SRC = '00000000-0000-4000-8000-0000000000aa';
const M1 = '11111111-1111-4111-8111-111111111111';
const M2 = '22222222-2222-4222-8222-222222222222';
const G1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const G2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const OWN = 'bbbbbbbb-0000-4000-8000-000000000001';
const OWN2 = 'bbbbbbbb-0000-4000-8000-000000000002';

function record(rows: Record<string, SceneTargetRecord> = {}, over: Partial<InstanceRecord> = {}): InstanceRecord {
  return {
    rootGuid: ROOT, source: SRC,
    placement: { parent: '', sortOrder: 0, name: 'Ship' },
    list: { rows: new Map(Object.entries(rows)) },
    held: {},
    ...over,
  };
}
const node = (guid: string, name: string): SceneOwnedNode => ({ parentLocalId: 7, guid, name, traits: { Transform: { x: 1 } }, children: [] });
function ctx(identity: Record<string, { guid: string; name?: string }> = {}, owned: SceneOwnedNode[] = []): SerializeContext {
  return { identity: new Map(Object.entries(identity)) as MemberIdentity, sceneOwned: (g) => owned.find((n) => n.guid === g) };
}

describe('serializeInstanceRecord: the scene v20 entry (#2008)', () => {
  it('an untouched instance writes its placement, its root name and nothing else', () => {
    const { entry, superseded } = serializeInstanceRecord(record(), ctx());
    expect(entry).toEqual({
      name: 'Ship',
      traits: { EntityAttributes: { sortOrder: 0 } },
      prefab: SRC,
      guid: ROOT,
      members: { '/': { traits: { EntityAttributes: { name: 'Ship' } } } },
    });
    expect(superseded).toEqual([]);
  });

  it('placement lives on the entry: parentId, editorFolder and sourceScene when set, sortOrder ALWAYS (F7)', () => {
    const rec = record({}, { placement: { parent: G1, sortOrder: 4, name: 'Ship', editorFolder: 'Fleet', sourceScene: 'base.scene.json' } });
    expect(serializeInstanceRecord(rec, ctx()).entry.traits).toEqual({ EntityAttributes: { parentId: G1, sortOrder: 4, editorFolder: 'Fleet', sourceScene: 'base.scene.json' } });
  });

  it("the root's name is a default override: placement.name is written on the \"/\" row first, over any name the row holds", () => {
    const rec = record({ '/': { traits: { EntityAttributes: { isActive: false, name: 'Stale' }, Transform: { x: 2 } } } }, {
      placement: { parent: '', sortOrder: 1, name: 'Renamed' },
    });
    const { entry, superseded } = serializeInstanceRecord(rec, ctx());
    expect(JSON.stringify(entry.members!['/'])).toBe(JSON.stringify({
      traits: { EntityAttributes: { name: 'Renamed', isActive: false }, Transform: { x: 2 } },
    }));
    expect(entry.name).toBe('Renamed');
    // The shadowed name is reported, never dropped silently.
    expect(superseded).toEqual([{ path: ['members', '/', 'traits', 'EntityAttributes', 'name'], value: 'Stale' }]);
  });

  it('the root is not a member: an identity for "/" writes no pin there (its guid is the entry\'s)', () => {
    const { entry } = serializeInstanceRecord(record(), ctx({ '/': { guid: ROOT, name: 'Ship' } }));
    expect(entry.members!['/']).toEqual({ traits: { EntityAttributes: { name: 'Ship' } } });
  });

  it('a row that states nothing is not written', () => {
    expect(Object.keys(serializeInstanceRecord(record({ [`/${M1}`]: {} }), ctx()).entry.members!)).toEqual(['/']);
  });

  it('rows are sorted by key, and each row states its fields in one fixed order', () => {
    const rec = record({
      [`/${M2}`]: { removed: true },
      [`/${M1}`]: { own: [{ guid: OWN }], removed: false, traitRemovals: { Light: true }, traits: { Sprite: { tint: '#f00' } }, parent: G2, name: 'Old', guid: G1 },
    });
    const { entry } = serializeInstanceRecord(rec, ctx({}, [node(OWN, 'Badge')]));
    expect(Object.keys(entry.members!)).toEqual(['/', `/${M1}`, `/${M2}`]);
    expect(Object.keys(entry.members![`/${M1}`])).toEqual(['guid', 'name', 'parent', 'traits', 'traitRemovals', 'removed', 'own']);
  });

  it('traits and fields keep the record\'s own order (load → save verbatim)', () => {
    const rec = record({ [`/${M1}`]: { traits: { Zed: { b: 1, a: 2 }, Alpha: true } } });
    expect(JSON.stringify(serializeInstanceRecord(rec, ctx()).entry.members![`/${M1}`].traits)).toBe('{"Zed":{"b":1,"a":2},"Alpha":true}');
  });

  describe('identity pins (rule 5, § 2.7, § 10.4 L2)', () => {
    it('every present member gets a pin row, though the list holds no record for it', () => {
      const { entry } = serializeInstanceRecord(record(), ctx({ [`/${M1}`]: { guid: G1, name: 'Button' } }));
      expect(entry.members![`/${M1}`]).toEqual({ guid: G1, name: 'Button' });
    });

    it('parsed pins are kept verbatim over the projection\'s; the projection fills only a pin the list lacks', () => {
      const rec = record({ [`/${M1}`]: { guid: G1, name: 'Old' }, [`/${M2}`]: { guid: G2 } });
      const { entry } = serializeInstanceRecord(rec, ctx({ [`/${M1}`]: { guid: G2, name: 'New' }, [`/${M2}`]: { guid: G1, name: 'Filled' } }));
      expect(entry.members![`/${M1}`]).toEqual({ guid: G1, name: 'Old' });
      expect(entry.members![`/${M2}`]).toEqual({ guid: G2, name: 'Filled' });
    });

    it('a GONE member\'s pin (in the list, not in the projection) is kept verbatim', () => {
      const { entry } = serializeInstanceRecord(record({ [`/${M2}`]: { guid: G2, name: 'Gone' } }), ctx());
      expect(entry.members![`/${M2}`]).toEqual({ guid: G2, name: 'Gone' });
    });
  });

  describe('scene-owned added nodes (`own`)', () => {
    it('a link writes the live node\'s content, anchored by its row (parentLocalId 0)', () => {
      const { entry } = serializeInstanceRecord(record({ [`/${M1}`]: { own: [{ guid: OWN }] } }), ctx({}, [node(OWN, 'Badge')]));
      expect(entry.members![`/${M1}`].own).toEqual([{ parentLocalId: 0, guid: OWN, name: 'Badge', traits: { Transform: { x: 1 } }, children: [] }]);
    });

    it('a node the projection could not place is written from held.heldOwn, verbatim, in link order', () => {
      const rec = record({ [`/${M1}`]: { own: [{ guid: OWN2 }, { guid: OWN }] } }, {
        held: { heldOwn: new Map([[`/${M1}`, [node(OWN, 'Held'), node(OWN2, 'Held2')]]]) },
      });
      const own = serializeInstanceRecord(rec, ctx()).entry.members![`/${M1}`].own!;
      expect(own.map((n) => [n.guid, n.name, n.parentLocalId])).toEqual([[OWN2, 'Held2', 0], [OWN, 'Held', 0]]);
    });

    it('a held node no link names is still written, after the linked ones, even under a row the list does not hold', () => {
      const rec = record({ [`/${M1}`]: { own: [{ guid: OWN }] } }, {
        held: { heldOwn: new Map([[`/${M1}`, [node(OWN2, 'Unlinked')]], [`/${M2}`, [node(OWN2 + 'x', 'Orphan')]]]) },
      });
      const { entry } = serializeInstanceRecord(rec, ctx({}, [node(OWN, 'Live')]));
      expect(entry.members![`/${M1}`].own!.map((n) => n.name)).toEqual(['Live', 'Unlinked']);
      expect(entry.members![`/${M2}`].own!.map((n) => n.name)).toEqual(['Orphan']);
    });

    it('a link with no content anywhere is reported, not written, and does not stop the rest of the save (§ 10.2)', () => {
      const { entry, danglingOwn } = serializeInstanceRecord(record({ [`/${M1}`]: { own: [{ guid: OWN }, { guid: OWN2 }] } }), ctx({}, [node(OWN2, 'Live')]));
      expect(danglingOwn).toEqual([{ key: `/${M1}`, guid: OWN }]);
      expect(entry.members![`/${M1}`].own!.map((n) => n.guid)).toEqual([OWN2]);
    });
  });

  describe('held values written back verbatim (format rule exceptions)', () => {
    it('pendingLegacy channels go back as the file stated them', () => {
      const pendingLegacy = {
        overrides: { 3: { Transform: { x: 9 } } },
        removed: [5],
        nestedOverrides: { '4': { 2: { Light: { intensity: 3 } } } },
      };
      const { entry, superseded } = serializeInstanceRecord(record({}, { held: { pendingLegacy } }), ctx());
      expect(entry.overrides).toEqual(pendingLegacy.overrides);
      expect(entry.removed).toEqual([5]);
      expect(entry.nestedOverrides).toEqual(pendingLegacy.nestedOverrides);
      expect(superseded).toEqual([]);
    });

    it('a pending legacy row (a whole-list pin no reader could convert) merges into the written row, and rows stay in key order', () => {
      const rec = record({ [`/${M2}`]: { removed: true } }, {
        held: { pendingLegacy: { members: { [`/${M2}`]: { removedTraits: ['Light'] }, [`/${M1}`]: { added: [] } } } },
      });
      const { entry, superseded } = serializeInstanceRecord(rec, ctx());
      expect(entry.members![`/${M2}`]).toEqual({ removed: true, removedTraits: ['Light'] });
      expect(entry.members![`/${M1}`]).toEqual({ added: [] });
      expect(Object.keys(entry.members!)).toEqual(['/', `/${M1}`, `/${M2}`]);
      expect(superseded).toEqual([]);
    });

    it('a held remainder of a whole list goes back with its `heldRemainder: true` marker, in both forms (hub ruling C, #2006)', () => {
      // The parser converts a container carrying the marker ADDITIVELY on reload; without it, the remainder reads as the
      // whole list and the siblings it omits are removed. The exact key is the contract.
      const slot = { heldRemainder: true, removed: [99] };
      const row = { heldRemainder: true, added: [{ parentLocalId: 0, guid: '', key: 'k2', name: 'K2', traits: {}, children: [] }] };
      const { entry } = serializeInstanceRecord(record({}, { held: { pendingLegacy: { nestedStructure: { '3': slot }, members: { [`/${M1}`]: row } } } }), ctx());
      expect(entry.nestedStructure).toEqual({ '3': { heldRemainder: true, removed: [99] } });
      expect(entry.members![`/${M1}`]).toEqual(row);
      const { fields } = serializeTemplateOwner({ rows: new Map(), held: { pendingLegacy: { nestedStructure: { '3': slot }, members: { [`/${M1}`]: row } } } });
      expect(fields.nestedStructure).toEqual({ '3': { heldRemainder: true, removed: [99] } });
      expect((fields.members as Record<string, unknown>)[`/${M1}`]).toEqual(row);
    });

    it('pending legacy goes back before unparsed: an unparsed value at the same place is the one reported', () => {
      const { entry, superseded } = serializeInstanceRecord(record({}, { held: { pendingLegacy: { removed: [5] }, unparsed: { removed: 'x' } } }), ctx());
      expect(entry.removed).toEqual([5]);
      expect(superseded).toEqual([{ path: ['removed'], value: 'x' }]);
    });

    it('an unparsed value goes back under its own channel; one the written form supersedes is reported, not dropped silently', () => {
      const { entry, superseded } = serializeInstanceRecord(record({}, { held: { unparsed: { removed: 'x', traits: 5 } } }), ctx());
      expect((entry as Record<string, unknown>).removed).toBe('x');
      expect(entry.traits).toEqual({ EntityAttributes: { sortOrder: 0 } });
      expect(superseded).toEqual([{ path: ['traits'], value: 5 }]);
    });

    it('with nothing held, no legacy channel is ever written', () => {
      const rec = record({ [`/${M1}`]: { traits: { Light: { on: true } }, removed: false } });
      expect(Object.keys(serializeInstanceRecord(rec, ctx({ [`/${M1}`]: { guid: G1 } })).entry).sort()).toEqual(['guid', 'members', 'name', 'prefab', 'traits']);
    });
  });

  it('the output shares nothing with the record: mutating it leaves the record as it was', () => {
    const ownNode = node(OWN, 'Badge');
    const rec = record({ [`/${M1}`]: { traits: { Light: { on: true } }, traitRemovals: { X: true }, own: [{ guid: OWN }] }, '/': { traits: { Transform: { x: 1 } } } }, {
      held: {
        pendingLegacy: { overrides: { 3: { T: { x: 1 } } } }, unparsed: { weird: { deep: 1 } },
        heldOwn: new Map([[`/${M1}`, [node(OWN2, 'Held')]]]),
      },
    });
    const before = structuredClone({ rows: [...rec.list.rows], held: rec.held, ownNode });
    const { entry } = serializeInstanceRecord(rec, ctx({}, [ownNode]));
    const row = entry.members![`/${M1}`];
    (row.traits!.Light as Record<string, unknown>).on = false;
    row.traitRemovals!.X = false;
    row.own![0].traits.Transform = { x: 99 };
    (row.own![1].traits.Transform as Record<string, unknown>).x = 99;
    (entry.members!['/'].traits!.Transform as Record<string, unknown>).x = 99;
    (entry.overrides as Record<number, Record<string, Record<string, unknown>>>)[3].T.x = 99;
    ((entry as Record<string, unknown>).weird as Record<string, unknown>).deep = 99;
    expect({ rows: [...rec.list.rows], held: rec.held, ownNode }).toEqual(before);
  });

  it('is a function of its inputs: two writes give the same bytes', () => {
    const rec = record({ [`/${M2}`]: { removed: true }, [`/${M1}`]: { traits: { Light: { on: true } } } });
    const c = ctx({ [`/${M1}`]: { guid: G1, name: 'A' } });
    expect(JSON.stringify(serializeInstanceRecord(rec, c))).toBe(JSON.stringify(serializeInstanceRecord(rec, c)));
  });
});

describe('serializeTemplateOwner: what a prefab v10 reference row states (#2008)', () => {
  const tmpl = (rows: Record<string, TemplateTargetRecord>) => ({ rows: new Map(Object.entries(rows)) });
  const tm = (l: ReturnType<typeof tmpl>) => serializeTemplateOwner(l).fields.members as Record<string, TemplateRowJson>;

  it('writes the "/" row\'s name and sortOrder as records, sorted rows, one fixed field order', () => {
    const out = tm(tmpl({
      [`/${M2}`]: { removed: true },
      '/': { traits: { EntityAttributes: { name: 'Flames', sortOrder: 2 } } },
      [`/${M1}`]: { removed: false, traitRemovals: { Light: true }, traits: { Sprite: { tint: '#0f0' } }, parent: '@member:3' },
    }));
    expect(Object.keys(out)).toEqual(['/', `/${M1}`, `/${M2}`]);
    expect(out['/']).toEqual({ traits: { EntityAttributes: { name: 'Flames', sortOrder: 2 } } });
    expect(Object.keys(out[`/${M1}`])).toEqual(['parent', 'traits', 'traitRemovals', 'removed']);
  });

  it('carries no identity pins (I8), even if a record somehow holds one', () => {
    const out = tm(tmpl({ [`/${M1}`]: { guid: G1, name: 'Pin', removed: true } as TemplateTargetRecord }));
    expect(out[`/${M1}`]).toEqual({ removed: true });
  });

  it('writes added nodes in template shape (guid \'\', parentLocalId 0, key), a reference node\'s own list recursively', () => {
    const out = tm(tmpl({
      '/': {
        own: [{
          key: 'lamp', name: 'Lamp', traits: { Light: { intensity: 3 } },
          children: [{ key: 'bulb', name: 'Bulb', traits: {}, children: [] }],
        }, {
          key: 'gun', name: 'Gun', traits: {}, children: [], prefab: SRC,
          members: { [`/${M2}`]: { removed: true }, '/': { traits: { EntityAttributes: { name: 'Gun' } } } },
        }],
      },
    }));
    expect(out['/'].own).toEqual([
      { parentLocalId: 0, guid: '', key: 'lamp', name: 'Lamp', traits: { Light: { intensity: 3 } },
        children: [{ parentLocalId: 0, guid: '', key: 'bulb', name: 'Bulb', traits: {}, children: [] }] },
      { parentLocalId: 0, guid: '', key: 'gun', name: 'Gun', traits: {}, children: [], prefab: SRC,
        members: { '/': { traits: { EntityAttributes: { name: 'Gun' } } }, [`/${M2}`]: { removed: true } } },
    ]);
    expect(Object.keys(out['/'].own![1].members!)).toEqual(['/', `/${M2}`]);
  });

  it('an empty row writes nothing', () => {
    expect(tm(tmpl({ [`/${M1}`]: {} }))).toEqual({});
  });

  it('a reference row\'s held values go back beside `members`, pending legacy first, a superseded one reported', () => {
    const list = {
      ...tmpl({ [`/${M1}`]: { removed: true } }),
      held: {
        pendingLegacy: { overrides: { 1: { Transform: { x: 3 } } }, members: { [`/${M2}`]: { removedTraits: ['Light'] } } },
        unparsed: { removed: 'x', overrides: 7 },
      },
    };
    const { fields, superseded } = serializeTemplateOwner(list);
    expect(fields).toEqual({
      members: { [`/${M1}`]: { removed: true }, [`/${M2}`]: { removedTraits: ['Light'] } },
      overrides: { 1: { Transform: { x: 3 } } },
      removed: 'x',
    });
    expect(superseded).toEqual([{ path: ['overrides'], value: 7 }]);
  });

  it('a template reference node\'s held values go back on the node; a superseded one is reported with its path', () => {
    const { fields, superseded } = serializeTemplateOwner(tmpl({
      '/': { own: [{ key: 'gun', name: 'Gun', traits: {}, children: [], prefab: SRC, held: { pendingLegacy: { nestedOverrides: { '2': { 1: { L: { on: true } } } } }, unparsed: { name: 5 } } }] },
    }));
    const gun = (fields.members as Record<string, TemplateRowJson>)['/'].own![0] as unknown as Record<string, unknown>;
    expect(gun.nestedOverrides).toEqual({ '2': { 1: { L: { on: true } } } });
    expect(gun.name).toBe('Gun');
    expect(superseded).toEqual([{ path: ['members', '/', 'own', '0', 'name'], value: 5 }]);
  });

  it('shares nothing with the list: mutating the output leaves the held values as they were', () => {
    const held = { pendingLegacy: { overrides: { 1: { T: { x: 1 } } } } };
    const { fields } = serializeTemplateOwner({ ...tmpl({}), held });
    (fields.overrides as Record<number, Record<string, Record<string, unknown>>>)[1].T.x = 99;
    expect(held.pendingLegacy.overrides[1].T.x).toBe(1);
  });
});

describe('serializeTemplateDocHeld: a prefab document\'s own held moves (#2008, design § 10.4b)', () => {
  it('writes the held document-level moves back verbatim, and nothing when there are none', () => {
    const docHeld = { moved: { 'a.b': '@member:3' } };
    const out = serializeTemplateDocHeld(docHeld);
    expect(out).toEqual({ moved: { 'a.b': '@member:3' } });
    out.moved!['a.b'] = 'changed';
    expect(docHeld.moved['a.b']).toBe('@member:3');
    expect(serializeTemplateDocHeld(undefined)).toEqual({});
    expect(serializeTemplateDocHeld({ moved: {} })).toEqual({});
  });
});

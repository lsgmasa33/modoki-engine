/** #1937 C-A step 1: `documentIdentity.ts`, the one owner of a document's identifiers (owner rulings F-A (1), F-C yes).
 *  T1–T4 of the design, plus the scene check's own cases. Each names the mutation that turns it red. */

import { describe, it, expect } from 'vitest';
import { admitPrefabDocument, sceneIdentityRefusal } from '../../src/runtime/loaders/documentIdentity';

const X = 'cccccccc-0000-4000-8000-000000193701';
const node = (name: string, key?: string, extra: Record<string, unknown> = {}) => ({ parentLocalId: 1, guid: '', name, traits: {}, children: [], ...(key ? { key } : {}), ...extra });
/** P: row 1 (root), rows 2 and 3 reference X; `patch` puts template nodes on them. */
const doc = (patch: (rows: Array<Record<string, unknown>>) => void = () => {}, id = 'cccccccc-0000-4000-8000-000000193700') => {
  const rows: Array<Record<string, unknown>> = [
    { localId: 1, name: 'R', nodeGuid: 'eeeeeeee-0000-4000-8000-000000193701', traits: {} },
    { localId: 2, name: 'N2', nodeGuid: 'eeeeeeee-0000-4000-8000-000000193702', prefab: X, traits: {} },
    { localId: 3, name: 'N3', nodeGuid: 'eeeeeeee-0000-4000-8000-000000193703', prefab: X, traits: {} },
  ];
  patch(rows);
  return { id, version: 9, name: 'P', rootLocalId: 1, entities: rows };
};
const refusal = (d: unknown) => { const r = admitPrefabDocument(d); return 'refusal' in r ? r.refusal : null; };

describe('admitPrefabDocument (#1937 C-A step 1)', () => {
  // T1. Mutation: drop the key-repeat loop in `documentRepeat` — every case admits.
  it('T1: refuses a template key repeated in one frame — an added list, a child, a nestedStructure slot, a member row\'s own', () => {
    expect(refusal(doc((r) => { r[1]!.added = [node('A', 'k1'), node('B', 'k1')]; }))).toMatch(/template key k1 to two nodes in one frame \(A and B\)/);
    expect(refusal(doc((r) => { r[1]!.added = [node('A', 'k1', { children: [node('A1', 'k2')] }), node('B', 'k2')]; }))).toMatch(/template key k2/);
    expect(refusal(doc((r) => { r[1]!.nestedStructure = { '5': { added: [node('A', 'k1'), node('B', 'k1')] } }; }))).toMatch(/template key k1/);
    expect(refusal(doc((r) => { r[1]!.members = { '/g9': { added: [node('A', 'k1')], own: [node('B', 'k1')] } }; }))).toMatch(/template key k1/);
  });

  // T2, the accept side. Mutation: key the groups by key alone (`walkTemplateNodes`' group → '') — each case refuses.
  it('T2: admits the same key in different frames — two reference rows, two slots, inside a reference node', () => {
    expect(refusal(doc((r) => { r[1]!.added = [node('A', 'k1')]; r[2]!.added = [node('B', 'k1')]; }))).toBeNull();
    expect(refusal(doc((r) => { r[1]!.nestedStructure = { '5': { added: [node('A', 'k1')] }, '6': { added: [node('B', 'k1')] } }; }))).toBeNull();
    expect(refusal(doc((r) => { r[1]!.added = [node('Ref', 'k0', { prefab: X, added: [node('B', 'k1')] }), node('A', 'k1')]; }))).toBeNull();
  });

  // T3 (F-C yes). Mutation: drop the `localId`/`nodeGuid` loop — both admit.
  it('T3: refuses a repeated row localId or nodeGuid', () => {
    expect(refusal(doc((r) => { r[2]!.localId = 2; }))).toMatch(/localId 2 to two rows \(N2 and N3\)/);
    expect(refusal(doc((r) => { r[2]!.nodeGuid = r[1]!.nodeGuid; }))).toMatch(/nodeGuid eeeeeeee-0000-4000-8000-000000193702 to two rows/);
    expect(refusal({ name: 'not one' })).toMatch(/not a prefab document/);
  });

  // T4. Mutations: (a) seed the mint without the document's id — the two documents' keys match; (b) mint over an existing
  // key (drop the `!str(n.key)` test) — the stated key changes; (c) mint into the input (skip the clone) — the input changes.
  it('T4: a keyless node gets a deterministic key, per document; a stated key is untouched; the input is not mutated', () => {
    const keyless = (id?: string) => doc((r) => { r[1]!.added = [node('A'), node('B', 'kept', { children: [node('C')] })]; }, id);
    const input = keyless();
    const a = admitPrefabDocument(input) as { doc: ReturnType<typeof doc> };
    const b = admitPrefabDocument(keyless()) as { doc: ReturnType<typeof doc> };
    const keysOf = (d: ReturnType<typeof doc>) => { const [n1, n2] = d.entities[1]!.added as Array<{ key?: string; children: Array<{ key?: string }> }>; return [n1!.key, n2!.key, n2!.children[0]!.key]; };
    const ka = keysOf(a.doc);
    expect(ka[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(ka[1]).toBe('kept');
    expect(new Set(ka).size).toBe(3);
    expect(keysOf(b.doc), 'the same document admitted twice mints the same keys').toEqual(ka);
    const other = admitPrefabDocument(keyless('cccccccc-0000-4000-8000-000000193799')) as { doc: ReturnType<typeof doc> };
    expect(keysOf(other.doc)[0], 'another document of the same shape mints its own').not.toBe(ka[0]);
    expect((input.entities[1]!.added as Array<{ key?: string }>)[0]!.key, 'the input is not mutated').toBeUndefined();
    const clean = doc();
    expect((admitPrefabDocument(clean) as { doc: unknown }).doc, 'nothing to mint: the document itself').toBe(clean);
  });

  // T4b (#1779's "nothing re-targets"). Mutations: (a) seed by the node's index instead of its content — inserting Other
  // before Extra hands Other Extra's key; (b) drop the ordinal among identical nodes — two identical nodes share one key
  // and the document refuses itself.
  it('T4b: a key is seeded by the node, not its place — an inserted node takes a new key, identical nodes two keys', () => {
    const keysOf = (nodes: Array<Record<string, unknown>>) => {
      const r = admitPrefabDocument(doc((rows) => { rows[1]!.added = nodes; }));
      if (!('doc' in r)) throw new Error((r as { refusal: string }).refusal);
      return ((r.doc as { entities: Array<{ added?: Array<{ name: string; key: string }> }> }).entities[1]!.added ?? []).map((n) => [n.name, n.key]);
    };
    const extra = node('Extra', undefined, { traits: { Transform: { x: 5 } } });
    const alone = Object.fromEntries(keysOf([extra]));
    const after = Object.fromEntries(keysOf([node('Other'), extra]));
    expect(after.Extra).toBe(alone.Extra);
    expect(after.Other).not.toBe(alone.Extra);
    const twins = keysOf([node('Twin'), node('Twin')]).map(([, k]) => k);
    expect(new Set(twins).size).toBe(2);
  });
});

describe('sceneIdentityRefusal (#1937 C-A step 1, #1933 L3)', () => {
  const G = (n: number) => `dddddddd-0000-4000-8000-0000001937${String(n).padStart(2, '0')}`;
  const scene = (entities: unknown[]) => ({ id: 's', name: 'S', version: 19, entities });
  const entry = (guid: string, extra: Record<string, unknown> = {}) => ({ prefab: X, guid, traits: { EntityAttributes: { name: `E-${guid.slice(-2)}`, parentId: 0 } }, ...extra });
  const added = (guid: string, key?: string) => ({ parentLocalId: 1, guid, name: `n-${guid.slice(-2)}`, traits: {}, children: [], ...(key ? { key } : {}) });

  // Mutation: `define` never reports (drop its `first !== undefined` branch) — every reject case passes.
  it('refuses a guid defined twice: two entries, two scene-added nodes (L3), a member pin beside an entry', () => {
    expect(sceneIdentityRefusal(scene([entry(G(1)), entry(G(1))]))).toMatch(/defines guid .*01 twice/);
    expect(sceneIdentityRefusal(scene([entry(G(1), { added: [added(G(2)), added(G(2))] })]))).toMatch(/defines guid .*02 twice/);
    expect(sceneIdentityRefusal(scene([entry(G(1)), entry(G(3), { members: { '/x': { guid: G(1) } } })]))).toMatch(/defines guid .*01 twice/);
  });

  // Mutation: `keysOnce` never reports — the first case passes.
  it('refuses a key repeated in one list, and admits it in two lists', () => {
    expect(sceneIdentityRefusal(scene([entry(G(1), { added: [added(G(2), 'k'), added(G(3), 'k')] })]))).toMatch(/gives key k to two nodes in one list/);
    expect(sceneIdentityRefusal(scene([entry(G(1), { added: [added(G(2), 'k')] }), entry(G(4), { added: [added(G(3), 'k')] })]))).toBeNull();
  });

  it('accept side: every guid single, in every channel', () => {
    expect(sceneIdentityRefusal(scene([
      entry(G(1), { added: [added(G(2))], members: { '/x': { guid: G(5), added: [added(G(6))] } }, nestedStructure: { '3': { added: [added(G(7))] } } }),
      entry(G(4)),
    ]))).toBeNull();
  });
});

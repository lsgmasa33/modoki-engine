/** The Inspector's "Missing component" rows (#1944): which rows a selection shows, and when Remove is refused. Decisions
 *  only, against an injected source — the live wiring (a loaded scene, the Remove's undo, what the save writes) is
 *  pinned in unusedOverrides.test.ts beside the data half it builds on. */

import { describe, it, expect } from 'vitest';
import {
  missingComponentRows, missingRemoveRefusal, missingRowsKey, MISSING_REMOVE_ON_TEMPLATE_MEMBER,
  type MissingComponentSource,
} from '../../packages/modoki/src/editor/panels/missingComponentRows';

const source = (bags: Record<number, Record<string, unknown> | undefined>, members: number[] = []): MissingComponentSource => ({
  bagOf: (id) => bags[id],
  isTemplateMember: (id) => members.includes(id),
});

describe('missingComponentRows (#1944)', () => {
  it('one entity: a row per missing component, sorted by name, Remove allowed', () => {
    expect(missingComponentRows([1], source({ 1: { Zeta: {}, Alpha: { speed: 1 } } }))).toEqual([
      { name: 'Alpha', removeRefusal: null },
      { name: 'Zeta', removeRefusal: null },
    ]);
  });

  // Mutation: return the union instead of the intersection — Only1 appears.
  it('a multi-selection shows only the names EVERY entity carries, as the Inspector does for traits', () => {
    const src = source({ 1: { Shared: {}, Only1: {} }, 2: { Shared: { x: 2 } } });
    expect(missingComponentRows([1, 2], src).map((r) => r.name)).toEqual(['Shared']);
  });

  it('nothing when any selected entity has no record, and nothing for an empty selection', () => {
    expect(missingComponentRows([1, 2], source({ 1: { A: {} } }))).toEqual([]);
    expect(missingComponentRows([], source({}))).toEqual([]);
  });

  // Mutation: `every` → `some` in missingRemoveRefusal — the mixed selection is allowed.
  it('Remove is refused when any selected entity is a template member — its prefab holds the data', () => {
    expect(missingRemoveRefusal([1], source({}, [1]))).toBe(MISSING_REMOVE_ON_TEMPLATE_MEMBER);
    expect(missingRemoveRefusal([1, 2], source({}, [2]))).toBe(MISSING_REMOVE_ON_TEMPLATE_MEMBER);
    expect(missingRemoveRefusal([1, 2], source({}, []))).toBeNull();
    expect(missingComponentRows([1], source({ 1: { A: {} } }, [1]))[0]!.removeRefusal).toBe(MISSING_REMOVE_ON_TEMPLATE_MEMBER);
  });

  // The Inspector re-renders on a key change only. Mutation: key on names alone — the refusal flip is invisible.
  it('the row key changes with a name and with a refusal, and not otherwise', () => {
    const a = missingComponentRows([1], source({ 1: { A: {} } }));
    expect(missingRowsKey(a)).toBe(missingRowsKey(missingComponentRows([1], source({ 1: { A: { changed: 1 } } }))));
    expect(missingRowsKey(a)).not.toBe(missingRowsKey(missingComponentRows([1], source({ 1: { B: {} } }))));
    expect(missingRowsKey(a)).not.toBe(missingRowsKey(missingComponentRows([1], source({ 1: { A: {} } }, [1]))));
  });
});

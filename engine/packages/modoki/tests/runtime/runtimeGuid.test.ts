/** Runtime guids (#1210) — the shape, and the predicates every persistence site reads it through.
 *
 *  A runtime guid is the address `spawnEntity` mints for an entity spawned with no guid. It is valid
 *  only until its world is swapped out, so `durableGuid` must read it as "no guid" and
 *  `findRuntimeGuids` must find it anywhere a file or a storage value could carry it. */

import { describe, it, expect } from 'vitest';
import {
  isRuntimeGuid, formatRuntimeGuid, parseRuntimeGuid, durableGuid, findRuntimeGuids,
  isGuid, newGuid, deriveGuid,
} from '../../src/runtime/core/assetRefRules';

describe('runtime guid shape', () => {
  it('round-trips generation and ordinal, and is a GUID', () => {
    const g = formatRuntimeGuid(3, 42);
    expect(g).toBe('00000000-0000-0003-0000-00000000002a');
    expect(isGuid(g)).toBe(true);
    expect(isRuntimeGuid(g)).toBe(true);
    expect(parseRuntimeGuid(g)).toEqual({ generation: 3, ordinal: 42 });
  });

  it('carries the full 32-bit generation and 48-bit ordinal', () => {
    const g = formatRuntimeGuid(0xdeadbeef, 0xabcd_1234_5678);
    expect(g).toBe('00000000-dead-beef-0000-abcd12345678');
    expect(parseRuntimeGuid(g)).toEqual({ generation: 0xdeadbeef, ordinal: 0xabcd_1234_5678 });
  });

  it('refuses to FORMAT generation 0 or a wrapped one — it would read as durable everywhere', () => {
    expect(() => formatRuntimeGuid(0, 1)).toThrow(RangeError);
    expect(() => formatRuntimeGuid(0x1_0000_0000, 1)).toThrow(RangeError);
    expect(() => formatRuntimeGuid(-1, 1)).toThrow(RangeError);
    expect(isRuntimeGuid(formatRuntimeGuid(0xffffffff, 1))).toBe(true);
  });

  it('rejects the all-zero placeholder, a v4, a derived guid and non-guids', () => {
    // Generation 0 is never minted: the all-zero guid is already a placeholder elsewhere.
    expect(isRuntimeGuid('00000000-0000-0000-0000-000000000001')).toBe(false);
    expect(isRuntimeGuid('00000000-0000-0000-0000-000000000000')).toBe(false);
    for (let i = 0; i < 50; i++) expect(isRuntimeGuid(newGuid())).toBe(false);
    expect(isRuntimeGuid(deriveGuid('anchor|1.2'))).toBe(false);
    expect(isRuntimeGuid('')).toBe(false);
    expect(isRuntimeGuid(undefined)).toBe(false);
    expect(isRuntimeGuid('00000000-0000-0003-0000-00000000002')).toBe(false); // one hex short
    expect(isRuntimeGuid('00000000-0000-0003-0001-00000000002a')).toBe(false); // 4th group not 0000
  });
});

describe('durableGuid', () => {
  it('passes a real guid through and reads empty or runtime as ""', () => {
    const v4 = newGuid();
    expect(durableGuid(v4)).toBe(v4);
    expect(durableGuid(formatRuntimeGuid(1, 1))).toBe('');
    expect(durableGuid('')).toBe('');
    expect(durableGuid(undefined)).toBe('');
    expect(durableGuid(null)).toBe('');
  });
});

describe('findRuntimeGuids', () => {
  const rg = formatRuntimeGuid(7, 9);

  it('finds one in a nested value, in an array, embedded in a string, and as an object KEY', () => {
    const hits = findRuntimeGuids({
      entities: [{ traits: { EntityAttributes: { guid: rg } } }],
      overrides: { [`+added.${rg}`]: true },
      label: `target is ${rg}!`,
    });
    expect(hits.map((h) => h.path)).toEqual([
      'entities[0].traits.EntityAttributes.guid',
      `overrides.+added.${rg} (key)`,
      'label',
    ]);
    expect(hits.every((h) => h.guid === rg)).toBe(true);
  });

  it('finds nothing in a value holding only durable guids and the placeholder', () => {
    expect(findRuntimeGuids({
      a: newGuid(), b: [deriveGuid('x')], c: '00000000-0000-0000-0000-000000000000', d: 5, e: null,
    })).toEqual([]);
  });
});

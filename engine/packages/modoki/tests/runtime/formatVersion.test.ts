/** Shared format-version classifier (§ 2a of docs/format-versioning.md). */

import { describe, it, expect } from 'vitest';
import {
  classifyFormatVersion,
  classifyJsonFormatVersion,
  isReadable,
  preservedVersion,
  collectUnknownFields,
  mergeUnknownFields,
} from '../../src/runtime/core/formatVersion';

describe('classifyFormatVersion', () => {
  it('is ok when the stored version equals current', () => {
    expect(classifyFormatVersion({ version: 3 }, 3)).toEqual({ kind: 'ok', version: 3 });
  });

  it('is ok when the stored version is strictly lower than current, with no floor passed', () => {
    expect(classifyFormatVersion({ version: 1 }, 3)).toEqual({ kind: 'ok', version: 1 });
  });

  it('is too-new only when the stored version is strictly greater than current', () => {
    expect(classifyFormatVersion({ version: 4 }, 3)).toEqual({ kind: 'too-new', version: 4 });
  });

  it('is NOT too-new when the stored version equals current — the >= trap', () => {
    const verdict = classifyFormatVersion({ version: 3 }, 3);
    expect(verdict.kind).not.toBe('too-new');
    expect(verdict.kind).toBe('ok');
  });

  it('is absent when the version key is missing entirely', () => {
    expect(classifyFormatVersion({}, 3)).toEqual({ kind: 'absent' });
  });

  it('is absent when the version key is explicitly undefined', () => {
    expect(classifyFormatVersion({ version: undefined }, 3)).toEqual({ kind: 'absent' });
  });

  it('is unreadable/not-an-object for null', () => {
    expect(classifyFormatVersion(null, 3)).toEqual({ kind: 'unreadable', reason: 'not-an-object' });
  });

  it('is unreadable/not-an-object for a bare array', () => {
    expect(classifyFormatVersion([1, 2, 3], 3)).toEqual({
      kind: 'unreadable',
      reason: 'not-an-object',
    });
  });

  it('is unreadable/not-an-object for a string', () => {
    expect(classifyFormatVersion('nope', 3)).toEqual({
      kind: 'unreadable',
      reason: 'not-an-object',
    });
  });

  it('is unreadable/not-an-object for a number', () => {
    expect(classifyFormatVersion(3, 3)).toEqual({ kind: 'unreadable', reason: 'not-an-object' });
  });

  it('is unreadable/non-numeric-version for a stringly-typed version', () => {
    expect(classifyFormatVersion({ version: '2' }, 3)).toEqual({
      kind: 'unreadable',
      reason: 'non-numeric-version',
    });
  });

  it('is unreadable/non-numeric-version for a non-integer version', () => {
    expect(classifyFormatVersion({ version: 2.5 }, 3)).toEqual({
      kind: 'unreadable',
      reason: 'non-numeric-version',
    });
  });

  it('is unreadable/non-numeric-version for NaN', () => {
    expect(classifyFormatVersion({ version: NaN }, 3)).toEqual({
      kind: 'unreadable',
      reason: 'non-numeric-version',
    });
  });

  it('is unreadable/non-numeric-version for Infinity', () => {
    expect(classifyFormatVersion({ version: Infinity }, 3)).toEqual({
      kind: 'unreadable',
      reason: 'non-numeric-version',
    });
  });

  it('is too-old only when minReadable is passed and the version is below it', () => {
    expect(classifyFormatVersion({ version: 1 }, 3, { minReadable: 2 })).toEqual({
      kind: 'too-old',
      version: 1,
    });
  });

  it('the same low version is ok when minReadable is not passed — the floor is opt-in', () => {
    expect(classifyFormatVersion({ version: 1 }, 3)).toEqual({ kind: 'ok', version: 1 });
  });

  it('a version exactly at minReadable is ok, not too-old', () => {
    expect(classifyFormatVersion({ version: 2 }, 3, { minReadable: 2 })).toEqual({
      kind: 'ok',
      version: 2,
    });
  });

  it('reads the version from a custom field name — schema', () => {
    expect(classifyFormatVersion({ schema: 2 }, 3, { field: 'schema' })).toEqual({
      kind: 'ok',
      version: 2,
    });
  });

  it('reads the version from a custom field name — v', () => {
    expect(classifyFormatVersion({ v: 1 }, 3, { field: 'v' })).toEqual({ kind: 'ok', version: 1 });
  });
});

describe('classifyJsonFormatVersion', () => {
  it('maps a JSON syntax error to unreadable/unparsable', () => {
    expect(classifyJsonFormatVersion('{not json', 3)).toEqual({
      kind: 'unreadable',
      reason: 'unparsable',
    });
  });

  it('classifies a .meta.json with literal unresolved conflict markers as unparsable, not absent (#778)', () => {
    const conflicted = [
      '{',
      '<<<<<<< HEAD',
      '  "version": 2,',
      '  "guid": "abc123"',
      '=======',
      '  "version": 3,',
      '  "guid": "def456"',
      '>>>>>>> origin/main',
      '}',
    ].join('\n');
    expect(classifyJsonFormatVersion(conflicted, 3)).toEqual({
      kind: 'unreadable',
      reason: 'unparsable',
    });
  });

  it('delegates to classifyFormatVersion for a valid ok document', () => {
    expect(classifyJsonFormatVersion(JSON.stringify({ version: 1 }), 3)).toEqual({
      kind: 'ok',
      version: 1,
    });
  });

  it('delegates to classifyFormatVersion for a valid too-new document', () => {
    expect(classifyJsonFormatVersion(JSON.stringify({ version: 5 }), 3)).toEqual({
      kind: 'too-new',
      version: 5,
    });
  });
});

describe('isReadable', () => {
  it('is true for ok', () => {
    expect(isReadable({ kind: 'ok', version: 1 })).toBe(true);
  });

  it('is true for absent', () => {
    expect(isReadable({ kind: 'absent' })).toBe(true);
  });

  it('is false for too-new', () => {
    expect(isReadable({ kind: 'too-new', version: 5 })).toBe(false);
  });

  it('is false for too-old', () => {
    expect(isReadable({ kind: 'too-old', version: 1 })).toBe(false);
  });

  it('is false for unreadable', () => {
    expect(isReadable({ kind: 'unreadable', reason: 'not-an-object' })).toBe(false);
  });
});

describe('preservedVersion', () => {
  it('ok with a lower stored version returns current', () => {
    expect(preservedVersion({ kind: 'ok', version: 1 }, 3)).toBe(3);
  });

  it('too-new with a higher stored version returns the STORED (higher) one — the #735 guarantee', () => {
    expect(preservedVersion({ kind: 'too-new', version: 7 }, 3)).toBe(7);
  });

  it('absent normalizes to current, not preserved', () => {
    expect(preservedVersion({ kind: 'absent' }, 3)).toBe(3);
  });

  it('unreadable normalizes to current, not preserved', () => {
    expect(preservedVersion({ kind: 'unreadable', reason: 'unparsable' }, 3)).toBe(3);
  });
});

describe('collectUnknownFields', () => {
  it('returns undefined, not {}, when every key is known', () => {
    expect(collectUnknownFields({ version: 1, coins: 5 }, ['version', 'coins'])).toBeUndefined();
  });

  it('collects only the unknown keys, preserving their values', () => {
    const nested = { foo: 'bar' };
    expect(collectUnknownFields({ version: 1, coins: 5, extra: nested }, ['version', 'coins'])).toEqual(
      { extra: nested },
    );
  });

  it('returns undefined for a non-record input', () => {
    expect(collectUnknownFields([1, 2, 3], ['version'])).toBeUndefined();
    expect(collectUnknownFields(null, ['version'])).toBeUndefined();
    expect(collectUnknownFields('nope', ['version'])).toBeUndefined();
  });
});

describe('mergeUnknownFields', () => {
  it('the known fields win over a stale colliding key in the bag — the money case', () => {
    const known = { coins: 5 };
    const bag = { coins: 999, extra: 'keepme' };
    expect(mergeUnknownFields(known, bag)).toEqual({ coins: 5, extra: 'keepme' });
  });

  it('an undefined bag returns a copy of known, not the same reference', () => {
    const known = { coins: 5 };
    const result = mergeUnknownFields(known, undefined);
    expect(result).toEqual(known);
    expect(result).not.toBe(known);
  });
});

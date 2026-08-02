/** The predicate that decides what a trait PERSISTS.
 *
 *  Three call sites depend on it (override capture, the editor apply, the loader
 *  apply), and the bug it replaced was subtle enough to survive a full test suite
 *  — so pin the predicate itself, not only its consequences. See
 *  runtime/core/ecs/traitSchema.ts and docs/prefabs.md. */

import { describe, it, expect } from 'vitest';
import { trait } from 'koota';
import { isPersistentTraitField, isRuntimeOnlyField, soaSchema, traitFieldOrDefault } from '../../src/runtime/core/ecs/traitSchema';

/** SoA: a plain-object schema. `clips`/`clip` stand in for a field a custom
 *  Inspector section owns, so they persist while carrying no `fields` entry. */
const SoA = trait({ clips: '[]' as string, clip: '' as string, speed: 1, activeClip: '' as string });
/** AoS: a callback schema, so there is no key list to check against. */
const AoS = trait(() => ({ animSets: [] as string[], boneMaps: {} as Record<string, unknown> }));

const soaMeta = { trait: SoA, fields: { speed: { type: 'number' }, activeClip: { runtimeOnly: true } } } as never;
const aosMeta = { trait: AoS, fields: {} } as never;

describe('soaSchema', () => {
  it('exposes the schema keys for a SoA trait', () => {
    expect(Object.keys(soaSchema(soaMeta)!)).toEqual(['clips', 'clip', 'speed', 'activeClip']);
  });

  it('returns null for an AoS trait — no declared key set to check', () => {
    expect(soaSchema(aosMeta)).toBeNull();
  });
});

describe('isPersistentTraitField', () => {
  it('accepts a SoA field that has NO Inspector metadata (the bug)', () => {
    expect(isPersistentTraitField(soaMeta, 'clips')).toBe(true);
    expect(isPersistentTraitField(soaMeta, 'clip')).toBe(true);
  });

  it('accepts an ordinary SoA field that does have Inspector metadata', () => {
    expect(isPersistentTraitField(soaMeta, 'speed')).toBe(true);
  });

  it('REJECTS a field the schema does not declare — the renamed/retired case the old guard wanted', () => {
    expect(isPersistentTraitField(soaMeta, 'retiredField')).toBe(false);
  });

  it('accepts any field on an AoS trait, including one no schema lists', () => {
    expect(isPersistentTraitField(aosMeta, 'animSets')).toBe(true);
    expect(isPersistentTraitField(aosMeta, 'anythingAtAll')).toBe(true);
  });

  it('is about persistence, NOT lifetime — a runtimeOnly field is still a schema field', () => {
    // The two questions are orthogonal: this one says "the trait declares it",
    // and the caller separately decides whether to WRITE it (see below). Folding
    // them together here would silently drop runtime state on the APPLY paths,
    // which must restore every declared field.
    expect(isPersistentTraitField(soaMeta, 'activeClip')).toBe(true);
  });

  it('does not confuse an inherited Object.prototype key for a schema field', () => {
    // These names arrive from a FILE. The old `field in meta.fields` guard used
    // `in`, which walks the prototype chain and would have accepted both.
    expect(isPersistentTraitField(soaMeta, 'toString')).toBe(false);
    expect(isPersistentTraitField(soaMeta, 'constructor')).toBe(false);
  });
});

describe('isRuntimeOnlyField', () => {
  it('is true only for a field flagged runtimeOnly in the Inspector metadata', () => {
    expect(isRuntimeOnlyField(soaMeta, 'activeClip')).toBe(true);
    expect(isRuntimeOnlyField(soaMeta, 'speed')).toBe(false);
  });

  it('treats a field with NO Inspector metadata as persistent, not runtime-only', () => {
    // The whole defect in one assertion: absence from meta.fields says nothing
    // about a field's lifetime. Returning true here would re-lose Animator.clips
    // by the other door.
    expect(isRuntimeOnlyField(soaMeta, 'clips')).toBe(false);
  });
});

describe('traitFieldOrDefault', () => {
  // #75: serializeScene omits a field once its authored value equals the trait default
  // (isTraitDefault), so a raw-JSON read of that field is only correct by accident — this
  // is the resolver guard tests should use instead.
  it('prefers the authored value over the schema default', () => {
    expect(traitFieldOrDefault<number>(SoA, { speed: 42 }, 'speed')).toBe(42);
  });

  it('falls back to the schema default when the field is absent from the bag', () => {
    expect(traitFieldOrDefault<number>(SoA, {}, 'speed')).toBe(1);
    expect(traitFieldOrDefault<number>(SoA, undefined, 'speed')).toBe(1);
  });

  it('an authored value of ""/0/false still wins — only `undefined` falls back', () => {
    expect(traitFieldOrDefault<string>(SoA, { activeClip: '' }, 'activeClip')).toBe('');
  });

  it('throws for a field the schema does not declare — never silently undefined', () => {
    expect(() => traitFieldOrDefault(SoA, {}, 'retiredField')).toThrow(/retiredField/);
  });

  it('throws for an AoS trait — no schema to read a default off', () => {
    expect(() => traitFieldOrDefault(AoS, {}, 'animSets')).toThrow();
  });
});

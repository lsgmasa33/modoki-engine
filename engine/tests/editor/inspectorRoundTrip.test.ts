/** Phase 1 — Inspector field inputs, data-driven over the real trait registry.
 *
 *  Rather than hand-writing a test per field, this iterates every registered
 *  component trait field the Inspector can edit, writes a representative value
 *  through the real `writeTraitFieldWithUndo` path, and asserts it round-trips:
 *    write → readTraitData equals · undo → restores old · redo → reapplies new.
 *
 *  A trait/field added to app/ecs/registerTraits.ts is covered automatically. */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getAllTraits, readTraitData, getCurrentWorld, getTraitByName,
  type TraitMeta,
} from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { writeTraitFieldWithUndo, setActionCallback } from '@modoki/engine/editor';
import { pushAction, clearHistory, undo, redo } from '@modoki/engine/editor';

registerAllTraits();
setActionCallback(pushAction);

beforeEach(() => clearHistory());

type FieldHint = TraitMeta['fields'][string];

/** Produce a value of the field's type that differs from `old` where possible,
 *  staying within any declared min/max / enum options. */
function pickDistinct(hint: FieldHint, old: unknown): unknown {
  switch (hint.type) {
    case 'boolean':
      return !old;
    case 'enum': {
      const opts = hint.options ?? [];
      return opts.find(o => o !== old) ?? old;
    }
    case 'string':
      return old === 'rt-test' ? 'rt-test-2' : 'rt-test';
    case 'color':
    case 'number': {
      const { min, max } = hint;
      const base = typeof old === 'number' ? old : 0;
      let cand = base + 1;
      if (max != null && cand > max) cand = base - 1;
      if (min != null && cand < min) cand = min;
      if (max != null && cand > max) cand = max;
      return cand;
    }
  }
  return old;
}

/** Spawn a bare entity carrying just `meta`'s trait (plus EntityAttributes so the
 *  entity is well-formed), and return its id. */
function spawnWith(meta: TraitMeta): number {
  const ea = getTraitByName('EntityAttributes')!;
  const entity = meta.name === 'EntityAttributes'
    ? getCurrentWorld().spawn(meta.trait({ name: 'rt' }))
    : getCurrentWorld().spawn(meta.trait(), ea.trait({ name: 'rt' }));
  return entity.id();
}

const editableComponents = getAllTraits().filter(
  m => m.category === 'component' && Object.keys(m.fields).length > 0,
);

describe('Inspector field round-trip (data-driven)', () => {
  it('covers a meaningful number of registered fields', () => {
    // Guards against the registry silently returning nothing (wiring regression).
    const fieldCount = editableComponents.reduce(
      (n, m) => n + Object.values(m.fields).filter(f => !f.readOnly).length, 0,
    );
    expect(editableComponents.length).toBeGreaterThan(5);
    expect(fieldCount).toBeGreaterThan(20);
  });

  for (const meta of editableComponents) {
    const fields = Object.entries(meta.fields).filter(([, h]) => !h.readOnly);
    if (fields.length === 0) continue;

    describe(meta.name, () => {
      for (const [field, hint] of fields) {
        it(`round-trips ${field} (${hint.type})`, async () => {
          const id = spawnWith(meta);
          const before = readTraitData(id, meta)!;
          const oldVal = before[field];
          const newVal = pickDistinct(hint, oldVal);

          writeTraitFieldWithUndo(id, meta, field, newVal);
          expect(readTraitData(id, meta)![field]).toEqual(newVal);

          await undo();
          expect(readTraitData(id, meta)![field]).toEqual(oldVal);

          await redo();
          expect(readTraitData(id, meta)![field]).toEqual(newVal);
        });
      }
    });
  }
});

/** RigidBody2D/3D: the AUTHORED launch velocity is saved, the solver read-back is not (#1592).
 *
 *  The defect: `vx/vy` were the only velocity fields, registered `runtimeOnly`, so the serializer
 *  (the Play snapshot AND every save) dropped an authored value — it launched once, Stop restored
 *  0, a save lost it. This pins the split through the REAL registration and the serializer's own
 *  rule (`isFieldWritten`), not a restated copy of it. */
import { describe, it, expect } from 'vitest';
import { RigidBody2D, RigidBody3D, getTraitMeta } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { isFieldWritten } from '../../packages/modoki/src/editor/scene/traitDefault';

registerAllTraits();

const CASES = [
  { name: 'RigidBody2D', trait: RigidBody2D, authored: ['initialVx', 'initialVy', 'initialAngularVel'], readBack: ['vx', 'vy', 'angularVel', 'launched'] },
  { name: 'RigidBody3D', trait: RigidBody3D, authored: ['initialVx', 'initialVy', 'initialVz', 'initialAvx', 'initialAvy', 'initialAvz'], readBack: ['vx', 'vy', 'vz', 'avx', 'avy', 'avz', 'launched'] },
] as const;

describe('RigidBody launch velocity persists; the read-back does not (#1592)', () => {
  for (const c of CASES) {
    const meta = getTraitMeta(c.trait)!;
    const schema = c.trait.schema as unknown as Record<string, unknown>;
    const hints = meta.fields as Record<string, { runtimeOnly?: boolean; readOnly?: boolean }>;

    it(`${c.name}: a non-default initial velocity is written by the serializer and editable`, () => {
      for (const f of c.authored) {
        expect(f in schema, `${f} in the trait schema`).toBe(true);
        expect(hints[f], `${f} has an Inspector hint`).toBeDefined();
        expect(hints[f].readOnly, `${f} editable`).toBeFalsy();
        expect(isFieldWritten(5, schema, f, hints[f] as never), `${f} written`).toBe(true);
      }
    });

    it(`${c.name}: the read-back velocity stays runtimeOnly (never saved)`, () => {
      for (const f of c.readBack) expect(isFieldWritten(f === 'launched' ? true : 5, schema, f, hints[f] as never), `${f} not written`).toBe(false);
    });
  }
});

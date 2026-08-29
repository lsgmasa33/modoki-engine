/**
 * Every persistent `AudioSource` field is reachable in the Inspector, or is on a NAMED exclusion
 * list with a reason.
 *
 * The gap this closes: `AudioSource.playlist` shipped as engine-read, scene-serialized authored
 * data with no Inspector row. Nothing failed — serialization walks the koota SCHEMA, so the value
 * saved and loaded correctly — the field was simply invisible, and the only way to change it was
 * hand-editing scene JSON. That is the inverse of this project's authoring rule, and the trait
 * field existed *because* the owner asked for the parameter to be exposed.
 *
 * The list below is EXCLUSIONS, not inclusions, which is what makes this guard hold: a new field
 * fails the test by default and the author has to either add a row or say why not. An
 * inclusion list would go stale silently on the first field somebody adds.
 */

import { describe, it, expect } from 'vitest';
import { getTraitByName } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';

/** Fields deliberately absent from `meta.fields`, each with the reason it is not a plain row. */
const EXCLUDED: Record<string, string> = {
  clips: 'owned by the AudioSourceClips bank editor, a custom Inspector section',
};

describe('AudioSource — every authored field is reachable in the editor', () => {
  it('has an Inspector row for every schema field except the named exclusions', () => {
    registerAllTraits();
    const meta = getTraitByName('AudioSource');
    expect(meta, 'AudioSource is registered').toBeTruthy();

    const schema = Object.keys((meta!.trait as unknown as { schema: Record<string, unknown> }).schema);
    const rows = new Set(Object.keys(meta!.fields ?? {}));
    const missing = schema.filter((f) => !rows.has(f) && !(f in EXCLUDED));

    expect(
      missing,
      `these AudioSource fields are authored data with no way to edit them — add a row in `
      + `registerTraits.ts, or add them to EXCLUDED here with the reason:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('keeps the exclusion list honest — every excluded field still exists', () => {
    // A renamed or removed field left in EXCLUDED would silently widen the guard's blind spot.
    registerAllTraits();
    const meta = getTraitByName('AudioSource');
    const schema = new Set(Object.keys((meta!.trait as unknown as { schema: Record<string, unknown> }).schema));
    for (const f of Object.keys(EXCLUDED)) expect(schema.has(f), `EXCLUDED names '${f}', which is gone`).toBe(true);
  });
});

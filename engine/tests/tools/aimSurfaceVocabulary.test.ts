/** The aim-surface vocabulary lives in ONE place — the MCP schema may not know fewer names than
 *  the backend can produce (#151).
 *
 *  WHY THIS GUARD EXISTS. `entityResolve.ts` gained `'game-ui'` when a UI entity turned out NOT to
 *  be a single DOM node (the editor mounts a UIRenderer in the Scene panel's preview frame AND the
 *  Game panel, so every full-screen overlay has two live nodes). The backend was updated, tested,
 *  and shipped. The MCP's `entitySpec` enum was not — so aiming at a two-mount UI entity became
 *  IMPOSSIBLE through the tool surface:
 *
 *    modoki_tap { entity:{ name:'FailedRetry' } }
 *      → REFUSED_BY_OP: rendered in 2 surfaces at once … Say which: surface:'game-ui'
 *    modoki_tap { entity:{ name:'FailedRetry', surface:'game-ui' } }
 *      → InputValidationError: Expected 'game-3d'|'game-2d'|'scene-view', received 'game-ui'
 *
 *  Both refusals individually correct; together a dead end with NO accepted value. Neither side's
 *  own tests could see it — each was internally consistent. Only a guard that compares the two
 *  vocabularies can, which is what this file is. It asserts a SUPERSET relation rather than
 *  equality of a hardcoded list, so adding a fifth surface fails here instead of silently
 *  reproducing the dead end.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UI_SURFACE_GAME, UI_SURFACE_SCENE_VIEW } from '../../app/debug/uiSurface';
import { makeEntitySpec } from '../../tools/modoki-mcp/src/shapes';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOUNDS_SURFACE_SRC = path.resolve(
  HERE, '../../packages/modoki/src/runtime/core/screenBounds.ts',
);

/** The 2D/3D surface names, read from the type that every bounds provider labels its rects with.
 *  Parsed from source because it is a TYPE — there is no runtime value to import. */
function boundsSurfaces(): string[] {
  const src = fs.readFileSync(BOUNDS_SURFACE_SRC, 'utf8');
  const m = src.match(/export type BoundsSurface\s*=\s*([^;]+);/);
  expect(m, 'BoundsSurface union not found — did screenBounds.ts move or get renamed?').toBeTruthy();
  const names = [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  expect(names.length).toBeGreaterThanOrEqual(3);
  return names;
}

/** Every surface name the resolver can report back to a caller: the 2D/3D bounds vocabulary plus
 *  the two UI hosts. Deliberately assembled from the SAME modules the runtime uses. */
function backendSurfaces(): string[] {
  return [...new Set([...boundsSurfaces(), UI_SURFACE_SCENE_VIEW, UI_SURFACE_GAME])];
}

/** The names the MCP tool schema will actually accept, read off the live zod enum. */
function schemaSurfaces(): string[] {
  const shape = (makeEntitySpec() as unknown as { shape: Record<string, unknown> }).shape;
  const field = shape.surface as { _def: { innerType?: { _def: { values: string[] } } } };
  // `.optional()` wraps the enum, so unwrap before reading its values.
  const values = field._def.innerType?._def.values;
  expect(values, 'entitySpec.surface is no longer an optional enum — has its shape changed?')
    .toBeTruthy();
  return values!;
}

describe('aim-surface vocabulary — schema vs backend (#151)', () => {
  it('the MCP schema accepts every surface the backend can name in a refusal', () => {
    const missing = backendSurfaces().filter((s) => !schemaSurfaces().includes(s));
    expect(
      missing,
      `entitySpec.surface rejects ${missing.join(', ')} — the backend can REFUSE an aim and tell ` +
      'the caller to pass exactly that value, so an omission here is an unreachable entity, not ' +
      'a cosmetic gap. Add it to the enum in engine/tools/modoki-mcp/src/shapes.ts.',
    ).toEqual([]);
  });

  it("'game-ui' specifically — the name the two-mount UI refusal hands out", () => {
    expect(schemaSurfaces()).toContain(UI_SURFACE_GAME);
  });

  it('the schema invents no surface the backend cannot produce', () => {
    // The other direction: an accepted value that never labels a real rect resolves to
    // "no bounds in surface 'x'" for every entity — a schema that promises a surface which
    // cannot exist is its own kind of dead end.
    const invented = schemaSurfaces().filter((s) => !backendSurfaces().includes(s));
    expect(invented).toEqual([]);
  });
});

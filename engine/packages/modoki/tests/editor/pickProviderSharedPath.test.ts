/** F15 (docs/enact.md) — the load-bearing rule from `screenPick.ts`'s header: a pick
 *  provider must call the SAME code path its surface's own pointer handler runs, never a second,
 *  independently-written raycast that merely happens to agree today. That rule can't be checked
 *  by driving SceneView (it needs a live WebGPU/Pixi viewport, which is not available headlessly
 *  — see the report), so this is a SOURCE-level assertion instead: it reads the file and confirms
 *  the exact identifier registered via `registerPickProvider` is the exact identifier the pointer
 *  handler calls, for both the 3D viewport and the 2D chrome overlay. A vacuous version of this
 *  test (merely "the string registerPickProvider appears") would pass even if someone rewired the
 *  registration to a second, drifted implementation — so it pins the IDENTIFIER match, not just
 *  presence. Still not a substitute for a live pick-vs-select-outcome check; see the plan's own
 *  test list for what remains a live-editor verification. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../../src/editor/panels/SceneView.tsx'), 'utf8');

/** Every `registerPickProvider(<fn>, 'scene-view'[, priority])` call, with the bare identifier
 *  passed as the provider — NOT an inline arrow (which would defeat this test: it could no longer
 *  prove the registered function IS the one below decorated as `onPointerDown`'s picker). The
 *  optional trailing `, <number>` is the #80 priority argument (the 2D overlay registers at 10,
 *  the 3D viewport at the implicit default). */
function registeredProviderNames(): string[] {
  const out: string[] = [];
  const re = /registerPickProvider\(([A-Za-z_$][\w$]*),\s*'scene-view'(?:,\s*\d+)?\)/g;
  for (const m of src.matchAll(re)) out.push(m[1]);
  return out;
}

describe('SceneView pick providers share the pointer handler\'s own code path', () => {
  it('registers a BARE named function as the provider (not a second, inline implementation)', () => {
    // If this fails because a call site switched to an inline `(x, y) => { ... }` arrow, that IS
    // the regression this test exists to catch — a fresh raycast beside the real one, not the SAME
    // one, is exactly the false-guarantee `screenPick.ts` warns against.
    const names = registeredProviderNames();
    expect(names.length).toBeGreaterThanOrEqual(2); // one 3D viewport + one 2D chrome overlay
  });

  it('the 3D-viewport registration and its onPointerDown call the SAME identifier', () => {
    const names = registeredProviderNames();
    expect(names).toContain('pickEntityAtViewportPoint');
    // The 3D onPointerDown (selection raycast) must call it — not recompute entries itself.
    const onPointerDown3D = src.slice(
      src.indexOf('function onPointerDown(event: PointerEvent)'),
      src.indexOf('function onPointerDown(event: PointerEvent)') + 800,
    );
    expect(onPointerDown3D).toMatch(/pickEntityAtViewportPoint\(event\.clientX, event\.clientY\)/);
  });

  it('the 2D chrome overlay\'s registration and its onPointerDown call the SAME identifier', () => {
    // Scope to installScene2DInteraction's own body — there is an UNRELATED
    // `onPointerDown(e: PointerEvent)` earlier in the file (a panel-pan handler) with no picking
    // in it at all, so an unscoped search would find the wrong one.
    const fnStart = src.indexOf('function installScene2DInteraction(');
    expect(fnStart).toBeGreaterThan(-1);
    const nextTopLevelFn = src.indexOf('\nfunction ', fnStart + 1);
    const body = src.slice(fnStart, nextTopLevelFn > -1 ? nextTopLevelFn : src.length);
    const idx = body.indexOf('function onPointerDown(e: PointerEvent)');
    expect(idx).toBeGreaterThan(-1);
    // No fixed window: onPointerDown runs a long gizmo/bone/collider hit-test chain BEFORE the
    // entity pick, and `body` is already scoped to installScene2DInteraction, so searching the
    // rest of it cannot cross into an unrelated function.
    const onPointerDown2D = body.slice(idx);
    expect(onPointerDown2D).toMatch(/pickEntityAtViewportPoint\(e\.clientX, e\.clientY\)/);
    // And the registration for THIS canvas is the same-named function, not a copy. Priority 10
    // (#80) — the 2D overlay must win over the 3D viewport when both answer.
    expect(body).toMatch(/registerPickProvider\(pickEntityAtViewportPoint, 'scene-view', 10\)/);
  });

  it('there is exactly ONE definition of `pickEntityAtViewportPoint` per scope (2D and 3D) — no drifted duplicate', () => {
    // Two definitions total: one inside installScene2DInteraction (2D), one inside the
    // ThreeJSViewport setup effect (3D). A THIRD would mean somebody pasted a divergent copy.
    const defs = [...src.matchAll(/function pickEntityAtViewportPoint\(/g)];
    expect(defs.length).toBe(2);
  });
});

/** #1206: `SceneViewGizmoTable` is only correct if SceneView drives it the way its contract assumes —
 *  one pass that opens before the first gizmo loop and closes after the last, loops in
 *  `GIZMO_LOOP_ORDER`, and a `clear()` wherever the rest of the per-entity objects are released (the
 *  world swap, which can reuse both an index and a world id, and the teardown). None of that is
 *  reachable headlessly — the frame callback needs a live WebGPU viewport — so, like
 *  `pickProviderSharedPath.test.ts`, this reads the SOURCE. Deleting `endPass()` would otherwise leave
 *  every other test green while no gizmo is ever released again. The live behaviour was measured on
 *  `games/3d-test` (see the module's docblock); this pins the wiring that measurement depended on. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { GIZMO_LOOP_ORDER } from '../../src/editor/scene/sceneViewGizmoTable';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../../src/editor/panels/SceneView.tsx'), 'utf8');

const indexesOf = (needle: string) => {
  const out: number[] = [];
  for (let i = src.indexOf(needle); i !== -1; i = src.indexOf(needle, i + 1)) out.push(i);
  return out;
};

const calls = [...src.matchAll(/gizmos\.(claim|keep)\(entity, '(\w+)'/g)].map((m) => ({ at: m.index!, kind: m[2] }));

describe('SceneView drives its gizmo table as the table\'s contract assumes (#1206)', () => {
  it('every gizmo loop claims or keeps through the table — one kind each, all seven present', () => {
    expect(new Set(calls.map((c) => c.kind))).toEqual(new Set(GIZMO_LOOP_ORDER));
  });

  it('exactly one pass, opened before the first claim and closed after the last', () => {
    const begins = indexesOf('gizmos.beginPass();');
    const ends = indexesOf('gizmos.endPass();');
    expect(begins).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(begins[0]).toBeLessThan(Math.min(...calls.map((c) => c.at)));
    expect(ends[0]).toBeGreaterThan(Math.max(...calls.map((c) => c.at)));
  });

  it('the loops appear in GIZMO_LOOP_ORDER', () => {
    const order = calls.map((c) => GIZMO_LOOP_ORDER.indexOf(c.kind as (typeof GIZMO_LOOP_ORDER)[number]));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('the world swap and the teardown each clear the table beside the other per-entity objects', () => {
    const swapStart = src.indexOf('const unsubSwap = onWorldSwap(() => {');
    const swapEnd = src.indexOf('scope.add(unsubSwap);', swapStart);
    expect(swapStart).toBeGreaterThan(-1);
    expect(src.slice(swapStart, swapEnd)).toContain('gizmos.clear();');

    const clears = indexesOf('gizmos.clear();');
    const disposes = indexesOf('disposeSceneViewEntityObjects(scene, {');
    expect(clears).toHaveLength(2);
    expect(disposes).toHaveLength(2);
    // Each clear sits right after one of the two release sites, so neither can drift from the other.
    for (const d of disposes) expect(clears.some((c) => c > d && c - d < 800)).toBe(true);
  });

  it('the shared camera pivot is shown only while a camera row holds it', () => {
    // How `pivotHeld` is derived, not merely that it is read: starting it `true` restores the old
    // always-visible pivot, which draws an icon nothing can pick.
    const at = src.indexOf('let pivotHeld = false;');
    expect(at).toBeGreaterThan(-1);
    const visibility = src.slice(at, src.indexOf('camGizmoPivot.visible = !isUI && pivotHeld;', at) + 1);
    expect(visibility).toContain('for (const [, g, kind] of gizmos) {');
    expect(visibility).toContain('if (g === camGizmoPivot) pivotHeld = true;');
  });

  it('only a camera whose claim succeeds poses the shared pivot', () => {
    const anchor = "if (gizmos.claim(entity, 'camera', () => camGizmoPivot)) {";
    const start = src.indexOf(anchor);
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf('\n          }\n', start));
    for (const pose of ['camGizmoPivot.position.copy(_svCamPos);', 'camGizmoPivot.rotation.set(rx, ry, rz);', 'updateCamFrustum(cam.fov,']) {
      expect(block).toContain(pose);
      expect(indexesOf(pose)).toHaveLength(1); // not duplicated outside the claimed branch
    }
  });
});

/** diagnose op — integration test against a LIVE ECS world (no mocked relay).
 *  Exercises the real computeDiagnostics path: ref integrity, NaN transforms, and
 *  missing-camera detection over a headless createTestWorld. */

import { describe, it, expect, afterEach } from 'vitest';
import { createTestWorld, type TestWorld, Transform, EntityAttributes, Renderable3D, Camera } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { computeDiagnostics } from '../../app/debug/diagnose';

registerAllTraits();

let game: TestWorld | undefined;
afterEach(() => { game?.dispose(); game = undefined; });

describe('computeDiagnostics: console-error recency window (F14)', () => {
  const now = 1_000_000;
  const win = 30_000;
  const stale = [{ level: 'error', ts: now - 60_000, text: 'old boom' }];   // 60s ago
  const recent = [{ level: 'error', ts: now - 5_000, text: 'fresh boom' }]; //  5s ago

  it('a STALE error is windowed out — it no longer counts toward the verdict', () => {
    game = createTestWorld({});
    const d = computeDiagnostics({ consoleErrors: stale, now, errorWindowMs: win });
    expect(d.consoleErrors).toHaveLength(0);
    // And it does not change `ok` vs having no errors at all — i.e. it stopped PINNING ok:false.
    const none = computeDiagnostics({ consoleErrors: [], now, errorWindowMs: win });
    expect(d.ok).toBe(none.ok);
  });

  it('a RECENT error is kept and forces ok:false', () => {
    game = createTestWorld({});
    const d = computeDiagnostics({ consoleErrors: recent, now, errorWindowMs: win });
    expect(d.consoleErrors).toHaveLength(1);
    expect(d.ok).toBe(false); // a non-empty consoleErrors always fails ok
  });

  it('with NO window (the fixed-list unit path) a stale error still counts — behavior unchanged', () => {
    game = createTestWorld({});
    const d = computeDiagnostics({ consoleErrors: stale });
    expect(d.consoleErrors).toHaveLength(1);
    expect(d.ok).toBe(false);
  });
});

describe('computeDiagnostics (live world)', () => {
  it('flags a NaN transform, a literal-path asset ref, and a missing camera', () => {
    game = createTestWorld({});
    // A NaN position — renders nowhere / breaks math.
    game.spawn(Transform({ x: NaN }), EntityAttributes({ name: 'BadTransform' }));
    // A ref field holding a literal internal path instead of a GUID.
    game.spawn(
      Transform({}),
      Renderable3D({ mesh: '/games/x/assets/meshes/a.mesh.json', material: '' }),
      EntityAttributes({ name: 'PathRef' }),
    );

    const d = computeDiagnostics();
    expect(d.ok).toBe(false);
    expect(d.camera.ok).toBe(false);
    expect(d.transforms.nan.some((n) => n.field === 'x')).toBe(true);
    expect(d.refs.issues.some((r) => r.kind === 'literal-path' && r.trait === 'Renderable3D')).toBe(true);
    expect(d.summary).toMatch(/no Camera/);
  });

  it('reports clean (ok) for a well-formed scene with a camera', () => {
    game = createTestWorld({});
    game.spawn(Transform({ x: 1, y: 2, z: 3 }), Camera({}), EntityAttributes({ name: 'Camera' }));
    game.spawn(Transform({}), EntityAttributes({ name: 'Plain' }));

    const d = computeDiagnostics();
    expect(d.camera.ok).toBe(true);
    expect(d.transforms.nan).toHaveLength(0);
    expect(d.refs.count).toBe(0);
    expect(d.ok).toBe(true);
  });

  // C7 re-audit: a scene with NO 3D content (a 2D/UI-only game like chess) legitimately has no
  // Camera — it must not be flagged "3D renders black".
  it('does NOT flag a missing camera when the scene has no 3D content', () => {
    game = createTestWorld({});
    game.spawn(Transform({}), EntityAttributes({ name: 'UIThing' })); // no camera, no 3D renderable
    const d = computeDiagnostics() as ReturnType<typeof computeDiagnostics> & { camera: { needed: boolean } };
    expect(d.camera.needed).toBe(false);
    expect(d.camera.ok).toBe(true);
    expect(d.ok).toBe(true);
    expect(d.summary).not.toMatch(/no Camera/);
  });

  it('still flags a missing camera when there IS 3D content', () => {
    game = createTestWorld({});
    game.spawn(Transform({}), Renderable3D({ mesh: '', material: '' }), EntityAttributes({ name: 'Mesh' }));
    const d = computeDiagnostics() as ReturnType<typeof computeDiagnostics> & { camera: { needed: boolean } };
    expect(d.camera.needed).toBe(true);
    expect(d.camera.ok).toBe(false);
    expect(d.summary).toMatch(/no Camera/);
  });

  // C7 re-audit: zero-scale is a SOFT signal (an entity can be intentionally scaled to 0), so it
  // must not sit inside ok:true + "No issues detected" — it is surfaced in the summary instead.
  it('surfaces a zero-scale entity in the summary without failing ok', () => {
    game = createTestWorld({});
    game.spawn(Transform({ x: 1, y: 2, z: 3 }), Camera({}), EntityAttributes({ name: 'Camera' }));
    game.spawn(Transform({ sx: 0 }), EntityAttributes({ name: 'Hidden' })); // scale 0 → invisible
    const d = computeDiagnostics();
    expect(d.transforms.zeroScale).toHaveLength(1);
    expect(d.ok).toBe(true); // soft — not gated
    expect(d.summary).toMatch(/zero-scale/);
    expect(d.summary).not.toMatch(/No issues detected/);
  });
});

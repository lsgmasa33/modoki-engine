/** diagnose op — integration test against a LIVE ECS world (no mocked relay).
 *  Exercises the real computeDiagnostics path: ref integrity, NaN transforms, and
 *  missing-camera detection over a headless createTestWorld. */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  createTestWorld, type TestWorld, Transform, EntityAttributes, Renderable3D, Camera,
  setActiveQualityTier, setRenderSettings, resetRenderSettings,
  recordUIOverflow, refreshUIOverflowCurrent, resetUIOverflowFindings, setUIOverflowCheckEnabled, type UIOverflowFinding,
} from '@modoki/engine/runtime';
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

  // #152: windowed out of the VERDICT is not windowed out of the REPORT. A stale error used to
  // vanish entirely, so `consoleErrors: []` + "No issues detected." was reachable while the ring
  // held a real boot error — the shape that made me report "zero console errors" on three devices.
  it('a STALE error is still COUNTED and TIMESTAMPED — never silently dropped', () => {
    game = createTestWorld({});
    const d = computeDiagnostics({ consoleErrors: stale, now, errorWindowMs: win });
    expect(d.olderErrors).toEqual({ count: 1, oldestTs: stale[0].ts, newestTs: stale[0].ts });
  });

  it('a clean-looking verdict can NEVER say "No issues detected" while older errors exist', () => {
    game = createTestWorld({});
    game.spawn(Transform({}), Camera({}), EntityAttributes({ name: 'Camera' }));
    const d = computeDiagnostics({ consoleErrors: stale, now, errorWindowMs: win });
    expect(d.ok).toBe(true);                              // the verdict is still windowed
    expect(d.summary).not.toMatch(/No issues detected/);  // but the summary tells the truth
    expect(d.summary).toMatch(/1 older console error/);
    // Names BOTH tools: this string is built in the renderer, which serves the editor AND the
    // device, so it cannot know which surface reads it. Caught on a phone, where it advised
    // `modoki_get_console_logs` — a tool that does not exist there (#151's failure in miniature).
    expect(d.summary).toMatch(/modoki_get_console_logs/);
    expect(d.summary).toMatch(/device_console_logs/);
  });

  it('names the window, so `consoleErrors: []` cannot be read as an absolute', () => {
    game = createTestWorld({});
    const d = computeDiagnostics({ consoleErrors: [], now, errorWindowMs: win });
    expect(d.errorWindowMs).toBe(win);
    expect(d.olderErrors).toBeNull();
  });

  it('with no window applied it reports neither field — nothing was filtered, nothing to explain', () => {
    game = createTestWorld({});
    const d = computeDiagnostics({ consoleErrors: stale });
    expect(d).not.toHaveProperty('errorWindowMs');
    expect(d).not.toHaveProperty('olderErrors');
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

// R6.3: "did the clamp take?" was previously answerable only by reading source — the tier NAME
// was reported and nothing it actually applied. These three fields are cheap and deliberately
// small: NOT the whole resolved TierRenderOverrides object, which would spend response budget on
// a subsystem most `diagnose` calls are not asking about.
describe('computeDiagnostics: quality tier fields (R6.3)', () => {
  afterEach(() => resetRenderSettings());

  it('omits qualityTier entirely until a tier has resolved (healthy-means-silent)', () => {
    game = createTestWorld({});
    const d = computeDiagnostics() as ReturnType<typeof computeDiagnostics> & { qualityTier?: unknown };
    expect(d.qualityTier).toBeUndefined();
  });

  it('reports assessed, configCount and the EFFECTIVE targetFps once a tier resolves', () => {
    game = createTestWorld({});
    setRenderSettings({
      targetFps: 60,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only partial tier config
      three: { tiers: { low: { targetFps: 30 } } } as any,
    });
    setActiveQualityTier({ tier: 'low', source: 'calibrating', reason: 'unrecognised device — starting low' });

    const d = computeDiagnostics() as ReturnType<typeof computeDiagnostics> & {
      qualityTier: { tier: string; assessed: { tier: string; source: string }; configCount: number; targetFps: number };
    };
    expect(d.qualityTier.tier).toBe('low');
    // `assessed` is the tier this SESSION started at — the first resolution, distinct from a
    // later live promote/demote (getAssessedQualityTier's whole reason to exist).
    expect(d.qualityTier.assessed).toEqual({ tier: 'low', source: 'calibrating', reason: 'unrecognised device — starting low' });
    // 1 (default) + 1 (authored `low`) — the boot-probe gate signal from `configCount`.
    expect(d.qualityTier.configCount).toBe(2);
    // The EFFECTIVE cap (authored 60, clamped by the authored `low.targetFps: 30`), never the
    // raw authored value — that is the exact distinction R6.2/R6.3 exist to stop hiding.
    expect(d.qualityTier.targetFps).toBe(30);
  });
});

// #1126 — the UI text overflow warning's findings store. A finding is a HARD problem (owner,
// 2026-09-14): it fails `ok`, and the summary says so.
describe('computeDiagnostics: UI text overflow (#1126)', () => {
  afterEach(() => { resetUIOverflowFindings(); setUIOverflowCheckEnabled(false); vi.restoreAllMocks(); });

  const finding = (entityId: number, over: Partial<UIOverflowFinding> = {}): Omit<UIOverflowFinding, 'current' | 'boxGuid'> => ({
    kind: 'spill', boxEntityId: entityId, overflowPx: 6.6, availablePx: 254, textPx: 267.2, clipped: false,
    entityId, guid: '', text: 'Hard', viewport: { w: 375, h: 667 }, ...over,
  });

  it('a clean store reports enabled + count 0 and leaves ok alone', () => {
    game = createTestWorld({});
    setUIOverflowCheckEnabled(true);
    const d = computeDiagnostics();
    expect(d.uiOverflow).toEqual({ enabled: true, count: 0, current: 0, findings: [] });
    expect(d.ok).toBe(true);
  });

  it('reports enabled:false from a build that never scans, so count 0 is not read as "checked"', () => {
    game = createTestWorld({});
    expect(computeDiagnostics().uiOverflow.enabled).toBe(false);
  });

  it('a recorded finding fails ok, is named in the summary, and resolves both entity names', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    game = createTestWorld({});
    const label = game.spawn(EntityAttributes({ name: 'LevelTab_Hard' }));
    const row = game.spawn(EntityAttributes({ name: 'LevelTabs' }));
    recordUIOverflow('k', finding(label.id(), { boxEntityId: row.id() }));

    const d = computeDiagnostics();
    expect(d.ok).toBe(false);
    expect(d.summary).toContain('1 UI text overflow(s)');
    expect(d.uiOverflow.count).toBe(1);
    expect(d.uiOverflow.findings[0]).toMatchObject({ name: 'LevelTab_Hard', boxName: 'LevelTabs', kind: 'spill', overflowPx: 6.6, current: true });
    // The box named by guid too (#1223 P2).
    expect(d.uiOverflow.findings[0]).toMatchObject({ boxGuid: (row.get(EntityAttributes) as { guid: string }).guid });
  });

  it('a placed element wider than the whole UI names the UI root as its box', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    game = createTestWorld({});
    recordUIOverflow('k', finding(1, { boxEntityId: 0 }));
    expect(computeDiagnostics().uiOverflow.findings[0]).toMatchObject({ boxName: '(UI root)', boxGuid: null });
  });

  it('a finding the latest scan did not see overflow is listed and noted, but no longer fails ok', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    game = createTestWorld({});
    recordUIOverflow('k', finding(1));
    refreshUIOverflowCurrent(new Set());                   // the latest scan did not see it overflow

    const d = computeDiagnostics();
    expect(d.ok).toBe(true);
    expect(d.uiOverflow).toMatchObject({ count: 1, current: 0 });
    expect(d.summary).toMatch(/1 earlier UI text overflow\(s\) not overflowing now/);
    expect(d.summary).not.toMatch(/No issues detected/);
  });
});

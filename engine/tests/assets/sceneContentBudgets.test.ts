import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasAnyProject } from '../helpers/repoLayout';

/**
 * SCENE CONTENT BUDGETS — #212 item 5, "so a regression fails a test rather than a phone".
 *
 * ── WHY THESE FOUR NUMBERS, AND NOT FRAME TIME ────────────────────────────────────────────
 * Frame time is the thing we care about and the one thing this cannot assert: there is no GPU in
 * CI, and the numbers that matter came off a Galaxy A23. What a headless test CAN see is the
 * CONTENT that drives it — and the 2026-08-18 device sweep is what says which content:
 *
 *   - `renderables` — the draw-call driver. `submit` costs ~0.063 ms per draw call on the A23
 *     (#224), and on forest-camp it was 8.2 ms of a 15.7 ms CPU frame. This is the biggest lever
 *     measured on that device, so it gets a budget.
 *   - `shadowCasters` — the lever with the largest MEASURED win in the whole workstream: #229 cut
 *     postfx-demo from 5 casters to 1 for −22 draw calls, −52k triangles and frame p95 30.2 → 19.8 ms.
 *   - `lights` — shader-variant pressure. The boot stall tracks shader variety (postfx-demo, 14
 *     lights, stalls 2.15 s at boot; 2d-physics-demo, 0 lights, stalls not at all).
 *   - `particleEmitters` — the per-frame CPU/upload cost that has no LOD and no tier cap.
 *
 * ⚠️ **`renderables` is a PROXY for draw calls, and proxies are how a guard ends up measuring the
 * wrong thing.** It was validated against the device before being trusted: forest-camp authors 80
 * `Renderable3D` entities and the running app reports exactly 80 LOD nodes, against 94 renderer
 * draw calls — the gap being the shadow pass and a few non-scene draws. So it tracks, but it is
 * NOT the draw-call count, and a change that moves draw calls without moving entity count (adding
 * a shadow-casting light, a post-FX pass) is invisible here. That is what the other three rows are
 * for, and it is why this file does not claim to be a performance test.
 *
 * ── WHY THE BUDGETS HAVE HEADROOM ─────────────────────────────────────────────────────────
 * A strict ratchet at today's exact counts would fail the build every time the owner adds a rock,
 * which trains everyone to bump the number without thinking — a guard nobody reads is worse than
 * no guard. These sit at roughly 1.5x the measured content, so ADDING A PROP IS FINE and DOUBLING
 * THE SCENE IS NOT. Shadow casters are the exception: the tier caps them at 1 on `mid`/`low`, so
 * the authored count is a deliberate statement and gets only +2.
 *
 * ⚠️ **Raising a budget is a real decision, not paperwork.** Every number below was inside a 20 ms
 * frame budget on an A23 on 2026-08-18. If content grew past one, the honest response is to
 * re-measure on that phone and then raise it — not to raise it and assume.
 *
 * Scope is `demos/` — the published set, the scenes a stranger runs. `games/` is the owner's
 * testbed and is deliberately unbudgeted.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

interface Budget {
  renderables: number;
  lights: number;
  shadowCasters: number;
  particleEmitters: number;
}

/** Measured content on 2026-08-18, with the headroom described above. Keyed by repo-relative path. */
const BUDGETS: Record<string, Budget> = {
  // Flagship: 80 renderables / 3 lights / 1 caster / 2 emitters. 17.5 ms median on the A23.
  'demos/forest-camp/runtime/assets/scenes/main.scene.json':
    { renderables: 120, lights: 6, shadowCasters: 3, particleEmitters: 4 },
  // 33 renderables / 14 lights / 5 casters. The 14 lights ARE the demo (one effect per exhibit),
  // and the tier caps the 5 casters to 1 at runtime — see #229.
  'demos/postfx-demo/runtime/assets/scenes/main.scene.json':
    { renderables: 50, lights: 18, shadowCasters: 7, particleEmitters: 2 },
  // The VFX showreel: almost no geometry, 13 emitters. Emitters are the point, so the budget is
  // loose there and tight everywhere else.
  'demos/particle-demo/runtime/assets/scenes/main.scene.json':
    { renderables: 6, lights: 4, shadowCasters: 3, particleEmitters: 20 },
  'demos/particle-demo/runtime/assets/scenes/2d-gallery.scene.json':
    { renderables: 4, lights: 2, shadowCasters: 1, particleEmitters: 10 },
  'demos/3d-physics-demo/runtime/assets/scenes/physics-showcase.scene.json':
    { renderables: 40, lights: 4, shadowCasters: 3, particleEmitters: 2 },
  // 50 renderables — the densest 3D scene in the set after forest-camp.
  'demos/3d-physics-demo/runtime/assets/scenes/terrain-demo.scene.json':
    { renderables: 75, lights: 4, shadowCasters: 2, particleEmitters: 2 },
  'demos/video-demo/runtime/assets/scenes/main.scene.json':
    { renderables: 12, lights: 4, shadowCasters: 2, particleEmitters: 2 },
  'demos/2d-physics-demo/runtime/assets/scenes/physics-playground.scene.json':
    { renderables: 20, lights: 1, shadowCasters: 1, particleEmitters: 2 },
  'demos/2d-physics-demo/runtime/assets/scenes/platformer.scene.json':
    { renderables: 12, lights: 1, shadowCasters: 1, particleEmitters: 2 },
  'demos/2d-physics-demo/runtime/assets/scenes/compound-colliders.scene.json':
    { renderables: 15, lights: 1, shadowCasters: 1, particleEmitters: 2 },
  'demos/2d-physics-demo/runtime/assets/scenes/concave-shapes.scene.json':
    { renderables: 13, lights: 1, shadowCasters: 1, particleEmitters: 2 },
  'demos/2d-physics-demo/runtime/assets/scenes/ccd-tunneling.scene.json':
    { renderables: 6, lights: 1, shadowCasters: 1, particleEmitters: 2 },
  'demos/2d-physics-demo/runtime/assets/scenes/collider-mesh.scene.json':
    { renderables: 8, lights: 1, shadowCasters: 1, particleEmitters: 2 },
};

const RENDERABLE_TRAITS = [
  'Renderable3D', 'Renderable3DPrimitive', 'Renderable2D', 'Renderable2DPrimitive',
] as const;

interface SceneEntity { traits?: Record<string, unknown> }

function measure(scenePath: string): Budget {
  const scene = JSON.parse(fs.readFileSync(scenePath, 'utf8')) as { entities?: SceneEntity[] };
  const counts: Budget = { renderables: 0, lights: 0, shadowCasters: 0, particleEmitters: 0 };
  for (const entity of scene.entities ?? []) {
    const traits = entity.traits ?? {};
    if (RENDERABLE_TRAITS.some((t) => t in traits)) counts.renderables++;
    if ('ParticleEmitter' in traits) counts.particleEmitters++;
    const light = traits.Light as { castShadow?: boolean } | undefined;
    if (light) {
      counts.lights++;
      if (light.castShadow) counts.shadowCasters++;
    }
  }
  return counts;
}

describe('scene content budgets (demos/)', () => {
  const entries = Object.entries(BUDGETS)
    .map(([rel, budget]) => ({ rel, budget, abs: path.join(repoRoot, rel) }))
    .filter((e) => fs.existsSync(e.abs));

  // A checkout without demos (the OSS snapshot ships them, but a stripped one need not) legitimately
  // has nothing to check. A checkout WITH projects that matched no budget is a broken guard wearing
  // a green tick — the same "always false predicate" failure `repoLayout.ts` exists to prevent.
  it('checks at least one scene when this checkout has projects at all', () => {
    if (!hasAnyProject()) return;
    expect(entries.length).toBeGreaterThan(0);
  });

  it.each(entries)('$rel stays inside its content budget', ({ rel, abs, budget }) => {
    const actual = measure(abs);
    for (const key of Object.keys(budget) as (keyof Budget)[]) {
      expect(
        actual[key],
        `${rel}: ${key} is ${actual[key]}, over its budget of ${budget[key]}.\n`
        + 'These budgets come from a Galaxy A23 measurement (#212, 2026-08-18) where every demo sat\n'
        + 'inside a 20 ms frame. If this growth is intentional, RE-MEASURE on that device and raise\n'
        + 'the number in sceneContentBudgets.test.ts — do not raise it on the assumption it is fine.',
      ).toBeLessThanOrEqual(budget[key]);
    }
  });

  // The budgets are only meaningful while they sit ABOVE current content — a budget that has drifted
  // far above what the scene holds has stopped being a guard without ever failing. This catches the
  // opposite drift from the one above: content DELETED, budget left behind.
  it('no budget is more than 3x the content it guards', () => {
    const slack: string[] = [];
    for (const { rel, abs, budget } of entries) {
      const actual = measure(abs);
      for (const key of Object.keys(budget) as (keyof Budget)[]) {
        // Only meaningful once there is something to compare against; a 0-content row is a
        // legitimate "this scene has none of these" rather than drift.
        if (actual[key] > 0 && budget[key] > actual[key] * 3) {
          slack.push(`${rel}: ${key} budget ${budget[key]} vs actual ${actual[key]}`);
        }
      }
    }
    expect(slack, `budgets that have drifted into meaninglessness:\n${slack.join('\n')}`).toEqual([]);
  });
});

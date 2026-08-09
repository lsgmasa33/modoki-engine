/** Guard: every render surface that calls `syncEnvironment` also reconciles its OWN exposure.
 *
 *  The IBL-off compensation (#154) is gated on `isIblSuppressed()` — module state in
 *  `scene3DSync` recording what the LAST `syncEnvironment` call saw. That is deliberate: the
 *  compensation must fire only when a scene actually LOST an environment, never on the tier
 *  alone, or a tier ends up RAISING its output on every scene that never had IBL (which, since
 *  an unrecognised device resolves `low`, meant every phone — see docs/rendering.md § "Quality
 *  tiers").
 *
 *  The cost of that design is this coupling: the flag is global, and the editor mounts TWO
 *  surfaces that each call `syncEnvironment` (the Game panel's `Scene3D` and the Scene panel's
 *  `SceneView`). A surface that SETS the flag and never reads it back keeps whatever exposure
 *  its renderer was constructed with. `SceneView` shipped exactly that way for one commit: with
 *  a project pinning `qualityTier: 'low'`, a Game-panel frame set the flag, and a Scene panel
 *  opened afterwards baked in a 1.25x compensation it did not own and never re-derived.
 *
 *  A comment on `reconcileToneExposure` states the rule; this makes it fail a build instead.
 *  The pairing is per FILE rather than per call site — a surface may sync in one place and
 *  reconcile in another — which is loose enough to have no false positives and tight enough
 *  that a brand-new surface cannot appear without one.
 *
 *  Deliberately NOT covered: `applyRendererColorConfig`, which sets the authored exposure with
 *  no compensation on it. It also serves the asset-preview renderers (`ModelPreview`,
 *  `previewScene`), which never sync an environment — so they are correct by having no
 *  compensation at all, not by reconciling one. */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const srcRoots = [
  path.resolve(__dirname, '../../packages/modoki/src'),
  path.resolve(__dirname, '../../app'),
];

/** Every .ts/.tsx under the given roots, minus the module that DEFINES the pair. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (/\.tsx?$/.test(e.name)) out.push(p);
    }
  };
  for (const root of srcRoots) if (fs.existsSync(root)) walk(root);
  return out.filter((p) => !p.endsWith(path.join('rendering', 'scene3DSync.ts')));
}

describe('IBL-off compensation — surfaces that sync an environment must reconcile their exposure', () => {
  it('every syncEnvironment caller also calls reconcileToneExposure', () => {
    const offenders: string[] = [];
    let callers = 0;
    for (const file of sourceFiles()) {
      const src = fs.readFileSync(file, 'utf8');
      if (!/\bsyncEnvironment\s*\(/.test(src)) continue;
      callers++;
      if (!/\breconcileToneExposure\s*\(/.test(src)) offenders.push(path.relative(process.cwd(), file));
    }
    // The guard is worthless if the query stopped matching anything — pin that it still finds
    // the surfaces it is meant to police (Scene3D + SceneView today).
    expect(callers).toBeGreaterThanOrEqual(2);
    expect(offenders).toEqual([]);
  });
});

/**
 * Every string-union field in project.config.json is validated, and an out-of-union value
 * BLOCKS THE BUILD (#39).
 *
 * Before this, exactly three fields were checked (`rendering.web.sizeMode` and the two GPU
 * `backend`s). Everything else was a plain object spread, so a typo flowed through untouched:
 *
 *   - `capacitor.orientation` → written into native config verbatim. A bad value silently
 *     unlocks rotation on BOTH platforms (`healNativeConfig` falls iOS back to `auto`, Android
 *     to `fullSensor`) and the launch log echoes the value you WROTE, so the log looks correct.
 *     You find out from a store screenshot.
 *   - `build.webDeployMode` → the deploy step picks a branch on it.
 *   - `build.playableNetwork` → validated here, but NOTHING branches on it yet: the MRAID shim
 *     (`app/playable/mraid.ts`) is network-agnostic and only AppLovin is really covered. Per-network
 *     adapters are deliberately deferred (docs/playable-export.md § "Deferred — per-network
 *     adapters"), so this guard is protecting a value the build does not consume — keep it, but
 *     do not read it as evidence the field is wired.
 *   - `rendering.three.toneMapping` → `resolveToneMapping` maps unknown → ACESFilmic BY DESIGN,
 *     which is why a typo was invisible: the fallback IS the most common intended value.
 *
 * The policy is deliberately split, and the split is the whole design (owner's call):
 * **load coerces + warns, the BUILD refuses.** Load has to stay forgiving or one typo makes a
 * project un-openable in the editor, and you cannot fix a config you cannot open. The build is
 * the last moment before the value ships, so that is where it becomes fatal.
 */

import { describe, it, expect } from 'vitest';
import {
  mergeProjectConfig,
  DEFAULT_PROJECT_CONFIG,
  TONE_MAPPINGS,
  CAPACITOR_ORIENTATIONS,
  STATUS_BAR_STYLES,
  IOS_CONTENT_MODES,
  ANDROID_SCHEMES,
  KEYBOARD_RESIZE_MODES,
  WEB_DEPLOY_MODES,
  PLAYABLE_NETWORKS,
  QUALITY_TIERS,
  type ProjectConfigIssue,
} from '../../project-config';

/** Every field this issue covers: dot-path → a bad value and the legal set. */
const UNION_FIELDS: { path: string; patch: Record<string, unknown>; allowed: readonly string[] }[] = [
  { path: 'capacitor.orientation', patch: { capacitor: { orientation: 'Portrait' } }, allowed: CAPACITOR_ORIENTATIONS },
  { path: 'capacitor.statusBarStyle', patch: { capacitor: { statusBarStyle: 'Light' } }, allowed: STATUS_BAR_STYLES },
  { path: 'capacitor.iosContentMode', patch: { capacitor: { iosContentMode: 'Mobile' } }, allowed: IOS_CONTENT_MODES },
  { path: 'capacitor.androidScheme', patch: { capacitor: { androidScheme: 'HTTP' } }, allowed: ANDROID_SCHEMES },
  { path: 'capacitor.keyboardResize', patch: { capacitor: { keyboardResize: 'None' } }, allowed: KEYBOARD_RESIZE_MODES },
  { path: 'build.webDeployMode', patch: { build: { webDeployMode: 'GCS' } }, allowed: WEB_DEPLOY_MODES },
  { path: 'build.playableNetwork', patch: { build: { playableNetwork: 'AppLovin' } }, allowed: PLAYABLE_NETWORKS },
  { path: 'rendering.three.toneMapping', patch: { rendering: { three: { toneMapping: 'ACES Filmic' } } }, allowed: TONE_MAPPINGS },
  { path: 'rendering.three.qualityTier', patch: { rendering: { three: { qualityTier: 'Low' } } }, allowed: QUALITY_TIERS },
];

describe('project.config string unions are all validated (#39)', () => {
  // Every bad value here is a REALISTIC typo — a case slip or an added space — not `'zzz'`.
  // `'ACES Filmic'` is the one that matters most: it coerces to the value the author meant,
  // so nothing about the render looks wrong and only the warning reveals it.
  for (const { path, patch, allowed } of UNION_FIELDS) {
    it(`${path}: a bad value is reported and coerced to the default`, () => {
      const issues: ProjectConfigIssue[] = [];
      const resolved = mergeProjectConfig(patch as never, { issues });
      const issue = issues.find((i) => i.path === path);
      expect(issue, `no issue collected for ${path}`).toBeTruthy();
      expect(issue!.allowed).toEqual([...allowed]);
      // Coerced, so the engine always has a value a consumer handles…
      const read = (o: unknown, p: string) => p.split('.').reduce<unknown>((a, k) => (a as Record<string, unknown>)?.[k], o);
      expect(read(resolved, path)).toBe(read(DEFAULT_PROJECT_CONFIG, path));
      // …and the message names the field, the value AND the legal set, since that is what the
      // reader has to act on.
      expect(issue!.message).toContain(path);
      for (const a of allowed) expect(issue!.message).toContain(a);
    });
  }

  it('a GOOD value is passed through untouched and collects no issue', () => {
    const issues: ProjectConfigIssue[] = [];
    const resolved = mergeProjectConfig({ capacitor: { orientation: 'portrait' }, rendering: { three: { toneMapping: 'AgX' } } } as never, { issues });
    expect(issues).toEqual([]);
    expect(resolved.capacitor.orientation).toBe('portrait');
    expect(resolved.rendering.three.toneMapping).toBe('AgX');
  });

  it('the committed defaults are themselves in-union (no issue on a bare resolve)', () => {
    const issues: ProjectConfigIssue[] = [];
    mergeProjectConfig(null, { issues });
    expect(issues).toEqual([]);
  });

  it('coerceUnions:false ROUND-TRIPS a bad value instead of healing it', () => {
    // The settings-save route resolves this way on purpose: pressing Apply on an unrelated
    // section must not silently normalize a field the author never touched. `sizeMode:'portrait'`
    // is what revealed games/sling was *meant* to be portrait (#25) — healing it would have
    // erased the only evidence of intent.
    const resolved = mergeProjectConfig({ capacitor: { orientation: 'Portrait' } } as never, { coerceUnions: false });
    expect(resolved.capacitor.orientation).toBe('Portrait');
  });
});

describe('TONE_MAPPINGS stays in step with resolveToneMapping', () => {
  it('names exactly the cases the resolver handles', async () => {
    // project-config.ts is deliberately IMPORT-FREE (browser-safe, no Node deps), so it cannot
    // import the resolver's set — the two lists are a knowing duplication and THIS is the guard
    // that keeps them honest. A name added to the resolver but not here would be rejected as
    // out-of-union despite working; a name here but not in the resolver would silently render as
    // ACESFilmic via the `default` branch.
    const src = await import('@modoki/engine/testing').then(({ readScannedSource }) =>
      readScannedSource('engine/packages/modoki/src/runtime/rendering/renderSettings.ts').code);
    const body = src.slice(src.indexOf('export function resolveToneMapping'));
    const end = body.indexOf('\n}');
    const cases = [...body.slice(0, end).matchAll(/case '([^']+)':/g)].map((m) => m[1]);
    expect(cases.length).toBeGreaterThan(0);
    expect([...cases].sort()).toEqual([...TONE_MAPPINGS].sort());
  });
});

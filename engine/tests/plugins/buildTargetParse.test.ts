/** Unit tests for engine/scripts/buildTarget.mjs's pure `parseBuildTarget` — fast, no subprocess.
 *  Companion to buildWebTargetFlag.test.ts, which proves the real script wires this correctly;
 *  this file exhaustively covers the parsing logic itself, including the F1/F2 regressions found
 *  in review. */
import { describe, it, expect } from 'vitest';
import { parseBuildTarget, VALID_TARGETS } from '../../scripts/buildTarget.mjs';

describe('parseBuildTarget', () => {
  it('sanity: VALID_TARGETS is web/native/playable', () => {
    expect(VALID_TARGETS).toEqual(['web', 'native', 'playable']);
  });

  it('--target web (space form): ok, target web, no VITE_PLAYABLE in childEnv', () => {
    const result = parseBuildTarget(['--target', 'web'], {});
    expect(result).toEqual({ ok: true, target: 'web', childEnv: { MODOKI_BUILD_TARGET: 'web' } });
  });

  it('--target=web (equals form): same result as the space form', () => {
    const result = parseBuildTarget(['--target=web'], {});
    expect(result).toEqual({ ok: true, target: 'web', childEnv: { MODOKI_BUILD_TARGET: 'web' } });
  });

  it('--target playable: childEnv includes VITE_PLAYABLE: 1', () => {
    const result = parseBuildTarget(['--target', 'playable'], {});
    expect(result).toEqual({
      ok: true,
      target: 'playable',
      childEnv: { MODOKI_BUILD_TARGET: 'playable', VITE_PLAYABLE: '1' },
    });
  });

  it('env fallback: empty argv + MODOKI_BUILD_TARGET=native resolves to native', () => {
    const result = parseBuildTarget([], { MODOKI_BUILD_TARGET: 'native' });
    expect(result).toEqual({ ok: true, target: 'native', childEnv: { MODOKI_BUILD_TARGET: 'native' } });
  });

  it('precedence: an explicit --target argv wins over MODOKI_BUILD_TARGET env', () => {
    const result = parseBuildTarget(['--target', 'web'], { MODOKI_BUILD_TARGET: 'native' });
    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ target: 'web' });
  });

  it('absent target: not ok, message says --target is required', () => {
    const result = parseBuildTarget([], {});
    expect(result.ok).toBe(false);
    expect(result.ok || result.message).toContain('--target is required');
  });

  it('--target bogus: not ok', () => {
    const result = parseBuildTarget(['--target', 'bogus'], {});
    expect(result.ok).toBe(false);
  });

  // F2 regression guard: a bare `--target` (no value) used to silently fall through to
  // `target = undefined`, then adopt MODOKI_BUILD_TARGET from the env — the same
  // silent-wrong-target class #40 exists to eliminate. It must now be a hard error, and the env
  // fallback must NOT rescue it.
  it('F2: --target with no value (last arg) is an error, mentions "no value"', () => {
    const result = parseBuildTarget(['--target'], {});
    expect(result.ok).toBe(false);
    expect(result.ok || result.message).toContain('no value');
  });

  it('F2: --target with no value does NOT silently adopt MODOKI_BUILD_TARGET from env', () => {
    const result = parseBuildTarget(['--target'], { MODOKI_BUILD_TARGET: 'web' });
    expect(result.ok).toBe(false);
  });

  it('F2: --target immediately followed by another flag counts as no value', () => {
    const result = parseBuildTarget(['--target', '--foo'], { MODOKI_BUILD_TARGET: 'web' });
    expect(result.ok).toBe(false);
  });

  // F1 regression guard: vite.config.ts:226's authoritative check is `VITE_PLAYABLE === '1'`.
  // The old guard here used truthiness, so `VITE_PLAYABLE=0` (which vite reads as OFF) wrongly
  // hard-failed a legitimate `--target web` build.
  it('F1: VITE_PLAYABLE=1 with --target web is a contradiction (not ok)', () => {
    const result = parseBuildTarget(['--target', 'web'], { VITE_PLAYABLE: '1' });
    expect(result.ok).toBe(false);
  });

  it('F1: VITE_PLAYABLE=0 with --target web is OK — 0 means off, matching vite.config', () => {
    const result = parseBuildTarget(['--target', 'web'], { VITE_PLAYABLE: '0' });
    expect(result).toEqual({ ok: true, target: 'web', childEnv: { MODOKI_BUILD_TARGET: 'web' } });
  });

  it('F1: VITE_PLAYABLE=1 with --target playable is OK (no contradiction)', () => {
    const result = parseBuildTarget(['--target', 'playable'], { VITE_PLAYABLE: '1' });
    expect(result.ok).toBe(true);
  });
});

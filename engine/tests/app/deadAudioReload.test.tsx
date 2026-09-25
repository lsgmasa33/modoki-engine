/** Pins `resolveReloadOnDeadAudio` (#1455) — the opt-in read in the app shell. The decision itself
 *  is tested in `packages/modoki/tests/runtime/core/deadAudioReload.test.ts`.
 *
 *  ⚠️ `.test.tsx`, not `.ts`: `engine/vite.config.ts` collects only `tests/app/**\/*.test.tsx`. */
import { describe, it, expect, vi } from 'vitest';

vi.mock('virtual:modoki-project-config', () => ({ default: {} }));
vi.mock('@modoki/engine/runtime', () => ({
  PlayerPrefs: { flush: vi.fn() },
  createDeadAudioReloadHandler: vi.fn(),
  getActiveReloadBlockers: () => [],
  onAudioDead: vi.fn(() => () => {}),
  shutdownRealmThenReload: vi.fn(),
}));

const { resolveReloadOnDeadAudio } = await import('../../app/useDeadAudioReload');

describe('resolveReloadOnDeadAudio', () => {
  it('is off unless the project authors a literal true', () => {
    expect(resolveReloadOnDeadAudio({})).toBe(false);
    expect(resolveReloadOnDeadAudio({ runtime: {} })).toBe(false);
    for (const bad of [false, 'true', 1, null, {}, []]) {
      expect(resolveReloadOnDeadAudio({ runtime: { reloadOnDeadAudio: bad } })).toBe(false);
    }
    expect(resolveReloadOnDeadAudio({ runtime: { reloadOnDeadAudio: true } })).toBe(true);
  });
});

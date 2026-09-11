/**
 * #837 — the Bundle choices "Publish OTA Update…" offers, and the engine-API line under the field.
 * The route is what refuses; these pin that the dialog never OFFERS a choice the route would refuse,
 * and that a sub-game's engine API is stated as the value it must equal, never a made-up number.
 */
import { describe, it, expect } from 'vitest';
import { otaBundleChoices, otaEngineApiNote } from '../../src/editor/panels/publishOtaTargets';

describe('otaBundleChoices', () => {
  it('offers the shell first, then each listed sub-game', () => {
    expect(otaBundleChoices({ bundleName: 'shell', subgames: ['ota-subgame-test', 'minigame-b'] })).toEqual([
      { bundleName: 'shell', kind: 'shell' },
      { bundleName: 'ota-subgame-test', kind: 'subgame' },
      { bundleName: 'minigame-b', kind: 'subgame' },
    ]);
  });

  it('offers only the shell when nothing is listed, and defaults an absent bundle name to "shell"', () => {
    expect(otaBundleChoices({})).toEqual([{ bundleName: 'shell', kind: 'shell' }]);
    expect(otaBundleChoices(undefined)).toEqual([{ bundleName: 'shell', kind: 'shell' }]);
  });

  it('does not offer what the route refuses: a non-string, an empty id, a duplicate, or the shell\'s own name', () => {
    expect(otaBundleChoices({ bundleName: 'main', subgames: [42, '', 'a', 'a', 'main', null] })).toEqual([
      { bundleName: 'main', kind: 'shell' },
      { bundleName: 'a', kind: 'subgame' },
    ]);
  });
});

describe('otaEngineApiNote', () => {
  it('states the shell\'s own stamped value for the shell', () => {
    expect(otaEngineApiNote({ bundleName: 'shell', kind: 'shell' }, 1)).toBe(
      'Engine API 1: this project\'s ota.engineApi, stamped into the bundle.',
    );
  });

  it('states the value a sub-game must EQUAL, naming the sub-game, and invents no number of its own', () => {
    const note = otaEngineApiNote({ bundleName: 'ota-subgame-test', kind: 'subgame' }, 3);
    expect(note).toContain('ota-subgame-test');
    expect(note).toContain('equals this shell\'s 3');
    expect(note).not.toMatch(/Engine API \d/);
  });

  it('says "unknown" rather than guessing when the shell value has not loaded', () => {
    expect(otaEngineApiNote({ bundleName: 'shell', kind: 'shell' }, undefined)).toContain('Engine API unknown');
  });
});

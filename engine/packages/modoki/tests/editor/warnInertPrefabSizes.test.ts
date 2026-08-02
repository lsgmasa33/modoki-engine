/**
 * The prefab WRITE-time half of #42: `warnInertPrefabSizes` and, just as importantly, WHICH writes
 * call it.
 *
 * `validatePrefabData` is already unit-tested (tests/runtime/validatePrefabData.test.ts). What was
 * uncovered is the seam production actually goes through — nobody reaches the validator directly;
 * they reach it by saving a prefab. This file covers the reporting behaviour, plus a source-level
 * guard on the placement decision, because that decision is invisible in the code and easy to
 * "simplify" away.
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { warnInertPrefabSizes } from '../../src/editor/scene/prefab';

const SRC = path.resolve(__dirname, '../../src');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

const trap = (localId = 3) => ({
  entities: [{ localId, name: 'Band', traits: { UIAnchor: { anchor: 'stretch' }, UIElement: { width: 90, widthUnit: '%' } } }],
});

describe('warnInertPrefabSizes (prefab write-time reporting)', () => {
  it('warns once per finding, naming the prefab FILE', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warnInertPrefabSizes(trap(), '/assets/prefabs/thing.prefab.json');
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][0]);
    // The FILE is the whole point of reporting here rather than from the scene side — without it
    // the reader is told a value is dead but not which of 89 prefabs holds it.
    expect(msg).toContain('/assets/prefabs/thing.prefab.json');
    expect(msg).toContain('localId=3');
    // `[Editor]` is the prefix the editor Console panel surfaces; a bare warn is invisible there.
    expect(msg).toContain('[Editor]');
    warn.mockRestore();
  });

  it('is silent for a clean prefab — it must not chatter on every save', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warnInertPrefabSizes({ entities: [{ localId: 1, traits: { UIAnchor: { anchor: 'stretch' }, UIElement: { width: 100, widthUnit: '%' } } }] }, '/x.prefab.json');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('never throws on a malformed prefab — a save must not fail because a WARNING path threw', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const bad of [null, undefined, 42, {}, { entities: 'no' }]) {
      expect(() => warnInertPrefabSizes(bad, '/x.prefab.json')).not.toThrow();
    }
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('the hook is on the AUTHORING writes, not on writePrefabFile (#42)', () => {
  // Source-level on purpose. This encodes a decision that is invisible in the code itself and
  // would look like an obvious cleanup to a later reader: `writePrefabFile` is the single choke
  // point for every prefab write, so hooking it is the tempting move — but it is ALSO the
  // undo/redo restore path (`installPrefabSnapshot`), so warning there fires while someone
  // REVERTS the value, blaming them for an edit they are undoing. Same idiom as this repo's other
  // architecture guards (reapScoping, determinismGuard, testTypecheckCoverage).
  const prefabSrc = read('editor/scene/prefab.ts');

  it('applyToPrefab warns before writing', () => {
    expect(prefabSrc).toMatch(/warnInertPrefabSizes\(newPrefab, source\);\s*\n\s*const ok = await writePrefabFile\(source, newPrefab\);/);
  });

  it('createPrefabFromEntity (Save-as-Prefab) warns before writing', () => {
    expect(read('editor/panels/assetOps.ts')).toMatch(/warnInertPrefabSizes\(prefab, savePath\);/);
  });

  it('writePrefabFile itself does NOT warn, so undo/redo stays quiet', () => {
    // Slice the function body and assert the call is absent from it specifically — asserting on
    // the whole file would pass merely because the helper is DEFINED there.
    const start = prefabSrc.indexOf('export async function writePrefabFile');
    expect(start).toBeGreaterThan(-1);
    const body = prefabSrc.slice(start, prefabSrc.indexOf('\n}', start));
    expect(body).not.toContain('warnInertPrefabSizes');
  });

  it('installPrefabSnapshot (the undo/redo path) does NOT warn', () => {
    const start = prefabSrc.indexOf('export async function installPrefabSnapshot');
    expect(start).toBeGreaterThan(-1);
    const body = prefabSrc.slice(start, prefabSrc.indexOf('\n}', start));
    expect(body).not.toContain('warnInertPrefabSizes');
  });
});

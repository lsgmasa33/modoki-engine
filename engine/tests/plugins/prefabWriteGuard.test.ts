/** `engine/plugins/prefabWriteGuard.ts` — the prefab format WRITE gate (#1468 D4).
 *
 *  The two assertions that matter most are the boring-looking ones: an OLDER prefab must be
 *  writable, and a CURRENT one must be writable. Measured 2026-09-23, the committed corpus is 102
 *  prefabs at `version: 2` and 3 at `version: 3` against a constant of 4 — **zero at the current
 *  version** — so a gate spelled `!==` rather than `>` refuses all 105 authored prefabs on the
 *  first save. That spelling looks equally reasonable in code, which is why it is pinned here
 *  rather than left to review.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';
import { PREFAB_FORMAT_VERSION } from '../../packages/modoki/src/runtime/core/version';
import { classifyPrefabWrite, isPrefabPath } from '../../plugins/prefabWriteGuard';

/** A `.prefab.json` on disk carrying `version`, and its absolute path. */
function prefabAt(version: unknown, opts: { raw?: string; name?: string } = {}): string {
  const dir = makeScratchDir('modoki-prefabguard-');
  const p = path.join(dir, opts.name ?? 'thing.prefab.json');
  fs.writeFileSync(p, opts.raw ?? JSON.stringify({ version, name: 'thing', rootLocalId: 1, entities: [] }, null, 2));
  return p;
}

describe('isPrefabPath', () => {
  it('keys on the full double suffix, not on .json', () => {
    expect(isPrefabPath('/a/b/c.prefab.json')).toBe(true);
    expect(isPrefabPath('/a/b/c.scene.json')).toBe(false);
    expect(isPrefabPath('/a/b/c.json')).toBe(false);
    expect(isPrefabPath('/a/b/prefab.json')).toBe(false);
  });
});

describe('classifyPrefabWrite — what it lets through', () => {
  it('⚠️ allows EVERY older version — the 105-file case a `!==` gate would refuse', () => {
    for (const v of [1, 2, 3]) {
      expect(classifyPrefabWrite(prefabAt(v)), `version ${v} must stay writable`).toBeNull();
    }
  });

  it('allows the current version', () => {
    expect(classifyPrefabWrite(prefabAt(PREFAB_FORMAT_VERSION))).toBeNull();
  });

  it('allows a file that does not exist — a first write', () => {
    const dir = makeScratchDir('modoki-prefabguard-');
    expect(classifyPrefabWrite(path.join(dir, 'nope.prefab.json'))).toBeNull();
  });

  it('allows a document with no version field at all — legacy, readable', () => {
    const p = prefabAt(undefined, { raw: JSON.stringify({ name: 'legacy', entities: [] }) });
    expect(classifyPrefabWrite(p)).toBeNull();
  });

  it('ignores a path that is not a prefab, whatever its version says', () => {
    const p = prefabAt(999, { name: 'thing.scene.json' });
    expect(classifyPrefabWrite(p)).toBeNull();
  });

  it('⚠️ does NOT refuse a DAMAGED document — that is a different disposition (#778)', () => {
    // Refusing here would make a corrupt prefab unfixable from the editor, and prefabs have no
    // quarantine path like `.meta.json`'s `quarantineCorruptSidecar`. Collapsing "damaged" into
    // "too new" is the exact defect #778 was filed for.
    expect(classifyPrefabWrite(prefabAt(undefined, { raw: '{ not json' }))).toBeNull();
    expect(classifyPrefabWrite(prefabAt(undefined, { raw: '[1,2,3]' }))).toBeNull();
    expect(classifyPrefabWrite(prefabAt(undefined, { raw: '"a string"' }))).toBeNull();
  });
});

describe('classifyPrefabWrite — what it refuses', () => {
  it('refuses a strictly newer version', () => {
    const r = classifyPrefabWrite(prefabAt(PREFAB_FORMAT_VERSION + 1));
    expect(r).not.toBeNull();
    expect(r!.stored).toBe(PREFAB_FORMAT_VERSION + 1);
    expect(r!.current).toBe(PREFAB_FORMAT_VERSION);
  });

  it('refuses a far-future version', () => {
    expect(classifyPrefabWrite(prefabAt(PREFAB_FORMAT_VERSION + 99))).not.toBeNull();
  });

  it('⚠️ refuses a numerically-newer NON-INTEGER version, which the classifier calls unreadable', () => {
    // `classifyFormatVersion` reports 5.5 as `unreadable`/`non-numeric-version`, so the
    // damaged-is-not-refused rule above would wave a plainly-from-the-future file straight through.
    // `rawPrefabVersion` exists only for this, mirroring `meta-sidecar.ts`'s `rawSidecarVersion`.
    const r = classifyPrefabWrite(prefabAt(PREFAB_FORMAT_VERSION + 0.5));
    expect(r).not.toBeNull();
    expect(r!.stored).toBe(PREFAB_FORMAT_VERSION + 0.5);
  });

  it('does NOT refuse an older non-integer — it is damaged, not from the future', () => {
    expect(classifyPrefabWrite(prefabAt(1.5))).toBeNull();
  });

  it('names the file and both versions, so the refusal is actionable', () => {
    const p = prefabAt(PREFAB_FORMAT_VERSION + 1);
    const r = classifyPrefabWrite(p)!;
    expect(r.message).toContain(p);
    expect(r.message).toContain(String(PREFAB_FORMAT_VERSION + 1));
    expect(r.message).toContain(String(PREFAB_FORMAT_VERSION));
  });
});

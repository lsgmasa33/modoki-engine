/**
 * A JSON asset or sidecar that starts with a UTF-8 BOM is read like any other (#1799).
 *
 * Node's `readFileSync(…, 'utf8')` keeps U+FEFF and `JSON.parse` throws on it, so before #1799:
 *  - a BOM'd prefab had NO guid in the asset manifest (OBSERVED on Windows: its instances and a
 *    UIEntries pool went blank, and new instances stored a raw path);
 *  - a BOM'd `.meta.json` classified `unreadable`, and `quarantineCorruptSidecar` moved it aside —
 *    the texture's import settings and slice guids left the asset.
 * Both are driven here through the REAL scanner and sidecar code, with the bytes a Windows tool
 * writes (BOM + CRLF).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { classifySidecarOnDisk, quarantineCorruptSidecar, readMetaSidecar, CORRUPT_SIDECAR_SUFFIX } from '../../plugins/meta-sidecar';
import { readAssetGuid, writeAssetGuid, scanAllAssets, buildManifest } from '../../plugins/vite-asset-scanner';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

const BOM = '\uFEFF';
const windowsBytes = (obj: unknown) => `${BOM}${JSON.stringify(obj, null, 2).replace(/\n/g, '\r\n')}\r\n`;
const PREFAB_GUID = '59dee356-b657-4bdf-a3b5-8274b975becc';
const TEXTURE_GUID = 'fa4adec8-c305-4c1e-9a01-3b7d2e6f8a90';

let root: string;
const abs = (p: string) => path.join(root, p);
const write = (p: string, content: string) => { fs.mkdirSync(path.dirname(abs(p)), { recursive: true }); fs.writeFileSync(abs(p), content); };

beforeEach(() => { root = makeScratchDir('modoki-bomassets-'); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('a BOM-prefixed prefab stays in the asset manifest (#1799, the observed symptom)', () => {
  const PREFAB = windowsBytes({ id: PREFAB_GUID, version: 8, name: 'Crate', rootLocalId: 1, entities: [] });

  it('readAssetGuid returns the id a BOM-prefixed prefab declares', () => {
    write('prefabs/Crate.prefab.json', PREFAB);
    expect(readAssetGuid(abs('prefabs/Crate.prefab.json'), 'prefab')).toBe(PREFAB_GUID);
  });

  it('the scan lists it WITH its guid, and a healing manifest build neither re-mints nor rewrites it', () => {
    write('prefabs/Crate.prefab.json', PREFAB);
    const entries = scanAllAssets([{ urlPrefix: '/assets', absDir: root }]);
    const crate = entries.find((e) => e.path === '/assets/prefabs/Crate.prefab.json');
    expect(crate?.guid, 'the manifest listed the prefab with no guid — every ref to it went blank').toBe(PREFAB_GUID);
    const manifest = buildManifest(entries, true);
    expect(manifest.assets.find((a) => a.path === '/assets/prefabs/Crate.prefab.json')?.guid).toBe(PREFAB_GUID);
    expect(fs.readFileSync(abs('prefabs/Crate.prefab.json'), 'utf8'), 'the heal must leave the file alone').toBe(PREFAB);
  });
});

describe('a BOM-prefixed .meta.json is not quarantined as corrupt (#1799)', () => {
  const SIDECAR = windowsBytes({ id: TEXTURE_GUID, version: 1, texture: { maxSize: 512 }, sprites: [{ guid: '86e73ddf', name: 'run_0' }] });

  it('classifies readable, and quarantineCorruptSidecar leaves it where it is', () => {
    write('tex.png', 'PNGBYTES');
    write('tex.png.meta.json', SIDECAR);
    expect(classifySidecarOnDisk(abs('tex.png')).kind).not.toBe('unreadable');
    expect(quarantineCorruptSidecar(abs('tex.png'))).toBeUndefined();
    expect(fs.existsSync(abs(`tex.png.meta.json${CORRUPT_SIDECAR_SUFFIX}`)), 'the sidecar was moved aside as corrupt').toBe(false);
  });

  it('keeps its authored settings through a guid re-stamp, and its guid and settings read back', () => {
    write('tex.png', 'PNGBYTES');
    write('tex.png.meta.json', SIDECAR);
    expect(readAssetGuid(abs('tex.png'), 'texture')).toBe(TEXTURE_GUID);
    expect(readMetaSidecar(abs('tex.png'))).toMatchObject({ texture: { maxSize: 512 } });
    expect(writeAssetGuid(abs('tex.png'), 'texture', 'b1b2c3d4-0000-4000-8000-000000001799')).toBe(true);
    expect(fs.existsSync(abs(`tex.png.meta.json${CORRUPT_SIDECAR_SUFFIX}`))).toBe(false);
    const after = JSON.parse(fs.readFileSync(abs('tex.png.meta.json'), 'utf8'));
    expect(after.texture, 'the import settings left the asset').toEqual({ maxSize: 512 });
    expect(after.sprites).toEqual([{ guid: '86e73ddf', name: 'run_0' }]);
  });

  it('a sidecar that is genuinely damaged is still quarantined (the accept side is not widened)', () => {
    write('bad.png', 'PNGBYTES');
    write('bad.png.meta.json', `${BOM}{ "id": "x", `);
    expect(classifySidecarOnDisk(abs('bad.png')).kind).toBe('unreadable');
    expect(quarantineCorruptSidecar(abs('bad.png'))).toBeDefined();
  });
});

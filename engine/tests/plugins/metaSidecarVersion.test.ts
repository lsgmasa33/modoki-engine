/** Coverage for the `.meta.json` sidecar FORMAT-version guard (#734).
 *
 *  Test 1's byte-comparison is the load-bearing assertion here: it is what
 *  distinguishes "the write was refused" from "the write happened but produced
 *  identical bytes" — a weaker check (e.g. "the file still exists") cannot tell
 *  those apart. Removing the guard from `writeMetaSidecar` (or from
 *  `assertSidecarWritable`) must turn tests 1 and 2 red. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeMetaSidecar, assertSidecarWritable, SIDECAR_FORMAT_VERSION } from '../../plugins/meta-sidecar';
import { writeAssetGuid } from '../../plugins/vite-asset-scanner';

let root: string;
const abs = (p: string) => path.join(root, p);
const write = (p: string, content: string) => { fs.mkdirSync(path.dirname(abs(p)), { recursive: true }); fs.writeFileSync(abs(p), content); };
const read = (p: string) => fs.readFileSync(abs(p), 'utf-8');
const exists = (p: string) => fs.existsSync(abs(p));

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-metasidecar-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('writeMetaSidecar — too-new sidecar refusal', () => {
  it('throws and leaves the on-disk sidecar byte-identical when the sidecar is a newer format', () => {
    const target = abs('tex.png');
    write('tex.png', 'PNGBYTES');
    const seeded = JSON.stringify({ version: 3, id: 'abc', sprites: [{ name: 's1' }] }, null, 2) + '\n';
    write('tex.png.meta.json', seeded);

    expect(() => writeMetaSidecar(target, { id: 'different-id', foo: 'bar' })).toThrow(
      /newer build|SIDECAR_FORMAT_VERSION/
    );

    // The load-bearing assertion: not just "still exists" — byte-identical to what
    // was seeded, proving nothing was rewritten (not even to the same content).
    expect(read('tex.png.meta.json')).toBe(seeded);
  });

  it('does not write a .meta.local.json when the write is refused', () => {
    const target = abs('tex2.png');
    write('tex2.png', 'PNGBYTES');
    write('tex2.png.meta.json', JSON.stringify({ version: 99, id: 'x' }));

    expect(() => writeMetaSidecar(target, {
      id: 'y',
      textureCache: { bytes: 123 }, // would normally be peeled into .meta.local.json
    })).toThrow();

    expect(exists('tex2.png.meta.local.json')).toBe(false);
  });
});

describe('assertSidecarWritable', () => {
  it('throws the same way writeMetaSidecar does, without writing anything', () => {
    const target = abs('mesh.glb');
    write('mesh.glb', 'GLBBYTES');
    const seeded = JSON.stringify({ version: 3, id: 'abc' }, null, 2) + '\n';
    write('mesh.glb.meta.json', seeded);

    expect(() => assertSidecarWritable(target)).toThrow(/newer build|SIDECAR_FORMAT_VERSION/);
    expect(read('mesh.glb.meta.json')).toBe(seeded);
    expect(exists('mesh.glb.meta.local.json')).toBe(false);
  });

  it('does not throw when there is no sidecar on disk yet', () => {
    const target = abs('brand-new.png');
    write('brand-new.png', 'X');
    expect(() => assertSidecarWritable(target)).not.toThrow();
  });
});

describe('writeMetaSidecar — normal writes stamp SIDECAR_FORMAT_VERSION', () => {
  it('stamps the version when no sidecar exists yet', () => {
    const target = abs('a.png');
    write('a.png', 'X');
    writeMetaSidecar(target, { id: 'g1' });
    const written = JSON.parse(read('a.png.meta.json'));
    expect(written.version).toBe(SIDECAR_FORMAT_VERSION);
    expect(written.version).toBe(2);
  });

  it('stamps the version (2) when the existing sidecar is already version 2', () => {
    const target = abs('b.png');
    write('b.png', 'X');
    write('b.png.meta.json', JSON.stringify({ version: 2, id: 'g2' }));
    writeMetaSidecar(target, { id: 'g2', extra: 'field' });
    const written = JSON.parse(read('b.png.meta.json'));
    expect(written.version).toBe(2);
    expect(written.extra).toBe('field');
  });

  it('stamps the version (2) when the existing sidecar is an OLDER version 1', () => {
    const target = abs('c.png');
    write('c.png', 'X');
    write('c.png.meta.json', JSON.stringify({ version: 1, id: 'g3' }));
    writeMetaSidecar(target, { id: 'g3' });
    const written = JSON.parse(read('c.png.meta.json'));
    expect(written.version).toBe(2);
  });

  it('the caller does not need to supply version at all — the module stamps it', () => {
    const target = abs('d.png');
    write('d.png', 'X');
    // Deliberately no `version` key in the meta object passed in.
    writeMetaSidecar(target, { id: 'g4' });
    const written = JSON.parse(read('d.png.meta.json'));
    expect(written.version).toBe(2);
  });
});

describe('writeMetaSidecar — only a strictly-greater on-disk version refuses', () => {
  it('proceeds normally when the on-disk sidecar is corrupt/unparsable JSON', () => {
    const target = abs('corrupt.png');
    write('corrupt.png', 'X');
    write('corrupt.png.meta.json', '{not valid json!!');
    expect(() => writeMetaSidecar(target, { id: 'g5' })).not.toThrow();
    const written = JSON.parse(read('corrupt.png.meta.json'));
    expect(written.id).toBe('g5');
    expect(written.version).toBe(2);
  });

  it('proceeds normally when the on-disk version is not a number', () => {
    const target = abs('strversion.png');
    write('strversion.png', 'X');
    write('strversion.png.meta.json', JSON.stringify({ version: 'not-a-number', id: 'g6' }));
    expect(() => writeMetaSidecar(target, { id: 'g6' })).not.toThrow();
    const written = JSON.parse(read('strversion.png.meta.json'));
    expect(written.version).toBe(2);
  });
});

describe('writeAssetGuid — a sidecar writer that bypasses writeMetaSidecar', () => {
  /** `writeMetaSidecar` is the choke point for MOST sidecar writes, but several writers
   *  bypass it — `writeAssetGuid` writes via vite-asset-scanner's OWN `writeJsonAtomic`,
   *  not through `writeMetaSidecar`, so it does not inherit that guard and carries its own
   *  stamp + refusal (#734). Each bypassing writer must carry both halves itself — see
   *  docs/format-versioning.md § 2b. */
  it('refuses to stamp a GUID into a sidecar written by a newer build, leaving it byte-identical', () => {
    const target = abs('rock.png');
    write('rock.png', 'PNGBYTES');
    const seeded = JSON.stringify({ version: 99, id: 'original-guid', texture: { format: 'webp' } }, null, 2) + '\n';
    write('rock.png.meta.json', seeded);

    expect(writeAssetGuid(target, 'texture', 'a-brand-new-guid')).toBe(false);
    expect(read('rock.png.meta.json')).toBe(seeded);
  });

  it('still stamps normally when the sidecar is a version this build understands', () => {
    const target = abs('ok.png');
    write('ok.png', 'PNGBYTES');
    // Seeded strictly OLDER than this build's version (not equal to it) so the
    // re-stamp assertion below actually distinguishes "re-stamped" from "already
    // matched" — matches vite-asset-scanner.ts's unconditional
    // `meta.version = SIDECAR_FORMAT_VERSION`, which also fires on this "existing
    // valid sidecar" path (intentional, mirroring writeMetaSidecar's behaviour).
    write('ok.png.meta.json', JSON.stringify({ version: 1, id: 'old-guid' }) + '\n');

    expect(writeAssetGuid(target, 'texture', 'fresh-guid')).toBe(true);
    const written = JSON.parse(read('ok.png.meta.json'));
    expect(written.id).toBe('fresh-guid');
    expect(written.version).toBe(SIDECAR_FORMAT_VERSION);
  });

  it('stamps SIDECAR_FORMAT_VERSION onto a brand-new sidecar (no sidecar exists yet)', () => {
    const target = abs('brand-new-guid.png');
    write('brand-new-guid.png', 'PNGBYTES');

    expect(writeAssetGuid(target, 'texture', 'new-guid')).toBe(true);
    const written = JSON.parse(read('brand-new-guid.png.meta.json'));
    expect(written.id).toBe('new-guid');
    expect(written.version).toBe(SIDECAR_FORMAT_VERSION);
  });

  it('stamps SIDECAR_FORMAT_VERSION onto the recreated sidecar when the existing one is corrupt JSON', () => {
    const target = abs('corrupt-guid.png');
    write('corrupt-guid.png', 'PNGBYTES');
    write('corrupt-guid.png.meta.json', '{not valid json!!');

    expect(writeAssetGuid(target, 'texture', 'recreated-guid')).toBe(true);
    const written = JSON.parse(read('corrupt-guid.png.meta.json'));
    expect(written.id).toBe('recreated-guid');
    expect(written.version).toBe(SIDECAR_FORMAT_VERSION);
  });
});

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
import {
  writeMetaSidecar,
  assertSidecarWritable,
  classifySidecarOnDisk,
  CORRUPT_SIDECAR_SUFFIX,
  SIDECAR_FORMAT_VERSION,
} from '../../plugins/meta-sidecar';
import { writeAssetGuid, readAssetGuid, detectType } from '../../plugins/vite-asset-scanner';

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

  it('still REFUSES a non-integer version that is numerically newer', () => {
    // Classification calls `3.5` `unreadable` — correct for a save, where malformed data
    // normalizes. For the sidecar that would be a RELAXATION: the old `versionOnDisk` returned
    // `3.5` and `3.5 > 2` threw, so routing through the shared classifier without this guard
    // would quarantine-and-replace a document that is plainly from the future rather than leave
    // it alone. Hypothetical today (no build writes one) and cheap to keep monotonic.
    const target = abs('fractional.png');
    write('fractional.png', 'PNGBYTES');
    const seeded = JSON.stringify({ version: 3.5, id: 'x', sprites: [{ name: 's1' }] }, null, 2) + '\n';
    write('fractional.png.meta.json', seeded);

    expect(() => writeMetaSidecar(target, { id: 'y' })).toThrow(/newer build|SIDECAR_FORMAT_VERSION/);
    expect(read('fractional.png.meta.json')).toBe(seeded);
    expect(exists('fractional.png.meta.json' + CORRUPT_SIDECAR_SUFFIX)).toBe(false);
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
    const original = '{not valid json!!';
    write('corrupt-guid.png.meta.json', original);

    expect(writeAssetGuid(target, 'texture', 'recreated-guid')).toBe(true);
    const written = JSON.parse(read('corrupt-guid.png.meta.json'));
    expect(written.id).toBe('recreated-guid');
    expect(written.version).toBe(SIDECAR_FORMAT_VERSION);
    // The recreation is only acceptable because the original was moved aside first (#778).
    // Before that fix this assertion did not exist and the bytes were simply gone.
    expect(read('corrupt-guid.png.meta.json' + CORRUPT_SIDECAR_SUFFIX)).toBe(original);
  });
});

/** #778 — an unparsable sidecar is QUARANTINED, never silently replaced.
 *
 *  The trigger this repo actually invites is not a crash mid-write (tmp+rename already closes
 *  that) but unresolved merge-conflict markers in a committed `.meta.json`: several hundred are
 *  tracked and shared by six clones across five long-lived branches, so two of them editing one
 *  asset's import settings is an ordinary conflict.
 *
 *  ⚠️ The load-bearing assertion in each test below is on the QUARANTINED file's bytes, not on
 *  the return value. "It returned false" or "a file still exists" cannot distinguish "the
 *  authored fields were preserved" from "they were destroyed and something was written". The
 *  original defect returned `true` while destroying them. */
describe('writeAssetGuid — a sidecar that does not parse is moved aside, not destroyed', () => {
  /** A realistic conflict: two clones changed the same texture's maxSize. Note this file is
   *  otherwise a perfectly ordinary sidecar — a GUID, import settings, and a hand-drawn sprite
   *  slice carrying its OWN guid that scenes reference. None of it is derivable from the PNG. */
  const CONFLICTED = [
    '{',
    '  "id": "fa4adec8-c305-4c1e-9a01-3b7d2e6f8a90",',
    '<<<<<<< HEAD',
    '  "texture": { "maxSize": 2048 },',
    '=======',
    '  "texture": { "maxSize": 1024 },',
    '>>>>>>> origin/main',
    '  "sprites": [{ "guid": "86e73ddf", "name": "run_0" }]',
    '}',
    '',
  ].join('\n');

  it('preserves every authored field in the quarantined file', () => {
    const target = abs('conflicted.png');
    write('conflicted.png', 'PNGBYTES');
    write('conflicted.png.meta.json', CONFLICTED);

    writeAssetGuid(target, 'texture', 'BRAND-NEW-GUID');

    // Byte-identical: the texture import settings and the sprite slice (with its own GUID) are
    // all still recoverable. Previously this content was replaced by `{"id": "BRAND-NEW-GUID"}`.
    expect(read('conflicted.png.meta.json' + CORRUPT_SIDECAR_SUFFIX)).toBe(CONFLICTED);
  });

  it('leaves a parsable sidecar alone — no quarantine file is created', () => {
    const target = abs('fine.png');
    write('fine.png', 'PNGBYTES');
    write('fine.png.meta.json', JSON.stringify({ id: 'keep-me', texture: { maxSize: 512 } }, null, 2) + '\n');

    expect(writeAssetGuid(target, 'texture', 'new-guid')).toBe(true);

    // The discriminating half: without this, a quarantine that fired on EVERY write would pass
    // the test above and be indistinguishable from the correct behaviour.
    expect(exists('fine.png.meta.json' + CORRUPT_SIDECAR_SUFFIX)).toBe(false);
    // And the authored field survives an ordinary re-stamp, which is the whole point.
    expect(JSON.parse(read('fine.png.meta.json')).texture).toEqual({ maxSize: 512 });
  });

  it('quarantines on the writeMetaSidecar path too, so every reimport handler is covered', () => {
    const target = abs('reimport.png');
    write('reimport.png', 'PNGBYTES');
    write('reimport.png.meta.json', CONFLICTED);

    // Every reimport handler reaches disk through `writeMetaSidecar`, and each has already lost
    // the authored fields by this point (`readMetaSidecar` returns `{}` for a corrupt file just
    // as for a missing one) — so the quarantine has to live at this choke point, not only in
    // `writeAssetGuid`.
    writeMetaSidecar(target, { id: 'x', textureCache: {} });

    expect(read('reimport.png.meta.json' + CORRUPT_SIDECAR_SUFFIX)).toBe(CONFLICTED);
  });

  it('the quarantined file is not itself scanned as an asset', () => {
    // ⚠️ `.meta.json.corrupt` ends in neither `.meta.json` nor `.json`, so it does not match the
    // sidecar skip by accident — it has to be listed. `.meta.local.json` had to be listed for the
    // same reason once already, and before that it was classified as a SCENE and minted a GUID.
    // Handing a GUID to the one file holding the unrecoverable authored fields would be the
    // funniest possible way to lose them.
    expect(detectType('sprites/player.png.meta.json' + CORRUPT_SIDECAR_SUFFIX, CORRUPT_SIDECAR_SUFFIX)).toBeNull();
    // The discriminating control: the source asset beside it is still scanned normally, so this
    // is not passing merely because `detectType` rejects everything it is handed here.
    expect(detectType('sprites/player.png', '.png')).not.toBeNull();
  });

  it('the asset keeps its GUID — preserving the bytes is not the same as preserving the asset', () => {
    // ⚠️ The half the byte-level assertions above do NOT cover, and the more expensive one.
    // The authored fields in the `.corrupt` file can be merged back by hand at leisure; a
    // re-minted GUID silently dangles every scene/prefab reference to this asset, and nothing
    // reports it. `readAssetGuid` returning undefined here is exactly what makes the scan's heal
    // pass mint a fresh one.
    const target = abs('keepsguid.png');
    write('keepsguid.png', 'PNGBYTES');
    write('keepsguid.png.meta.json', CONFLICTED);

    expect(readAssetGuid(target, 'texture')).toBe('fa4adec8-c305-4c1e-9a01-3b7d2e6f8a90');
  });

  it('an editor write that carries no id inherits the salvaged one', () => {
    // The seam that actually bites: the panels load through `/api/read-meta`, which returns `{}`
    // for an unparsable sidecar exactly as for a missing one, so the payload they POST has no
    // `id` at all. Without the salvage the sidecar written here is id-less and the next scan
    // mints a new GUID.
    const target = abs('panelwrite.png');
    write('panelwrite.png', 'PNGBYTES');
    write('panelwrite.png.meta.json', CONFLICTED);

    writeMetaSidecar(target, { texture: { maxSize: 256 } }); // no id — what a panel actually sends

    expect(JSON.parse(read('panelwrite.png.meta.json')).id).toBe('fa4adec8-c305-4c1e-9a01-3b7d2e6f8a90');
  });

  it('refuses to guess when the id ITSELF conflicts — minting is the honest outcome there', () => {
    const target = abs('idconflict.png');
    write('idconflict.png', 'PNGBYTES');
    write('idconflict.png.meta.json', [
      '{',
      '<<<<<<< HEAD',
      '  "id": "fa4adec8-c305-4c1e-9a01-3b7d2e6f8a90",',
      '=======',
      '  "id": "11111111-2222-3333-4444-555555555555",',
      '>>>>>>> origin/main',
      '  "texture": { "maxSize": 2048 }',
      '}',
      '',
    ].join('\n'));

    // Two different candidates and no way to tell which the scenes reference — salvaging either
    // would be a coin flip that LOOKS like a recovery. Both survive in the quarantined file.
    expect(readAssetGuid(target, 'texture')).toBeUndefined();
  });

  it('classifies a conflict-marked sidecar as unreadable, NOT as absent', () => {
    const target = abs('classify.png');
    write('classify.png', 'PNGBYTES');
    write('classify.png.meta.json', CONFLICTED);

    // The root cause of #778 in one assertion: the old `versionOnDisk` returned `undefined` for
    // this input exactly as it did for a missing file, so the too-new guard above it read a
    // corrupt sidecar as "no version" and failed open.
    expect(classifySidecarOnDisk(target)).toEqual({ kind: 'unreadable', reason: 'unparsable' });
    expect(classifySidecarOnDisk(abs('no-such-asset.png'))).toEqual({ kind: 'absent' });
  });
});

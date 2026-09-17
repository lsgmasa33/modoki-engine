/** Integration tests for the Assets-panel filesystem operations (the core of
 *  /api/create-folder, /api/move-file, /api/duplicate-asset). Each test builds
 *  real files under an isolated tmpdir and runs the op against disk, asserting
 *  the on-disk result — GUID regeneration, sidecar handling, the JSON-vs-binary
 *  branch, and folder-subtree moves. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createFolderAt, moveAssetFile, duplicateAssetFile, moveToTrash } from '../../plugins/asset-fs-ops';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

let root: string;
const abs = (p: string) => path.join(root, p);
const write = (p: string, content: string) => { fs.mkdirSync(path.dirname(abs(p)), { recursive: true }); fs.writeFileSync(abs(p), content); };
const read = (p: string) => fs.readFileSync(abs(p), 'utf-8');
const exists = (p: string) => fs.existsSync(abs(p));

beforeEach(() => { root = makeScratchDir('modoki-fsops-'); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('createFolderAt', () => {
  it('creates a nested folder', () => {
    createFolderAt(abs('a/b/New Folder'));
    expect(fs.statSync(abs('a/b/New Folder')).isDirectory()).toBe(true);
  });

  it('throws when the folder already exists (endpoint maps this to 409)', () => {
    createFolderAt(abs('dup'));
    expect(() => createFolderAt(abs('dup'))).toThrow(/exists/i);
  });
});

describe('moveAssetFile', () => {
  it('moves a file and creates the destination directory', () => {
    write('src/a.png', 'PNGBYTES');
    moveAssetFile(abs('src/a.png'), abs('dst/a.png'));
    expect(exists('src/a.png')).toBe(false);
    expect(read('dst/a.png')).toBe('PNGBYTES');
  });

  it('carries the .meta.json sidecar along', () => {
    write('src/a.png', 'X');
    write('src/a.png.meta.json', '{"id":"g1"}');
    moveAssetFile(abs('src/a.png'), abs('dst/a.png'));
    expect(exists('src/a.png.meta.json')).toBe(false);
    expect(read('dst/a.png.meta.json')).toBe('{"id":"g1"}');
  });

  it('carries a QUARANTINED .meta.json.corrupt along too (#778)', () => {
    // The same stranding bug as QA-CTX-0005 below, on the file that can least afford it: the
    // quarantined sidecar holds the ONLY surviving copy of the asset's authored fields (texture
    // import settings, sprite slices and their GUIDs). It is gitignored, so stranding it under
    // the old filename shows up in no `git status` — it surfaces when someone goes looking for
    // data they have already lost.
    write('src/a.png', 'X');
    write('src/a.png.meta.json', '{"id":"g1"}');
    write('src/a.png.meta.json.corrupt', '{"id":"g1"\n<<<<<<< HEAD');
    moveAssetFile(abs('src/a.png'), abs('dst/a.png'));
    expect(exists('src/a.png.meta.json.corrupt')).toBe(false);
    expect(read('dst/a.png.meta.json.corrupt')).toBe('{"id":"g1"\n<<<<<<< HEAD');
  });

  it('carries the GITIGNORED .meta.local.json half along too (QA-CTX-0005)', () => {
    // Both halves are written as a pair by writeMetaSidecar. Moving only the committed
    // one stranded the local stats under the OLD filename and left the moved asset
    // with none — invisible, because the file is gitignored.
    write('src/a.png', 'X');
    write('src/a.png.meta.json', '{"id":"g1"}');
    write('src/a.png.meta.local.json', '{"bytes":42}');
    moveAssetFile(abs('src/a.png'), abs('dst/a.png'));
    expect(exists('src/a.png.meta.local.json')).toBe(false);
    expect(read('dst/a.png.meta.local.json')).toBe('{"bytes":42}');
  });

  it('moves a whole folder subtree (rename of a directory)', () => {
    write('old/x.png', '1');
    write('old/sub/y.png', '2');
    moveAssetFile(abs('old'), abs('new'));
    expect(exists('old')).toBe(false);
    expect(read('new/x.png')).toBe('1');
    expect(read('new/sub/y.png')).toBe('2');
  });

  it('renames a folder with only a case change (Sprites → sprites)', () => {
    write('Sprites/a.png', '1');
    moveAssetFile(abs('Sprites'), abs('sprites'));
    expect(read('sprites/a.png')).toBe('1');
  });
});

describe('duplicateAssetFile', () => {
  it('JSON asset: rewrites the top-level id with the new GUID and returns it', () => {
    write('a.prefab.json', JSON.stringify({ id: 'orig', name: 'hero', n: 1 }));
    const guid = duplicateAssetFile(abs('a.prefab.json'), abs('a copy.prefab.json'), () => 'NEW-GUID');
    expect(guid).toBe('NEW-GUID');
    const copy = JSON.parse(read('a copy.prefab.json'));
    expect(copy.id).toBe('NEW-GUID');
    expect(copy.name).toBe('hero'); // rest preserved
    // Original untouched
    expect(JSON.parse(read('a.prefab.json')).id).toBe('orig');
  });

  it('a duplicated PREFAB ends in a trailing newline — assetJsonBytes, not a parsed round-trip (#835)', () => {
    // Byte assertion, not JSON.parse: a parse succeeds identically with or without the newline,
    // which is exactly how the old scene/prefab special case (isSceneOrPrefab) hid for so long.
    write('a.prefab.json', JSON.stringify({ id: 'orig' }));
    duplicateAssetFile(abs('a.prefab.json'), abs('a copy.prefab.json'), () => 'NEW-GUID');
    const bytes = fs.readFileSync(abs('a copy.prefab.json'));
    expect(bytes[bytes.length - 1]).toBe(0x0a);
  });

  it('JSON asset that fails to parse: copies verbatim and returns null', () => {
    write('broken.json', '{ not valid json');
    const guid = duplicateAssetFile(abs('broken.json'), abs('broken copy.json'), () => 'NEW');
    expect(guid).toBeNull();
    expect(read('broken copy.json')).toBe('{ not valid json');
  });

  it('binary asset: copies the file + sidecar with a fresh id, dropping `generated`', () => {
    write('m.glb', 'GLB');
    write('m.glb.meta.json', JSON.stringify({ id: 'orig', version: 2, generated: { meshes: ['x.mesh.json'] }, texture: { maxSize: 1024 } }));
    const guid = duplicateAssetFile(abs('m.glb'), abs('m copy.glb'), () => 'FRESH');
    expect(guid).toBe('FRESH');
    expect(read('m copy.glb')).toBe('GLB');
    const meta = JSON.parse(read('m copy.glb.meta.json'));
    expect(meta.id).toBe('FRESH');
    expect(meta.generated).toBeUndefined();   // parent's derived list NOT carried
    expect(meta.texture).toEqual({ maxSize: 1024 }); // other settings preserved
  });

  describe('a duplicated SCENE gets its own entity guids (#1293)', () => {
    // Real scene shape: flat rows, parentId as a guid, a prefab-instance ROOT whose guid sits on the
    // row (not in EntityAttributes), a structural add with its own guid and a nested add under it,
    // two in-file refs (an entityRef field and a UIAction binding), and one ref to a guid this file
    // does NOT define (an entity in its base scene), which must be left alone.
    const P = 'p0000000-0000-4000-8000-000000000001';      // parent
    const C = 'c0000000-0000-4000-8000-000000000002';      // child of P
    const R = 'r0000000-0000-4000-8000-000000000003';      // prefab-instance root (row-level guid)
    const A = 'a0000000-0000-4000-8000-000000000004';      // added[] node
    const N = 'n0000000-0000-4000-8000-000000000005';      // nested add under A
    const BASE = 'b0000000-0000-4000-8000-000000000006';   // defined in the BASE scene, not here
    const scene = {
      id: 'scene-orig', version: 11, baseScene: 'base-scene-asset',
      entities: [
        { id: 1, traits: { EntityAttributes: { name: 'Parent', guid: P, parentId: '' } } },
        {
          id: 2,
          traits: {
            EntityAttributes: { name: 'Child', guid: C, parentId: P },
            UINavigation: { navUp: P, navDown: BASE },
            UIAction: { bindings: [{ target: C, action: 'press' }] },
          },
        },
        {
          id: 3, prefab: 'prefab-asset', guid: R,
          traits: { PrefabInstance: { source: 'prefab-asset', localId: 1, rootInstanceId: R } },
          added: [{
            parentLocalId: 1, guid: A, name: 'Extra', traits: {},
            children: [{ parentLocalId: 0, guid: N, name: 'Deep', traits: {}, children: [] }],
          }],
        },
      ],
    };
    let n = 0;
    const gen = () => `NEW-${n++}`;
    const dup = () => {
      write('lvl.scene.json', JSON.stringify(scene));
      duplicateAssetFile(abs('lvl.scene.json'), abs('lvl copy.scene.json'), gen);
      return JSON.parse(read('lvl copy.scene.json'));
    };
    beforeEach(() => { n = 0; });

    it('every guid the file defines is fresh and distinct — including the instance root and added nodes', () => {
      const copy = dup();
      const [parent, child, inst] = copy.entities;
      const minted = [
        parent.traits.EntityAttributes.guid, child.traits.EntityAttributes.guid,
        inst.guid, inst.added[0].guid, inst.added[0].children[0].guid,
      ];
      expect(new Set(minted).size).toBe(5);
      for (const g of minted) expect(g).toMatch(/^NEW-/);
      expect(copy.id).toMatch(/^NEW-/);
      expect(minted).not.toContain(copy.id);
    });

    it('in-file references follow their entity: parentId, rootInstanceId, an entityRef field, a UIAction binding', () => {
      const copy = dup();
      const [parent, child, inst] = copy.entities;
      // Equality alone passes when NOTHING is reminted (both sides still the old guid) — pin that
      // the ref moved off the original, so this test fails on its own when only the refs are missed.
      for (const ref of [child.traits.EntityAttributes.parentId, child.traits.UINavigation.navUp,
        child.traits.UIAction.bindings[0].target, inst.traits.PrefabInstance.rootInstanceId]) {
        expect(ref).toMatch(/^NEW-/);
      }
      expect(child.traits.EntityAttributes.parentId).toBe(parent.traits.EntityAttributes.guid);
      expect(child.traits.UINavigation.navUp).toBe(parent.traits.EntityAttributes.guid);
      expect(child.traits.UIAction.bindings[0].target).toBe(child.traits.EntityAttributes.guid);
      expect(inst.traits.PrefabInstance.rootInstanceId).toBe(inst.guid);
    });

    it('a reference to a guid the file does NOT define is left alone, and asset refs are untouched', () => {
      const copy = dup();
      expect(copy.entities[1].traits.UINavigation.navDown).toBe(BASE);
      expect(copy.baseScene).toBe('base-scene-asset');
      expect(copy.entities[2].prefab).toBe('prefab-asset');
      expect(copy.entities[2].traits.PrefabInstance.source).toBe('prefab-asset');
    });

    it('leaves the original byte-identical', () => {
      dup();
      expect(read('lvl.scene.json')).toBe(JSON.stringify(scene));
    });

    it('a non-scene JSON is not reminted — a prefab keeps whatever guid-shaped values it carries', () => {
      write('x.prefab.json', JSON.stringify({ id: 'orig', entities: [{ traits: { EntityAttributes: { guid: P } } }] }));
      duplicateAssetFile(abs('x.prefab.json'), abs('x copy.prefab.json'), () => 'NEW');
      expect(JSON.parse(read('x copy.prefab.json')).entities[0].traits.EntityAttributes.guid).toBe(P);
    });

    it('a stale RUNTIME guid is not an identity — two rows sharing one are not collapsed onto one durable guid', () => {
      // The loader reads a runtime guid as "no guid" and derives a distinct one per row; minting ONE
      // durable guid for the shared value would make both rows answer to it — a same-file collision.
      const RT = '00000000-0000-0001-0000-000000000007';
      write('rt.scene.json', JSON.stringify({ id: 'o', entities: [
        { id: 1, traits: { EntityAttributes: { name: 'A', guid: RT } } },
        { id: 2, traits: { EntityAttributes: { name: 'B', guid: RT } } },
      ] }));
      duplicateAssetFile(abs('rt.scene.json'), abs('rt copy.scene.json'), gen);
      const rows = JSON.parse(read('rt copy.scene.json')).entities;
      expect(rows.map((r: { traits: { EntityAttributes: { guid: string } } }) => r.traits.EntityAttributes.guid)).toEqual([RT, RT]);
    });

    it('a scene saved with a UTF-8 BOM is still reminted — not copied verbatim under the original asset id', () => {
      write('bom.scene.json', '﻿' + JSON.stringify(scene));
      const guid = duplicateAssetFile(abs('bom.scene.json'), abs('bom copy.scene.json'), gen);
      expect(guid).toMatch(/^NEW-/);
      const copy = JSON.parse(read('bom copy.scene.json'));
      expect(copy.id).toBe(guid);
      expect(copy.entities[0].traits.EntityAttributes.guid).toMatch(/^NEW-/);
    });

    it('an own __proto__ key in the document is copied as a field, not applied as a prototype', () => {
      write('p.scene.json', `{"id":"o","entities":[{"id":1,"traits":{"EntityAttributes":{"guid":"${P}"}}}],"__proto__":{"polluted":true}}`);
      duplicateAssetFile(abs('p.scene.json'), abs('p copy.scene.json'), gen);
      const text = read('p copy.scene.json');
      expect(text).toContain('"__proto__"');
      expect(JSON.parse(text).entities[0].traits.EntityAttributes.guid).toMatch(/^NEW-/);
    });
  });

  it('binary asset without a sidecar: still mints a sidecar with the new id', () => {
    write('n.png', 'IMG');
    const guid = duplicateAssetFile(abs('n.png'), abs('n copy.png'), () => 'MINTED');
    expect(guid).toBe('MINTED');
    expect(JSON.parse(read('n copy.png.meta.json'))).toEqual({ id: 'MINTED', version: 2 });
  });
});

describe('moveToTrash', () => {
  // Drive the real execution + fs effect deterministically by injecting the
  // platform + an exec spy, so the test asserts on-disk removal without
  // depending on a Trash/osascript/trash-put being present in the environment.

  it('invokes the platform trash command with the resolved path (success path)', () => {
    write('keep/m.glb', 'GLB');
    const calls: { command: string; args: string[] }[] = [];
    moveToTrash(abs('keep/m.glb'), 'darwin', (command, args) => { calls.push({ command, args }); });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('osascript');
    expect(calls[0].args.join('\n')).toContain('as alias'); // the -1728 fix reaches exec
    expect(calls[0].args[calls[0].args.length - 1]).toBe(abs('keep/m.glb'));
  });

  it('batches a path LIST into ONE exec call (one trash sound)', () => {
    const paths = [abs('keep/a.glb'), abs('keep/a.glb.meta.json'), abs('keep/b.mesh.json')];
    const calls: { command: string; args: string[] }[] = [];
    moveToTrash(paths, 'darwin', (command, args) => { calls.push({ command, args }); });
    // The whole list goes through a SINGLE osascript invocation, not one per file.
    expect(calls).toHaveLength(1);
    expect(calls[0].args.slice(-paths.length)).toEqual(paths);
  });

  it('no-ops on an empty list (no exec, no throw)', () => {
    const calls: unknown[] = [];
    moveToTrash([], 'darwin', () => { calls.push(1); });
    expect(calls).toHaveLength(0);
  });

  it('Linux fallback: removes the file from disk when trash-put is unavailable', () => {
    write('gone/a.txt', 'X');
    expect(exists('gone/a.txt')).toBe(true);
    // Simulate trash-put missing: exec throws → moveToTrash falls back to rm.
    moveToTrash(abs('gone/a.txt'), 'linux', () => { throw new Error('trash-put: not found'); });
    expect(exists('gone/a.txt')).toBe(false);
  });

  it('Linux fallback removes EVERY path in the list when trash-put is unavailable', () => {
    write('many/a.txt', '1');
    write('many/sub/b.png', '2');
    moveToTrash([abs('many/a.txt'), abs('many/sub/b.png')], 'linux', () => { throw new Error('no trash-put'); });
    expect(exists('many/a.txt')).toBe(false);
    expect(exists('many/sub/b.png')).toBe(false);
  });

  it('Linux fallback removes a whole folder subtree, not just files', () => {
    write('tree/x.png', '1');
    write('tree/sub/y.png', '2');
    moveToTrash(abs('tree'), 'linux', () => { throw new Error('no trash-put'); });
    expect(exists('tree')).toBe(false);
  });
});

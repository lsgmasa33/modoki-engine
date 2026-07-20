/** Integration tests for the Assets-panel filesystem operations (the core of
 *  /api/create-folder, /api/move-file, /api/duplicate-asset). Each test builds
 *  real files under an isolated tmpdir and runs the op against disk, asserting
 *  the on-disk result — GUID regeneration, sidecar handling, the JSON-vs-binary
 *  branch, and folder-subtree moves. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createFolderAt, moveAssetFile, duplicateAssetFile, moveToTrash } from '../../plugins/asset-fs-ops';

let root: string;
const abs = (p: string) => path.join(root, p);
const write = (p: string, content: string) => { fs.mkdirSync(path.dirname(abs(p)), { recursive: true }); fs.writeFileSync(abs(p), content); };
const read = (p: string) => fs.readFileSync(abs(p), 'utf-8');
const exists = (p: string) => fs.existsSync(abs(p));

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-fsops-')); });
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

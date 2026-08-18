/** Delete + rename POLICY for the Assets panel (#105 Phase 3) — `deletionPathsFor`
 *  and `planRename`, extracted from `Assets.tsx` into the existing `assetOps` seam.
 *
 *  The delete rule is the one with history: a binary asset's `.meta.json` used to
 *  be snapshotted for undo but never trashed, so every binary/model delete left an
 *  orphaned sidecar on disk. It carries the asset's GUID and import settings, so
 *  losing track of it dangles both. That rule was only reachable through fetch +
 *  the backend; now it is a list. */

import { describe, it, expect } from 'vitest';
import { deletionPathsFor, planRename } from '../../src/editor/panels/assetOps';

describe('deletionPathsFor — the sidecar rule', () => {
  it('puts the asset itself first, so an undo restores in the original order', () => {
    expect(deletionPathsFor('/a/hero.png', 'texture')[0]).toBe('/a/hero.png');
  });

  it('trashes a BINARY asset\'s .meta.json, not just snapshots it', () => {
    // The regression: this list used to contain only the asset.
    expect(deletionPathsFor('/a/hero.png', 'texture')).toEqual([
      '/a/hero.png', '/a/hero.png.meta.json', '/a/hero.png.meta.local.json',
    ]);
  });

  it('also trashes the gitignored .meta.local.json half', () => {
    // The second half of the same sidecar rule: the machine-local byte-stats file was
    // stranded on every delete. Gitignored, so nothing ever surfaced the residue.
    expect(deletionPathsFor('/a/hero.png', 'texture')).toContain('/a/hero.png.meta.local.json');
  });

  it('gives a TEXT asset no sidecar — it carries its id inline', () => {
    expect(deletionPathsFor('/a/mat.mat.json', 'material')).toEqual(['/a/mat.mat.json']);
    expect(deletionPathsFor('/a/level.scene.json', 'scene')).toEqual(['/a/level.scene.json']);
  });

  it('ignores generated files for a non-model, even if the meta lists them', () => {
    // Only a model import generates; a texture carrying a stale `generated` block
    // must not drag unrelated files into the trash.
    expect(deletionPathsFor('/a/hero.png', 'texture', { textures: ['/a/other.png'] }))
      .toEqual(['/a/hero.png', '/a/hero.png.meta.json', '/a/hero.png.meta.local.json']);
  });

  it('takes a model\'s generated meshes, materials and textures', () => {
    const paths = deletionPathsFor('/m/rig.glb', 'model', {
      meshes: ['/m/rig.mesh.json'],
      materials: ['/m/rig.mat.json'],
      textures: ['/m/rig_diffuse.png'],
    });
    expect(paths).toEqual([
      '/m/rig.glb', '/m/rig.glb.meta.json', '/m/rig.glb.meta.local.json',
      '/m/rig.mesh.json',            // text — no sidecar
      '/m/rig.mat.json',             // text — no sidecar
      // binary — both sidecar halves
      '/m/rig_diffuse.png', '/m/rig_diffuse.png.meta.json', '/m/rig_diffuse.png.meta.local.json',
    ]);
  });

  it('gives each generated BINARY its own sidecar but not the JSON ones', () => {
    const paths = deletionPathsFor('/m/rig.glb', 'model', { textures: ['/m/a.png', '/m/b.png'], meshes: ['/m/a.mesh.json'] });
    expect(paths.filter((p) => p.endsWith('.meta.json')))
      .toEqual(['/m/rig.glb.meta.json', '/m/a.png.meta.json', '/m/b.png.meta.json']);
    expect(paths.filter((p) => p.endsWith('.meta.local.json')))
      .toEqual(['/m/rig.glb.meta.local.json', '/m/a.png.meta.local.json', '/m/b.png.meta.local.json']);
  });

  it('degrades to the bare model delete when the meta is missing or empty', () => {
    const bare = ['/m/rig.glb', '/m/rig.glb.meta.json', '/m/rig.glb.meta.local.json'];
    expect(deletionPathsFor('/m/rig.glb', 'model', null)).toEqual(bare);
    expect(deletionPathsFor('/m/rig.glb', 'model', {})).toEqual(bare);
    expect(deletionPathsFor('/m/rig.glb', 'model', { meshes: [] })).toEqual(bare);
  });
});

describe('planRename', () => {
  const EXISTING = ['/a/hero.png', '/a/villain.png', '/a/notes.txt'];

  it('keeps the folder and the full extension', () => {
    expect(planRename('/a/hero.png', 'champion', EXISTING)).toEqual({ ok: true, toPath: '/a/champion.png', base: 'champion' });
  });

  it('preserves a DOUBLE extension rather than treating .json as the whole ext', () => {
    // splitAssetPath cuts at the first dot, so `.mesh.json` travels as one unit —
    // renaming must not turn rig.mesh.json into champion.json.
    expect(planRename('/m/rig.mesh.json', 'champion', [])).toMatchObject({ toPath: '/m/champion.mesh.json' });
  });

  it('refuses an empty or whitespace-only name', () => {
    expect(planRename('/a/hero.png', '', EXISTING)).toEqual({ ok: false, reason: 'empty' });
    expect(planRename('/a/hero.png', '   ', EXISTING)).toEqual({ ok: false, reason: 'empty' });
  });

  it('refuses a no-op rename', () => {
    expect(planRename('/a/hero.png', 'hero', EXISTING)).toEqual({ ok: false, reason: 'unchanged' });
    expect(planRename('/a/hero.png', '  hero  ', EXISTING)).toEqual({ ok: false, reason: 'unchanged' });
  });

  it('refuses a collision, and reports the path it would have taken', () => {
    expect(planRename('/a/hero.png', 'villain', EXISTING)).toEqual({ ok: false, reason: 'exists', toPath: '/a/villain.png' });
  });

  it('collides only on the FULL path, so the same name in another folder is fine', () => {
    expect(planRename('/b/hero.png', 'villain', EXISTING)).toMatchObject({ ok: true, toPath: '/b/villain.png' });
  });

  it('neutralises separators instead of letting a rename relocate the asset', () => {
    // The important half: the result stays in /a/, it does not become /a/sub/evil.png.
    expect(planRename('/a/hero.png', '../evil', [])).toMatchObject({ toPath: '/a/.._evil.png' });
    expect(planRename('/a/hero.png', 'sub/evil', [])).toMatchObject({ toPath: '/a/sub_evil.png' });
    expect(planRename('/a/hero.png', 'sub\\evil', [])).toMatchObject({ toPath: '/a/sub_evil.png' });
  });
});

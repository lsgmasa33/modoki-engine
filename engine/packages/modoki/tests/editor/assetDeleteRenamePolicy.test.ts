/** Delete + rename POLICY for the Assets panel (#105 Phase 3) — `deletionPathsFor`
 *  and `planRename`, extracted from `Assets.tsx` into the existing `assetOps` seam.
 *
 *  The delete rule is the one with history: a binary asset's `.meta.json` used to
 *  be snapshotted for undo but never trashed, so every binary/model delete left an
 *  orphaned sidecar on disk. It carries the asset's GUID and import settings, so
 *  losing track of it dangles both. That rule was only reachable through fetch +
 *  the backend; now it is a list. */

import { describe, it, expect } from 'vitest';
import {
  deletionPathsFor, planRename, planDeleteOutcome, describeRefusedDeletes,
} from '../../src/editor/panels/assetOps';

describe('deletionPathsFor — the sidecar rule', () => {
  it('puts the asset itself first, so an undo restores in the original order', () => {
    expect(deletionPathsFor('/a/hero.png', 'texture')[0]).toBe('/a/hero.png');
  });

  it('trashes a BINARY asset\'s .meta.json, not just snapshots it', () => {
    // The regression: this list used to contain only the asset.
    expect(deletionPathsFor('/a/hero.png', 'texture'))
      .toEqual(['/a/hero.png', '/a/hero.png.meta.json', '/a/hero.png.meta.local.json']);
  });

  it('trashes the GITIGNORED .meta.local.json half too (QA-CTX-0005)', () => {
    // The second regression in the same rule. `.meta.local.json` holds this machine's
    // byte stats and is gitignored, so a stranded one never shows in `git status` —
    // every binary delete left one behind, forever.
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
      // binary — BOTH sidecar halves
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

/** #884 — what the panel does with a delete the OS REFUSED.
 *
 *  `/api/delete-asset` reports per PATH (`failed`); the panel used to act per REQUEST, so a file
 *  still on disk lost its row, kept an unbound editor and was offered back by undo. These are the
 *  two decisions that split, extracted out of `Assets.tsx` so they can be asserted without
 *  mounting it. */
describe('planDeleteOutcome — act on what went, not on what was asked', () => {
  const REQ = ['/a/hero.png', '/a/hero.png.meta.json', '/a/tree.png', '/a/tree.png.meta.json'];
  const ASSETS = ['/a/hero.png', '/a/tree.png'];

  it('keeps a refused file OUT of `went`, so nothing downstream unbinds it', () => {
    const { went } = planDeleteOutcome(REQ, ASSETS, ['/a/tree.png']);
    expect(went).toEqual(['/a/hero.png', '/a/hero.png.meta.json', '/a/tree.png.meta.json']);
    expect(went).not.toContain('/a/tree.png');
  });

  it('keeps the refused asset\'s ROW listed — the defect this exists for', () => {
    // The old code removed every requested asset because `ok` was true.
    const { removed } = planDeleteOutcome(REQ, ASSETS, ['/a/tree.png']);
    expect(removed).toEqual(['/a/hero.png']);
  });

  it('still removes the row when only a SIDECAR was refused — the mirror defect', () => {
    // The asset itself is gone; a row pointing at nothing is not better than a stray sidecar.
    const { removed, went } = planDeleteOutcome(REQ, ASSETS, ['/a/tree.png.meta.json']);
    expect(removed).toEqual(ASSETS);
    // …but the refused sidecar still must not be unbound or restored.
    expect(went).not.toContain('/a/tree.png.meta.json');
  });

  it('ACCEPT SIDE: with nothing refused, every row goes and every path counts as went', () => {
    // A guard proven only on its reject side is half-tested — this is the case that runs every
    // time a delete works, and it must not start reporting phantom survivors.
    const { went, removed } = planDeleteOutcome(REQ, ASSETS, []);
    expect(went).toEqual(REQ);
    expect(removed).toEqual(ASSETS);
  });
});

describe('describeRefusedDeletes — the message the human gets', () => {
  it('returns null when nothing was refused, so a working delete is silent', () => {
    expect(describeRefusedDeletes([], { trashed: 3 })).toBeNull();
  });

  it('names a PARTIAL delete by what did go, and by what was really THERE', () => {
    // ⚠️ The denominator is trashed + refused (4), NOT the requested-path count. A delete asks for
    // maybe-absent sidecars on purpose, so requesting 7 paths to remove one texture would report
    // "Moved 3 of 7" about files that never existed.
    const r = describeRefusedDeletes(['/a/tree.png'], { trashed: 3 })!;
    expect(r.toast).toContain('Moved 3 of 4');
    expect(r.toast).toContain('tree.png');
  });

  it('says "on disk", never "listed" — a refused SIDECAR has no row to stay in', () => {
    // vite-asset-scanner classifies .meta.json / .meta.local.json as null, so they are never
    // listed; and the asset's own row is gone anyway when its primary file went.
    const r = describeRefusedDeletes(['/a/tree.png.meta.json'], { trashed: 2 })!;
    expect(r.toast).toContain('still on disk');
    expect(r.toast).not.toContain('listed');
  });

  it('does NOT say "moved 0 of N" for a total refusal — that reads as a count that could tick up', () => {
    const r = describeRefusedDeletes(['/a/tree.png'], { trashed: 0 })!;
    expect(r.toast).not.toContain('0 of');
    expect(r.toast).toContain('still on disk');
  });

  it('caps the named files and says how many more, so the toast cannot run off', () => {
    const many = ['/a/1.png', '/a/2.png', '/a/3.png', '/a/4.png', '/a/5.png'];
    const r = describeRefusedDeletes(many, { trashed: 0 })!;
    expect(r.toast).toContain('+2 more');
    // The console line is the only hand-recovery record, so it keeps every FULL path.
    expect(r.detail).toBe(many.join(', '));
  });
});

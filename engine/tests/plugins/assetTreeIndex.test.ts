/** #1708 — the known-file index that turns ONE recursive `fs.watch`'s coarse events back into chokidar's per-file
 *  `add` / `change` / `unlink`. Pure: a fake filesystem and hand-fed raw events, so it runs on every platform, and each
 *  case runs twice, with the Windows path spelling and with the POSIX one.
 *
 *  The fake filesystem is CASE-INSENSITIVE for `stat` (like NTFS/APFS defaults) and exact for `readdir`, so the
 *  case-only rename case can tell "asked the listing" from "asked stat".
 *
 *  Mutations, each checked red on its own cases and nothing else:
 *  - folder expansion: `removeUnder` unlinks only the path itself, not the known files under it → "a recycled folder".
 *  - case check: `lookup` returns `fs.stat(abs(rel))` instead of consulting the parent listing → "a case-only rename".
 *  - other-spelling fallback: `reconcile` skips its loop over the parent's case-insensitive matches → both "…arrives as
 *    the old name ALONE" cases (folder and file).
 *  - "no ping-pong" is held by TWO guards, so the mutation breaks both: drop the "exact name is listed" early return AND
 *    recurse into `reconcile` for a file variant (the pre-review shape) → a stack overflow. Either guard alone holds.
 *  - overflow: `flush` ignores the overflow flag (reconciles the pending set only) → "an overflow, then one file
 *    modified in place" and "past the threshold".
 *  - the rescan diffs the file SET only (`setFile` never emits `change` for a known file) → "an overflow, then one file
 *    modified in place". */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { createAssetTreeIndex, type TreeEventKind, type TreeFs, type RawTreeEvent } from '../../plugins/assetTreeIndex';

type P = typeof path.win32;

function fakeFs(p: P, root: string) {
  const nodes = new Map<string, { isDir: boolean; mtimeMs: number; size: number }>();
  nodes.set(root, { isDir: true, mtimeMs: 0, size: 0 });
  const fold = (s: string) => s.toLowerCase();
  const find = (abs: string) => { for (const [k, v] of nodes) if (fold(k) === fold(abs)) return [k, v] as const; return null; };
  let clock = 1;
  const api = {
    mkdir(rel: string) {
      let cur = root;
      for (const seg of rel.split(p.sep)) { cur = p.join(cur, seg); if (!find(cur)) nodes.set(cur, { isDir: true, mtimeMs: 0, size: 0 }); }
    },
    write(rel: string, size = 10) {
      api.mkdir(p.dirname(rel) === '.' ? '' : p.dirname(rel));
      const abs = p.join(root, rel);
      const hit = find(abs);
      nodes.set(hit ? hit[0] : abs, { isDir: false, mtimeMs: clock++, size });
    },
    /** Remove `rel` and everything under it (case-insensitively, like the volume). */
    remove(rel: string) {
      const hit = find(p.join(root, rel));
      if (!hit) return;
      for (const k of [...nodes.keys()]) if (k === hit[0] || fold(k).startsWith(fold(hit[0]) + p.sep)) nodes.delete(k);
    },
    /** Rename, keeping the subtree; the new spelling is what `readdir` then shows. */
    rename(fromRel: string, toRel: string) {
      const hit = find(p.join(root, fromRel));
      if (!hit) throw new Error('no ' + fromRel);
      const to = p.join(root, toRel);
      for (const [k, v] of [...nodes]) {
        if (k === hit[0] || fold(k).startsWith(fold(hit[0]) + p.sep)) { nodes.delete(k); nodes.set(to + k.slice(hit[0].length), v); }
      }
    },
    readdirCalls: 0,
    fs: {
      readdir(absDir: string) {
        api.readdirCalls++;
        const dir = find(absDir);
        if (!dir || !dir[1].isDir) return null;
        return [...nodes].filter(([k]) => k !== dir[0] && fold(p.dirname(k)) === fold(dir[0]))
          .map(([k, v]) => ({ name: p.basename(k), isDir: v.isDir }));
      },
      stat(abs: string) { const hit = find(abs); return hit ? { ...hit[1] } : null; },
    } satisfies TreeFs,
  };
  return api;
}

for (const [label, p, root] of [['win32 paths', path.win32, 'E:\\proj\\runtime\\assets'], ['posix paths', path.posix, '/proj/runtime/assets']] as const) {
  describe(`assetTreeIndex (${label})`, () => {
    function setup(opts: { resyncThreshold?: number } = {}) {
      const disk = fakeFs(p as P, root);
      const events: Array<[TreeEventKind, string]> = [];
      const index = createAssetTreeIndex({ root, fs: disk.fs, emit: (k, a) => events.push([k, a]), pathImpl: p, ...opts });
      const rel = (s: string) => s.split('/').join(p.sep);
      const abs = (s: string) => p.join(root, rel(s));
      const feed = (...evs: RawTreeEvent[]) => { for (const e of evs) index.note(e); index.flush(); };
      const ren = (s: string): RawTreeEvent => ({ rel: rel(s), kind: 'rename' });
      const chg = (s: string): RawTreeEvent => ({ rel: rel(s), kind: 'change' });
      return { disk, events, index, rel, abs, feed, ren, chg };
    }
    const sorted = (e: Array<[TreeEventKind, string]>) => [...e].sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));

    it('seeding records every file under the root, emits nothing, and skips dot entries and node_modules', () => {
      const t = setup();
      for (const f of ['a.json', 'kit/b.json', 'kit/deep/c.prefab.json', '.cache/x.json', 'kit/.hidden', 'node_modules/y.json']) t.disk.write(t.rel(f));
      t.index.seed();
      expect(t.events).toEqual([]);
      expect(t.index.knownFiles().sort()).toEqual(['a.json', 'kit/b.json', 'kit/deep/c.prefab.json'].map(t.rel).sort());
    });

    it('a recycled folder reports ONE event — the index unlinks every known file under it', () => {
      const t = setup();
      for (const f of ['nest/a.json', 'nest/sub/b.json', 'nest/sub/dééper/c.prefab.json', 'keep.json']) t.disk.write(t.rel(f));
      t.index.seed();
      t.disk.remove(t.rel('nest'));
      // What the recursive watch really sent for this (measured on Windows): the deepest dir's change, then the top.
      t.feed(t.chg('nest/sub/dééper'), t.ren('nest'));
      expect(sorted(t.events)).toEqual(sorted([
        ['unlink', t.abs('nest/a.json')], ['unlink', t.abs('nest/sub/b.json')], ['unlink', t.abs('nest/sub/dééper/c.prefab.json')],
      ]));
      expect(t.index.knownFiles()).toEqual([t.rel('keep.json')]);
    });

    it('a folder moved in (a restore, an undo) reports ONE event — the index walks it and adds every file', () => {
      const t = setup();
      t.index.seed();
      for (const f of ['restored/a.json', 'restored/sub/b.prefab.json']) t.disk.write(t.rel(f));
      t.feed(t.ren('restored'), t.chg('restored'));
      expect(sorted(t.events)).toEqual(sorted([['add', t.abs('restored/a.json')], ['add', t.abs('restored/sub/b.prefab.json')]]));
    });

    it('a folder rename arrives as two unpaired renames — the old files unlink, the new ones add', () => {
      const t = setup();
      for (const f of ['ren/a.json', 'ren/sub/b.json']) t.disk.write(t.rel(f));
      t.index.seed();
      t.disk.rename(t.rel('ren'), t.rel('ren2'));
      t.feed(t.ren('ren'), t.ren('ren2'));
      expect(sorted(t.events)).toEqual(sorted([
        ['unlink', t.abs('ren/a.json')], ['unlink', t.abs('ren/sub/b.json')], ['add', t.abs('ren2/a.json')], ['add', t.abs('ren2/sub/b.json')],
      ]));
    });

    it('a case-only rename unlinks the old spelling — the volume still answers stat for it, the listing does not', () => {
      const t = setup();
      t.disk.write(t.rel('Foo.prefab.json'));
      t.disk.write(t.rel('Kit/a.json'));
      t.index.seed();
      expect(t.disk.fs.stat(t.abs('foo.prefab.json')), 'premise: the fake volume is case-insensitive').not.toBeNull();
      t.disk.rename(t.rel('Foo.prefab.json'), t.rel('foo.prefab.json'));
      t.disk.rename(t.rel('Kit'), t.rel('kit'));
      t.feed(t.ren('Foo.prefab.json'), t.ren('foo.prefab.json'), t.ren('Kit'), t.ren('kit'));
      expect(sorted(t.events)).toEqual(sorted([
        ['unlink', t.abs('Foo.prefab.json')], ['add', t.abs('foo.prefab.json')], ['unlink', t.abs('Kit/a.json')], ['add', t.abs('kit/a.json')],
      ]));
      expect(t.index.knownFiles().sort()).toEqual([t.rel('foo.prefab.json'), t.rel('kit/a.json')].sort());
    });

    it('a case-only FOLDER rename that arrives as the old name ALONE still adds the new spelling (Windows, #1708 review)', () => {
      const t = setup();
      t.disk.write(t.rel('Sprites/b.json'));
      t.disk.write(t.rel('Sprites/Sub/hero.prefab.json'));
      t.index.seed();
      t.disk.rename(t.rel('Sprites'), t.rel('sprites'));
      t.feed(t.ren('Sprites')); // the new-name half never comes
      expect(sorted(t.events)).toEqual(sorted([
        ['unlink', t.abs('Sprites/b.json')], ['unlink', t.abs('Sprites/Sub/hero.prefab.json')],
        ['add', t.abs('sprites/b.json')], ['add', t.abs('sprites/Sub/hero.prefab.json')],
      ]));
      t.events.length = 0;
      t.disk.remove(t.rel('sprites/b.json')); // …so a later outside delete in it is still reported
      t.feed(t.ren('sprites/b.json'));
      expect(t.events).toEqual([['unlink', t.abs('sprites/b.json')]]);
    });

    it('a case-only FILE rename that arrives as the old name alone also adds the new spelling', () => {
      const t = setup();
      t.disk.write(t.rel('kit/Foo.prefab.json'));
      t.index.seed();
      t.disk.rename(t.rel('kit/Foo.prefab.json'), t.rel('kit/foo.prefab.json'));
      t.feed(t.ren('kit/Foo.prefab.json'));
      expect(sorted(t.events)).toEqual(sorted([['unlink', t.abs('kit/Foo.prefab.json')], ['add', t.abs('kit/foo.prefab.json')]]));
    });

    it('a case-SENSITIVE folder listing a.json AND A.json, both unreadable: no ping-pong between the two spellings', () => {
      const events: Array<[TreeEventKind, string]> = [];
      const fs: TreeFs = {
        readdir: (d) => (d === root ? [{ name: 'a.json', isDir: false }, { name: 'A.json', isDir: false }] : null),
        stat: () => null, // dangling links, or deleted after the listing was read
      };
      const index = createAssetTreeIndex({ root, fs, emit: (k, a) => events.push([k, a]), pathImpl: p });
      index.seed();
      index.note({ rel: 'a.json', kind: 'rename' });
      expect(() => index.flush()).not.toThrow();
      expect(events).toEqual([]);
    });

    it('an overflow, then one file modified in place: the rescan emits exactly one change', () => {
      const t = setup();
      for (const f of ['a.prefab.json', 'kit/b.json', 'kit/c.json']) t.disk.write(t.rel(f));
      t.index.seed();
      t.disk.write(t.rel('kit/b.json'), 10); // same size, new mtime — what a checkout does to most files
      t.feed({ overflow: true });
      expect(t.events).toEqual([['change', t.abs('kit/b.json')]]);
    });

    it('the rescan also finds what was added and removed, and a file whose size changed', () => {
      const t = setup();
      for (const f of ['a.json', 'gone/x.json']) t.disk.write(t.rel(f));
      t.index.seed();
      t.disk.remove(t.rel('gone'));
      t.disk.write(t.rel('new/y.json'));
      const before = t.disk.fs.stat(t.abs('a.json'))!;
      t.disk.write(t.rel('a.json'), 99);
      t.feed({ overflow: true });
      expect(t.disk.fs.stat(t.abs('a.json'))!.size).not.toBe(before.size);
      expect(sorted(t.events)).toEqual(sorted([['unlink', t.abs('gone/x.json')], ['add', t.abs('new/y.json')], ['change', t.abs('a.json')]]));
    });

    it('past the pending threshold, one rescan replaces per-path reconciling — it finds a change nothing reported', () => {
      const t = setup({ resyncThreshold: 2 });
      t.disk.write(t.rel('a.json'));
      t.index.seed();
      t.disk.write(t.rel('a.json'));
      t.feed(t.chg('x1'), t.chg('x2'), t.chg('x3'));
      expect(t.events).toEqual([['change', t.abs('a.json')]]);
    });

    it('a file change emits change only when mtime or size moved (Windows also fires on metadata)', () => {
      const t = setup();
      t.disk.write(t.rel('a.json'));
      t.index.seed();
      t.feed(t.chg('a.json'));
      expect(t.events).toEqual([]);
      t.disk.write(t.rel('a.json'));
      t.feed(t.chg('a.json'), t.chg('a.json'));
      expect(t.events).toEqual([['change', t.abs('a.json')]]);
    });

    it('a change on a KNOWN folder is not a walk — its children report themselves', () => {
      const t = setup();
      t.disk.write(t.rel('kit/a.json'));
      t.index.seed();
      t.disk.write(t.rel('kit/b.json'));
      t.feed(t.chg('kit'));
      expect(t.events).toEqual([]);
      t.feed(t.ren('kit/b.json'));
      expect(t.events).toEqual([['add', t.abs('kit/b.json')]]);
    });

    it('events under an ignored segment are dropped', () => {
      const t = setup();
      t.index.seed();
      t.disk.write(t.rel('.cache/x.json'));
      t.disk.write(t.rel('kit/node_modules/y.json'));
      t.feed(t.ren('.cache/x.json'), t.ren('kit/node_modules/y.json'));
      expect(t.events).toEqual([]);
    });

    it('a deleted single file unlinks just that file; a file replaced by a folder of the same name swaps kinds', () => {
      const t = setup();
      for (const f of ['a.json', 'a.json.meta.json', 'thing']) t.disk.write(t.rel(f));
      t.index.seed();
      t.disk.remove(t.rel('a.json'));
      t.feed(t.ren('a.json'));
      expect(t.events).toEqual([['unlink', t.abs('a.json')]]);
      t.events.length = 0;
      t.disk.remove(t.rel('thing'));
      t.disk.write(t.rel('thing/inner.json'));
      t.feed(t.ren('thing'));
      expect(sorted(t.events)).toEqual(sorted([['unlink', t.abs('thing')], ['add', t.abs('thing/inner.json')]]));
    });
  });
}

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findDeleteBoundaries, describeBoundary } from '../../scripts/deleteBoundary.mjs';
import { makeDirLink } from '../helpers/linkFixture';
import { readScannedSource } from '@modoki/engine/testing';
import { refuseUnsafeReplace } from '../../toolchain/replaceGuard';

/** `deleteBoundary.mjs` — "would a recursive delete of this subtree misreport what it did?"
 *
 *  The SSOT behind #883's guard (`clean-packaged-cache.mjs`) and #1004's (`forceRemoveDir`), so it
 *  is tested here once rather than twice through its consumers.
 *
 *  ⚠️ **The accept cases are not padding.** "Refuse on any nested link" is the obvious
 *  implementation and it is WRONG — npm's `node_modules/.bin` shims are symlinks, and the toolchain
 *  installs npm tools into `MODOKI_TOOLCHAIN_DIR`, so that version refuses every POSIX run while
 *  passing every refusal case here. The inside-pointing and dangling cases are what separate the
 *  two implementations.
 */
describe('deleteBoundary — the subtree pre-flight (#990/#989/#1004)', () => {
  let root: string;
  beforeEach(() => { root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'db-'))); });
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* fixture */ } });

  const mk = (...seg: string[]) => { const p = path.join(root, ...seg); fs.mkdirSync(p, { recursive: true }); return p; };
  const payload = () => { const p = mk('PAYLOAD'); fs.writeFileSync(path.join(p, 'big.bin'), 'x'); return p; };

  describe('accept — a self-contained subtree, and the shapes that only LOOK like defects', () => {
    it('is empty for a plain tree of real directories and files', () => {
      const c = mk('clean', 'sub', 'deep');
      fs.writeFileSync(path.join(c, 'a.txt'), 'x');
      expect(findDeleteBoundaries(path.join(root, 'clean'))).toEqual([]);
    });

    // The case that makes "refuse on any nested link" unshippable.
    it('ALLOWS a nested link whose target is INSIDE the subtree (npm .bin shim shape)', () => {
      const c = mk('inside');
      mk('inside', 'pkg'); fs.writeFileSync(path.join(c, 'pkg', 'cli.js'), 'x');
      mk('inside', 'bin');
      makeDirLink(path.join(c, 'pkg'), path.join(c, 'bin', 'shim'));
      expect(findDeleteBoundaries(c)).toEqual([]);
    });

    // A dangling link points at nothing, so severing it orphans nothing. Refusing here would trip
    // on every stale shim.
    it('ALLOWS a DANGLING nested link', () => {
      const c = mk('dang');
      const gone = mk('gone');
      makeDirLink(gone, path.join(c, 'ptr'));
      fs.rmSync(gone, { recursive: true, force: true });
      expect(findDeleteBoundaries(c)).toEqual([]);
    });

    it('is empty for an ABSENT path — there is nothing for rmSync to get wrong', () => {
      expect(findDeleteBoundaries(path.join(root, 'no-such-thing'))).toEqual([]);
    });

    it('is empty for a plain FILE candidate — no subtree to walk', () => {
      const f = path.join(root, 'a.plist');
      fs.writeFileSync(f, 'x');
      expect(findDeleteBoundaries(f)).toEqual([]);
    });
  });

  // ⚠️ A filesystem root has no parent, so the depth-0 mount comparison cannot run — and an earlier
  // version therefore SKIPPED it and walked in. A root IS a volume, so that is the one candidate
  // this guard must never be silent about: `MODOKI_TOOLCHAIN_DIR=D:\` reaches
  // `clean-packaged-cache.mjs` as a candidate, and a clean report there means a recursive delete of
  // a whole drive. (Found by close-out review, not by the original tests.)
  describe('a filesystem ROOT is reported as a mount, never walked', () => {
    it.each([
      ['a drive root', process.platform === 'win32' ? 'E:\\' : '/'],
      ['a UNC share', '\\\\server\\share'],
    ])('%s', (_label, candidate) => {
      if (_label === 'a UNC share' && process.platform !== 'win32') return; // no UNC off Windows
      const found = findDeleteBoundaries(candidate, {
        lstatSync: () => ({ isSymbolicLink: () => false, isDirectory: () => true, dev: 1 }),
        readdirSync: () => { throw new Error('MUST NOT WALK a filesystem root'); },
        realpathNative: (p: string) => p,
      });
      expect(found.map((b) => b.kind)).toEqual(['mount']);
    });
  });

  describe('refuse — links', () => {
    it('reports a nested link ESCAPING the subtree, naming its target (#990)', () => {
      const c = mk('esc');
      const pay = payload();
      makeDirLink(pay, path.join(c, 'android-sdk'));
      const found = findDeleteBoundaries(c);
      expect(found).toHaveLength(1);
      expect(found[0].kind).toBe('link');
      expect(found[0].path).toBe(path.join(c, 'android-sdk'));
      expect(found[0].target).toBe(pay);
    });

    it('reports the CANDIDATE ITSELF being a link (#883, preserved as the depth-0 case)', () => {
      const pay = payload();
      const link = path.join(root, 'aslink');
      makeDirLink(pay, link);
      expect(findDeleteBoundaries(link)).toEqual([
        { path: link, kind: 'link', target: pay, code: null },
      ]);
    });

    it('reports a DANGLING candidate — existsSync follows links and would skip it silently', () => {
      const gone = mk('vanished');
      const link = path.join(root, 'dangling-candidate');
      makeDirLink(gone, link);
      fs.rmSync(gone, { recursive: true, force: true });
      const found = findDeleteBoundaries(link);
      expect(found).toHaveLength(1);
      expect(found[0].kind).toBe('link');
      expect(found[0].target).toBeNull(); // dangling, and SAID to be
    });

    // ⚠️ Following a link would walk a foreign tree and can loop. The escaping link inside the
    // linked-to directory must NOT be reported, because we never went in — only the link itself is.
    it('does NOT walk INTO a nested link (no following, so no loop)', () => {
      const c = mk('outer');
      const other = mk('other');
      const pay = payload();
      makeDirLink(pay, path.join(other, 'deeper-escape'));
      makeDirLink(other, path.join(c, 'ptr'));
      const found = findDeleteBoundaries(c);
      expect(found).toHaveLength(1);
      expect(found[0].path).toBe(path.join(c, 'ptr'));
    });
  });

  describe('refuse — mounts, via the injected fs surface (runs on every host)', () => {
    // ⚠️ **This fake is paired with the REAL fixture below and is not a substitute for it.** A fake
    // can model behaviour nothing has; the win32 test is what proves a mount reaches these branches
    // on a real filesystem. Do not delete either one as redundant with the other.
    const ROOT_DEV = 1;
    const OTHER_DEV = 2;
    // ⚠️ **Fixture paths are built with `path.join`, never written as POSIX literals.** The walk
    // joins with the platform separator, so a `'/base/cand/mnt'` literal simply never matches on
    // win32 and the fake silently models a DIFFERENT tree than the one being walked — two cases
    // here failed exactly that way, and a fake that quietly misses is worse than one that throws.
    const CAND = path.join(path.sep, 'base', 'cand');
    const under = (...s: string[]) => path.join(CAND, ...s);
    const ELSEWHERE = path.join(path.sep, 'Volumes', 'Ext');
    const dirent = (name: string, o: { link?: boolean; dir?: boolean } = {}) => ({
      name, isSymbolicLink: () => !!o.link, isDirectory: () => o.dir !== false,
    });
    const st = (o: { link?: boolean; dir?: boolean; dev?: number }) => ({
      isSymbolicLink: () => !!o.link, isDirectory: () => o.dir !== false, dev: o.dev ?? ROOT_DEV,
    });

    it('reports the CANDIDATE being a mount root — resolved elsewhere, and not a symlink (#989)', () => {
      const found = findDeleteBoundaries(CAND, {
        lstatSync: () => st({ dev: OTHER_DEV }),
        readdirSync: () => [],
        // The parent resolves to itself; the candidate resolves to a volume root. That mismatch is
        // the signal — NOT `realpath(p) !== p`, which an aliased ancestor also satisfies.
        realpathNative: (p: string) => (p === CAND ? ELSEWHERE : p),
      });
      expect(found).toEqual([{ path: CAND, kind: 'mount', target: ELSEWHERE, code: null }]);
    });

    // ⚠️ Non-recursion is asserted by OBSERVING the readdir calls, not by planting a sentinel entry
    // behind the mount. An earlier version of this fake returned a directory for every unknown
    // path — an infinite filesystem — and the suite HUNG rather than failing. A fake models the
    // dependency; it must not model something no filesystem can be.
    it('reports a NESTED mount and does not recurse into it', () => {
      const readdirs: string[] = [];
      const found = findDeleteBoundaries(CAND, {
        lstatSync: (p: string) => st(p === under('mnt') ? { dev: OTHER_DEV } : {}),
        readdirSync: (p: string) => { readdirs.push(p); return p === CAND ? [dirent('mnt')] : []; },
        realpathNative: (p: string) => p,
      });
      expect(found).toEqual([{ path: under('mnt'), kind: 'mount', target: under('mnt'), code: null }]);
      expect(readdirs).toEqual([CAND]); // never went in
    });

    // The Windows half: a volume mount point is reported as a link by the directory ENUMERATION and
    // as a non-link by `lstat`. That disagreement is the exact detector, with no dev comparison.
    it('reports a nested mount from the Dirent/lstat DISAGREEMENT, with dev identical', () => {
      const found = findDeleteBoundaries(CAND, {
        lstatSync: () => st({ dev: ROOT_DEV }),               // same dev everywhere
        readdirSync: (p: string) => (p === CAND ? [dirent('vol', { link: true })] : []),
        realpathNative: (p: string) => (p === under('vol') ? ELSEWHERE : p),
      });
      expect(found.map((b) => b.kind)).toEqual(['mount']);
    });

    it('a plain FILE is never stat\'d — the walk trusts the Dirent for "not a directory"', () => {
      const statted: string[] = [];
      findDeleteBoundaries(CAND, {
        lstatSync: (p: string) => { statted.push(p); return st({}); },
        readdirSync: (p: string) => (p === CAND ? [dirent('f.txt', { dir: false })] : []),
        realpathNative: (p: string) => p,
      });
      expect(statted).not.toContain(under('f.txt'));
    });

    it('reports an UNREADABLE directory rather than walking past it', () => {
      const found = findDeleteBoundaries(CAND, {
        lstatSync: () => st({}),
        readdirSync: (p: string) => {
          if (p === CAND) return [dirent('locked')];
          const e = new Error('denied') as Error & { code: string }; e.code = 'EACCES'; throw e;
        },
        realpathNative: (p: string) => p,
      });
      expect(found).toEqual([{ path: under('locked'), kind: 'unreadable', target: null, code: 'EACCES' }]);
    });
  });

  // ⚠️ **The real thing.** `mountvol` needs elevation, but `mklink /J <link> \\?\Volume{GUID}\`
  // does not, and writes the SAME `IO_REPARSE_TAG_MOUNT_POINT` reparse point with the same
  // volume-GUID substitute name (`fsutil reparsepoint query`: Microsoft / Name Surrogate / Mount
  // Point). This is what proves the fake above models something that exists. Mounting the temp
  // dir's OWN volume keeps the fixture off any other drive.
  describe.skipIf(process.platform !== 'win32')('refuse — a REAL Windows volume mount point (#989)', () => {
    let volumeGuidPath: string | null = null;
    // ONCE, not per test — it is a cold PowerShell start.
    beforeAll(() => {
      try {
        const drive = path.parse(os.tmpdir()).root.replace(/\\$/, ''); // 'E:'
        volumeGuidPath = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
          `(Get-CimInstance Win32_Volume | Where-Object { $_.DriveLetter -eq '${drive}' }).DeviceID`],
        { encoding: 'utf8', timeout: 30_000 }).trim() || null;
      } catch { volumeGuidPath = null; }
    });

    /** Run `body` with a real volume mount at `<fresh dir>/<name>`.
     *
     *  ⚠️ **This fixture is deliberately OUTSIDE the suite's shared `root`, and it is torn down with
     *  NON-RECURSIVE `rmdir` only.** The shared `afterEach` ends in
     *  `fs.rmSync(root, {recursive: true})`, and a recursive delete over a tree containing a live
     *  volume mount is the exact catastrophe this module exists to prevent — it would walk INTO the
     *  mounted volume and start deleting it. Writing the fixture where that teardown can reach it
     *  puts the whole drive one thrown assertion away from the bug under test. So: own directory,
     *  unmount first, then `rmdirSync` the empty shells one at a time. Never add a `recursive: true`
     *  to this teardown.
     *
     *  The mount is of the temp dir's OWN volume, so no other drive is ever involved. */
    const withMount = (name: string, body: (mountPath: string, base: string) => void) => {
      expect(volumeGuidPath, 'could not read the volume GUID — cannot build the fixture').toBeTruthy();
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'db-mnt-'));
      const mountPath = path.join(base, name);
      fs.mkdirSync(path.dirname(mountPath), { recursive: true });
      // `mklink` is a cmd builtin, so it needs cmd rather than a direct spawn. A junction whose
      // substitute name is a volume GUID path IS a volume mount point — the same
      // IO_REPARSE_TAG_MOUNT_POINT `mountvol` writes, but without needing elevation.
      execFileSync('cmd', ['/c', 'mklink', '/J', mountPath, volumeGuidPath!], { stdio: 'pipe' });
      try {
        body(mountPath, base);
      } finally {
        // `rmdir` removes the reparse point WITHOUT touching what it points at — this family's own
        // mechanism, used deliberately.
        execFileSync('cmd', ['/c', 'rmdir', mountPath], { stdio: 'pipe' });
        expect(fs.existsSync(mountPath), 'mount NOT torn down — refusing to leave it').toBe(false);
        for (let d = path.dirname(mountPath); d.startsWith(base); d = path.dirname(d)) fs.rmdirSync(d);
      }
    };

    it("lstat does NOT see it as a symlink, so #883's predicate alone would miss it", () => {
      withMount('atroot', (m, base) => {
        expect(fs.lstatSync(m).isSymbolicLink()).toBe(false);
        // …and the Dirent DISAGREES with it, which is what the nested branch keys on.
        const ent = fs.readdirSync(base, { withFileTypes: true }).find((e) => e.name === 'atroot')!;
        expect(ent.isSymbolicLink()).toBe(true);
      });
    });

    it('is reported as a MOUNT at the candidate, not as a link', () => {
      withMount('atroot', (m) => {
        const found = findDeleteBoundaries(m);
        expect(found.map((b) => b.kind)).toEqual(['mount']);
        expect(describeBoundary(found[0])).toContain('MOUNTED VOLUME');
      });
    });

    it('is reported as a MOUNT when NESTED, with the mount remedy rather than the link one', () => {
      withMount(path.join('cand', 'vol'), (m, base) => {
        const found = findDeleteBoundaries(path.join(base, 'cand'));
        expect(found.map((b) => b.kind)).toEqual(['mount']);
        expect(found[0].path).toBe(m);
        // The regression this case exists for: it was classified `link` — refusing correctly, but
        // telling the reader to "remove the link", which does nothing to a mounted volume (#989).
        expect(describeBoundary(found[0])).not.toContain('remove the link');
      });
    });
  });

  describe('describeBoundary — three kinds, three remedies (#989)', () => {
    it('never gives a mount the link wording', () => {
      const s = describeBoundary({ path: '/p', kind: 'mount', target: '/Volumes/Ext', code: null });
      expect(s).toContain('MOUNTED VOLUME');
      expect(s).not.toContain('remove the link');
    });

    it('says a dangling link resolves to nothing rather than printing "null"', () => {
      expect(describeBoundary({ path: '/p', kind: 'link', target: null, code: null })).toContain('DANGLING');
    });

    it('claims nothing about an unreadable path beyond the code', () => {
      const s = describeBoundary({ path: '/p', kind: 'unreadable', target: null, code: 'EACCES' });
      expect(s).toContain('EACCES');
      expect(s).toContain('may well exist');
    });
  });
});

/** #1006 close-out — the sweep's OWN residue. #1006 sized the population at two user-owned
 *  delete sites and fixed both; this pass's re-sweep found two more of the same mechanism inside
 *  `engine/toolchain/`, one line away from a staging directory, which is how the original sweep
 *  missed them: `androidSdkProvision` and `wdaProvision` each `rmSync` a PERSISTENT destination
 *  and then rename a fresh extract into its place.
 *
 *  ⚠️ A source guard, and the reason is worth stating rather than defaulting to: driving these
 *  behaviourally means running a real provision (a network download, an archive extract, minutes),
 *  and the DECISION under test is one line — "does the replace consult the shared walk first". The
 *  walk's own behaviour is covered exhaustively above, including the accept side. What could still
 *  regress is a future edit dropping the call, which is exactly what this sees. */
describe('every persistent-destination REPLACE in engine/toolchain consults the walk first (#1006)', () => {
  const SITES = [
    { file: 'androidSdkProvision.ts', dest: 'latest' },
    { file: 'wdaProvision.ts', dest: 'srcDir' },
  ];

  // Own fixture: the suite's `root`/`mk`/`payload` belong to the describe above.
  let gRoot: string;
  beforeEach(() => { gRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-'))); });
  afterEach(() => { try { fs.rmSync(gRoot, { recursive: true, force: true }); } catch { /* fixture */ } });

  it.each(SITES)('$file guards its rmSync of $dest', ({ file, dest }) => {
    const { code } = readScannedSource(path.resolve(__dirname, '../../toolchain', file));
    const lines = code.split('\n');
    const i = lines.findIndex((l) => l.includes(`fs.rmSync(${dest}, { recursive: true`));
    expect(i, `no recursive rmSync of \`${dest}\` found in ${file} — fix the parser, not the test`)
      .toBeGreaterThan(-1);
    // The pre-flight must run BEFORE the delete, not merely exist somewhere in the file.
    const before = lines.slice(Math.max(0, i - 5), i).join('\n');
    expect(before, `${file} deletes ${dest} without the #883 pre-flight immediately before it`)
      .toMatch(/refuseUnsafeReplace\(/);
  });

  it('shares ONE policy rather than pasting it — and that policy REFUSES', () => {
    // ⚠️ close-out § 1a ②: the first version of this fix put the same ~10 lines in both files,
    // which is a missing helper wearing a fix's clothes. Detection was already shared
    // (`deleteBoundary.mjs`); this pins that the REFUSAL is too, and that it throws — a
    // warn-and-delete would still sever the link, which is the whole defect.
    for (const { file } of SITES) {
      const { code } = readScannedSource(path.resolve(__dirname, '../../toolchain', file));
      expect(code, `${file} must import the shared guard, not re-declare it`)
        .toMatch(/import \{ refuseUnsafeReplace \} from '\.\/replaceGuard'/);
      expect(code).not.toMatch(/function refuseUnsafeReplace/);
    }
    const { code: guard } = readScannedSource(path.resolve(__dirname, '../../toolchain/replaceGuard.ts'));
    expect(guard).toMatch(/export function refuseUnsafeReplace/);
    expect(guard, 'the pre-flight must THROW — a warn-and-delete still severs the link')
      .toMatch(/throw new Error\(/);
  });

  it('the shared guard ACCEPTS a self-contained dir and REFUSES a link out of it', () => {
    // The behavioural half — the source guards above only pin that the call happens.
    // ⚠️ The ACCEPT side first, and it is the load-bearing one: every real provision destination
    // is a plain extracted tree, so a guard that refused them would break provisioning outright.
    const dest = path.join(gRoot, 'provision-dest');
    fs.mkdirSync(path.join(dest, 'inner'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'inner', 'tool'), 'x');
    expect(() => refuseUnsafeReplace(dest)).not.toThrow();
    expect(() => refuseUnsafeReplace(path.join(gRoot, 'no-such-dest'))).not.toThrow();  // absent is safe

    const elsewhere = path.join(gRoot, 'big-sdk-on-another-drive');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.writeFileSync(path.join(elsewhere, 'payload.bin'), 'x');
    const linked = path.join(gRoot, 'linked-dest');
    makeDirLink(elsewhere, linked);
    expect(() => refuseUnsafeReplace(linked)).toThrow(/not self-contained/);
    expect(fs.existsSync(path.join(elsewhere, 'payload.bin'))).toBe(true);
  });
});

/** `toolchainRootRefusal` — "is this directory OURS to delete?" (#1005).
 *
 *  ⚠️ **A direct table test of the predicate, because the two callers cannot reach all of its
 *  edges.** It was written first with cover only through `uninstallAll()` and
 *  `clean-packaged-cache.mjs`, and the case that slipped through was found by review, not by either
 *  of them: a plain FILE handed in as `MODOKI_TOOLCHAIN_DIR` was ACCEPTED and deleted (see the
 *  `not-a-directory` cases below). The caller-level suites drive the seam; this one drives the
 *  decision.
 *
 *  ⚠️ This predicate is NOT the delete-boundary walk and neither subsumes the other
 *  (`engine/scripts/deleteBoundary.mjs`): that one asks "would a recursive delete MISREPORT this
 *  subtree?" — links, mounts, drive roots — and this one asks "is this a toolchain at all?". Both
 *  run at both delete sites. See docs/editor-toolchain.md § Removing tools.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  toolchainRootRefusal,
  describeToolchainRootRefusal,
  TOOLCHAIN_OWNED_ENTRIES,
} from '../../scripts/toolchainRoot.mjs';

describe('toolchainRootRefusal (#1005)', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'tcroot-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const dirWith = (name: string, entries: string[]): string => {
    const d = path.join(root, name);
    fs.mkdirSync(d, { recursive: true });
    for (const e of entries) {
      if (e.includes('.')) fs.writeFileSync(path.join(d, e), 'x');
      else fs.mkdirSync(path.join(d, e), { recursive: true });
    }
    return d;
  };

  describe('accepts — the half that proving a refusal says nothing about', () => {
    it('a real toolchain layout, whatever the directory is NAMED', () => {
      // The reported symptom: this clone's override is named `modoki-toolchain`, and the guard this
      // replaced rejected it purely on that.
      for (const name of ['toolchain', 'modoki-toolchain', 'dev-cache', 'tc']) {
        const d = dirWith(name, ['node', 'jdk', 'android-sdk', 'npm-tools', 'settings.json']);
        expect(toolchainRootRefusal(d), name).toBeNull();
      }
    });

    it('every owned entry ALONE — no single one of them reads as foreign', () => {
      for (const owned of TOOLCHAIN_OWNED_ENTRIES) {
        const d = dirWith(`solo-${owned.replace('.', '_')}`, [owned]);
        expect(toolchainRootRefusal(d), owned).toBeNull();
      }
    });

    it('an empty dir — nothing to orphan', () => {
      expect(toolchainRootRefusal(dirWith('empty', []))).toBeNull();
    });

    it('a dir that does not exist — absence is not evidence of a foreign directory', () => {
      expect(toolchainRootRefusal(path.join(root, 'nope'))).toBeNull();
    });

    it('OS junk only — a root Explorer or Finder has rendered stays removable', () => {
      expect(toolchainRootRefusal(dirWith('junk', ['.DS_Store', 'Thumbs.db', 'desktop.ini']))).toBeNull();
    });
  });

  describe('refuses', () => {
    it('a home-shaped directory, naming what it found', () => {
      const d = dirWith('home-ish', ['Documents', 'Desktop', 'node']);
      const r = toolchainRootRefusal(d);
      expect(r?.kind).toBe('foreign');
      expect([...(r?.entries ?? [])].sort()).toEqual(['Desktop', 'Documents']); // order is describe()'s job
      expect(describeToolchainRootRefusal(d, r!)).toContain('Documents');
    });

    it('a dir NAMED "toolchain" that holds foreign entries — the direction the old guard passed', () => {
      const r = toolchainRootRefusal(dirWith('toolchain', ['Pictures']));
      expect(r?.kind).toBe('foreign');
    });

    // ⚠️ **The case review found, and the reason this file exists.** `readdirSync` on a file throws
    // ENOTDIR; the first version caught that and returned "no foreign entries", i.e. ACCEPT — and
    // `findDeleteBoundaries` does not backstop it (`if (!rootStat.isDirectory()) return out`, a file
    // has no subtree). Measured end to end before the fix: `unexpectedEntries = []`,
    // `boundaries = []`, and `rmSync` deleted the file. The `basename` guard this all replaced would
    // have REJECTED it, so the rewrite had swapped a false-reject for a false-ACCEPT on a
    // destructive path.
    it('a plain FILE — not a directory at all', () => {
      const f = path.join(root, 'notes.txt');
      fs.writeFileSync(f, 'the users notes');
      const r = toolchainRootRefusal(f);
      expect(r?.kind).toBe('not-a-directory');
      expect(describeToolchainRootRefusal(f, r!)).toContain('not a directory');
    });

    it('a file NAMED "toolchain" — the name never enters into it, in either direction', () => {
      const f = path.join(root, 'toolchain');
      fs.writeFileSync(f, 'x');
      expect(toolchainRootRefusal(f)?.kind).toBe('not-a-directory');
    });
  });

  describe('the message', () => {
    // ⚠️ **Driven with a HAND-BUILT refusal, not one the predicate produced, and that is the whole
    // point.** The ordering assertion used to run against a real directory and compare the entries
    // to their own sort — which cannot fail on NTFS, where `readdir` already returns sorted names.
    // Measured: deleting the `.sort()` left that test GREEN. Presentation order therefore lives in
    // this function, where an unsorted input can be handed straight in.
    const refusal = (entries: string[]) => ({ kind: 'foreign' as const, entries });

    it('names entries in SORTED order, whatever order it was given them in', () => {
      const msg = describeToolchainRootRefusal('/tmp/not-a-toolchain', refusal(['zeta', 'alpha', 'Mike']));
      expect(msg).toContain('Mike, alpha, zeta');
    });

    it('truncates to eight — and to the FIRST eight by sort, not by arrival', () => {
      const msg = describeToolchainRootRefusal('/tmp/not-a-toolchain', refusal(
        ['z9', 'z8', 'z7', 'z6', 'z5', 'z4', 'z3', 'z2', 'z1', 'z0'],
      ));
      expect(msg).toContain('10 entries');
      expect(msg).toContain('z0, z1, z2, z3, z4, z5, z6, z7');
      expect(msg).not.toContain('z8');
      expect(msg).toContain('…');
    });

    it('singular/plural agree, so the sentence reads', () => {
      expect(describeToolchainRootRefusal('/tmp/not-a-toolchain', refusal(['Documents']))).toContain('1 entry the');
    });

    it('says something different for a file — the two kinds must not share wording', () => {
      const f = describeToolchainRootRefusal('/tmp/not-a-toolchain', { kind: 'not-a-directory', entries: [] });
      expect(f).toContain('not a directory');
      expect(f).not.toContain('does not look like');
    });

    // ⚠️ **Never tells the user to delete the subject.** The realistic subject is a home directory
    // or a repo root. `deleteBoundary.mjs` records what a careless remedy line already cost here:
    // #883's text "lost a user their provision AND left them still blocked".
    it('does NOT instruct the user to remove the directory it just refused', () => {
      for (const msg of [
        describeToolchainRootRefusal('/tmp/not-a-toolchain', refusal(['Documents'])),
        describeToolchainRootRefusal('/tmp/not-a-toolchain', { kind: 'not-a-directory', entries: [] }),
      ]) {
        expect(msg).not.toMatch(/remove it by hand|delete it by hand/i);
        expect(msg).toContain('MODOKI_TOOLCHAIN_DIR');
      }
    });
  });
});

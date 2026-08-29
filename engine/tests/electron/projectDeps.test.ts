/** Unit: `composeDepsInstallError` — what a failed dependency install actually TELLS you.
 *
 *  This is a diagnosability guard, not a behaviour guard: the install fails either way. It
 *  exists because the un-composed version shipped and cost a real user (and their agent) a
 *  long session — the dialog said only "npm install exited with code 1" while the true cause
 *  (a 120s plugin-vendoring timeout on a read-only Program Files install) sat unread in
 *  main.log. They chased npm, the registry, and a phantom stale process first.
 *
 *  The causal link is not a guess: vendoring is what rewrites an engine plugin's dep from
 *  the placeholder `"*"` to `file:plugins/<name>-<hash>.tgz`, and those plugins are not on
 *  the public npm registry — so if vendoring threw, the install CANNOT succeed. */

import { describe, it, expect } from 'vitest';
import { composeDepsInstallError, hasStaleWorkspaceLink, type WorkspaceLinkFs } from '../../electron/projectDeps';

const VENDOR_ERR = '[vendor] timed out waiting for a concurrent build of capacitor-game-debug dist';

describe('composeDepsInstallError', () => {
  it('names the vendoring failure as the cause, keeping the install error first', () => {
    const out = composeDepsInstallError(new Error('npm install exited with code 1'), VENDOR_ERR);
    // The install failure stays the headline (it's what the user's action produced)…
    expect(out.message.startsWith('npm install exited with code 1')).toBe(true);
    // …but the actual cause is now IN the message, not just in main.log.
    expect(out.message).toContain(VENDOR_ERR);
    expect(out.message).toMatch(/CONSEQUENCE/);
  });

  it('leaves a genuine install failure untouched when vendoring succeeded', () => {
    // Guards the inverse mistake: blaming vendoring for an unrelated npm failure (offline,
    // a bad user dependency) would be its own misdirection. Same Error identity, so the
    // original stack survives for a real npm fault.
    const original = new Error('npm install exited with code 1');
    const out = composeDepsInstallError(original, null);
    expect(out).toBe(original);
    expect(out.message).not.toMatch(/CONSEQUENCE/);
  });

  it('handles a non-Error throw without producing "[object Object]"', () => {
    // runNpm/spawn paths can reject with a non-Error; the dialog must stay readable.
    const out = composeDepsInstallError({ code: 'EPERM' }, VENDOR_ERR);
    expect(out).toBeInstanceOf(Error);
    expect(out.message).toContain(VENDOR_ERR);
    const out2 = composeDepsInstallError('spawn ENOENT', null);
    expect(out2).toBeInstanceOf(Error);
    expect(out2.message).toBe('spawn ENOENT');
  });
});

/** Unit: `hasStaleWorkspaceLink` — catches the class ensureProjectDeps' bare
 *  `!existsSync(node_modules)` check misses: node_modules exists overall, but one of the
 *  project's OWN workspace packages (games/court's `capacitor-applovin-max`, concretely) isn't
 *  linked inside it, and nothing in the editor's on-open heal ever re-ran `npm install` to
 *  fix it — only the repo-ROOT `bootstrap-game-deps.mjs` postinstall had that fix (for #215, a
 *  STALE REGULAR dependency — a different concrete symptom of the same "don't trust
 *  node_modules existing" posture this ports), and only a human/agent running `npm install` at
 *  the root reaches it. */

type FakeEntry = string | { name: string; isDir: boolean };

function fakeFs(opts: {
  dirs?: Record<string, FakeEntry[]>;
  files?: Record<string, string>;
  present?: Iterable<string>;
}): WorkspaceLinkFs {
  const dirs = opts.dirs ?? {};
  const files = opts.files ?? {};
  const present = new Set(opts.present ?? []);
  return {
    readdirSync(dir) {
      const names = dirs[dir];
      if (!names) throw new Error(`ENOENT: ${dir}`);
      return names.map((e) =>
        typeof e === 'string' ? { name: e, isDirectory: () => true } : { name: e.name, isDirectory: () => e.isDir },
      );
    },
    readFileSync(file) {
      const content = files[file];
      if (content === undefined) throw new Error(`ENOENT: ${file}`);
      return content;
    },
    existsSync: (p) => present.has(p),
  };
}

describe('hasStaleWorkspaceLink', () => {
  const pkg = (workspaces: unknown) => ({ workspaces });

  it('is true when one workspace package is missing from node_modules — the court/capacitor-applovin-max repro', () => {
    const fs = fakeFs({
      dirs: { '/proj/packages': ['app-services', 'capacitor-applovin-max'] },
      files: {
        '/proj/packages/app-services/package.json': '{"name":"@court/app-services"}',
        '/proj/packages/capacitor-applovin-max/package.json': '{"name":"capacitor-applovin-max"}',
      },
      // app-services is linked; capacitor-applovin-max is not — the exact repro.
      present: ['/proj/node_modules/@court/app-services'],
    });
    expect(hasStaleWorkspaceLink('/proj', pkg(['packages/*']), fs)).toBe(true);
  });

  it('is false when every workspace package is linked', () => {
    const fs = fakeFs({
      dirs: { '/proj/packages': ['app-services', 'capacitor-applovin-max'] },
      files: {
        '/proj/packages/app-services/package.json': '{"name":"@court/app-services"}',
        '/proj/packages/capacitor-applovin-max/package.json': '{"name":"capacitor-applovin-max"}',
      },
      present: ['/proj/node_modules/@court/app-services', '/proj/node_modules/capacitor-applovin-max'],
    });
    expect(hasStaleWorkspaceLink('/proj', pkg(['packages/*']), fs)).toBe(false);
  });

  it('is false when the project has no workspaces field', () => {
    const fs = fakeFs({});
    expect(hasStaleWorkspaceLink('/proj', pkg(undefined), fs)).toBe(false);
  });

  it('does not throw and treats it as satisfied when the workspaces dir does not exist yet', () => {
    const fs = fakeFs({});
    expect(hasStaleWorkspaceLink('/proj', pkg(['packages/*']), fs)).toBe(false);
  });

  it('skips a workspace entry with no readable package.json rather than throwing', () => {
    const fs = fakeFs({
      dirs: { '/proj/packages': ['scratch-dir'] },
      // no package.json entry for scratch-dir/package.json
    });
    expect(hasStaleWorkspaceLink('/proj', pkg(['packages/*']), fs)).toBe(false);
  });

  it('skips a glob shape other than the single-level "dir/*" this repo actually uses', () => {
    const fs = fakeFs({
      dirs: { '/proj/packages': ['capacitor-applovin-max'] },
      files: { '/proj/packages/capacitor-applovin-max/package.json': '{"name":"capacitor-applovin-max"}' },
      present: [], // would report stale if the literal-path glob were followed
    });
    expect(hasStaleWorkspaceLink('/proj', pkg(['packages/capacitor-applovin-max']), fs)).toBe(false);
    expect(hasStaleWorkspaceLink('/proj', pkg(['packages/**']), fs)).toBe(false);
  });

  it('skips a non-directory entry under the workspace glob', () => {
    const fs = fakeFs({
      // README.md sits beside the real package dirs — a plain readdir would try (and fail) to
      // read README.md/package.json if the isDirectory() filter were ever dropped.
      dirs: { '/proj/packages': [{ name: 'README.md', isDir: false }, 'capacitor-applovin-max'] },
      files: { '/proj/packages/capacitor-applovin-max/package.json': '{"name":"capacitor-applovin-max"}' },
      present: [], // capacitor-applovin-max is NOT linked — must still report stale
    });
    expect(hasStaleWorkspaceLink('/proj', pkg(['packages/*']), fs)).toBe(true);
  });

  it('skips a dot-prefixed directory — npm\'s own glob does not match dotfiles either', () => {
    const fs = fakeFs({
      dirs: { '/proj/packages': ['.archive'] },
      files: { '/proj/packages/.archive/package.json': '{"name":"old-archived-plugin"}' },
      present: [], // never linked, and never SHOULD be — npm never resolved it as a member
    });
    expect(hasStaleWorkspaceLink('/proj', pkg(['packages/*']), fs)).toBe(false);
  });

  it('bails out entirely on a negation pattern rather than looping stale forever', () => {
    // packages/experimental is explicitly EXCLUDED from workspace resolution by the `!` entry —
    // npm will never link it, so treating it as "expected" would report stale=true on every
    // future open no matter how many times `npm install` runs. Bailing out (false) is the safe
    // read: it just falls back to the plain node_modules-existence check, same as an
    // unrecognized glob shape.
    const fs = fakeFs({
      dirs: { '/proj/packages': ['experimental'] },
      files: { '/proj/packages/experimental/package.json': '{"name":"experimental-plugin"}' },
      present: [], // would report stale forever if the negation were ignored
    });
    expect(hasStaleWorkspaceLink('/proj', pkg(['packages/*', '!packages/experimental']), fs)).toBe(false);
  });
});

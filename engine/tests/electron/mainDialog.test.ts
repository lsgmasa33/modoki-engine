/** mainDialog — the one parenting rule for main-process native dialogs (#1044).
 *
 *  Two halves, and the second is the one that keeps this fixed. The unit tests below pin the
 *  resolver's decisions; the SOURCE GUARD at the bottom is what stops a twelfth site being added
 *  parentless — which is exactly how this bug happened, with the correct helper sitting in the
 *  same file as three calls that bypassed it. Same source-guard shape as `fatalDialog.test.ts`,
 *  `quitExitCode.test.ts` and `reapScoping.test.ts`, and for the same reason: the entry point has
 *  no harness, so the pattern is checked in the SOURCE. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type FakeWin = { destroyed: boolean; visible: boolean; tag: string; isDestroyed: () => boolean; isVisible: () => boolean };
let windows: FakeWin[] = [];
let splash: FakeWin | null = null;
const showMessageBoxSpy = vi.fn(() => Promise.resolve({ response: 0, checkboxChecked: false }));
const showOpenDialogSpy = vi.fn(() => Promise.resolve({ canceled: true, filePaths: [] }));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => windows },
  dialog: {
    showMessageBox: (...a: unknown[]) => showMessageBoxSpy(...(a as [])),
    showOpenDialog: (...a: unknown[]) => showOpenDialogSpy(...(a as [])),
  },
}));
vi.mock('../../electron/splash', () => ({ isSplashWindow: (w: unknown) => w != null && w === splash }));

const mkWin = (tag: string, opts: Partial<FakeWin> = {}): FakeWin => {
  const w: FakeWin = {
    tag, destroyed: false, visible: true,
    isDestroyed: () => w.destroyed, isVisible: () => w.visible, ...opts,
  };
  return w;
};

async function fresh() {
  vi.resetModules();
  windows = []; splash = null;
  showMessageBoxSpy.mockClear(); showOpenDialogSpy.mockClear();
  return import('../../electron/mainDialog');
}

describe('resolveDialogParent', () => {
  beforeEach(() => { windows = []; splash = null; });

  it('returns null when there are no windows at all', async () => {
    const { resolveDialogParent } = await fresh();
    expect(resolveDialogParent('visibleNonSplash')).toBeNull();
    expect(resolveDialogParent('anyWindow')).toBeNull();
  });

  it("visibleNonSplash refuses the SPLASH — an open sheet dies with it, unanswered", async () => {
    const { resolveDialogParent } = await fresh();
    const s = mkWin('splash'); splash = s; windows = [s];
    expect(resolveDialogParent('visibleNonSplash')).toBeNull();
  });

  it('anyWindow ACCEPTS the splash — it only needs "not app-modal", and terminates on its own timer', async () => {
    const { resolveDialogParent } = await fresh();
    const s = mkWin('splash'); splash = s; windows = [s];
    expect(resolveDialogParent('anyWindow')).toBe(s);
  });

  it('visibleNonSplash refuses the still-HIDDEN editor window and picks the visible one', async () => {
    const { resolveDialogParent } = await fresh();
    const hidden = mkWin('hidden', { visible: false });
    const shown = mkWin('shown');
    windows = [hidden, shown];
    expect(resolveDialogParent('visibleNonSplash')).toBe(shown);
  });

  it('skips a DESTROYED window under BOTH policies', async () => {
    const { resolveDialogParent } = await fresh();
    const dead = mkWin('dead', { destroyed: true });
    const live = mkWin('live');
    windows = [dead, live];
    expect(resolveDialogParent('anyWindow')).toBe(live);
    expect(resolveDialogParent('visibleNonSplash')).toBe(live);
  });

  /** ⚠️ The ORDER of the two filters is the mechanism, not a detail: `isVisible()` THROWS on a
   *  destroyed window, so probing visibility before liveness turns a dialog into an exception.
   *  `autoUpdate.ts`'s `show()` had exactly that shape. Swap the filters in the source and this
   *  is the test that goes red. */
  it('does not call isVisible on a destroyed window (it throws there)', async () => {
    const { resolveDialogParent } = await fresh();
    const dead = mkWin('dead', { destroyed: true });
    dead.isVisible = () => { throw new Error('Object has been destroyed'); };
    windows = [dead, mkWin('live')];
    expect(() => resolveDialogParent('visibleNonSplash')).not.toThrow();
  });
});

describe('showMessageBox / showOpenDialog — parent when we can', () => {
  beforeEach(() => { windows = []; splash = null; });

  it('PARENTS to a visible window rather than going free-floating (the #1044 defect)', async () => {
    const { showMessageBox } = await fresh();
    const win = mkWin('editor'); windows = [win];
    await showMessageBox({ message: 'hi' });
    expect(showMessageBoxSpy).toHaveBeenCalledWith(win, { message: 'hi' });
  });

  it('falls back to a parentless box ONLY when there is genuinely no window', async () => {
    const { showMessageBox } = await fresh();
    await showMessageBox({ message: 'hi' });
    expect(showMessageBoxSpy).toHaveBeenCalledWith({ message: 'hi' });
  });

  it('an EXPLICIT parent wins over the policy', async () => {
    const { showMessageBox } = await fresh();
    const resolved = mkWin('resolved'); const explicit = mkWin('explicit');
    windows = [resolved];
    await showMessageBox({ message: 'hi' }, explicit as unknown as Electron.BrowserWindow);
    expect(showMessageBoxSpy).toHaveBeenCalledWith(explicit, { message: 'hi' });
  });

  /** The old call sites spelled this `mainWindow ? show(mainWindow, o) : show(o)`, so a null
   *  `mainWindow` went straight to parentless without ever looking for another window. */
  it('a NULL explicit parent resolves through the policy instead of going parentless', async () => {
    const { showMessageBox } = await fresh();
    const win = mkWin('editor'); windows = [win];
    await showMessageBox({ message: 'hi' }, null);
    expect(showMessageBoxSpy).toHaveBeenCalledWith(win, { message: 'hi' });
  });

  /** ⚠️ A caller's own handle is not a guarantee of liveness. `main.ts` nulls `mainWindow` on the
   *  window's `'closed'` event, but `win.destroy()` flips `isDestroyed()` BEFORE `closed`
   *  dispatches — so there is a window in which `mainWindow` is non-null and destroyed. Passing it
   *  straight through throws `Object has been destroyed`, which `healConnectedMcp` swallows (no
   *  dialog at all, the #1032 shape) and which escapes `setProject`, skipping its `return` and
   *  leaving the project half-swapped. */
  it('a DESTROYED explicit parent falls back to the resolver instead of throwing', async () => {
    const { showMessageBox } = await fresh();
    const dead = mkWin('dead', { destroyed: true });
    const live = mkWin('live');
    windows = [live];
    await showMessageBox({ message: 'hi' }, dead as unknown as Electron.BrowserWindow);
    expect(showMessageBoxSpy).toHaveBeenCalledWith(live, { message: 'hi' });
  });

  it('a destroyed explicit parent with NO other window goes parentless, still without throwing', async () => {
    const { showMessageBox } = await fresh();
    const dead = mkWin('dead', { destroyed: true });
    await expect(showMessageBox({ message: 'hi' }, dead as unknown as Electron.BrowserWindow)).resolves.toBeDefined();
    expect(showMessageBoxSpy).toHaveBeenCalledWith({ message: 'hi' });
  });

  it('showOpenDialog follows the same rule — the pickers run the same modal loop', async () => {
    const { showOpenDialog } = await fresh();
    const win = mkWin('editor'); windows = [win];
    await showOpenDialog({ properties: ['openDirectory'] });
    expect(showOpenDialogSpy).toHaveBeenCalledWith(win, { properties: ['openDirectory'] });
  });
});

/** ── The guard ────────────────────────────────────────────────────────────────────────────────
 *  #1044 was not "somebody forgot a parent once". `autoUpdate.ts` contained the CORRECT helper
 *  and three calls that bypassed it, in the same file, for months. A unit test on the helper
 *  cannot fail on that: the helper was right. So the invariant that actually matters is
 *  structural — **the only module allowed to name `dialog.show*` is the one that owns the rule.**
 *
 *  ⚠️ Derived from the directory, not a hand-listed set of files, so a module added tomorrow is
 *  covered without anybody remembering this test exists — the same reason `fatalDialog.test.ts`
 *  builds its corpus that way.
 *
 *  ⚠️ Reads through `readScannedSource`, which strips comments (#812): a source guard that
 *  matched raw text could be satisfied — or hidden — by a mention in a docblock, and
 *  `fatalDialog.ts` legitimately discusses `dialog.showErrorBox` in prose. */
import { readScannedSource } from '@modoki/engine/testing';
import * as nodePath from 'node:path';
import { readdirSync } from 'node:fs';

describe('every main-process dialog goes through mainDialog (#1044)', () => {
  const dir = nodePath.resolve(__dirname, '../../electron');
  const OWNER = 'mainDialog.ts';
  // ⚠️ RECURSIVE. A one-level `readdirSync` would leave `engine/electron/dialogs/prompts.ts`
  // unscanned the day somebody adds it — and this file's whole job is to cover the site nobody
  // remembered. `dist/` holds the built bundle, which legitimately contains everything.
  const files = readdirSync(dir, { recursive: true })
    .map((f) => String(f))
    .filter((f) => f.endsWith('.ts') && !f.split(nodePath.sep).includes('dist') && f !== OWNER);

  it('scans a non-trivial number of electron modules (the corpus is not silently empty)', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  /** The owner must actually contain the calls, or the ban above is vacuous — every other file
   *  could be clean because nothing anywhere opens a dialog at all. */
  it('the owning module DOES call the real electron dialog (the ban is not vacuous)', () => {
    const { code } = readScannedSource(nodePath.join(dir, OWNER));
    expect([...code.matchAll(/\bdialog\.(showMessageBox|showOpenDialog)\b/g)].length).toBeGreaterThanOrEqual(2);
  });

  /** ⚠️ **Bans the IMPORT, not the member access — and that is the whole point.**
   *
   *  The first version of this guard matched `/\bdialog\.(show[A-Za-z]*)\b/` in the source. Review
   *  broke it in one word: `import { dialog as __d } from 'electron'` and either `__d.showMessageBox({…})`
   *  or a destructured `const { showMessageBox } = __d` sails straight past a regex bound to the
   *  literal identifier `dialog`. The real #1044 defect was then put BACK at autoUpdate.ts's error
   *  handler through an aliased import and the entire electron suite — 1072 tests — stayed green.
   *
   *  Banning the specifier is unspoofable by renaming, because the rename is IN the specifier: to
   *  reach `dialog.anything` a module must first name `dialog` in an import from 'electron', and
   *  that is what this matches. `import * as electron` would evade it; nothing in this tree does
   *  that, and `mainBundleExternals`-style namespace imports of 'electron' would be a far louder
   *  change than the alias this actually caught. */
  it.each(files)('%s does not import `dialog` from electron', (file) => {
    const { code } = readScannedSource(nodePath.join(dir, file));
    const specifiers = [...code.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]electron['"]/g)]
      .flatMap((m) => m[1].split(',').map((x) => x.trim().split(/\s+as\s+/)[0].trim()));
    expect(
      specifiers.filter((n) => n === 'dialog'),
      `${file}: a parentless native dialog is APP-MODAL on macOS and blocks the whole main ` +
        'process — no timers, no IPC, no backend (#1044). Import showMessageBox/showOpenDialog ' +
        `from './mainDialog', which parents to a real window whenever one exists.`,
    ).toEqual([]);
  });

  /** The specifier ban has exactly one escape: `import * as electron from 'electron'`, which
   *  never names `dialog` in the import at all. So ban that too, rather than trying to spot
   *  `something.showMessageBox(` in the body — a member-call regex cannot tell electron's `dialog`
   *  from `fatalDialog.ts`'s INJECTED `deps.showMessageBox`, and an earlier draft of this test duly
   *  failed on the one module that is doing the right thing. Nothing in this tree namespace-imports
   *  electron today; this keeps it that way. */
  it.each(files)('%s does not namespace-import electron (the specifier ban\'s one escape)', (file) => {
    const { code } = readScannedSource(nodePath.join(dir, file));
    expect(
      [...code.matchAll(/import\s+\*\s+as\s+(\w+)\s+from\s*['"]electron['"]/g)].map((m) => m[1]),
      `${file}: a namespace import of electron reaches dialog.* without ever naming it, which is `
        + 'the one thing the specifier ban above cannot see (#1044). Import the members you need.',
    ).toEqual([]);
  });
});

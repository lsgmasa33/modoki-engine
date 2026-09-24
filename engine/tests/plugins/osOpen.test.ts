/** Unit tests for the platform branches of `osOpen` — the module the editor's
 *  "open in default app" and "Reveal in Finder" routes go through.
 *
 *  The module's docblock has claimed since it was written that it exists "so the
 *  platform branch is unit-testable without mocking a node builtin", and nothing
 *  ever took that up: the only test that touched it (`openFileRouter.test.ts`)
 *  mocks the WHOLE module away and asserts on a stand-in that always succeeds. So
 *  a win32 branch that failed 100% of the time on a real Windows box sat green for
 *  months (#1508, #1515).
 *
 *  ⚠️ These tests drive a FAKE child process, so they can only pin the SHAPE of
 *  the contract (resolve on spawn, never on exit). What Windows' real launchers
 *  actually do is measured in `osOpenWin32.test.ts`, which runs no mocks — that is
 *  the test that would have caught the bug, and it is why this file is not enough
 *  on its own. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

const spawnMock = vi.hoisted(() => vi.fn());
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ spawn: spawnMock, execFile: execFileMock }));

import { openInOS, revealInOS } from '../../plugins/backend/osOpen';

/** A child that has started and simply never ends — a GUI launcher sitting on a
 *  modal dialog, which is exactly #1515's hang. */
class FakeChild extends EventEmitter {
  unref = vi.fn();
}

const REAL_PLATFORM = process.platform;
function setPlatform(value: string) {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

/** Hand the next `spawn()` a child, and return it so the test can drive its events. */
function nextChild(): FakeChild {
  const child = new FakeChild();
  spawnMock.mockReturnValueOnce(child);
  return child;
}

beforeEach(() => {
  spawnMock.mockReset();
  execFileMock.mockReset();
});
afterEach(() => setPlatform(REAL_PLATFORM));

describe('win32 — the launcher is not awaited (#1508, #1515)', () => {
  beforeEach(() => setPlatform('win32'));

  it('revealInOS resolves once the opener has STARTED, though it never exits', async () => {
    const child = nextChild();
    const done = revealInOS('C:\\proj\\assets\\hero.png');
    child.emit('spawn'); // ...and deliberately no 'exit', ever.
    await expect(done).resolves.toBeUndefined();
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it('openInOS resolves once the opener has STARTED, though it never exits', async () => {
    const child = nextChild();
    const done = openInOS('C:\\proj\\game.ts');
    child.emit('spawn');
    await expect(done).resolves.toBeUndefined();
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  /* There was a third test here — "a non-zero EXIT is not a failure" — which
   * emitted 'spawn' and then 'exit', 1 and asserted the promise resolved. It was
   * deleted in this change's own close-out review because it CANNOT FAIL: the
   * promise has already settled on 'spawn', so rejecting a later non-zero exit
   * would be a no-op on an settled promise and the test stays green even with the
   * mechanism removed. The falsifiable form would emit 'exit' WITHOUT 'spawn' —
   * an ordering the real explorer.exe cannot produce — so the claim belongs to
   * the test above, and to osOpenWin32.test.ts against the real binary. */

  it('still rejects when the opener could not be STARTED at all', async () => {
    const child = nextChild();
    const done = revealInOS('C:\\proj\\assets\\hero.png');
    child.emit('error', new Error('spawn explorer ENOENT'));
    await expect(done).rejects.toThrow(/ENOENT/);
  });

  it('reveals with explorer /select, and a backslashed path', async () => {
    const child = nextChild();
    const done = revealInOS('C:/proj/assets/hero.png');
    child.emit('spawn');
    await done;
    expect(spawnMock).toHaveBeenCalledWith(
      'explorer',
      ['/select,C:\\proj\\assets\\hero.png'],
      expect.objectContaining({ detached: true, stdio: 'ignore' }),
    );
  });

  it('never awaits an exit code on this platform — execFile is not used', async () => {
    const child = nextChild();
    const done = openInOS('C:\\proj\\game.ts');
    child.emit('spawn');
    await done;
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

describe('darwin — the exit code IS meaningful, so it is still awaited', () => {
  beforeEach(() => setPlatform('darwin'));

  /** promisify(execFile) calls this with (cmd, args, cb). */
  const execFileAnswers = (err: Error | null) =>
    execFileMock.mockImplementation((_cmd: string, _args: string[], cb: (e: Error | null, r?: unknown) => void) =>
      cb(err, { stdout: '', stderr: '' }),
    );

  it('revealInOS uses `open -R` and resolves on a zero exit', async () => {
    execFileAnswers(null);
    await expect(revealInOS('/proj/assets/hero.png')).resolves.toBeUndefined();
    expect(execFileMock).toHaveBeenCalledWith('open', ['-R', '/proj/assets/hero.png'], expect.anything());
  });

  it('propagates a non-zero exit as a failure (the caller maps it to a 500)', async () => {
    execFileAnswers(new Error('Command failed: open -R'));
    await expect(revealInOS('/proj/assets/hero.png')).rejects.toThrow(/Command failed/);
  });

  it('does not take the detached path — the asymmetry with win32 is deliberate', async () => {
    execFileAnswers(null);
    await openInOS('/proj/game.ts');
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

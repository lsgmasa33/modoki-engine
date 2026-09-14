/**
 * ⚠️ **A scratch dir a test creates with a bare `mkdtempSync` is never removed unless that test
 * remembers to (#1117).** Nothing else removes it. Measured on 2026-09-14: the `modoki-qa` Mac held
 * 131,158 `modoki-*` entries in `os.tmpdir()`, 59,249 of them more than 3 days old, so macOS was not
 * expiring them either. The win clone held 8,551. They come from three leaking shapes:
 * a `beforeEach` with no matching removal, a removal on the success path only (so any failing test
 * leaks), and a removal of the child path the test kept rather than the dir it created.
 *
 * `makeScratchDir(prefix)` makes the lifetime the helper's job instead of the caller's. Every dir it
 * creates is removed after the TEST FILE finishes, whether its tests passed or failed, by the
 * `afterAll` that `installScratchDirCleanup()` registers from each vitest config's setup file.
 *
 * - **The end of the file, not the end of the test.** A dir created in `beforeAll` or at module
 *   scope is shared across the file's tests, and only file scope covers every place a dir is made.
 *   The setup file registers its `afterAll` first, so under vitest's default `stack` hook order it
 *   runs after the file's own `afterAll`s have finished using the dirs.
 * - ⚠️ **KNOWN GAP: the `afterAll` can be SKIPPED.** Vitest 4 runs a file's `afterAll`s in sequence
 *   and stops at the first one that throws. A test file whose OWN `afterAll` throws or times out
 *   never reaches this one, so its dirs leak. A killed run leaks the same way. A process `exit`
 *   fallback was tried and is UNREACHABLE: the pool ends each worker with SIGTERM, which emits no
 *   `exit` unless a SIGTERM handler is installed (measured 2026-09-14). The child-run test pins the
 *   gap. The design that would close it is a run-scoped parent dir that `globalSetup` removes. It
 *   is not built: docs/verify-and-ci.md § Scratch dirs.
 * - **A dir that cannot be removed is a WARNING, not a failure.** On Windows a handle a child process
 *   has not released yet can outlast the retries. Failing an unrelated suite over temp cleanup would
 *   trade a leak for a flaky gate, so the leftovers are named on stderr instead.
 * - **An existing explicit `rmSync` of a scratch dir is harmless.** Removal here is `force`, so a
 *   dir the test already removed is not an error.
 * - **An uninstalled cleanup is a thrown error, not a silent leak.** A vitest config whose setup
 *   file does not call `installScratchDirCleanup()`, or a second module instance of this file, would
 *   otherwise create dirs that nothing ever removes. That is the exact defect this helper exists to
 *   end. So `makeScratchDir` refuses to create one until cleanup is installed in its own instance.
 *
 * `engine/tests/architecture/scratchDirOwnership.test.ts` refuses a raw `mkdtemp` call anywhere in
 * the test corpus except this file. Why and the shapes: docs/verify-and-ci.md § Scratch dirs.
 */
import type * as NodeFs from 'node:fs';
import type * as NodeOs from 'node:os';
import type * as NodePath from 'node:path';

// The builtins are fetched with `process.getBuiltinModule`, not imported, on purpose. A suite that
// `vi.mock`s `fs` or `os` replaces them for every module in its graph, including this one, and a
// helper whose own mkdtemp or rm is mocked either creates nothing real or never removes what it
// created. `getBuiltinModule` goes to Node directly, so the mock cannot reach it.
const fs = process.getBuiltinModule('node:fs') as typeof NodeFs;
const os = process.getBuiltinModule('node:os') as typeof NodeOs;
const path = process.getBuiltinModule('node:path') as typeof NodePath;

export interface ScratchDirOptions {
  /** Parent directory. Defaults to `os.tmpdir()`. */
  base?: string;
  /**
   * Resolve `base` with `fs.realpathSync.native` first, so the returned path is its own physical
   * spelling (macOS `/var` → `/private/var`, a Windows 8.3 short name → its long form). Needed by a
   * test that compares the dir against a path something else canonicalised.
   */
  canonical?: boolean;
}

const created: string[] = [];
let installed = false;

/**
 * Create a fresh, uniquely named directory (`<base>/<prefix>XXXXXX`) that is removed after the
 * current test file finishes. Returns its path.
 */
export function makeScratchDir(prefix: string, opts: ScratchDirOptions = {}): string {
  if (!installed) {
    throw new Error(
      `makeScratchDir(${JSON.stringify(prefix)}): scratch-dir cleanup is not installed in this module instance, `
      + 'so the dir would never be removed (#1117). The vitest config running this file needs a setup file that calls '
      + 'installScratchDirCleanup() from @modoki/engine/testing/scratchDir.',
    );
  }
  const base = opts.base ?? os.tmpdir();
  const dir = fs.mkdtempSync(path.join(opts.canonical ? fs.realpathSync.native(base) : base, prefix));
  created.push(dir);
  return dir;
}

/**
 * Remove every dir `makeScratchDir` has created and not yet removed. All of them are attempted, and
 * the ones that could not be removed are warned about together. A dir that is already gone is not
 * an error. Returns the failure lines.
 */
export function removeScratchDirs(): string[] {
  const failed = created.splice(0).map(removeOne).filter((f): f is string => f !== undefined);
  if (failed.length) {
    console.warn(`removeScratchDirs: ${failed.length} scratch dir(s) could not be removed and are leaked:\n  ${failed.join('\n  ')}`);
  }
  return failed;
}

/** Remove one dir; the failure line for the report, or `undefined` when it is gone. */
function removeOne(dir: string): string | undefined {
  try {
    // Retries cover a Windows handle a just-exited child process has not released yet.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return undefined;
  } catch (err) {
    return `${dir}: ${(err as Error).message}`;
  }
}

/** Dirs created and not yet removed. For the helper's own tests. */
export function pendingScratchDirs(): readonly string[] {
  return [...created];
}

/**
 * Register the per-file removal. Call it once, at the top level of a vitest setup file, passing
 * vitest's `afterAll`, so the removal lands on every test file's root suite.
 *
 * The hook is passed in rather than imported so this module never imports `vitest` itself. A
 * helper that imports it (`makeTestGlb`) is also loaded by a Playwright spec, where importing
 * vitest is not safe. Outside vitest nothing installs the cleanup, so `makeScratchDir` refuses.
 */
export function installScratchDirCleanup(afterAll: (fn: () => void) => void): void {
  installed = true;
  afterAll(() => { removeScratchDirs(); });
}

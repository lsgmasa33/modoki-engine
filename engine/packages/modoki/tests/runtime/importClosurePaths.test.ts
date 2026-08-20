/** The module-boundary walker's path identity must be POSIX on every OS.
 *
 *  WHY THIS TEST EXISTS. `render3dBoundary.test.ts` was RED on `check (windows-latest)` and green
 *  on ubuntu and macOS. Not a product defect: `walkClosure` built its per-file identity with
 *  `path.relative`, which yields `runtime\loaders\textureResolver.ts` on Windows, while every
 *  allowlist that feeds it (`GATED_EDGES`) is written with forward slashes — an `ImportEdge.file`
 *  is source text, not a filesystem path. So `skipEdges` matched NOTHING there: the guard walked
 *  the very edges its allowlist exempts, reported them as offenders, and failed. The same mismatch
 *  broke the other direction too — the caller's `offenders.some(o => o.includes(file))` cannot
 *  match a backslash chain against a forward-slash entry.
 *
 *  This is the repo's recurring Windows-only path class (CLAUDE.md: five such fixes in six months,
 *  every one invisible to a Mac clone), and the reason `targets: editor-win` exists in the QA
 *  suite. A Mac cannot reproduce it — so `toPosix` splits on BOTH separators instead of
 *  `path.sep`, which is what makes the assertions below non-vacuous here. A `path.sep`
 *  implementation would return a Windows path unchanged on this machine and these tests would
 *  fail, which is exactly the guard behaviour wanted: the fix cannot silently regress to the
 *  platform-dependent form. */

import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { toPosix, walkClosure } from '../helpers/importClosure';

describe('importClosure path identity is POSIX on every OS', () => {
  it('converts a Windows-separated path, from any platform', () => {
    expect(toPosix('runtime\\loaders\\textureResolver.ts')).toBe('runtime/loaders/textureResolver.ts');
  });

  it('leaves an already-POSIX path alone (idempotent)', () => {
    const p = 'runtime/loaders/textureResolver.ts';
    expect(toPosix(p)).toBe(p);
    expect(toPosix(toPosix(p))).toBe(p);
  });

  it('normalizes a mixed-separator path — the shape a half-joined path actually takes', () => {
    expect(toPosix('runtime\\rendering/npr\\NPRPostProcess.ts')).toBe('runtime/rendering/npr/NPRPostProcess.ts');
  });

  it('emits no backslash in `visited`, so an allowlist can match it', () => {
    // Walk the real tree: cheap, and it pins the property at the seam the guards consume rather
    // than only on the helper in isolation.
    const srcDir = path.resolve(__dirname, '../../src');
    const { visited } = walkClosure({ srcDir, entries: ['runtime/index.ts'], forbidden: [] });
    expect(visited.length).toBeGreaterThan(0);
    expect(visited.filter((v) => v.includes('\\'))).toEqual([]);
  });

  it('honours a skipEdge written with forward slashes — the assertion that was false on Windows', () => {
    const srcDir = path.resolve(__dirname, '../../src');
    const entries = ['runtime/index.ts'];
    const forbidden = ['three/webgpu'] as const;

    const withoutSkip = walkClosure({ srcDir, entries, forbidden });
    const withSkip = walkClosure({
      srcDir,
      entries,
      forbidden,
      skipEdges: [{ file: 'runtime/loaders/materialPresets.ts', spec: './fileShaderBuilder' }],
    });

    // The skip must CHANGE the result. On Windows pre-fix both calls returned the same set,
    // because the key never matched — which is precisely how the allowlist became a no-op.
    expect(withoutSkip.visited).toContain('runtime/loaders/fileShaderBuilder.ts');
    expect(withSkip.visited.length).toBeLessThan(withoutSkip.visited.length);
  });
});

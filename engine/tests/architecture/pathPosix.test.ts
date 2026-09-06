/** Unit: `engine/scripts/pathPosix.mjs` — the shared `toPosix` (#798).
 *
 *  This helper exists to end a class of Windows-only defects where a `node:path` result
 *  (backslash-separated) is compared against a hand-authored forward-slash literal and the
 *  comparison silently misses (docs/windows.md § Paths). It is now the SSOT for that
 *  normalisation, and until this file existed it was the only `toPosix` in the repo with no
 *  test of its own — while `importClosurePaths.test.ts` pins the copy it is meant to displace.
 *
 *  The load-bearing assertion is the LAST describe block: `toPosix` must normalise a
 *  backslash path ON EVERY PLATFORM. The tempting "simplification" is `split(path.sep)`, which
 *  is separator-dependent and therefore a no-op on backslashes under POSIX — it would pass a
 *  Windows-shaped path straight through unnormalised, reintroducing exactly the class this
 *  helper closes, and it would do so INVISIBLY on the Mac clones where most work happens. */

import { describe, it, expect } from 'vitest';
import { toPosix } from '../../scripts/pathPosix.mjs';

describe('toPosix', () => {
  it('converts backslashes to forward slashes', () => {
    expect(toPosix('engine\\packages\\modoki\\src\\x.ts'))
      .toBe('engine/packages/modoki/src/x.ts');
  });

  it('is idempotent — an already-POSIX path is unchanged', () => {
    const posix = 'engine/packages/modoki/src/x.ts';
    expect(toPosix(posix)).toBe(posix);
    expect(toPosix(toPosix('engine\\packages\\x.ts'))).toBe(toPosix('engine\\packages\\x.ts'));
  });

  it('normalises a MIXED-mode path — MSYS/Git-Bash hands native exes these', () => {
    expect(toPosix('E:/Projects\\modoki/engine\\scripts')).toBe('E:/Projects/modoki/engine/scripts');
  });

  // The edge set the docblock claims was checked. Pinned so the claim stays true.
  it.each([
    ['', ''],
    ['E:/a/b', 'E:/a/b'],                    // already POSIX, drive letter preserved
    ['C:foo', 'C:foo'],                      // drive-relative, no separator to touch
    ['a\\', 'a/'],                           // trailing separator preserved
    ['a//b', 'a//b'],                        // empty segments preserved, NOT collapsed
    ['a\\\\b', 'a//b'],                      // ...on either separator
    ['\\\\server\\share\\x', '//server/share/x'], // UNC keeps its leading double
  ])('edge: %j -> %j', (input, expected) => {
    expect(toPosix(input)).toBe(expected);
  });

  describe('the property that makes it correct on every platform', () => {
    it('normalises a backslash path even where path.sep is "/" (the split(path.sep) trap)', () => {
      // Deliberately platform-independent: this is the assertion that goes red if anyone
      // "simplifies" the implementation to `p.split(path.sep).join('/')`, which on POSIX
      // would return the input untouched and silently restore the #798 defect class.
      expect(toPosix('runtime\\rendering\\text\\textDirty.ts'))
        .toBe('runtime/rendering/text/textDirty.ts');
    });
  });
});

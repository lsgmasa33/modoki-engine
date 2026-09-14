/**
 * ⚠️ **An ordering assertion on a raw `indexOf` passes when the thing it orders is ABSENT (#1181).**
 *
 * `expect(s.indexOf(a)).toBeLessThan(s.indexOf(b))` reads `-1` for a missing `a`, and `-1` is less
 * than every real position, so the assertion is green precisely when `a` never appeared. The mirror,
 * `expect(s.indexOf(b)).toBeGreaterThan(s.indexOf(a))`, has the same hole on its right-hand side, and
 * a position bound first (`const at = s.indexOf(a)`) carries it into every later comparison. Observed
 * as a real miss once: `userDataDir.test.ts` compared a formatter-wrapped `app.setPath(` that read
 * `-1`, and the guard that exists to catch #1036's regression passed.
 *
 * The two shapes below make "absent" a FAILURE that names what is missing, before any position is
 * compared:
 *
 * - `expectInOrder(haystack, [a, b, c])` — the whole check, for needles searched from the start.
 * - `found(index, what)` — for a position computed any other way (a `from` offset, `lastIndexOf`,
 *   `findIndex`, a regex `search`). Wrap the index where it is PRODUCED, so every later comparison
 *   of it is safe: `const at = found(src.indexOf('x(', start), 'x( after start')`.
 *
 * `engine/tests/architecture/indexOrderingAssertions.test.ts` refuses the raw form, and a separate
 * `toBeGreaterThan(-1)` pin does not satisfy it on purpose: whether a pin elsewhere in the test
 * covers THIS operand is the adjunct question that fails open (docs/verify-and-ci.md § Exemption
 * GRAIN). Why and the shapes: docs/falsifiable-tests.md § Shape (H).
 */

/** What an ordering check searches: source/command text, or a list (event log, sorted names). */
export type Haystack = string | readonly unknown[];

function show(v: unknown): string {
  const s = typeof v === 'string' ? JSON.stringify(v) : String(v);
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

/**
 * `index`, when it is a real position; otherwise throw naming `what`.
 *
 * ⚠️ Rejects every negative, not only `-1`, and a non-integer (`NaN` from arithmetic on an absent
 * position), because each of those is an absent subject that some comparison would still accept.
 */
export function found(index: number, what: string): number {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`found: ${what} is not present (index ${index}), so no ordering check on it can mean anything`);
  }
  return index;
}

/**
 * Assert that every needle is present in `haystack` and that their FIRST occurrences appear in the
 * given order, strictly: two needles at the same position are not "in order".
 *
 * Presence is checked for every needle before any position is compared, so a missing needle is
 * reported as missing rather than as out of order. Positions are each needle's first occurrence
 * (`indexOf`), the same thing the `indexOf` comparison it replaces read.
 */
export function expectInOrder(haystack: Haystack, needles: readonly unknown[], label = 'haystack'): void {
  if (needles.length < 2) {
    throw new Error(`expectInOrder(${label}): needs at least two needles to order, got ${needles.length}`);
  }
  const positions = needles.map((n) => {
    if (typeof haystack === 'string') {
      if (typeof n !== 'string') throw new Error(`expectInOrder(${label}): a string haystack takes string needles, got ${show(n)}`);
      // '' is "found" at 0 in every string, so a computed needle that came out empty would read as
      // present and first, which is the hole this helper exists to close.
      if (n === '') throw new Error(`expectInOrder(${label}): an empty needle is found at 0 in any string, so it orders nothing`);
      return haystack.indexOf(n);
    }
    return haystack.indexOf(n);
  });
  const missing = needles.filter((_, i) => positions[i] < 0);
  if (missing.length > 0) {
    throw new Error(`expectInOrder(${label}): not present: ${missing.map(show).join(', ')}`);
  }
  for (let i = 1; i < needles.length; i++) {
    if (positions[i - 1] >= positions[i]) {
      throw new Error(`expectInOrder(${label}): ${show(needles[i - 1])} (at ${positions[i - 1]}) must come before `
        + `${show(needles[i])} (at ${positions[i]})`);
    }
  }
}

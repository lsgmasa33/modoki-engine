/**
 * Normalise a filesystem path to forward slashes — the ONE implementation (#798).
 *
 * `node:path`'s `relative()`/`join()` return `\`-separated paths on Windows, and a LOT
 * of code in this repo compares that output against a hand-authored forward-slash
 * literal (an allowlist entry, a `.endsWith('a/b.ts')`, an `.includes('/scenes/')`).
 * The comparison silently stops matching — not throwing, not warning — which is the
 * dangerous shape: a guard built on it goes quietly GREEN on Windows when its matching
 * breaks, because nothing matches (see docs/windows.md § Paths, "the loud failure is
 * the lucky one"). This is documented instance 7/8 of that class; five earlier fixes
 * hand-rolled the same normalisation in three different spellings
 * (`split(/[\\/]/)`, `split(path.sep)`, `replace(/\\/g,'/')`) instead of sharing one.
 *
 * The spelling that MATTERS to get right is `split(path.sep)`: it is separator-dependent,
 * so on POSIX it does not split backslashes at all and a Windows-shaped path handed to it
 * survives unnormalised. `split(/[\\/]/)` and `replace(/\\/g,'/')` are, by contrast,
 * extensionally identical — both were checked over the edge set (empty, UNC, mixed-mode
 * `E:/a/b`, doubled separators, trailing separator, drive-relative `C:foo`) and found to
 * agree everywhere. This one is chosen for reading as "split on either separator", not
 * because it normalises anything the replace does not.
 *
 * New code should reach for this rather than hand-rolling a sixth spelling. The ~66
 * existing sites with their own inline normalisation are left alone deliberately —
 * see docs/windows.md § Paths.
 */

/** Convert `p` to forward-slash form. Idempotent; safe to call on an already-POSIX path. */
export function toPosix(p) {
  return p.split(/[\\/]/).join('/');
}

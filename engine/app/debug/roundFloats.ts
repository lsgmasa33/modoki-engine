/** Significant-digit rounding for agent-facing numeric payloads.
 *
 *  A `Transform` ships nine float64s per entity, and the mantissa is where the tokens are:
 *  `-0.31536382659192896` costs 9 tokens, `-0.315363827` costs 6. Across the drill-downs an
 *  agent actually repeats (`trait=Transform`, `world=1`, `bounds=1`, `layout-bounds` rects),
 *  9 significant digits removes ~17% of the real token count — about 22,600 tokens on the
 *  reference project — for a maximum absolute error of 3.5e-7.
 *
 *  WHY SIGNIFICANT DIGITS, NOT DECIMALS. `toFixed(3)` flattens `1.5e-7` and `0.0004321` to
 *  `0.0`. A scale of 1.5e-7 collapsing to zero is a bug report, not a rounding artifact.
 *  Significant digits preserve small magnitudes exactly and only trim the mantissa.
 *
 *  WHY 9. The savings/error curve is steep at the wrong end: going 9 → 6 buys 6 more points of
 *  saving and costs 1,400× the error (3.5e-7 → 5.0e-4), and mangles clean authored values
 *  (679.0625 → 679.062). 9 keeps 73% of the benefit with an error below any tolerance a
 *  renderer, a physics engine, or a human cares about.
 *
 *  THIS IS LOSSY. `247.13061935179246` reads back as `247.130619`. Verifying an edit by exact
 *  string/`===` comparison will fail; verify with a tolerance. `precision=0` (or ≥17) returns
 *  the exact float64 for a caller who needs it.
 *
 *  BOUNDARY ONLY. Call this from an agent op / HTTP route, never inside a producer: the
 *  editor's Inspector, gizmos and diagnostics read those producers in-process and must keep
 *  full precision. See docs/mcp-response-budget.md — "shape the payload at the BOUNDARY". */

/** Default significant digits for agent-facing floats. */
export const DEFAULT_FLOAT_PRECISION = 9;

/** float64 carries ~17 significant decimal digits; at or above that, rounding is a no-op. */
const EXACT = 17;

/** Round one number to `sig` significant digits. Integers, zero, and non-finite values pass
 *  through untouched (`-0` keeps its sign; NaN/Infinity are not JSON anyway but must not throw). */
export function roundSig(x: number, sig: number): number {
  if (!Number.isFinite(x) || x === 0) return x;
  // Integers are already minimal — and `toPrecision` would turn 5 into "5.00000000".
  if (Number.isInteger(x) && Math.abs(x) < 1e15) return x;
  if (sig <= 0 || sig >= EXACT) return x;
  return Number(x.toPrecision(sig));
}

/** Deep-copy `value`, rounding every float to `sig` significant digits.
 *
 *  Returns a NEW structure — the producer's objects are live (a rect may be reused by the
 *  editor overlay), so rounding in place would silently degrade what the human sees. */
export function roundFloats<T>(value: T, sig: number = DEFAULT_FLOAT_PRECISION): T {
  if (sig <= 0 || sig >= EXACT) return value; // exact-fidelity escape hatch
  return walk(value, sig) as T;
}

function walk(v: unknown, sig: number): unknown {
  if (typeof v === 'number') return roundSig(v, sig);
  if (Array.isArray(v)) return v.map((x) => walk(x, sig));
  // Only plain objects: a Date/Map/class instance must not be silently rebuilt as {}.
  if (v !== null && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x, sig);
    return out;
  }
  return v; // strings, booleans, null, undefined, and anything exotic
}

/** Parse a `precision` query/tool param. A bad value must never disable the default — the
 *  `?limit=abc` → NaN → full-ring-flood lesson, applied to precision. */
export function resolvePrecision(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw !== '' ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : DEFAULT_FLOAT_PRECISION;
}

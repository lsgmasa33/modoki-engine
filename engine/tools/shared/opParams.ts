/**
 * The TYPED params of the agent ops a backend route relays (#1962), in ONE table both sides read.
 *
 * A route parses its query string, then the op behind it checks what arrives. Each side used to do this
 * by its own rule, and the two rules drifted apart:
 * - The route DROPPED a malformed number (`?since=abc` gave the default tail under a cursored framing).
 * - Booleans had three spellings: `'1'|'true'`, truthy (where `?entities=0` turned the option ON), and
 *   `'true'` only.
 * - The op checked some params, coerced others and left the rest to `?? default`, where a NaN slips
 *   through because `NaN ?? 50` is NaN.
 * This table is the op's schema for those params:
 * - {@link decodeOpQuery} is the route half. It decodes the values it can, losslessly, by the same
 *   rule the MCP side uses (`coerceArgs`' {@link decodeStringEncoded}), and forwards the rest RAW.
 * - {@link checkOpParams} is the op half. `runAgentOp` runs it before every handler, so the editor
 *   relay, Electron IPC, an eval's `modoki.call` and the device bridge all refuse the same value
 *   the same way.
 *
 * Only TYPED params live here. A vocabulary param (`level`, `action`, `source`) is forwarded raw by
 * the route and refused by the op against its own vocabulary table (#1072); a free string needs no
 * decoding.
 *
 * ⚠️ **Adding a numeric or boolean param to one of these ops means adding it HERE.** That one edit
 * both makes the route forward it and makes every transport refuse a malformed value of it.
 * `tests/plugins/opParams.test.ts` fails if a router line goes back to hand-parsing one.
 */
import { decodeStringEncoded, NOT_DECODED } from './coerceArgs';

export type OpParamRule =
  /** A finite number. `integer: 'floor'` floors it (a count); `'require'` refuses a fraction (a seq cursor). */
  | { kind: 'number'; min?: number; integer?: 'floor' | 'require' }
  /** A boolean. Over a query string: `1`/`true` and `0`/`false`. Nothing else, and never "any non-empty value". */
  | { kind: 'flag' }
  /** A list of finite numbers. Over a query string: comma-separated. */
  | { kind: 'numberList' }
  /** `{x, y}`, both finite. Over a query string it is two keys (`query`), and both must be present. */
  | { kind: 'point'; query: readonly [string, string] };

/** A count of things to return (`limit`, `precision`, `markers`): whole, never negative. */
const COUNT = { kind: 'number', min: 0, integer: 'floor' } as const;
/** A `since` seq cursor (`SINCE_CURSOR_BASE`): a prior reply's `nextSeq`, so a non-negative integer. */
const SEQ_CURSOR = { kind: 'number', min: 0, integer: 'require' } as const;
/** A `sinceCap` cursor: a prior reply's `nextCap`. */
const CAP_CURSOR = { kind: 'number', min: 0 } as const;
const NUMBER = { kind: 'number' } as const;
const FLAG = { kind: 'flag' } as const;

export const OP_PARAMS: Readonly<Record<string, Readonly<Record<string, OpParamRule>>>> = {
  'scene-state': { id: NUMBER, limit: COUNT, precision: COUNT, full: FLAG, resources: FLAG, world: FLAG, bounds: FLAG, contacts: FLAG },
  'console-logs': { limit: COUNT, since: SEQ_CURSOR, sinceMs: NUMBER },
  'journal-events': { limit: COUNT, sinceCap: CAP_CURSOR },
  'editor-journal': { since: SEQ_CURSOR, sinceCap: CAP_CURSOR, limit: COUNT, merged: FLAG },
  // `timeoutMs` is CLAMPED by the op (`clampWaitForEditTimeout`), not refused: only its type is checked here.
  'wait-for-edit': { since: SEQ_CURSOR, timeoutMs: NUMBER },
  'watch-read': { limit: COUNT, precision: COUNT, clear: FLAG, samples: FLAG },
  'layout-bounds': { ids: { kind: 'numberList' }, entities: FLAG, overlaps: FLAG, limit: COUNT, precision: COUNT },
  'profiler': { markers: COUNT, limit: COUNT, all: FLAG },
  'input-watch-read': { limit: COUNT, precision: COUNT, unresolvedOnly: FLAG },
  'hit-regions': { limit: COUNT, precision: COUNT, at: { kind: 'point', query: ['atX', 'atY'] } },
  'diagnose': { video: FLAG },
};

/** A query-string flag: `true`/`false` for the four spellings, `undefined` when absent or empty, and the RAW
 *  string otherwise, so whoever checks it next can refuse it by name. Exported for the backend-only routes,
 *  which have no op behind them and refuse the raw string themselves ({@link flagRefusal}). */
export function decodeQueryFlag(raw: string | null): boolean | string | undefined {
  if (raw == null || raw === '') return undefined;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return raw;
}

function decodeNumberish(raw: string): number | string {
  const n = decodeStringEncoded(raw, 'number');
  return n === NOT_DECODED ? raw : (n as number);
}

/**
 * The route half: every key of `op`'s table that the query carries, decoded. A value that cannot be
 * decoded is forwarded RAW, so the op refuses it. Dropping it would hand the caller the default answer
 * under the framing they asked for. An empty value (`?limit=`) is absent, as it always was.
 */
export function decodeOpQuery(op: string, query: URLSearchParams): Record<string, unknown> {
  const rules = OP_PARAMS[op];
  if (!rules) throw new Error(`decodeOpQuery: '${op}' has no OP_PARAMS entry`);
  const out: Record<string, unknown> = {};
  for (const [key, rule] of Object.entries(rules)) {
    if (rule.kind === 'point') {
      const [qx, qy] = rule.query;
      const x = query.get(qx);
      const y = query.get(qy);
      if ((x == null || x === '') && (y == null || y === '')) continue;
      // Half a point is forwarded as half a point, and the op refuses it. It used to be dropped
      // whole, which turned a probe into "no probe" with no word said.
      out[key] = {
        ...(x != null && x !== '' ? { x: decodeNumberish(x) } : {}),
        ...(y != null && y !== '' ? { y: decodeNumberish(y) } : {}),
      };
      continue;
    }
    const raw = query.get(key);
    if (raw == null || raw === '') continue;
    if (rule.kind === 'flag') out[key] = decodeQueryFlag(raw);
    else if (rule.kind === 'number') out[key] = decodeNumberish(raw);
    else out[key] = raw.split(',').map((s) => s.trim()).filter(Boolean).map(decodeNumberish);
  }
  return out;
}

export interface OpParamRefusal { ok: false; code: 'REFUSED_BY_OP'; error: string; options?: string[] }

function describe(rule: OpParamRule): string {
  switch (rule.kind) {
    case 'flag': return 'a boolean (true/false, or 1/0 in a query string)';
    case 'numberList': return 'a list of finite numbers';
    case 'point': return `{x, y} with both finite (in a query string: ${rule.query.join(' and ')})`;
    case 'number': {
      const whole = rule.integer === 'require' ? 'an integer' : 'a finite number';
      return rule.min === 0 ? `${whole} >= 0` : rule.min != null ? `${whole} >= ${rule.min}` : whole;
    }
  }
}

/** A number the op can use, or NOT_DECODED. Takes a decimal string too: an in-process or POST caller may
 *  send one, and refusing `"5"` where the MCP side would have decoded it is a third rule. */
function asNumber(v: unknown): number | typeof NOT_DECODED {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NOT_DECODED;
  if (typeof v === 'string') return decodeStringEncoded(v, 'number') as number | typeof NOT_DECODED;
  return NOT_DECODED;
}

function normalize(rule: OpParamRule, v: unknown): { value: unknown } | null {
  switch (rule.kind) {
    case 'flag': {
      if (typeof v === 'boolean') return { value: v };
      const d = typeof v === 'string' ? decodeQueryFlag(v) : undefined;
      return typeof d === 'boolean' ? { value: d } : null;
    }
    case 'numberList': {
      if (!Array.isArray(v)) return null;
      const out: number[] = [];
      for (const e of v) { const n = asNumber(e); if (n === NOT_DECODED) return null; out.push(n); }
      return { value: out };
    }
    case 'point': {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
      const x = asNumber((v as { x?: unknown }).x);
      const y = asNumber((v as { y?: unknown }).y);
      return x === NOT_DECODED || y === NOT_DECODED ? null : { value: { x, y } };
    }
    case 'number': {
      let n = asNumber(v);
      if (n === NOT_DECODED) return null;
      if (rule.integer === 'require' && !Number.isInteger(n)) return null;
      if (rule.integer === 'floor') n = Math.floor(n);
      if (rule.min != null && n < rule.min) return null;
      return { value: n };
    }
  }
}

/**
 * The op half. It checks `params` against `op`'s table and returns the params with each typed value
 * normalized: a decimal string becomes a number, a count is floored, and a `null` is dropped because
 * it means absent. A value the table rejects is a REFUSAL, RETURNED rather than thrown, so the device
 * relay carries its code (`opRefusal.ts`'s docblock). An op with no entry passes through untouched.
 */
export function checkOpParams(op: string, params: unknown): { ok: true; params: unknown } | { ok: false; refusal: OpParamRefusal } {
  const rules = OP_PARAMS[op];
  if (!rules || params == null || typeof params !== 'object' || Array.isArray(params)) return { ok: true, params };
  const p = params as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;
  for (const [key, rule] of Object.entries(rules)) {
    if (!Object.prototype.hasOwnProperty.call(p, key) || p[key] === undefined) continue;
    const v = p[key];
    out ??= { ...p };
    if (v === null) { delete out[key]; continue; }
    const n = normalize(rule, v);
    if (!n) {
      return {
        ok: false,
        refusal: {
          ok: false, code: 'REFUSED_BY_OP',
          error: `${op}: ${key} must be ${describe(rule)}, got ${JSON.stringify(v)}. Nothing was done.`,
        },
      };
    }
    out[key] = n.value;
  }
  return { ok: true, params: out ?? params };
}

/** A backend-only route's refusal of a flag that is not one of the four spellings ({@link decodeQueryFlag}). */
export function flagRefusal(key: string, raw: string): OpParamRefusal {
  return { ok: false, code: 'REFUSED_BY_OP', error: `${key} must be ${describe(FLAG)}, got ${JSON.stringify(raw)}. Nothing was done.` };
}

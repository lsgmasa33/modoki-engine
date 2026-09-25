/**
 * String-encoded tool args are DECODED, not refused (#1560; docs/mcp-tool-conventions.md §1).
 *
 * Agents send `"limit":"12"`, `"bounds":"1"`, `"entity":"{\"name\":…}"` — and Claude Code itself
 * sometimes packs a nested object into a string (§1's `$ref`-dedupe note). Each of those used to be
 * refused with the SDK's raw `Expected number, received string`, and the agent spent a turn
 * re-sending the same value unquoted. Owner decision (2026-09-25): decode them.
 *
 * Only LOSSLESS cases, and only where the schema at that path does not already take the string:
 *  - a full-match finite decimal → number (`"12"`, `"-0.5"`, `"1e3"`; NOT `"12abc"`, `""`, `"0x1f"`)
 *  - `"true"` / `"false"` → boolean
 *  - a string that `JSON.parse`s to an object/array, where an object/array is wanted
 *
 * The schema decides WHERE, not this module: {@link coerceStringEncoded} parses, and touches only
 * the paths whose issue is a type mismatch on a string value. A field that accepts a string (a
 * plain `z.string()`, an enum, a `string | number` union) never produces such an issue, so it is
 * never rewritten. The result is then validated again, strictly, by the normal parse — a decoded
 * object with a typo'd key is refused naming that key, exactly as if it had been sent unencoded.
 *
 * Zod-version-agnostic on purpose: the editor server runs zod 3 and the device server zod 4, and
 * both issue shapes carry `code`, `path` and (for a type mismatch) `expected`. Nothing here reads
 * a schema's internals, so one helper serves both.
 */

/** The value could not be decoded losslessly — leave the original in place. */
export const NOT_DECODED: unique symbol = Symbol('not-decoded');

const DECIMAL = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** What a type-mismatch issue asked for, folded to the four kinds this module can produce. */
export type WantedKind = 'number' | 'boolean' | 'object' | 'array' | 'unknown';

/** Decode one string as `want`, or {@link NOT_DECODED}. `'unknown'` (a union that failed) tries
 *  JSON first, then a number, then a boolean — the union's own re-validation picks the winner. */
export function decodeStringEncoded(raw: string, want: WantedKind): unknown {
  const s = raw.trim();
  if (want === 'number' || want === 'unknown') {
    if (DECIMAL.test(s)) {
      const n = Number(s);
      // Exact only: an integer-looking string past 2^53 would come back rounded (review).
      if (Number.isFinite(n) && !(/^-?\d+$/.test(s) && !Number.isSafeInteger(n))) return n;
    }
    if (want === 'number') return NOT_DECODED;
  }
  if (want === 'boolean' || want === 'unknown') {
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (want === 'boolean') return NOT_DECODED;
  }
  if (want === 'object' || want === 'array' || want === 'unknown') {
    if (!(s.startsWith('{') || s.startsWith('['))) return NOT_DECODED;
    let v: unknown;
    try { v = JSON.parse(s); } catch { return NOT_DECODED; }
    if (want === 'array') return Array.isArray(v) ? v : NOT_DECODED;
    if (want === 'object') return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : NOT_DECODED;
    return v !== null && typeof v === 'object' ? v : NOT_DECODED;
  }
  return NOT_DECODED;
}

/** The minimal issue shape both zod 3 and zod 4 produce. */
interface Issue { code: string; path: ReadonlyArray<PropertyKey>; expected?: unknown }
type SafeParseResult = { success: true } | { success: false; error: { issues: ReadonlyArray<Issue> } };
/** Anything with a zod-style `safeParse` — a zod 3 or zod 4 object schema. */
export interface SafeParser { safeParse(data: unknown): SafeParseResult }

function wantedOf(issue: Issue): WantedKind | null {
  if (issue.code === 'invalid_union') return 'unknown';
  if (issue.code !== 'invalid_type') return null;
  switch (issue.expected) {
    case 'number': case 'int': case 'integer': case 'float': return 'number';
    case 'boolean': return 'boolean';
    case 'object': case 'record': return 'object';
    case 'array': case 'tuple': return 'array';
    default: return null;
  }
}

function getAt(root: unknown, path: ReadonlyArray<PropertyKey>): unknown {
  let cur = root;
  for (const k of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    // Own properties only: a path segment is caller-supplied, and `toString` must not read a function.
    if (!Object.prototype.hasOwnProperty.call(cur, k)) return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[k];
  }
  return cur;
}

function setAt(root: unknown, path: ReadonlyArray<PropertyKey>, value: unknown): void {
  let cur = root as Record<PropertyKey, unknown>;
  for (const k of path.slice(0, -1)) cur = cur[k] as Record<PropertyKey, unknown>;
  cur[path[path.length - 1]] = value;
}

/** A nested string can decode to an object that holds another encoded string — bounded anyway. */
const MAX_PASSES = 4;

/**
 * Return `args` with every string-encoded value the schema rejects decoded, or `args` itself
 * (same reference) when nothing needed or admitted decoding. Never throws and never refuses:
 * the caller's normal parse still runs on what this returns and still owns every refusal.
 */
export function coerceStringEncoded<T>(schema: SafeParser, args: T): T {
  if (args === null || typeof args !== 'object') return args;
  let cur: unknown = args;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const r = schema.safeParse(cur);
    if (r.success) break;
    let next: unknown = null;
    for (const issue of r.error.issues) {
      if (issue.path.length === 0) continue; // the root is the args object itself — never a string
      const want = wantedOf(issue);
      if (!want) continue;
      const v = getAt(next ?? cur, issue.path);
      if (typeof v !== 'string') continue;
      const decoded = decodeStringEncoded(v, want);
      if (decoded === NOT_DECODED) continue;
      next ??= structuredClone(cur);
      setAt(next, issue.path, decoded);
    }
    if (next === null) break;
    cur = next;
  }
  return cur as T;
}

/** The one SDK seam this module uses: `McpServer.validateToolInput(tool, args, name)`, which the
 *  CallTool handler awaits before invoking any tool (`@modelcontextprotocol/sdk` 1.30,
 *  `server/mcp.js`). It is `private` in the typings but an ordinary instance method at runtime. */
type ValidateToolInput = (tool: { inputSchema?: unknown } | undefined, args: unknown, toolName: string) => Promise<unknown>;

/**
 * Decode string-encoded args on every tool this server registers — before the SDK validates them,
 * so the tool, the strict refusal and the published JSON Schema are all exactly what they were.
 *
 * Why this seam rather than the schema: wrapping the strict object in `z.preprocess` turns it into
 * an effects/pipe schema, and the SDK's `normalizeObjectSchema` then no longer recognises an object
 * — `tools/list` would advertise an EMPTY input schema for every tool. Overriding the validation
 * call leaves the registered schema untouched.
 *
 * ⚠️ FAILS LOUD when the method is missing: an SDK bump that renames it must not silently turn
 * this back into "refused", which is what a skip-if-absent guard would do.
 */
export function installArgCoercion(server: object): void {
  const s = server as { validateToolInput?: ValidateToolInput };
  const original = s.validateToolInput;
  if (typeof original !== 'function') {
    throw new Error('installArgCoercion: this McpServer has no validateToolInput — the SDK changed the seam '
      + 'string-encoded arg decoding hooks (tools/shared/coerceArgs.ts, #1560). Re-find the call the '
      + 'CallTool handler validates through.');
  }
  s.validateToolInput = function (this: unknown, tool, args, toolName) {
    const schema = tool?.inputSchema as Partial<SafeParser> | undefined;
    const decoded = schema && typeof schema.safeParse === 'function' ? coerceStringEncoded(schema as SafeParser, args) : args;
    return original.call(this, tool, decoded, toolName);
  };
}

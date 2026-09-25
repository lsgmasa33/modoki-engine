/**
 * The §1 strict-schema refusal, worded once for every surface (mcp-tool-conventions.md §1, §5).
 *
 * A strict schema refuses an unknown key; this is the TEXT of that refusal. It has to carry
 * everything, because the MCP SDK delivers only each issue's `message` — zod's own `keys` field
 * never reaches the caller (`getParseErrorMessage` in the SDK's `zod-compat.js`). The old wording
 * listed the accepted params but not the offending key, so the caller had to diff its own call
 * against the list. The 2026-09-25 audit (docs/reviews/2026-09-25-mcp-tool-audit.md, U-1) measured
 * the cost: `surface` sent top-level on `modoki_tap` — it belongs INSIDE `entity` — 7 times, and
 * 5 of the 8 retries failed again, because "It accepts: x, y, selector, …, entity" does not say
 * that the key the caller used is real, one level down.
 *
 * So the refusal names the key, and when a NESTED param has a field of that name, says which one —
 * as a FACT with that param's own description beside it, never as "it goes inside X". A name match
 * is not a meaning match: `modoki_set_selection {name:'Capsule'}` (the call that made §1 strict)
 * means an ENTITY, and the only nested `name` on that tool is `asset.name`, an asset selection. An
 * instruction would send the caller the wrong way; the fact plus the description lets it judge.
 *
 * Zod-version-agnostic on purpose: the editor server pins zod 3 and the device server zod 4. The
 * walk uses only accessors both dialects expose or that are checked for — `.shape` (object),
 * `.options` (union), `.element` (array), `.unwrap()` (optional/nullable, and zod 4's default),
 * `.removeDefault()` (zod 3's default), `.innerType()` (zod 3's refine/transform). A record/map
 * (`keySchema`/`keyType`) is a leaf: its values are not named fields. Anything unrecognised is a
 * leaf too, which only ever costs the hint, never the refusal.
 */

const MAX_DEPTH = 3;
const DESCRIPTION_CHARS = 90;

type Walked = { shape: Record<string, unknown>; suffix: string };

/** Objects a param's schema resolves to, through wrappers, unions and arrays (an array adds `[]`
 *  to the path, so a home reads `ops[]`). */
function objectShapesOf(schema: unknown, suffix = '', seen = new Set<unknown>()): Walked[] {
  if (!schema || typeof schema !== 'object' || seen.has(schema)) return [];
  seen.add(schema);
  const s = schema as {
    shape?: unknown; options?: unknown; element?: unknown; keySchema?: unknown; keyType?: unknown;
    unwrap?: () => unknown; removeDefault?: () => unknown; innerType?: () => unknown;
  };
  if (s.keySchema !== undefined || s.keyType !== undefined) return [];
  if (s.shape && typeof s.shape === 'object') return [{ shape: s.shape as Record<string, unknown>, suffix }];
  if (Array.isArray(s.options)) return s.options.flatMap((o) => objectShapesOf(o, suffix, seen));
  if (s.element && typeof s.element === 'object') return objectShapesOf(s.element, `${suffix}[]`, seen);
  for (const step of [s.unwrap, s.removeDefault, s.innerType]) {
    if (typeof step !== 'function') continue;
    try { return objectShapesOf(step.call(schema), suffix, seen); } catch { return []; }
  }
  return [];
}

export type NestedHome = { path: string; description?: string };

/** The description a param carries, from the first wrapper along the unwrap chain that has one.
 *  zod 4's `.optional()` returns a NEW schema with no description — the device's entity aim is
 *  `.describe()`d on the inner object and then made optional — while zod 3 carries it outward, so
 *  reading only the outer schema quoted nothing on the device (#1545 re-review). */
function descriptionOf(schema: unknown): string | undefined {
  let cur: unknown = schema;
  for (let i = 0; i < 6 && cur && typeof cur === 'object'; i++) {
    const s = cur as { description?: unknown; unwrap?: () => unknown; removeDefault?: () => unknown; innerType?: () => unknown };
    if (typeof s.description === 'string' && s.description.trim()) return s.description;
    const step = [s.unwrap, s.removeDefault, s.innerType].find((f) => typeof f === 'function');
    if (!step) return undefined;
    try { cur = step.call(cur); } catch { return undefined; }
  }
  return undefined;
}

/** The first sentence of a param's description, capped at a word boundary — enough to tell
 *  `entity` (an aim) from `asset` (an asset selection) without pasting a paragraph into every
 *  refusal. A sentence ends only where the NEXT one starts with a capital, so "What to create,
 *  e.g. {kind:…}" is not cut at "e.g." — that cut dropped exactly the part showing the shape.
 *  Omitted when it LEADS with only the param's name ("Ops. …"), which tells the caller nothing. */
function briefOf(schema: unknown, name: string): string | undefined {
  const d = descriptionOf(schema);
  if (!d) return undefined;
  const flat = d.replace(/\s+/g, ' ').trim();
  // Compared on the LEAD (text before the first period), not the first sentence: the real
  // `modoki_mutate_scene` `ops` reads "Ops. setTrait: {…}" — a lowercase continuation, so the
  // sentence split keeps it whole and a whole-sentence compare never matched; the refusal quoted a
  // JSON fragment cut mid-brace instead (#1545 third review).
  const norm = (t: string) => t.replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (norm(flat.split('.')[0]) === norm(name)) return undefined;
  const first = flat.split(/(?<=[.!?])\s+(?=[A-Z`'"(])/)[0];
  if (first.length <= DESCRIPTION_CHARS) return first;
  const cut = first.slice(0, DESCRIPTION_CHARS - 1);
  const space = cut.lastIndexOf(' ');
  return `${space > DESCRIPTION_CHARS / 2 ? cut.slice(0, space) : cut}…`;
}

/** The nested params that declare `key` as one of their own fields, shallowest first —
 *  `entity` for `surface` on `modoki_tap`, `from.entity` + `to.entity` on a drag. */
export function nestedHomesOf(shape: Record<string, unknown>, key: string): NestedHome[] {
  const found: NestedHome[] = [];
  let frontier: Array<[string, Record<string, unknown>]> = [['', shape]];
  for (let depth = 0; depth < MAX_DEPTH && frontier.length; depth++) {
    const next: Array<[string, Record<string, unknown>]> = [];
    for (const [prefix, fields] of frontier) {
      for (const [name, schema] of Object.entries(fields)) {
        for (const { shape: inner, suffix } of objectShapesOf(schema)) {
          const at = `${prefix ? `${prefix}.` : ''}${name}${suffix}`;
          if (Object.prototype.hasOwnProperty.call(inner, key) && !found.some((h) => h.path === at)) {
            found.push({ path: at, description: briefOf(schema, name) });
          }
          next.push([at, inner]);
        }
      }
    }
    if (found.length) return found;
    frontier = next;
  }
  return found;
}

/** "`entity` has a field of that name (entity: Aim at a scene entity…)" — a fact, not advice. A
 *  home's description is quoted once per refusal (`quoted`), however many keys land on it. */
function homeSentence(key: string, homes: NestedHome[], quoted: Set<string>): string {
  const paths = homes.map((h) => `\`${h.path}\``);
  const who = paths.length === 1 ? `${paths[0]} has` : `${paths.slice(0, -1).join(', ')} and ${paths[paths.length - 1]} have`;
  const only = homes.length === 1 ? homes[0] : undefined;
  const brief = only?.description && !quoted.has(only.path) ? ` (${only.path}: ${only.description})` : '';
  if (only) quoted.add(only.path);
  return `'${key}' is not a top-level parameter; ${who} a field of that name${brief}.`;
}

/** Params a tool USED to accept, and what replaced them — so a caller working from an old habit or
 *  an old transcript is told what to do instead, not just that the key is unknown. Only for a
 *  removal whose replacement is a different MOVE; a plain rename needs no entry, since the accepted
 *  list already names the new key. Keyed by tool, because the same word is live elsewhere
 *  (`watch`'s `clear` still means something). */
export const RETIRED_PARAMS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  // #1561: a journal READ used to delete the ring it read (§7). Its one real use was a baseline.
  modoki_journal: { clear: "'clear' was removed — a journal read no longer deletes anything. For a clean baseline, read once (limit:0 is enough) and pass the returned nextCap as sinceCap, with its epoch." },
  device_journal: { clear: "'clear' was removed — a journal read no longer deletes anything. For a clean baseline, read once (limit:0 is enough) and pass the returned nextCap as sinceCap, with its epoch." },
  modoki_editor_journal: { clear: "'clear' was removed — a journal read no longer deletes anything. For a clean baseline, read once (limit:0 is enough) and pass the returned nextSeq as since, with its epoch." },
};

/** The refusal for `keys` (the unknown ones) on `tool`, whose top-level params are `shape`. */
export function unknownParamMessage(tool: string, shape: Record<string, unknown>, keys: readonly string[]): string {
  const params = Object.keys(shape);
  const accepts = `It accepts: ${params.length ? params.join(', ') : '(no parameters)'}.`;
  if (!keys.length) return `${tool} received an unrecognized parameter. ${accepts}`;
  const named = keys.map((k) => `'${k}'`).join(', ');
  const quoted = new Set<string>();
  const retired = RETIRED_PARAMS[tool];
  const homes = keys.flatMap((k) => {
    if (retired && Object.prototype.hasOwnProperty.call(retired, k)) return [retired[k]];
    const found = nestedHomesOf(shape, k);
    return found.length ? [homeSentence(k, found, quoted)] : [];
  });
  const head = keys.length > 1 ? `received unrecognized parameters: ${named}.` : `received an unrecognized parameter: ${named}.`;
  return `${tool} ${head} ${homes.length ? `${homes.join(' ')} ` : ''}${accepts}`;
}

/** The refusal for an unknown key inside a NESTED strict object — an entity aim, a drag endpoint,
 *  a mutate op. `accepts` is that object's own fixed "X accepts only: …" sentence, which used to BE
 *  the whole message: the SDK appends the path (`… at ops.0`) but not the key, so `ops[].values`
 *  came back as "setTrait accepts: op, entity, trait, fields, space at ops.0" and the caller had to
 *  guess which of its keys was wrong. */
export function nestedUnknownKeyMessage(accepts: string, keys: readonly string[]): string {
  if (!keys.length) return accepts;
  return `unrecognized key${keys.length > 1 ? 's' : ''} ${keys.map((k) => `'${k}'`).join(', ')} — ${accepts}`;
}

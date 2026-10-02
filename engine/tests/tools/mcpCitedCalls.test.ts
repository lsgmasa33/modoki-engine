/** Every `modoki_<tool> {param: …}` call that agent-facing text CITES must be a call the surface takes (#2039).
 *
 *  A refusal or a reply that names an exit is an instruction: the agent copies it and calls it. #2039 was two
 *  replies in `agentEditorOps.ts` pointing at `modoki_persistence {op:"resolve-unsaved"}` — a real tool, given a
 *  parameter it has never had (its schema is empty; `resolve-unsaved` is a renderer op only the backend calls). The
 *  agent paid a round-trip to learn that, and the reply had hidden the exits that DO work.
 *
 *  A tool-NAME check could not have caught it: `modoki_persistence` exists. So this reads each cited call's
 *  top-level KEYS and checks them against the schema the tool was REGISTERED with (`mcpSurface.ts` — the real
 *  surface, not a copy of its names).
 *
 *  Scope: every tracked source file outside tests that can carry agent-facing text — the renderer's agent ops, the
 *  backend routes, the engine package and the MCP server's own descriptions — plus `docs/` and `qa/`, which are what an
 *  agent copies a call from most (QA cases are run by agents verbatim). Comments are scanned too: a comment citing a
 *  call is the next author's instruction, and it is where reply text gets copied from. A deliberate WRONG example
 *  (the typo a strict schema exists to catch) is written so it does not read as a call: `modoki_x` called with `{…}`.
 *
 *  Not checked: a bare `param:` with no tool name before it (`prefabAction:'overrides'` in a reply), and nested keys. */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { readScannedSource } from '@modoki/engine/testing';
import { loadSurface, type Surface } from './mcpSurface';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
/** Comments and Markdown are the point: a reply is a string literal, and a comment or a doc citing a call is what the
 *  next author or agent copies — see the header. */
const AS_PROSE = { comments: 'include', reason: 'cited calls live in string literals, comments and Markdown prose alike' } as const;
const ROOTS = ['engine/app', 'engine/plugins', 'engine/packages/modoki/src', 'engine/tools/modoki-mcp/src', 'engine/electron', 'docs', 'qa'];
/** Point-in-time records: a review or a plan quotes the call as it was, and rewriting history to match today's surface
 *  would falsify the record. Everything else in `docs/` and `qa/` is an instruction an agent copies. */
const RECORDS = /^docs\/(reviews|plans)\//;

export type Citation = { tool: string; keys: string[]; at: string };

/** Bracket pairs, position for position. */
const OPENERS = '{[(<';
const CLOSERS = '}])>';

/** The top-level keys of the object literal starting at `text[start] === '{'`, or null when it is not one (no
 *  closing brace on reach, or a body that is not `key: value` pairs — prose like `modoki_x {…}`).
 *
 *  Quote-aware for ', " and ` (TS source escapes them as \' and \" inside a string, and a value is skipped either
 *  way). Nesting of {[(< is tracked so a nested object's keys or an `<placeholder, with commas>` are not read as
 *  top-level. */
export function topLevelKeys(text: string, start: number): string[] | null {
  const keys: string[] = [];
  const stack: string[] = [];
  let i = start + 1;
  let expectKey = true;
  const LIMIT = start + 400;
  while (i < text.length && i < LIMIT) {
    const c = text[i];
    if (c === '\\' && /["'`]/.test(text[i + 1] ?? '')) { i += 1; continue; }
    if (!stack.length && expectKey) {
      const m = /^\s*\\?["']?([A-Za-z_$][\w$]*)\\?["']?\s*:/.exec(text.slice(i, i + 80));
      if (m) { keys.push(m[1]); i += m[0].length; expectKey = false; continue; }
      // Shorthand — `{path, meta, discardUnsaved:true}` names `path` and `meta` with no value.
      const short = /^\s*([A-Za-z_$][\w$]*)\s*(?=[,}])/.exec(text.slice(i, i + 80));
      if (short) { keys.push(short[1]); i += short[0].length; expectKey = false; continue; }
      if (/^\s*\}/.test(text.slice(i))) return keys.length ? keys : null;
      return null;
    }
    if (c === '"' || c === "'" || c === '`') {
      const end = text.indexOf(c, i + 1);
      if (end < 0) return null;
      i = end + 1;
      continue;
    }
    const opener = OPENERS.indexOf(c);
    if (opener >= 0) { stack.push(CLOSERS[opener]); i += 1; continue; }
    if (stack.length && c === stack[stack.length - 1]) { stack.pop(); i += 1; continue; }
    if (!stack.length && c === '}') return keys;
    if (!stack.length && c === ',') expectKey = true;
    i += 1;
  }
  return null;
}

export function citationsIn(text: string, file: string): Citation[] {
  const out: Citation[] = [];
  // `mcp__modoki__modoki_tap {…}` (the client-side name) and `modoki_tap({…})` are citations too; `\b` alone missed the
  // first, since `_` is a word character.
  for (const m of text.matchAll(/(?<![a-z0-9_])(?:mcp__modoki\d*__)?(modoki_[a-z0-9_]+)`?\s?\(?\{/g)) {
    const brace = (m.index ?? 0) + m[0].length - 1;
    const keys = topLevelKeys(text, brace);
    if (!keys) continue;
    const line = text.slice(0, m.index).split('\n').length;
    out.push({ tool: m[1], keys, at: `${file}:${line}` });
  }
  return out;
}

function scannedSources(): Array<{ rel: string; abs: string }> {
  // `floor` fails CLOSED on a scan that found nothing: a moved tree would otherwise pass vacuously (mcpRegistry.test.ts' scar).
  return (repoFiles({ under: ROOTS.map((r) => path.join(REPO, r)), match: /\.(ts|tsx|mts|cts|mjs|md)$/, exclude: ['dist', 'tests', 'test'], floor: 200 }) as Array<{ rel: string; abs: string }>)
    .filter((f) => !/\.test\./.test(f.rel) && !RECORDS.test(f.rel));
}

/** The top-level parameter names a registered tool accepts. */
function paramsOf(s: Surface, tool: string): Set<string> | null {
  const schema = s.schemaFor(tool) as { shape?: Record<string, unknown>; _def?: { shape?: () => Record<string, unknown> } } | undefined;
  if (!schema) return null;
  const shape = schema.shape ?? schema._def?.shape?.();
  return shape ? new Set(Object.keys(shape)) : null;
}

describe('a cited MCP call is one the surface takes (#2039)', () => {
  let s: Surface | undefined;
  afterEach(() => { s?.restore(); s = undefined; });

  it('the extractor reads the keys of a cited call, and only the top level', () => {
    const t = (src: string) => citationsIn(src, 'x').map((c) => `${c.tool}:${c.keys.join(',')}`);
    expect(t(`'modoki_persistence {op:"resolve-unsaved"}'`)).toEqual(['modoki_persistence:op']);
    expect(t(`modoki_load_scene {path:<the open scene, or any>, discardUnsaved:true}`)).toEqual(['modoki_load_scene:path,discardUnsaved']);
    expect(t('modoki_write_asset_meta {path, meta, discardUnsaved:true}')).toEqual(['modoki_write_asset_meta:path,meta,discardUnsaved']);
    expect(t(`modoki_mutate_scene {ops:[{op:'set', field:1}], dryRun:true}`)).toEqual(['modoki_mutate_scene:ops,dryRun']);
    expect(t(`modoki_play_control {"action":"stop"}`)).toEqual(['modoki_play_control:action']);
    expect(t(`modoki_tap {selector: '[data-ui-id=\\"a,b\\"]'}`)).toEqual(['modoki_tap:selector']);
    expect(t('mcp__modoki__modoki_tap {entity:{name:"a"}}')).toEqual(['modoki_tap:entity']);
    expect(t("modoki_list_assets({type: 'texture'})")).toEqual(['modoki_list_assets:type']);
    // Prose in braces is not a call.
    expect(t('modoki_save_all {…} and modoki_refresh { see above }')).toEqual([]);
  });

  it('every cited call names a registered tool and only parameters its schema has', () => {
    s = loadSurface();
    const all: Citation[] = [];
    for (const f of scannedSources()) all.push(...citationsIn(readScannedSource(f.abs, AS_PROSE).raw, f.rel));
    // Measured 2026-10-02: 60+ citations in source alone, more with docs/ and qa/. A floor, so a broken extractor cannot go quietly green.
    expect(all.length).toBeGreaterThan(40);
    const bad: string[] = [];
    for (const c of all) {
      if (!s.names.includes(c.tool)) { bad.push(`${c.at}: ${c.tool} is not a registered tool`); continue; }
      const params = paramsOf(s, c.tool);
      if (!params) { bad.push(`${c.at}: ${c.tool} has no readable schema shape`); continue; }
      const unknown = c.keys.filter((k) => !params.has(k));
      if (unknown.length) bad.push(`${c.at}: ${c.tool} {${unknown.join(', ')}} — it takes ${[...params].join(', ') || 'no parameters'}`);
    }
    expect(bad, `cited calls the surface would refuse — an agent copies these:\n  ${bad.join('\n  ')}\n`).toEqual([]);
  });
});

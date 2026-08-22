/** Render the `modoki_*` tool catalog table from the CONTRACT table — the single source of truth.
 *
 *  WHY GENERATED. The catalog is exactly the kind of doc that drifts: one row per tool of facts
 *  (method, route, does-it-mutate, is-it-undoable, what does it need, how is it aimed) that already
 *  live in `contracts.ts` and were previously restated by hand in prose. A restated fact is a fact
 *  that goes stale silently — which is the same failure mode this whole audit chased through the
 *  code. Generating it means a drifted doc is a RED BUILD (`engine/tests/tools/toolCatalogSync.test.ts`)
 *  rather than something a reader discovers by being misled.
 *
 *  WHAT STAYS HAND-WRITTEN: everything that is judgement rather than fact — the mental model, the
 *  gotchas, which tool to reach for, the live-vs-file rule. Those are the valuable part of
 *  `docs/debug-tools-mcp.md` and no table can carry them.
 *
 *  Side-effect-free — see `context.ts`.
 */

import { CONTRACTS } from './contracts.js';

export const CATALOG_BEGIN = '<!-- BEGIN GENERATED TOOL CATALOG -->';
export const CATALOG_END = '<!-- END GENERATED TOOL CATALOG -->';

/** How a tool's effect lands, in one cell: what it changes and whether Cmd-Z takes it back. */
function effect(name: string): string {
  const c = CONTRACTS[name];
  if (!c.mutating) return 'read-only';
  const where = c.persists === 'none' ? 'no persistence' : c.persists;
  const undo = c.undoable ? ' · undoable' : '';
  // A `read` that mutates is the surface's sharpest edge — it makes VERIFICATION destructive — so it
  // must be impossible to skim past in the row that otherwise sits under "never changes anything".
  const impure = c.kind === 'read' ? ' · **IMPURE READ** (an optional arg destroys state)' : '';
  return `${where}${undo}${impure}`;
}

function endpoint(name: string): string {
  const c = CONTRACTS[name];
  if (!c.route) return '—';
  const op = c.op ? ` \`${c.op}\`` : c.opVaries ? ' *(op = your `action`)*' : '';
  const varies = c.varies ? ` *(${c.varies} varies)*` : '';
  return `${c.method} \`${c.route}\`${op}${varies}`;
}

/** `{a:1}` → `` `{"a":1}` ``, and `{}` → "*(no args)*" — the smallest call, verbatim, so the table
 *  doubles as machine-checked copy-paste documentation. It is the SAME object the T2 fixtures and the
 *  live sweep call each tool with, which is why it cannot rot into a plausible-looking lie. */
function smallestCall(name: string): string {
  const args = CONTRACTS[name].minimalArgs ?? {};
  const keys = Object.keys(args);
  if (!keys.length) return '*(no args)*';
  return `\`${JSON.stringify(args)}\``;
}

export function renderCatalog(): string {
  const names = Object.keys(CONTRACTS).sort();
  const byKind = new Map<string, string[]>();
  for (const n of names) {
    const k = CONTRACTS[n].kind;
    byKind.set(k, [...(byKind.get(k) ?? []), n]);
  }
  // A stable, meaningful order: what you read with, what you change with, then the heavy machinery.
  const KIND_ORDER = ['read', 'mutate', 'asset', 'input', 'control', 'build', 'meta'] as const;
  const KIND_TITLE: Record<string, string> = {
    read: 'Read — answer a question about state (never changes anything)',
    mutate: 'Mutate — change scene/world data',
    asset: 'Asset — read or write an asset definition',
    input: 'Input (Enact) — trusted input injection',
    control: 'Control — drive the editor session, not scene data',
    build: 'Build — long-running toolchain work',
    meta: 'Meta — operates on the tool surface itself',
  };

  const out: string[] = [];
  out.push('');
  out.push(`*${names.length} tools. Generated from \`engine/tools/modoki-mcp/src/contracts.ts\` — do NOT hand-edit;`);
  out.push('run `npm --prefix engine/tools/modoki-mcp run gen:catalog`. A drifted table fails `npm test`.*');
  for (const kind of KIND_ORDER) {
    const list = byKind.get(kind);
    if (!list?.length) continue;
    out.push('');
    out.push(`#### ${KIND_TITLE[kind]}`);
    out.push('');
    out.push('| Tool | Endpoint | Effect | Needs | Aim | Smallest call |');
    out.push('|---|---|---|---|---|---|');
    for (const n of list) {
      const c = CONTRACTS[n];
      out.push([
        `\`${n}\``,
        endpoint(n),
        effect(n),
        c.requires.length ? c.requires.join(' + ') : '—',
        c.aim === 'none' ? '—' : c.aim,
        smallestCall(n),
      ].join(' | ').replace(/^/, '| ') + ' |');
    }
  }
  out.push('');
  return out.join('\n');
}

/** Splice a freshly-rendered catalog between the markers in a doc. Throws if the markers are
 *  missing — a generator that silently appends would produce two catalogs, one of them stale. */
export function spliceCatalog(doc: string, rendered: string = renderCatalog()): string {
  const b = doc.indexOf(CATALOG_BEGIN);
  const e = doc.indexOf(CATALOG_END);
  if (b === -1 || e === -1 || e < b) {
    throw new Error(`the catalog markers (${CATALOG_BEGIN} … ${CATALOG_END}) are missing or out of order`);
  }
  return doc.slice(0, b + CATALOG_BEGIN.length) + '\n' + rendered + doc.slice(e);
}

/** The catalog block currently in a doc, for the sync guard. */
export function extractCatalog(doc: string): string {
  const b = doc.indexOf(CATALOG_BEGIN);
  const e = doc.indexOf(CATALOG_END);
  if (b === -1 || e === -1 || e < b) throw new Error('the catalog markers are missing or out of order');
  return doc.slice(b + CATALOG_BEGIN.length, e);
}

/** Every agent-reachable Node route that touches a `.meta.json` consults the park gate — or is
 *  exempt ON THE RECORD, with a reason (#872/#882).
 *
 *  This is the guard that exists because the defect arrived THREE TIMES. `pendingMeta` is
 *  renderer-only state; a route that reads or writes a sidecar in the Node process cannot see it,
 *  and nothing about writing that route makes its author think about a registry in another
 *  process. `/api/write-meta` destroyed a parked edit, `/api/reimport` baked from the pre-edit
 *  bytes, `/api/duplicate-asset` copied them — each found separately, each individually correct
 *  code. The fourth one is the one this test is for.
 *
 *  ⚠️ **An exemption is a CLAIM, not a silencer.** Each one below says why that route cannot be in
 *  the way, and two of them are load-bearing: the park-preferring read already asks the renderer
 *  (gating it would be circular), and the import route refuses an existing destination, so no park
 *  can be keyed to a path it is about to create. If either of those stops being true the exemption
 *  is wrong and this file is where it gets fixed.
 *
 *  Structural, not behavioural: it reads the router's source. That is deliberate — the behavioural
 *  cover is `plugins/metaParkGate.test.ts`, and a behavioural test can only assert about routes
 *  somebody remembered to write a case for, which is precisely the thing that fails here.
 */

import { describe, it, expect } from 'vitest';
import path from 'path';
import { readScannedSource } from '@modoki/engine/testing';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const REPO = path.resolve(__dirname, '../../..');

/** Source with comments STRIPPED. Load-bearing here, not hygiene: this guard's whole job is to
 *  decide whether a route CALLS `metaParkGate`, and the routes it inspects are heavily commented —
 *  including with the word `metaParkGate` in prose. A raw-text match would let a comment satisfy
 *  the assertion for a route that does not gate at all, and the guard would be green and blind
 *  (#812). `commentStripperIsShared.test.ts` enforces this repo-wide. */
const source = (rel: string): string => readScannedSource(path.join(REPO, rel)).code;
const ROUTER = 'engine/plugins/backend/editorBackendRouter.ts';

/** Anything that reads or writes a sidecar, or runs something that does. `getReimportHandler` is
 *  in the list because the handlers it dispatches to are all read-modify-write over the sidecar —
 *  the route does not name `writeMetaSidecar` itself, which is exactly how `/api/reimport` looked
 *  innocent for a release. */
const SIDECAR_CALLS = /\b(writeMetaSidecar|readMetaSidecar|duplicateAssetFile|getReimportHandler)\s*\(/;

/** Routes that touch a sidecar and deliberately do NOT gate, each with the reason it cannot be in
 *  the way of a parked edit. Keys are the route path exactly as the router spells it. */
const EXEMPT: Record<string, string> = {
  '/api/read-meta':
    "the EDITOR'S OWN disk read — `readMetaPreferringPark` calls it FROM the renderer, so probing "
    + 'the renderer back would be circular for every real caller it has. It is also the read whose '
    + 'X-Meta-Sha256 seeds the CAS baseline; a park is consulted one layer up, by the helper.',
  '/api/asset-meta':
    'the agent read, which already PREFERS the park (#872 read half) by asking the renderer — the '
    + 'gate would be asking the same question twice. Its `readMetaSidecar` call is the labelled '
    + 'disk FALLBACK for when no renderer answered, i.e. exactly the case where no park can exist.',
  '/api/import-file':
    'it REFUSES an existing destination before writing anything, so no park can be keyed to the '
    + 'path it creates. Its optional re-import runs through `/api/reimport`\'s own handler on that '
    + 'brand-new path. ⚠️ If it ever grows an overwrite mode, this exemption is void.',
};

function routeBlocks(src: string): Array<{ route: string; body: string }> {
  // The router is one long `if (urlPath === '…')` chain, so each block runs from its own test to
  // the next one. Crude, and it does not need to be clever: a route that stops matching this shape
  // stops being counted, and the count assertion below is what catches that.
  const re = /if\s*\(\s*urlPath\s*===\s*'([^']+)'/g;
  const starts: Array<{ route: string; at: number }> = [];
  for (let m = re.exec(src); m; m = re.exec(src)) starts.push({ route: m[1], at: m.index });
  return starts.map((s, i) => ({ route: s.route, body: src.slice(s.at, starts[i + 1]?.at ?? src.length) }));
}

describe('the sidecar park gate covers every Node route that could clobber a parked edit', () => {
  const src = source(ROUTER);
  const blocks = routeBlocks(src);

  it('the router still parses into route blocks — the premise of every assertion below', () => {
    // A guard whose parser silently matches nothing passes forever. Pin the shape, not a number
    // that churns: these four routes are the ones this file is about, and all four must be found.
    expect(blocks.length).toBeGreaterThan(50);
    const found = blocks.map((b) => b.route);
    for (const r of ['/api/write-meta', '/api/reimport', '/api/duplicate-asset', '/api/read-meta']) {
      expect(found, `route block not found: ${r}`).toContain(r);
    }
  });

  it('every sidecar-touching route either gates or is exempt with a reason', () => {
    const ungated = blocks
      .filter((b) => SIDECAR_CALLS.test(b.body))
      .filter((b) => !/\bmetaParkGate\s*\(/.test(b.body))
      .filter((b) => !(b.route in EXEMPT))
      .map((b) => b.route);

    expect(
      ungated,
      'these routes read or write a .meta.json in the Node process without consulting the '
      + 'renderer\'s pendingMeta registry. Either call metaParkGate (see /api/write-meta for the '
      + 'DESTROYED shape and /api/reimport for the UN-INCLUDED one), or add the route to EXEMPT '
      + 'with the reason a parked edit cannot be in its way.',
    ).toEqual([]);
  });

  it('EXEMPT names no route that has left the router, and none that now gates', () => {
    // The same ledger rule every other list in this repo carries: a stale exemption rots into a
    // blanket one, and the next genuine gap lands on it unnoticed.
    const byRoute = new Map(blocks.map((b) => [b.route, b.body]));
    const stale = Object.keys(EXEMPT).filter((r) => !byRoute.has(r));
    expect(stale, 'delete these — no such route').toEqual([]);
    const nowGated = Object.keys(EXEMPT).filter((r) => /\bmetaParkGate\s*\(/.test(byRoute.get(r) ?? ''));
    expect(nowGated, 'these gate now — drop the exemption rather than carrying both').toEqual([]);
  });

  it('no OTHER tracked file reaches the sidecar helpers from a backend route', () => {
    // The corpus is enumerated through git, not a filesystem walk: an untracked scratch file is not
    // part of the shipped surface, and a walk would either miss a new tracked file under a
    // directory nobody thought to list, or fail on a stray one.
    // `repoFiles` is the ONE corpus producer (#799/#771/#805) — a hand-rolled `git ls-files` spawn
    // misses untracked-but-real files and re-derives the dedup/relative-path handling badly. The
    // floor is what stops a filter that silently empties the corpus from passing forever.
    const tracked = repoFiles({ under: 'engine/plugins', match: /\.ts$/, floor: 20 })
      .map(({ rel }) => rel);
    // The files allowed to call these helpers directly. Everything here is either the helper
    // module itself, a build-time/static path with no editor attached, or a re-import handler —
    // which is reached ONLY through `/api/reimport`, and that route is gated.
    const ALLOWED = new Set([
      'engine/plugins/meta-sidecar.ts', 'engine/plugins/asset-fs-ops.ts',
      'engine/plugins/reimport-registry.ts', // declares getReimportHandler; dispatches, never writes
      'engine/plugins/asset-tree-shaker.ts', 'engine/plugins/vite-asset-scanner.ts',
      'engine/plugins/backend/editorBackendRouter.ts', 'engine/plugins/backend/staticAssets.ts',
      'engine/plugins/reimport-atlas.ts', 'engine/plugins/reimport-audio.ts',
      'engine/plugins/reimport-environment.ts', 'engine/plugins/reimport-font.ts',
      'engine/plugins/reimport-model.ts', 'engine/plugins/reimport-texture.ts',
      'engine/plugins/reimport-video.ts',
    ]);
    const strays = tracked
      .filter((f) => SIDECAR_CALLS.test(source(f)))
      .filter((f) => !ALLOWED.has(f));

    expect(
      strays,
      'a new Node-side file reads or writes a .meta.json. If it is reachable from an agent route, '
      + 'that route needs metaParkGate; if it is not, add it to ALLOWED with that reasoning.',
    ).toEqual([]);
    // …and the ledger does not outlive its entries.
    expect([...ALLOWED].filter((f) => !tracked.includes(f)), 'delete these — no such file').toEqual([]);
  });

  it('the RENDERER side of the gate is wired — the exemption and the flush (#872/#882 review)', () => {
    // The gate was put on the ROUTE, and the route is not agent-only. Two renderer paths have to
    // hold up their end, and both failures were invisible from the backend:
    //
    //  • `writeMetaConditional` is the ONE definition of the renderer's /api/write-meta POST. Its
    //    callers all load through `readMetaPreferringPark`, so their document already CONTAINS the
    //    parked edit — without `rendererWrite` the gate refused a human's Sprite Editor save and
    //    the 409 was reported as "the file changed on disk", a wrong diagnosis of an unchanged file.
    //  • the Assets panel's Duplicate seeds the copy from the source's FILE, so it flushes the
    //    source's park first — the click is the human's consent, the same call
    //    `assetViews/reimport.ts` already makes. Without it, Duplicate simply failed.
    //
    // The paren is required in both patterns: without it the assertion is satisfied by the import
    // line, and the guard passes for a file that only mentions the symbol.
    const widgets = source('engine/packages/modoki/src/editor/panels/assetViews/widgets.tsx');
    expect(/writeMetaConditional\s*\(/.test(widgets), 'writeMetaConditional is gone or renamed — re-point this guard').toBe(true);
    expect(/rendererWrite:\s*true/.test(widgets),
      "the renderer's own /api/write-meta POST must declare `rendererWrite: true`, or the park gate "
      + "refuses the editor's own saves — the Sprite Editor and 9-slice editor cannot save while an "
      + 'Inspector import-settings edit is parked').toBe(true);

    const assetOps = source('engine/packages/modoki/src/editor/panels/assetOps.ts');
    expect(/flushPendingMetaFor\s*\(/.test(assetOps),
      "the Assets panel's duplicate must flush the SOURCE's parked import-settings edit first — "
      + 'otherwise the copy is born from pre-edit bytes, and since the route gates on a park the '
      + 'duplicate fails outright').toBe(true);
  });
});

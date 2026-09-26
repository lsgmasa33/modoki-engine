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
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const REPO = path.resolve(__dirname, '../../..');

/** Source with comments STRIPPED. Load-bearing here, not hygiene: this guard's whole job is to
 *  decide whether a route CALLS `metaParkGate`, and the routes it inspects are heavily commented —
 *  including with the word `metaParkGate` in prose. A raw-text match would let a comment satisfy
 *  the assertion for a route that does not gate at all, and the guard would be green and blind
 *  (#812). `commentStripperIsShared.test.ts` enforces this repo-wide. */
const source = (rel: string): string => readScannedSource(path.join(REPO, rel)).code;
const ROUTER = 'engine/plugins/backend/editorBackendRouter.ts';

/** Anything that reads or writes PROJECT CONTENT in the Node process, or runs something that does.
 *
 *  ⚠️ **Widened from "touches a sidecar" to "reads asset content" (#889).** The old set was
 *  `writeMetaSidecar|readMetaSidecar|duplicateAssetFile|getReimportHandler`, which described the
 *  three routes #872/#882 happened to fix rather than the mechanism — so `/api/unused-assets` and
 *  `/api/find-references`, which read every scene, prefab, material and atlas off disk and feed a
 *  DELETE, were never even candidates. `getReimportHandler` stays because the handlers it
 *  dispatches to are all read-modify-write over the sidecar and the route names none of them,
 *  which is exactly how `/api/reimport` looked innocent for a release.
 *
 *  This nets routes that legitimately do not care (`/api/read-file` serving bytes). That is the
 *  intended trade: `EXEMPT` is the honest home for those, and a declaration a reader can check
 *  beats a trigger tuned until nothing inconvenient matches. */
const CONTENT_CALLS = /\b(writeMetaSidecar|readMetaSidecar|duplicateAssetFile|getReimportHandler|readFileSync|computeUnused|computeRefEdges|validateSceneData|validatePrefabData|moveToTrash|moveAssetFile|writeFileSync)\s*\(/;

/** Every registry name in the vocabulary, and the subset that holds an unsaved DOCUMENT. The split
 *  exists because `openAssetEditor` (#1362) is not a registry of parked documents — it is "a modal
 *  is holding edits in component state" — so the callers that mean "every document" say so. */
const DOCUMENT_REGISTRY_NAMES = ['dirtyAsset', 'pendingMeta', 'pendingBaseScene', 'liveScene'] as const;
const ALL_REGISTRY_NAMES = [...DOCUMENT_REGISTRY_NAMES, 'openAssetEditor'] as const;

/** The registries each trigger symbol's INPUTS can live in.
 *
 *  ⚠️ **This is the hole the old guard could not see, and it is not hypothetical.**
 *  `duplicateAssetFile` was ALREADY a trigger, and `/api/duplicate-asset` ALREADY contained a
 *  `metaParkGate(` call — so the guard was satisfied while the gate covered ONE of the helper's two
 *  branches. The `.json` branch copied the source DOCUMENT with nothing consulted, which is #889
 *  member 4. Presence of a gate call is not coverage; asking about the right registries is.
 *
 *  `duplicateAssetFile` maps to all four because `ext === '.json'` catches `.scene.json` and
 *  `.prefab.json` as well as the nine asset-schema types — so the OPEN scene's live-world edits
 *  are in scope, and a `dirtyAsset`-only widening would have sailed straight past the worst case. */
const HELPER_REGISTRIES: Record<string, readonly string[]> = {
  writeMetaSidecar: ['pendingMeta'],
  readMetaSidecar: ['pendingMeta'],
  getReimportHandler: ['pendingMeta'],
  duplicateAssetFile: ['dirtyAsset', 'pendingMeta', 'pendingBaseScene', 'liveScene'],
  computeUnused: ['dirtyAsset', 'pendingBaseScene', 'liveScene'],
  computeRefEdges: ['dirtyAsset', 'pendingBaseScene', 'liveScene'],
  // A raw read says nothing about WHAT was read, so it declares nothing and merely has to be
  // gated or exempt. Narrowing this by guessing at the filename would be a trigger tuned to
  // pass.
  readFileSync: [],
  // ⚠️ Added in phase 2 so the two validators are checked rather than merely counted. Both routes
  // trigger on `readFileSync` too, and that maps to `[]` — so without these rows the superset
  // check is VACUOUS for them and the guard degrades to "does the word unsavedGate appear",
  // which is the presence test #889 already found insufficient once.
  //
  // ⚠️ **Got wrong TWICE, in both directions, so the reasoning is written out.** It first said
  // `['dirtyAsset', 'pendingBaseScene', 'liveScene']` "for the same reason as computeUnused" —
  // false: computeUnused really does read material documents for refs, while `makeAssetResolver`
  // is a membership test over manifest GUIDs and `validateSceneData` takes only `getPrefab` +
  // `assetExists`. The correction then over-swung and dropped `pendingMeta` too, which was an
  // UNDER-declaration and hence the dangerous direction.
  //
  // The question is NOT "which pass reads that file" — it is "can that park change what these
  // two resolvers ANSWER":
  //   • `pendingMeta` — YES, through the manifest. `vite-asset-scanner` resolves a texture's
  //     `textureType` from the sidecar and emits the auto whole-image `sprite` sub-entry only for
  //     `2d`/`ui`, so a parked Type change deletes a guid the scene references.
  //   • `liveScene`  — YES. `makePrefabResolver` reads prefab documents, and prefab-edit is the
  //     only registry state that can hold an unsaved prefab.
  //   • `pendingBaseScene` — NO. `sceneValidation.ts` contains "baseScene" zero times.
  //   • `dirtyAsset` — NO. A parked asset document changes no manifest entry `assetExists` tests.
  validateSceneData: ['pendingMeta', 'liveScene'],
  // The prefab pass consults NO resolver — one document, the inert-size rule. The only registry
  // that can hold a `.prefab.json` is `liveScene`, via prefab-edit (a prefab is not an
  // `AssetSchemaType`, so `dirtyAsset` never holds one).
  validatePrefabData: ['liveScene'],
  // ⚠️ Added in phase 3 to close a PROSE-ONLY gap. `docs/mcp-persistence.md` named
  // /api/write-file, /api/move-file and /api/delete-asset in its list of routes that touch content
  // the editor can hold — but they matched NO trigger, so this guard never classified them and
  // that doc list read as a ledger the guard keeps when for those three it was prose. All three
  // turn out to be exempt, and the point is that they are now exempt ON THE RECORD rather than
  // merely unexamined. The difference shows up the day one of them grows a branch.
  // ⚠️ DERIVED, not copied. These two decide `needed` for the move and delete routes, so a stale
  // copy here is the one whose staleness costs most — a registry added to the vocabulary would never
  // reach those routes' `needed` and the gap would be silent (#1362 review, F12).
  moveToTrash: DOCUMENT_REGISTRY_NAMES,
  moveAssetFile: DOCUMENT_REGISTRY_NAMES,
  // Same argument as readFileSync: a raw write says nothing about WHAT was written.
  writeFileSync: [],
};

/** The `registries: [...]` a route DECLARES on its `unsavedGate` call.
 *
 *  ⚠️ **The literal is a convention this guard depends on.** A `registries` built in a variable is
 *  unreadable from stripped source and the check silently degrades to the old presence test — the
 *  exact vacuity being fixed. Spell it inline at the call site. */
function declaredRegistries(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/registries:\s*(ALL_UNSAVED_REGISTRIES|DOCUMENT_UNSAVED_REGISTRIES|\[([^\]]*)\])/g)) {
    if (m[1] === 'ALL_UNSAVED_REGISTRIES') {
      for (const r of ALL_REGISTRY_NAMES) out.add(r);
      continue;
    }
    // #1362: the stale-read disclosures ask for the DOCUMENT registries by name, because
    // `openAssetEditor` is a modal holding component state and says nothing about a stale read.
    if (m[1] === 'DOCUMENT_UNSAVED_REGISTRIES') {
      for (const r of DOCUMENT_REGISTRY_NAMES) out.add(r);
      continue;
    }
    for (const q of (m[2] ?? '').matchAll(/'([^']+)'/g)) out.add(q[1]);
  }
  return [...out];
}

/** Routes that read project content and deliberately do NOT gate, each with the reason unsaved
 *  editor state cannot be in its way. Keys are the route path exactly as the router spells it.
 *
 *  ⚠️ **`registries` narrows an exemption to specific ones** (#889); omitted means fully exempt.
 *  The dimension exists because an exemption's REASONING is usually registry-specific even when
 *  its effect is total — `/api/read-meta` is circular for `pendingMeta` in particular — and
 *  without it, a route that later needs gating for one registry and not another has to be either
 *  wholly exempt or wholly gated, which is how a narrow exemption rots into a blanket one. */
const EXEMPT: Record<string, { reason: string; registries?: readonly string[] }> = {
  // ── The two move/delete routes. FULLY exempt (no `registries`), because the reasoning is total
  //    rather than per-registry — and note they can never satisfy `gapsNowGated`, since the
  //    correct implementation of these routes calls no gate at all. ──
  // ⚠️ PARTIALLY exempt since #1362 (owner, 2026-09-18) — the four REGISTRY registries only. The
  //    route gates `openAssetEditor`, so this row no longer covers it.
  '/api/move-file': { registries: ['dirtyAsset', 'pendingMeta', 'pendingBaseScene', 'liveScene'], reason:
    'GATING THESE FOUR WOULD BE WRONG: the gate would refuse a rename BECAUSE the file being '
    + 'renamed has unsaved edits, which is precisely the case the repair exists to carry across. A '
    + 'file must stay renameable while it is being edited. Instead the route REPAIRS every '
    + 'path-keyed registry, and does so by DERIVATION — `PARKED_MOVE_REPAIRS` '
    + '(assetEditorBindings.ts) `satisfies Record<PathKeyedCause, ...>`, where `PathKeyedCause` is '
    + 'the `keying:\'path\'` slice of `CAUSE_SPECS` — so a fourth path-keyed registry cannot '
    + 'compile without a repair. '
    + '⚠️ VOID if that repair stops being derived: "it repairs them" was true of the hand-written '
    + 'version too, right up until it was two of three (#972) and nothing said so. '
    + '⚠️ AND IT DOES NOT EXTEND TO `openAssetEditor` (#1362): that reasoning rests entirely on the '
    + 'repair being able to carry the work across, and the Sprite/9-slice editors hold their edits '
    + 'in component state, in NO registry, so there is nothing to re-point — observed live, a move '
    + 'unmounted the modal and its unsaved slices were gone with `unsavedChanges` still false. The '
    + 'owner ruled the move REFUSES there (2026-09-18), on the modals\' own rule that Save and '
    + 'Cancel are the only exits. So: renameable while edited, EXCEPT when the only copy of the '
    + 'edit would die with the move.', },
  // ⚠️ NOT the move-file exemption any more (#1215 A-7, owner 2026-09-15). A move CARRIES the work
  // across; a delete DESTROYS it, and the "drops are reported" note reached only the agent that
  // caused them. The AGENT path now gates the three path-keyed registries the repair drops; the
  // renderer's own deletes (`rendererWrite`) do not. What is left exempt is `liveScene` alone.
  '/api/delete-asset': { registries: ['liveScene'], reason:
    'trashing the file the live world was loaded from destroys nothing in the live world — the '
    + 'human\'s next save writes it back — so refusing on it would be a false alarm. The three '
    + 'path-keyed registries the delete repair actually DROPS are gated.', },
  // ⚠️ REINSTATED (#1305, owner 2026-09-17). The close-out briefly deducted this row, because an
  // automatic local-half heal was scheduled from here and that heal DID need the gate. The owner
  // then chose the button over the automatic heal, so the route went back to reading only — it
  // reports the gap in a header and repairs nothing — and the original reasoning is load-bearing
  // again, unchanged.
  '/api/read-meta': { registries: ['pendingMeta'], reason:
    "the EDITOR'S OWN disk read — `readMetaPreferringPark` calls it FROM the renderer, so probing "
    + 'the renderer back would be circular for every real caller it has. It is also the read whose '
    + 'X-Meta-Sha256 seeds the CAS baseline; a park is consulted one layer up, by the helper.', },
  '/api/asset-meta': { registries: ['pendingMeta'], reason:
    'the agent read, which already PREFERS the park (#872 read half) by asking the renderer — the '
    + 'gate would be asking the same question twice. Its `readMetaSidecar` call is the labelled '
    + 'disk FALLBACK for when no renderer answered, i.e. exactly the case where no park can exist.', },
  // ── Reads that touch no registry-backed content at all (#889's widened trigger nets them
  //    because they call readFileSync; the trade is deliberate — see CONTENT_CALLS). ──
  '/api/font-axes': { reason: 'reads the FONT BINARY to enumerate variable axes. A font file is not an editor document; no registry holds one.' },
  '/api/read-file': { reason: 'serves SOURCE/art bytes under resolveSourcePath (a .psd, an .aseprite) — inputs to the import pipeline, not documents any panel edits.' },
  '/api/source-image': { reason: 'same as /api/read-file, for the image half.' },
  '/api/adopt-file': { reason: 'copies an OUTSIDE file into the project. Its source is not under an asset root, so no registry can be keyed to it, and its destination is new.' },
  '/api/layout': { reason: 'reads editor WINDOW layouts from the user profile — chrome state, not project content, and not under any asset root.' },
  '/api/layout-delete': { reason: 'same store as /api/layout.' },
  '/api/ota/keys': { reason: 'reads the OTA signing keypair from the user profile. Not project content and never opened in a panel.' },
  // ── One of the three `docs/mcp-persistence.md` named and this guard could not previously see
  //    (#889 phase 3). Its two siblings are in KNOWN_GAPS below — they repair MOST of what they
  //    touch, and "most" is a gap, not an exemption. ──
  '/api/write-file': { reason:
    'renderer-only. It has NO entry in engine/tools/modoki-mcp/src/contracts.ts, so no agent tool '
    + 'calls it DIRECTLY. Three reach it THROUGH the renderer — create_registered_asset, prefab '
    + 'create and save_all (an earlier version of this reason said "no agent tool reaches it", '
    + 'which was false; #1215) — but every one of those writes is issued BY the renderer, which '
    + 'holds the registries, and the route fingerprints EVERY write through markEditorWrite, the '
    + 'same assertion selfWrite makes on /api/asset-write: a write issued from the renderer is '
    + 'never blind to the registry. VOID the day it gains an MCP contract — it would then need '
    + 'asset-write selfWrite split, because the renderer half must not be gated.', },
  '/api/import-file': { reason:
    'it REFUSES an existing destination before writing anything, so no park can be keyed to the '
    + 'path it creates. Its optional re-import runs through `/api/reimport`\'s own handler on that '
    + 'brand-new path. ⚠️ If it ever grows an overwrite mode, this exemption is void.', },
};

/** The registries a route's EXEMPT row is scoped to, or undefined for a full (or absent) exemption.
 *  An EMPTY `registries: []` is refused by its own test below: it would leave the route ledger while
 *  spending nothing on the pair ledger, a pardon neither side could ever find stale. */
const scopedRegistries = (route: string): readonly string[] | undefined =>
  Object.hasOwn(EXEMPT, route) && EXEMPT[route].registries?.length ? EXEMPT[route].registries : undefined;

/** Trigger calls a registry scope cannot speak for: a raw read/write maps to no registry (see
 *  HELPER_REGISTRIES), and a trigger absent from that table declares none. A route making one must
 *  gate or be exempt at ROUTE grain, whatever its scoped row says. */
const unscopedTriggers = (body: string): string[] =>
  [...body.matchAll(new RegExp(CONTENT_CALLS.source, 'g'))].map((m) => m[1]!)
    .filter((sym) => !(HELPER_REGISTRIES[sym]?.length));

/** Routes that DO read content the editor can hold unsaved, and are **not fixed yet**.
 *
 *  ⚠️ **This is deliberately NOT part of `EXEMPT`, and the separation is the point.** An exemption
 *  says "unsaved state cannot be in this route's way"; these say "it can, we know, and here is the
 *  ticket". Folding them into one table is how a documented gap becomes a licence — the next reader
 *  finds the route listed in something called EXEMPT and concludes it was considered and cleared.
 *
 *  Each entry MUST name an issue, asserted below.
 *
 *  Every route #889 filed is now gated: phase 1 took `/api/duplicate-asset`, `/api/unused-assets`
 *  and `/api/find-references`; phase 2 the two validators (DISCLOSE, owner 2026-09-09 — they answer
 *  200 with a caveat rather than refusing); phase 3 `/api/scene-mutate` and `/api/asset-write`.
 *
 *  ⚠️ **What remains is a DIFFERENT defect, found by making these two routes visible to this guard
 *  at all.** They were about to be exempted on the grounds that they repair the registries
 *  themselves — which is true for `dirtyAsset` and `pendingMeta` and FALSE for `pendingBaseScene`:
 *  `assetEditorBindings.ts` does not mention that registry anywhere. "Repairs most of what it
 *  touches" is a gap, not an exemption, and writing it as one is how a defect starts reading as a
 *  decision — which is the exact thing the two-table split exists to prevent. */
const KNOWN_GAPS: Record<string, { issue: string; reason: string }> = {
  // Empty, and deliberately KEPT rather than deleted along with its last entries. The two that
  // lived here (`/api/move-file`, `/api/delete-asset`, both #972) are now EXEMPT above: the repair
  // they were waiting on is complete and DERIVED. The table stays because the split between "we
  // considered this and it cannot apply" and "it can apply, we know, here is the ticket" is what
  // stops a documented gap from reading as a decision — and the next gap needs somewhere honest to
  // go on the day it is found, not a reason to widen EXEMPT.
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
    // On the shared ledger since #1140: FULL EXEMPT rows and KNOWN_GAPS are SPENT by an ungated
    // sidecar-touching route, so a row whose route now gates (or left the router) reports as
    // blessing more than exists. A REGISTRY-SCOPED row is not a route-grain pardon and is not
    // spent here: it pardons (route, registry) pairs, and it legitimately coexists with a gate for
    // the registries it does not cover, so spending it against UNGATED routes made a correct
    // scoped gate impossible to write (#1140 close-out). Its registry-backed calls are answered by the
    // pair-grain ledger in the next test instead: a scoped row whose route reaches no pardoned
    // registry is stale there, and deleting the row puts the route back here. A scoped route that
    // makes a call no registry covers (a raw readFileSync/writeFileSync) STAYS here, because its scope
    // cannot pardon that — the second review found a raw write in /api/read-meta green otherwise.
    const ungated = blocks
      .filter((b) => CONTENT_CALLS.test(b.body))
      .filter((b) => !/\bunsavedGate\s*\(/.test(b.body))
      .filter((b) => !scopedRegistries(b.route) || unscopedTriggers(b.body).length > 0)
      .map((b) => ({ item: b.route, site: b.route }));
    assertExemptionLedger({
      label: 'EXEMPT + KNOWN_GAPS in unsavedGateCoverage (routes)',
      population: ungated,
      exempt: [
        ...Object.entries(EXEMPT).filter(([, e]) => !e.registries).map(([item, e]) => ({ item, reason: e.reason })),
        ...Object.entries(KNOWN_GAPS).map(([item, g]) => ({ item, reason: `${g.issue}: ${g.reason}` })),
      ],
      floor: 1,
      fix: 'these routes read project content in the Node process without asking the renderer what it '
        + 'holds. Three honest resolutions, and only three: call unsavedGate (see /api/write-meta for '
        + 'the `destroys` shape, /api/duplicate-asset for `stale-write`, /api/unused-assets for '
        + '`stale-read`); add to EXEMPT if unsaved state genuinely CANNOT be in the way, with that '
        + 'reason; or add to KNOWN_GAPS with an issue number if it can and is not fixed yet. '
        + '⚠️ Do NOT put a known gap in EXEMPT — that is how a defect starts reading as a decision.',
    });
  });

  it('a gated route DECLARES every registry its own helpers can read (#889)', () => {
    // ⚠️ THE HOLE THE OLD GUARD COULD NOT SEE. It asked "does this route call the gate?", which
    // `/api/duplicate-asset` answered YES while gating one of `duplicateAssetFile`'s two branches.
    // Presence of a call is not coverage. This asks the harder question: does the route's DECLARED
    // scope cover the registries its own trigger symbols can reach?
    //
    // ⚠️ Mutation check for THIS assertion: narrow `/api/duplicate-asset`'s `registries` back to
    // ['pendingMeta'] and it must go red naming `dirtyAsset, pendingBaseScene, liveScene`. If it
    // stays green, `declaredRegistries` has stopped reading the literal — see its docblock.
    //
    // On the shared ledger at (route, registry) grain since #1140: every registry a route's helpers
    // can reach and its gate does not declare is one occurrence, and a registry-scoped EXEMPT row
    // spends exactly the pairs it names. The population is every GATED route plus every route
    // carrying a scoped row (gated or not) — the latter is where the previous test hands them.
    const uncovered: { item: string; site: string }[] = [];
    let examined = 0;
    for (const b of blocks) {
      const gated = /\bunsavedGate\s*\(/.test(b.body);
      if (!gated && !scopedRegistries(b.route)) continue;
      const needed = new Set<string>();
      for (const [symbol, registries] of Object.entries(HELPER_REGISTRIES)) {
        if (!new RegExp(`\\b${symbol}\\s*\\(`).test(b.body)) continue;
        for (const r of registries) needed.add(r);
      }
      const declared = new Set(gated ? declaredRegistries(b.body) : []);
      for (const r of needed) {
        examined++;
        if (!declared.has(r)) uncovered.push({ item: `${b.route}::${r}`, site: `${b.route} declares [${[...declared].join(', ')}]` });
      }
    }
    assertExemptionLedger({
      label: 'registry-scoped EXEMPT in unsavedGateCoverage (route::registry)',
      population: uncovered,
      exempt: Object.entries(EXEMPT).flatMap(([route, e]) =>
        (e.registries ?? []).map((r) => ({ item: `${route}::${r}`, reason: e.reason }))),
      // Every (route, registry) pair a gated or scoped route can reach — covered or not. The
      // uncovered ones shrink to nothing once every scoped row is gone, and that must stay green.
      scanned: examined,
      floor: 5,
      fix: 'these routes can reach a registry their gate does not declare — so the gate (if any) runs '
        + 'and the uncovered registry is exactly as invisible as before. Widen the `registries` '
        + 'literal on the unsavedGate call, narrow HELPER_REGISTRIES if the helper genuinely cannot '
        + 'reach that registry from here, or scope an EXEMPT row to that registry with its reason.',
    });
  });

  it('declaredRegistries can actually READ the literal — its own positive control', () => {
    // ⚠️ Without this, every assertion above is satisfied by a reader that returns nothing:
    // `needed` minus an empty `declared` would be non-empty and the guard would go red for the
    // wrong reason — or, worse, a `needed` that is also empty makes both sides vacuous and it
    // passes forever. Pin that the parser sees a real declaration in the real router.
    const dup = blocks.find((b) => b.route === '/api/duplicate-asset');
    expect(dup, 'route block missing — re-point this guard').toBeDefined();
    expect(declaredRegistries(dup!.body).sort())
      .toEqual(['dirtyAsset', 'liveScene', 'pendingBaseScene', 'pendingMeta']);

    const write = blocks.find((b) => b.route === '/api/write-meta');
    expect(declaredRegistries(write!.body), 'the scoped case must read as scoped, not as everything')
      .toEqual(['pendingMeta']);
  });

  it('EXEMPT names no route that has left the router, and none that now gates', () => {
    // The same ledger rule every other list in this repo carries: a stale exemption rots into a
    // blanket one, and the next genuine gap lands on it unnoticed.
    const byRoute = new Map(blocks.map((b) => [b.route, b.body]));
    const stale = Object.keys(EXEMPT).filter((r) => !byRoute.has(r));
    expect(stale, 'delete these — no such route').toEqual([]);
    // Only a FULL exemption is contradicted by gating; a registry-scoped one deliberately
    // coexists with a gate for the registries it does not cover.
    const nowGated = Object.keys(EXEMPT)
      .filter((r) => !EXEMPT[r].registries)
      .filter((r) => /\bunsavedGate\s*\(/.test(byRoute.get(r) ?? ''));
    expect(nowGated, 'these gate now — drop the exemption rather than carrying both').toEqual([]);
    // Every exemption still carries a REASON. An entry that decayed to an empty string is a
    // blanket exemption wearing a ledger's clothes.
    const unreasoned = Object.entries(EXEMPT).filter(([, e]) => !e.reason.trim()).map(([r]) => r);
    expect(unreasoned, 'an exemption without a reason is not an exemption').toEqual([]);
    // `registries: []` scopes the exemption to nothing, and would be spent by neither ledger.
    const emptyScope = Object.entries(EXEMPT).filter(([, e]) => e.registries?.length === 0).map(([r]) => r);
    expect(emptyScope, 'drop `registries` for a full exemption, or name the registries it covers').toEqual([]);

    // KNOWN_GAPS carries the same ledger rules, plus the one that keeps it from decaying into a
    // second EXEMPT: every entry names an issue.
    const staleGaps = Object.keys(KNOWN_GAPS).filter((r) => !byRoute.has(r));
    expect(staleGaps, 'delete these — no such route').toEqual([]);
    const gapsNowGated = Object.keys(KNOWN_GAPS).filter((r) => /\bunsavedGate\s*\(/.test(byRoute.get(r) ?? ''));
    expect(gapsNowGated, 'these gate now — close the issue and delete the entry').toEqual([]);
    const unticketed = Object.entries(KNOWN_GAPS)
      .filter(([, g]) => !/#\d+/.test(g.issue)).map(([r]) => r);
    expect(unticketed, 'a known gap without an issue number is an undocumented defect').toEqual([]);
    const bothTables = Object.keys(KNOWN_GAPS).filter((r) => r in EXEMPT);
    expect(bothTables, 'a route is EXEMPT or a KNOWN GAP, never both — they say opposite things').toEqual([]);
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
    // The files allowed to call these helpers directly — keyed per FILE (whether a file sits behind an
    // agent route is a property of the file) and spent through the shared ledger since #1140. The
    // old staleness check only asked a row's file still EXISTED, not that it still read or wrote a
    // .meta.json, so a file that stopped touching sidecars kept a pardon for whatever it did next.
    const ALLOWED: ReadonlyArray<{ item: string; reason: string }> = [
      { item: 'engine/plugins/meta-sidecar.ts', reason: 'the sidecar helper module itself' },
      { item: 'engine/plugins/asset-fs-ops.ts', reason: 'the sidecar helper module itself' },
      { item: 'engine/plugins/takeAssets.ts', reason: '#1509: READS .meta.json bytes (hashing + GUID index), writes nothing, so it cannot clobber a parked edit. Behind POST /api/record/fingerprint, which the recorder calls only after refusing to record on hasUnsavedChanges() — every cause, parked asset docs and import settings included — so disk IS what the take plays' },
      { item: 'engine/plugins/reimport-registry.ts', reason: 'declares getReimportHandler; dispatches, never writes' },
      { item: 'engine/plugins/asset-tree-shaker.ts', reason: 'a build-time / static path with no editor attached' },
      { item: 'engine/plugins/vite-asset-scanner.ts', reason: 'a build-time / static path with no editor attached' },
      { item: 'engine/plugins/backend/editorBackendRouter.ts', reason: 'the router itself — its sidecar-touching ROUTES are checked one by one by the route-block tests above (unsavedGate, EXEMPT, KNOWN_GAPS)' },
      { item: 'engine/plugins/backend/staticAssets.ts', reason: 'a build-time / static path with no editor attached' },
      { item: 'engine/plugins/reimport-atlas.ts', reason: 'a re-import handler — reached ONLY through /api/reimport, and that route is gated' },
      { item: 'engine/plugins/reimport-audio.ts', reason: 'a re-import handler — reached ONLY through /api/reimport, and that route is gated' },
      { item: 'engine/plugins/reimport-environment.ts', reason: 'a re-import handler — reached ONLY through /api/reimport, and that route is gated' },
      { item: 'engine/plugins/reimport-font.ts', reason: 'a re-import handler — reached ONLY through /api/reimport, and that route is gated' },
      { item: 'engine/plugins/reimport-model.ts', reason: 'a re-import handler — reached ONLY through /api/reimport, and that route is gated' },
      { item: 'engine/plugins/reimport-texture.ts', reason: 'a re-import handler — reached ONLY through /api/reimport, and that route is gated' },
      { item: 'engine/plugins/reimport-video.ts', reason: 'a re-import handler — reached ONLY through /api/reimport, and that route is gated' },
      // ── #889's widened trigger nets every Node file that calls readFileSync. These are
      //    BUILD-TIME converters, native-config writers and device tooling: none of them runs
      //    behind an editor route, and none reads a document any panel can hold unsaved. They are
      //    listed individually rather than excluded by a path pattern, because a pattern would
      //    silently absorb a future file that DOES sit behind a route.
      { item: 'engine/plugins/addNativeTarget.ts', reason: '#889 widened trigger: build-time converter / native-config writer / device tooling, behind no editor route' },
      { item: 'engine/plugins/audio-convert.ts', reason: '#889 widened trigger: build-time converter / native-config writer / device tooling, behind no editor route' },
      { item: 'engine/plugins/backend/deviceConnection.ts', reason: '#889 widened trigger: build-time converter / native-config writer / device tooling, behind no editor route' },
      { item: 'engine/plugins/backend/deviceCrashReports.ts', reason: '#889 widened trigger: build-time converter / native-config writer / device tooling, behind no editor route' },
      { item: 'engine/plugins/backend/wdaLauncher.ts', reason: '#889 widened trigger: build-time converter / native-config writer / device tooling, behind no editor route' },
      { item: 'engine/plugins/detect-modules.ts', reason: '#889 widened trigger: build-time converter / native-config writer / device tooling, behind no editor route' },
      { item: 'engine/plugins/env-convert.ts', reason: '#889 widened trigger: build-time converter / native-config writer / device tooling, behind no editor route' },
      { item: 'engine/plugins/env-ultrahdr.ts', reason: '#1314: reads the source .hdr only (the encoder behind reimport-environment.ts, itself reached only through the gated /api/reimport); writes nothing, touches no sidecar' },
      { item: 'engine/plugins/font-convert.ts', reason: '#889 widened trigger: build-time converter / native-config writer / device tooling, behind no editor route' },
      { item: 'engine/plugins/font-instance.ts', reason: '#889 widened trigger: build-time converter / native-config writer / device tooling, behind no editor route' },
      { item: 'engine/plugins/healNativeConfig.ts', reason: '#889 widened trigger: build-time converter / native-config writer / device tooling, behind no editor route' },
      { item: 'engine/plugins/iconAssets.ts', reason: '#889 widened trigger: build-time converter / native-config writer / device tooling, behind no editor route' },
      { item: 'engine/plugins/inlinePlayable.ts', reason: '#889 widened trigger: build-time converter / native-config writer / device tooling, behind no editor route' },
      { item: 'engine/plugins/load-project-config.ts', reason: '#889 widened trigger: build-time converter / native-config writer / device tooling, behind no editor route' },
      { item: 'engine/plugins/model-convert.ts', reason: '#889 widened trigger: build-time converter / native-config writer / device tooling, behind no editor route' },
      { item: 'engine/plugins/prefabWriteGuard.ts', reason: "#1468: READS ONLY — one readFileSync of the "
        + 'prefab already on disk, to classify its format version and refuse a write that would overwrite a '
        + 'newer one. It never writes, so it cannot clobber a parked edit; the route it guards '
        + '(/api/write-file) is byte-opaque and deliberately ungated, which is why the refusal lives here '
        + 'rather than in that route body' },
      { item: 'engine/plugins/rigged-model-optimize.ts', reason: '#889 widened trigger: build-time converter / native-config writer / device tooling, behind no editor route' },
      { item: 'engine/plugins/texture-convert.ts', reason: '#889 widened trigger: build-time converter / native-config writer / device tooling, behind no editor route' },
      { item: 'engine/plugins/vendorPlugins.ts', reason: '#889 widened trigger: build-time converter / native-config writer / device tooling, behind no editor route' },
      { item: 'engine/plugins/video-convert.ts', reason: '#889 widened trigger: build-time converter / native-config writer / device tooling, behind no editor route' },
      { item: 'engine/plugins/stripFirebaseAuthFacebook.ts', reason: '#1062: build heal step 6 (reached from /api/build via healNativeProject, under the build claim) — reads capacitor.config.json and reads/writes node_modules/@capacitor-firebase/authentication/Package.swift only; no asset, sidecar or document a panel can hold unsaved' },
      { item: 'engine/plugins/backend/loginShellProbe.ts', reason: '#1449: reads back only the one-line answer file its own login-shell probe wrote into a fresh mkdtemp dir; no asset, sidecar or document a panel can hold unsaved' },
      { item: 'engine/plugins/projectLockfileHash.ts', reason: '#1502: READS ONLY each project\'s package-lock.json, at vite.config evaluation, to key the dep-optimizer cache; behind no editor route, writes nothing, touches no sidecar' },
      { item: 'engine/plugins/transcoders.ts', reason: '2026-09-26 (#1586): READS ONLY the installed three/pixi KTX2 transcoder files in node_modules (to hash and to serve them), and at build time copies them into dist/; touches no sidecar or document a panel can hold unsaved' },
      { item: 'engine/plugins/favicon.ts', reason: '2026-09-26: READS ONLY the project\'s app.iconSource / the engine favicon, at build time (and the engine icon in the dev server\'s /favicon.png middleware); writes no file, touches no sidecar or document a panel can hold unsaved' },
      { item: 'engine/plugins/backend/iosUsbForward.ts', reason: '#1065: reads/writes only this clone\'s .modoki/ios-forward.json pid record for the go-ios forward' },
    ];
    assertExemptionLedger({
      label: 'ALLOWED in unsavedGateCoverage',
      population: tracked.filter((f) => CONTENT_CALLS.test(source(f))).map((f) => ({ item: f, site: f })),
      exempt: ALLOWED,
      floor: 1,
      fix: 'a new Node-side file reads or writes a .meta.json. If it is reachable from an agent route, '
        + 'that route needs unsavedGate; if it is not, add it to ALLOWED with that reasoning.',
    });
  });

  it('the registry VOCABULARY is the same everywhere it is spelled, documents included (#889 close-out review)', () => {
    // ⚠️ **The exhaustiveness derivation covers CAUSES; this covers REGISTRIES, and nothing did.**
    // `CAUSE_REGISTRY`/`CAUSE_HOLDS` `satisfies Record<keyof UnsavedCauses, …>`, so a sixth CAUSE
    // is a compile error. But the axis Node actually asks along is the REGISTRY, and that union is
    // declared TWICE — once in the renderer (`agentEditorOps.ts`), once in the Node router — in two
    // zones that cannot import each other, plus expanded as a literal in this guard.
    //
    // The failure that leaves: a new registry (say `dirtyPrefab`) added to the renderer's union,
    // its `ALL_REGISTRIES`, both cause tables and `DISCARDERS` — compiles, tests green. The Node
    // half is untouched, so it never ASKS about it; `covers` only reports registries the caller
    // asked for, so the skew guard is silent BY CONSTRUCTION. `/api/duplicate-asset` of a prefab
    // with a dirty prefab document then copies pre-edit bytes and reports clear — #889 member 4
    // verbatim, one registry over, inside the fix for #889 member 4.
    //
    // A shared module is not available (the renderer cannot import `engine/plugins/**`, and pulling
    // a runtime module into the Node bundle to host four strings is a worse trade), so this is the
    // structural mirror — the same idiom `findReferencesWireShape.test.ts` uses for the wire type.
    const union = (code: string, name: string): string[] => {
      const m = new RegExp(`type ${name}\\s*=\\s*([^;]+);`).exec(code);
      expect(m, `${name} is gone or reshaped — re-point this guard`).not.toBeNull();
      return [...m![1].matchAll(/'([^']+)'/g)].map((q) => q[1]).sort();
    };
    const arrayLiteral = (code: string, name: string): string[] => {
      const m = new RegExp(`${name}[^=]*=\\s*\\[([^\\]]*)\\]`, 's').exec(code);
      expect(m, `${name} is gone or reshaped — re-point this guard`).not.toBeNull();
      return [...m![1].matchAll(/'([^']+)'/g)].map((q) => q[1]).sort();
    };

    const renderer = source('engine/app/editor/agentEditorOps.ts');
    const node = source(ROUTER);

    const EXPECTED = [...ALL_REGISTRY_NAMES].sort();
    const DOCUMENTS = [...DOCUMENT_REGISTRY_NAMES].sort();

    expect(union(renderer, 'UnsavedRegistry'), 'the RENDERER union').toEqual(EXPECTED);
    expect(union(node, 'UnsavedRegistry'), 'the NODE union — it is asked along this axis').toEqual(EXPECTED);
    expect(arrayLiteral(renderer, 'ALL_REGISTRIES'), "the renderer's runtime list").toEqual(EXPECTED);
    expect(arrayLiteral(node, 'ALL_UNSAVED_REGISTRIES'), "the Node runtime list").toEqual(EXPECTED);
    // #1362: and the DOCUMENT subset, which is a fifth spelling and the one the stale-read
    // disclosures ask for. Left out, a registry added to the full vocabulary would silently start
    // being asked about by those routes — the spillover this split exists to stop.
    expect(arrayLiteral(node, 'DOCUMENT_UNSAVED_REGISTRIES'), "the Node document subset").toEqual(DOCUMENTS);

    // …and this guard's OWN expansion, which decides what `registries: ALL_UNSAVED_REGISTRIES`
    // means when it reads a route. A stale copy here would silently under-report `needed`.
    const mine = declaredRegistries("registries: ALL_UNSAVED_REGISTRIES").sort();
    expect(mine, "this guard's own expansion of ALL_UNSAVED_REGISTRIES").toEqual(EXPECTED);
    expect(declaredRegistries("registries: DOCUMENT_UNSAVED_REGISTRIES").sort(),
      "this guard's own expansion of DOCUMENT_UNSAVED_REGISTRIES").toEqual(DOCUMENTS);

    // ⚠️ …and the SIXTH spelling, which the title's "everywhere" was over-claiming without
    // (close-out review 2). `HELPER_REGISTRIES.duplicateAssetFile` is a fourth literal list of all
    // four; add a fifth registry everywhere else and it stays short, so `needed` under-reports for
    // any route declaring the four explicitly — the exact silent under-coverage this file exists
    // to stop, in this file.
    expect(
      [...HELPER_REGISTRIES.duplicateAssetFile].sort(),
      'duplicateAssetFile reads DOCUMENTS as well as sidecars, so it needs every DOCUMENT registry '
      + '— but NOT openAssetEditor (#1362): a duplicate leaves the held asset where it is, so an '
      + 'open modal is no reason to refuse one',
    ).toEqual(DOCUMENTS);
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

    // The renderer's own DELETES must say so too (#1215). The route gates the agent path on unsaved
    // work; without `rendererWrite` the human deleting a file they have a parked edit on gets a 409,
    // and `deleteAssetFile` reports it only as `false`. Checked per CALL, not per file: each POST
    // to the route must carry the flag within its own request body, so a second call added without
    // it cannot hide behind the first.
    for (const file of [
      'engine/packages/modoki/src/editor/panels/assetOps.ts',
      'engine/packages/modoki/src/editor/panels/CleanupAssetsDialog.tsx',
    ]) {
      const src = source(file);
      const calls = [...src.matchAll(/['"]\/api\/delete-asset['"]/g)];
      expect(calls.length, `${file} no longer POSTs /api/delete-asset — re-point this guard`).toBeGreaterThan(0);
      for (const m of calls) {
        const body = src.slice(m.index, m.index + 200);
        expect(/rendererWrite:\s*true/.test(body),
          `${file}: a /api/delete-asset call without \`rendererWrite: true\` — the agent-path unsaved gate `
          + 'would refuse the human\'s own delete of a file they have unsaved edits on').toBe(true);
      }
    }

    const assetOps = source('engine/packages/modoki/src/editor/panels/assetOps.ts');
    expect(/flushPendingMetaFor\s*\(/.test(assetOps),
      "the Assets panel's duplicate must flush the SOURCE's parked import-settings edit first — "
      + 'otherwise the copy is born from pre-edit bytes, and since the route gates on a park the '
      + 'duplicate fails outright').toBe(true);
  });
});

/**
 * Every exported `invalidate<Something>` cache-invalidator has a real production caller (#74).
 *
 * `liveReloadKinds.test.ts` (this file's sibling) cross-checks the PRODUCER union (`LiveReloadKind`
 * + `classifySceneChange` in `engine/plugins/vite-asset-scanner.ts`) against the CONSUMER union
 * (`SceneChangedKind` + `ASSET_CACHE_INVALIDATORS` in `engine/app/debug/agentBridge.ts`). That guard
 * has a blind spot: a kind missing from BOTH unions passes, because the two sides agree with each
 * other while agreeing on the wrong set — exactly how `animset` (a real shipped asset kind that
 * `detectType` classifies correctly) went unmentioned by either union without either test noticing.
 *
 * This guard is reachable independently of both unions: it enumerates every exported
 * `invalidate<Something>` function under `runtime/loaders/*.ts` directly from the loader source,
 * and requires each one to be either wired into `ASSET_CACHE_INVALIDATORS` (the live-reload path)
 * or named in an explicit allowlist below with a verified real caller. It encodes the actual defect
 * — "an exported invalidator nothing in production calls" — rather than one symptom of it.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';
import { parseSource, ts, unwrapValue, variablesNamed } from '@modoki/engine/testing/sourceAst';

const REPO = path.resolve(__dirname, '../../..');
const RUNTIME_SRC = path.join(REPO, 'engine/packages/modoki/src/runtime');
// Scanned dirs (#842): `runtime/loaders/` plus `runtime/rendering/`, which is where
// `invalidatePixiShaderProgram` lives — the shader-cache invalidator `spriteMaterialCache.ts`'s
// `invalidateShader` calls, so it must be visible to this guard too, not just the loaders.
const SCAN_DIRS = [path.join(RUNTIME_SRC, 'loaders'), path.join(RUNTIME_SRC, 'rendering')];
const consumerSf = () => parseSource(readScannedSource(path.join(REPO, 'engine/app/debug/agentBridge.ts')).code, 'agentBridge.ts');

/** `invalidate<Something>` — the names this guard is about. */
const INVALIDATOR_NAME = /^invalidate[A-Za-z0-9]+$/;

/** Every EXPORTED `invalidate<Something>` function in `sf`: an `export function`, or an `export const` bound to
 *  an arrow or function expression. From the parser (#1195) — it used to be `/export function (invalidate…)\s*\(/`
 *  over the text, which never saw the `export const` form. */
function exportedInvalidators(sf: ts.SourceFile): string[] {
  const isExported = (n: ts.Node) => ts.canHaveModifiers(n) && !!ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  return sf.statements.flatMap((st) => {
    if (ts.isFunctionDeclaration(st) && st.name && st.body && isExported(st)) return [st.name.text];
    if (ts.isVariableStatement(st) && isExported(st)) {
      return st.declarationList.declarations.filter((d) => ts.isIdentifier(d.name) && d.initializer
        && (ts.isArrowFunction(unwrapValue(d.initializer)) || ts.isFunctionExpression(unwrapValue(d.initializer))))
        .map((d) => (d.name as ts.Identifier).text);
    }
    return [];
  }).filter((name) => INVALIDATOR_NAME.test(name));
}

/** Every `export`ed invalidator across the scanned runtime dirs, with the file that defines it (for a failure
 *  message that doesn't force a repo-wide grep). */
function findInvalidators(): Array<{ name: string; file: string }> {
  const out: Array<{ name: string; file: string }> = [];
  for (const dir of SCAN_DIRS) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      const sf = parseSource(readScannedSource(path.join(dir, entry.name)).code, entry.name);
      for (const name of exportedInvalidators(sf)) out.push({ name, file: entry.name });
    }
  }
  return out;
}

/** The VALUE of each entry in `const ASSET_CACHE_INVALIDATORS = { … }`, e.g. `animation: invalidateAnimationClip`
 *  → `invalidateAnimationClip`; a shorthand entry → its name. An entry whose value is not a plain name (a
 *  wrapper arrow, a call) comes back as `<key: text>`, so it can neither pass as wired nor go unseen.
 *
 *  From the parser (#1195). It used to be the text from `const ASSET_CACHE_INVALIDATORS` to the first `'};'`,
 *  matched with `/:\s*(invalidate…)\s*[,}]/` — which silently skipped any entry of another shape. */
function invalidatorTableValues(sf: ts.SourceFile): string[] {
  const decls = variablesNamed(sf, 'ASSET_CACHE_INVALIDATORS');
  if (decls.length !== 1 || !decls[0]!.initializer) throw new Error('could not find one "const ASSET_CACHE_INVALIDATORS = …" — did it move or get renamed?');
  const table = unwrapValue(decls[0]!.initializer);
  if (!ts.isObjectLiteralExpression(table)) throw new Error('ASSET_CACHE_INVALIDATORS is no longer an object literal — read its new shape');
  return table.properties.map((p) => {
    if (ts.isShorthandPropertyAssignment(p)) return p.name.text;
    if (ts.isPropertyAssignment(p) && ts.isIdentifier(unwrapValue(p.initializer))) return (unwrapValue(p.initializer) as ts.Identifier).text;
    return `<${p.getText().replace(/\s+/g, ' ')}>`;
  });
}

const INVALIDATORS = findInvalidators();
const WIRED = new Set(invalidatorTableValues(consumerSf()));

/**
 * Invalidators NOT wired into `ASSET_CACHE_INVALIDATORS` (the live-reload watcher path), each with
 * the REAL production caller that drives it by a different mechanism instead — verified by reading
 * the call site, not assumed. This is a list of invalidators driven by a DIFFERENT mechanism, NOT a
 * list of exemptions: adding a name here without a verified caller defeats the entire guard, because
 * it makes the test green while the underlying defect (an invalidator nothing calls) still exists.
 *
 * Keyed per NAME (a caller drives an invalidator by name, and `WIRED` is by name) and spent through
 * `assertExemptionLedger` since #1140 — it used to be a `Record` looked up with `in` and NO staleness
 * check, so a name that became WIRED, or was renamed or deleted, kept its row. ⚠️ That is exactly the
 * `invalidateMaterial` shape noted below: #842 wired it, and a leftover row would have silently kept
 * vouching after the wiring was reverted.
 */
const ALLOWLIST: ReadonlyArray<{ item: string; reason: string }> = [
  // Driven by the agent/editor "invalidate-assets" op (agentBridge.ts registerAgentOp) and directly
  // by editor asset-view panels on manual re-import/edit — not by the live-reload file watcher.
  // ⚠️ Since #1366 these four are reached through ONE table — `REIMPORT_INVALIDATORS`
  // (runtime/loaders/reimportInvalidation.ts) — which both re-import entry points read:
  // agentBridge.ts's registerAgentOp('invalidate-assets') and assetViews/reimport.ts. The panels
  // below drive them directly as well. They are not in ASSET_CACHE_INVALIDATORS because a model /
  // texture / audio / environment re-import is not a live-reload watcher kind.
  { item: 'invalidateTexture', reason: 'REIMPORT_INVALIDATORS.texture — read by agentBridge.ts registerAgentOp(\'invalidate-assets\') + assetViews/reimport.ts; also direct from makeTexture2D.ts, TextureAssetView.tsx, editor/scene/modelImport.ts' },
  { item: 'invalidateAudio', reason: 'REIMPORT_INVALIDATORS.audio — read by agentBridge.ts registerAgentOp(\'invalidate-assets\') + assetViews/reimport.ts; also direct from AudioAssetView.tsx' },
  { item: 'invalidateEnvironment', reason: 'REIMPORT_INVALIDATORS.environment — read by agentBridge.ts registerAgentOp(\'invalidate-assets\') + assetViews/reimport.ts; also direct from EnvironmentAssetView.tsx' },
  // `invalidateModel` and `invalidateRiggedModel` are BOTH reached through `invalidateModelAndRig`,
  // which is `REIMPORT_INVALIDATORS.model` and the only thing any re-import entry point calls now.
  // Same shape as `invalidatePixiShaderProgram` below: called FROM something that is itself driven.
  // ⚠️ `invalidateRiggedModel`'s row used to read 'editor/scene/modelImport.ts (rigged-model
  // re-import step)', and that row WAS #1366: the drag-in importer was its only caller of four, so
  // the Assets-panel batch, the agent/MCP op and the Model Inspector's own Re-import button all
  // skipped the rigged prototype — and this row made that read as deliberate. This guard proves an
  // invalidator has A caller (#74's defect, zero callers); it can say nothing about entry-point
  // COVERAGE, which is why it stayed green through all of it.
  { item: 'invalidateModel', reason: 'invalidateModelAndRig (reimportInvalidation.ts) = REIMPORT_INVALIDATORS.model, read by agentBridge.ts registerAgentOp(\'invalidate-assets\') + assetViews/reimport.ts, ModelAssetView.tsx, editor/scene/modelImport.ts' },
  { item: 'invalidateRiggedModel', reason: 'invalidateModelAndRig (reimportInvalidation.ts) = REIMPORT_INVALIDATORS.model — same four callers as invalidateModel; never called alone any more' },
  { item: 'invalidateModelAndRig', reason: 'REIMPORT_INVALIDATORS.model in agentBridge.ts registerAgentOp(\'invalidate-assets\') + assetViews/reimport.ts, ModelAssetView.tsx, editor/scene/modelImport.ts' },
  // Font invalidation has its OWN channel: assetManifest.ts's onFontInvalidated(...) fires these
  // directly (module-load subscriptions in fontAtlasLoader.ts / fontLoader.ts) whenever a font
  // re-import or Font-Inspector mode flip changes the manifest hash — not via the scene-change path.
  { item: 'invalidateFont', reason: 'assetManifest.ts onFontInvalidated(...) fires it — subscribed at module load in fontAtlasLoader.ts' },
  { item: 'invalidateFontFace', reason: 'assetManifest.ts onFontInvalidated(...) fires it — subscribed at module load in fontLoader.ts' },
  // Prefabs/rigged models are edited through their own Inspector asset-view panels
  // (editor/panels/assetViews/persist.ts wraps the invalidator per asset kind) or the prefab
  // apply/instantiate flow — not the live-reload watcher.
  //
  // ⚠️ `invalidateMaterial` used to be here, on the same (wrong) premise as the old `invalidateAnimSet`
  // comment below: it has an Inspector caller, but that only serves edits made INSIDE the editor.
  // #842 wired it into ASSET_CACHE_INVALIDATORS (agentBridge.ts) too, so it is no longer allowlisted
  // — it must show as WIRED now, and an entry here for it again would silently un-fix #842.
  { item: 'invalidatePrefab', reason: 'editor/scene/prefab.ts (prefab apply/instantiate flow)' },
  // `invalidatePixiShaderProgram` is never called directly from ASSET_CACHE_INVALIDATORS — it's
  // called FROM `spriteMaterialCache.ts`'s `invalidateShader`, which IS wired (as `shader:`) below
  // (#842). Verified by reading spriteMaterialCache.ts: `invalidateShader` calls it unconditionally,
  // alongside a per-key eviction of the one guid the path resolves to (#852 — it used to be a
  // wholesale `clearSpriteMaterialCache()`, which now runs only on the unresolved-path fallback).
  { item: 'invalidatePixiShaderProgram', reason: 'runtime/loaders/spriteMaterialCache.ts\'s invalidateShader (itself wired into ASSET_CACHE_INVALIDATORS as `shader:`)' },
];

describe('every invalidator is reachable from production (#74)', () => {
  it('found a plausible number of invalidators (sanity: the parse works, so a pass means something)', () => {
    expect(INVALIDATORS.length).toBeGreaterThan(10);
    expect(WIRED.size).toBeGreaterThan(2);
  });

  it('every exported invalidator is wired into ASSET_CACHE_INVALIDATORS or verified in the allowlist', () => {
    assertExemptionLedger({
      label: 'ALLOWLIST in invalidatorsAreReachable',
      population: INVALIDATORS.filter((inv) => !WIRED.has(inv.name)).map((inv) => ({ item: inv.name, site: `${inv.name} (${inv.file})` })),
      exempt: ALLOWLIST,
      floor: 1,
      fix: 'These invalidators have no caller in ASSET_CACHE_INVALIDATORS and no verified allowlist '
        + 'entry here. The silent symptom: the asset cache holds its PRE-EDIT contents forever, which '
        + 'reads as "my change was ignored" rather than as a stale cache, and a read_asset_def → '
        + 'write_asset round-trip reverts the file that was just written. Fix it one of two ways: (1) '
        + 'wire the invalidator into ASSET_CACHE_INVALIDATORS in engine/app/debug/agentBridge.ts, or '
        + '(2) if it is genuinely driven by a different mechanism, add it to the ALLOWLIST above with a '
        + 'one-line reason naming the REAL caller you verified by reading the call site. A row that '
        + 'blesses more than exists means the invalidator got wired or went away: delete the row.',
    });
  });

  it('reads exported invalidators and the table by node, and never drops an entry it cannot name (#1195)', () => {
    const sf = parseSource([
      'export function invalidateA(p: string) { m.delete(p); }',
      'export const invalidateB = (p: string) => { const t = `};`; m.delete(p); };',
      'function invalidateC(p: string) {}',
      'export function invalidator() {}',
      'export const invalidateD = makeInvalidator();',
      'const ASSET_CACHE_INVALIDATORS: Partial<Record<K, F>> = {',
      '  a: invalidateA, invalidateB, c: (p) => invalidateC(p), "d": (invalidateA as F),',
      '} satisfies object;',
    ].join('\n'), 'probe.ts');
    expect(exportedInvalidators(sf)).toEqual(['invalidateA', 'invalidateB']);
    expect(invalidatorTableValues(sf)).toEqual(['invalidateA', 'invalidateB', '<c: (p) => invalidateC(p)>', 'invalidateA']);
    expect(() => invalidatorTableValues(parseSource('const ASSET_CACHE_INVALIDATORS = build();', 'x.ts'))).toThrow(/no longer an object literal/);
  });
});

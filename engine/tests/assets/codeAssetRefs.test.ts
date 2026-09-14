/**
 * Invariant guard: a GAME must not reference an asset by a GUID LITERAL IN CODE.
 *
 * This is the code-side twin of `assetRefIntegrity.test.ts`. That file enforces the
 * GUID-only rule on the DATA side (scene/prefab/mesh/material/particle JSON). This one
 * closes the hole on the other side, discovered on Court (#53): an asset reached only by a
 * GUID constant in game code is INVISIBLE TO THE BUILD.
 *
 * WHY the rule exists, the three build passes it broke on Court, why `asset-keep.json` is a patch
 * rather than a fix, and what this guard deliberately does not reach — all owned by
 * **docs/build.md § "Assets the build cannot see"**. Read it there; this header covers only the
 * MECHANISM, which belongs with the code.
 *
 * The discriminator: resolve each candidate against the REAL asset GUID index. In the index ⇒ an
 * asset ref the build cannot see ⇒ failure. Not in the index ⇒ an entity ref (or unrelated data)
 * ⇒ ignored. That is load-bearing, not a refinement: #53 proposed "any GUID-shaped literal in game
 * code is an error", and measured, that fires on ~10 legitimate entity refs (`demos/postfx-demo`
 * addresses its caption/light/environment entities by guid, as its own comment says). A guard with
 * that false-positive rate gets disabled, which is worse than no guard. It is also why this is a
 * vitest guard and not ESLint: `engine/eslint.config.js` has only `no-restricted-syntax` AST
 * selectors, which cannot consult the asset index.
 *
 * ── TWO FORMS ARE CHECKED ───────────────────────────────────────────────────────────────
 *   1. a GUID **literal** — `const PIECE_ICON = { K: '9f90775e-…' }`;
 *   2. an **imported identifier** naming an engine asset-GUID constant — `DEFAULT_FONT_GUID`.
 *
 * Form 2 was initially written off as needing type information. It does not: the set of engine
 * constants is small and ENUMERABLE from source (`exportedGuidConsts`), and the same
 * asset-index membership test discriminates their values, so the names are derived rather than
 * hard-coded and a new engine builtin is covered automatically. It earns its keep immediately —
 * Court's font ref is a form-2 instance, and a dropped font takes its baked MTSDF atlas with it,
 * i.e. NO TEXT AT ALL in the built game.
 *
 * ── WHAT IS STILL NOT COVERED (deliberate) ─────────────────────────────────────────────
 *   • A guid built at runtime from non-constant parts (a template literal over a variable). The
 *     derived-sprite form Court uses — `deriveGuid('sprite:' + PIECE_ICON[piece])` — is safe
 *     only because its INPUT is a caught literal; a guid assembled from data would slip through.
 *   • An asset fetched by PATH rather than guid: Court's `fetch('/assets/levels/index.json')`.
 *     That is #54's `detectType` problem and this issue's own out-of-scope note (a resource
 *     trait cannot enumerate a generated set), not something a ref scan can reach.
 *   • A game-LOCAL const re-exporting an engine guid under a new name, since only engine-declared
 *     names are matched. In practice such a const holds a literal, which form 1 catches.
 */

import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import { findAssetRoots, readAssetGuid, detectType, type AssetRoot } from '../../plugins/vite-asset-scanner';
import { deriveGuid } from '../../packages/modoki/src/runtime/core/assetRefRules';
import { discoverProjects } from '../../scripts/projectRoots.mjs';
import { hasInternalGames } from '../helpers/repoLayout';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';
import { readScannedSource, stripComments } from '@modoki/engine/testing';
import { findNodes, lineOf, parseSource, readsOf, referencesToPath, stringValueOf, ts } from '@modoki/engine/testing/sourceAst';

// engine/tests/assets/ → repo root (games/ + demos/ live there).
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
// The public engine snapshot ships neither games/ nor demos/ — nothing to audit there.
const hasGames = hasInternalGames();

/* ⚠️ **No ALLOWED list (#1140).** It was an EMPTY file-keyed list — its first row would have
 *  pardoned every GUID literal a file would ever hold, which is the per-file pardon over a
 *  per-occurrence ban the rest of this guard is careful not to be. A site that genuinely cannot use
 *  a resource trait goes on PENDING_MIGRATION below, per GUID and counted, with its reason. */

/**
 * Sites that already existed when this guard landed and are NOT yet migrated to a resource
 * trait (#53 Phase 2). Every one is currently held alive by a hand-maintained
 * `asset-keep.json` entry, which is exactly the patch #53 wants to delete.
 *
 * This list exists so the guard can land GREEN and start blocking NEW instances immediately —
 * the issue's own framing: "instances get fixed by hand; only the rule stops the third game
 * from rediscovering this". It differs from `asset-keep.json` in the way that matters: it is
 * pinned per GUID and stale-checked below, so it can only ever SHRINK. Adding a new literal to
 * an already-listed file still fails, and fixing one and forgetting to delete its entry also
 * fails. `asset-keep.json` has neither property, which is why forgetting it is silent.
 *
 * ⚠️ **Each GUID is SPENT per MATCH (#1140).** The keys were a `Set<file:guid>`, so a GUID already
 * listed for a file could be written any number of further times in that file for free — a
 * repeated reference collapsed into one row. A GUID matched N times (on N lines, or twice on one)
 * now carries `{ guid, count: N }`; a plain string is one match.
 *
 * Regenerate with: MODOKI_DUMP_CODE_ASSET_REFS=1 npx vitest run --config engine/vite.config.ts \
 *   engine/tests/assets/codeAssetRefs.test.ts
 */
const PENDING_MIGRATION: { file: string; note: string; guids: Array<string | { guid: string; count: number }> }[] = [
  {
    file: 'games/court/runtime/systems.ts',
    note: 'The engine builtin font, via the imported DEFAULT_FONT_GUID identifier — an ENGINE '
      + 'asset reached through an engine constant, so there is no project trait that would '
      + 'naturally hold it. It matters most of the three that were here: a dropped font takes its '
      + 'BAKED MTSDF atlas with it, i.e. no text at all in the built game. '
      + '(PIECE_ICON + CIVILIAN_ICON were migrated 2026-08-05 onto CourtConfig — pieceIconK..N and '
      + 'civilianIcon, authored in the scene — which also let their asset-keep.json entries go. '
      + 'The original note proposed a separate CourtAssets trait; CourtConfig already had the same '
      + 'shape for heartFullTexture/handIcon, so a second trait would have split one concern.)',
    guids: [
      'beef0000-0000-4000-8000-000000000002',
    ],
  },
  {
    file: 'games/sling/runtime/field/level.ts',
    note: 'POINT_BRUSH prefab guids (bumper, goal-point) painted by the Level Editor brush.',
    guids: [
      '92c6da9c-0d69-483c-bb69-580d0a8eb048',
      '379ba714-80ba-4bf4-8f06-3797b69b684d',
    ],
  },
  {
    file: 'games/sling/runtime/field/rebuildField.ts',
    note: 'KIT_MESH_GUIDS + the field-kit prefab guids — rebuildField merges these meshes procedurally, so no scene entity ever references them.',
    guids: [
      '1543405a-60a4-4e6d-a357-8e5ee335cc2d',
      '96ff95be-5fb4-4c59-9ecf-4f0e380ddc17',
      '0c74e346-e8e1-4b04-94bb-200251a1f72a',
      'f6025381-7a11-4035-9ba3-d0265c4c7eaf',
      'f380e4f8-ca70-4fda-ab86-9c98436171fd',
      '55d55843-2fac-48eb-97de-53b59dbbb9e4',
      '96a1aa13-0eae-4b98-b710-a209a5579269',
      '9d3bc699-66e5-4242-b249-06aee6ecd2f6',
      'a6623cff-9716-405a-86c7-2a42cafb28a2',
      'df329736-cfdd-41a5-b473-9a1f2adcda0f',
      '42dd6f4b-eab7-43fc-8f0b-3e52bd9366e8',
    ],
  },
];

/** Every source `.ts`/`.tsx` file under `dir`, git-enumerated (#771/#799) rather than a
 *  hand-rolled recursive walk. `tools/` (build-time Node code that legitimately handles asset
 *  paths/guids while generating them) and `tests/` (allowed to name a guid as a fixture) are
 *  excluded explicitly because they are TRACKED; `dist/`/`node_modules/` need no entry at all —
 *  both are gitignored. */
function walkFiles(dir: string): string[] {
  return repoFiles({
    under: dir,
    match: (rel) => /\.tsx?$/.test(rel) && !rel.endsWith('.d.ts'),
    exclude: ['tools', 'tests'],
    floor: 0,
  }).map(({ abs }) => abs);
}

/** Matches on `rel` — git's own repo-relative POSIX string — rather than on two independently
 *  derived absolute paths (#849). `roots[].relDir` is `absDir` made repo-relative ONCE per root
 *  (a handful, not once per file); compared case-insensitively, same convention `repoCorpus.mjs`'s
 *  own `under` matching already uses. */
function urlFor(rel: string, roots: (AssetRoot & { relDir: string })[]): string | null {
  const relLower = rel.toLowerCase();
  for (const r of roots) {
    if (relLower.startsWith(r.relDir.toLowerCase() + '/')) {
      return (r.urlPrefix + '/' + rel.slice(r.relDir.length + 1)).normalize('NFC');
    }
  }
  return null;
}

/** guid → the asset URL that owns it, over every shippable asset under the real roots.
 *  Includes the whole-image SPRITE guid a 2D/UI texture auto-emits, since a sprite field
 *  legitimately holds that derived guid and it is just as invisible to the build. */
function buildGuidIndex(): Map<string, string> {
  const roots = findAssetRoots(PROJECT_ROOT).map((r) => ({
    ...r,
    relDir: path.relative(PROJECT_ROOT, r.absDir).split(path.sep).join('/'),
  }));
  const index = new Map<string, string>();
  for (const r of roots) {
    for (const { rel, abs } of walkFiles0(r.absDir)) {
      const url = urlFor(rel, roots);
      if (!url) continue;
      const type = detectType(url, path.extname(url).toLowerCase());
      if (!type) continue;
      const guid = readAssetGuid(abs, type);
      if (!guid) continue;
      index.set(guid.toLowerCase(), url);
      if (type === 'texture') {
        // A 2D/UI texture auto-emits a whole-image SPRITE guid, and a sprite field legitimately
        // holds that derived guid rather than the texture's own — just as invisible to the build.
        index.set(deriveGuid('sprite:' + guid).toLowerCase(), `${url} (whole-image sprite)`);
        // A SLICED sheet additionally owns one guid per slice, declared in its `.meta.json`
        // `sprites[]`. Without these the guard misses the sliced case entirely, which is the
        // sharper half of the class: space-invader's `CATVADER_SLICE0` is a slice guid.
        for (const s of readSpriteSliceGuids(abs)) index.set(s.guid.toLowerCase(), `${url} (slice "${s.name}")`);
      }
    }
  }
  return index;
}

/** Slice guids declared in a texture's `<file>.meta.json` `sprites[]` (spriteMode 'multiple').
 *  Best-effort: a missing/!JSON sidecar just means no slices, never a test error. */
function readSpriteSliceGuids(textureAbs: string): { guid: string; name: string }[] {
  const meta = `${textureAbs}.meta.json`;
  if (!fs.existsSync(meta)) return [];
  try {
    const json = JSON.parse(fs.readFileSync(meta, 'utf-8')) as { sprites?: { guid?: string; name?: string }[] };
    return (json.sprites ?? [])
      .filter((s): s is { guid: string; name?: string } => typeof s.guid === 'string')
      .map((s) => ({ guid: s.guid, name: s.name ?? '?' }));
  } catch {
    return [];
  }
}

/** Asset-tree walker — separate from walkFiles (which is source-only, .ts/.tsx). Git-enumerated
 *  (#771/#799) rather than a hand-rolled recursive walk. A dotfile/dot-dir segment is dropped,
 *  same as the old walker's `e.name.startsWith('.')` — git enumeration additionally drops
 *  `*.meta.local.json` for free (gitignored machine-local sidecars — `.gitignore:41`), which
 *  `detectType()` below already classifies as `null` and discards, so nothing downstream changes. */
function walkFiles0(dir: string): Array<{ rel: string; abs: string }> {
  return repoFiles({
    under: dir,
    match: (rel) => !rel.split('/').some((seg) => seg.startsWith('.')),
    floor: 0,
  });
}

/**
 * Engine-exported constants that hold an ASSET guid, as `identifier → guid`. A game importing one
 * of these (`Text2D({ font: DEFAULT_FONT_GUID })`) has an asset ref that no literal scan can see —
 * and it is a REAL instance, not a theoretical one: it is exactly why Court's `asset-keep.json`
 * needs a font entry, and a dropped font takes its baked MTSDF atlas with it, i.e. no text at all
 * in the built game.
 *
 * Catching it needs no type information because the set is small and ENUMERABLE: engine source
 * declares these as plain top-level string consts, and the same asset-index membership test that
 * discriminates asset guids from entity guids applies to the value. Measured at the time of
 * writing: 3 such constants exist (`WHITE_HDR_GUID`, `DEFAULT_FONT_GUID`, `PREFAB_EDIT_HDR_GUID`),
 * of which only `DEFAULT_FONT_GUID` is consumed by a game. Derived, not hard-coded, so a new engine
 * builtin is covered automatically.
 */
function engineAssetGuidConstants(index: Map<string, string>): Map<string, { guid: string; asset: string }> {
  const out = new Map<string, { guid: string; asset: string }>();
  const engineSrc = path.join(PROJECT_ROOT, 'engine', 'packages', 'modoki', 'src');
  for (const file of walkFiles(engineSrc)) {
    for (const { name, guid } of exportedGuidConsts(readScannedSource(file).code, file)) {
      const asset = index.get(guid);
      // Same discriminator as the literal path: only a guid a real asset OWNS is a ref the build
      // must be able to see. A sentinel/entity guid declared this way is correctly ignored.
      if (asset) out.set(name, { guid, asset });
    }
  }
  return out;
}

const GUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QUOTED_GUID = /['"]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})['"]/gi;

/** Every `export const NAME = '<guid>'` declaration in one file's comment-stripped code, from the
 *  parse (#1179). The regex it replaced matched RAW text, so a docblock quoting such a
 *  declaration registered a constant, and `export const NAME =\n  '<guid>'` wrapped was never one. */
function exportedGuidConsts(code: string, label: string): Array<{ name: string; guid: string }> {
  const sf = parseSource(code, label);
  return sf.statements.filter(ts.isVariableStatement)
    .filter((s) => s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) && (s.declarationList.flags & ts.NodeFlags.Const) !== 0)
    .flatMap((s) => s.declarationList.declarations.flatMap((d) => {
      const guid = stringValueOf(d.initializer);
      return ts.isIdentifier(d.name) && guid !== undefined && GUID_TEXT.test(guid) ? [{ name: d.name.text, guid: guid.toLowerCase() }] : [];
    }));
}

/**
 * Every asset-GUID reference in one file's comment-stripped code, from the parse (#1179): a string
 * literal whose WHOLE value is a GUID, and every READ of an engine GUID constant (`referencesToPath` —
 * so an import specifier, a declaration name or an object key spelled alike is not one). `lines`
 * only supplies the quoted line text (comment-blanked lines are enough for a message). Two things the line scan got wrong: its comment filter was
 * "the line starts with `//` or `*`", and its import filter skipped any line shaped `NAME,` — which
 * is also a formatter-wrapped call ARGUMENT, so `useFont(\n  DEFAULT_FONT_GUID,\n  …)` was invisible.
 */
function assetRefsIn(
  code: string, lines: string[], rel: string,
  index: Map<string, string>, engineConsts: Map<string, { guid: string; asset: string }>,
): Finding[] {
  const sf = parseSource(code, rel);
  const quote = (line: number) => (lines[line - 1] ?? '').trim().slice(0, 100);
  // A string whose WHOLE value is a GUID, or a GUID QUOTED inside a longer string or template text
  // (JSON in a string, `{"font":"<guid>"}`) — the shape the old line regex caught (#1179 P2 review).
  const literals = findNodes(sf, (n): n is ts.StringLiteralLike | ts.TemplateLiteralLikeNode =>
    ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n))
    .flatMap((n) => {
      const guids = GUID_TEXT.test(n.text) ? [n.text] : [...n.text.matchAll(QUOTED_GUID)].map((m) => m[1]!);
      return guids.flatMap((g) => {
        const guid = g.toLowerCase();
        const asset = index.get(guid);
        // Not a known asset guid ⇒ an entity ref or unrelated data. Ignored by design.
        return asset ? [{ file: rel, line: lineOf(n), guid, asset, text: quote(lineOf(n)) }] : [];
      });
    });
  // A RENAMED import (`import { DEFAULT_FONT_GUID as F }`) is followed to `F`'s reads by symbol.
  const aliases = findNodes(sf, (n): n is ts.ImportSpecifier => ts.isImportSpecifier(n)
    && n.propertyName !== undefined && engineConsts.has(n.propertyName.text) && n.name.text !== n.propertyName.text);
  // `readsOf` also returns a TYPE position (`typeof F`) and a re-export (`export { F }`), which
  // `referencesToPath` excludes for the plain name — excluded here too, so both spellings count alike.
  const isRuntimeRead = (r: ts.Identifier): boolean => {
    if (ts.isExportSpecifier(r.parent)) return false;
    for (let cur = r.parent; cur && !ts.isBlock(cur) && !ts.isSourceFile(cur); cur = cur.parent) if (ts.isTypeNode(cur) && !ts.isExpressionWithTypeArguments(cur)) return false;
    return true;
  };
  const viaAlias = aliases.flatMap((spec) => readsOf(spec.name).filter(isRuntimeRead).map((r) => {
    const hit = engineConsts.get(spec.propertyName!.text)!;
    return { file: rel, line: lineOf(r), guid: hit.guid, asset: hit.asset, text: quote(lineOf(r)), via: spec.propertyName!.text };
  }));
  const nameOf = (r: ts.Expression | ts.BindingElement): string | undefined => {
    if (ts.isBindingElement(r)) return ((r.propertyName ?? r.name) as ts.Identifier).text;
    if (ts.isIdentifier(r)) return r.text;
    if (ts.isPropertyAccessExpression(r)) return r.name.text;
    return ts.isElementAccessExpression(r) ? stringValueOf(r.argumentExpression) : undefined;
  };
  const viaConst = engineConsts.size === 0 ? [] : referencesToPath(sf, ...engineConsts.keys()).flatMap((r) => {
    const name = nameOf(r);
    const hit = name === undefined ? undefined : engineConsts.get(name);
    return hit ? [{ file: rel, line: lineOf(r), guid: hit.guid, asset: hit.asset, text: quote(lineOf(r)), via: name }] : [];
  });
  return [...literals, ...viaConst, ...viaAlias].sort((a, b) => a.line - b.line);
}

interface Finding { file: string; line: number; guid: string; asset: string; text: string; via?: string }

/**
 * Non-project dirs walked ALONGSIDE `discoverProjects()`. Both are currently clean (0 GUID
 * literals), but neither is a game/demo, so neither was in the original walk — a real gap:
 * `engine/templates/starter` is what `scaffold-project.mjs` mints EVERY new game from, so a GUID
 * literal added there would propagate to every future project unguarded; `engine/app` is the
 * app-shell code every project shares. Added by #53's close-out follow-up.
 */
const EXTRA_SCAN_DIRS = [
  path.join(PROJECT_ROOT, 'engine', 'templates', 'starter'),
  path.join(PROJECT_ROOT, 'engine', 'app'),
];

function findAssetGuidLiterals(): Finding[] {
  const index = buildGuidIndex();
  const engineConsts = engineAssetGuidConstants(index);
  const found: Finding[] = [];
  const scanDirs = [...(discoverProjects(PROJECT_ROOT) as { dir: string }[]).map((p) => p.dir), ...EXTRA_SCAN_DIRS];
  for (const dir of scanDirs) {
    for (const file of walkFiles(dir)) {
      const rel = path.relative(PROJECT_ROOT, file).replace(/\\/g, '/');
      // A comment is never a reference — it cannot make the build keep anything. This applies to
      // BOTH forms: a doc comment that quotes a guid (this repo's comments cite guids and constant
      // names freely, e.g. Court's own note about DEFAULT_FONT_GUID) would otherwise be reported as
      // a live ref, which is a false positive that costs the guard its credibility. An import is how
      // a constant's name ARRIVES, not a use of it, so it is not reported either.
      const { code } = readScannedSource(file);
      found.push(...assetRefsIn(code, code.split('\n'), rel, index, engineConsts));
    }
  }
  return found;
}

const findings = hasGames ? findAssetGuidLiterals() : [];

// Maintaining PENDING_MIGRATION by hand is how a list like this goes wrong, so it is
// machine-producible: `MODOKI_DUMP_CODE_ASSET_REFS=1 npx vitest run --config engine/vite.config.ts \
//   engine/tests/assets/codeAssetRefs.test.ts` prints the exact literal to paste.
if (process.env.MODOKI_DUMP_CODE_ASSET_REFS) {
  // Counted per file+guid: the list is keyed that way and spends one row unit per MATCH, so the
  // dump emits `{ guid, count }` where a guid is on more than one line — the exact literal to paste.
  const byFile = new Map<string, Map<string, number>>();
  for (const f of findings) {
    const guids = byFile.get(f.file) ?? new Map<string, number>();
    guids.set(f.guid, (guids.get(f.guid) ?? 0) + 1);
    byFile.set(f.file, guids);
  }
  console.log(JSON.stringify([...byFile].map(([file, guids]) => ({
    file, guids: [...guids].map(([guid, count]) => (count === 1 ? guid : { guid, count })),
  })), null, 2));
}

describe('game code must not reference assets by GUID literal (#53)', () => {
  // (#866) Non-vacuity for the ENGINE scan, which is NOT games-gated. Deliberately outside the
  // skipIf below: that one asserts about `discoverProjects`, a different producer, and it does
  // not run on a checkout without `games/` — i.e. exactly the public/`windows-latest` leg where
  // a vacuously-passing corpus guard is supposed to go red. `walkFiles` discards git's `rel`,
  // so if its enumeration or its `under` prefix ever stops matching, every guard in this file
  // passes having read no files at all.
  it('the ref detector sees a WRAPPED constant argument and a quoted GUID, and not an import or a comment (#1179)', () => {
    const FONT = 'beef0000-0000-4000-8000-000000000002';
    const index = new Map([[FONT, 'fonts/default.json']]);
    const consts = new Map([['DEFAULT_FONT_GUID', { guid: FONT, asset: 'fonts/default.json' }]]);
    const raw = [
      "import { DEFAULT_FONT_GUID, other } from '@modoki/engine';",
      'useFont(',
      '  DEFAULT_FONT_GUID,',
      '  12,',
      ');',
      `const icon = { K: '${FONT}' }; // was '${FONT}'`,
      "const entity = 'aaaaaaaa-0000-4000-8000-000000000000';",
      // #1179 P2 review: JSON in a string, a renamed import, and bracket access.
      `const json = '{"font":"${FONT}"}';`,
      "import { DEFAULT_FONT_GUID as F } from '@modoki/engine';",
      'use(F); type T = typeof F; export { F };',
      "use(engine['DEFAULT_FONT_GUID']);",
    ].join('\n');
    const refs = assetRefsIn(stripComments(raw), raw.split('\n'), 'games/x/a.ts', index, consts);
    expect(refs.map((r) => `${r.line}:${r.via ?? 'literal'}`)).toEqual(['3:DEFAULT_FONT_GUID', '6:literal', '8:literal', '10:DEFAULT_FONT_GUID', '11:DEFAULT_FONT_GUID']);
    const decl = "/** export const OLD_GUID = 'beef0000-0000-4000-8000-000000000002'; */\nexport const NEW_GUID =\n  'beef0000-0000-4000-8000-000000000002';\nconst LOCAL_GUID = 'beef0000-0000-4000-8000-000000000002';";
    expect(exportedGuidConsts(stripComments(decl), 'e.ts')).toEqual([{ name: 'NEW_GUID', guid: FONT }]);
  });

  it('the engine source scan is not vacuous', () => {
    const engineSrc = path.join(PROJECT_ROOT, 'engine', 'packages', 'modoki', 'src');
    expect(
      walkFiles(engineSrc).length,
      'the engine source scan reached almost nothing — the enumeration is broken, not the tree empty',
    ).toBeGreaterThan(100);
  });
  it.skipIf(!hasGames)('finds project sources to scan (sanity: the guard is actually looking)', () => {
    expect(discoverProjects(PROJECT_ROOT).length).toBeGreaterThan(0);
  });

  it.skipIf(!hasGames)('no NEW asset-GUID literal in game/demo code, and the backlog only shrinks', () => {
    assertExemptionLedger({
      label: 'PENDING_MIGRATION in codeAssetRefs',
      population: findings.map((f) => ({
        item: `${f.file}::${f.guid}`,
        site: `${f.file}:${f.line} → ${f.asset}${f.via ? ` (via the imported ${f.via})` : ''}\n      ${f.text}`,
      })),
      // One row per (file, guid), spending `count` lines. Over-blessed is the old "still fires"
      // test: a migrated ref must be deducted here, and its asset-keep.json line dropped, in the
      // same commit — a backlog that outlives its entries silently re-permits the ref.
      exempt: PENDING_MIGRATION.flatMap((p) => p.guids.map((g) => (typeof g === 'string'
        ? { item: `${p.file}::${g}`, reason: p.note }
        : { item: `${p.file}::${g.guid}`, count: g.count, reason: p.note }))),
      floor: 1,
      fix: 'A GUID literal in game code is a reference THE BUILD CANNOT SEE: the tree-shaker walks the '
        + 'scene→prefab→mesh→material graph, so the asset is dropped from the production build AND '
        + 'the manifest, and it fails only in a real build — dev serves everything off disk, so the '
        + 'game looks perfect right up until you ship it. '
        + "Do NOT add it to asset-keep.json: that list is hand-maintained and NOTHING fails when "
        + 'someone forgets an entry, which is the whole reason this guard exists. Put the ref on a '
        + "RESOURCE TRAIT authored in the scene instead — the tree-shaker's generic trait sweep "
        + 'keeps any GUID that resolves in the asset index, game-defined traits included, with no '
        + 'registration at all. See #53 and CLAUDE.md\'s single-source-of-truth rule.',
    });
  });
});

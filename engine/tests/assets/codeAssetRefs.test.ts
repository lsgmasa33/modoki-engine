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
 * constants is small and ENUMERABLE from source (`ENGINE_GUID_CONST_RE`), and the same
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

// engine/tests/assets/ → repo root (games/ + demos/ live there).
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
// The public engine snapshot ships neither games/ nor demos/ — nothing to audit there.
const hasGames = hasInternalGames();

/** A GUID literal inside a single- or double-quoted string, anywhere in a source line. */
const GUID_LITERAL_RE = /['"]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})['"]/gi;

/**
 * Sites that reference an asset by GUID literal in code and are ACCEPTED, each with the
 * reason it cannot use a resource trait. Shrink-only: adding an entry is a deliberate,
 * reviewed decision, and the reason has to say why the resource-trait pattern does not fit.
 * A stale entry is its own bug (it silences a site that has since been fixed), so the test
 * below also fails on an entry that no longer fires.
 */
const ALLOWED: { file: string; why: string }[] = [];

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
 * Regenerate with: MODOKI_DUMP_CODE_ASSET_REFS=1 npx vitest run --config engine/vite.config.ts \
 *   engine/tests/assets/codeAssetRefs.test.ts
 */
const PENDING_MIGRATION: { file: string; note: string; guids: string[] }[] = [
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

function* walkFiles(dir: string): Generator<string> {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    // dist/ is build OUTPUT (contains bundled copies of the very sources we scan, which would
    // double-report every finding); tools/ is build-time Node code that legitimately handles
    // asset paths/guids while generating them; tests are allowed to name a guid as a fixture.
    if (e.isDirectory()) {
      if (e.name === 'dist' || e.name === 'node_modules' || e.name === 'tools' || e.name === 'tests') continue;
      yield* walkFiles(path.join(dir, e.name));
    } else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) {
      yield path.join(dir, e.name);
    }
  }
}

function urlFor(abs: string, roots: AssetRoot[]): string | null {
  for (const r of roots) {
    if (abs.startsWith(r.absDir + path.sep)) {
      return (r.urlPrefix + '/' + path.relative(r.absDir, abs).replace(/\\/g, '/')).normalize('NFC');
    }
  }
  return null;
}

/** guid → the asset URL that owns it, over every shippable asset under the real roots.
 *  Includes the whole-image SPRITE guid a 2D/UI texture auto-emits, since a sprite field
 *  legitimately holds that derived guid and it is just as invisible to the build. */
function buildGuidIndex(): Map<string, string> {
  const roots = findAssetRoots(PROJECT_ROOT);
  const index = new Map<string, string>();
  for (const r of roots) {
    for (const abs of walkFiles0(r.absDir)) {
      const url = urlFor(abs, roots);
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

/** Asset-tree walker — separate from walkFiles (which is source-only, .ts/.tsx). */
function* walkFiles0(dir: string): Generator<string> {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles0(full);
    else yield full;
  }
}

/** `export const SOME_GUID = '<guid>'` in engine source — the ENGINE's own asset-GUID constants. */
const ENGINE_GUID_CONST_RE = /export const ([A-Za-z_][A-Za-z0-9_]*) *(?::[^=]*)?= *['"]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})['"]/g;

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
    for (const m of fs.readFileSync(file, 'utf-8').matchAll(ENGINE_GUID_CONST_RE)) {
      const [, name, guid] = m;
      const asset = index.get(guid.toLowerCase());
      // Same discriminator as the literal path: only a guid a real asset OWNS is a ref the build
      // must be able to see. A sentinel/entity guid declared this way is correctly ignored.
      if (asset) out.set(name, { guid: guid.toLowerCase(), asset });
    }
  }
  return out;
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
  const constRe = engineConsts.size
    ? new RegExp(`\\b(${[...engineConsts.keys()].join('|')})\\b`, 'g')
    : null;
  const found: Finding[] = [];
  const scanDirs = [...(discoverProjects(PROJECT_ROOT) as { dir: string }[]).map((p) => p.dir), ...EXTRA_SCAN_DIRS];
  for (const dir of scanDirs) {
    for (const file of walkFiles(dir)) {
      const rel = path.relative(PROJECT_ROOT, file).replace(/\\/g, '/');
      const lines = fs.readFileSync(file, 'utf-8').split('\n');
      lines.forEach((text, i) => {
        // A comment is never a reference — it cannot make the build keep anything. This applies to
        // BOTH forms: a doc comment that quotes a guid (this repo's comments cite guids and
        // constant names freely, e.g. Court's own note about DEFAULT_FONT_GUID) would otherwise be
        // reported as a live ref, which is a false positive that costs the guard its credibility.
        if (/^\s*(\/\/|\*|\/\*)/.test(text)) return;
        for (const m of text.matchAll(GUID_LITERAL_RE)) {
          const guid = m[1].toLowerCase();
          const asset = index.get(guid);
          // Not a known asset guid ⇒ an entity ref or unrelated data. Ignored by design.
          if (!asset) continue;
          found.push({ file: rel, line: i + 1, guid, asset, text: text.trim().slice(0, 100) });
        }
        // The identifier form, additionally skipped on import lines: an import is how the name
        // arrives, not a use of it, so reporting both just doubles the noise.
        if (!constRe) return;
        if (/^\s*(import|export)\s*\{|^\s*[A-Za-z_][A-Za-z0-9_]*,\s*$|\bfrom\s+['"]/.test(text)) return;
        for (const m of text.matchAll(constRe)) {
          const hit = engineConsts.get(m[1]);
          if (!hit) continue;
          found.push({ file: rel, line: i + 1, guid: hit.guid, asset: hit.asset, text: text.trim().slice(0, 100), via: m[1] });
        }
      });
    }
  }
  return found;
}

const findings = hasGames ? findAssetGuidLiterals() : [];

// Maintaining PENDING_MIGRATION by hand is how a list like this goes wrong, so it is
// machine-producible: `MODOKI_DUMP_CODE_ASSET_REFS=1 npx vitest run --config engine/vite.config.ts \
//   engine/tests/assets/codeAssetRefs.test.ts` prints the exact literal to paste.
if (process.env.MODOKI_DUMP_CODE_ASSET_REFS) {
  // Deduped per file+guid: the list is keyed that way, so a guid referenced from three lines in
  // one file is ONE entry — emitting it three times would produce a list that cannot round-trip.
  const byFile = new Map<string, Set<string>>();
  for (const f of findings) byFile.set(f.file, (byFile.get(f.file) ?? new Set()).add(f.guid));
  console.log(JSON.stringify([...byFile].map(([file, guids]) => ({ file, guids: [...guids] })), null, 2));
}

describe('game code must not reference assets by GUID literal (#53)', () => {
  it.skipIf(!hasGames)('finds project sources to scan (sanity: the guard is actually looking)', () => {
    expect(discoverProjects(PROJECT_ROOT).length).toBeGreaterThan(0);
  });

  /** `file:guid` — the key both lists are pinned on, so a NEW literal in an already-listed
   *  file is still a failure. Pinning per FILE would have let sling grow a 12th ref for free. */
  const key = (file: string, guid: string) => `${file}:${guid}`;
  const allowedFiles = new Set(ALLOWED.map((a) => a.file));
  const pendingKeys = new Set(PENDING_MIGRATION.flatMap((p) => p.guids.map((g) => key(p.file, g))));

  it.skipIf(!hasGames)('no NEW asset-GUID literal in game/demo code', () => {
    const offenders = findings
      .filter((f) => !allowedFiles.has(f.file) && !pendingKeys.has(key(f.file, f.guid)))
      .map((f) => `${f.file}:${f.line} → ${f.asset}${f.via ? ` (via the imported ${f.via})` : ''}\n      ${f.text}`);
    expect(
      offenders,
      'A GUID literal in game code is a reference THE BUILD CANNOT SEE: the tree-shaker walks the '
        + 'scene→prefab→mesh→material graph, so the asset is dropped from the production build AND '
        + 'the manifest, and it fails only in a real build — dev serves everything off disk, so the '
        + 'game looks perfect right up until you ship it. '
        + "Do NOT add it to asset-keep.json: that list is hand-maintained and NOTHING fails when "
        + 'someone forgets an entry, which is the whole reason this guard exists. Put the ref on a '
        + "RESOURCE TRAIT authored in the scene instead — the tree-shaker's generic trait sweep "
        + 'keeps any GUID that resolves in the asset index, game-defined traits included, with no '
        + 'registration at all. See #53 and CLAUDE.md\'s single-source-of-truth rule.',
    ).toEqual([]);
  });

  it.skipIf(!hasGames)('every ALLOWED entry still fires (no stale exemptions)', () => {
    const firing = new Set(findings.map((f) => f.file));
    const stale = ALLOWED.filter((a) => !firing.has(a.file)).map((a) => a.file);
    expect(
      stale,
      'These files are exempted but no longer contain an asset-GUID literal — the exemption is '
        + 'silencing nothing and would silence a real regression later. Remove them from ALLOWED.',
    ).toEqual([]);
  });

  it.skipIf(!hasGames)('every PENDING_MIGRATION guid still fires (the backlog only shrinks)', () => {
    const firing = new Set(findings.map((f) => key(f.file, f.guid)));
    const stale = [...pendingKeys].filter((k) => !firing.has(k));
    expect(
      stale,
      'These refs are listed as pending migration but no longer appear in code — either they were '
        + 'migrated to a resource trait (good: delete the entry, and drop the matching '
        + 'asset-keep.json line in the same commit) or the file/guid moved. A backlog that outlives '
        + 'its entries stops being able to tell you what is left, and silently re-permits the ref '
        + 'if it comes back.',
    ).toEqual([]);
  });
});

/** A meta-sidecar write REPLACES the file, so every writer must read-modify-write.
 *
 *  WHY. `/api/write-meta` → `writeMetaSidecar` → `writeJsonAtomic(sidecarPath, committed)`: no
 *  merge with what is on disk, by design (it also has to split the local-only cache keys out).
 *  Every writer in the editor therefore spreads the loaded meta first — except the two
 *  postprocessor controls, which posted a bare `{version: 1, postprocessor}` and destroyed the
 *  rest of the sidecar.
 *
 *  On a real model (`demos/forest-camp/runtime/assets/models/char_Ranger.glb.meta.json`) the file
 *  holds `version, id, rig, generated, modelCache`. Picking a postprocessor left
 *  `{version: 1, postprocessor}` — losing:
 *    - `id`, the asset's STABLE GUID. Every scene/mesh ref to the model dangles, and the next scan
 *      mints a new guid, so the refs cannot even be repaired by re-importing.
 *    - `generated`, the derived-file cleanup list → the meshes/materials it produced are orphaned.
 *    - `rig` and `modelCache` (LOD paths/distances/hash).
 *  ...and downgrading `version` 2 → 1. The batch view did it to EVERY selected model per click.
 *
 *  Found by the close-out sweep of the 9-slice work, not by the reported bug — it predates that
 *  range. Guarded here as a source rule because the failure is invisible at the call site: the
 *  post succeeds, the UI updates, and the damage is a file nobody re-reads until much later.
 *
 *  ⚠️ Since #784/#778/#767 (docs/format-versioning.md § 2b) editor writers no longer supply
 *  `version` at all — `writeMetaSidecar` stamps `SIDECAR_FORMAT_VERSION` unconditionally and a
 *  caller's `version` was always ignored. That retired the `version:\s*\d` literal this file used
 *  to anchor on to LOCATE each write call's payload literal — anchoring there worked only because
 *  every writer happened to carry that (inert) literal, and removing it made the writer invisible
 *  to a detector keyed on it. The detector below is re-anchored on the write CALL itself
 *  (`writeMetaOrWarn(` / `'/api/write-meta'`), which is structural and cannot be "cleaned up"
 *  the way a redundant literal can.
 *
 *  ⚠️ #845 moved most of these calls behind a PARK instead of an immediate write — the field
 *  handler now calls `parkMetaEdit(path, updatedMeta)` (`editor/scene/pendingMeta.ts`), which
 *  `flushPendingMeta`/`flushPendingMetaFor` later hand to `writeMetaOrWarn` verbatim, unmodified.
 *  The clobber risk is IDENTICAL either way — a payload that drops keys is just as destructive
 *  once it reaches disk on Cmd+S as it was on the old immediate write — so the anchor now also
 *  matches `parkMetaEdit(`. `pendingMeta.ts` itself is EXCLUDED (see `EXCLUDED` below): it
 *  forwards whatever was parked and constructs no payload of its own, exactly like
 *  `widgets.tsx` forwards whatever it is given — the actual literal is still checked, just at
 *  the PARK call site instead of the write call site. */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { readScannedSource } from '@modoki/engine/testing';
import {
  accessPath, callsTo, declarationOf, enclosingFunction, findNodes, flatText, isBlock, lineOf,
  objectLiteralKeys, parseSource, propertyValue, unwrapValue, ts,
} from '@modoki/engine/testing/sourceAst';

const SRC = path.resolve(__dirname, '../../packages/modoki/src/editor');
const read = (rel: string) => readScannedSource(path.join(SRC, rel)).code;

/** `repoFiles()`'s own `rel` is repo-root-relative (`engine/packages/modoki/src/editor/...`);
 *  WRITERS is keyed SRC-relative (`panels/Inspector.tsx`). Stripped by a plain prefix check, not
 *  a `path.relative`/`sep` round-trip (#799/#771/#805 Phase 4) — THROW rather than tolerate a
 *  miss, same reasoning as `materialCloneStamp.test.ts`'s `runtimeFiles()`: a silent truncation
 *  would make every WRITERS lookup quietly stop matching. */
const EDITOR_PREFIX = 'engine/packages/modoki/src/editor/';
function editorSourceFiles(): { rel: string }[] {
  return repoFiles({ under: SRC, match: /\.tsx?$/, floor: 150 }).map(({ rel }) => {
    if (!rel.startsWith(EDITOR_PREFIX)) {
      throw new Error(
        `metaMergeNotClobber: ${rel} is not under "${EDITOR_PREFIX}", but \`under\` is SRC — the `
        + 'enumeration root and this prefix strip have drifted apart.',
      );
    }
    return { rel: rel.slice(EDITOR_PREFIX.length) };
  });
}

/** Files that write (or PARK, #845) a meta sidecar and must therefore merge rather than replace.
 *  Derived by grepping `engine/packages/modoki/src/editor/**` for the write/park call itself
 *  (`writeMetaOrWarn(`, `writeMetaWholesale(`, `parkMetaEdit(`, or the `'/api/write-meta'` route
 *  string) — an artifact-shaped search, not a guess from memory.
 *
 *  ⚠️ `writeMetaWholesale(` was added when #874 introduced it, and adding it was the POINT: three
 *  explicit-action writers moved onto that helper, and without the new name this guard silently
 *  dropped `makeTexture2D.ts` from its own corpus — a file that still builds a merged payload.
 *  A refactor that renames the call is exactly how a merge-not-clobber guard loses a writer, so
 *  the name list is what has to keep up. This guard caught it; the list is not optional. `widgets.tsx` (defines `writeMetaOrWarn`) and
 *  `scene/pendingMeta.ts` (defines `parkMetaEdit`/the flush) are deliberately excluded: both
 *  forward whatever payload they are given and construct none themselves, so neither has a
 *  literal of its own to check. */
const WRITERS = [
  'panels/Inspector.tsx',
  'panels/NineSliceEditor.tsx',
  'panels/SpriteEditor.tsx',
  'panels/makeTexture2D.ts',
  'panels/assetViews/AudioAssetView.tsx',
  'panels/assetViews/EnvironmentAssetView.tsx',
  'panels/assetViews/FontAssetView.tsx',
  'panels/assetViews/ModelAssetView.tsx',
  'panels/assetViews/ModelBatchView.tsx',
  'panels/assetViews/TextureAssetView.tsx',
  'panels/assetViews/TextureBatchView.tsx',
  'panels/assetViews/VideoAssetView.tsx',
  'scene/modelImport.ts',
];

/** Lines of `src` with comment-only lines dropped, so a detector anchored on a literal
 *  cannot mistake a MENTION of that literal inside a comment (prose describing the bug,
 *  a worked example, ...) for the real write call. Shared by every detector below so
 *  they cannot drift apart — that drift is exactly how the liveness check below once
 *  "anchored" on a comment while the real literal it was meant to protect was deleted. */
function codeLines(src: string): string[] {
  return src.split('\n').filter((raw) => {
    const line = raw.trim();
    return !(line.startsWith('*') || line.startsWith('//'));
  });
}

/** `true` if `src` contains at least one real meta-sidecar write call. Line-based (not the
 *  brace-parsing machinery below) because this only needs to prove the corpus is real — that
 *  every file in WRITERS genuinely posts to the endpoint this guard cares about — not to find
 *  and evaluate the payload. */
function hasMetaWriteCall(src: string): boolean {
  // ⚠️ `planMetaBatchWrite(` counts as a write call (#903): the batch views reach the sidecar
  // through it now, and an anchor that stops matching is SILENT — this file's own #784 lesson.
  return codeLines(src).some((line) => /writeMetaOrWarn\(|writeMetaWholesale\(|\/api\/write-meta|parkMetaEdit\(|planMetaBatchWrite\(/.test(line));
}

// ── Payload-literal extraction ──────────────────────────────────────────────────────────────
// The detector's job is "does this meta-write literal merge or clobber", not "does it contain
// a version". So it locates the literal via the CALL (structural, cannot be refactored away by
// a legitimate cleanup) rather than via a value a legitimate cleanup can remove. A write call
// either carries its payload inline (`writeMetaOrWarn(p, { ... })`) or passes a variable/
// shorthand property that was assigned a few lines earlier (`const updatedMeta = { ... };
// writeMetaOrWarn(path, updatedMeta)`) — both shapes occur in the real corpus, so both are
// resolved here.
//
// ⚠️ Every extent below is the parser's (#1241). The version before it balanced brackets by hand,
// split arguments on a depth-counted comma, and bound an identifier to the NEAREST `const` of that
// name earlier in the file — scope-blind, so a same-named `const` in another function answered for
// this call's payload, and a bracket inside a string moved every edge. It carried a second check
// ("two calls resolved to the same declaration") only to catch that mis-binding; resolving by scope
// removes the cause, so the check went with it.

/** The object literal a payload expression IS: the literal itself, or the `const` it names —
 *  resolved by the file's own scopes. Anything else THROWS: a payload this detector cannot
 *  resolve must never be treated as clean (`const meta = computeMeta(x)` included). */
function payloadLiteral(e: ts.Expression, where: string): ts.ObjectLiteralExpression {
  const u = unwrapValue(e);
  if (ts.isObjectLiteralExpression(u)) return u;
  if (ts.isIdentifier(u)) {
    const decl = declarationOf(u);
    const init = decl && ts.isVariableDeclaration(decl) && ts.isVariableDeclarationList(decl.parent)
      && (decl.parent.flags & ts.NodeFlags.Const) && decl.initializer ? unwrapValue(decl.initializer) : undefined;
    if (init && ts.isObjectLiteralExpression(init)) return init;
    throw new Error(`metaPayloadLiterals: '${u.text}' (${where}) does not resolve to a \`const\` object literal — `
      + 'this write call\'s payload cannot be verified and must not be treated as clean');
  }
  throw new Error(`metaPayloadLiterals: unrecognized meta payload '${flatText(u)}' (${where})`);
}

/** The object literals a `planMetaBatchWrite` mutate callback RETURNS: a concise `(m) => ({ … })`,
 *  or every `return` of a block body that belongs to the callback itself (not a nested function).
 *  Both forms are in use; a return that is not a literal throws. */
function mutateReturnLiterals(e: ts.Expression | undefined, where: string): ts.ObjectLiteralExpression[] {
  const fn = e && unwrapValue(e);
  if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
    throw new Error(`metaPayloadLiterals: planMetaBatchWrite's mutate is not an inline function (${where})`);
  }
  const returned = isBlock(fn.body)
    ? findNodes(fn.body, ts.isReturnStatement).filter((r) => enclosingFunction(r) === fn).map((r) => r.expression)
    : [fn.body];
  if (returned.length === 0) throw new Error(`metaPayloadLiterals: planMetaBatchWrite mutate returns nothing (${where})`);
  return returned.map((r) => {
    const lit = r && unwrapValue(r);
    if (!lit || !ts.isObjectLiteralExpression(lit)) {
      throw new Error(`metaPayloadLiterals: planMetaBatchWrite mutate returns no object literal (${where})`);
    }
    return lit;
  });
}

/** For every meta-sidecar write call in `code`, the object literal it writes — resolving through a
 *  variable/shorthand property where the call doesn't carry the literal inline. Throws (loudly, in a
 *  test) on a call shape this doesn't recognize, rather than silently skipping it — a skipped call
 *  is a write this guard is no longer checking. */
function metaPayloadLiterals(code: string, label: string): ts.ObjectLiteralExpression[] {
  const sf = parseSource(code, label);
  const where = (n: ts.Node) => `${label}:${lineOf(n)}`;
  const literals: ts.ObjectLiteralExpression[] = [];

  // Shape 1: writeMetaOrWarn(<pathExpr>, <payloadExpr>) or parkMetaEdit(<pathExpr>, <payloadExpr>)
  // — #845 gave every field handler a SECOND way to reach the sidecar (park now, write later),
  // and it carries the exact same (pathExpr, payloadExpr) shape, so one pass handles both.
  for (const call of callsTo(sf, 'writeMetaOrWarn', 'writeMetaWholesale', 'parkMetaEdit')) {
    const payload = call.arguments[1];
    if (!payload) throw new Error(`metaPayloadLiterals: meta write/park call with <2 args (${where(call)})`);
    literals.push(payloadLiteral(payload, where(call)));
  }

  // Shape 3: `planMetaBatchWrite(<paths>, <metas>, (m) => <payload>)` — #903 moved the two batch
  // views' payload construction OFF their `parkMetaEdit(` call and INTO a mutate callback handed to
  // the shared planner, which `parkPlannedMetaEdits` then parks verbatim. The clobber risk is
  // unchanged: a mutate that returns a bare `{postprocessor}` destroys the sidecar exactly as the
  // old bare `parkMetaEdit(p, {version, postprocessor})` did, and on EVERY selected model per click.
  //
  // ⚠️ Extending the detector rather than dropping the two views from WRITERS, deliberately. The
  // views still build the payload; only the call they hand it to changed. Removing them would have
  // turned a red gate green by making this guard BLIND to the exact destruction it exists for — the
  // "a fix scoped to the instances someone listed reads afterwards as a fix to the class" trap this
  // file's own header is about.
  for (const call of callsTo(sf, 'planMetaBatchWrite')) {
    if (call.arguments.length < 3) throw new Error(`metaPayloadLiterals: planMetaBatchWrite with <3 args (${where(call)})`);
    literals.push(...mutateReturnLiterals(call.arguments[2], where(call)));
  }

  // Shape 2: a raw `backendFetch('/api/write-meta', { ..., body: JSON.stringify({ path, meta: <X> }) })`
  // — quoted OR template-literal endpoint. The corpus test (`hasMetaWriteCall`) anchors on the
  // bare substring `/api/write-meta` regardless of quote style, so this extractor must recognize
  // every style that anchor does — otherwise a template-literal endpoint passes the corpus check
  // while contributing zero payload literals here, and its clobber ships unexamined. The body is
  // read off THIS call's options object: the text version searched forward for the next
  // `JSON.stringify(` in the file, whoever's it was.
  for (const lit of findNodes(sf, ts.isStringLiteralLike).filter((l) => l.text === '/api/write-meta')) {
    const call = lit.parent;
    if (!ts.isCallExpression(call) || call.arguments[0] !== lit) {
      throw new Error(`metaPayloadLiterals: '/api/write-meta' is not a fetch call's first argument (${where(lit)})`);
    }
    const body = propertyValue(call.arguments[1], 'body');
    const stringify = body && unwrapValue(body as ts.Expression);
    if (!stringify || !ts.isCallExpression(stringify) || accessPath(stringify.expression) !== 'JSON.stringify') {
      throw new Error(`metaPayloadLiterals: '/api/write-meta' with no JSON.stringify body (${where(lit)})`);
    }
    const meta = propertyValue(stringify.arguments[0], 'meta');
    if (!meta || !ts.isExpression(meta)) {
      throw new Error(`metaPayloadLiterals: write-meta body missing a 'meta' property (${where(lit)})`);
    }
    // A `{ meta }` shorthand comes back as its name, which resolves like any other identifier.
    literals.push(payloadLiteral(meta, where(lit)));
  }

  return literals;
}

/** A payload literal that MERGES an existing sidecar or CREATES a complete one — read off the
 *  literal's OWN members (a spread, or an `id` key), not anywhere in its text: `generated: { id }`
 *  nested inside is not the sidecar's id. */
function mergesOrCreates(literal: ts.ObjectLiteralExpression): boolean {
  return (objectLiteralKeys(literal) ?? []).some((k) => k === '...' || k === 'id');
}

/** A meta payload literal that neither MERGES an existing sidecar nor CREATES a complete one.
 *
 *  The rule a legitimate write satisfies, one or the other:
 *   - it spreads the loaded meta first — `{ ...(meta ?? {}), … }` — an EDIT; or
 *   - it carries an explicit `id` — `{ id: modelGuid, generated: … }` — the model IMPORT path,
 *     which legitimately authors a fresh sidecar from scratch.
 *
 *  Anything else replaces the file with a fragment. */
function clobberingMetaPayloads(code: string, label = 'fixture.ts'): string[] {
  return metaPayloadLiterals(code, label).filter((l) => !mergesOrCreates(l)).map(flatText);
}

describe('meta sidecar writers merge instead of replacing', () => {
  for (const rel of WRITERS) {
    it(`${rel} never posts a meta literal that drops the existing keys`, () => {
      expect(clobberingMetaPayloads(read(rel), rel)).toEqual([]);
    });
  }

  it('the server really does REPLACE — the premise this rule rests on', () => {
    // If writeMetaSidecar ever starts merging, this rule becomes unnecessary and this test says
    // so, rather than the rule quietly outliving its reason.
    const sidecar = readScannedSource(path.resolve(__dirname, '../../plugins/meta-sidecar.ts')).code;
    expect(sidecar).toMatch(/writeJsonAtomic\(sidecarPath\(absPath\), committed\)/);
    expect(sidecar).not.toMatch(/readMetaSidecar\(absPath\)[\s\S]{0,200}\.\.\./); // no read-and-merge
  });

  it('every WRITERS file actually posts to the meta-write endpoint — the corpus is real, not aspirational', () => {
    // ⚠️ This used to anchor on the `version:\s*\d` literal every writer carried. Since
    // #784/#778/#767 writers don't supply `version` at all (docs/format-versioning.md § 2b), so
    // that anchor is gone — by design, not by accident. Anchoring on the WRITE CALL itself
    // instead means a future cleanup cannot make a writer invisible to this guard just by
    // deleting a value the writer never needed. `toEqual(WRITERS)`, not a weaker bound, so a
    // failure names exactly which file has no write call left in it (or was added here without
    // one).
    const anchored = WRITERS.filter((rel) => hasMetaWriteCall(read(rel)));
    expect(anchored).toEqual(WRITERS);
  });

  it('a file with a write call resolves at least one payload literal — a vacuous pass is a failure', () => {
    // Closes the class Fix 2 found: `hasMetaWriteCall` (a bare substring test) and
    // `metaPayloadLiterals`'s shape-2 anchor (quotes required) could disagree — a template-
    // literal endpoint (`` `/api/write-meta` ``) made the corpus check pass while the extractor
    // silently found nothing to examine, so a clobbering payload behind it shipped unexamined. A
    // write call this guard can see but cannot resolve into any literal is exactly that vacuous
    // pass, whatever new call shape produces it next — so this asserts the invariant directly,
    // by file, rather than re-deriving today's two known culprits.
    for (const rel of WRITERS) {
      const src = read(rel);
      if (!hasMetaWriteCall(src)) continue;
      const literals = metaPayloadLiterals(src, rel);
      if (literals.length === 0) {
        throw new Error(`${rel}: has a meta-write call but resolved zero payload literals — vacuous pass`);
      }
    }
  });

  it('no editor-side sidecar writer supplies its own version — the server stamps it alone', () => {
    // Regression guard for #784/#778/#767: `writeMetaSidecar` stamps `SIDECAR_FORMAT_VERSION`
    // unconditionally (engine/plugins/meta-sidecar.ts), so a writer supplying its own `version`
    // is always dead weight today and a stale-number trap the day the constant bumps and this
    // writer wasn't touched. None of them should ever carry one again.
    //
    // Scoped to the RESOLVED meta-sidecar payload literals (`metaPayloadLiterals`), not a raw
    // scan of the whole file — a couple of these files (ModelAssetView.tsx, modelImport.ts) also
    // write sibling `.mesh.json`/`.mat.json` documents that legitimately carry their OWN
    // `version` (a different document, a different owner, out of scope per
    // docs/format-versioning.md § 3) and a whole-file scan would wrongly flag those too.
    const offenders = WRITERS.filter((rel) =>
      metaPayloadLiterals(read(rel), rel).some((literal) => objectLiteralKeys(literal)?.includes('version')),
    );
    expect(offenders).toEqual([]);
  });

  it('WRITERS is complete — every file in the editor tree with a meta-write call is listed', () => {
    // Fix 3: WRITERS is a hand-maintained list every assertion above iterates, so a new writer
    // added to the codebase and never added here is untested silently. This DERIVES the corpus
    // by walking the real tree (git-tracked or not — a fresh writer file is on disk before it is
    // ever committed) and comparing it to WRITERS, so the completeness check cannot itself go
    // stale the way the list it verifies did (6 files, per the brief that added this test).
    // Both DEFINE a write/park call and build no payload of their own — they forward whatever
    // they are handed. `scene/pendingMeta.ts`'s `meta` comes off a `for…of` loop over the pending
    // map, not a `const meta = {…}` this guard's identifier resolver could bind to; the literal it
    // forwards was already checked at its origin — the PARK call site in whichever WRITERS file
    // built it.
    // `panels/assetEditorBindings.ts` joins them for the SAME reason, not a new one (#845
    // close-out): when an asset is renamed it re-parks the doc it just took verbatim out of
    // the registry (`peekPendingMeta` → `parkMetaEdit`), so like the other two it forwards a
    // payload rather than composing one. There is no literal here to check, and the literal
    // that matters was already checked wherever the edit was originally parked.
    // ⚠️ `panels/assetViews/metaBatchLoad.ts` joins the forwarders (#903): `parkPlannedMetaEdits`
    // parks whatever the PLANNER produced and constructs no payload of its own, exactly as
    // `pendingMeta.ts` forwards what was parked. The literal it eventually parks is still checked —
    // at the `planMetaBatchWrite` call site in each view (Shape 3 above), which is where it is built.
    const EXCLUDED = ['panels/assetViews/widgets.tsx', 'scene/pendingMeta.ts', 'panels/assetEditorBindings.ts', 'panels/assetViews/metaBatchLoad.ts'];

    const discovered = editorSourceFiles()
      .map(({ rel }) => rel)
      .filter((rel) => hasMetaWriteCall(read(rel)));

    expect(discovered.sort()).toEqual([...WRITERS, ...EXCLUDED].sort());
  });

  it('the detector reads the payload by scope and by member, not by nearby text (#1241)', () => {
    const clobbers = (src: string) => clobberingMetaPayloads(src, 'fixture.ts');
    // H1 — a same-named `const` in ANOTHER function sits nearer the call than the one it names. The
    // nearest-`const` lookup bound the call to that merge and passed the clobber.
    expect(clobbers([
      'const updated = { postprocessor: x };',
      'function other() { const updated = { ...meta, a }; use(updated); }',
      'void writeMetaOrWarn(p, updated);',
    ].join('\n'))).toEqual(['{ postprocessor: x }']);
    // H2 — `...` inside a string, and an `id` inside a NESTED literal, are not a spread or the
    // sidecar's id. The text test (`includes('...')`, `/\bid\s*:/`) passed both.
    expect(clobbers("void writeMetaOrWarn(p, { label: 'more...', postprocessor: x });")).toHaveLength(1);
    expect(clobbers('void writeMetaOrWarn(p, { generated: { id: g }, postprocessor: x });')).toHaveLength(1);
    // H3 — a bracket inside a string does not move an argument's edge.
    expect(clobbers("void writeMetaOrWarn(p, { note: ')}', ...meta });")).toEqual([]);
    // A block-bodied mutate: EVERY return of the callback is a payload, and a nested function's
    // return is not.
    expect(clobbers([
      'planMetaBatchWrite(paths, metas, (m) => {',
      '  if (!m) return { early: 1 };',
      '  const f = () => { return { unrelated: 1 }; };',
      '  if (m.done) return { ...m };',
      '  return { postprocessor: f() };',
      '});',
    ].join('\n'))).toEqual(['{ early: 1 }', '{ postprocessor: f() }']);
  });

  it('a payload the detector cannot resolve THROWS — never reads as clean', () => {
    const extract = (src: string) => () => metaPayloadLiterals(src, 'fixture.ts');
    expect(extract('const meta = computeMeta(x); writeMetaOrWarn(p, meta);')).toThrow(/const` object literal/);
    expect(extract('let meta = { ...m }; writeMetaOrWarn(p, meta);')).toThrow(/const` object literal/);
    expect(extract('function f(meta) { writeMetaOrWarn(p, meta); }')).toThrow(/const` object literal/);
    expect(extract('writeMetaOrWarn(p);')).toThrow(/<2 args/);
    expect(extract('writeMetaOrWarn(p, build());')).toThrow(/unrecognized meta payload/);
    expect(extract('planMetaBatchWrite(paths, metas, mutate);')).toThrow(/not an inline function/);
    expect(extract('planMetaBatchWrite(paths, metas, (m) => { return build(m); });')).toThrow(/no object literal/);
    expect(extract("backendFetch('/api/write-meta', { method: 'POST', body: payload });")).toThrow(/no JSON.stringify body/);
    expect(extract("backendFetch('/api/write-meta', { body: JSON.stringify({ path }) });")).toThrow(/missing a 'meta'/);
    expect(extract("const url = '/api/write-meta';")).toThrow(/first argument/);
  });

  it('the detector detects — merge/create/clobber, both inline and via a variable', () => {
    const bad = (src: string) => clobberingMetaPayloads(src, 'fixture.tsx').length === 1;

    // Clobber: the two real shapes the historical bug took.
    expect(bad(`
      await backendFetch('/api/write-meta', {
        method: 'POST',
        body: JSON.stringify({ path, meta: { version: 1, postprocessor: x } }),
      });
    `)).toBe(true);
    expect(bad(`void writeMetaOrWarn(p, { version: 2, postprocessor: next });`)).toBe(true);
    // ...and the shape a first cut of this guard let through: the literal bound to a const
    // first, then passed by name — exactly Inspector's original bug.
    expect(bad(`
      const updated = { version: 1, postprocessor: newPostprocessor };
      void writeMetaOrWarn(asset.path, updated);
    `)).toBe(true);
    // #845: the same clobber, reached through the PARK call instead of the immediate write —
    // the detector must not treat "not written yet" as "therefore safe".
    expect(bad(`
      const updated = { version: 1, postprocessor: newPostprocessor };
      parkMetaEdit(asset.path, updated);
    `)).toBe(true);

    // Legitimate: merges, inline and via a variable.
    expect(bad(`void writeMetaOrWarn(p, { ...(metas[p] ?? {}), postprocessor: next });`)).toBe(false);
    expect(bad(`
      const updatedMeta = { ...(meta ?? {}), type };
      writeMetaOrWarn(path, updatedMeta);
    `)).toBe(false);
    expect(bad(`
      const updatedMeta = { ...(meta ?? {}), type };
      parkMetaEdit(path, updatedMeta);
    `)).toBe(false);

    // Legitimate: authors a complete sidecar from scratch (import path), inline and via the
    // `meta` shorthand property.
    expect(bad(`
      await backendFetch('/api/write-meta', {
        method: 'POST',
        body: JSON.stringify({ path, meta: { id: modelGuid, generated: { meshes: [] } } }),
      });
    `)).toBe(false);
    expect(bad(`
      const meta = { id: glbGuid, generated: { meshes: [] } };
      await backendFetch('/api/write-meta', {
        method: 'POST',
        body: JSON.stringify({ path, meta }),
      });
    `)).toBe(false);
  });
});

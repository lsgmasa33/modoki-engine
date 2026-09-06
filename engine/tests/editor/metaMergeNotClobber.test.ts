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
 *  the way a redundant literal can. */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { readScannedSource } from '@modoki/engine/testing';

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

/** Files that write a meta sidecar and must therefore merge rather than replace. Derived by
 *  grepping `engine/packages/modoki/src/editor/**` for the write call itself
 *  (`writeMetaOrWarn(` or the `'/api/write-meta'` route string) — an artifact-shaped search, not
 *  a guess from memory. `widgets.tsx` (defines `writeMetaOrWarn`) is deliberately excluded: it
 *  forwards whatever payload it is given and constructs none itself, so it has no literal to
 *  check. */
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
  return codeLines(src).some((line) => /writeMetaOrWarn\(|\/api\/write-meta/.test(line));
}

// ── Payload-literal extraction ──────────────────────────────────────────────────────────────
// The detector's job is "does this meta-write literal merge or clobber", not "does it contain
// a version". So it locates the literal via the CALL (structural, cannot be refactored away by
// a legitimate cleanup) rather than via a value a legitimate cleanup can remove. A write call
// either carries its payload inline (`writeMetaOrWarn(p, { ... })`) or passes a variable/
// shorthand property that was assigned a few lines earlier (`const updatedMeta = { ... };
// writeMetaOrWarn(path, updatedMeta)`) — both shapes occur in the real corpus, so both are
// resolved here.

function extractBalanced(src: string, openIdx: number, openCh: string, closeCh: string): string {
  if (src[openIdx] !== openCh) {
    throw new Error(`extractBalanced: expected '${openCh}' at index ${openIdx}, found '${src[openIdx]}'`);
  }
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === openCh) depth++;
    else if (src[i] === closeCh) {
      depth--;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  throw new Error(`extractBalanced: unbalanced '${openCh}${closeCh}' starting at ${openIdx}`);
}

/** Splits `text` on TOP-LEVEL commas only (depth-tracking `(){}[]`), returning each part's
 *  absolute offset into the ORIGINAL source (`text` starts at `baseOffset` in it) so callers can
 *  re-locate a part's exact position for a further `extractBalanced` call. */
function splitTopLevelWithOffsets(text: string, baseOffset: number): { text: string; start: number }[] {
  const parts: { text: string; start: number }[] = [];
  let depth = 0;
  let curStart = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      parts.push({ text: text.slice(curStart, i), start: baseOffset + curStart });
      curStart = i + 1;
    }
  }
  if (curStart < text.length) parts.push({ text: text.slice(curStart), start: baseOffset + curStart });
  return parts;
}

function firstNonWs(text: string, from: number): number {
  let i = from;
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

/** Finds the nearest `const <ident> = ...` (optionally typed: `const x: T = ...`) BEFORE
 *  `beforeIdx` and returns its full literal text plus the declaration's own offset. This is how
 *  a write call that passes a variable ("`writeMetaOrWarn(path, updatedMeta)`") reaches the
 *  literal that was actually built for the payload.
 *
 *  The nearest declaration is found REGARDLESS of shape — not just brace literals — and then
 *  checked: if it isn't `{ ... }` (e.g. `const meta = computeMeta(x);`), this THROWS rather than
 *  silently falling through to some earlier, unrelated `const <ident> = {` (which is how the
 *  detector used to bind an unrelated function's literal to this call when two same-named
 *  `const`s live in different scopes — a payload this detector cannot resolve must never be
 *  treated as clean). The returned `offset` lets callers detect the OTHER shape of that same
 *  bug: two different write calls both resolving to the identical declaration. */
function resolveIdentifierLiteral(
  codeSrc: string,
  beforeIdx: number,
  ident: string,
): { literal: string; offset: number } {
  const declRe = new RegExp(`const\\s+${ident}\\b[^=]*=\\s*`, 'g');
  let bestDeclIdx = -1;
  let bestValueIdx = -1;
  let dm: RegExpExecArray | null;
  while ((dm = declRe.exec(codeSrc))) {
    if (dm.index < beforeIdx && dm.index > bestDeclIdx) {
      bestDeclIdx = dm.index;
      bestValueIdx = dm.index + dm[0].length;
    }
  }
  if (bestDeclIdx < 0) {
    throw new Error(`resolveIdentifierLiteral: could not find 'const ${ident} = ...' before index ${beforeIdx}`);
  }
  if (codeSrc[bestValueIdx] !== '{') {
    throw new Error(
      `resolveIdentifierLiteral: 'const ${ident} = ...' at index ${bestDeclIdx} (nearest before ${beforeIdx}) ` +
        `is not an object literal — this write call's payload cannot be verified and must not be treated as clean`,
    );
  }
  return { literal: extractBalanced(codeSrc, bestValueIdx, '{', '}'), offset: bestDeclIdx };
}

/** For every meta-sidecar write call in `src`, returns the full text of the object literal it
 *  writes — resolving through a variable/shorthand property where the call doesn't carry the
 *  literal inline. Throws (loudly, in a test) on a call shape this doesn't recognize, rather
 *  than silently skipping it — a skipped call is a write this guard is no longer checking. */
function metaPayloadLiterals(src: string): string[] {
  const codeSrc = codeLines(src).join('\n');
  const literals: string[] = [];
  // Declaration offsets bound by an identifier-resolved payload (Fix 1's other tell): if two
  // DIFFERENT write calls resolve to the exact same `const` declaration, one of them is binding
  // to a literal that was never built for it — the scope-blind lookup finding someone else's
  // same-named `const` because its own local declaration wasn't a brace literal.
  const declOffsets: number[] = [];
  const pushResolved = (resolved: { literal: string; offset: number }) => {
    literals.push(resolved.literal);
    declOffsets.push(resolved.offset);
  };

  // Shape 1: writeMetaOrWarn(<pathExpr>, <payloadExpr>)
  const callRe = /writeMetaOrWarn\(/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(codeSrc))) {
    const parenOpen = m.index + m[0].length - 1;
    const parens = extractBalanced(codeSrc, parenOpen, '(', ')');
    const args = splitTopLevelWithOffsets(parens.slice(1, -1), parenOpen + 1);
    if (args.length < 2) {
      throw new Error(`metaPayloadLiterals: writeMetaOrWarn call with <2 args near index ${m.index}`);
    }
    const payload = args[1];
    const payloadTrimStart = firstNonWs(payload.text, 0);
    const payloadStart = payload.start + payloadTrimStart;
    if (codeSrc[payloadStart] === '{') {
      literals.push(extractBalanced(codeSrc, payloadStart, '{', '}'));
    } else {
      const identMatch = payload.text.slice(payloadTrimStart).match(/^[A-Za-z_$][\w$]*/);
      if (!identMatch) throw new Error(`metaPayloadLiterals: unrecognized writeMetaOrWarn payload '${payload.text}'`);
      pushResolved(resolveIdentifierLiteral(codeSrc, m.index, identMatch[0]));
    }
  }

  // Shape 2: a raw `backendFetch('/api/write-meta', { ..., body: JSON.stringify({ path, meta: <X> }) })`
  // — quoted OR template-literal endpoint. The corpus test (`hasMetaWriteCall`) anchors on the
  // bare substring `/api/write-meta` regardless of quote style, so this extractor must recognize
  // every style that anchor does — otherwise a template-literal endpoint passes the corpus check
  // while contributing zero payload literals here, and its clobber ships unexamined.
  const fetchRe = /(['"`])\/api\/write-meta\1/g;
  while ((m = fetchRe.exec(codeSrc))) {
    const stringifyIdx = codeSrc.indexOf('JSON.stringify(', m.index);
    if (stringifyIdx < 0) {
      throw new Error(`metaPayloadLiterals: '/api/write-meta' with no JSON.stringify body near index ${m.index}`);
    }
    const parenOpen = stringifyIdx + 'JSON.stringify'.length;
    const braceIdx = codeSrc.indexOf('{', parenOpen);
    if (braceIdx < 0) throw new Error(`metaPayloadLiterals: JSON.stringify with no object body near index ${stringifyIdx}`);
    const bodyObj = extractBalanced(codeSrc, braceIdx, '{', '}');
    const props = splitTopLevelWithOffsets(bodyObj.slice(1, -1), braceIdx + 1);
    const metaProp = props.find((p) => /^\s*meta\b/.test(p.text));
    if (!metaProp) throw new Error(`metaPayloadLiterals: write-meta body missing a 'meta' property near index ${m.index}`);
    const colonIdx = metaProp.text.indexOf(':');
    if (colonIdx < 0) {
      // Shorthand `meta` — the property IS the variable, resolve it like any other identifier.
      pushResolved(resolveIdentifierLiteral(codeSrc, m.index, 'meta'));
    } else {
      const localValueStart = firstNonWs(metaProp.text, colonIdx + 1);
      const absValueStart = metaProp.start + localValueStart;
      if (codeSrc[absValueStart] === '{') {
        literals.push(extractBalanced(codeSrc, absValueStart, '{', '}'));
      } else {
        const rest = metaProp.text.slice(localValueStart);
        const identMatch = rest.match(/^[A-Za-z_$][\w$]*/);
        if (!identMatch) throw new Error(`metaPayloadLiterals: unrecognized meta value '${rest}'`);
        pushResolved(resolveIdentifierLiteral(codeSrc, m.index, identMatch[0]));
      }
    }
  }

  const seenOffsets = new Set<number>();
  for (const offset of declOffsets) {
    if (seenOffsets.has(offset)) {
      throw new Error(
        `metaPayloadLiterals: two different write calls resolved to the SAME 'const' declaration ` +
          `(offset ${offset}) — one of them is binding a same-named const from a different scope, ` +
          `not the literal actually built for its own payload`,
      );
    }
    seenOffsets.add(offset);
  }

  return literals;
}

/** A meta payload literal that neither MERGES an existing sidecar nor CREATES a complete one.
 *
 *  The rule a legitimate write satisfies, one or the other:
 *   - it spreads the loaded meta first — `{ ...(meta ?? {}), … }` — an EDIT; or
 *   - it carries an explicit `id` — `{ id: modelGuid, generated: … }` — the model IMPORT path,
 *     which legitimately authors a fresh sidecar from scratch.
 *
 *  Anything else replaces the file with a fragment. */
function clobberingMetaPayloads(src: string): string[] {
  return metaPayloadLiterals(src).filter((literal) => !literal.includes('...') && !/\bid\s*:/.test(literal));
}

describe('meta sidecar writers merge instead of replacing', () => {
  for (const rel of WRITERS) {
    it(`${rel} never posts a meta literal that drops the existing keys`, () => {
      expect(clobberingMetaPayloads(read(rel))).toEqual([]);
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
      const literals = metaPayloadLiterals(src);
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
      metaPayloadLiterals(read(rel)).some((literal) => /version\s*:\s*\d/.test(literal)),
    );
    expect(offenders).toEqual([]);
  });

  it('WRITERS is complete — every file in the editor tree with a meta-write call is listed', () => {
    // Fix 3: WRITERS is a hand-maintained list every assertion above iterates, so a new writer
    // added to the codebase and never added here is untested silently. This DERIVES the corpus
    // by walking the real tree (git-tracked or not — a fresh writer file is on disk before it is
    // ever committed) and comparing it to WRITERS, so the completeness check cannot itself go
    // stale the way the list it verifies did (6 files, per the brief that added this test).
    const EXCLUDED = ['panels/assetViews/widgets.tsx']; // defines writeMetaOrWarn, builds no payload of its own

    const discovered = editorSourceFiles()
      .map(({ rel }) => rel)
      .filter((rel) => hasMetaWriteCall(read(rel)));

    expect(discovered.sort()).toEqual([...WRITERS, ...EXCLUDED].sort());
  });

  it('the detector detects — merge/create/clobber, both inline and via a variable', () => {
    const bad = (src: string) => clobberingMetaPayloads(src).length === 1;

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

    // Legitimate: merges, inline and via a variable.
    expect(bad(`void writeMetaOrWarn(p, { ...(metas[p] ?? {}), postprocessor: next });`)).toBe(false);
    expect(bad(`
      const updatedMeta = { ...(meta ?? {}), type };
      writeMetaOrWarn(path, updatedMeta);
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

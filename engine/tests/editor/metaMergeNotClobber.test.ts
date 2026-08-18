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
 *  post succeeds, the UI updates, and the damage is a file nobody re-reads until much later. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '../../packages/modoki/src/editor');
const read = (rel: string) => readFileSync(path.join(SRC, rel), 'utf-8');

/** Files that write a meta sidecar and must therefore merge rather than replace. */
const WRITERS = [
  'panels/Inspector.tsx',
  'panels/assetViews/ModelBatchView.tsx',
  'panels/assetViews/TextureAssetView.tsx',
  'panels/assetViews/FontAssetView.tsx',
  'panels/assetViews/ModelAssetView.tsx',
  'panels/NineSliceEditor.tsx',
  'panels/SpriteEditor.tsx',
];

/** A meta payload literal that neither MERGES an existing sidecar nor CREATES a complete one.
 *
 *  The rule a legitimate write satisfies, one or the other:
 *   - it spreads the loaded meta first — `{ ...(meta ?? {}), version: 2, … }` — an EDIT; or
 *   - it carries an explicit `id` — `{ id: modelGuid, version: 2, generated: … }` — the model
 *     IMPORT path in ModelAssetView, which legitimately authors a fresh sidecar from scratch.
 *
 *  Anything else replaces the file with a fragment. Scans the enclosing literal on the line, which
 *  is the shape every writer here uses; a future multi-line literal would slip past, which is what
 *  the "detector detects" case below exists to make visible if these shapes ever change.
 */
function clobberingMetaLiterals(src: string): string[] {
  const bad: string[] = [];
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('*') || line.startsWith('//')) continue;      // prose, not code
    const at = line.search(/version:\s*\d/);
    if (at < 0) continue;
    // Everything before `version:` on the line, rather than a brace-matched window. Two shapes
    // defeated the brace approach: `{ ...(meta ?? {}), version: 2 }` has an INNER `{}` from the
    // `?? {}` default (searching backwards landed inside it and read the merge as a clobber), and
    // SpriteEditor opens its literal on the previous line, so there is no opener to find at all.
    // A whole-prefix check handles both, at the cost of a false negative on a line that spreads
    // something UNRELATED before the meta literal — a shape no writer here uses.
    const head = line.slice(0, at);
    if (head.includes('...')) continue;         // merges → fine
    if (/\bid:/.test(line)) continue;           // authors a complete sidecar → fine
    bad.push(line);
  }
  return bad;
}

describe('meta sidecar writers merge instead of replacing', () => {
  for (const rel of WRITERS) {
    it(`${rel} never posts a meta literal that drops the existing keys`, () => {
      expect(clobberingMetaLiterals(read(rel))).toEqual([]);
    });
  }

  it('the server really does REPLACE — the premise this rule rests on', () => {
    // If writeMetaSidecar ever starts merging, this rule becomes unnecessary and this test says
    // so, rather than the rule quietly outliving its reason.
    const sidecar = readFileSync(path.resolve(__dirname, '../../plugins/meta-sidecar.ts'), 'utf-8');
    expect(sidecar).toMatch(/writeJsonAtomic\(sidecarPath\(absPath\), committed\)/);
    expect(sidecar).not.toMatch(/readMetaSidecar\(absPath\)[\s\S]{0,200}\.\.\./); // no read-and-merge
  });

  it('the detector detects — including the variable form, which a first attempt missed', () => {
    const bad = (l: string) => clobberingMetaLiterals(l).length === 1;
    // The two shapes the real bug took...
    expect(bad('body: JSON.stringify({ path, meta: { version: 1, postprocessor: x } })')).toBe(true);
    expect(bad('void writeMetaOrWarn(p, { version: 2, postprocessor: next })')).toBe(true);
    // ...and the one a first cut of this guard let through: the literal bound to a const first.
    // That mutation passed the old matcher, which is exactly the "guard vouches for the bug" case.
    expect(bad('const updated = { version: 1, postprocessor: newPostprocessor };')).toBe(true);
    // Legitimate: merges, or authors a complete sidecar.
    expect(bad('void writeMetaOrWarn(p, { ...(metas[p] ?? {}), version: 2, postprocessor: next })')).toBe(false);
    expect(bad('const updatedMeta = { ...(meta ?? {}), version: 2, type };')).toBe(false);
    expect(bad('meta: { id: modelGuid, version: 2, generated: { meshes: [] } }')).toBe(false);
  });
});

/** Every material clone bound to a live mesh must be stamped `markDerived` (#318).
 *
 *  `sweepRetiredMaterials` frees a retired base once no MESH binds it, and it learns that a
 *  clone counts as a holder only from `userData.__derivedBase`. A `THREE.Material.clone()`
 *  copies texture REFERENCES, so a clone stamped nowhere lets the sweep free its base and
 *  `disposeMaterial` release the textures the clone is still sampling.
 *
 *  A SOURCE guard rather than a behavioural one, and this is the case it exists for: the failure
 *  is not that the existing clone sites are wrong — they are all stamped and each has its own
 *  behavioural test — it is that the SIXTH one, added months from now by someone who has never
 *  read `derivedMaterials.ts`, is silent. Nothing errors, nothing looks wrong, and WebGPU-on-Metal
 *  tolerated four frames of a destroyed material in the #317 measurement before anything showed.
 *  The #318 close-out sweep found exactly this: two clone sites (the prewarm side-pinned variants
 *  and the video-texture clone) predating the stamp and missed by the fix that introduced it.
 *
 *  It checks the LINE, so a stamp applied a few lines later (as `lightMaskVariants` does, where
 *  the `userData` assignment must come first) needs an allowlist entry stating why. */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const RUNTIME = join(__dirname, '../../packages/modoki/src/runtime');

/** A `.clone()` whose receiver reads as a material. Deliberately loose on the receiver name —
 *  `base`, `material`, `mat`, `target.material`, `m` inside a `.map()` over materials — and
 *  narrowed by the allowlist below rather than by a cleverer regex, because a regex that misses
 *  is the exact failure this guard exists to prevent. */
const CLONE = /(^|[^A-Za-z0-9_])(\w*[Mm]aterial|base|mat)\s*\.clone\(\)/;

/** Clone sites that do NOT need the stamp on the line, each with the reason. Keyed by
 *  `runtime`-relative path + the distinguishing text of the line. */
const EXEMPT: Array<{ file: string; contains: string; why: string }> = [
  {
    file: 'rendering/lightMaskVariants.ts',
    contains: 'base.clone() as LightsNodeMaterial',
    why: 'stamped a few lines down, and it must be: the `material.userData = {...}` assignment '
      + 'that writes __lightMaskBase would have to spread a stamp written first, and the two keys '
      + 'answer different questions (see the module header). Its own tests cover the stamp.',
  },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') || p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/** Strip line comments and block-comment bodies so a doc paragraph ABOUT `base.clone()` — of
 *  which this change added several — is not read as a clone site. */
function codeLines(src: string): Array<{ n: number; text: string }> {
  const out: Array<{ n: number; text: string }> = [];
  let inBlock = false;
  src.split('\n').forEach((raw, i) => {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) return;
      line = line.slice(end + 2);
      inBlock = false;
    }
    const block = line.indexOf('/*');
    if (block !== -1) { inBlock = line.indexOf('*/', block) === -1; line = line.slice(0, block); }
    const slash = line.indexOf('//');
    if (slash !== -1) line = line.slice(0, slash);
    if (line.trim()) out.push({ n: i + 1, text: line });
  });
  return out;
}

describe('material clones carry the derived-base stamp', () => {
  it('every material .clone() in runtime/ is markDerived-wrapped or allowlisted', () => {
    const unstamped: string[] = [];
    for (const file of walk(RUNTIME)) {
      const rel = relative(RUNTIME, file);
      for (const { n, text } of codeLines(readFileSync(file, 'utf8'))) {
        if (!CLONE.test(text)) continue;
        if (text.includes('markDerived')) continue;
        if (EXEMPT.some((e) => e.file === rel && text.includes(e.contains))) continue;
        unstamped.push(`${rel}:${n} — ${text.trim()}`);
      }
    }
    expect(unstamped, 'a material clone bound to a mesh must be markDerived(clone, base) — see '
      + 'runtime/rendering/derivedMaterials.ts. If this clone is never bound to a live mesh, add '
      + 'it to EXEMPT with the reason.').toEqual([]);
  });

  it('finds the known clone sites — the scan is not vacuously passing', () => {
    // The guard above is a NEGATIVE assertion, which a broken regex satisfies perfectly. This is
    // the distinguishing check: the scan must still SEE the sites it is meant to police.
    const stamped: string[] = [];
    for (const file of walk(RUNTIME)) {
      const rel = relative(RUNTIME, file);
      for (const { text } of codeLines(readFileSync(file, 'utf8'))) {
        if (CLONE.test(text) && text.includes('markDerived')) stamped.push(rel);
      }
    }
    expect(new Set(stamped)).toEqual(new Set([
      'rendering/scene3DSync.ts',            // tint clones + the prewarm side-pinned variants
      'rendering/materialInstanceClones.ts', // per-entity prop clones (single + array)
      'rendering/videoTextureSync.ts',       // the per-entity video-surface clone
    ]));
  });
});

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
import { join, relative, sep } from 'node:path';

const RUNTIME = join(__dirname, '../../packages/modoki/src/runtime');

/** A `.clone()` whose receiver reads as a material. Deliberately loose on the receiver name —
 *  `base`, `material`, `mat`, `target.material`, `m` inside a `.map()` over materials — and
 *  narrowed by the allowlist below rather than by a cleverer regex, because a regex that misses
 *  is the exact failure this guard exists to prevent. */
const CLONE = /(^|[^A-Za-z0-9_])(\w*[Mm]aterial|base|mat)\s*\.clone\(\)/;

/** `cloneDerived(material, base)` — the shared helper that clones, stamps ON its own clone line,
 *  and suppresses the `userData` round-trip (#325). A call to it IS a stamped clone site: the
 *  stamp cannot be forgotten because the caller never writes the `.clone()`. Tracked separately so
 *  the known-sites check below still names every file that mints a mesh-bound material, which is
 *  the signal that would otherwise be lost by routing sites through a helper. */
const CLONE_HELPER = /(^|[^A-Za-z0-9_])cloneDerived\s*\(/;

/** Clone sites that do NOT need the stamp on the line, each with the reason. Keyed by
 *  `runtime`-relative path + the distinguishing text of the line. */
const EXEMPT: Array<{ file: string; contains: string; why: string }> = [
  // `lightMaskVariants`' own `base.clone()` used to sit here. It is now a `cloneDerived` call
  // (#325): that site had the very `userData` round-trip this family of bugs is made of, because
  // `applyLightMask` hands it a `markDerived` clone whenever the mesh is tinted or instanced.
];

/** POSIX-normalised so the `EXEMPT` keys and the known-sites set below — both hand-authored with
 *  `/` — still match on Windows, where `relative()` returns backslashes. This guard failed exactly
 *  that way on `ci/main`; the class is documented in `docs/windows.md` § Paths. */
const toPosix = (p: string) => p.split(sep).join('/');

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

/** The one file allowed to contain a raw material `.clone()`: the helper itself. */
const HELPER_FILE = 'rendering/derivedMaterials.ts';

describe('material clones carry the derived-base stamp', () => {
  it('every material .clone() in runtime/ goes through cloneDerived or is allowlisted', () => {
    // ⚠️ The invariant TIGHTENED in #325, and `markDerived` on the line is no longer enough.
    // Stamping only ever answered "does the sweep see this holder"; it says nothing about the
    // `userData` JSON round-trip, so a site could be fully stamp-compliant and still serialise a
    // material graph — which is exactly what `videoTextureSync`, `lightMaskVariants`,
    // `tintedMaterial` and `applyPropOverride` were all doing while this guard was green. The rule
    // is now "use the helper", and the helper is the only place the raw clone may live.
    const raw: string[] = [];
    for (const file of walk(RUNTIME)) {
      const rel = toPosix(relative(RUNTIME, file));
      if (rel === HELPER_FILE) continue;
      for (const { n, text } of codeLines(readFileSync(file, 'utf8'))) {
        if (!CLONE.test(text)) continue;
        if (EXEMPT.some((e) => e.file === rel && text.includes(e.contains))) continue;
        raw.push(`${rel}:${n} — ${text.trim()}`);
      }
    }
    expect(raw, 'a material clone bound to a mesh must go through cloneDerived(material, base) — '
      + 'see runtime/rendering/derivedMaterials.ts. A bare .clone() JSON-round-trips userData, '
      + 'which serialises any Material or Texture parked in it and drops the own properties that '
      + 'make a light-mask variant distinct. If this clone is never bound to a live mesh, add it '
      + 'to EXEMPT with the reason.').toEqual([]);
  });

  it('finds the known clone sites — the scan is not vacuously passing', () => {
    // The guard above is a NEGATIVE assertion, which a broken regex satisfies perfectly. This is
    // the distinguishing check: the scan must still SEE the sites it is meant to police.
    //
    // Counted by `cloneDerived` CALLS only — deliberately not "has markDerived on the line". The
    // looser form made reverting a migrated site invisible: it kept the set identical, so the two
    // sites this guard's own rule was extended to cover could have gone back to a bare stamped
    // clone with the suite green.
    const sites: string[] = [];
    let helperStampsItsOwnClone = false;
    for (const file of walk(RUNTIME)) {
      const rel = toPosix(relative(RUNTIME, file));
      for (const { text } of codeLines(readFileSync(file, 'utf8'))) {
        if (rel === HELPER_FILE) {
          // The helper is where the ONE raw clone lives, and it must still stamp on that line.
          if (CLONE.test(text) && text.includes('markDerived')) helperStampsItsOwnClone = true;
          continue;
        }
        if (CLONE_HELPER.test(text) && !text.startsWith('import')) sites.push(rel);
      }
    }
    expect(new Set(sites)).toEqual(new Set([
      'rendering/lightMaskVariants.ts',      // per-(base, light-selection) variants
      'rendering/scene3DSync.ts',            // tint clones + the prewarm side-pinned variants
      'rendering/materialInstanceClones.ts', // per-entity prop clones (single + array)
      'rendering/videoTextureSync.ts',       // the per-entity video-surface clone
    ]));
    expect(helperStampsItsOwnClone, 'cloneDerived must still markDerived on its own clone line')
      .toBe(true);
  });
});

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
 *  ⚠️ **Clones are found in the PARSE, and the stamp must wrap THAT clone (#1179).** The per-line
 *  regex required the receiver's name to sit right before `.clone()`, so `(mesh.material as
 *  Material).clone()` escaped even on one line, and `material\n  .clone()` did too; the helper's
 *  "stamps its own clone" check was `markDerived` anywhere on the clone's LINE. */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';
import { callsTo, calleeName, findNodes, lineOf, parseSource, ts, unwrapValue, valueCarrier } from '@modoki/engine/testing/sourceAst';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const RUNTIME = join(__dirname, '../../packages/modoki/src/runtime');

/** A receiver NAME that reads as a material. Deliberately loose — `base`, `material`, `mat`,
 *  `target.material` — and narrowed by structure rather than by a cleverer pattern, because a
 *  matcher that misses is the exact failure this guard exists to prevent. The name is the receiver's
 *  LAST segment, through parens, casts and `!` — a computed receiver (`mesh[k]`, `mats[i]`) has no name
 *  and is not matched, as the regex before it did not match it either. */
const MATERIAL_RECEIVER = /^(\w*[Mm]aterial|base|mat)$/;

/** Every argument-less `.clone()` CALL on a material-named receiver, with whether that very call is
 *  the first argument of a `markDerived(…)` call. */
function materialClones(code: string, rel: string): Array<{ line: number; text: string; stamped: boolean }> {
  const sf = parseSource(code, rel);
  return findNodes(sf, (n): n is ts.CallExpression => ts.isCallExpression(n) && n.arguments.length === 0
    && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'clone')
    .flatMap((c) => {
      const recv = unwrapValue((c.expression as ts.PropertyAccessExpression).expression);
      const name = ts.isIdentifier(recv) ? recv.text : ts.isPropertyAccessExpression(recv) ? recv.name.text : undefined;
      if (name === undefined || !MATERIAL_RECEIVER.test(name)) return [];
      const carrier = valueCarrier(c); // `material.clone() as T` is still this clone
      const outer = carrier.parent;
      const stamped = ts.isCallExpression(outer) && calleeName(outer) === 'markDerived' && outer.arguments[0] === carrier;
      return [{ line: lineOf(c), text: c.getText(sf).replace(/\s+/g, ' '), stamped }];
    });
}

/** `cloneDerived(material, base)` — the shared helper that clones, stamps its own clone, and
 *  suppresses the `userData` round-trip (#325). A call to it IS a stamped clone site: the stamp
 *  cannot be forgotten because the caller never writes the `.clone()`. Tracked separately so the
 *  known-sites check below still names every file that mints a mesh-bound material, which is the
 *  signal that would otherwise be lost by routing sites through a helper. */
const cloneDerivedCalls = (code: string, rel: string): number => callsTo(parseSource(code, rel), 'cloneDerived').length;

/* ⚠️ **No EXEMPT list (#1140).** It was empty since #325 moved `lightMaskVariants`' own
 *  `base.clone()` onto `cloneDerived`, and its match was `file && line.includes(contains)` with no
 *  staleness — so its first row would have pardoned every clone line in that file carrying the
 *  text. The one legitimate raw clone is `HELPER_FILE`, excluded structurally below, and the
 *  "finds the known clone sites" test proves the CLONE detector alive on that line. */

/** Every `.ts`/`.tsx` under `RUNTIME`, RUNTIME-relative POSIX — via the shared corpus producer
 *  (#799/#771/#805 Phase 4). `repoFiles()`'s own `rel` is repo-root-relative
 *  (`engine/packages/modoki/src/runtime/...`); the prefix up to and including the one `runtime/`
 *  segment is stripped by a plain string search, not a `path.relative`/`sep` round-trip — that
 *  round-trip (this file's own former `toPosix`, instance 3 of the class docs/windows.md § Paths
 *  records) is exactly the hazard `repoCorpus.mjs` removes by returning git's own POSIX `rel`
 *  verbatim. Floored well under the 540 measured today. */
function runtimeFiles(): Array<{ abs: string; rel: string }> {
  const MARKER = '/runtime/';
  return repoFiles({ under: RUNTIME, match: /\.tsx?$/, floor: 400 })
    .map(({ abs, rel }) => {
      // ⚠️ THROW rather than tolerate a miss. `indexOf` returns -1 when the marker is absent, and
      // `slice(-1 + MARKER.length)` is a perfectly valid slice — it would hand back a truncated
      // but plausible-looking path, `HELPER_FILE` would quietly stop matching, and the guard
      // would report the helper's own raw clone as an offender — or, with the helper renamed, go
      // green comparing the wrong paths. That is a wrong answer with no error, which is the
      // precise failure this whole family exists to remove; it must not be reintroduced by the
      // change removing it. Unreachable while `under` is RUNTIME, which is why it is a throw and
      // not a fallback: if it ever fires, the assumption changed and the guard should stop.
      const i = rel.indexOf(MARKER);
      if (i === -1) {
        throw new Error(
          `materialCloneStamp: ${rel} is not under a "runtime/" segment, but \`under\` is RUNTIME `
          + '— the enumeration root and this prefix strip have drifted apart.',
        );
      }
      return { abs, rel: rel.slice(i + MARKER.length) };
    });
}

/** The one file allowed to contain a raw material `.clone()`: the helper itself. */
const HELPER_FILE = 'rendering/derivedMaterials.ts';

/** Every runtime file's comment-stripped code, read once through the shared scanner (#812). */
const SOURCES = runtimeFiles().map(({ abs, rel }) => ({ rel, code: readScannedSource(abs).code }));

describe('material clones carry the derived-base stamp', () => {
  it('every material .clone() in runtime/ goes through cloneDerived or is allowlisted', () => {
    // ⚠️ The invariant TIGHTENED in #325, and `markDerived` on the line is no longer enough.
    // Stamping only ever answered "does the sweep see this holder"; it says nothing about the
    // `userData` JSON round-trip, so a site could be fully stamp-compliant and still serialise a
    // material graph — which is exactly what `videoTextureSync`, `lightMaskVariants`,
    // `tintedMaterial` and `applyPropOverride` were all doing while this guard was green. The rule
    // is now "use the helper", and the helper is the only place the raw clone may live.
    const raw = SOURCES.filter((s) => s.rel !== HELPER_FILE)
      .flatMap((s) => materialClones(s.code, s.rel).map((c) => `${s.rel}:${c.line} — ${c.text}`));
    expect(raw, 'a material clone bound to a mesh must go through cloneDerived(material, base) — '
      + 'see runtime/rendering/derivedMaterials.ts. A bare .clone() JSON-round-trips userData, '
      + 'which serialises any Material or Texture parked in it and drops the own properties that '
      + 'make a light-mask variant distinct.').toEqual([]);
  });

  it('finds the known clone sites — the scan is not vacuously passing', () => {
    // The guard above is a NEGATIVE assertion, which a broken regex satisfies perfectly. This is
    // the distinguishing check: the scan must still SEE the sites it is meant to police.
    //
    // Counted by `cloneDerived` CALLS only — deliberately not "has markDerived on the line". The
    // looser form made reverting a migrated site invisible: it kept the set identical, so the two
    // sites this guard's own rule was extended to cover could have gone back to a bare stamped
    // clone with the suite green.
    const sites = SOURCES.filter((s) => s.rel !== HELPER_FILE && cloneDerivedCalls(s.code, s.rel) > 0).map((s) => s.rel);
    expect(new Set(sites)).toEqual(new Set([
      'rendering/lightMaskVariants.ts',      // per-(base, light-selection) variants
      'rendering/scene3DSync.ts',            // tint clones + the prewarm side-pinned variants
      'rendering/materialInstanceClones.ts', // per-entity prop clones (single + array)
      'rendering/videoTextureSync.ts',       // the per-entity video-surface clone
    ]));
    // The helper is where the ONE raw clone lives, and that clone must itself be what it stamps.
    const helper = SOURCES.find((s) => s.rel === HELPER_FILE)!;
    expect(materialClones(helper.code, helper.rel).map((c) => c.stamped), 'cloneDerived must markDerived its own clone')
      .toEqual([true]);
  });

  it('the detector sees a cast or wrapped receiver, and a stamp must wrap THIS clone (#1179)', () => {
    const src = [
      'const a = (mesh.material as Material).clone();',
      'const b = material',
      '  .clone();',
      'const c = markDerived(base.clone() as T, base); const d = mat.clone(); markDerived(d, base);',
      'const e = geometry.clone(); const f = base.clone(opts);',
    ].join('\n');
    expect(materialClones(src, 'r.ts').map((c) => `${c.line}:${c.stamped}`)).toEqual(['1:false', '2:false', '4:true', '4:false']);
  });
});

/** ParticleEditor's load-outcome decision logic, extracted so it is unit-testable without
 *  mounting the component (CLAUDE.md § Panels: editor `.tsx` carries no tests, `.ts` does).
 *  Mirrors the same extraction `atlasPersist.ts`'s `classifyAtlasLoad` does for AtlasAssetView.
 *
 *  #778's mechanism, restated for this document: `ParticleEditor`'s load effect used to build
 *  `defaultParticleEffect()` on ANY load failure — a real 404 for a brand-new asset, but also a
 *  corrupt/conflict-markered file, and (before this change) a `.particle.json` written by a
 *  newer build than this one understands — and mark that fallback as the SAVED baseline. The
 *  first edit then parked a full-replace write of the defaults over the authored file. This
 *  module decides which outcome is which; `ParticleEditor.tsx` just acts on the verdict. */

import { classifyFormatVersion } from '../../runtime/core/formatVersion';
import { isMissingAsset } from '../../runtime/loaders/assetFetch';
import { PARTICLE_FORMAT_VERSION } from '../../runtime/particles/types';

/** What to do with a successfully-fetched-and-parsed `.particle.json` body. `'load'` means the
 *  document is readable (possibly a legacy/absent version) and the caller should proceed to
 *  `normalizeParticleDef` + `loadParticleDef` as usual. `'refused'` means REFUSE per
 *  docs/format-versioning.md § 2b-bis (`.particle.json` is a machine-generated sidecar, not
 *  player data) — the caller must NOT substitute defaults, NOT mark a saved baseline, and NOT
 *  call `loadParticleDef`; it disables editing by simply doing nothing further. */
export type ParticleFetchVerdict =
  | { kind: 'load' }
  | { kind: 'refused'; message: string };

/** Classify a successfully-parsed `.particle.json` body against this build's format constant. */
export function classifyParticleFetchSuccess(json: unknown): ParticleFetchVerdict {
  const verdict = classifyFormatVersion(json, PARTICLE_FORMAT_VERSION);
  if (verdict.kind === 'too-new') {
    return {
      kind: 'refused',
      message: `format version ${verdict.version} is newer than this build's PARTICLE_FORMAT_VERSION (${PARTICLE_FORMAT_VERSION})`,
    };
  }
  if (verdict.kind === 'unreadable') {
    return { kind: 'refused', message: `version field is unreadable (${verdict.reason})` };
  }
  return { kind: 'load' };
}

/** What to do when the fetch/parse itself threw. `'missing'` is a genuinely absent file (a
 *  brand-new asset, or a stale reference) — defaults ARE the correct content, same as before
 *  this fix (see `isMissingAsset`'s own header). Anything else — corrupt/truncated/
 *  conflict-markered JSON — is `'refused'`: the caller must not substitute defaults. */
export type ParticleFetchFailure =
  | { kind: 'missing' }
  | { kind: 'refused'; message: string };

export function classifyParticleFetchFailure(e: unknown): ParticleFetchFailure {
  if (isMissingAsset(e)) return { kind: 'missing' };
  return { kind: 'refused', message: e instanceof Error ? e.message : String(e) };
}

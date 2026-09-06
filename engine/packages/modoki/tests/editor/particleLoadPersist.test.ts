/** ParticleEditor's load-outcome decision logic (`particleLoadPersist.ts`), unit-tested without
 *  mounting the component (CLAUDE.md § Panels). This is the #778-class regression guard for
 *  `.particle.json` (1d, #784): a load failure/refusal must never resolve to "substitute
 *  defaults and mark them saved" the way it did before this fix — see the module's own header
 *  for the mechanism. */

import { describe, it, expect } from 'vitest';
import { classifyParticleFetchSuccess, classifyParticleFetchFailure } from '../../src/editor/panels/particleLoadPersist';
import { MissingAssetError } from '../../src/runtime/loaders/assetFetch';
import { PARTICLE_FORMAT_VERSION } from '../../src/runtime/particles/types';

describe('classifyParticleFetchSuccess', () => {
  it('loads a document at or below this build\'s format version', () => {
    expect(classifyParticleFetchSuccess({ version: PARTICLE_FORMAT_VERSION })).toEqual({ kind: 'load' });
  });

  it('loads a versionless (legacy/absent) document', () => {
    expect(classifyParticleFetchSuccess({})).toEqual({ kind: 'load' });
  });

  it('refuses a too-new document — this is the ONLY path that must not fall through to "load"', () => {
    const v = classifyParticleFetchSuccess({ version: PARTICLE_FORMAT_VERSION + 1 });
    expect(v.kind).toBe('refused');
    expect((v as { message: string }).message).toContain(String(PARTICLE_FORMAT_VERSION + 1));
  });

  it('refuses an unreadable (non-numeric) version field', () => {
    const v = classifyParticleFetchSuccess({ version: 'two' });
    expect(v.kind).toBe('refused');
  });

  it('refuses a non-object body', () => {
    expect(classifyParticleFetchSuccess(null).kind).toBe('refused');
    expect(classifyParticleFetchSuccess([1, 2, 3]).kind).toBe('refused');
  });
});

describe('classifyParticleFetchFailure', () => {
  it('treats a MissingAssetError as "missing" — defaults are the correct content', () => {
    expect(classifyParticleFetchFailure(new MissingAssetError('404 for fx/new.particle.json'))).toEqual({ kind: 'missing' });
  });

  it('treats a real parse failure as "refused" — must NOT be treated as missing', () => {
    // The #778 mechanism: a plain Error (corrupt/conflict-markered JSON) is not a 404. Getting
    // this backwards — routing it through the "missing" branch — is exactly the regression this
    // guards: ParticleEditor would substitute defaultParticleEffect() and mark it saved.
    const v = classifyParticleFetchFailure(new Error('fx/broken.particle.json is not valid JSON: Unexpected token <'));
    expect(v.kind).toBe('refused');
    expect((v as { message: string }).message).toContain('not valid JSON');
  });
});

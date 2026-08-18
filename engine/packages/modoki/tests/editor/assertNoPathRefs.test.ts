/**
 * Unit tests for serialize.assertNoPathRefs — the GUID-only guard must flag a stray
 * internal asset PATH (vs a GUID) in EVERY ref location, including the ones the old
 * guard was blind to: per-localId `overrides`, recursive `added` subtrees, and
 * path-keyed `nestedOverrides` (serialize F8).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { assertNoPathRefs } from '../../src/editor/scene/serialize';
import type { SerializedEntity } from '../../src/editor/scene/serialize';

const STRAY = '/models/stray.mesh.json'; // internal asset path (should be a GUID)

let err: ReturnType<typeof vi.spyOn>;
beforeEach(() => { err = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { err.mockRestore(); });

const flaggedContexts = () => err.mock.calls.map((c: unknown[]) => String(c[0]));
const flaggedWith = (needle: string) => flaggedContexts().some((m: string) => m.includes(needle));

function base(): SerializedEntity {
  return { id: 1, name: 'e', traits: {} };
}

describe('assertNoPathRefs — font ASSET fields (Text2D/Text3D.font)', () => {
  const FONT = '/assets/fonts/Inter.ttf';

  it('flags a literal font path on Text2D.font', () => {
    assertNoPathRefs({ ...base(), traits: { Text2D: { font: FONT } } });
    expect(flaggedWith('Text2D.font')).toBe(true);
  });

  it('flags it on Text3D.font too', () => {
    assertNoPathRefs({ ...base(), traits: { Text3D: { font: FONT } } });
    expect(flaggedWith('Text3D.font')).toBe(true);
  });

  it('flags it inside a prefab override, not just at the top level', () => {
    assertNoPathRefs({ ...base(), overrides: { 5: { Text2D: { font: FONT } } } });
    expect(flaggedWith('Text2D.font')).toBe(true);
  });

  it('leaves UIElement.fontFamily alone — a CSS family name, not a manifest asset', () => {
    assertNoPathRefs({ ...base(), traits: { UIElement: { fontFamily: FONT } } });
    expect(err).not.toHaveBeenCalled();
  });

  it('passes a GUID font ref', () => {
    assertNoPathRefs({ ...base(), traits: { Text2D: { font: '2aeb118a-5f36-41cc-8bb4-edc2ce19e042' } } });
    expect(err).not.toHaveBeenCalled();
  });
});

describe('assertNoPathRefs — full-coverage ref walk (F8)', () => {
  it('still flags a path ref in a top-level trait', () => {
    assertNoPathRefs({ ...base(), traits: { Renderable3D: { mesh: STRAY } } });
    expect(flaggedWith('Renderable3D.mesh')).toBe(true);
  });

  it('flags a path ref buried in per-localId overrides', () => {
    assertNoPathRefs({ ...base(), overrides: { 5: { Renderable3D: { material: STRAY } } } });
    expect(flaggedWith('Renderable3D.material')).toBe(true);
  });

  it('flags a path ref inside an added subtree (recursively)', () => {
    const entry: SerializedEntity = {
      ...base(),
      added: [{
        parentLocalId: 1, guid: 'g', name: 'a', traits: {},
        children: [{
          parentLocalId: 1, guid: 'g2', name: 'child', children: [],
          traits: { ModelSource: { glbPath: STRAY } },
        }],
      }],
    };
    assertNoPathRefs(entry);
    expect(flaggedWith('ModelSource.glbPath')).toBe(true);
  });

  it('flags a path ref in an added nested-instance reference node\'s overrides', () => {
    const entry: SerializedEntity = {
      ...base(),
      added: [{
        parentLocalId: 1, guid: 'g', name: 'ref', traits: {}, children: [],
        prefab: 'guid-child-prefab',
        overrides: { 3: { ParticleEmitter: { effect: STRAY } } },
      }],
    };
    assertNoPathRefs(entry);
    expect(flaggedWith('ParticleEmitter.effect')).toBe(true);
  });

  it('flags a path ref in path-keyed nestedOverrides', () => {
    assertNoPathRefs({ ...base(), nestedOverrides: { '2.5': { 4: { Environment: { hdrPath: STRAY } } } } });
    expect(flaggedWith('Environment.hdrPath')).toBe(true);
  });

  it('stays silent when every ref is a GUID', () => {
    assertNoPathRefs({
      ...base(),
      traits: { Renderable3D: { mesh: 'a0000000-0000-4000-8000-000000000001' } },
      overrides: { 5: { Renderable3D: { material: 'b0000000-0000-4000-8000-000000000002' } } },
      nestedOverrides: { '1': { 2: { Environment: { hdrPath: 'c0000000-0000-4000-8000-000000000003' } } } },
    });
    expect(err).not.toHaveBeenCalled();
  });
});

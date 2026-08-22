/** A timeline's audio cue must reach `acquireAudio` as the GUID it was authored with.
 *
 *  QA-GAME-0001 (games/timeline-demo). `collectSceneResourceRefs` pre-resolved the cue GUID to a
 *  PATH before adding it as a scene resource, so the ref was resolved TWICE — `acquireAudio` →
 *  `refToPath` → `resolveRef(<internal path>)`, which correctly refuses an internal path. The
 *  acquire bailed, the clip was never preloaded, the cue never played, and every boot logged
 *  `[assetManifest] path reference no longer supported`. Every authored `type:'audio'` resource
 *  in games/ + demos/ is a GUID, and prefab/video cues already pass the GUID straight through —
 *  audio was the odd one out.
 *
 *  Driven through a real `loadScene` on purpose: the defect lives in the SEAM between two modules
 *  that are each individually correct, so neither module's own tests could see it. In its own file
 *  rather than in `SceneManager.test.ts` because koota caps a module graph at 16 worlds and that
 *  file is already near the ceiling. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { trait } from 'koota';
import { completeResponse } from '../stubs/assetResponse';

const Transform = trait({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
const EntityAttributes = trait({ name: '', isActive: true, sortOrder: 0, parentId: 0, layer: '' as '' | '3d' | '2d' | 'ui', guid: '' });

vi.mock('../../src/runtime/core/ecs/traitRegistry', () => {
  const traits = [
    { name: 'Transform', trait: Transform, category: 'component', fields: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, rx: { type: 'number' }, ry: { type: 'number' }, rz: { type: 'number' }, sx: { type: 'number' }, sy: { type: 'number' }, sz: { type: 'number' } } },
    { name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: { type: 'string' }, isActive: { type: 'boolean' }, sortOrder: { type: 'number' }, parentId: { type: 'number', entityId: { onMissing: 'root' } }, layer: { type: 'string' }, guid: { type: 'string' } } },
    { name: 'Persistent', trait: null as never, category: 'tag', fields: {} },
  ];
  return { getAllTraits: () => traits, getTraitByName: (name: string) => traits.find(t => t.name === name) };
});

const TL_GUID = '30000000-0000-4000-8000-00000000000a';
const TL_PATH = '/timelines/cutscene.timeline.json';
const SFX_GUID = '40000000-0000-4000-8000-00000000000b';
const SFX_PATH = '/audio/sfx-confirm.mp3';

let fetchCalls: string[] = [];
const fetchResponses: Record<string, unknown> = {};

// @ts-expect-error mocking global
global.fetch = vi.fn(async (url: string) => {
  fetchCalls.push(url);
  for (const [key, body] of Object.entries(fetchResponses)) {
    if (url.endsWith(key) || url === key) return completeResponse({ ok: true, json: async () => body });
  }
  return completeResponse({ ok: false, status: 404, json: async () => ({}) });
});

beforeEach(async () => {
  vi.resetModules();
  fetchCalls = [];
  for (const k of Object.keys(fetchResponses)) delete fetchResponses[k];

  const { Persistent } = await import('../../src/runtime/traits/Persistent');
  const { getAllTraits } = await import('../../src/runtime/core/ecs/traitRegistry');
  const meta = getAllTraits().find((m: { name: string }) => m.name === 'Persistent');
  if (meta) (meta as { trait: unknown }).trait = Persistent;

  const manifest = await import('../../src/runtime/loaders/assetManifest');
  manifest.clearManifest();
  manifest.registerAsset(TL_GUID, TL_PATH, 'timeline');
  manifest.registerAsset(SFX_GUID, SFX_PATH, 'audio');

  fetchResponses[TL_PATH] = {
    id: TL_GUID, duration: 4,
    tracks: [{ id: 'track-audio', type: 'audio', cues: [{ t: 1, clip: SFX_GUID }] }],
  };
  fetchResponses['/sceneT.json'] = {
    version: 6,
    resources: [{ type: 'timeline', path: TL_GUID }],
    entities: [{ id: 300, traits: { Transform: { x: 0 }, EntityAttributes: { name: 'T1', parentId: 0 } } }],
  };
});

async function loadSceneT() {
  const mod = await import('../../src/runtime/scene/SceneManager');
  mod.sceneManager.resetForTesting();
  await mod.sceneManager.loadScene('/sceneT.json');
}

describe('SceneManager — timeline audio cues acquire by GUID', () => {
  it('never feeds a resolved path back through resolveRef', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await loadSceneT();
      const offenders = err.mock.calls.map((c) => String(c[0]))
        .filter((m) => m.includes('path reference no longer supported'));
      expect(offenders).toEqual([]);
    } finally { err.mockRestore(); }
  });

  it('registers a scene-scoped owner for the clip (the acquire genuinely ran)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await loadSceneT();
      const { getAudioCacheStats } = await import('../../src/runtime/loaders/audioBufferCache');
      // Ownership is recorded BEFORE the decode (which is a headless no-op here), so it is the
      // honest evidence that the acquire got past `refToPath`. Pre-fix that lookup returned
      // undefined and the function bailed with no owner at all.
      expect(Object.keys(getAudioCacheStats().owners)).toContain(SFX_PATH);
    } finally { err.mockRestore(); }
  });
});

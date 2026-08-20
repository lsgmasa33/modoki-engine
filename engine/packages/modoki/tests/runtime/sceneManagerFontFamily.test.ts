/** #253 — a scene's `{type:'font', path:'<CSS family name>'}` resource, collected from
 *  `UIElement.fontFamily`, must be REGISTERED WITH THE BROWSER by the SCENE-LOAD path.
 *
 *  It used to be a no-op in `acquireResource`, on the reasoning that the global
 *  `loadAllFonts` had already registered every font. That call has exactly two sites — the
 *  game runtime's `initWorldSync` (app/ecs/init.ts) and the editor's ASSETS PANEL. The editor
 *  mounts EditorApp rather than GameShell, so inside the editor the only registrar was a
 *  panel: with the Assets tab unmounted, `document.fonts.size` was 0 and every DOM string in
 *  the Game panel rendered in the browser's default serif. Nothing errored, which is what made
 *  it expensive — a serif page still looks like a page, so a capture judged against reference
 *  art can be wrong about weight/tracking/wrap (and therefore panel fit) with nothing to
 *  indicate it.
 *
 *  Asserted END-TO-END (a real `loadScene` → a real face added to `document.fonts`) rather
 *  than by spying on `loadFontFamily`: what broke was the WIRING, and a spy on the callee
 *  would have passed against the no-op just as happily.
 *
 *  Own file because koota caps live worlds at 16 and SceneManager.test.ts is already tuned to
 *  that budget (same reasoning as sceneManagerLifecycle.test.ts). */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { trait } from 'koota';

const Transform = trait({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
const EntityAttributes = trait({ name: '', isActive: true, sortOrder: 0, parentId: 0, layer: '' as '' | '3d' | '2d' | 'ui', guid: '' });

vi.mock('../../src/runtime/core/ecs/traitRegistry', () => {
  const traits = [
    { name: 'Transform', trait: Transform, category: 'component', fields: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, rx: { type: 'number' }, ry: { type: 'number' }, rz: { type: 'number' }, sx: { type: 'number' }, sy: { type: 'number' }, sz: { type: 'number' } } },
    { name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: { type: 'string' }, isActive: { type: 'boolean' }, sortOrder: { type: 'number' }, parentId: { type: 'number', entityId: { onMissing: 'root' } }, layer: { type: 'string' }, guid: { type: 'string' } } },
    { name: 'Persistent', trait: null as unknown, category: 'tag', fields: {} }, // patched in beforeEach
  ];
  return {
    getAllTraits: () => traits,
    getTraitByName: (name: string) => traits.find((t) => t.name === name),
  };
});

const FONT_GUID = '30000000-0000-4000-8000-000000000001';
const FONT_PATH = '/assets/fonts/VarelaRound-Regular.ttf';

/** A scene whose only resource is the font ref under test. */
const sceneWithFont = (fontRef: string) => ({
  version: 8,
  resources: [{ type: 'font', path: fontRef }],
  entities: [{ id: 1, traits: { Transform: { x: 0 }, EntityAttributes: { name: 'UIRoot', parentId: 0 } } }],
});

/** Stand in for the browser's FontFace API, recording every face that reaches
 *  `document.fonts.add` — the observable end of "this typeface is now available". */
function installFontFaceMock() {
  const added: { family: string; source: string }[] = [];
  class FakeFontFace {
    constructor(public family: string, public source: string, public descriptors: unknown) {}
    load() { return Promise.resolve(this); }
  }
  (globalThis as Record<string, unknown>).FontFace = FakeFontFace;
  (globalThis as Record<string, unknown>).document = { fonts: { add: (f: { family: string; source: string }) => { added.push(f); } } };
  return added;
}

beforeEach(async () => {
  vi.resetModules();
  const { Persistent } = await import('../../src/runtime/traits/Persistent');
  const { getAllTraits } = await import('../../src/runtime/core/ecs/traitRegistry');
  const meta = getAllTraits().find((m: { name: string }) => m.name === 'Persistent');
  if (meta) (meta as { trait: unknown }).trait = Persistent;
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).FontFace;
  delete (globalThis as Record<string, unknown>).document;
});

async function setup() {
  const manifest = await import('../../src/runtime/loaders/assetManifest');
  manifest.clearManifest();
  manifest.registerAsset(FONT_GUID, FONT_PATH, 'font');
  const scene = await import('../../src/runtime/scene/SceneManager');
  scene.sceneManager.resetForTesting();
  return scene.sceneManager;
}

describe('SceneManager — a scene font family is registered by the scene, not by a panel (#253)', () => {
  it('registers the family-name font resource with the browser on scene load', async () => {
    const added = installFontFaceMock();
    const sceneManager = await setup();

    await sceneManager.loadScene('/font.json', { preloaded: sceneWithFont('Varela Round') as never });

    expect(added.map(f => f.family)).toEqual(['Varela Round']);
    expect(added[0].source).toContain('VarelaRound-Regular.ttf');
  });

  /** AWAITED as one of the scene's resources, so the first frame of the new scene already has
   *  the face — no flash of the fallback typeface. */
  it('has the face registered by the time loadScene resolves', async () => {
    const added = installFontFaceMock();
    const sceneManager = await setup();

    const p = sceneManager.loadScene('/font.json', { preloaded: sceneWithFont('Varela Round') as never });
    expect(added, 'not synchronously').toEqual([]);
    await p;
    expect(added.length, 'but by the time the load resolves').toBe(1);
  });

  /** A GUID font resource is an SDF font (Text2D/Text3D.font) and takes the atlas path. It must
   *  NOT also go through the browser FontFace loader, which would fetch the raw `.ttf` that a
   *  text MESH never reads. */
  it('does not FontFace-register a GUID font resource — that is the SDF atlas path', async () => {
    const added = installFontFaceMock();
    const sceneManager = await setup();

    await sceneManager.loadScene('/font.json', { preloaded: sceneWithFont(FONT_GUID) as never });

    expect(added).toEqual([]);
  });

  /** A family naming no asset must not fail the scene load — it warns and the scene loads. */
  it('loads the scene anyway when the family matches no asset, warning once', async () => {
    installFontFaceMock();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sceneManager = await setup();

    await sceneManager.loadScene('/font.json', { preloaded: sceneWithFont('No Such Face') as never });

    expect(sceneManager.getCurrent()?.state).toBe('active');
    expect(warn.mock.calls.map(c => String(c[0])).some(m => m.includes('No Such Face'))).toBe(true);
    warn.mockRestore();
  });
});

/** `list-creatable-assets` / `create-registered-asset` (#288 gap 5) — the Assets panel's "New X"
 *  surface, made reachable from the agent side.
 *
 *  The panel's own flow opens the location picker FIRST, and on darwin that picker is a BLOCKING
 *  `osascript "choose file name"` panel — i.e. every clone in this repo. So the whole registry was
 *  agent-unreachable, and two QA cases worked around it by editing an existing fixture instead.
 *
 *  ⚠️ **The `scene` refusal is the most load-bearing assertion in this file, and it is not
 *  hypothetical.** That kind's `create` override is
 *  `newScene(); selectEntity(null); setCurrentScenePath(path); await saveScene()` — it DISCARDS the
 *  live world. Its own source comment reads *"Dialog first so a cancel leaves the current world
 *  untouched"*: the dialog WAS the guard, and the explicit-`path` route these ops exist to provide
 *  is precisely what removes it. Without the refusal, one `{kind:'scene'}` call throws away a
 *  human's unsaved scene and reports success.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { runAgentOp } from '../../app/debug/agentBridge';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { registerCreatableAsset, unregisterCreatableAsset } from '../../packages/modoki/src/editor/panels/creatableAssets';
import { registerBuiltinCreatableAssets } from '../../packages/modoki/src/editor/panels/builtinCreatableAssets';

registerAllTraits();
registerEditorAgentOps();
registerBuiltinCreatableAssets();

type ListReply = { ok?: boolean; totalCount?: number; kinds?: Array<{ kind: string; ext: string; agentCreatable: boolean; refusedBecause?: string }> };
type CreateReply = { ok?: boolean; code?: string; error?: string; options?: string[]; path?: string; name?: string; guid?: string; saved?: boolean };

const list = () => runAgentOp('list-creatable-assets', {}) as Promise<ListReply>;
const create = (params: unknown) => runAgentOp('create-registered-asset', params) as Promise<CreateReply>;

/** Captures what the create path tried to WRITE, without touching a real backend. */
let writes: Array<{ path: string; body: string }> = [];
let rescans = 0;
beforeEach(() => {
  writes = [];
  rescans = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
    if (String(url).endsWith('/api/write-file')) {
      const b = JSON.parse(init?.body ?? '{}') as { path: string; content: string };
      writes.push({ path: b.path, body: b.content });
      return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
    }
    if (String(url).endsWith('/api/rescan-assets')) {
      rescans++;
      return { ok: true, json: async () => ({ assets: [] }) } as unknown as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('a create-OVERRIDE kind is REFUSED, and never runs', () => {
  it("kind:'scene' refuses and points at modoki_new_scene", async () => {
    const r = await create({ kind: 'scene', path: '/assets/scenes/probe.json' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('REFUSED_BY_OP');
    expect(String(r.error)).toMatch(/DISCARD the live world/);
    // A refusal that does not name the right tool just moves the dead end.
    expect(r.options?.join(' ')).toMatch(/modoki_new_scene/);
    // And it must not have written anything on the way to refusing.
    expect(writes).toEqual([]);
  });

  it('the refusal keys off `create` EXISTING, not off the id "scene"', async () => {
    // The registry is game-extensible, so the next override will not be called "scene". Keying on
    // the id would leave every future one unguarded — which is the whole failure mode, since the
    // damage a create-override does is arbitrary editor code, not specifically a world swap.
    registerCreatableAsset({
      id: 'test.override', label: 'X', ext: '.x.json', defaultName: 'X', assetType: 'material',
      create: async () => { throw new Error('the override must never run from here'); },
    });
    try {
      const r = await create({ kind: 'test.override', path: '/assets/x/probe.x.json' });
      expect(r.ok).toBe(false);
      expect(r.code).toBe('REFUSED_BY_OP');
      expect(writes).toEqual([]);
    } finally { unregisterCreatableAsset('test.override'); }
  });

  it('the LIST flags override kinds up front, so a batch can be planned', async () => {
    const r = await list();
    expect(r.ok).toBe(true);
    const scene = r.kinds?.find((k) => k.kind === 'scene');
    expect(scene?.agentCreatable).toBe(false);
    expect(String(scene?.refusedBecause)).toMatch(/DISCARDS the live world/);
    // …while an ordinary document kind is creatable.
    expect(r.kinds?.find((k) => k.kind === 'material')?.agentCreatable).toBe(true);
  });
});

describe('creating an ordinary document kind', () => {
  it('writes the body, appends the extension, and reports a fresh guid', async () => {
    const r = await create({ kind: 'material', path: '/assets/materials/probe' });
    expect(r.ok).toBe(true);
    expect(r.saved).toBe(true);
    // The extension is appended when the caller leaves it off. The panel gets this free from the
    // save dialog's `ext`; without it here, `assetType:'material'` would be registered against a
    // file the manifest classifies as something else entirely.
    expect(r.path).toBe('/assets/materials/probe.mat.json');
    expect(r.name).toBe('probe');
    expect(r.guid).toMatch(/^[0-9a-f-]{36}$/);
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe('/assets/materials/probe.mat.json');
    // The guid the reply reports must be the one INSIDE the document, or the two identities drift.
    expect((JSON.parse(writes[0].body) as { id: string }).id).toBe(r.guid);
  });

  it('rebuilds the BACKEND manifest before replying, and says whether it worked', async () => {
    // Registering the guid is a RENDERER act; modoki_list_assets — the read this tool names as its
    // verification — reads the BACKEND's scanned map. Two different maps, and /api/write-file
    // deliberately suppresses the watcher for the editor's own saves, so nothing rebuilds the
    // backend one on its own. Measured live: a list_assets straight after a create came back
    // count:0 with the file already on disk. Same defect /api/delete-asset had, from the far side.
    const r = await create({ kind: 'material', path: '/assets/materials/probe2' });
    expect(r.ok).toBe(true);
    expect(rescans).toBe(1);
    expect((r as { manifestRebuilt?: boolean }).manifestRebuilt).toBe(true);
  });

  it('a rescan that FAILS is not a failed create — it reports manifestRebuilt:false', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (
      String(url).endsWith('/api/write-file')
        ? ({ ok: true, json: async () => ({ ok: true }) } as unknown as Response)
        : ({ ok: false, status: 500, json: async () => ({}) } as unknown as Response)
    )));
    const r = await create({ kind: 'material', path: '/assets/materials/probe3' });
    // The file IS written. Failing the call here would read as "nothing was created" and invite a
    // retry that then collides with the file the first attempt made.
    expect(r.ok).toBe(true);
    expect((r as { manifestRebuilt?: boolean }).manifestRebuilt).toBe(false);
  });

  it('an extension already present is not doubled', async () => {
    const r = await create({ kind: 'material', path: '/assets/materials/probe.mat.json' });
    expect(r.path).toBe('/assets/materials/probe.mat.json');
  });

  it("registers the guid the DOCUMENT carries, stamping one in when def.body omits it", async () => {
    // A `def.body` supplied by a GAME need not put the guid in the document. Written with no `id`,
    // the backend's own heal-scan mints a DIFFERENT random one into the file — so the guid this
    // function handed back would name nothing, and a ref written with it resolves to undefined
    // through the backend manifest. That is the "asset ref the build cannot see" class arriving
    // through a door the def-author never looks at.
    registerCreatableAsset({
      id: 'test.noid', label: 'X', ext: '.x.json', defaultName: 'X', assetType: 'material',
      body: () => ({ shader: 'lit' }) as never,   // deliberately NO id
    });
    try {
      const r = await create({ kind: 'test.noid', path: '/assets/x/noid' });
      expect(r.ok).toBe(true);
      const written = JSON.parse(writes[0].body) as { id?: string };
      expect(written.id, 'the document must carry an id').toBeTruthy();
      expect(written.id, 'and it must be the one reported back').toBe(r.guid);
    } finally { unregisterCreatableAsset('test.noid'); }
  });

  it("a def that mints its OWN id wins — the document is the truth", async () => {
    // Registering our unused guid against a document carrying a different one recreates the same
    // mismatch from the other side.
    registerCreatableAsset({
      id: 'test.ownid', label: 'X', ext: '.y.json', defaultName: 'X', assetType: 'material',
      body: () => ({ id: 'def-chosen-id' }) as never,
    });
    try {
      const r = await create({ kind: 'test.ownid', path: '/assets/y/own' });
      expect(r.guid).toBe('def-chosen-id');
      expect((JSON.parse(writes[0].body) as { id: string }).id).toBe('def-chosen-id');
    } finally { unregisterCreatableAsset('test.ownid'); }
  });

  it('a FAILED write does not register the guid', async () => {
    // Registering it anyway would leave the manifest resolving a GUID to a file that is not there
    // — dangling, and resolvable, which is worse than absent.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) } as unknown as Response)));
    const r = await create({ kind: 'material', path: '/assets/materials/nope.mat.json' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('REFUSED_BY_OP');
    expect(String(r.error)).toMatch(/failed to write/);
    expect(r.guid).toBeUndefined();
  });
});

describe('discovery and refusals hand back the LIVE options', () => {
  it('an unknown kind is NOT_FOUND with every registered id', async () => {
    const r = await create({ kind: 'materal', path: '/assets/materials/x' });  // typo
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NOT_FOUND');
    expect(r.options).toContain('material');
  });

  it('a missing kind or path is refused before anything is written', async () => {
    expect((await create({ path: '/a/b' })).ok).toBe(false);
    const noPath = await create({ kind: 'material' });
    expect(noPath.ok).toBe(false);
    // The reason the path is required at all belongs in the message: it is a deliberate design
    // choice (route around a blocking native dialog), not an oversight.
    expect(String(noPath.error)).toMatch(/osascript|save dialog/i);
    expect(writes).toEqual([]);
  });

  it('the list reports the registry LIVE, including a game-registered kind', async () => {
    // The registry comes and goes with the open project, which is why discovery is a tool and not
    // a line in the catalog.
    registerCreatableAsset({
      id: 'testgame.level', label: 'Create Level', ext: '.level.json', defaultName: 'Level',
      assetType: 'scene', body: (guid) => ({ id: guid }),
    });
    try {
      const r = await list();
      const row = r.kinds?.find((k) => k.kind === 'testgame.level');
      expect(row?.agentCreatable).toBe(true);
      expect(row?.ext).toBe('.level.json');
    } finally { unregisterCreatableAsset('testgame.level'); }
  });
});

/** One word per concept on the MCP surface (#1560, owner-approved breaking — no alias).
 *
 *  Each renamed param: the OLD name is refused by name (§1's strict schema is what makes a hard
 *  rename safe), and the NEW name reaches the op under its unchanged wire name — the MCP layer maps,
 *  so a mapping typo would send `undefined` and this is what catches it. Plus the two aliases kept
 *  because they are another tool's vocabulary (`modoki_scroll` dx/dy, `delete_asset` path), and
 *  `create_entity`'s new `name`, on both ops. */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { loadSurface, type Surface } from './mcpSurface';
import { loadDeviceSurface, type DeviceSurface } from './deviceSurface';
import { createTestWorld, type TestWorld, EntityAttributes, setPlayState, getCurrentWorld } from '@modoki/engine/runtime';
import { clearHistory, markSceneSaved } from '@modoki/engine/editor';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';
import { createEntityLive } from '../../app/debug/liveLifecycle';

registerAllTraits();

let surface: Surface | undefined;
let device: DeviceSurface | undefined;
afterEach(() => { surface?.restore(); surface = undefined; device?.restore(); device = undefined; });

const CLIP = '/assets/anim/probe.anim.json';
const TL = '/assets/timelines/probe.timeline.json';

describe('each renamed param: the new name reaches the op wire; the old name is refused by name', () => {
  it.each([
    ['modoki_anim_set_clip', { path: CLIP, clip: {} }, { clipPath: CLIP, clip: {} }, { clipPath: CLIP, clip: {} }, 'clipPath'],
    ['modoki_anim_add_key', { path: CLIP, trait: 'Transform', field: 'x', t: 0.5, value: 1, target: 'Arm' },
      { clipPath: CLIP, trait: 'Transform', field: 'x', time: 0.5, value: 1, path: 'Arm' },
      { clipPath: CLIP, trait: 'Transform', field: 'x', t: 0.5, value: 1 }, 'clipPath'],
    ['modoki_timeline_set', { path: TL, timeline: {} }, { timelinePath: TL, timeline: {} }, { timelinePath: TL, timeline: {} }, 'timelinePath'],
    ['modoki_timeline_add_clip', { path: TL, trackType: 'signal', item: {} }, { timelinePath: TL, trackType: 'signal', item: {} },
      { timelinePath: TL, trackType: 'signal', item: {} }, 'timelinePath'],
    ['modoki_create_registered_asset', { type: 'material', path: '/assets/m.mat.json' }, { kind: 'material', path: '/assets/m.mat.json' },
      { kind: 'material', path: '/assets/m.mat.json' }, 'kind'],
    ['modoki_set_selection', { id: 7, ids: [7, 8] }, { entityId: 7, entityIds: [7, 8] }, { entityIds: [7] }, 'entityIds'],
  ] as const)('%s', async (tool, args, wire, oldArgs, oldKey) => {
    const s = (surface = loadSurface());
    await s.call(tool, args as Record<string, unknown>);
    expect(s.last()!.body).toMatchObject(wire);
    await expect(s.call(tool, oldArgs as Record<string, unknown>)).rejects.toThrow(new RegExp(`unrecognized parameter: '${oldKey}'`));
  });

  it('anim_add_key: `time` and a name-path `path` are refused too — each old spelling, not just the first', async () => {
    const s = (surface = loadSurface());
    await expect(s.call('modoki_anim_add_key', { path: CLIP, trait: 'T', field: 'x', time: 0, value: 1 }))
      .rejects.toThrow(/unrecognized parameter: 'time'/);
    // Omitting `target` sends no name-path at all, rather than `path: undefined` over the clip.
    await s.call('modoki_anim_add_key', { path: CLIP, trait: 'T', field: 'x', t: 0, value: 1 });
    expect(s.last()!.body).toMatchObject({ clipPath: CLIP });
    expect(s.last()!.body).not.toHaveProperty('path');
  });
});

describe('modoki_scroll takes device_scroll\'s dx/dy', () => {
  it('dx/dy are sent as deltaX/deltaY', async () => {
    const s = (surface = loadSurface());
    await s.call('modoki_scroll', { x: 10, y: 10, dy: 120 });
    expect(s.last()!.body).toMatchObject({ deltaY: 120 });
  });

  it('a delta under both names is AMBIGUOUS and sends nothing', async () => {
    const s = (surface = loadSurface());
    const before = s.requests.length;
    const r = await s.call('modoki_scroll', { x: 10, y: 10, deltaY: 0, dy: 120 });
    expect(r.isError).toBe(true);
    expect(s.text(r)).toMatch(/AMBIGUOUS/);
    expect(s.requests.slice(before).filter((q) => q.path === '/api/input/scroll')).toEqual([]);
  });
});

describe('modoki_delete_asset takes one `path` or a `paths` list — exactly one', () => {
  it('`path` is sent as a one-element `paths`', async () => {
    const s = (surface = loadSurface());
    await s.call('modoki_delete_asset', { path: '/assets/a.png' });
    expect(s.last()).toMatchObject({ path: '/api/delete-asset', body: { paths: ['/assets/a.png'] } });
  });

  it.each([
    ['both', { path: '/assets/a.png', paths: ['/assets/b.png'] }, /AMBIGUOUS/],
    ['neither', {}, /REFUSED_BY_OP/],
  ] as const)('%s is refused and deletes nothing', async (_label, args, code) => {
    const s = (surface = loadSurface());
    const r = await s.call('modoki_delete_asset', args as Record<string, unknown>);
    expect(r.isError).toBe(true);
    expect(s.text(r)).toMatch(code);
    expect(s.requests.filter((q) => q.path === '/api/delete-asset')).toEqual([]);
  });
});

describe('device_drag has no flat aliases left in its schema', () => {
  it('only the nested endpoints', async () => {
    const d = (device = await loadDeviceSurface());
    expect(Object.keys(d.shapeFor('device_drag'))).not.toEqual(expect.arrayContaining(['fromSelector']));
    for (const k of ['fromSelector', 'fromX', 'fromY', 'toSelector', 'toX', 'toY']) expect(d.shapeFor('device_drag')).not.toHaveProperty(k);
  });
});

describe('create_entity names the entity at creation — both ops', () => {
  let game: TestWorld;
  beforeEach(() => { game = createTestWorld({}); setPlayState('stopped'); clearHistory(); markSceneSaved(); });
  afterEach(() => game.dispose());

  const nameOf = (id: number) => {
    const e = getCurrentWorld().query(EntityAttributes).find((x) => x.id() === id);
    return (e?.get(EntityAttributes) as { name?: string } | undefined)?.name;
  };

  it('the device op (liveLifecycle) — name set, and the reply reports it', () => {
    const r = createEntityLive({ spec: { kind: 'primitive', mesh: 'cube' }, name: 'Crate' }) as { ok: boolean; id: number; name: string };
    expect(r).toMatchObject({ ok: true, name: 'Crate' });
    expect(nameOf(r.id)).toBe('Crate');
  });

  it('the device op refuses an empty name and creates nothing', () => {
    const before = getCurrentWorld().query(EntityAttributes).length;
    const r = createEntityLive({ spec: { kind: 'empty' }, name: '  ' }) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(getCurrentWorld().query(EntityAttributes).length).toBe(before);
  });

  it('the editor op — name set; omitted keeps the kind default', async () => {
    registerEditorAgentOps();
    const named = await runAgentOp('create-entity', { spec: { kind: 'primitive', mesh: 'cube' }, name: 'Crate' }) as { id: number; name: string };
    expect(named.name).toBe('Crate');
    expect(nameOf(named.id)).toBe('Crate');
    const plain = await runAgentOp('create-entity', { spec: { kind: 'empty' } }) as { id: number; name: string };
    expect(plain.name).toBe('New Entity');
  });

  it('the MCP tools pass `name` through', async () => {
    const s = (surface = loadSurface());
    await s.call('modoki_create_entity', { kind: 'empty', name: 'Crate' });
    expect(s.last()!.body).toMatchObject({ name: 'Crate', spec: { kind: 'empty' } });
    const d = (device = await loadDeviceSurface());
    await d.call('device_create_entity', { spec: { kind: 'empty' }, name: 'Crate' });
    expect(d.real().find((q) => q.path === '/api/device/request')?.body).toMatchObject({ method: 'create-entity', params: { name: 'Crate' } });
  });
});

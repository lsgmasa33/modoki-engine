/** #1216 C-13 / C-14, #1223 P4 — `device_handles` and `device_invalidate_assets` against their editor
 *  twins and the op they front.
 *
 *  Drives the REAL tool handlers against stubbed backends, so what is asserted is what reaches the
 *  device and what the agent reads back. */

import { describe, it, expect } from 'vitest';
import { loadDeviceSurface, deviceReply, type StubRequest } from './deviceSurface';
import { loadSurface } from './mcpSurface';

const HANDLES = [
  { id: 'hud.pause', editor: 'chrome', kind: 'button', label: 'Pause', x: 1, y: 2 },
  { id: 'hud.score', editor: 'chrome', kind: 'span', x: 3, y: 4 },
];
const opResult = (handles: unknown[]) => ({ count: handles.length, occludedCount: 0, occlusionUnchecked: 1, handles });

const sent = (reqs: StubRequest[]) =>
  reqs.filter((q) => q.path === '/api/device/request' && (q.body as { method?: string }).method === 'enact-handles')
    .map((q) => (q.body as { params: Record<string, unknown> }).params);

describe('device_handles is shaped like modoki_handles (#1216 C-14)', () => {
  // The device tool's description promised counts for a bare call; the summary lived only in the editor's
  // route, so the device dumped every handle. Mutation: drop the `shape` argument in device_handles.
  it('a bare call answers counts and no handles[], keeping the occlusion counters', async () => {
    const s = await loadDeviceSurface((q) => (q.path === '/api/device/request' ? deviceReply(opResult(HANDLES)) : undefined));
    try {
      const body = JSON.parse(s.text(await s.call('device_handles', {})));
      expect(body.handles).toBeUndefined();
      expect(body.byEditor).toEqual({ chrome: 2 });
      expect(body).toMatchObject({ occludedCount: 0, occlusionUnchecked: 1 });
    } finally { s.restore(); }
  });

  it('a filtered call that matches nothing names what IS live, asking the device once more unfiltered', async () => {
    const s = await loadDeviceSurface((q) => {
      if (q.path !== '/api/device/request') return undefined;
      const params = (q.body as { params?: Record<string, unknown> }).params ?? {};
      return deviceReply(opResult(Object.keys(params).length ? [] : HANDLES));
    });
    try {
      const body = JSON.parse(s.text(await s.call('device_handles', { editor: 'colider2d' })));
      expect(body.hint).toMatch(/no handle matches editor=colider2d\. Live now: editor ∈ \{chrome\}/);
      expect(sent(s.real())).toEqual([{ editor: 'colider2d' }, {}]);
    } finally { s.restore(); }
  });

  it('a filtered call that matches passes the geometry through untouched', async () => {
    const s = await loadDeviceSurface((q) => (q.path === '/api/device/request' ? deviceReply(opResult(HANDLES)) : undefined));
    try {
      const body = JSON.parse(s.text(await s.call('device_handles', { kind: 'button' })));
      expect(body.handles).toHaveLength(2);
      expect(body.byEditor).toBeUndefined();
    } finally { s.restore(); }
  });

  // modoki_handles took a CSV string and device_handles a list; `prefix`/`label` were editor-only.
  it('ids as a list or a comma string, prefix and label all reach the op', async () => {
    const s = await loadDeviceSurface((q) => (q.path === '/api/device/request' ? deviceReply(opResult(HANDLES)) : undefined));
    try {
      await s.call('device_handles', { ids: 'hud.pause, hud.score' });
      await s.call('device_handles', { ids: ['hud.pause'] });
      await s.call('device_handles', { prefix: 'hud.', label: 'pause' });
      expect(sent(s.real())).toEqual([
        { ids: ['hud.pause', 'hud.score'] }, { ids: ['hud.pause'] }, { prefix: 'hud.', label: 'pause' },
      ]);
    } finally { s.restore(); }
  });

  // Review: an app built before the op's prefix/label filters ignores them and answers every handle, which
  // the shaping would pass off as matches. Mutation: skip the ignoredHandleFilter check in device_handles.
  it('a reply that ignored prefix/label is refused, not passed off as the matches; an honoured one is kept', async () => {
    const s = await loadDeviceSurface((q) => (q.path === '/api/device/request' ? deviceReply(opResult(HANDLES)) : undefined));
    try {
      const ignored = await s.call('device_handles', { prefix: 'menu.' });
      expect(ignored.isError).toBe(true);
      expect(s.text(ignored)).toMatch(/NOT_AVAILABLE_HERE[\s\S]*ignored `prefix`/);
      expect(s.text(await s.call('device_handles', { label: 'pause' }))).toMatch(/ignored `label`/);
      const honoured = await s.call('device_handles', { prefix: 'hud.' });
      expect(honoured.isError).toBeFalsy();
      expect(JSON.parse(s.text(honoured)).handles).toHaveLength(2);
    } finally { s.restore(); }
  });

  // The accept side for label: an honoured filter answers labels that match by the SAME rule the op uses
  // (whitespace-collapsed, case-insensitive), so "  PAUSE " against "Pause" must not read as ignored.
  // Mutation: compare labels exactly in ignoredHandleFilter.
  it('a label filter the device honoured is kept, matched case- and whitespace-insensitively', async () => {
    const s = await loadDeviceSurface((q) => (q.path === '/api/device/request' ? deviceReply(opResult([HANDLES[0]])) : undefined));
    try {
      const r = await s.call('device_handles', { label: '  PAUSE ' });
      expect(r.isError).toBeFalsy();
      expect(JSON.parse(s.text(r)).handles).toHaveLength(1);
    } finally { s.restore(); }
  });

  it('modoki_handles takes a list too, sent as the route\'s comma form', async () => {
    const s = loadSurface();
    try {
      await s.call('modoki_handles', { ids: ['a', 'b'] });
      expect(s.last()?.path).toBe('/api/enact-handles?ids=a%2Cb');
      await s.call('modoki_handles', { ids: 'a,b' });
      expect(s.last()?.path).toBe('/api/enact-handles?ids=a%2Cb');
    } finally { s.restore(); }
  });
});

describe('device_invalidate_assets reaches every cache the op evicts (#1216 C-13)', () => {
  // The enum was ['model','texture'] while the op also evicted audio and environments. Listed literally, not
  // read from the shared tuple the schema derives from: iterating that tuple cannot notice a type dropped
  // from it (a mutation check showed exactly that). invalidateAssetsOp.test.ts pins the op to the same four.
  it.each(['model', 'texture', 'audio', 'environment'])('%s is accepted', async (type) => {
    const s = await loadDeviceSurface();
    try {
      expect(s.validate('device_invalidate_assets', { items: [{ path: '/assets/x', type }] }).ok).toBe(true);
    } finally { s.restore(); }
  });

  it('a type the op holds no cache for is refused by the schema', async () => {
    const s = await loadDeviceSurface();
    try {
      expect(s.validate('device_invalidate_assets', { items: [{ path: '/assets/x.mat.json', type: 'material' }] }).ok).toBe(false);
    } finally { s.restore(); }
  });
});

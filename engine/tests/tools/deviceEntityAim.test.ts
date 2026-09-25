// @vitest-environment jsdom
/** #1223 P3 / #1216 P1-1 — the device input tools aim at an ENTITY, and their refusals keep their code.
 *
 *  Drives the REAL `device_*` handlers against a stubbed backend (`deviceSurface.ts`), so what is
 *  asserted is what the tool sends and what the agent reads back — not a helper in isolation. */

import { describe, it, expect } from 'vitest';
import { loadDeviceSurface, deviceReply, type StubRequest } from './deviceSurface';
import { ENTITY_AIM_SKEW_SELECTOR as SKEW } from '../../tools/game-debug-mcp/src/mcp-tools';
import { encodeDeviceRefusal, decodeDeviceRefusal } from '../../tools/shared/deviceRefusal';

const sentTo = (reqs: StubRequest[], method: string) =>
  reqs.filter((q) => q.path === '/api/device/request' && (q.body as { method?: string })?.method === method)
    .map((q) => (q.body as { params: Record<string, unknown> }).params);
const envelope = (text: string) => JSON.parse(text.slice(text.indexOf('{"error"'))).error as {
  code: string; why: string; options?: string[]; got?: Record<string, unknown>;
};

describe('a synthetic-fallback refusal is still a refusal', () => {
  /** The backend fronts a SYNTHETIC reply with a one-line banner (`synthFallbackBanner`) — on a
   *  refusal too. The tools judged failure by `startsWith('Error:')` on the composed string, so a
   *  refused tap on a device with no trusted route (the iPhone 8, any Android without adb) answered
   *  `Tapped … — ⚠️ SYNTHETIC INPUT … Error: …` as a success. */
  it('device_tap flags a banner-prefixed `Error:` reply as a failure', async () => {
    const banner = '⚠️ SYNTHETIC INPUT (NOT TRUSTED) — no route. This input does NOT set isTrusted.';
    const s = await loadDeviceSurface((q) => (q.path === '/api/device/request' ? deviceReply(`${banner}\nError: selector "#nope" did not resolve`) : undefined));
    try {
      const r = await s.call('device_tap', { selector: '#nope' });
      expect(r.isError).toBe(true);
      expect(s.text(r)).not.toMatch(/^Tapped/);
    } finally { s.restore(); }
  });
});

/** Answer every device request with `reply`, and the adb lease probe as an adb lease with no scale —
 *  the state in which a COORDINATE aim is refused, so an entity aim going through proves it needs none. */
const onDevice = (reply: unknown) => (q: StubRequest) => {
  if (q.path === '/api/device/request') return deviceReply(reply);
  if (q.path === '/api/device/status') return { body: { state: 'connected', target: { host: '', port: 0, useAdb: true }, lastTarget: null } };
  return undefined;
};

describe('the input tools send an entity aim to the device', () => {
  it('device_tap sends entity + allowOccluded, no coordinates, and needs no screenshot scale', async () => {
    const s = await loadDeviceSurface(onDevice('ok (tap) @ entity "Cube" guid=g-cube'));
    try {
      const r = await s.call('device_tap', { entity: { guid: 'g-cube', surface: 'game-3d' }, allowOccluded: true });
      expect(r.isError).toBeFalsy();
      // The skew selector rides along so an app predating entity aim refuses instead of tapping elsewhere.
      expect(sentTo(s.real(), 'tap')).toEqual([{ entity: { guid: 'g-cube', surface: 'game-3d' }, selector: SKEW, allowOccluded: true }]);
      expect(s.text(r)).toContain('Tapped entity guid g-cube on game-3d');
    } finally { s.restore(); }
  });

  it('device_hover, device_scroll and device_pointer send it too', async () => {
    const s = await loadDeviceSurface(onDevice('ok'));
    const entity = { name: 'Hero', surface: 'game-2d' };
    try {
      await s.call('device_hover', { entity });
      await s.call('device_scroll', { entity, deltaY: 120 });
      await s.call('device_pointer', { action: 'down', entity, allowOccluded: false });
      expect(sentTo(s.real(), 'hover')).toEqual([{ entity, selector: SKEW }]);
      expect(sentTo(s.real(), 'scroll')).toEqual([{ dy: 120, entity, selector: SKEW }]);
      expect(sentTo(s.real(), 'pointer')).toEqual([{ action: 'down', entity, selector: SKEW, allowOccluded: false }]);
    } finally { s.restore(); }
  });

  it('device_drag flattens nested from/to onto the bridge keys, an endpoint\'s flag beating the top-level one', async () => {
    const s = await loadDeviceSurface(onDevice('ok'));
    try {
      const r = await s.call('device_drag', {
        from: { entity: { guid: 'g-a', surface: 'game-3d' }, allowOccluded: false },
        to: { selector: '#slot' },
        allowOccluded: true,
      });
      expect(r.isError).toBeFalsy();
      expect(sentTo(s.real(), 'drag')).toEqual([{
        fromEntity: { guid: 'g-a', surface: 'game-3d' }, fromSelector: SKEW, fromAllowOccluded: false,
        toSelector: '#slot', toAllowOccluded: true, steps: 5, delayMs: 20,
      }]);
    } finally { s.restore(); }
  });

  // #1560: the six flat aliases are gone — a stale one is refused BY NAME by the strict schema (§1),
  // and nothing is sent. (It used to be accepted, and AMBIGUOUS beside the nested form.)
  it.each(['fromX', 'fromSelector', 'toY', 'toSelector'])('device_drag refuses the retired flat %s by name, and sends nothing', async (key) => {
    const s = await loadDeviceSurface(onDevice('ok'));
    try {
      await expect(s.call('device_drag', { from: { selector: '#a' }, to: { selector: '#b' }, [key]: key.endsWith('Selector') ? '#c' : 1 }))
        .rejects.toThrow(new RegExp(`unrecognized parameter: '${key}'`));
      expect(sentTo(s.real(), 'drag')).toEqual([]);
    } finally { s.restore(); }
  });
});

describe('an entity aim to an app build that predates it is refused there, not acted on', () => {
  it('the skew selector matches nothing', () => {
    document.body.innerHTML = '<canvas></canvas><div data-ui-id="x"></div>';
    expect(document.querySelector(SKEW)).toBeNull();
  });
});

/** #1556 (owner-approved breaking): two of entity / selector / {x,y} are refused on the device too.
 *  This used to keep a caller's selector beside its entity and let the page's order pick one. The
 *  check reads the CALLER's spec, so the skew selector — the one deliberate second address on the
 *  wire — is not what trips it (the entity-only tests above still send it). */
describe('a device aim giving two addresses is REFUSED AMBIGUOUS, and nothing is sent', () => {
  const entity = { guid: 'g-1', surface: 'game-3d' };
  it.each([
    ['device_tap', 'tap', { entity, selector: '#list' }, 'entity AND selector'],
    ['device_tap', 'tap', { selector: '#list', x: 5, y: 6 }, 'selector AND {x,y}'],
    ['device_hover', 'hover', { entity, x: 5, y: 6 }, 'entity AND {x,y}'],
    ['device_scroll', 'scroll', { entity, selector: '#list', deltaY: 120 }, 'entity AND selector'],
    ['device_pointer', 'pointer', { action: 'down', selector: '#list', x: 5 }, 'selector AND {x,y}'],
    ['device_drag', 'drag', { from: { entity, x: 1, y: 1 }, to: { x: 9, y: 9 } }, 'the from endpoint'],
    ['device_drag', 'drag', { from: { x: 1, y: 1 }, to: { selector: '#list', x: 9, y: 9 } }, 'the to endpoint'],
  ])('%s %j', async (tool, method, args, named) => {
    const s = await loadDeviceSurface(onDevice('ok'));
    try {
      const r = await s.call(tool, args);
      expect(r.isError).toBe(true);
      const e = envelope(s.text(r));
      expect(e.code).toBe('AMBIGUOUS');
      expect(e.why).toContain(named);
      expect(sentTo(s.real(), method)).toEqual([]);
    } finally { s.restore(); }
  });
});

describe('the entity aim schema is strict', () => {
  it('a typo\'d key inside `entity` or a drag endpoint is refused, naming the accepted keys', async () => {
    const s = await loadDeviceSurface();
    try {
      expect(s.validate('device_tap', { entity: { guid: 'g-1', surfce: 'game-3d' } }).error)
        .toMatch(/an entity aim accepts only: guid, name, id, surface, allowOccluded/);
      expect(s.validate('device_drag', { from: { selectr: '#a' }, to: { x: 1, y: 2 } }).error)
        .toMatch(/a drag endpoint accepts only: entity, selector, x, y, allowOccluded/);
    } finally { s.restore(); }
  });

  /** A deliberate difference from the editor twin: a shipped game has no editor viewport. */
  it('surface has no scene-view on the device', async () => {
    const s = await loadDeviceSurface();
    try {
      expect(s.validate('device_tap', { entity: { guid: 'g-1', surface: 'scene-view' } }).ok).toBe(false);
      expect(s.validate('device_tap', { entity: { guid: 'g-1', surface: 'game-ui' } }).ok).toBe(true);
    } finally { s.restore(); }
  });
});

describe('a device aim refusal keeps its code, options and stale', () => {
  it('NOT_FOUND + stale and AMBIGUOUS + guids reach the envelope; the guids replace the generic advice', async () => {
    const stale = encodeDeviceRefusal({ error: 'Error: entity: no live entity has guid "00000000-0002-0000-0000-000000000001"', code: 'NOT_FOUND', stale: 'world-swapped' });
    let s = await loadDeviceSurface(onDevice(stale));
    try {
      const e = envelope(s.text(await s.call('device_tap', { entity: { guid: '00000000-0002-0000-0000-000000000001', surface: 'game-3d' } })));
      expect(e.code).toBe('NOT_FOUND');
      expect(e.got).toEqual({ stale: 'world-swapped' });
      expect(e.why).not.toContain('[modoki-refusal]');
    } finally { s.restore(); }

    s = await loadDeviceSurface(onDevice(encodeDeviceRefusal({ error: 'Error: entity: 2 LIVE entities are named "Enemy"', code: 'AMBIGUOUS', options: ['g-a', 'g-b'] })));
    try {
      const e = envelope(s.text(await s.call('device_hover', { entity: { name: 'Enemy', surface: 'game-2d' } })));
      expect(e.code).toBe('AMBIGUOUS');
      expect(e.options).toEqual(['g-a', 'g-b']);
    } finally { s.restore(); }
  });

  it('an older app build\'s bare `Error:` reply stays the generic refusal with the tool\'s advice', async () => {
    const s = await loadDeviceSurface(onDevice('Error: selector "#nope" did not resolve'));
    try {
      const e = envelope(s.text(await s.call('device_tap', { selector: '#nope' })));
      expect(e.code).toBe('REFUSED_BY_OP');
      expect(e.options?.length).toBeGreaterThan(0);
    } finally { s.restore(); }
  });
});

describe('the refusal wire encoding (tools/shared/deviceRefusal.ts)', () => {
  it('round-trips, keeps the Error: prefix first, and adds no tail when there is nothing to carry', () => {
    const wire = encodeDeviceRefusal({ error: 'Error: covered', code: 'OCCLUDED', options: ['g-1'], stale: 'despawned' });
    expect(wire.startsWith('Error: covered\n')).toBe(true);
    expect(decodeDeviceRefusal(wire)).toEqual({ message: 'Error: covered', code: 'OCCLUDED', options: ['g-1'], stale: 'despawned' });
    expect(encodeDeviceRefusal({ error: 'Error: plain' })).toBe('Error: plain');
  });

  /** The closed code set is the contract (§5): a tail from a newer or corrupted build must not put an
   *  invented code in front of the agent. */
  it('drops a code outside the closed set', () => {
    expect(decodeDeviceRefusal('Error: x\n[modoki-refusal]{"code":"BOGUS","stale":"despawned"}')).toEqual({ message: 'Error: x', stale: 'despawned' });
  });
});

/** Gameplay recorder (#1479): the take format, the replay's event cursor, and the recorder's pure
 *  decisions — layout mapping, move coalescing, the saved-data snapshot. */

import { describe, it, expect } from 'vitest';
import { parseTake, frameCountFor, TakeCursor, TAKE_FORMAT, TAKE_VERSION, type Take } from '../../src/editor/recorder/take';
import { clientToLayout, TakeBuilder, snapshotPrefs, takeFileStem } from '../../src/editor/recorder/takeRecorder';

const valid = (): Take => ({
  format: TAKE_FORMAT, version: TAKE_VERSION, game: 'court', scene: 'main.scene.json',
  viewport: { width: 540, height: 960 }, seed: 7, duration: 3,
  epochMs: 1_790_000_000_000, timezone: 'Asia/Tokyo', locale: 'en-US',
  safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
  prefs: { 'court.progress': '{"v":1,"d":{}}' },
  events: [{ t: 1, kind: 'down', x: 10, y: 20 }, { t: 1.5, kind: 'up', x: 10, y: 20 }],
});

describe('parseTake', () => {
  it('accepts a well-formed take', () => {
    expect(parseTake(valid()).game).toBe('court');
  });

  it('reports EVERY problem at once, not just the first', () => {
    const bad = { ...valid(), version: 2, seed: 1.5, timezone: '', prefs: { k: { parsed: true } } };
    const msg = (() => { try { parseTake(bad); return ''; } catch (e) { return (e as Error).message; } })();
    expect(msg).toMatch(/4 problem/);
    expect(msg).toMatch(/version/);
    expect(msg).toMatch(/seed/);
    expect(msg).toMatch(/timezone/);
    expect(msg).toMatch(/raw stored string/);
  });

  it('refuses events out of time order — the replay walks them once, forwards', () => {
    const t = valid();
    t.events = [{ t: 2, kind: 'down', x: 0, y: 0 }, { t: 1, kind: 'up', x: 0, y: 0 }];
    expect(() => parseTake(t)).toThrow(/earlier than the event before it/);
  });

  it('refuses a non-object', () => {
    expect(() => parseTake([])).toThrow(/JSON object/);
  });
});

describe('frameCountFor', () => {
  it('spans [0, duration] inclusive — the last frame dispatches the events stamped at the very end', () => {
    expect(frameCountFor({ duration: 3 }, 30)).toBe(91);
    expect(frameCountFor({ duration: 3.01 }, 30)).toBe(92);
    // A float product a hair over an integer must not add a frame.
    expect(frameCountFor({ duration: 0.1 * 3 }, 10)).toBe(4);
  });

  it('dispatches an event stamped at the duration — the closing up of a take stopped mid-gesture', () => {
    for (const [duration, fps] of [[1, 30], [2.345, 30], [0.5, 60], [7, 24]] as const) {
      const total = frameCountFor({ duration }, fps);
      const cursor = new TakeCursor([{ t: duration, kind: 'up', x: 0, y: 0 }]);
      for (let f = 0; f < total; f++) cursor.due(f / fps);
      expect(cursor.remaining).toBe(0);
    }
  });

  it('renders one frame of an empty take', () => {
    expect(frameCountFor({ duration: 0 }, 30)).toBe(1);
  });
});

describe('TakeCursor', () => {
  it('hands out each event once, when the replay clock reaches its stamp', () => {
    const c = new TakeCursor([
      { t: 0.5, kind: 'down', x: 0, y: 0 }, { t: 0.5, kind: 'move', x: 1, y: 0 }, { t: 1, kind: 'up', x: 1, y: 0 },
    ]);
    expect(c.due(0.4)).toEqual([]);
    expect(c.due(0.5).map((e) => e.kind)).toEqual(['down', 'move']);
    expect(c.due(0.9)).toEqual([]);
    expect(c.due(2).map((e) => e.kind)).toEqual(['up']);
    expect(c.remaining).toBe(0);
  });

  it('tolerates float drift between a live stamp and a sum of fixed steps', () => {
    let replay = 0;
    for (let i = 0; i < 30; i++) replay += 1 / 60;   // 0.49999999999999994
    const c = new TakeCursor([{ t: 0.5, kind: 'down', x: 0, y: 0 }]);
    expect(c.due(replay)).toHaveLength(1);
  });
});

describe('clientToLayout', () => {
  it('divides the GameView CSS scale back out of a client point', () => {
    // A 540-wide game drawn at 270 px on screen, offset by the panel.
    expect(clientToLayout(100 + 135, 50 + 240, { left: 100, top: 50, width: 270, height: 480 }, 540))
      .toEqual({ x: 270, y: 480 });
  });

  it('is the identity at scale 1 with the root at the origin — the replay page', () => {
    expect(clientToLayout(12.345, 6.789, { left: 0, top: 0, width: 540, height: 960 }, 540)).toEqual({ x: 12.35, y: 6.79 });
  });
});

describe('TakeBuilder', () => {
  it('drops hover moves and keeps moves inside a gesture', () => {
    const b = new TakeBuilder();
    expect(b.add('move', 0.1, 1, 1)).toBe(false);
    b.add('down', 0.2, 1, 1);
    expect(b.add('move', 0.3, 2, 2)).toBe(true);
    b.add('up', 0.4, 2, 2);
    expect(b.add('move', 0.5, 3, 3)).toBe(false);
    expect(b.events.map((e) => e.kind)).toEqual(['down', 'move', 'up']);
  });

  it('coalesces moves at one sim instant to the last — the only one the game sampled', () => {
    const b = new TakeBuilder();
    b.add('down', 1, 0, 0);
    b.add('move', 1.5, 1, 1);
    b.add('move', 1.5, 2, 2);
    b.add('move', 1.5, 3, 3);
    expect(b.events).toEqual([{ t: 1, kind: 'down', x: 0, y: 0 }, { t: 1.5, kind: 'move', x: 3, y: 3 }]);
  });

  it('ignores a second down and a stray up, and reports an open gesture', () => {
    const b = new TakeBuilder();
    expect(b.add('up', 0, 0, 0)).toBe(false);
    b.add('down', 1, 0, 0);
    expect(b.add('down', 1.1, 5, 5)).toBe(false);
    expect(b.isPressed).toBe(true);
    b.add('up', 1.2, 0, 0);
    expect(b.isPressed).toBe(false);
  });
});

describe('snapshotPrefs', () => {
  const store = (entries: Record<string, string>) => {
    const keys = Object.keys(entries);
    return { length: keys.length, key: (i: number) => keys[i] ?? null, getItem: (k: string) => entries[k] ?? null };
  };

  it('keeps exactly the namespace, raw, with the prefix stripped', () => {
    const s = store({
      'mk:court@editor:court.progress': '{"v":1,"d":{"x":1}}',
      'mk:court@editor:court.purchases': '{"v":1,"d":[]}',
      'mk:court:court.progress': 'the RUNTIME namespace, not this one',
      'mk:court@editorX:court.progress': 'a namespace that merely shares a prefix',
      'unrelated': 'x',
    });
    expect(snapshotPrefs(s, 'court@editor')).toEqual({
      'court.progress': '{"v":1,"d":{"x":1}}',
      'court.purchases': '{"v":1,"d":[]}',
    });
  });

  it('sanitises a colon in the namespace the way PlayerPrefs does', () => {
    expect(snapshotPrefs(store({ 'mk:a_b:k': 'v' }), 'a:b')).toEqual({ k: 'v' });
  });
});

describe('takeFileStem', () => {
  it('sorts by when the take was played', () => {
    expect(takeFileStem('court', new Date(2026, 8, 4, 7, 5, 9))).toBe('court-20260904-070509');
  });
});

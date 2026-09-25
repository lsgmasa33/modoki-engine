/** `waitForCondition` / `conditionError` (#1154) — the decisions, against fake readers and a fake
 *  clock, one describe per condition kind. The op binding (real readers, real refusal) is in
 *  waitForOp.test.ts. */

import { describe, it, expect } from 'vitest';
import {
  conditionError, waitForCondition, clampWaitTimeout,
  WAIT_FOR_DEFAULT_MS, WAIT_FOR_MAX_MS, WAIT_FOR_MIN_MS,
  type WaitReaders, type WaitCondition, type ChromeHandleLike, type ConsoleEntryLike,
} from '../../app/debug/waitFor';

/** Readers over mutable state, and a clock that only moves when the wait sleeps. `onSleep` runs
 *  after each sleep, so a test can make the world change "while" the wait is parked. */
function harness(over: Partial<WaitReaders> = {}) {
  const state = {
    handles: [] as ChromeHandleLike[],
    entityCount: 0,
    console: [] as Array<ConsoleEntryLike & { mono?: number }>,
    editor: { playState: 'stopped', runMode: 'stopped', advancing: true, scenePath: '/a.scene.json' } as Record<string, unknown>,
  };
  let t = 0;
  const sleeps: number[] = [];
  let onSleep: (() => void) | null = null;
  const readers: WaitReaders = {
    chrome: () => state.handles,
    whereError: () => null,
    entities: () => ({ count: state.entityCount, ...(state.entityCount ? { first: { guid: 'g1' } } : {}) }),
    consoleSince: (seq) => state.console.filter((e) => e.seq > seq),
    consoleWatermark: (lookbackMs) => {
      if (!lookbackMs) return state.console.at(-1)?.seq ?? 0;
      let mark = 0;
      for (const e of state.console) { if ((e.mono ?? 0) < t - lookbackMs) mark = e.seq; else break; }
      return mark;
    },
    editorState: () => state.editor,
    ...over,
  };
  const run = (cond: WaitCondition, timeoutMs = 1000, pollMs = 50) => waitForCondition(cond, {
    readers, timeoutMs, pollMs,
    now: () => t,
    sleep: async (ms) => { sleeps.push(ms); t += ms; onSleep?.(); },
  });
  return { state, readers, run, sleeps, setOnSleep: (fn: () => void) => { onSleep = fn; } };
}

describe('conditionError — refused BEFORE parking', () => {
  const r = { whereError: (w: string) => (w.startsWith('Nope.') ? 'unknown trait "Nope"' : null) };
  it.each([
    [undefined, /condition object is required/],
    [{}, /exactly one of chrome, entity, console, editor is required \(got none\)/],
    [{ chrome: { label: 'A' }, editor: { runMode: 'stopped' } }, /got chrome \+ editor/],
    [{ dom: {} }, /unknown condition kind\(s\): dom/],
    [{ chrome: { lable: 'A' } }, /unknown chrome field\(s\): lable/],
    [{ chrome: { label: 'A', checked: 'yes' } }, /chrome\.checked must be a boolean/],
    [{ chrome: {} }, /chrome needs a label or an id/],
    [{ chrome: { id: 'x', absent: true, value: '3' } }, /absent cannot be combined with a state field/],
    [{ entity: {} }, /entity needs a guid, a name or a where/],
    [{ entity: { where: 'Nope.x = 1' } }, /unknown trait "Nope"/],
    [{ console: { match: '' } }, /console\.match .* is required/],
    [{ console: { match: 'x', level: 'debug' } }, /console\.level must be one of/],
    [{ console: { match: 'x', lookbackMs: '500' } }, /console\.lookbackMs must be a number/],
    [{ console: { match: 'x', lookbackMs: 120_000 } }, /console\.lookbackMs must be within/],
    [{ editor: {} }, /editor needs at least one of/],
  ])('%j', (cond, re) => {
    expect(conditionError(cond, r)).toMatch(re);
  });

  it('accepts one well-formed condition of each kind', () => {
    for (const cond of [
      { chrome: { label: 'Save', disabled: false } }, { chrome: { id: 'x', absent: true } },
      { entity: { where: 'Transform.y > 3' } }, { console: { match: 'loaded', level: 'info' } },
      { editor: { runMode: 'playing' } },
    ]) expect(conditionError(cond, r), JSON.stringify(cond)).toBeNull();
  });
});

describe('clampWaitTimeout', () => {
  it('defaults, floors and caps', () => {
    expect(clampWaitTimeout(undefined)).toBe(WAIT_FOR_DEFAULT_MS);
    expect(clampWaitTimeout(0)).toBe(WAIT_FOR_MIN_MS);
    expect(clampWaitTimeout(10 ** 9)).toBe(WAIT_FOR_MAX_MS);
  });
});

describe('the wait loop', () => {
  it('a condition already true returns at once, without sleeping', async () => {
    const h = harness();
    const r = await h.run({ editor: { runMode: 'stopped' } });
    expect(r).toMatchObject({ satisfied: true, elapsedMs: 0, observation: { runMode: 'stopped' } });
    expect(h.sleeps).toEqual([]);
  });

  it('a timeout is a normal result carrying the LAST observation, and never sleeps past the deadline', async () => {
    const h = harness();
    const r = await h.run({ editor: { runMode: 'playing' } }, 120, 50);
    expect(r).toEqual({ satisfied: false, timedOut: true, elapsedMs: 120, condition: 'editor {"runMode":"playing"}', lastObservation: { runMode: 'stopped' } });
    expect(h.sleeps).toEqual([50, 50, 20]);
  });

  it('keeps polling through a reader that throws, and reports the error if it never recovers', async () => {
    let calls = 0;
    const h = harness({ editorState: () => { if (++calls < 3) throw new Error('world swapping'); return { runMode: 'playing' }; } });
    expect(await h.run({ editor: { runMode: 'playing' } })).toMatchObject({ satisfied: true, elapsedMs: 100 });
    const dead = harness({ editorState: () => { throw new Error('world swapping'); } });
    expect(await dead.run({ editor: { runMode: 'playing' } }, 60)).toMatchObject({ timedOut: true, lastObservation: { readError: 'world swapping' } });
  });
});

describe('chrome', () => {
  it('present: satisfied the poll after the control appears, with the handle as the observation', async () => {
    const h = harness();
    h.setOnSleep(() => { if (h.sleeps.length === 2) h.state.handles = [{ id: 'dlg-ok', label: 'OK' }]; });
    expect(await h.run({ chrome: { label: 'OK' } })).toMatchObject({ satisfied: true, elapsedMs: 100, observation: { matches: 1, first: { id: 'dlg-ok', label: 'OK' } } });
  });

  it('absent: satisfied once no control matches', async () => {
    const h = harness();
    h.state.handles = [{ id: 'spinner' }];
    h.setOnSleep(() => { h.state.handles = []; });
    expect(await h.run({ chrome: { id: 'spinner', absent: true } })).toMatchObject({ satisfied: true, observation: { matches: 0 } });
  });

  it('a state test compares the ONE match\'s meta, reading an omitted disabled/mixed flag as false', async () => {
    const h = harness();
    h.state.handles = [{ id: 'save', meta: { value: '3' } }];
    expect(await h.run({ chrome: { id: 'save', disabled: false, value: '3' } })).toMatchObject({ satisfied: true });
    expect(await h.run({ chrome: { id: 'save', value: '4' } }, 60)).toMatchObject({ timedOut: true, lastObservation: { meta: { value: '3' } } });
    h.state.handles = [{ id: 'save', meta: { disabled: true } }];
    expect(await h.run({ chrome: { id: 'save', disabled: true } })).toMatchObject({ satisfied: true });
  });

  it('a state test over TWO matches is not satisfied — it says ambiguous and names them', async () => {
    const h = harness();
    h.state.handles = [{ id: 'a', meta: { checked: true } }, { id: 'b', meta: { checked: true } }];
    expect(await h.run({ chrome: { label: 'Loop', checked: true } }, 60)).toMatchObject({
      timedOut: true, lastObservation: { matches: 2, ids: ['a', 'b'], ambiguous: expect.stringMatching(/exactly one/) },
    });
  });
});

describe('entity', () => {
  it('reports the first match as identity plus ONLY the trait the where reads', async () => {
    const row = { id: 3, guid: 'g1', name: 'Hero', parentId: 0, traits: { Transform: { x: 1 }, Health: { hp: 0 }, EntityAttributes: { name: 'Hero' } } };
    const h = harness({ entities: () => ({ count: 1, first: row }) });
    expect(await h.run({ entity: { where: 'Health.hp <= 0' } })).toMatchObject({ satisfied: true, observation: { matches: 1, first: { guid: 'g1', name: 'Hero', Health: { hp: 0 } } } });
    const r = await h.run({ entity: { guid: 'g1' } }) as { observation: { first: Record<string, unknown> } };
    expect(r.observation.first).toEqual({ guid: 'g1', name: 'Hero' });
  });

  it('present when the query matches, absent when it stops matching', async () => {
    const h = harness();
    h.setOnSleep(() => { h.state.entityCount = 1; });
    expect(await h.run({ entity: { where: 'Health.hp <= 0' } })).toMatchObject({ satisfied: true, observation: { matches: 1, first: { guid: 'g1' } } });
    h.setOnSleep(() => { h.state.entityCount = 0; });
    expect(await h.run({ entity: { guid: 'g1', absent: true } })).toMatchObject({ satisfied: true, observation: { matches: 0 } });
  });
});

describe('console', () => {
  it('a matching line logged BEFORE the wait does not satisfy it; one logged during it does', async () => {
    const h = harness();
    h.state.console = [{ seq: 1, level: 'info', args: ['scene loaded'] }];
    h.setOnSleep(() => { if (h.sleeps.length === 1) h.state.console.push({ seq: 2, level: 'info', args: ['scene', 'loaded'] }); });
    expect(await h.run({ console: { match: 'scene loaded' } })).toMatchObject({ satisfied: true, elapsedMs: 50, observation: { seq: 2, text: 'scene loaded' } });
  });

  it('lookbackMs admits a line the PREVIOUS step logged just before the call, and nothing older', async () => {
    // The batch [tap, wait_for console] shape: the tap's handler logged before the wait began.
    const later = harness(); // the clock starts at 0, so negative monos were logged before the call
    later.state.console = [{ seq: 1, level: 'log', args: ['clicked'], mono: -5000 }, { seq: 2, level: 'log', args: ['clicked'], mono: -200 }];
    expect(await later.run({ console: { match: 'clicked', lookbackMs: 1000 } })).toMatchObject({ satisfied: true, elapsedMs: 0, observation: { seq: 2 } });
    const old = harness();
    old.state.console = [{ seq: 1, level: 'log', args: ['clicked'], mono: -5000 }];
    expect(await old.run({ console: { match: 'clicked', lookbackMs: 1000 } }, 60)).toMatchObject({ timedOut: true });
  });

  it('filters by level', async () => {
    const h = harness();
    h.setOnSleep(() => { h.state.console.push({ seq: h.sleeps.length, level: h.sleeps.length === 1 ? 'log' : 'error', args: ['boom'] }); });
    expect(await h.run({ console: { match: 'boom', level: 'error' } })).toMatchObject({ satisfied: true, observation: { seq: 2, level: 'error' } });
  });

  // #1559: `level` is a threshold on every console reader — waiting for `warn` is satisfied by an
  // error, and a `log` line does not satisfy it.
  it('level is a threshold — warn is satisfied by an error, not by a log', async () => {
    const h = harness();
    h.setOnSleep(() => { h.state.console.push({ seq: h.sleeps.length, level: h.sleeps.length === 1 ? 'log' : 'error', args: ['boom'] }); });
    expect(await h.run({ console: { match: 'boom', level: 'warn' } })).toMatchObject({ satisfied: true, observation: { seq: 2, level: 'error' } });
  });
});

describe('editor', () => {
  it('every given field must match — one mismatch keeps it waiting', async () => {
    const h = harness();
    expect(await h.run({ editor: { runMode: 'stopped', scenePath: '/b.scene.json' } }, 60)).toMatchObject({
      timedOut: true, lastObservation: { runMode: 'stopped', scenePath: '/a.scene.json' },
    });
    h.setOnSleep(() => { h.state.editor.scenePath = '/b.scene.json'; });
    expect(await h.run({ editor: { runMode: 'stopped', scenePath: '/b.scene.json' } })).toMatchObject({ satisfied: true });
  });
});

// #1214 (owner decision, option A): an `absent` wait on a target that never matched still succeeds,
// but says it held on the first check and names what IS live — a typo otherwise reads as "it closed".
describe('an empty match discloses the live vocabulary', () => {
  const vocab = { chromeLabels: () => ['Cancel', 'Save As', 'Save', 'Open'], entityNames: () => ['Player', 'Enemy'] };

  it('absent on the FIRST check: satisfied, alreadyAbsent, and the closest live label first', async () => {
    const h = harness(vocab);
    const r = await h.run({ chrome: { label: 'Sav As', absent: true } }) as Record<string, unknown>;
    expect(r).toMatchObject({ satisfied: true, alreadyAbsent: true, elapsedMs: 0 });
    expect(r.hint).toMatch(/not evidence that anything went away/);
    expect(r.hint).toMatch(/label ∈ \{Save As, /);
  });

  it('absent that held only AFTER a poll is an ordinary success — no alreadyAbsent', async () => {
    const h = harness(vocab);
    h.state.handles = [{ id: 'dlg', label: 'Save As' }];
    h.setOnSleep(() => { h.state.handles = []; });
    const r = await h.run({ chrome: { label: 'Save As', absent: true } }) as Record<string, unknown>;
    expect(r).toMatchObject({ satisfied: true });
    expect(r).not.toHaveProperty('alreadyAbsent');
    expect(r).not.toHaveProperty('hint');
  });

  it('a chrome wait addressed by id names live ids, not labels', async () => {
    const h = harness({ ...vocab, chromeIds: () => ['menu.file', 'dialog.saveAs.ok'] });
    const r = await h.run({ chrome: { id: 'dialog.saveAs.okk', absent: true } }) as Record<string, unknown>;
    expect(r.hint).toMatch(/id ∈ \{dialog\.saveAs\.ok, menu\.file\}/);
    expect(r.hint).not.toMatch(/label ∈/);
  });

  it('an entity absent wait by name gets the live names', async () => {
    const h = harness(vocab);
    const r = await h.run({ entity: { name: 'Plyer', absent: true } }) as Record<string, unknown>;
    expect(r).toMatchObject({ satisfied: true, alreadyAbsent: true });
    expect(r.hint).toMatch(/name ∈ \{Player, Enemy\}/);
  });

  it('a present wait that never matched times out naming the live labels', async () => {
    const h = harness(vocab);
    expect(await h.run({ chrome: { label: 'Sav As' } }, 60)).toMatchObject({
      timedOut: true, lastObservation: { matches: 0, live: expect.stringMatching(/^label ∈ \{Save As, /) },
    });
  });

  it('a timeout that DID match something carries no vocabulary', async () => {
    const h = harness(vocab);
    h.state.handles = [{ id: 'save', meta: { value: '3' } }];
    const r = await h.run({ chrome: { id: 'save', value: '4' } }, 60) as { lastObservation: Record<string, unknown> };
    expect(r.lastObservation).not.toHaveProperty('live');
  });

  it('readers without a vocabulary still answer — the hint just names none', async () => {
    const h = harness();
    const r = await h.run({ chrome: { label: 'X', absent: true } }) as Record<string, unknown>;
    expect(r).toMatchObject({ satisfied: true, alreadyAbsent: true });
    expect(r.hint).not.toMatch(/Live now/);
  });
});

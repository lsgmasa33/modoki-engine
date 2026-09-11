/** `''` on a DECLARED action param reaches the handler as ABSENT (#1075).
 *
 *  `normaliseParams` in `runtime/core/actionRegistry.ts` is the one door every route comes through —
 *  UI bindings and MCP via `dispatchUIAction`, timeline signal markers via `dispatchGameAction` — so
 *  these drive the real dispatchers rather than calling a helper, and cover BOTH. The member tests
 *  (quality, haptics, audio, the demos, space-console) each pin one handler's reported symptom; this
 *  file pins the rule they all rest on, including its accept side. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createWorld } from 'koota';
import { registerUIAction, unregisterUIAction, dispatchUIAction, dispatchGameAction } from '../../src/runtime/core/actionRegistry';
import { setCurrentWorld } from '../../src/runtime/core/ecs/world';
import { getPlayState, setPlayState } from '../../src/runtime/core/playState';

const prevState = getPlayState();
let world: ReturnType<typeof createWorld> | undefined;
let seen: Record<string, unknown> | undefined;

beforeEach(() => {
  world = createWorld();
  setCurrentWorld(world);
  setPlayState('playing'); // both dispatchers are inert unless the sim runs
  seen = undefined;
  registerUIAction('t.typed', {
    params: {
      n: { type: 'number' }, e: { type: 'enum', options: ['a'] }, s: { type: 'string' },
      c: { type: 'color' }, b: { type: 'boolean' }, r: { type: 'entityRef' },
      keep: { type: 'string', allowEmpty: true },
    },
    handler: ({ params }) => { seen = params; },
  });
  registerUIAction('t.bare', ({ params }) => { seen = params; });
});

afterEach(() => {
  unregisterUIAction('t.typed');
  unregisterUIAction('t.bare');
  world?.destroy();
  world = undefined;
  setPlayState(prevState);
});

describe('declared action params: empty string means absent (#1075)', () => {
  it('drops "" from a declared param of every type — the key is gone, not set to undefined', () => {
    dispatchUIAction('t.typed', { params: { n: '', e: '', s: '', c: '', b: '', r: '' } });
    expect(seen).toEqual({});
    for (const key of ['n', 'e', 's', 'c', 'b', 'r']) expect(Object.hasOwn(seen!, key), key).toBe(false);
  });

  it('keeps "" on a param declared allowEmpty', () => {
    dispatchUIAction('t.typed', { params: { keep: '', s: '' } });
    expect(seen).toEqual({ keep: '' });
  });

  it('passes an undeclared key through — the schema-less payload convention included', () => {
    dispatchUIAction('t.typed', { params: { extra: '', payload: '' } });
    expect(seen).toEqual({ extra: '', payload: '' });
    // "Declared" is an OWN property of the schema: `constructor` is inherited by every object, so an
    // `in` check would read it as declared and drop an authored `constructor: ''`.
    dispatchUIAction('t.typed', { params: { constructor: '', toString: '' } });
    expect(Object.hasOwn(seen!, 'constructor') && seen!.constructor).toBe('');
    expect(Object.hasOwn(seen!, 'toString') && seen!.toString).toBe('');
    dispatchUIAction('t.bare', { params: { s: '' } });
    expect(seen).toEqual({ s: '' });
  });

  it('leaves every non-empty value alone, falsy ones included', () => {
    dispatchUIAction('t.typed', { params: { n: 0, s: 'x', b: false, e: 'a', c: 0 } });
    expect(seen).toEqual({ n: 0, s: 'x', b: false, e: 'a', c: 0 });
  });

  it('never mutates the authored params object — it is the scene binding data', () => {
    const authored = { s: '', n: 5 };
    dispatchUIAction('t.typed', { params: authored });
    expect(authored).toEqual({ s: '', n: 5 });
    expect(seen).toEqual({ n: 5 });
  });

  it('dispatchGameAction normalises too — the timeline signal-marker route', () => {
    expect(dispatchGameAction('t.typed', { params: { s: '', n: 3 } })).toBe(true);
    expect(seen).toEqual({ n: 3 });
  });
});

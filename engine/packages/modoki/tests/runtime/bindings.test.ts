/** applyBindings — unified UIAction event→response bindings (set writes + call
 *  actions), per-event filtering, $value substitution, sim-gating. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createWorld } from 'koota';
import { setCurrentWorld } from '../../src/runtime/ecs/world';
import { EntityAttributes } from '../../src/runtime/traits/EntityAttributes';
import { UIElement } from '../../src/runtime/traits/UIElement';
import { Transform } from '../../src/runtime/traits/Transform';
import { registerTrait } from '../../src/runtime/ecs/traitRegistry';
import { applyBindings, type UIActionBinding } from '../../src/runtime/ui/bindings';
import { registerUIAction, unregisterUIAction } from '../../src/runtime/ui/actionRegistry';
import { setPlayState } from '../../src/runtime/systems/playState';

// applyBindings resolves components via the trait registry (like the runtime).
registerTrait({ name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: {} });
registerTrait({ name: 'UIElement', trait: UIElement, category: 'component', fields: {} });
registerTrait({ name: 'Transform', trait: Transform, category: 'component', fields: {} });

const setOp = (target: string, value: unknown, event: UIActionBinding['event'] = 'click'): UIActionBinding =>
  ({ event, kind: 'set', target, component: 'UIElement', property: 'isVisible', value });

describe('applyBindings', () => {
  let world: ReturnType<typeof createWorld>;

  beforeEach(() => {
    world = createWorld();
    setCurrentWorld(world);
    setPlayState('playing');
  });
  afterEach(() => {
    setPlayState('playing');
    world.destroy();
  });

  function panel(guid: string, visible = false) {
    return world.spawn(EntityAttributes({ guid, name: guid }), UIElement({ isVisible: visible }));
  }

  it('runs a set binding for the matching event', () => {
    const p = panel('panel-1', false);
    applyBindings([setOp('panel-1', true)], 'click');
    expect((p.get(UIElement) as any).isVisible).toBe(true);
  });

  it('only runs bindings whose event matches', () => {
    const p = panel('panel-1', false);
    applyBindings([setOp('panel-1', true, 'change')], 'click'); // change binding, click event
    expect((p.get(UIElement) as any).isVisible).toBe(false);
    applyBindings([setOp('panel-1', true, 'change')], 'change');
    expect((p.get(UIElement) as any).isVisible).toBe(true);
  });

  it('applies multiple set bindings in one event (show one, hide another)', () => {
    const a = panel('a', false);
    const b = panel('b', true);
    applyBindings([setOp('a', true), setOp('b', false)], 'click');
    expect((a.get(UIElement) as any).isVisible).toBe(true);
    expect((b.get(UIElement) as any).isVisible).toBe(false);
  });

  it('substitutes the $value token with the event value', () => {
    const e = world.spawn(EntityAttributes({ guid: 'movable', name: 'movable' }), Transform({ x: 0 }));
    applyBindings([{ event: 'change', kind: 'set', target: 'movable', component: 'Transform', property: 'x', value: '$value' }], 'change', { eventValue: 7 });
    expect((e.get(Transform) as any).x).toBe(7);
  });

  it('is inert when the sim is not running', () => {
    const p = panel('panel-1', false);
    setPlayState('stopped');
    applyBindings([setOp('panel-1', true)], 'click');
    expect((p.get(UIElement) as any).isVisible).toBe(false);
  });

  it('resolves an empty target to selfGuid', () => {
    const p = panel('self', false);
    applyBindings([setOp('', true)], 'click', { selfGuid: 'self' });
    expect((p.get(UIElement) as any).isVisible).toBe(true);
  });

  it('dispatches a call binding with resolved params and target', () => {
    const p = world.spawn(EntityAttributes({ guid: 'tgt', name: 'tgt' }));
    let seen: any;
    registerUIAction('test.callBinding', (ctx) => { seen = { params: ctx.params, payload: ctx.payload, target: ctx.target?.id() }; });
    applyBindings(
      [{ event: 'change', kind: 'call', action: 'test.callBinding', target: 'tgt', params: { amount: '$value', fixed: 3 } }],
      'change',
      { eventValue: 42 },
    );
    unregisterUIAction('test.callBinding');
    expect(seen.params).toEqual({ amount: 42, fixed: 3 });
    expect(seen.payload).toBe(42);
    expect(seen.target).toBe(p.id());
  });

  it('falls back to an authored payload param for ctx.payload on click (no event value)', () => {
    let seen: any;
    registerUIAction('test.payloadFallback', (ctx) => { seen = ctx.payload; });
    applyBindings([{ event: 'click', kind: 'call', action: 'test.payloadFallback', params: { payload: 'hello' } }], 'click');
    unregisterUIAction('test.payloadFallback');
    expect(seen).toBe('hello');
  });

  it('routes the submit event (Enter key) to its bindings', () => {
    const p = world.spawn(EntityAttributes({ guid: 'tgt', name: 'tgt' }), Transform({ x: 0 }));
    applyBindings(
      [{ event: 'submit', kind: 'set', target: 'tgt', component: 'Transform', property: 'x', value: '$value' }],
      'submit',
      { eventValue: 5 },
    );
    expect((p.get(Transform) as any).x).toBe(5);
  });

  it('fires the right binding when one list mixes click/change/submit', () => {
    const p = panel('p', false);
    const bindings: UIActionBinding[] = [
      setOp('p', true, 'click'),
      setOp('p', false, 'change'),
      setOp('p', true, 'submit'),
    ];
    applyBindings(bindings, 'change');
    expect((p.get(UIElement) as any).isVisible).toBe(false); // only the change row ran
    applyBindings(bindings, 'submit');
    expect((p.get(UIElement) as any).isVisible).toBe(true);  // only the submit row ran
  });

  it('skips a call binding with no action name but still runs sibling bindings', () => {
    const p = panel('p', false);
    expect(() => applyBindings([
      { event: 'click', kind: 'call' }, // no action — skipped, must not throw
      setOp('p', true),                 // sibling set still applies
    ], 'click')).not.toThrow();
    expect((p.get(UIElement) as any).isVisible).toBe(true);
  });

  it('ignores set bindings with a missing target, component, or untargeted self', () => {
    const p = panel('panel-1', false);
    expect(() => applyBindings([
      { event: 'click', kind: 'set', target: 'nope', component: 'UIElement', property: 'isVisible', value: true },
      { event: 'click', kind: 'set', target: 'panel-1', component: 'NoSuchTrait', property: 'isVisible', value: true },
      { event: 'click', kind: 'set', target: '', component: 'UIElement', property: 'isVisible', value: true }, // no selfGuid
    ], 'click')).not.toThrow();
    expect((p.get(UIElement) as any).isVisible).toBe(false);
  });
});

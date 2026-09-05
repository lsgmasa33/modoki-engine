/** Enact Phase 2 — the interaction-handle provider registry (the input twin of
 *  screenBounds). Verifies merge, filtering, id resolution, and that one throwing
 *  provider can't break the whole report. */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createWorld } from 'koota';
import {
  registerHandleProvider, collectHandles, resolveHandle,
  type InteractionHandle,
} from '../../src/runtime/rendering/interactionHandles';
import { setCurrentWorld } from '../../src/runtime/core/ecs/world';

const unregs: Array<() => void> = [];
function provide(handles: InteractionHandle[]) {
  const u = registerHandleProvider(() => handles);
  unregs.push(u);
  return u;
}
afterEach(() => { while (unregs.length) unregs.pop()!(); });

const H = (over: Partial<InteractionHandle>): InteractionHandle => ({
  id: 'x', kind: 'k', editor: 'e', x: 0, y: 0, ...over,
});

describe('interactionHandles registry', () => {
  it('merges handles from every registered provider', () => {
    provide([H({ id: 'a', editor: 'collider2d' })]);
    provide([H({ id: 'b', editor: 'dopesheet' }), H({ id: 'c', editor: 'dopesheet' })]);
    expect(collectHandles().map((h) => h.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('filters by editor, kind, and ids', () => {
    provide([
      H({ id: 'v0', editor: 'collider2d', kind: 'collider-vertex' }),
      H({ id: 'v1', editor: 'collider2d', kind: 'collider-vertex' }),
      H({ id: 'k0', editor: 'dopesheet', kind: 'keyframe' }),
    ]);
    expect(collectHandles({ editor: 'collider2d' }).map((h) => h.id).sort()).toEqual(['v0', 'v1']);
    expect(collectHandles({ kind: 'keyframe' }).map((h) => h.id)).toEqual(['k0']);
    expect(collectHandles({ ids: ['v1', 'k0'] }).map((h) => h.id).sort()).toEqual(['k0', 'v1']);
  });

  it('resolveHandle returns the handle by id or null', () => {
    provide([H({ id: 'bone:root', x: 12, y: 34 })]);
    expect(resolveHandle('bone:root')).toMatchObject({ id: 'bone:root', x: 12, y: 34 });
    expect(resolveHandle('nope')).toBeNull();
  });

  it('skips a provider that throws without losing the others', () => {
    unregs.push(registerHandleProvider(() => { throw new Error('boom'); }));
    provide([H({ id: 'ok' })]);
    expect(collectHandles().map((h) => h.id)).toContain('ok');
  });

  it('unregistering a provider drops its handles', () => {
    const u = provide([H({ id: 'gone' })]);
    expect(resolveHandle('gone')).not.toBeNull();
    u();
    expect(resolveHandle('gone')).toBeNull();
  });

  it('re-warns for the same duplicate handle id after a world swap (#738 group B)', () => {
    // `warnedDuplicates` had NO clear at all in production — a handle id that warned once (two
    // providers both reporting it) stayed silently suppressed for the rest of the session,
    // including a later scene that happens to reuse the same id.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    provide([H({ id: 'dup' })]);
    provide([H({ id: 'dup' })]);
    collectHandles();
    collectHandles();
    expect(err).toHaveBeenCalledTimes(1); // warn-once, not once per poll
    setCurrentWorld(createWorld()); // world swap — should reset the warn-once memory
    collectHandles();
    expect(err).toHaveBeenCalledTimes(2);
    err.mockRestore();
  });
});

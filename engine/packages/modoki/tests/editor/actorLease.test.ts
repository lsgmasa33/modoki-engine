/** Actor lease — provenance for TRUSTED INPUT (editorJournal.ts).
 *
 *  `withEditorActor` can only attribute code the agent CALLS. Trusted input is the opposite
 *  shape: `sendInputEvent` injects real OS-level input and the editor's own handlers run,
 *  deliberately indistinguishable from a human's click. Nothing on that path reaches the
 *  renderer op registry, so every agent tap/keypress journaled as `source:'human'`.
 *
 *  Measured against the live editor 2026-07-22, same session, back to back:
 *    modoki_tap   on a Hierarchy row → !focus + !select  source:"human"   ← agent-driven
 *    modoki_gizmo (a renderer op)    → !gizmo            source:"agent"   ← correct
 *
 *  The lease lets the injector declare itself. What matters most here is the FAILURE
 *  behaviour: a plain flag that sticks would mis-tag the human's whole remaining session,
 *  which is worse than the bug. So the deadline and the id-keying get the most tests. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  editorEmit, readEditorJournal, clearEditorJournal, withEditorActor,
  openActorLease, closeActorLease, _clearActorLease, ACTOR_LEASE_TTL_MS,
} from '../../src/editor/editorJournal';

const sources = () => readEditorJournal().map((e) => e.source);

beforeEach(() => { clearEditorJournal(); _clearActorLease(); });
afterEach(() => { vi.useRealTimers(); _clearActorLease(); });

describe('openActorLease / closeActorLease', () => {
  it('attributes emits to the lease holder until closed', () => {
    editorEmit('!select');
    const id = openActorLease('agent');
    editorEmit('!edit');
    editorEmit('!transform');
    closeActorLease(id);
    editorEmit('!select');
    expect(sources()).toEqual(['human', 'agent', 'agent', 'human']);
  });

  it('EXPIRES on its deadline instead of mis-attributing forever', () => {
    // The whole reason this is a lease and not a flag. If the close never lands — the op
    // threw, the process died, the renderer reloaded mid-flight — a flag would silently
    // relabel every subsequent human action as the agent's, for the rest of the session.
    vi.useFakeTimers();
    openActorLease('agent', 1000); // deliberately never closed
    editorEmit('!edit');
    vi.advanceTimersByTime(999);
    editorEmit('!edit');
    vi.advanceTimersByTime(2);
    editorEmit('!edit'); // past the deadline → back to the human
    expect(sources()).toEqual(['agent', 'agent', 'human']);
  });

  it('a stale close cannot cancel the lease now in flight', () => {
    // Two overlapping input ops: the older one finishing must not strip attribution from
    // the newer one still dispatching. This is the "keyed to the in-flight request" part —
    // a bare boolean cannot express it, and would leave the second op's events as 'human'.
    const first = openActorLease('agent');
    const second = openActorLease('agent');
    closeActorLease(first); // late close from the superseded op
    editorEmit('!edit');
    expect(sources()).toEqual(['agent']);
    closeActorLease(second);
    editorEmit('!edit');
    expect(sources()).toEqual(['agent', 'human']);
  });

  it('closing an unknown id is a no-op, not a reset', () => {
    const id = openActorLease('agent');
    closeActorLease(id + 999);
    editorEmit('!edit');
    expect(sources()).toEqual(['agent']);
  });

  it('a live lease wins over the ambient actor', () => {
    // Precedence is defined rather than incidental: the lease is the narrower, explicitly
    // declared claim. In practice both only ever say 'agent', so this pins the rule before
    // some future caller makes it matter.
    withEditorActor('human', () => {
      const id = openActorLease('agent');
      editorEmit('!edit');
      closeActorLease(id);
    });
    expect(sources()).toEqual(['agent']);
  });

  it('restores the ambient actor after the lease closes, not a hardcoded human', () => {
    withEditorActor('agent', () => {
      const id = openActorLease('agent');
      closeActorLease(id);
      editorEmit('!edit'); // still inside the agent wrapper
    });
    expect(sources()).toEqual(['agent']);
  });

  it('defaults to a TTL long enough for the slowest input op', () => {
    // A 10-step drag is ~180ms of sleeps, and an async drop handler awaits a fetch. Too
    // short a default would expire mid-gesture and split one op across two attributions.
    expect(ACTOR_LEASE_TTL_MS).toBeGreaterThanOrEqual(1000);
  });

  it('expiry is lazy — no timer is left behind to fire after teardown', () => {
    // Deliberately not setTimeout-based: a timer would be a handle to leak, and would keep
    // the process alive in tests. Expiry is decided at emit time by comparing the clock.
    vi.useFakeTimers();
    const before = vi.getTimerCount();
    openActorLease('agent', 50);
    expect(vi.getTimerCount()).toBe(before);
  });
});

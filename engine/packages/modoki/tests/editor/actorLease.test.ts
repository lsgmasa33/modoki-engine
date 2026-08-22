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
  openActorLease, closeActorLease, _clearActorLease, ACTOR_LEASE_TTL_MS, ACTOR_LEASE_GRACE_MS,
} from '../../src/editor/editorJournal';

const sources = () => readEditorJournal().map((e) => e.source);

beforeEach(() => { clearEditorJournal(); _clearActorLease(); });
afterEach(() => { vi.useRealTimers(); _clearActorLease(); });

describe('openActorLease / closeActorLease', () => {
  it('attributes emits to the lease holder until closed, then for a trailing grace window', () => {
    vi.useFakeTimers();
    editorEmit('!select');
    const id = openActorLease('agent');
    editorEmit('!edit');
    editorEmit('!transform');
    closeActorLease(id);
    editorEmit('!select');                              // inside the grace — still the agent
    vi.advanceTimersByTime(ACTOR_LEASE_GRACE_MS + 1);
    editorEmit('!select');                              // past it — back to the human
    expect(sources()).toEqual(['human', 'agent', 'agent', 'agent', 'human']);
  });

  /** QA-SVIEW-0001 / QA-TOOL-0005 / QA-GVIEW-0008 — one race, three reports.
   *
   *  A close means "I have finished SENDING the input", not "the editor has finished
   *  REACTING to it". Synthetic input goes through the browser's input pipeline; the close
   *  arrives as an IPC message on the JS task queue. Nothing orders them, so the journal
   *  event the input CAUSES can land either side of the close.
   *
   *  Measured live (backend 5183, games/anim-bug, 2026-08-18, unattended): two identical
   *  modoki_drag_handle calls on gizmo3d:translate:x, seconds apart. The first journalled
   *  its !transform as source:'human' — 184ms after the same gesture's !focus, which was
   *  correctly 'agent'. The second journalled 'agent'. Same call, opposite answers. */
  it('an emit landing AFTER the close still belongs to the agent (the input-vs-close race)', () => {
    vi.useFakeTimers();
    const id = openActorLease('agent');
    closeActorLease(id);            // the close IPC wins the race…
    vi.advanceTimersByTime(184);    // …by the margin actually measured
    editorEmit('!transform');       // …and the work the input caused lands here
    expect(sources()).toEqual(['agent']);
  });

  it('the grace covers the measured latency with real headroom', () => {
    // Sized off a measurement, not a guess — and equal to undoManager's COALESCE_MS, the
    // editor's other renderer-side deferral window, so there is ONE number to reason about.
    expect(ACTOR_LEASE_GRACE_MS).toBeGreaterThanOrEqual(400);
    // …but far below the TTL backstop, or a failed close would cost as much as no close.
    expect(ACTOR_LEASE_GRACE_MS).toBeLessThan(ACTOR_LEASE_TTL_MS);
  });

  it('the grace never EXTENDS a lease that was already expiring sooner', () => {
    // close() shortens; it must not resurrect. A lease opened with a tiny ttl that has
    // already lapsed stays lapsed.
    vi.useFakeTimers();
    const id = openActorLease('agent', 100);
    vi.advanceTimersByTime(150);    // already past its own deadline
    closeActorLease(id);
    editorEmit('!edit');
    expect(sources()).toEqual(['human']);
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
    vi.useFakeTimers();
    closeActorLease(second);
    vi.advanceTimersByTime(ACTOR_LEASE_GRACE_MS + 1);   // past the trailing grace
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
    vi.useFakeTimers();
    withEditorActor('agent', () => {
      const id = openActorLease('agent');
      closeActorLease(id);
      vi.advanceTimersByTime(ACTOR_LEASE_GRACE_MS + 1); // past the grace, so the lease is gone
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

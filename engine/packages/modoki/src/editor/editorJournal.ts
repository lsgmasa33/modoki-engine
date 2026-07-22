/** Editor Percept (Phase 7) — the human-activity stream. The second SUBJECT of
 *  Percept: the first three primitives perceive the GAME WORLD; this perceives the
 *  EDITOR SESSION — what the human collaborator is doing (selection, edits, gizmo
 *  transforms, entity create/delete, play/stop, undo/redo). So Claude can pair,
 *  correlate human actions with game events, and reproduce hand-demonstrated bugs.
 *
 *  SEPARATE from the game journal (runtime/systems/journal.ts): different lifecycle —
 *  editor-only, session-scoped (not world-scoped), wall-clock stamped, never
 *  production-gated. Provenance sigil `!` = human/editor (vs `@` = engine, bare = game).
 *
 *  This lives in editor/ (NOT runtime/), so it is exempt from the determinism
 *  wall-clock guard and can stamp Date.now(). Events are captured at COMMIT points
 *  (an undo-stack push, a play toggle) — not per-drag-frame — so the stream stays
 *  naturally sparse. */

import { nextCaptureSeq } from '../runtime/systems/journal';

interface EditorEvent {
  /** Editor-local monotonic sequence — the poll cursor (use as `since`). Bumps only
   *  on editor emits, so it stays contiguous within the editor stream. */
  seq: number;
  /** Shared game+editor capture order (Percept V3) — bumps on every journal emit in
   *  EITHER stream, so a merged read interleaves editor + game events on one axis. */
  cap: number;
  /** Wall-clock ms (editor code is not determinism-guarded). */
  ts: number;
  /** `!`-prefixed editor event, e.g. `!edit`, `!select`, `!play`. */
  type: string;
  /** Who performed it — the human at the keyboard, or the AGENT via the MCP ops.
   *  So Claude can tell its own edits from the human's (avoids "I see you deleted 3
   *  crates" about crates Claude itself deleted). */
  source: 'human' | 'agent';
  payload?: unknown;
}

const MAX_EVENTS = 2000; // ring-drop oldest
const buffer: EditorEvent[] = [];
let seq = 0;
let enabled = true;
let actor: 'human' | 'agent' = 'human';

/** Run `fn` with editor activity attributed to `who` — sync OR async. agentEditorOps
 *  wraps its mutating ops in this so agent-driven edits are tagged source:'agent'. For
 *  an async `fn`, the attribution holds until the returned promise settles. NOTE: that
 *  window spans the await, so a human action during it is mis-tagged 'agent' — a narrow,
 *  accepted race (agent ops are brief; a human acting mid-op is rare). */
export function withEditorActor<T>(who: 'human' | 'agent', fn: () => T): T {
  const prev = actor; actor = who;
  const r = fn();
  if (r && typeof (r as { then?: unknown }).then === 'function') {
    return (r as unknown as Promise<unknown>).finally(() => { actor = prev; }) as unknown as T;
  }
  actor = prev;
  return r;
}

// ── Actor lease — attribution for TRUSTED INPUT ──────────────────────────────
//
// `withEditorActor` only works for code the agent CALLS. Trusted input is the opposite
// shape: `sendInputEvent` injects real OS-level input, Chromium hit-tests it, and the
// editor's own handlers run — deliberately indistinguishable from a human's click,
// because that fidelity is the entire point of Enact. Nothing on that path passes
// through the renderer op registry, so `withEditorActor` never wraps it.
//
// Measured 2026-07-22, same session, back to back:
//   modoki_tap   on a Hierarchy row → !focus + !select  source:"human"   ← agent-driven
//   modoki_gizmo (a renderer op)    → !gizmo            source:"agent"   ← correct
// Provenance depended purely on which transport the op happened to use. That defeats the
// point of the split: the human cannot tell their own edits from Claude's, and Claude
// reports the human "did" things Claude did.
//
// So the injector DECLARES itself for the duration: open a lease, dispatch, close it.
//
// WHY A LEASE AND NOT A FLAG. A flag set around an async dispatch is what the plan
// rejected: if the op throws, is killed, or the renderer reloads mid-flight, the flag
// sticks and the human's ENTIRE remaining session is mis-tagged 'agent' — strictly worse
// than the bug being fixed. A lease carries a DEADLINE and is keyed to the in-flight
// request, so the failure mode is bounded (it expires) and a stale close cannot cancel a
// newer op's lease.
//
// WHAT THIS HONESTLY CANNOT DO: while a lease is open the human is still at the keyboard,
// and their click is byte-identical to the agent's. So this converts "100% of agent input
// is mislabeled human" into "agent input is labeled agent; a human action inside a short,
// bounded window is mislabeled agent". Strictly better, not perfect — and the same
// accepted race withEditorActor already documents, with the added safety of a deadline.

interface ActorLease { who: 'human' | 'agent'; deadline: number; id: number }
let lease: ActorLease | null = null;
let leaseSeq = 0;

/** Default lease lifetime. A backstop, not the expected duration — every caller should
 *  close explicitly. Sized above the slowest input op (a 10-step drag is ~180ms, and an
 *  async drop handler awaits a fetch) while staying short enough that a leaked lease
 *  mis-attributes only a moment of the human's work. */
export const ACTOR_LEASE_TTL_MS = 3000;

/** Attribute editor activity to `who` until closed or `ttlMs` elapses. Returns the lease
 *  id to pass to `closeActorLease`. A second open supersedes the first. */
export function openActorLease(who: 'human' | 'agent', ttlMs: number = ACTOR_LEASE_TTL_MS): number {
  lease = { who, deadline: Date.now() + ttlMs, id: ++leaseSeq };
  return lease.id;
}

/** Close a lease. Ignores an id that is not the CURRENT lease, so a late close from a
 *  superseded op cannot cancel the attribution of the one now in flight. */
export function closeActorLease(id: number): void {
  if (lease && lease.id === id) lease = null;
}

/** Test/teardown hook. */
export function _clearActorLease(): void { lease = null; }

/** Who gets credit for an emit right now. A live lease wins over the ambient actor: it is
 *  the narrower, explicitly-declared claim. Expiry is LAZY — checked here rather than by a
 *  timer, so there is no handle to leak and no cleanup to forget. */
function currentActor(): 'human' | 'agent' {
  if (lease) {
    if (Date.now() <= lease.deadline) return lease.who;
    lease = null; // expired — fall back rather than mis-attribute indefinitely
  }
  return actor;
}

/** Record an editor activity event, tagged with the current actor. Payloads should
 *  reference entities by GUID. No-op when disabled. */
export function editorEmit(type: string, payload?: unknown): void {
  if (!enabled) return;
  buffer.push({ seq: ++seq, cap: nextCaptureSeq(), ts: Date.now(), type, source: currentActor(), payload });
  if (buffer.length > MAX_EVENTS) buffer.shift();
}

/** Read the editor-activity stream, optionally filtered by `type`, `source`, and/or
 *  `since` (a prior event's `seq` — returns only newer events). Returns a copy. */
export function readEditorJournal(filter?: { type?: string; source?: 'human' | 'agent'; since?: number }): EditorEvent[] {
  let out: EditorEvent[] = buffer;
  if (filter?.type) out = out.filter((e) => e.type === filter.type);
  if (filter?.source) out = out.filter((e) => e.source === filter.source);
  if (filter?.since != null) out = out.filter((e) => e.seq > filter.since!);
  return out.slice();
}

/** Clear the buffer. */
export function clearEditorJournal(): void { buffer.length = 0; }

/** Enable/disable capture (e.g. to mute during a bulk programmatic operation). */
export function setEditorJournalEnabled(on: boolean): void { enabled = on; }

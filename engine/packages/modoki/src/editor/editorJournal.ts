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

/** Record an editor activity event, tagged with the current actor. Payloads should
 *  reference entities by GUID. No-op when disabled. */
export function editorEmit(type: string, payload?: unknown): void {
  if (!enabled) return;
  buffer.push({ seq: ++seq, cap: nextCaptureSeq(), ts: Date.now(), type, source: actor, payload });
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

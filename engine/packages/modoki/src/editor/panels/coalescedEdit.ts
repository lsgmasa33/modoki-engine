/** Coalesced undo snapshots for fields that commit on EVERY keystroke (#244).
 *
 *  A field that writes its value on every `onChange` has no terminal signal to hang an
 *  undo step off. The obvious idiom — snapshot in `onFocus`, push in `onBlur` — is dead in
 *  an unfocused window: Chromium dispatches `focus`/`blur` only while `document.hasFocus()`,
 *  so with another window on top (the PERMANENT state of an agent-driven MCP session) the
 *  snapshot is never taken, nothing reaches the history, and the next undo silently reverts
 *  whatever came BEFORE the edit. Same class as #233 / #242 (`qa/knowledge.md` §5: nothing
 *  in the editor may depend on a focus event firing), different mechanism.
 *
 *  So: snapshot lazily on the first change since the last commit (`note`, driven from
 *  `onChange`, which always fires), and commit on signals that do not depend on focus —
 *  an idle timer, and an explicit `flush` from every OTHER thing that touches the history.
 *
 *  ⚠️ `note()` must run BEFORE the state mutation it is snapshotting, so `take()` still sees
 *  the pre-edit value — the same ordering the surrounding "snapshot, then mutate" code uses.
 *
 *  ⚠️ `flush()` is not optional politeness: undo/redo MUST flush first, or the pending entry
 *  is still un-pushed when the stack is popped and undo reverts the wrong step. That is the
 *  focus-independent half of #244, reproducible in a perfectly focused window by typing into
 *  a field and pressing ⌘Z without leaving it. */

/** How long a field may sit idle before its edits commit as one undo step. Long enough that
 *  ordinary typing (and a wheel-step burst) stays one entry, short enough that a pause reads
 *  as "done" — the granularity the old focus→blur session had, without the focus.
 *
 *  500 is not a fresh choice: it is the editor's ONE coalescing window, and every other
 *  surface already uses it — `undoManager`'s `coalesceKey` merge, plus the Particle,
 *  Animation, Timeline and SpriteAnim editors, each holding its own `COALESCE_MS = 500`.
 *  A different number here would mean the same pause produces one undo step in one editor
 *  and two in another, for no reason a user could infer. (The literal is duplicated per
 *  module by existing convention rather than imported; matching the VALUE is the part that
 *  matters — if it ever moves, `grep -rn "COALESCE_MS" engine/packages/modoki/src` is the
 *  full set.) */
export const DEFAULT_COALESCE_MS = 500;

export interface CoalescedEdit {
  /** Call from `onChange`, BEFORE mutating state. Snapshots on the first change of a
   *  session and (re)arms the idle timer; a no-op snapshot-wise on later changes. */
  note(): void;
  /** Commit the pending session now, if it changed anything. Idempotent. */
  flush(): void;
  /** Drop the pending session without committing (unmount). */
  cancel(): void;
  /** Is a session open? Test/diagnostic use. */
  pending(): boolean;
}

export function createCoalescedEdit<S>(opts: {
  /** Snapshot the current state. */
  take: () => S;
  /** Are two snapshots equal? A session that changed nothing pushes nothing. */
  same: (a: S, b: S) => boolean;
  /** Push `before` onto the undo stack. */
  push: (before: S) => void;
  /** Idle timeout in ms; 0 disables the timer (flush-only). */
  idleMs?: number;
}): CoalescedEdit {
  const { take, same, push } = opts;
  const idleMs = opts.idleMs ?? DEFAULT_COALESCE_MS;
  let start: S | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clear = () => { if (timer !== null) { clearTimeout(timer); timer = null; } };

  const flush = () => {
    clear(); // tidiness only — a timer left armed here would no-op on `start === null`
    const before = start;
    start = null;
    if (before !== null && !same(before, take())) push(before);
  };

  return {
    note() {
      if (start === null) start = take();
      if (idleMs > 0) { clear(); timer = setTimeout(flush, idleMs); }
    },
    flush,
    cancel() { clear(); start = null; },
    pending() { return start !== null; },
  };
}

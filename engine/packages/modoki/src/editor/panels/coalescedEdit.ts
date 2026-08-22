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

/** E2E-only override of the idle window, and a handle on every OPEN session (#300).
 *
 *  An E2E cannot type fast enough to be sure a run stays inside the window, so it must not
 *  race one: it widens the window past any plausible load and closes the session explicitly.
 *  Why that gives up nothing, and the measurements behind it, are in
 *  `docs/editor-input.md` § "Testing this class: drive the field with no focus events".
 *
 *  ⚠️ The override is read at `note()` time, NOT captured at construction: `SpriteEditor`
 *  builds its session once into a ref, so a value baked at construction could never be
 *  changed by a spec that opens the modal afterwards. */
let overrideMs: number | null = null;
/** The sessions with something pending — joined in `note()`, left in `flush()`/`cancel()`.
 *
 *  ⚠️ Keyed on the SESSION, not on the edit object's lifetime. Registering at construction and
 *  deregistering in `cancel()` looks equivalent and is not: `<StrictMode>` (engine/app/main.tsx)
 *  double-invokes mount effects in dev, so the unmount cleanup's `cancel()` fires once while
 *  the ref — and thus the edit — survives. The session was then unreachable forever and
 *  `flushCoalescedEdits()` silently saw zero. Measured, not reasoned: it cost a green-looking
 *  spec that had quietly stopped flushing. `panels/rendererLease.ts` is the same hazard met a
 *  different way. Following the session also makes the set leak-free by construction: an idle
 *  edit is not a member, so reopening a panel cannot accumulate. */
const live = new Set<CoalescedEdit>();

/** Set (or clear, with `null`) the idle window every coalesced session uses. E2E only —
 *  reached through the DEV-gated editor test bridge, never from editor code. */
export function setCoalesceOverrideMs(ms: number | null): void { overrideMs = ms; }

/** Commit every open session now — the deterministic stand-in for "the user paused long
 *  enough for the idle timer". E2E only, same route as `setCoalesceOverrideMs`. */
export function flushCoalescedEdits(): void { for (const e of [...live]) e.flush(); }

/** How many sessions currently have something pending. Test/diagnostic use — it is the only
 *  observable of the registry's bookkeeping, since a `flush()` on an already-closed session is
 *  a no-op whether or not it is still a member. */
export function pendingCoalescedEditCount(): number { return live.size; }

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
  // Resolved per `note()`, not captured here — see `overrideMs` above. An explicit `idleMs`
  // from the caller still wins, so `idleMs: 0` (flush-only) stays exactly that.
  const idleWindow = () => opts.idleMs ?? overrideMs ?? DEFAULT_COALESCE_MS;
  let start: S | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clear = () => { if (timer !== null) { clearTimeout(timer); timer = null; } };

  const flush = () => {
    clear(); // tidiness only — a timer left armed here would no-op on `start === null`
    const before = start;
    start = null;
    live.delete(edit);
    if (before !== null && !same(before, take())) push(before);
  };

  const edit: CoalescedEdit = {
    note() {
      if (start === null) start = take();
      live.add(edit);
      const idleMs = idleWindow();
      if (idleMs > 0) { clear(); timer = setTimeout(flush, idleMs); }
    },
    flush,
    cancel() { clear(); start = null; live.delete(edit); },
    pending() { return start !== null; },
  };
  return edit;
}

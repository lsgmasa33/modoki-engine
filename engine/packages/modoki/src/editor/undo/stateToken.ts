/** World-state tokens (#1904): one number per state the live world has been in, so "is the world back where it was
 *  saved?" is an equality test. The undo manager mints one for each edit and records it on the entry (the state the
 *  entry leaves); an undo or redo puts the entry's before/after token back, so undoing to the saved state reads clean,
 *  as Unity's does (issue 6559). A leaf module, because both the primary's token (`undoManager.ts`) and the base
 *  scenes' (`scene/sceneDirty.ts`, which the undo manager imports) must come from ONE sequence: a token from one must
 *  never equal an unrelated token from the other.
 *
 *  ⚠️ Not the edit version. `getEditVersion()` stays a monotonic count of changes, because its other readers ask "did
 *  anything happen since" (a drop's witness, Play's snapshot completeness, the Apply dialog's re-plan key, the
 *  timeline preview's authored-edit check) — and edit-then-undo IS something happening. */
let _seq = 0;

/** A token no earlier call returned. */
export function mintStateToken(): number { return ++_seq; }

/** A saved point nothing can reach: a save whose state is unknown, or a scene marked dirty from outside the undo
 *  stack. Dirty until the next save or load. */
export const UNREACHABLE_STATE = -1;

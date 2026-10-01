/** Which Inspector field EDIT SESSION a write belongs to (#1914, the hub's #1922 finding).
 *
 *  An Inspector number field commits on every keystroke (#242), so retyping 200 over a base of 200 writes 2 and 20 first,
 *  each different from the base, and the recorder — which never takes a record off (F3) — kept the record. Unity commits
 *  a typed field once, on Enter/blur, so there a retype records nothing. The field still writes live here; what moves is
 *  the RECORD's boundary: the writes of one session are one gesture, and the gesture records only what its final value
 *  differs in (`entityActions`' `resumeGesture`).
 *
 *  A dynamic scope rather than a parameter: the field calls its `onChange` synchronously, and that reaches the write
 *  through the Inspector's handler unchanged (`write` → `writeTraitFieldMultiWithUndo`), so no signature in between has
 *  to carry it. A write outside any field session (a gizmo, an agent, a scrub) sees null. */
let current: string | null = null;

/** Run `fn` — a field's `onChange` — as part of field session `token` (unique per field instance and session). */
export function inFieldGesture<T>(token: string, fn: () => T): T {
  const prev = current;
  current = token;
  try { return fn(); } finally { current = prev; }
}

/** The field session the write in progress belongs to, or null. */
export function currentFieldGesture(): string | null {
  return current;
}

// HMR: this module owns a REGISTRY that outlives its writers, so it cannot survive a
// module swap. MEASURED failure: after an edit, the new instance's `bindings` Map held 24
// app bindings and ZERO panel bindings, while the window dispatcher kept resolving against
// the OLD instance — two live registries, silent and permanent. `invalidate()` (the
// npr/NPRPostProcess.ts precedent) is NOT enough here: our importers are panel COMPONENTS,
// which are valid Fast Refresh boundaries and would absorb the propagation. Only a hard
// reload is deterministic. Cheap in practice — this file is a stable registry, rarely edited.
// (Editing a PANEL is the common case and does NOT reload: see input/hmrEpoch.ts.)
if (import.meta.hot) import.meta.hot.accept(() => { window.location.reload(); });

/** keymap — the editor's single shortcut registry.
 *
 *  Replaces ~10 ad-hoc window/document keydown listeners that arbitrated by hover
 *  refs, selection-emptiness yields, and capture-phase races. Every shortcut is
 *  declared once here with a SCOPE; one dispatcher resolves a chord against the
 *  focused panel. Contract + measurements: docs/editor-input.md.
 *
 *  THE LOAD-BEARING RULE (measured in P0, plan Appendix A.8 — do not "simplify"):
 *  the renderer sees a key BEFORE the Electron menu, and calling `preventDefault()`
 *  is what SUPPRESSES the menu accelerator. So:
 *    - a chord we CLAIM must preventDefault  → suppresses the menu/native fallback
 *    - a chord we YIELD must NOT preventDefault → lets the menu / native role run
 *  `resolve()` returning null means YIELD. A dispatcher that preventDefaults
 *  unconditionally would silently kill every native role in the editor — text-field
 *  cut/copy/paste, reload, devtools. This is why `when()` returning false must fall
 *  THROUGH to the next candidate rather than swallowing the key.
 *
 *  Pure module: no DOM, no React, no globals beyond the registry itself, so it is
 *  unit-testable by direct calls (the undoManager.ts / panelDock.ts model). */

/** Where a binding is eligible to fire.
 *  - 'app-chord'  — everywhere, INCLUDING text fields (Cmd+S, Cmd+Z, Cmd+P)
 *  - 'app-key'    — everywhere EXCEPT text-editable (bare `f` = frame selected)
 *  - 'overlay'    — only while an overlay owns input; may swallow app-chord
 *  - 'text-field' — only while a text-editable element has focus
 *  - <panelId>    — only while that FlexLayout panel is focused ('scene', 'hierarchy', …)
 */
export type Scope = 'app-chord' | 'app-key' | 'overlay' | 'text-field' | (string & {});

export interface Binding {
  /** Stable command id, '<area>.<verb>' — also the menu/journal/MCP handle. */
  id: string;
  /** Chord, e.g. 'mod+d', 'f', 'mod+shift+z', 'Backspace'. 'mod' = Cmd on mac, Ctrl elsewhere. */
  keys: string;
  scope: Scope;
  /** Guard. False → this binding does NOT claim the chord and resolution falls through
   *  to the next candidate (and ultimately to yield). This is the yield mechanism that
   *  8 existing handlers implement by hand today. */
  when?: () => boolean;
  run: () => void;
  /** Whether claiming this chord should also `preventDefault()`. Default true.
   *
   *  CLAIMING and PREVENTING are separate decisions, and conflating them was a real bug.
   *  An exclusive overlay (the SpriteEditor modal) must ALWAYS claim ⌘Z — otherwise
   *  resolution falls through to the app-scope undo, which edits the scene underneath the
   *  modal and can unmount it mid-edit — while still NOT preventing default when focus is
   *  in one of its own text fields, so the browser's native text-undo survives. Expressing
   *  that as `when` gets it backwards: a false `when` YIELDS, which is precisely the
   *  fall-through we must avoid. */
  preventDefault?: () => boolean;
  /** Overlay bindings only: which overlay instance owns this, so a stack can be honoured. */
  owner?: string;
  /** Menu placement — the menu is a VIEW of this registry, not a parallel table. */
  menu?: { path: string };
}

/** Runtime context a chord is resolved against. Supplied by the dispatcher; kept as a
 *  plain object so resolution is a pure function and testable without a DOM. */
export interface ResolveContext {
  /** Focused FlexLayout panel id, or null when nothing is focused. */
  focusedPanel: string | null;
  /** Top of the overlay stack (a context menu, picker, modal), or null. */
  overlay: string | null;
  /** Is focus in an <input type=text>/<textarea>/contenteditable? NOTE: deliberately
   *  NOT "any form control" — an editor e2e test presses Cmd+Z while a CHECKBOX holds
   *  focus and expects the scene undo. See focusScope.isTextEditable. */
  textEditable: boolean;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');

/** Modifier order is canonicalized so 'shift+mod+z' and 'mod+shift+z' are the same key. */
const MOD_ORDER = ['control', 'alt', 'shift', 'meta'] as const;

/** Normalize a chord string to a canonical lookup key: sorted modifiers + lowercase key.
 *  'mod' resolves per-platform HERE, so the rest of the system compares plain strings. */
export function normalizeChord(keys: string): string {
  // A lone ' ' would be erased by the trim+filter below and silently normalize to the
  // empty chord — matching nothing, with no error. Name it before that can happen.
  if (keys === ' ') return 'space';
  const parts = keys.split('+').map((p) => p.trim().toLowerCase()).filter(Boolean);
  const mods = new Set<string>();
  let key = '';
  for (const p of parts) {
    if (p === 'mod') mods.add(isMac ? 'meta' : 'control');
    else if (p === 'cmd' || p === 'command' || p === 'meta') mods.add('meta');
    else if (p === 'ctrl' || p === 'control') mods.add('control');
    else if (p === 'alt' || p === 'option') mods.add('alt');
    else if (p === 'shift') mods.add('shift');
    else key = normalizeKeyName(p);
  }
  const ordered = MOD_ORDER.filter((m) => mods.has(m));
  return [...ordered, key].join('+');
}

/** Build the canonical chord for a real keyboard event. Matches on the FULL chord —
 *  never on `key` alone, which is what keeps bare `r` from eating Cmd+R (a bug that
 *  was already fixed once by hand in SceneView). */
export function chordFromEvent(e: {
  key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean;
}): string {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push('control');
  if (e.altKey) mods.push('alt');
  if (e.shiftKey) mods.push('shift');
  if (e.metaKey) mods.push('meta');
  const ordered = MOD_ORDER.filter((m) => mods.includes(m));
  return [...ordered, normalizeKeyName(e.key || '')].join('+');
}

/** Space arrives as `e.key === ' '`, which '+'-splitting and trimming would erase
 *  entirely — a binding on it would silently never match. Name it instead. */
function normalizeKeyName(key: string): string {
  const k = key.toLowerCase();
  return k === ' ' || k === 'spacebar' ? 'space' : k;
}

// ── Registry ────────────────────────────────────────────────────────────────

const bindings = new Map<string, Binding>();

export class KeymapConflictError extends Error {}

/** Register a binding. Two bindings may share a chord ONLY across different scopes —
 *  that is the whole point of scoping (Cmd+D in hierarchy AND in animation-editor).
 *  A duplicate chord within ONE scope is a programming error and throws AT
 *  REGISTRATION, instead of being discovered at runtime as a capture-phase race. */
export function register(b: Binding): () => void {
  if (bindings.has(b.id)) throw new KeymapConflictError(`duplicate binding id: ${b.id}`);
  const chord = normalizeChord(b.keys);
  for (const other of bindings.values()) {
    if (other.scope === b.scope && normalizeChord(other.keys) === chord && other.owner === b.owner) {
      throw new KeymapConflictError(
        `chord "${chord}" is already bound in scope "${b.scope}" by "${other.id}" (adding "${b.id}")`,
      );
    }
  }
  bindings.set(b.id, b);
  return () => { bindings.delete(b.id); };
}

export function unregister(id: string): void { bindings.delete(id); }
export function getBindings(): readonly Binding[] { return [...bindings.values()]; }
/** Test/teardown hook — the editor never calls this. */
export function clearBindings(): void { bindings.clear(); }

// ── Resolution ──────────────────────────────────────────────────────────────

/** Scope priority, highest first. An overlay outranks everything (a modal's Escape/Cmd+Z
 *  must beat the app's), then a focused text field, then the focused panel, then the two
 *  app tiers. */
function priority(scope: Scope, ctx: ResolveContext): number {
  if (scope === 'overlay') return ctx.overlay ? 5 : -1;
  if (scope === 'text-field') return ctx.textEditable ? 4 : -1;
  if (scope === 'app-chord') return 1;                       // always eligible
  if (scope === 'app-key') return ctx.textEditable ? -1 : 2; // blocked while typing
  // Panel scope: only the focused panel, and never while typing in a field.
  if (ctx.textEditable) return -1;
  return scope === ctx.focusedPanel ? 3 : -1;
}

/** Resolve a chord to the binding that should run, or null to YIELD.
 *
 *  Null is meaningful: the caller must NOT preventDefault, so the Electron menu item
 *  or the native role handles the chord (docs/editor-input.md). Candidates are tried in scope
 *  priority order and a `when()` that returns false falls through to the next one. */
export function resolve(chord: string, ctx: ResolveContext): Binding | null {
  const norm = normalizeChord(chord);
  const candidates: { b: Binding; p: number }[] = [];
  for (const b of bindings.values()) {
    if (normalizeChord(b.keys) !== norm) continue;
    // An overlay binding belongs to the overlay on TOP of the stack, not any overlay.
    if (b.scope === 'overlay' && b.owner && b.owner !== ctx.overlay) continue;
    const p = priority(b.scope, ctx);
    if (p >= 0) candidates.push({ b, p });
  }
  candidates.sort((a, z) => z.p - a.p);
  for (const { b } of candidates) {
    if (b.when && !b.when()) continue; // yield → try the next scope, then the menu
    return b;
  }
  return null;
}

// ── Display ─────────────────────────────────────────────────────────────────

const GLYPH: Record<string, string> = {
  meta: '⌘', control: '⌃', alt: '⌥', shift: '⇧',
  backspace: '⌫', delete: '⌦', enter: '↵', escape: '⎋', tab: '⇥',
  arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→',
};

/** Human-facing chord label. The exact output is asserted by an existing e2e test
 *  (editor-hierarchy.spec.ts pins 'F2', '⌘D', '⌘C', '⌘X', 'F', '⌫' in the Hierarchy
 *  context menu), so this formatter is a contract, not a preference. */
export function formatChord(keys: string): string {
  const norm = normalizeChord(keys);
  const parts = norm.split('+');
  const key = parts.pop() ?? '';
  const mods = parts.map((m) => GLYPH[m] ?? m).join('');
  const label = GLYPH[key] ?? (key.length === 1 ? key.toUpperCase() : key.replace(/^f(\d+)$/, 'F$1'));
  return mods + label;
}

/** The Assets panel's keyboard decision, as a pure function.
 *
 *  Extracted from `Assets.tsx`'s `handleKeyDown` (#105 Phase 3). It was ~70 lines
 *  entangled with React state setters, refs and `navigator.platform`, so the only
 *  cover it had was e2e. What it decides is not obvious, and three details in
 *  particular were invisible to review and are now pinned by tests:
 *
 *   1. **Delete is platform-dependent.** macOS deletes on Cmd+Backspace; every
 *      other platform on Delete. A bare Backspace must NOT delete on macOS, and
 *      Cmd+Backspace must not delete on Windows/Linux (there it falls through to
 *      type-ahead's printable-key branch being skipped — Backspace is not length-1).
 *   2. **Type-ahead does NOT consume the key.** Every other handled key calls
 *      preventDefault+stopPropagation; the printable-character branch deliberately
 *      does not, so the keystroke still reaches the window-level keymap dispatcher.
 *      Hence `preventDefault` is a separate field from the command, not implied by
 *      "we returned a command".
 *   3. **Shift+Arrow does not move the anchor**, plain Arrow does. Getting this
 *      backwards makes an extended selection collapse on the next Shift+Arrow.
 *
 *  Keys this does not claim return `{kind:'none'}` with `preventDefault:false`, so
 *  they fall through untouched — that is what lets Cmd+Z reach undo.
 *
 *  `isMac` and `now` are parameters rather than reads of `navigator`/`performance`
 *  so the platform split and the 700ms type-ahead window are testable without
 *  stubbing globals. */

import { splitAssetPath, type AssetEntry } from '../utils/assetPaths';

/** How long a type-ahead buffer survives without another keystroke. */
export const TYPE_AHEAD_RESET_MS = 700;

export interface TypeAheadState {
  /** Characters typed so far in the current burst, lowercased. */
  str: string;
  /** Timestamp of the last keystroke, from the same clock passed as `now`. */
  t: number;
}

export type AssetKeyCommand =
  /** Not ours — let it through. */
  | { kind: 'none' }
  /** Consumed deliberately, but there is nothing to do (e.g. Arrow with an empty list). */
  | { kind: 'handled' }
  | { kind: 'new-folder' }
  | { kind: 'clipboard'; op: 'copy' | 'cut' | 'paste' }
  | { kind: 'duplicate' }
  | { kind: 'delete' }
  /** `path` is null when nothing is selected — consumed, but a no-op. */
  | { kind: 'rename'; path: string | null }
  | { kind: 'open'; path: string | null }
  /** A selection/focus move. `paths` ABSENT means leave the selection alone (the
   *  row is still activated and scrolled to); `anchor` ABSENT means leave the
   *  anchor where it is. Both are absent in the stale-anchor case below. */
  | { kind: 'select'; paths?: string[]; activate: string | null; scrollTo: string | null; anchor?: string };

export interface AssetKeyResult {
  command: AssetKeyCommand;
  /** Whether the panel should preventDefault + stopPropagation. See note 2 above. */
  preventDefault: boolean;
  /** The type-ahead buffer to store back. Absent ⇒ unchanged. */
  typeAhead?: TypeAheadState;
}

export interface AssetKeyInput {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** `tagName` of the event target — an inline rename field must keep its keys. */
  targetTag: string;
  isMac: boolean;
  /** Visible paths in on-screen order (see `assetListing.visibleOrder`). */
  order: ReadonlyArray<string>;
  selected: string | null;
  anchor: string | null;
  assets: ReadonlyArray<AssetEntry>;
  typeAhead: TypeAheadState;
  /** Monotonic ms, for the type-ahead window. */
  now: number;
}

const NONE: AssetKeyResult = { command: { kind: 'none' }, preventDefault: false };
const CONSUMED: AssetKeyResult = { command: { kind: 'handled' }, preventDefault: true };
const claim = (command: AssetKeyCommand): AssetKeyResult => ({ command, preventDefault: true });

export function resolveAssetKey(input: AssetKeyInput): AssetKeyResult {
  const { key, shiftKey, altKey, targetTag, isMac, order, selected, anchor, assets } = input;

  // An inline rename field owns its own keys.
  if (targetTag === 'INPUT' || targetTag === 'TEXTAREA') return NONE;

  const mod = isMac ? input.metaKey : input.ctrlKey;
  const lower = key.toLowerCase();

  if (mod && shiftKey && lower === 'n') return claim({ kind: 'new-folder' });
  if (mod && lower === 'a') return claim({ kind: 'select', paths: [...order], activate: null, scrollTo: null });
  if (mod && lower === 'c') return claim({ kind: 'clipboard', op: 'copy' });
  if (mod && lower === 'x') return claim({ kind: 'clipboard', op: 'cut' });
  if (mod && lower === 'v') return claim({ kind: 'clipboard', op: 'paste' });
  if (mod && lower === 'd') return claim({ kind: 'duplicate' });
  if (key === 'F2') return claim({ kind: 'rename', path: selected });

  // See note 1: the delete chord is not the same key on every platform.
  const isDelete = isMac ? (key === 'Backspace' && input.metaKey) : key === 'Delete';
  if (isDelete) return claim({ kind: 'delete' });

  if (key === 'Enter') return claim({ kind: 'open', path: selected });

  if (key === 'ArrowDown' || key === 'ArrowUp') {
    if (order.length === 0) return CONSUMED;
    const idx = selected ? order.indexOf(selected) : -1;
    const ni = key === 'ArrowDown'
      ? (idx < 0 ? 0 : Math.min(order.length - 1, idx + 1))
      : (idx < 0 ? 0 : Math.max(0, idx - 1));
    const np = order[ni];
    if (!assets.some((x) => x.path === np)) return CONSUMED;

    if (shiftKey && anchor) {
      const i0 = order.indexOf(anchor);
      // An anchor that is no longer visible cannot define a range. The row still
      // activates and scrolls into view — it just does not re-select, which is
      // better than collapsing an extended selection to one row behind the user's
      // back. (Preserved from the original: `activate`/`scrollTo` ran on EVERY
      // arrow path, including this one.)
      if (i0 < 0) return claim({ kind: 'select', activate: np, scrollTo: np });
      const [lo, hi] = i0 <= ni ? [i0, ni] : [ni, i0];
      // See note 3: extending a range must NOT move the anchor.
      return claim({ kind: 'select', paths: order.slice(lo, hi + 1), activate: np, scrollTo: np });
    }
    return claim({ kind: 'select', paths: [np], activate: np, scrollTo: np, anchor: np });
  }

  // Type-ahead: jump to the first VISIBLE item whose name starts with the recently
  // typed string. Note 2 — this branch never consumes the key.
  //
  // Gated on BOTH modifiers, not on the platform's `mod`. Using `mod` here meant the
  // WRONG-platform modifier (Ctrl+C on macOS, Cmd+C on Windows) left `mod` false and
  // fell through to type-ahead, silently jumping the selection to the first asset
  // starting with "c" instead of doing nothing. A chord that is not this platform's
  // is not ours: it falls through untouched so the window keymap can have it.
  if (key.length === 1 && !input.ctrlKey && !input.metaKey && !altKey) {
    const stale = input.now - input.typeAhead.t > TYPE_AHEAD_RESET_MS;
    const next: TypeAheadState = { str: (stale ? '' : input.typeAhead.str) + lower, t: input.now };

    const byPath = new Map(assets.map((a) => [a.path, a]));
    const match = order.find((p) => {
      const a = byPath.get(p);
      return !!a && (a.name.toLowerCase().startsWith(next.str) || splitAssetPath(p).base.toLowerCase().startsWith(next.str));
    });

    if (!match) return { command: { kind: 'none' }, preventDefault: false, typeAhead: next };
    return {
      command: { kind: 'select', paths: [match], activate: match, scrollTo: match, anchor: match },
      preventDefault: false,
      typeAhead: next,
    };
  }

  return NONE;
}

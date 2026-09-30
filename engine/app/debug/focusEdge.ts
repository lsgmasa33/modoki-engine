/** The editor's focus-GAIN edge (#1879): when the editor has LOST focus and gets it back, the outside file changes held
 *  meanwhile are applied (Unity's Auto Refresh). Owner, 2026-09-30: "while a human is working on editor the reload
 *  doesn't happen. Editor must lose the focus and gain it again to trigger the reload."
 *
 *  From the DOM's own `blur`/`focus` on the editor window, in both hosts (Electron and a plain browser tab): the editor is
 *  one window, and Chromium fires those on the OS window's activation as well as on a move inside the page.
 *
 *  A `blur` alone is not a loss of focus: one that a `focus` follows at once (a move inside the page) leaves
 *  `document.hasFocus()` true. So a blur counts only when, `SETTLE_MS` later, the document still has no focus. A `focus` then fires {@link FocusEdgeOptions.onGain} once; a `focus` while the editor
 *  counts as focused fires nothing.
 *
 *  The starting state is `hasFocus()` at install. A webview can report false at launch with nothing covering it
 *  (appActivity.ts), which here only means the first real `focus` counts as a gain — the human arriving at an editor an
 *  agent launched, which is a gain.
 *
 *  ⚠️ Never the only way in (docs/editor-input.md #233: "never make a commit depend on a focus EVENT"). An agent-driven
 *  editor may never be OS-focused, so `modoki_refresh` applies the same queue on demand. */

export interface FocusEdgeOptions {
  hasFocus: () => boolean;
  /** Runs `fn` after `ms`; returns a cancel. Injectable so a test drives the settle without a clock. */
  schedule: (fn: () => void, ms: number) => () => void;
  onGain: () => void;
}

/** How long after a `blur` the document must still be unfocused for it to count as a loss. Long enough for the `focus`
 *  of a move inside the page to land; short against a human switching apps. */
export const SETTLE_MS = 100;

export interface FocusEdge {
  blur(): void;
  focus(): void;
  /** Whether a human has the editor focused NOW: what decides a countdown before a refresh. Read live, not from the
   *  edge's state, which a launch without a focus event leaves false while the window is in front (review U5). */
  isFocused(): boolean;
}

export function createFocusEdge(opts: FocusEdgeOptions): FocusEdge {
  let focused = opts.hasFocus();
  let cancelSettle: (() => void) | null = null;
  return {
    blur() {
      cancelSettle?.();
      cancelSettle = opts.schedule(() => {
        cancelSettle = null;
        if (!opts.hasFocus()) focused = false;
      }, SETTLE_MS);
    },
    focus() {
      cancelSettle?.();
      cancelSettle = null;
      if (focused) return;
      focused = true;
      opts.onGain();
    },
    isFocused: () => opts.hasFocus(),
  };
}

/** Install on the page's own window. Returns the edge (for `isFocused`) and the uninstall. */
export function installFocusEdge(onGain: () => void, win: Window = window, doc: Document = document): FocusEdge & { uninstall: () => void } {
  const edge = createFocusEdge({
    hasFocus: () => doc.hasFocus(),
    schedule: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); },
    onGain,
  });
  const onBlur = () => edge.blur();
  const onFocus = () => edge.focus();
  win.addEventListener('blur', onBlur);
  win.addEventListener('focus', onFocus);
  return { ...edge, uninstall: () => { win.removeEventListener('blur', onBlur); win.removeEventListener('focus', onFocus); } };
}

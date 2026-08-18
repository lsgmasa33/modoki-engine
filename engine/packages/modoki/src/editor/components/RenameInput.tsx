import React, { useCallback, useRef } from 'react';

/** Inline rename text field used by the Hierarchy + Assets panels.
 *  Commits on Enter / blur (click-away), cancels on Escape. Commit fires at
 *  most once — the keydown/blur race that would otherwise double-fire is
 *  guarded by `doneRef`. The field selects its contents when it mounts so the
 *  user can immediately type over the old name.
 *
 *  ⚠️ NOTHING HERE MAY DEPEND ON A FOCUS EVENT FIRING, and both of the things that
 *  did were broken (QA-ASSET-0004). Chromium dispatches `focus`/`blur` only while
 *  the document HAS OS focus: with `document.hasFocus() === false` — the editor
 *  window behind another window, or any agent-driven session, which never brings
 *  it to the front — `el.focus()`/`el.blur()` still move `document.activeElement`
 *  but fire NO events. Measured live on 2026-08-18 (backend 5183, games/anim-bug):
 *  Enter's keydown arrived, `blur()` moved activeElement to BODY, and React's
 *  `onBlur` never ran once. So:
 *    - Enter COMMITS DIRECTLY. It used to call `blur()` and rely on `onBlur` to do
 *      the work, which meant the rename silently did nothing and left the field
 *      mounted forever — immune to Enter, Escape, blur and click-away alike,
 *      recoverable only by relaunching the editor.
 *    - The initial select happens in a REF CALLBACK, not `autoFocus` + `onFocus`,
 *      for the same reason: the field was focused with nothing selected, so typing
 *      APPENDED to the old name instead of replacing it.
 *  `onBlur` still commits — that is the click-away path, and it works whenever the
 *  window is focused, which is when a human clicks away. */
export default function RenameInput({ initial, onCommit, onCancel, style }: {
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
  style?: React.CSSProperties;
}) {
  const doneRef = useRef(false);

  const commit = (raw: string) => {
    if (doneRef.current) return;
    doneRef.current = true;
    const value = raw.trim();
    if (value && value !== initial) onCommit(value);
    else onCancel();
  };

  /** Focus + select on mount, imperatively. `autoFocus` + `onFocus={select}` looks
   *  equivalent and is not — see the focus-event caveat in the module doc. */
  const mount = useCallback((el: HTMLInputElement | null) => {
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  return (
    <input
      ref={mount}
      defaultValue={initial}
      spellCheck={false}
      // Stop the row's click/drag/select handlers from hijacking the field.
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        // Both act DIRECTLY. Neither may route through blur() — see the module doc.
        if (e.key === 'Enter') { e.preventDefault(); commit(e.currentTarget.value); }
        else if (e.key === 'Escape') { e.preventDefault(); doneRef.current = true; onCancel(); }
      }}
      onBlur={(e) => commit(e.currentTarget.value)}
      style={{
        flex: 1, minWidth: 0, font: 'inherit', color: '#fff', background: '#1a1a2e',
        border: '1px solid #f1c40f', borderRadius: 2, padding: '0 3px', outline: 'none',
        ...style,
      }}
    />
  );
}

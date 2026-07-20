import React, { useRef } from 'react';

/** Inline rename text field used by the Hierarchy + Assets panels.
 *  Commits on Enter / blur (click-away), cancels on Escape. Commit fires at
 *  most once — the keydown/blur race that would otherwise double-fire is
 *  guarded by `doneRef`. The field auto-selects its contents on focus so the
 *  user can immediately type over the old name. */
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

  return (
    <input
      autoFocus
      defaultValue={initial}
      spellCheck={false}
      onFocus={(e) => e.currentTarget.select()}
      // Stop the row's click/drag/select handlers from hijacking the field.
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
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

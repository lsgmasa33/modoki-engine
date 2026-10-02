/** An asset view's import-settings block, disabled WITH its reason when `lock` is non-null (#2060).
 *
 *  A `<fieldset disabled>` rather than a `disabled` threaded into every control: the browser disables every form control
 *  inside it — the Font view alone has a dozen selects, axis rows and a custom-charset box — so a control added to a
 *  view later is covered without anyone remembering to wire it. The reason is stated on screen, not only in a tooltip:
 *  a greyed control with no explanation reads as a broken editor. The decision is `builtinImportLock.ts`'s. */
import type { ReactNode } from 'react';

export function ImportLockFieldset({ lock, children }: { lock: string | null; children: ReactNode }) {
  return (
    <>
      {lock !== null && (
        <div data-ui-id="assetView.importLocked" style={{ color: '#e6a23c', fontSize: 10, margin: '6px 0 2px' }}>{lock}</div>
      )}
      <fieldset
        disabled={lock !== null}
        title={lock ?? undefined}
        style={{ border: 0, padding: 0, margin: 0, minWidth: 0, opacity: lock !== null ? 0.5 : 1 }}
      >
        {children}
      </fieldset>
    </>
  );
}

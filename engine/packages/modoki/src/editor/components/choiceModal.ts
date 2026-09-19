/** A plain-DOM choice dialog with N buttons, in the editor's modal shell (#1270), so the editor
 *  underneath takes no key and no menu command while it waits.
 *
 *  Plain DOM rather than React for the same reason `utils/saveDialog.ts`'s confirm is: its callers
 *  are plain `.ts` modules (the unsaved-work gate runs from an Assets double-click, a prefab exit
 *  and an Electron close request alike), and a dialog they can `await` needs no component tree to
 *  mount into. `window.confirm` is not an option in the Electron renderer.
 *
 *  Resolves the chosen `value`; Escape and a backdrop click resolve `cancelValue`. The button named
 *  by `focus` takes focus on open, so Enter answers with THAT choice — a caller whose choices include
 *  a destructive one focuses the safe one, so destroying work takes a deliberate click. */

import { openDomModalShell } from './modalBackdrop';

export interface ModalChoice<T extends string> {
  value: T;
  label: string;
  /** Visual weight only. `danger` for a choice that destroys work. */
  tone?: 'primary' | 'danger' | 'neutral';
}

export interface ChoiceModalOptions<T extends string> {
  /** Overlay-stack kind, also stamped as `data-ui-id` on the dialog box (buttons get `<kind>.<value>`),
   *  so an e2e spec or an agent aims by NAME. */
  kind: string;
  title: string;
  message: string;
  /** Optional bullet lines under the message. */
  details?: string[];
  choices: ModalChoice<T>[];
  cancelValue: T;
  focus: T;
}

const TONE_STYLE: Record<NonNullable<ModalChoice<string>['tone']>, string> = {
  primary: 'border:1px solid #3a6;background:#244;color:#cfc',
  danger: 'border:1px solid #a44;background:#3a1f24;color:#fcc',
  neutral: 'border:1px solid #555;background:#2a2a40;color:#ccc',
};

export function openChoiceModal<T extends string>(opts: ChoiceModalOptions<T>): Promise<T> {
  return new Promise((resolve) => {
    // Above every React dialog, like the save dialog: a gate can be asked from inside one.
    const { root: overlay, close } = openDomModalShell(opts.kind, { zIndex: 99999, onDismiss: () => done(opts.cancelValue) });
    const box = document.createElement('div');
    box.dataset.uiId = opts.kind;
    box.setAttribute('role', 'alertdialog');
    box.style.cssText = 'background:#1e1e30;border:1px solid #555;border-radius:6px;padding:16px 20px;min-width:380px;max-width:560px;font-family:monospace';
    const heading = document.createElement('div');
    heading.textContent = opts.title;
    heading.style.cssText = 'color:#fff;font-size:13px;margin-bottom:8px';
    const label = document.createElement('div');
    label.textContent = opts.message;
    label.style.cssText = 'color:#9a9aa8;font-size:11px;margin-bottom:8px';
    box.append(heading, label);
    if (opts.details?.length) {
      const list = document.createElement('ul');
      list.style.cssText = 'color:#ddd;font-size:11px;margin:0 0 8px;padding-left:18px';
      for (const d of opts.details) {
        const li = document.createElement('li');
        li.textContent = d;
        list.append(li);
      }
      box.append(list);
    }
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px';
    const buttons = new Map<T, HTMLButtonElement>();
    for (const c of opts.choices) {
      const b = document.createElement('button');
      b.textContent = c.label;
      b.dataset.uiId = `${opts.kind}.${c.value}`;
      b.style.cssText = `padding:4px 16px;border-radius:3px;cursor:pointer;font-family:monospace;font-size:11px;${TONE_STYLE[c.tone ?? 'neutral']}`;
      b.onclick = () => done(c.value);
      buttons.set(c.value, b);
      row.append(b);
    }
    box.append(row);
    overlay.append(box);

    let settled = false;
    const done = (val: T) => {
      if (settled) return;
      settled = true;
      close();
      resolve(val);
    };
    // On the OVERLAY, not the document — see saveDialog.ts's `openModal` (keymapOwnership).
    overlay.onkeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); done(opts.cancelValue); }
    };
    setTimeout(() => buttons.get(opts.focus)?.focus(), 0);
  });
}

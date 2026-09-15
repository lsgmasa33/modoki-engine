/** An open editor modal is NAMED when it is why an agent's menu click or key press did nothing (#1270). */

import { describe, it, expect } from 'vitest';
import { explainMenuRefusal, modalKeyWarning, MODAL_CAUSE } from '../../electron/modalRefusal';
import { triggerMenuItem, type MenuItemLike } from '../../electron/menuActions';

describe('explainMenuRefusal', () => {
  const menu: MenuItemLike[] = [{ label: 'File', submenu: { items: [{ label: 'Save All', enabled: false, click: () => {} }, { label: 'Gone', enabled: true }] } }];

  it('a greyed item under a modal names the modal — against the real triggerMenuItem wording', () => {
    const res = explainMenuRefusal(triggerMenuItem(menu, { path: 'File/Save All' }), true);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('"Save All" is disabled');
    expect(res.error).toContain(MODAL_CAUSE);
  });

  it('says nothing about a modal when none is open, or when the refusal is not a greyed item', () => {
    expect(explainMenuRefusal(triggerMenuItem(menu, { path: 'File/Save All' }), false).error).not.toContain(MODAL_CAUSE);
    expect(explainMenuRefusal(triggerMenuItem(menu, { path: 'File/Nope' }), true).error).not.toContain(MODAL_CAUSE);
    expect(explainMenuRefusal({ ok: true }, true)).toEqual({ ok: true });
  });
});

describe('modalKeyWarning', () => {
  it('warns for a press under a modal that no binding claimed', () => {
    expect(modalKeyWarning({ modalOpen: true, editorBinding: null })).toContain(MODAL_CAUSE);
  });

  it('is silent when the modal\'s own binding took the key, when no modal is open, or with no probe', () => {
    expect(modalKeyWarning({ modalOpen: true, editorBinding: 'spriteEditor.undo' })).toBeNull();
    expect(modalKeyWarning({ modalOpen: false, editorBinding: null })).toBeNull();
    expect(modalKeyWarning(null)).toBeNull();
  });
});

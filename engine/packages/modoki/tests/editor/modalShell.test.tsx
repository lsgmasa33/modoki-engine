// @vitest-environment jsdom
/** The editor's one modal shell, both forms (#1270): `ModalShell` (React) and `openDomModalShell`
 *  (plain DOM, for saveDialog). What they share, and what these pin against the REAL overlay stack:
 *  a shell that is showing is a MODAL on the stack, a shell that is gone is not, and the backdrop
 *  dismiss fires only for a press that starts and ends on the scrim. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';

const { ModalShell } = await import('../../src/editor/components/ModalShell');
const { openDomModalShell, scrimDismissHandlers, holdFocus } = await import('../../src/editor/components/modalBackdrop');
const { clearOverlays, isModalOpen, overlayDepth, topOverlay } = await import('../../src/editor/input/focusScope');

beforeEach(() => { clearOverlays(); document.body.innerHTML = ''; });
afterEach(() => { cleanup(); clearOverlays(); });

describe('ModalShell (React)', () => {
  it('is a modal on the stack while mounted, and gone when unmounted', () => {
    const { unmount } = render(<ModalShell kind="dlg"><button>inside</button></ModalShell>);
    expect(isModalOpen()).toBe(true);
    unmount();
    expect(isModalOpen()).toBe(false);
    expect(overlayDepth()).toBe(0);
  });

  it('uses the caller\'s `id` as the overlay id — the owner SpriteEditor\'s ⌘Z bindings name', () => {
    render(<ModalShell kind="sprite-editor" id="sprite-editor:r1"><div /></ModalShell>);
    expect(topOverlay()).toBe('sprite-editor:r1');
  });

  it('a press on the scrim dismisses; a click inside does not; no onDismiss means no dismiss', () => {
    const onDismiss = vi.fn();
    const { getByText, rerender } = render(<ModalShell kind="dlg" onDismiss={onDismiss}><button>inside</button></ModalShell>);
    const scrim = document.querySelector(`[data-modal-shell="dlg"]`) as HTMLElement;
    fireEvent.mouseDown(getByText('inside')); fireEvent.click(getByText('inside'));
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.mouseDown(scrim); fireEvent.click(scrim);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    rerender(<ModalShell kind="dlg" onDismiss={undefined}><button>inside</button></ModalShell>);
    fireEvent.mouseDown(scrim); fireEvent.click(scrim);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('renders into document.body even when mounted inside a hidden panel — a modal nobody can see must not block', () => {
    const hiddenTab = document.createElement('div');
    hiddenTab.style.display = 'none';
    document.body.append(hiddenTab);
    render(<ModalShell kind="sprite-editor"><button>Cancel</button></ModalShell>, { container: hiddenTab });
    const scrim = document.querySelector('[data-modal-shell="sprite-editor"]')!;
    expect(scrim.parentElement).toBe(document.body);
    expect(hiddenTab.contains(scrim)).toBe(false);
  });

  it('takes focus from the element under it, and gives it back on close', () => {
    // The Assets list keeps focus after a click and handles ⌘⌫ itself — under a dialog that did not
    // take focus, ⌘⌫ trashed the selected asset (#1270 review).
    const list = document.createElement('div');
    list.tabIndex = 0;
    document.body.append(list);
    list.focus();
    const { unmount } = render(<ModalShell kind="dlg"><button>x</button></ModalShell>);
    expect(document.activeElement?.getAttribute('data-modal-shell')).toBe('dlg');
    unmount();
    expect(document.activeElement).toBe(list);
  });

  it('leaves focus where a dialog\'s own autoFocus put it', () => {
    const { getByRole } = render(<ModalShell kind="dlg"><input autoFocus aria-label="name" /></ModalShell>);
    expect(document.activeElement).toBe(getByRole('textbox'));
  });

  it('does NOT take focus from a half-typed text field — a progress modal must not commit it on blur', () => {
    // ImportProgress/SceneLoad/BuildProgress mount with no user gesture, and several editor fields
    // commit on blur (the Skin Editor's bone name). Stealing focus would commit a half-typed value at
    // a moment nobody chose. A focused field already swallows the keys the block exists to intercept.
    const field = document.createElement('input');
    field.type = 'text';
    document.body.append(field);
    field.focus();
    render(<ModalShell kind="import-progress"><div>Importing…</div></ModalShell>);
    expect(document.activeElement).toBe(field);
  });

  it('gives focus back even when the dialog autoFocused its own field', () => {
    const before = document.createElement('button');
    document.body.append(before);
    before.focus();
    const { unmount } = render(<ModalShell kind="dlg"><input autoFocus aria-label="name" /></ModalShell>);
    unmount();
    expect(document.activeElement).toBe(before);
  });

  it('unblocks BEFORE it returns focus — the element it returns to never gets a live window under the modal', () => {
    // The Assets list handles ⌘⌫ itself, outside the keymap. Handing focus back while the modal was
    // still on the stack would reopen exactly the hole this shell closes.
    const list = document.createElement('div');
    list.tabIndex = 0;
    document.body.append(list);
    list.focus();
    let modalAtRefocus: boolean | null = null;
    list.addEventListener('focus', () => { modalAtRefocus = isModalOpen(); });
    const { unmount } = render(<ModalShell kind="dlg"><button>x</button></ModalShell>);
    unmount();
    expect(document.activeElement).toBe(list);
    expect(modalAtRefocus).toBe(false);
  });

  it('a drag that starts INSIDE and is released over the scrim does not dismiss (the Project Settings drag-select)', () => {
    const onDismiss = vi.fn();
    const { getByText } = render(<ModalShell kind="dlg" onDismiss={onDismiss}><input defaultValue="name" /><span>x</span></ModalShell>);
    const scrim = document.querySelector(`[data-modal-shell="dlg"]`) as HTMLElement;
    fireEvent.mouseDown(getByText('x'));
    fireEvent.click(scrim);                       // the click lands on the common ancestor: the scrim
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

describe('openDomModalShell (plain DOM)', () => {
  it('is a modal while open; close() removes the backdrop AND the entry, and is safe twice', () => {
    const shell = openDomModalShell('save-dialog');
    expect(document.body.contains(shell.root)).toBe(true);
    expect(isModalOpen()).toBe(true);
    shell.close();
    shell.close();
    expect(document.body.contains(shell.root)).toBe(false);
    expect(isModalOpen()).toBe(false);
  });

  it('two open at once are two entries — closing one leaves the other blocking', () => {
    const a = openDomModalShell('save-dialog');
    const b = openDomModalShell('save-dialog');
    a.close();
    expect(isModalOpen()).toBe(true);
    b.close();
    expect(isModalOpen()).toBe(false);
  });

  it('dismisses on a scrim press only', () => {
    const onDismiss = vi.fn();
    const { root } = openDomModalShell('save-dialog', { onDismiss });
    const inner = document.createElement('div');
    root.append(inner);
    inner.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); inner.click();
    inner.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); root.click();
    expect(onDismiss).not.toHaveBeenCalled();
    root.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); root.click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe('holdFocus', () => {
  it('does not restore over a focus the user has since moved elsewhere', () => {
    const before = document.createElement('button'); const root = document.createElement('div'); const later = document.createElement('button');
    root.tabIndex = -1;
    document.body.append(before, root, later);
    before.focus();
    const restore = holdFocus(root);
    expect(document.activeElement).toBe(root);
    later.focus();
    restore();
    expect(document.activeElement).toBe(later);
  });

  it('the DOM shell takes focus too, and returns it when closed', () => {
    const before = document.createElement('button');
    document.body.append(before);
    before.focus();
    const shell = openDomModalShell('save-dialog');
    expect(document.activeElement).toBe(shell.root);
    shell.close();
    expect(document.activeElement).toBe(before);
  });
});

describe('scrimDismissHandlers', () => {
  it('forgets a scrim press once its click is consumed — a later click alone does not dismiss', () => {
    const onDismiss = vi.fn();
    const h = scrimDismissHandlers(onDismiss);
    const scrim = {};
    h.onMouseDown({ target: scrim, currentTarget: scrim });
    h.onClick({ target: scrim, currentTarget: scrim });
    h.onClick({ target: scrim, currentTarget: scrim });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

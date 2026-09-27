// @vitest-environment jsdom
/** #1470 — the editor's plain-DOM prompt/confirm shell (`utils/saveDialog.ts` `openModal`) names its
 *  box and both buttons, so an agent aims by NAME instead of `modoki_eval` + a text match. Every
 *  prompt and confirm goes through the one shell, so the ids are asserted through the public entry
 *  points, and each id is asserted by CLICKING it: an id on the wrong button would pass a
 *  presence-only check and invert a destructive confirm for whoever aims at it. */
import { describe, it, expect, afterEach } from 'vitest';
import { alertInEditor, confirmInEditor, confirmReplaceAsset } from '../../packages/modoki/src/editor/utils/saveDialog';
import { describeTopModal } from '../../app/debug/modalShells';
import { clearOverlays } from '../../packages/modoki/src/editor/input/focusScope';

const aim = (id: string) => document.querySelector<HTMLElement>(`[data-ui-id="${id}"]`);

afterEach(() => {
  document.body.innerHTML = '';
  clearOverlays();
});

describe('save-dialog shell ids (#1470)', () => {
  it('the box carries the shell kind, and the confirm button resolves the question YES', async () => {
    const answer = confirmInEditor('Move into another scene?', 'body', 'Move');
    expect(aim('save-dialog')?.textContent).toContain('Move into another scene?');
    const ok = aim('save-dialog.confirm');
    expect(ok?.textContent).toBe('Move');
    ok!.click();
    await expect(answer).resolves.toBe(true);
    expect(aim('save-dialog')).toBeNull(); // closed, not left behind
  });

  it('the cancel button resolves the question NO', async () => {
    const answer = confirmReplaceAsset('/assets/rock.mat.json');
    const cancel = aim('save-dialog.cancel');
    expect(cancel?.textContent).toBe('Cancel');
    cancel!.click();
    await expect(answer).resolves.toBe(false);
  });

  it('a confirm has no input; there is nothing named `.input` to aim at', async () => {
    const answer = confirmInEditor('t', 'm', 'OK');
    expect(aim('save-dialog.input')).toBeNull();
    aim('save-dialog.cancel')!.click();
    await answer;
  });

  it('a notice (alertInEditor, #1594) names ONE button, confirm, and resolves when it is clicked', async () => {
    let settled = false;
    const done = alertInEditor('File chooser failed', 'boom').then(() => { settled = true; });
    expect(aim('save-dialog')?.textContent).toContain('boom');
    expect(aim('save-dialog.cancel')).toBeNull();
    await Promise.resolve();
    expect(settled).toBe(false); // waits on the human, like the alert it replaces
    aim('save-dialog.confirm')!.click();
    await done;
    expect(aim('save-dialog')).toBeNull();
  });
});

describe('get_editor_state.modal reads the open shell (#1594)', () => {
  it('none open → null; a confirm → its kind and both named buttons', async () => {
    expect(describeTopModal()).toBeNull();
    const answer = confirmInEditor('Auto-rig?', 'm', 'Auto-rig');
    expect(describeTopModal()).toEqual({ kind: 'save-dialog', controls: ['save-dialog.cancel', 'save-dialog.confirm'], controlCount: 2 });
    aim('save-dialog.cancel')!.click();
    await answer;
    expect(describeTopModal()).toBeNull();
  });

  it('two stacked → the TOP-most one, the one that takes input', async () => {
    const under = document.createElement('div');
    under.dataset.modalShell = 'under';
    under.innerHTML = '<button data-ui-id="under.ok"></button>';
    document.body.append(under);
    const notice = alertInEditor('t', 'm');
    expect(describeTopModal()).toEqual({ kind: 'save-dialog', controls: ['save-dialog.confirm'], controlCount: 1 });
    aim('save-dialog.confirm')!.click();
    await notice;
    expect(describeTopModal()?.kind).toBe('under');
  });
});

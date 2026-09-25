// @vitest-environment jsdom
/** #1470 — the editor's plain-DOM prompt/confirm shell (`utils/saveDialog.ts` `openModal`) names its
 *  box and both buttons, so an agent aims by NAME instead of `modoki_eval` + a text match. Every
 *  prompt and confirm goes through the one shell, so the ids are asserted through the public entry
 *  points, and each id is asserted by CLICKING it: an id on the wrong button would pass a
 *  presence-only check and invert a destructive confirm for whoever aims at it. */
import { describe, it, expect, afterEach } from 'vitest';
import { confirmInEditor, confirmReplaceAsset } from '../../packages/modoki/src/editor/utils/saveDialog';
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
});

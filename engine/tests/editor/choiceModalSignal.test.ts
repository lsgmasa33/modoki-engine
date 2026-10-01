// @vitest-environment jsdom
/** `openChoiceModal`'s `signal` (#1924): a dialog whose question went moot is closed from code. The "Reload / Keep mine"
 *  scene-conflict dialog uses it once a load has applied the change it asks about; before, nothing could close it but a
 *  click, so it stayed up claiming unsaved changes on a clean scene. */
import { describe, it, expect, afterEach } from 'vitest';
import { openChoiceModal } from '../../packages/modoki/src/editor/components/choiceModal';
import { clearOverlays } from '../../packages/modoki/src/editor/input/focusScope';

const open = (signal?: AbortSignal) => openChoiceModal<'a' | 'b' | 'later'>({
  kind: 'moot-test', title: 't', message: 'm', cancelValue: 'later', focus: 'a', signal,
  choices: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
});
const shown = () => document.querySelector('[data-modal-shell="moot-test"]') !== null;

afterEach(() => {
  document.body.innerHTML = '';
  clearOverlays();
});

describe('openChoiceModal signal (#1924)', () => {
  it('an abort closes the dialog and resolves the cancel value', async () => {
    const ctl = new AbortController();
    const answer = open(ctl.signal);
    expect(shown(), 'up').toBe(true);
    ctl.abort();
    expect(shown(), 'closed at once').toBe(false);
    await expect(answer).resolves.toBe('later');
  });

  it('a signal aborted before the dialog opens never leaves it up', async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(open(ctl.signal)).resolves.toBe('later');
    expect(shown()).toBe(false);
  });

  it('a click answers as before, and a later abort changes nothing', async () => {
    const ctl = new AbortController();
    const answer = open(ctl.signal);
    (document.querySelector('[data-ui-id="moot-test.b"]') as HTMLButtonElement).click();
    ctl.abort();
    await expect(answer).resolves.toBe('b');
    expect(shown()).toBe(false);
  });
});

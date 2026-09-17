// @vitest-environment jsdom
/** The iOS text-interaction toggle (#1360) — `engine/app/installTextInteractionToggle.ts`.
 *
 *  The native side disables the web view's text interaction to kill the double-tap selection
 *  magnifier over the game. Measured on an iPad (iOS 26.6.2): that ALSO stops any character being
 *  entered into an `<input>`, while still focusing it and still opening the keyboard — so every
 *  text field in the shipped debug overlay went dead, silently. This module puts the preference
 *  back while a text field is focused.
 *
 *  What these tests are really defending is the pair of asymmetries that make it correct:
 *  a text field must re-enable but a RANGE slider must not (sliders were measured working with
 *  interaction off, and re-enabling for a drag would put the magnifier back), and tabbing between
 *  two fields must not flicker the preference off and on. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installTextInteractionToggle } from '../../app/textInteractionToggle';

interface Posted { body: unknown }

let dispose: (() => void) | undefined;

/** Install a fake WKWebView message handler and install the toggle against it.
 *
 *  ⚠️ Deliberately NOT `vi.resetModules()` + re-import. That leaves the PREVIOUS instance's
 *  document listeners attached to jsdom's persistent document, so two installs both post on every
 *  focus change — this test read `[true, false, false]` before the module grew a disposer, and the
 *  duplicate looked like a bug in the debounce rather than in the test. */
function install(handlerPresent: boolean): Posted[] {
  const posted: Posted[] = [];
  if (handlerPresent) {
    (window as unknown as Record<string, unknown>).webkit = {
      messageHandlers: { modokiTextInteraction: { postMessage: (body: unknown) => posted.push({ body }) } },
    };
  } else {
    delete (window as unknown as Record<string, unknown>).webkit;
  }
  dispose = installTextInteractionToggle();
  return posted;
}

function focusIn(el: Element): void {
  el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
}
function focusOut(el: Element): void {
  el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
}

describe('iOS text-interaction toggle (#1360)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
  });
  afterEach(() => {
    dispose?.();
    dispose = undefined;
    vi.useRealTimers();
    delete (window as unknown as Record<string, unknown>).webkit;
  });

  it('turns text interaction ON when a text field is focused', () => {
    const posted = install(true);
    const input = document.createElement('input');
    input.type = 'text';
    document.body.append(input);

    focusIn(input);
    expect(posted.map((p) => p.body)).toEqual([true]);
  });

  it('turns it OFF again once focus has actually left every text field', () => {
    const posted = install(true);
    const input = document.createElement('input');
    input.type = 'text';
    document.body.append(input);

    focusIn(input);
    focusOut(input);
    // Deferred by one task on purpose — see the tabbing case below.
    expect(posted.map((p) => p.body), 'not yet: focusout fires BEFORE the next focusin').toEqual([true]);
    vi.runAllTimers();
    expect(posted.map((p) => p.body)).toEqual([true, false]);
  });

  it('does NOT flicker when tabbing between two text fields', () => {
    const posted = install(true);
    const a = document.createElement('input'); a.type = 'text';
    const b = document.createElement('input'); b.type = 'text';
    document.body.append(a, b);

    focusIn(a);
    focusOut(a);
    focusIn(b);
    b.focus(); // so document.activeElement is b when the deferred check runs
    vi.runAllTimers();

    // One enable, and NO disable in between: each postMessage crosses into native and mutates a
    // live WKPreferences, so an off/on pair here is a real (and visible) round trip.
    expect(posted.map((p) => p.body)).toEqual([true]);
  });

  it('ignores a RANGE slider — re-enabling for a drag would put the magnifier back', () => {
    const posted = install(true);
    const slider = document.createElement('input');
    slider.type = 'range';
    document.body.append(slider);

    focusIn(slider);
    vi.runAllTimers();
    // Measured on device: sliders work with text interaction OFF, so there is nothing to fix here
    // and turning it on would cost the very thing the feature exists to prevent.
    expect(posted).toEqual([]);
  });

  it('treats textarea and contenteditable as text', () => {
    const posted = install(true);
    const ta = document.createElement('textarea');
    document.body.append(ta);
    focusIn(ta);
    expect(posted.map((p) => p.body)).toEqual([true]);

    const ce = document.createElement('div');
    ce.setAttribute('contenteditable', 'true');
    document.body.append(ce);
    // jsdom does not implement isContentEditable; assert the attribute path is at least reachable
    // without throwing rather than faking the property.
    expect(() => focusIn(ce)).not.toThrow();
  });

  it('is an inert no-op with no native handler — Android, desktop, a web build in Safari', () => {
    const posted = install(false);
    const input = document.createElement('input');
    input.type = 'text';
    document.body.append(input);

    // Must not throw, and must not pretend the preference changed: the native default is OFF and
    // nothing here can turn it on by accident.
    expect(() => { focusIn(input); focusOut(input); vi.runAllTimers(); }).not.toThrow();
    expect(posted).toEqual([]);
  });
});

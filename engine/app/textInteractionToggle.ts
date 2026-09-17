/**
 * Side-effect module: put iOS text interaction BACK while a text field is focused (#1360).
 *
 * ## Why this exists
 *
 * `MyViewController.swift` turns the web view's `isTextInteractionEnabled` off, because that is the
 * only layer that can suppress the double-tap text-selection magnifier over the game — CSS provably
 * cannot (docs/input.md § "The iOS text-selection magnifier").
 *
 * That switch is coarser than it sounds. **Measured on an iPad (iOS 26.6.2), Court debug build:**
 * with text interaction off, tapping a text field still focuses it and still opens the keyboard,
 * and **no character is entered**. Every `<input>` in the shipped runtime debug overlay — the Store
 * and PlayerPrefs `filter…` boxes, Journal, Time, Input, Profiler — went dead, and it reads as a
 * broken filter rather than a disabled preference, because nothing errors.
 *
 * So the switch has to move: off while the game is being played, on while a field is focused. That
 * is what the published Capacitor plugins wrapping this preference do, and for the same reason.
 *
 * ## Why it lives here rather than in a plugin
 *
 * The native half is in `MyViewController.swift`, which the engine owns and heals into every
 * project. A Capacitor plugin would only reach the two projects that depend on
 * `capacitor-modoki-system`. The bridge is therefore a `WKScriptMessageHandler` registered by that
 * same generated block, and this file is the only thing that talks to it.
 *
 * ⚠️ **A side-effect import, and it must stay ABOVE `./App.tsx` in `main.tsx`** — same reason as
 * `./installErrorCapture`: imports are hoisted and evaluate in source order, so a statement in
 * `main.tsx`'s body runs after the whole app graph has already mounted. A field focused during boot
 * (an autofocused input) would otherwise be typed into before the listener existed.
 *
 * ## Shape notes
 *
 * - `focusin`/`focusout` rather than `focus`/`blur`: the latter do not bubble, so a delegated
 *   listener never sees them.
 * - Idempotent writes are skipped. Each `postMessage` crosses into native and mutates a live
 *   `WKPreferences`; tabbing between two text fields fires focusout+focusin and would otherwise
 *   toggle the preference off and on again for no reason.
 * - **Fails closed to ENABLED is wrong here, so it fails closed to DISABLED**: if the handler is
 *   absent (Android, desktop, a web build in Safari) every call is a no-op and the page behaves
 *   exactly as it did before this existed. The native default is off, and nothing here can turn it
 *   on by accident.
 */

/** Editable targets. `contenteditable` counts — the engine does not use it today, but a game's own
 *  DOM chrome may, and the cost of including it is nothing. `<input type=range|checkbox|button…>`
 *  deliberately does NOT: those were measured working with text interaction off, and re-enabling it
 *  for a slider would put the magnifier back for the duration of a drag. */
function isTextEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) {
    // The types that actually take typed text. `type` is lowercased by the DOM.
    return ['text', 'search', 'url', 'tel', 'email', 'password', 'number'].includes(el.type);
  }
  return false;
}

interface TextInteractionHandler { postMessage(body: unknown): void }

function handler(): TextInteractionHandler | undefined {
  // Present only in a WKWebView carrying the generated block. Everything else is a no-op.
  const webkit = (window as unknown as {
    webkit?: { messageHandlers?: Record<string, TextInteractionHandler | undefined> }
  }).webkit;
  return webkit?.messageHandlers?.modokiTextInteraction;
}

let enabled = false; // mirrors the native default set in webViewConfiguration(for:)

function set(next: boolean): void {
  if (next === enabled) return;
  const h = handler();
  // ⚠️ REDUNDANT for observable behaviour, and kept on purpose — say so rather than let the next
  // reader assume a test defends it. Deleting this line changes no assertion: `h.postMessage` on
  // `undefined` throws a TypeError, the catch below swallows it and restores the mirror, so the
  // outcome is identical. Mutation-checked 2026-09-18 and it SURVIVED. What it buys is not
  // correctness but cost: without it, every focus change on Android, desktop and any web build
  // constructs and throws an exception, on the majority of platforms, forever.
  if (!h) return;
  enabled = next;
  try {
    h.postMessage(next);
  } catch {
    // A throwing bridge must not take the focus handler down with it; the preference simply
    // stays where it was, which is the pre-#1360 behaviour for that field.
    enabled = !next;
  }
}

/** Install the focus-driven toggle. Returns a disposer.
 *
 *  ⚠️ **The disposer is not decoration.** This module is imported for its side effect exactly once
 *  in production, but a test that re-imports it (or any future double-mount) would otherwise leave
 *  the previous instance's document listeners attached — two installs then both post on every focus
 *  change, and the second write is the one that is wrong. Found exactly that way: the toggle test
 *  saw `[true, false, false]`.
 */
export function installTextInteractionToggle(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  enabled = false; // the native default, re-asserted so a re-install cannot inherit a stale mirror

  const onFocusIn = (e: FocusEvent): void => { if (isTextEditable(e.target)) set(true); };
  const onFocusOut = (e: FocusEvent): void => {
    if (!isTextEditable(e.target)) return;
    // focusout fires BEFORE the next focusin, so a straight `set(false)` here would flicker the
    // preference off and immediately on when tabbing between two fields. Defer one task and ask
    // what is focused NOW instead of trusting the event that is leaving.
    setTimeout(() => { if (!isTextEditable(document.activeElement)) set(false); }, 0);
  };

  document.addEventListener('focusin', onFocusIn, { passive: true, capture: true });
  document.addEventListener('focusout', onFocusOut, { passive: true, capture: true });
  return () => {
    document.removeEventListener('focusin', onFocusIn, { capture: true });
    document.removeEventListener('focusout', onFocusOut, { capture: true });
  };
}

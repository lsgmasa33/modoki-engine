/** Render an `Error` as text that ALWAYS carries its message, on every JS engine (#1055).
 *
 *  ⚠️ **`err.stack || err.message` is V8-shaped, and on iOS it silently drops the message.** V8
 *  (Chrome, Android's WebView, Node, Electron) writes `Name: message` as the first line of `stack`,
 *  so the stack alone reads as a complete report. JavaScriptCore (every WKWebView, so every iOS
 *  build) and SpiderMonkey write frames only (`fn@url:line:col`), so a non-empty stack wins the `||`
 *  and the message is gone. OBSERVED twice on an iPad mini 5 (2026-09-11): a
 *  `console.error(new Error('[wordweave] …'))` reached Crashlytics as
 *  `[console.error] anonymous@capacitor://localhost/assets/bridge-….js:2:1673`, with the message
 *  nowhere in it.
 *
 *  The answer is the stack when it already carries the message, otherwise `Name: message` followed by
 *  the stack. "Already carries it" is asked two ways:
 *   - the stack STARTS WITH `Name: message`. That is V8's ordinary output, returned byte-identical,
 *     so every Android and editor report, and the rate limiter's dedupe key built from one
 *     (`globalErrors.ts`), is unchanged. V8 formats the header on the FIRST read of `stack` (measured, Node), so a subclass
 *     name or a message set before that read is already in it.
 *   - the stack has V8 frames (`    at …`) and the text above the first one contains the message.
 *     Still V8, with the header written before a later `name` change. Prepending there would print
 *     the message twice on Android. A MESSAGE changed after that read fails this test and is
 *     prepended: a duplicated line is cheaper than a lost one.
 *  JavaScriptCore and SpiderMonkey never write an indented `at ` line, so the second test cannot
 *  hold for them, and a frames-only stack never starts with `Name: message`.
 *
 *  Total: this runs while something else is already failing, so a hostile `name`/`message`/`stack`
 *  getter degrades to `<unprintable>` rather than throwing a second error.
 *
 *  Zero imports on purpose. It is a dedicated deep export (`@modoki/engine/runtime/core/errorText`),
 *  so `engine/app/debug` can take it without pulling anything else in. It is guarded as the only
 *  implementation by `engine/tests/architecture/errorTextIsShared.test.ts`. */

/** A V8 stack frame line: indentation, then `at `. */
const V8_FRAME = /^[ \t]+at /m;

export function errorText(err: Error): string {
  try {
    const name = String(err.name || 'Error');
    const message = err.message == null ? '' : String(err.message);
    const head = message ? `${name}: ${message}` : name;
    const stack = typeof err.stack === 'string' ? err.stack : '';
    if (!stack) return head;
    if (stack.startsWith(head)) return stack;
    const firstV8Frame = stack.search(V8_FRAME);
    if (firstV8Frame > 0 && stack.slice(0, firstV8Frame).includes(message)) return stack;
    return `${head}\n${stack}`;
  } catch {
    return '<unprintable>';
  }
}

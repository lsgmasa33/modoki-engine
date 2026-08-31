/** Guard: every settle path for the parked Android purchase `PluginCall` goes through
 *  `unpark()`, so the parking slot and the bridge's keep-alive flag are always cleared together
 *  (#514).
 *
 *  ## The trap
 *
 *  `ModokiIapPlugin.java` parks the `purchase()` call in `awaitingPurchase` (+
 *  `awaitingProductId`) because Google Play reports the outcome through
 *  `purchasesUpdatedListener`, not through `purchase()` itself, and calls `call.setKeepAlive(true)`
 *  at the parking site. There are FOUR places that can settle that call — `USER_CANCELED`, a
 *  non-OK/null delivery, a matched delivery, and a `launchBillingFlow` launch failure — and each
 *  one used to clear `awaitingPurchase` by hand, with three of the four leaving `awaitingProductId`
 *  stale and NONE of them clearing `setKeepAlive`. A future settle path copy-pasted from one of
 *  those sites inherits the same gap silently: nothing here throws, nothing here fails a runtime
 *  test, because the bug is a flag that is never read on the paths this repo currently exercises.
 *
 *  `unpark(call)` centralizes all of it: it clears both parking fields (only if `call` still owns
 *  the slot, so a losing race cannot wipe a newer purchase's parking) and calls
 *  `setKeepAlive(false)`, and it must run BEFORE resolve/reject — see the docblock on `unpark`
 *  itself for why order matters.
 *
 *  ⚠️ **On Android today the keep-alive is INERT, not a leak — #514 was filed on the opposite
 *  reading.** This was verified by READING the Capacitor sources bundled in
 *  `games/3d-test/node_modules/@capacitor/android`, not by replaying the bridge:
 *  - `Bridge.java:842-845` — `Bridge.callPluginMethod` saves a call into `savedCalls` only if it
 *    is kept-alive at the moment the plugin METHOD RETURNS. This plugin parks the call several
 *    async hops later (inside `queryProductDetailsAsync`'s callback), so it never reaches
 *    `savedCalls` regardless of the flag.
 *  - `MessageHandler.java:136-138` — `sendResponseMessage` reads `isKeptAlive()` to decide whether
 *    to `release()` the call, and copies the same value into the response's `save` field. This is
 *    the reason the flag MUST be cleared before, not after, resolve/reject: by the time
 *    `sendResponseMessage` runs the decision is already made.
 *  - `native-bridge.js:968-978` — a promise-style call's JS callback is deleted on settle
 *    regardless of `save`, so there is no JS-side retention either.
 *
 *  So this guard exists for what happens the day someone parks a call SYNCHRONOUSLY (a cached
 *  ProductDetails lookup would do it) — at that point `Bridge.java` WOULD save the call, the flag
 *  stops being inert, and every settle path needs to already be correct. This is a SHAPE guard: it
 *  reads the Java source as text and checks that every settle site is routed through one place.
 *  `npm run verify` is vitest, not a JVM — it cannot instantiate `BillingClient` or replay the
 *  Capacitor bridge, so it cannot exercise `unpark` at runtime. That verification has to happen on
 *  a device with a real Play purchase in flight. */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { REPO_ROOT } from '../helpers/repoLayout';

const PLUGIN_PATH = path.join(
  REPO_ROOT,
  'engine/packages/capacitor-modoki-iap/android/src/main/java/com/modokiengine/capacitor/iap/ModokiIapPlugin.java',
);

const source = fs.readFileSync(PLUGIN_PATH, 'utf8');

/** Extract the body of `private void unpark(PluginCall call) { ... }` by locating the signature
 *  and matching braces — simple counting is enough for one method with no nested string literals
 *  containing braces. */
function extractUnparkBody(src: string): string {
  const signature = 'private void unpark(PluginCall call) {';
  const start = src.indexOf(signature);
  if (start === -1) {
    throw new Error(
      `could not find "${signature}" in ModokiIapPlugin.java — has unpark() been renamed or removed? `
        + 'This guard only makes sense if a single unpark() helper still exists.',
    );
  }
  let depth = 1;
  let i = start + signature.length;
  const bodyStart = i;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
  }
  if (depth !== 0) {
    throw new Error('unpark() body braces never balanced — malformed source?');
  }
  return src.slice(bodyStart, i - 1);
}

const unparkBody = extractUnparkBody(source);

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Count real `unpark(...)` STATEMENTS — a line whose trimmed form starts with `unpark(` and ends
 *  with `);` — excluding the `private void unpark(...) {` declaration (which starts with
 *  `private`, not `unpark(`) and any line inside a `//` or `/* *\/` comment. A bare substring
 *  count over the whole file is fooled by a prose comment mentioning `unpark(call)`; this isn't. */
function countUnparkCallSites(src: string): number {
  let count = 0;
  let inBlockComment = false;
  for (const rawLine of src.split('\n')) {
    const line = rawLine.trim();
    if (inBlockComment) {
      if (line.includes('*/')) inBlockComment = false;
      continue;
    }
    if (line.startsWith('/*')) {
      if (!line.includes('*/')) inBlockComment = true;
      continue;
    }
    if (line.startsWith('//') || line.startsWith('*')) continue; // line comment / javadoc continuation
    if (line.startsWith('unpark(') && line.endsWith(');')) count++;
  }
  return count;
}

describe('ModokiIapPlugin: every purchase-call settle path clears the parked slot via unpark() (#514)', () => {
  it('has exactly one `awaitingPurchase = null`, and it lives inside unpark()', () => {
    const totalCount = countOccurrences(source, 'awaitingPurchase = null');
    const inUnpark = countOccurrences(unparkBody, 'awaitingPurchase = null');
    expect(
      totalCount,
      `found ${totalCount} occurrences of "awaitingPurchase = null" in ModokiIapPlugin.java — `
        + 'route the new settle path through unpark() so the slot and the keep-alive are cleared '
        + 'together, instead of clearing awaitingPurchase by hand.',
    ).toBe(1);
    expect(
      inUnpark,
      'the single "awaitingPurchase = null" is not inside unpark() — a settle site is clearing '
        + 'the slot directly again; route it through unpark() instead.',
    ).toBe(1);
  });

  it('has exactly one `awaitingProductId = null`, and it lives inside unpark()', () => {
    const totalCount = countOccurrences(source, 'awaitingProductId = null');
    const inUnpark = countOccurrences(unparkBody, 'awaitingProductId = null');
    expect(
      totalCount,
      `found ${totalCount} occurrences of "awaitingProductId = null" in ModokiIapPlugin.java — `
        + 'route the new settle path through unpark() so awaitingProductId is cleared alongside '
        + 'awaitingPurchase, instead of clearing it by hand (or forgetting it, as three of the '
        + 'original four settle sites did before #514).',
    ).toBe(1);
    expect(
      inUnpark,
      'the single "awaitingProductId = null" is not inside unpark() — route the settle site '
        + 'through unpark() instead of clearing awaitingProductId directly.',
    ).toBe(1);
  });

  it('has exactly one `setKeepAlive(false)`, and it lives inside unpark()', () => {
    // Matched with a leading dot: `.setKeepAlive(false)` requires a method-call receiver, which
    // a prose comment mentioning the same phrase does not have.
    const totalCount = countOccurrences(source, '.setKeepAlive(false)');
    const inUnpark = countOccurrences(unparkBody, '.setKeepAlive(false)');
    expect(
      totalCount,
      `found ${totalCount} occurrences of ".setKeepAlive(false)" in ModokiIapPlugin.java — `
        + 'route the new settle path through unpark() so the keep-alive flag is cleared the same '
        + 'way everywhere, before resolve/reject.',
    ).toBe(1);
    expect(
      inUnpark,
      'the single ".setKeepAlive(false)" is not inside unpark() — route the settle site through '
        + 'unpark() instead of calling setKeepAlive(false) directly.',
    ).toBe(1);
  });

  it('has exactly one `setKeepAlive(true)` — the single parking site', () => {
    // Matched with a leading dot for the same reason as above: an existing prose comment ("the
    // loser's PluginCall, already setKeepAlive(true), became unreachable") mentions the phrase
    // without a receiver and must not be counted as a second parking call.
    const totalCount = countOccurrences(source, '.setKeepAlive(true)');
    expect(
      totalCount,
      `found ${totalCount} occurrences of ".setKeepAlive(true)" in ModokiIapPlugin.java — there `
        + 'should be exactly one parking site (in purchase(), where the call is stashed into '
        + 'awaitingPurchase). A second parking site needs its own matching unpark() call on every '
        + 'path that can settle it.',
    ).toBe(1);
  });

  it('unpark() is called from exactly 4 real settle sites (comments/declaration excluded)', () => {
    // Counting the bare substring `unpark(` over the whole file is fooled by a prose comment
    // mentioning `unpark(call)` (inflates the count, masking a REMOVED call site) just as easily
    // as it is by the declaration — so only count lines that are themselves a statement calling
    // unpark(), not a comment line or the `private void unpark(...)` signature.
    const callSites = countUnparkCallSites(source);
    expect(
      callSites,
      `found ${callSites} real unpark() call sites in ModokiIapPlugin.java — expected exactly 4, `
        + 'the enumerated settle paths: USER_CANCELED, a non-OK/null delivery, a matched delivery, '
        + 'and a launchBillingFlow failure. A different count means either a settle path is '
        + 'clearing the parked call by hand instead of calling unpark(call) (fewer), or a genuine '
        + 'new settle path has appeared that this guard doesn\'t know about yet (more) — in the '
        + 'latter case, update this expectation and the enumeration above once you\'ve confirmed '
        + 'the new site really does route through unpark().',
    ).toBe(4);
  });
});

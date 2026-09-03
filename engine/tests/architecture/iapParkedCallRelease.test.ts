/** Guard: every settle path for the parked Android purchase `PluginCall` goes through
 *  `unpark()`, so the parking slot and the bridge's keep-alive flag are always cleared together
 *  (#514).
 *
 *  ## The trap
 *
 *  `ModokiIapPlugin.java` parks the `purchase()` call in `awaitingPurchase` (+
 *  `awaitingProductId`) because Google Play reports the outcome through
 *  `purchasesUpdatedListener`, not through `purchase()` itself, and calls `call.setKeepAlive(true)`
 *  at the parking site. There are SIX places that can settle that call — `USER_CANCELED`, a
 *  non-OK/null delivery, a matched delivery, a `launchBillingFlow` launch failure, (since
 *  #586) a webview reload, which releases the slot from a `WebViewListener.onPageStarted`
 *  registered by `ensureWebViewListener()` at PARK time — NOT from `load()`, where the listener is
 *  silently discarded by `Bridge.Builder.create()`'s `setWebViewListeners` (device-proven on an
 *  S22, 2026-09-03; see docs/native-and-sdks.md) — and (since #583) a bounded timeout for a call
 *  left parked with no delivery ever matching it. The original four each used to clear `awaitingPurchase` by hand, with
 *  three of them leaving `awaitingProductId` stale and NONE of them clearing `setKeepAlive`. A future settle path copy-pasted from one of
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

/** Line indices of real STATEMENTS matching `stmt`, comments excluded — same reasoning as
 *  `countUnparkCallSites`, and learned the same way: an earlier version of the #586 pin below used
 *  `source.indexOf('ensureWebViewListener();')`, which a reviewer defeated by commenting the call
 *  site OUT. `// ensureWebViewListener();` still contains the substring, so the guard stayed green
 *  while the listener was never registered — the exact inert-mechanism defect #586 exists to stop. */
function statementLines(src: string, stmt: string): number[] {
  const hits: number[] = [];
  let inBlockComment = false;
  src.split('\n').forEach((rawLine, i) => {
    const line = rawLine.trim();
    if (inBlockComment) {
      if (line.includes('*/')) inBlockComment = false;
      return;
    }
    if (line.startsWith('/*')) {
      if (!line.includes('*/')) inBlockComment = true;
      return;
    }
    if (line.startsWith('//') || line.startsWith('*')) return;
    if (line === stmt) hits.push(i);
  });
  return hits;
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

  it('unpark() is called from exactly 6 real settle sites (comments/declaration excluded)', () => {
    // Counting the bare substring `unpark(` over the whole file is fooled by a prose comment
    // mentioning `unpark(call)` (inflates the count, masking a REMOVED call site) just as easily
    // as it is by the declaration — so only count lines that are themselves a statement calling
    // unpark(), not a comment line or the `private void unpark(...)` signature.
    const callSites = countUnparkCallSites(source);
    expect(
      callSites,
      `found ${callSites} real unpark() call sites in ModokiIapPlugin.java — expected exactly 6, `
        + 'the enumerated settle paths: USER_CANCELED, a non-OK/null delivery, a matched delivery, '
        + 'a launchBillingFlow failure, the webview-reload release in the '
        + 'ensureWebViewListener() WebViewListener (#586), and the parked-purchase timeout (#583). '
        + 'A different count means either a settle path is '
        + 'clearing the parked call by hand instead of calling unpark(call) (fewer), or a genuine '
        + 'new settle path has appeared that this guard doesn\'t know about yet (more) — in the '
        + 'latter case, update this expectation and the enumeration above once you\'ve confirmed '
        + 'the new site really does route through unpark().',
    ).toBe(6);
  });
});

describe('ModokiIapPlugin: a parked purchase() times out instead of waiting forever (#583)', () => {
  // The trap this closes: `purchasesUpdated` firing OK with a purchase list that never contains
  // the awaited product is left parked ON PURPOSE (an Ask-to-Buy approval or a subscription
  // renewal delivered while an unrelated purchase is in flight). But if no later delivery ever
  // matches, nothing released the slot.
  //
  // ⚠️ The timer is armed from the NO-MATCH BRANCH ONLY, never at park time. Close-out review
  // caught the park-time draft: it bounds every purchase, including one whose Play sheet is
  // legitimately still open, and resolving it settles the JS promise, which clears Court's
  // `storeInFlight` — whose own doc records that the last omission there was a DOUBLE CHARGE.
  // Several assertions below exist specifically to stop that draft coming back.

  /** The body of the `if (awaitingPurchase == call) { ... }` identity guard inside unpark(). The
   *  timer cancel must live IN here: a settle that lost a race must not cancel the NEWER call's
   *  timer. Asserting against the whole unpark() body cannot tell the two apart. */
  function extractUnparkIdentityGuard(src: string): string {
    const body = extractUnparkBody(src);
    const sig = 'if (awaitingPurchase == call) {';
    const start = body.indexOf(sig);
    if (start === -1) throw new Error('unpark() has no `if (awaitingPurchase == call) {` guard');
    let depth = 1;
    let i = start + sig.length;
    const bodyStart = i;
    for (; i < body.length && depth > 0; i++) {
      if (body[i] === '{') depth++;
      else if (body[i] === '}') depth--;
    }
    if (depth !== 0) throw new Error('unpark() identity-guard braces never balanced');
    return body.slice(bodyStart, i - 1);
  }

  /** Body of `private void armStrandTimeout(...) { ... }`. */
  function extractArmHelper(src: string): string {
    const sig = 'private void armStrandTimeout(PluginCall call, String productId) {';
    const start = src.indexOf(sig);
    if (start === -1) {
      throw new Error(`could not find "${sig}" — has the #583 arm helper been renamed or removed?`);
    }
    let depth = 1;
    let i = start + sig.length;
    const bodyStart = i;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
    }
    if (depth !== 0) throw new Error('armStrandTimeout braces never balanced');
    return src.slice(bodyStart, i - 1);
  }

  it('arms ONLY from the no-match branch — never at park time', () => {
    // ⚠️ Count EVERY call site, not one literal argument spelling. The first draft of this
    // assertion pinned `armStrandTimeout(call, awaitingProductId);` exactly, and a mutation test
    // proved a park-time arm written `armStrandTimeout(call, productId);` sailed straight through
    // it — vacuous on the single regression it exists to stop.
    const declLine = source.split('\n')
      .findIndex((l) => l.includes('private void armStrandTimeout('));
    const armSites = source.split('\n')
      .map((l, i) => ({ l: l.trim(), i }))
      .filter(({ l, i }) => i !== declLine && l.includes('armStrandTimeout(')
        && !l.startsWith('//') && !l.startsWith('*'))
      .map(({ i }) => i);
    expect(
      armSites.length,
      `expected exactly one armStrandTimeout(...) call site (found ${armSites.length}, at lines `
        + `${armSites.map((i) => i + 1).join(', ')}), in onPurchasesUpdated's no-match branch. `
        + 'Arming anywhere else — at park time above all — bounds a purchase whose Play sheet is '
        + 'still open and clears Court storeInFlight underneath it.',
    ).toBe(1);

    // The only postDelayed in the file must be the one inside the helper. A second one is how a
    // park-time arm would come back.
    expect(
      countOccurrences(source, 'mainHandler.postDelayed('),
      'more than one mainHandler.postDelayed( in ModokiIapPlugin.java — the #583 timer must be '
        + 'armed in exactly one place (armStrandTimeout), so its arming condition stays reviewable.',
    ).toBe(1);
    expect(
      extractArmHelper(source).includes('mainHandler.postDelayed('),
      'the sole postDelayed is not inside armStrandTimeout — the arm has moved somewhere the '
        + 'no-match-only invariant is no longer visible.',
    ).toBe(true);

    // Structural, not textual: the arm must live inside the purchasesUpdated LISTENER, and must
    // not have drifted into purchase(). `statementLines` needs an exact whole-line match, so these
    // anchor on declarations rather than on the two-line log statement in that branch.
    const lineOf = (needle: string): number =>
      source.split('\n').findIndex((l) => l.includes(needle));
    const listenerAt = lineOf('private final PurchasesUpdatedListener purchasesUpdatedListener');
    const purchaseAt = lineOf('public void purchase(PluginCall call)');
    expect(listenerAt, 'purchasesUpdatedListener declaration not found').toBeGreaterThan(-1);
    expect(purchaseAt, 'purchase(PluginCall) declaration not found').toBeGreaterThan(-1);
    expect(
      armSites[0] > listenerAt && armSites[0] < purchaseAt,
      `armStrandTimeout is at line ${armSites[0] + 1}, outside the purchasesUpdated listener `
        + `(declared line ${listenerAt + 1}, purchase() begins line ${purchaseAt + 1}). It must be `
        + 'armed from the no-match branch of the delivery listener — arming inside purchase() is '
        + 'the park-time draft that bounds a live Play sheet.',
    ).toBe(true);
  });

  it('parks under the lock — a non-atomic check-and-park strands the loser', () => {
    const parkLine = statementLines(source, 'awaitingPurchase = call;')[0];
    const syncLines = statementLines(source, 'synchronized (lock) {');
    expect(parkLine, 'no `awaitingPurchase = call;` parking statement').toBeGreaterThan(-1);
    const enclosing = syncLines.filter((l) => l < parkLine).pop();
    expect(
      enclosing !== undefined && parkLine - enclosing < 8,
      'the `awaitingPurchase = call;` park is not immediately inside a `synchronized (lock)` '
        + 'block. purchase() runs on a Play Billing THREAD POOL, so an unsynchronised '
        + 'check-and-park lets two calls both see the slot free; the loser parks a '
        + 'setKeepAlive(true) call reachable from no field, which nothing — including the #583 '
        + 'timeout, whose stale-fire guard bails — can ever settle.',
    ).toBe(true);
  });

  it('cancels the armed timeout INSIDE unpark()\'s identity guard', () => {
    const guard = extractUnparkIdentityGuard(source);
    expect(
      guard.includes('mainHandler.removeCallbacks(awaitingPurchaseTimeout)'),
      'the timer cancel is not inside unpark()\'s `if (awaitingPurchase == call)` guard. Outside '
        + 'it, a stale call settling after a NEW purchase took the slot cancels the NEWER call\'s '
        + 'timer — restoring #583 exactly, on the path unpark()\'s own docblock claims to guard.',
    ).toBe(true);
  });

  it('tears the handler down on destroy so a pending timer cannot pin the Activity', () => {
    expect(
      /protected\s+void\s+handleOnDestroy\s*\(/.test(source)
        && source.includes('mainHandler.removeCallbacksAndMessages(null)'),
      'no handleOnDestroy() dropping the posted timer. An armed timer strongly holds the '
        + 'PluginCall (-> MessageHandler -> Bridge -> WebView -> Activity) and the plugin '
        + 'instance, pinning a destroyed Activity in the main looper for the rest of its window.',
    ).toBe(true);
  });

  it('the fire path resolves, unparks FIRST, and never rejects', () => {
    const timeoutBody = extractArmHelper(source);
    const unparkAt = timeoutBody.indexOf('unpark(call)');
    const resolveAt = timeoutBody.indexOf('call.resolve(');
    expect(unparkAt, 'the fire path does not call unpark(call)').toBeGreaterThan(-1);
    expect(resolveAt, 'the fire path does not call call.resolve(...)').toBeGreaterThan(-1);
    expect(
      unparkAt < resolveAt,
      'the fire path resolves BEFORE unparking. unpark()\'s own docblock says the order is '
        + 'load-bearing (the keep-alive flag is read as the response is sent); every other settle '
        + 'site unparks first and this must match.',
    ).toBe(true);
    expect(
      timeoutBody.includes('call.reject('),
      'the fire path rejects — that surfaces a spurious error for a purchase that may still be '
        + 'succeeding. Resolve `transaction: null` like the USER_CANCELED arm.',
    ).toBe(false);
  });

  it('guards against a stale fire: only acts if it is still the parked call', () => {
    expect(
      /if\s*\(\s*awaitingPurchase\s*!=\s*call\s*\)\s*return;/.test(extractArmHelper(source)),
      'the #583 timeout fire path does not check `awaitingPurchase == call` before acting — a '
        + 'stale fire would settle the WRONG call.',
    ).toBe(true);
  });

  it('pins the timeout VALUE, and the docs that quote it', () => {
    const m = source.match(/PARKED_PURCHASE_TIMEOUT_MS\s*=\s*([^;]+);/);
    expect(m, 'PARKED_PURCHASE_TIMEOUT_MS declaration not found').not.toBeNull();
    expect(
      m![1].trim(),
      'the #583 timeout value changed. It is quoted in prose in docs/iap.md; change both or '
        + 'neither. Pinned because only the identifier was checked before, so 5 * 60_000L -> 0L '
        + 'or -> 5 * 60_000_000L was a silent green.',
    ).toBe('5 * 60_000L');

    const iapDoc = fs.readFileSync(
      path.join(REPO_ROOT, 'docs', 'iap.md'), 'utf8',
    );
    expect(
      iapDoc.includes('300000ms') || iapDoc.includes('5-minute') || iapDoc.includes('5 minute'),
      'docs/iap.md no longer states the #583 timeout window in a form matching the constant '
        + '(5 * 60_000L = 300000ms). The number is shadowed in prose; keep them in sync.',
    ).toBe(true);
  });
});

describe('ModokiIapPlugin: the reload listener is registered where it actually survives (#586)', () => {
  // ⚠️ The first #586 fix registered this listener from `Plugin.load()` and was completely INERT.
  // Capacitor's `Bridge` constructor calls `registerAllPlugins()` (`Bridge.java:231`), which is
  // what runs `Plugin.load()`; `Bridge.Builder.create()` then calls `setWebViewListeners(...)`
  // (`:1617`) eighteen lines later, and that setter REPLACES the list (`:1465`) instead of
  // appending — so anything `load()` registered is discarded before the first navigation, and
  // `BridgeWebViewClient.onPageStarted` walks a list that never contained it.
  //
  // Device-measured on a Galaxy S22 (2026-09-03), both halves, same reload path and same probe:
  // registered in `load()` -> `onPageStarted` NEVER fired; registered post-construction -> fired
  // 116ms after `[resume-reload] reloading after 80s away`. `load()` itself always ran (logged 1ms
  // after "Registering plugin instance: ModokiIap") — it was never the problem.
  //
  // These two assertions are the regression pin. A future reader "tidying" the registration back
  // into `load()` reintroduces a bug whose only symptom is silence, which is exactly the kind that
  // survives a code review. Full write-up: docs/native-and-sdks.md.

  it('does NOT override load() — a listener registered there is discarded before it can fire', () => {
    expect(
      /\n\s*public\s+void\s+load\s*\(\s*\)/.test(source),
      'ModokiIapPlugin.java declares a load() override. Capacitor discards anything '
        + 'addWebViewListener() registers there (Bridge.Builder.create() replaces the list right '
        + 'after the constructor ran load()), so a reload listener registered in load() is inert — '
        + 'device-proven on an S22. Register from a post-construction seam instead; '
        + 'ensureWebViewListener() does it at park time.',
    ).toBe(false);
  });

  it('calls ensureWebViewListener() exactly once, as a real statement — not from a comment', () => {
    // Counted as a STATEMENT, deliberately. Commenting the call out leaves the substring in the
    // file, and the first version of this test was defeated exactly that way: the listener would
    // never register, every Android purchase after a resume-reload would reject with "already in
    // progress" forever, and this guard stayed green. Reproducing that needs a Play-track build,
    // so the guard is the only thing standing between that regression and a release.
    const sites = statementLines(source, 'ensureWebViewListener();');
    expect(
      sites.length,
      `found ${sites.length} real ensureWebViewListener() call statements in ModokiIapPlugin.java `
        + '— expected exactly 1, at the parking site in purchase(). Zero means the listener is '
        + 'never registered and #586 is inert again; more than one means registration has spread '
        + 'and the instance-boolean guard is doing work the call sites should not need.',
    ).toBe(1);
  });

  it('registers the listener BEFORE the call becomes reachable from it', () => {
    const registerLine = statementLines(source, 'ensureWebViewListener();')[0];
    const parkLine = statementLines(source, 'awaitingPurchase = call;')[0];
    expect(registerLine, 'no ensureWebViewListener() statement').toBeGreaterThan(-1);
    expect(parkLine, 'no `awaitingPurchase = call;` parking statement').toBeGreaterThan(-1);
    expect(
      registerLine < parkLine,
      `ensureWebViewListener() is at line ${registerLine + 1} but the park is at line ${parkLine + 1}`
        + ' — registration must come FIRST, or a reload landing in between finds a parked call with'
        + ' no listener, which is the exact window #586 exists to close.',
    ).toBe(true);
  });
});

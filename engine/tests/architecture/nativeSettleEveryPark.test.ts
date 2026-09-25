/** Guard: every native plugin call that settles from a callback settles on EVERY path (#1514).
 *
 *  ## The class
 *
 *  A Capacitor plugin method whose only resolve/reject lives in an async callback hangs its JS
 *  promise for the life of the process if some path never reaches it — and whatever awaits it
 *  latches (the debug bridge's `busy`, Court's `storeInFlight`, the IAP boot reconcile). #1507 fixed
 *  it in capacitor-applovin-max; #1514's sweep found it in three more plugins. The behaviour of the
 *  pure parts is tested for real on a JVM (`IapCore.Join` / `ConnectionQueue` / `drainEach`, leg
 *  `android/iap-core` of `npm run test:native`) and in `bridgeBootStartFailure.test.ts`. What those
 *  cannot see is whether the plugin CLASSES still route through them, which is what this file pins —
 *  a SHAPE guard over the shipped sources, in the style of `iapParkedCallRelease.test.ts`.
 *
 *  ## Why each shape matters
 *
 *  - **IAP Android: every Billing listener body is `guarded(...)` or `join.branch(...)`.** Play
 *    Billing runs its query/consume/acknowledge listeners inside `ExecutorService.submit` (javap on
 *    Billing 9.0.0), so a throw is captured in the Future and never surfaces — no crash, no log — and
 *    Billing's 30s timeout is skipped because the future is done (the setup/disconnect listeners are
 *    caught and merely logged). An unwrapped listener that throws is a permanent hang.
 *  - **IAP Android: a mid-setup disconnect goes through the queue.** Nothing guarantees a setup
 *    callback for an attempt that disconnects, so a handler that only cleared a flag stranded every
 *    queued call.
 *  - **game-debug iOS: no `default: break` in the listener state switch, `.cancelled` settles, and a
 *    start deadline is armed.** `.waiting` / `.cancelled` used to fall through and never answer.
 *  - **modoki-system Android: `requestReview`'s listener body is inside a try.** It runs on main, so
 *    an escaped throw is a crash.
 *
 *  ⚠️ These are regex shapes over source text. They cannot prove a wrapper is CORRECT — the JVM leg
 *  and the device runs do that — only that nobody routed a new listener around it. Each shape was
 *  mutation-checked when written (#1514 close-out). */

import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';
import { found } from '@modoki/engine/testing/inOrder';
import { REPO_ROOT } from '../helpers/repoLayout';

/** Comments stripped by extension (#812): the plugins' own docblocks quote the very shapes these
 *  assertions look for (`default: break`, `guard … else { return }`), and a comment must neither
 *  hide an offender nor satisfy an assertion. */
const read = (rel: string) => readScannedSource(path.join(REPO_ROOT, rel)).code;

const IAP = read('engine/packages/capacitor-modoki-iap/android/src/main/java/com/modokiengine/capacitor/iap/ModokiIapPlugin.java');
const GAME_DEBUG_IOS = read('engine/packages/capacitor-game-debug/ios/Sources/GameDebugPlugin/GameDebugPlugin.swift');
const SYSTEM_ANDROID = read('engine/packages/capacitor-modoki-system/android/src/main/java/com/modokiengine/capacitor/system/ModokiSystemPlugin.java');

/** The Billing client calls whose listener runs on Billing's executor. */
const BILLING_ASYNC = /client\.(queryProductDetailsAsync|queryPurchasesAsync|consumeAsync|acknowledgePurchase)\(/g;

/** The source text of `name`'s body, from its signature to the matching close brace. */
function bodyOf(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `signature not found: ${signature}`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error(`unbalanced braces after ${signature}`);
}

describe('IAP Android: every Billing listener settles its call (#1514)', () => {
  it('each Billing async listener body is guarded(...) or join.branch(...)', () => {
    const sites = [...IAP.matchAll(BILLING_ASYNC)];
    // A guard that finds nothing passes by checking nothing: purchase's details query, products'
    // queryDetails, queryAll's queryPurchases, consume and acknowledge.
    expect(sites.length, 'expected the five Billing async call sites').toBe(5);
    const unguarded: string[] = [];
    for (const m of sites) {
      // The listener is the first lambda after the call site; its body is what follows the arrow.
      const arrow = IAP.indexOf('->', m.index);
      const after = IAP.slice(arrow + 2).trimStart();
      if (!/^(guarded\(call, "[^"]+", \(\) -> \{|join\.branch\(\(\) -> \{)/.test(after)) {
        const line = IAP.slice(0, m.index).split('\n').length;
        unguarded.push(`${m[1]} at ModokiIapPlugin.java:${line} — listener body starts: ${after.slice(0, 50)}`);
      }
    }
    expect(unguarded, 'a Billing listener that is not wrapped hangs its call silently on a throw').toEqual([]);
  });

  it('withBilling runs a ready block through guarded, and drains through drainEach', () => {
    const wb = bodyOf(IAP, 'private void withBilling(PluginCall call, Ready block)');
    expect(wb).toMatch(/guarded\(call, "withBilling", \(\) -> block\.run\(client\)\)/);
    expect(wb, 'a bare block.run in withBilling escapes the guard').not.toMatch(/(?<!\(\) -> )block\.run\(/);
    const connect = bodyOf(IAP, 'private void startConnection(final int gen)');
    expect(connect).toMatch(/IapCore\.drainEach\(batch,/);
    expect(connect, 'the drain must not loop by hand — one throw strands the rest of the batch').not.toMatch(/for \(Pending /);
  });

  it('a disconnect is decided by the ConnectionQueue, not by clearing a flag', () => {
    const connect = bodyOf(IAP, 'private void startConnection(final int gen)');
    const disc = bodyOf(connect, 'public void onBillingServiceDisconnected()');
    expect(disc).toMatch(/queue\.onDisconnected\(gen\)/);
    expect(disc).toMatch(/case RECONNECT:[\s\S]*connect\(d\.generation\)/);
    expect(disc).toMatch(/case REJECT:[\s\S]*IapCore\.drainEach\(d\.rejected,\s*p -> rejectWithBilling\(p\.call,/);
  });

  it('a startConnection that throws hands its queue back instead of stranding it (#1514 review)', () => {
    const connect = bodyOf(IAP, 'private void connect(final int gen)');
    expect(connect).toMatch(/try \{\s*startConnection\(gen\);\s*\} catch \(RuntimeException e\) \{/);
    expect(connect).toMatch(/queue\.onConnectFailed\(gen\)/);
    // REJECTS each handed-back call — a drain whose lambda drops them would pass a bare
    // `drainEach(failed,` match (review mutation).
    expect(connect).toMatch(/IapCore\.drainEach\(failed,\s*p -> rejectWithBilling\(p\.call,/);
  });

  it('purchase checks the Activity and builds the flow params BEFORE parking', () => {
    const buy = bodyOf(IAP, 'public void purchase(PluginCall call)');
    const park = found(buy.indexOf('awaitingPurchase = call;'), 'the park');
    const activityCheck = found(buy.indexOf('if (activity == null)'), 'the Activity check');
    const build = found(buy.indexOf('BillingFlowParams flowParams ='), 'the up-front flow params');
    expect(activityCheck, 'the Activity check must precede the park').toBeLessThan(park);
    expect(build, 'the flow params must be built before the park').toBeLessThan(park);
    expect(buy).toMatch(/launchBillingFlow\(activity, flowParams\)/);
  });

  it('the purchase join replaced the shared JSArray (#1517)', () => {
    expect(IAP, 'a shared AtomicInteger countdown is the old racy join').not.toMatch(/AtomicInteger/);
    expect(IAP.match(/new IapCore\.Join<>\(/g)?.length, 'products() and queryAll() each build a Join').toBe(2);
  });
});

describe('game-debug iOS: startServer answers exactly once on every path (#1514)', () => {
  const handler = bodyOf(GAME_DEBUG_IOS, 'newListener.stateUpdateHandler = {');

  it('the listener state switch has no silent default and settles .cancelled', () => {
    expect(handler, 'a `default: break` is exactly how .waiting/.cancelled used to never answer').not.toMatch(/default:\s*break/);
    expect(handler).toMatch(/case \.cancelled:[\s\S]*?settle\.reject\(/);
    expect(handler).toMatch(/case \.waiting/);
  });

  it('a released listener rejects rather than returning silently', () => {
    expect(handler, 'the old `guard let self … else { return }` at the top of the handler').not.toMatch(
      /\{\s*\[weak self, weak newListener\] state in\s*guard let self = self, let newListener = newListener else \{ return \}/,
    );
    // Positively, at both sites that need the weak refs (#1514 review: the negative match above
    // passes for any OTHER spelling of the regression).
    expect(handler, '.ready: a released or stale listener must reject').toMatch(
      /case \.ready:\s*guard let self = self, let newListener = newListener, self\.isCurrent\(settle\) else \{\s*newListener\?\.cancel\(\)\s*settle\.reject\(/,
    );
    expect(handler, '.failed: a released plugin must reject').toMatch(/guard let self = self else \{\s*settle\.reject\(/);
  });

  it('.cancelled ignores only the cancels this handler issued itself', () => {
    // Without the flag, the EADDRINUSE retry's own cancel of the failed listener rejects the start
    // mid-retry; without the settle, an outside cancel never answers.
    expect(handler).toMatch(/case \.cancelled:\s*if retiredByUs \{ return \}\s*settle\.reject\(/);
    expect(handler, '.failed must mark its own cancel').toMatch(/case \.failed\(let err\):\s*retiredByUs = true\s*newListener\?\.cancel\(\)/);
    expect(handler, 'the answered-start cancel in .ready must be marked').toMatch(/retiredByUs = true\s*newListener\.cancel\(\)/);
  });

  it('the start deadline rejects, and rejects BEFORE it cancels', () => {
    const deadline = bodyOf(GAME_DEBUG_IOS, 'private func armStartDeadline(_ settle: StartSettle)');
    const reject = found(deadline.indexOf('settle.reject('), "the deadline's reject");
    const cancel = found(deadline.indexOf('self.listener?.cancel()'), "the deadline's cancel");
    expect(reject, 'cancel first and the .cancelled it provokes answers the start with the wrong reason').toBeLessThan(cancel);
    expect(deadline, 'a deadline that returns before settling bounds nothing').toMatch(/\[weak self\] in\s*if settle\.isSettled \{ return \}\s*print\([^\n]*\n\s*guard settle\.reject\(/);
  });

  it('startServer arms the start deadline, and every retry threads the same settle', () => {
    const start = bodyOf(GAME_DEBUG_IOS, '@objc func startServer(_ call: CAPPluginCall)');
    expect(start).toMatch(/armStartDeadline\(settle\)/);
    const calls = [...GAME_DEBUG_IOS.matchAll(/self\.startListener\(|startListener\(on:/g)].length;
    const threaded = [...GAME_DEBUG_IOS.matchAll(/startListener\(on: [^)]*settle: settle\)/g)].length;
    expect(calls, 'expected the initial bind, the EADDRINUSE retry and the port-0 fallback').toBe(3);
    expect(threaded, 'a retry that makes its own settle answers the call twice or never').toBe(calls);
  });

  it('stopAll stands down an in-flight start', () => {
    const stop = bodyOf(GAME_DEBUG_IOS, 'private func stopAll()');
    expect(stop).toMatch(/startGeneration \+= 1/);
    expect(stop).toMatch(/pending\?\.reject\(/);
  });
});

describe('modoki-system Android: requestReview cannot crash or hang (#1514)', () => {
  it("the requestReviewFlow listener body is inside a try", () => {
    const review = bodyOf(SYSTEM_ANDROID, 'public void requestReview(PluginCall call)');
    expect(review).toMatch(/requestReviewFlow\(\)\.addOnCompleteListener\(task -> \{\s*try \{/);
  });
});

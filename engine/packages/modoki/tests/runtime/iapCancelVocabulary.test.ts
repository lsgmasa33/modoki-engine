/** #971 — the cancel VOCABULARY is one contract shared by three implementations, and this is the
 *  JS end of it.
 *
 *  The two natives are held to `test-vectors/iap-classification-vectors.json` by their own legs
 *  (`ios/iap-core`, `android/iap-core` in `npm run test:native`). Those legs prove each platform
 *  PRODUCES the right strings. This file guards the two things they structurally cannot:
 *
 *  1. **The `vocabulary` list cannot drift from the sections it summarises.** It is a
 *     hand-maintained list, i.e. a SECOND copy of facts already stated in `ios.classify` /
 *     `android.cancelReason` — so it is DERIVED here and compared, rather than eyeballed.
 *  2. **The engine's own prose cannot drift from it.** `cancelReason` is documented for consumers
 *     in `types.ts`, and nothing anywhere checked that the strings named there are the strings a
 *     native can actually emit. Four prose copies of this vocabulary exist across the repo; this
 *     pins the one engine consumers read.
 *
 *  ⚠️ There is deliberately NO per-string routing test. `capacitorStore` maps ANY truthy
 *  `cancelReason` to `{cancelled: true}` — it never branches on the value — so asserting four
 *  strings route as cancels would prove exactly what asserting one proves, and would look like
 *  coverage while testing nothing. The value-sensitive logic lives in the natives, which is where
 *  it is tested.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const VECTORS = path.resolve(here, '../../../capacitor-modoki-iap/test-vectors/iap-classification-vectors.json');
const TYPES_TS = path.resolve(here, '../../src/runtime/iap/types.ts');

type Vec = { name: string; expect?: string; cancel?: boolean };
type Doc = {
  version: number;
  ios: { resultCancelReason: string; classify: Vec[] };
  android: { cancelReason: string; rejectCodePrefix: string; classify: unknown[] };
  vocabulary: { reason: string; platform: string; cancel: boolean }[];
};

function load(): Doc {
  // ⚠️ Not wrapped in a try/catch returning a default: every assertion below reads this, so a
  // silent fallback would make the whole suite pass against nothing.
  return JSON.parse(fs.readFileSync(VECTORS, 'utf8')) as Doc;
}

describe('iap cancel vocabulary (#971)', () => {
  it('the vector file exists, is populated, and is the format all three replays expect', () => {
    expect(fs.existsSync(VECTORS)).toBe(true);
    const d = load();
    // ⚠️ `version` is READ here and in both native self-tests, not decoration. An authored field
    // nothing reads is a lie with a tooltip (CLAUDE.md); worse, a format change could otherwise
    // half-land — one replay updated, two silently reading the old shape.
    expect(d.version).toBe(1);
    expect(d.ios.classify.length).toBeGreaterThan(10);
    expect(d.android.classify.length).toBeGreaterThan(5);
    expect(d.vocabulary.length).toBeGreaterThan(0);
  });

  it('the declared vocabulary is exactly what the platform sections imply', () => {
    const d = load();
    const derived = new Set<string>([
      // The RESULT constant — a cancel StoreKit RETURNED, not one it threw.
      d.ios.resultCancelReason,
      // Every iOS classification the vectors mark as a cancel.
      ...d.ios.classify.filter((v) => v.cancel && v.expect).map((v) => v.expect as string),
      // Android reports its cancel by response code, so it has exactly one string.
      d.android.cancelReason,
    ]);
    const declared = new Set(d.vocabulary.map((v) => v.reason));
    expect([...declared].sort()).toEqual([...derived].sort());
  });

  it('every vocabulary entry is marked as a cancel', () => {
    // The list is the set of reasons that mean "cancelled". An entry with cancel:false would be a
    // contradiction that the derivation above cannot catch, since it only compares the key set.
    for (const v of load().vocabulary) expect(v.cancel).toBe(true);
  });

  it('no classification is both a cancel and not a cancel', () => {
    const d = load();
    const cancels = new Set(d.ios.classify.filter((v) => v.cancel).map((v) => v.expect));
    const notCancels = new Set(d.ios.classify.filter((v) => !v.cancel).map((v) => v.expect));
    for (const c of cancels) expect(notCancels.has(c)).toBe(false);
  });

  it('#946: the RESULT cancel and the THROWN cancel stay distinguishable', () => {
    const d = load();
    // Collapsing these two re-creates the ambiguity #946 exists to resolve: a purchase the player
    // CONFIRMED was recorded as `cancelled`, and nothing could say which kind of cancel it was.
    expect(d.ios.resultCancelReason).toBe('storekit.result.userCancelled');
    const thrown = d.ios.classify.find((v) => v.name.includes('thrown StoreKitError.userCancelled'));
    expect(thrown?.expect).toBe('storekit.userCancelled');
    expect(thrown?.expect).not.toBe(d.ios.resultCancelReason);
  });

  it('#946: an ASD/AMS fault classifies as NOT a cancel', () => {
    // Both surface to the player as "Request Canceled". Treating them as cancels is the misread
    // this whole contract exists to prevent.
    const d = load();
    for (const domain of ['ASDErrorDomain', 'AMSErrorDomain']) {
      const v = d.ios.classify.find((x) => x.expect?.startsWith(`${domain}:`));
      expect(v, `no vector for ${domain}`).toBeDefined();
      expect(v!.cancel).toBe(false);
    }
  });

  it("types.ts's cancelReason docs name every string a native can emit", () => {
    // The guard's SUBJECT is the prose, so it is meant to read the comment — this is not a case of
    // a regex accidentally matching a comment. Rewording is fine; dropping a string is not.
    const src = fs.readFileSync(TYPES_TS, 'utf8');
    for (const { reason } of load().vocabulary) {
      expect(src.includes(reason), `types.ts never mentions '${reason}'`).toBe(true);
    }
  });
});

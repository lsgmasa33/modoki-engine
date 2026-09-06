/** Generations against the shared MSDF worker must be SERIALIZED.
 *
 *  The worker holds exactly one loaded font, and the library's `generateAtlas` is two
 *  awaited round-trips — `loadFont(font)` then `generateAtlas(...)`. Two fonts generating
 *  concurrently interleave as loadFont(A) · loadFont(B) · generateAtlas(A) ·
 *  generateAtlas(B), and A's atlas comes back drawn from B's OUTLINES.
 *
 *  Nothing errors, which is the whole problem: real glyphs, real advances, wrong typeface.
 *  A scene with two `mode:'dynamic'` fonts hits it at LOAD (acquireFont seeds them in
 *  parallel), so it presents as an intermittent cold-start "this font renders at the wrong
 *  weight" that heals after a re-import — a lone re-acquire cannot race. Measured live in
 *  games/text_demo: the Geologica-Bold-wght700 provider returned H advance 0.698 and
 *  ascender 1.16, i.e. NotoSansJP's outlines, against Geologica's own 0.773 / 0.975.
 *
 *  The mock below reproduces the library's two-step shape exactly — that is what makes
 *  this a regression test rather than a restatement of the fix. Remove the lock and it
 *  fails; the assertion is that each call gets ITS OWN font back. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

/** `vi.mock` is hoisted above every top-level binding, so the fake and its recorder have
 *  to be created inside `vi.hoisted` to exist by the time the factory runs. */
const shared = vi.hoisted(() => {
  const loadOrder: string[] = [];
  // Monotonic id, one per FakeWorkerBackedMsdf instance — i.e. one per fake "worker". This is
  // how #817's test proves a NEW worker was built rather than the retired one being reused.
  let nextWorkerId = 0;
  // Every instance id that has had `dispose()` called on it — #818's test proves an
  // orphaned (late-initializing) instance actually gets disposed, not merely dropped.
  const disposedIds: number[] = [];
  // The worker id `generateAtlas` was called on, in call order — lets a test that never sees
  // its OWN call's result (because it hangs forever) still learn which worker it landed on.
  const issuedWorkerIds: number[] = [];
  /** Stands in for the worker: ONE loaded font, and a yield between load and rasterize. */
  const control: { hangInit: boolean; hangGenerate: boolean; initGate: Promise<void> | null } =
    { hangInit: false, hangGenerate: false, initGate: null };
  class FakeWorkerBackedMsdf {
    readonly id = ++nextWorkerId;
    private loaded: string | null = null;
    async initialize(): Promise<void> {
      // A worker whose script or wasm 404s never REPLIES — comlink's promise does not
      // reject, it simply never settles. That is the shape being guarded against.
      if (control.hangInit) return new Promise<void>(() => {});
      // A controllable "slow but alive" init: settles only once the test releases the gate,
      // which is what lets #818's test land the timeout FIRST and the real success LATER.
      if (control.initGate) await control.initGate;
    }
    async generateAtlas(o: { font: Uint8Array; charset: string }): Promise<unknown> {
      issuedWorkerIds.push(this.id);
      // step 1 — loadFont: overwrites the single slot
      this.loaded = String.fromCharCode(...o.font);
      loadOrder.push(this.loaded);
      if (control.hangGenerate) await new Promise<void>(() => {});
      // the comlink round-trip boundary the interleave slips through
      await new Promise((r) => setTimeout(r, 0));
      // step 2 — rasterize from whatever is loaded NOW
      return {
        texture: { data: new Uint8ClampedArray(4), width: 1, height: 1 },
        glyphs: [], kerning: [], textureSize: [1, 1], fieldRange: 8,
        metrics: { emSize: 1, ascender: 1, descender: -1, lineHeight: 1 },
        // the fingerprint: which font this atlas was actually drawn from, and which fake
        // worker it was drawn in.
        info: { name: this.loaded, workerId: this.id },
      };
    }
    async dispose(): Promise<void> { disposedIds.push(this.id); }
  }
  return { loadOrder, control, FakeWorkerBackedMsdf, disposedIds, issuedWorkerIds };
});

vi.mock('@zappar/msdf-generator', () => ({ MSDF: shared.FakeWorkerBackedMsdf }));

import { generateMsdf, disposeMsdfGenerator } from '../../src/runtime/rendering/text/msdfGenerate';
import { TimeoutError } from '../../src/runtime/core/abandonment';

const bytesOf = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

beforeEach(async () => {
  await disposeMsdfGenerator();
  shared.loadOrder.length = 0;
  shared.control.hangInit = false;
  shared.control.hangGenerate = false;
  shared.control.initGate = null;
  shared.disposedIds.length = 0;
  shared.issuedWorkerIds.length = 0;
});

describe('generateMsdf serializes against the shared worker', () => {
  it('gives each concurrent caller ITS OWN font, not the last one loaded', async () => {
    const [a, b] = await Promise.all([
      generateMsdf(bytesOf('AAA'), 'H'),
      generateMsdf(bytesOf('BBB'), 'H'),
    ]);
    expect((a as { info: { name: string } }).info.name).toBe('AAA');
    expect((b as { info: { name: string } }).info.name).toBe('BBB');
  });

  it('never loads a second font while a generation is in flight', async () => {
    await Promise.all([
      generateMsdf(bytesOf('AAA'), 'H'),
      generateMsdf(bytesOf('BBB'), 'H'),
      generateMsdf(bytesOf('CCC'), 'H'),
    ]);
    // One load per generation, in submission order — an interleave would still produce
    // three loads, so the ORDER plus the per-call result above is what pins it.
    expect(shared.loadOrder).toEqual(['AAA', 'BBB', 'CCC']);
  });

  it('does not let one failed generation reject the ones queued behind it', async () => {
    const boom = generateMsdf(null as unknown as Uint8Array, 'H'); // throws inside the mock
    const after = generateMsdf(bytesOf('BBB'), 'H');
    await expect(boom).rejects.toBeTruthy();
    await expect(after).resolves.toBeTruthy();
    expect((await after as { info: { name: string } }).info.name).toBe('BBB');
  });
});

/** A font that cannot load must degrade to NO TEXT, never to NO BOOT.
 *
 *  Fonts are awaited scene resources, so anything that hangs in here hangs the scene load
 *  — and a module Worker whose script or wasm 404s does not reject, it never replies at
 *  all. Measured in production: Court's iOS build shipped `assets/worker-*.js` with no
 *  `msdfgen_wasm.wasm` beside it, and the game sat on its splash screen forever with not
 *  one error logged. Both the init and the per-generation round-trip are therefore bounded.
 *
 *  Driven with fake timers so the test costs nothing; the assertion is that the promise
 *  SETTLES, which is the whole property. */
describe('a wedged worker cannot hang the caller', () => {
  it('rejects instead of hanging when init never replies', async () => {
    vi.useFakeTimers();
    try {
      shared.control.hangInit = true;
      const p = generateMsdf(bytesOf('AAA'), 'H');
      const assertion = expect(p).rejects.toThrow(/MSDF worker init timed out after 10000ms/);
      await vi.advanceTimersByTimeAsync(10_001);
      await assertion;
    } finally { vi.useRealTimers(); }
  });

  it('rejects instead of hanging when a generation never replies', async () => {
    vi.useFakeTimers();
    try {
      shared.control.hangGenerate = true;
      const p = generateMsdf(bytesOf('AAA'), 'H');
      const assertion = expect(p).rejects.toThrow(/generation of 1 glyph\(s\) timed out after 30000ms/);
      await vi.advanceTimersByTimeAsync(30_001);
      await assertion;
    } finally { vi.useRealTimers(); }
  });

  it('fails FAST after the first init failure — N fonts must not each pay the timeout', async () => {
    vi.useFakeTimers();
    try {
      shared.control.hangInit = true;
      const first = generateMsdf(bytesOf('AAA'), 'H');
      const a1 = expect(first).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(10_001);
      await a1;
      // The memoized rejection means no timer needs to run for the second caller at all.
      await expect(generateMsdf(bytesOf('BBB'), 'H')).rejects.toThrow();
    } finally { vi.useRealTimers(); }
  });
});

/** #817 — a timed-out `generateAtlas` abandons the caller while the call is STILL RUNNING
 *  inside the worker (the fake models this with `hangGenerate`, which never resolves).
 *  `genQueue` settles on the timeout regardless, so without retirement the very next
 *  generation would enter `loadFont` on the SAME worker while the abandoned call is still
 *  in there — exactly the font-swap window the queue exists to close, except now it is a
 *  worker-swap window instead. The fix (`retireGenerator`) nulls `instance`/`initPromise`
 *  on a `TimeoutError`, so the next `getGenerator()` is forced to build a brand-new `MSDF`
 *  — a fresh worker the old one's stuck call cannot reach into. */
describe('#817 — a timed-out generation retires its worker instead of reusing it', () => {
  it('the generation after a timeout runs on a DIFFERENT worker and is not corrupted', async () => {
    vi.useFakeTimers();
    try {
      shared.control.hangGenerate = true;
      const stuckA = generateMsdf(bytesOf('A'), 'H');
      const assertionA = expect(stuckA).rejects.toBeInstanceOf(TimeoutError);
      await vi.advanceTimersByTimeAsync(30_001);
      await assertionA;

      // Recorded by the fake at the top of `generateAtlas`, so it is captured even though
      // A's own call never resolves (it hangs forever inside `hangGenerate`).
      expect(shared.issuedWorkerIds).toHaveLength(1);
      const workerIdA = shared.issuedWorkerIds[0];

      shared.control.hangGenerate = false;
      const bPromise = generateMsdf(bytesOf('B'), 'H');
      await vi.advanceTimersByTimeAsync(1); // let the fake's internal `setTimeout(r, 0)` fire
      const b = (await bPromise) as unknown as { info: { name: string; workerId: number } };

      expect(b.info.name).toBe('B'); // not corrupted by whatever A's stuck call is still doing
      // The load-bearing assertion: revert `retireGenerator` and this fails, because B would
      // be issued on the SAME worker id as the abandoned A.
      expect(b.info.workerId).not.toBe(workerIdA);
    } finally { vi.useRealTimers(); }
  });

  it('the queue is not wedged after a timeout — a later generation still completes', async () => {
    vi.useFakeTimers();
    try {
      shared.control.hangGenerate = true;
      const stuck = generateMsdf(bytesOf('A'), 'H');
      const stuckAssertion = expect(stuck).rejects.toBeInstanceOf(TimeoutError);
      await vi.advanceTimersByTimeAsync(30_001);
      await stuckAssertion;

      shared.control.hangGenerate = false;
      // Guards against "fix it by holding the lock until the abandoned call settles" — that
      // would remove the corruption window but reopen the exact hang GENERATE_TIMEOUT_MS was
      // added to prevent (the stuck call never settles, so the lock would never release).
      const afterAssertion = expect(generateMsdf(bytesOf('B'), 'H')).resolves.toBeTruthy();
      await vi.advanceTimersByTimeAsync(1); // let the fake's internal `setTimeout(r, 0)` fire
      await afterAssertion;
    } finally { vi.useRealTimers(); }
  });
});

/** #818 — `getGenerator`'s init timeout rejects the CALLER, but a slow worker can still come
 *  up successfully afterwards. Before the fix, `instance = msdf` on that success path was
 *  unreachable code as far as future callers were concerned (a fresh `getGenerator()` call
 *  starts its own `initPromise` because the timed-out one was never stored), so
 *  `disposeMsdfGenerator` — which only ever reads `instance` — had no way to reach the late
 *  Worker, and it leaked for the life of the realm. The fix is the `onSettled` handler on the
 *  init `withTimeout`: it disposes a late-arriving `msdf` on the caller's behalf. */
describe('#818 — a late-succeeding init disposes its orphaned worker', () => {
  it('disposes the instance once init succeeds AFTER the caller has already timed out', async () => {
    vi.useFakeTimers();
    try {
      let releaseGate!: () => void;
      shared.control.initGate = new Promise<void>((resolve) => { releaseGate = resolve; });

      const p = generateMsdf(bytesOf('A'), 'H');
      const assertion = expect(p).rejects.toBeInstanceOf(TimeoutError);
      await vi.advanceTimersByTimeAsync(10_001);
      await assertion;

      // Nothing has succeeded yet — the gate is still held — so nothing should be disposed.
      expect(shared.disposedIds).toHaveLength(0);

      // Now let the "slow but alive" init finish, well after the caller has given up.
      releaseGate();
      await vi.advanceTimersByTimeAsync(0);
      // The `onSettled` callback isn't awaited by anything — flush a few microtask turns for
      // the init promise, `withTimeout`'s internal `.then`, and the fire-and-forget dispose
      // to all run.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // The load-bearing assertion: revert the `onSettled` disposition on the init
      // `withTimeout` and this stays empty forever — the late worker is orphaned, not disposed.
      expect(shared.disposedIds).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it('an on-time, ordinary init disposes nothing', async () => {
    const a = (await generateMsdf(bytesOf('A'), 'H')) as { info: { name: string } };
    expect(a.info.name).toBe('A');
    expect(shared.disposedIds).toEqual([]);
  });
});

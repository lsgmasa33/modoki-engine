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
  /** Stands in for the worker: ONE loaded font, and a yield between load and rasterize. */
  const control = { hangInit: false, hangGenerate: false };
  class FakeWorkerBackedMsdf {
    private loaded: string | null = null;
    async initialize(): Promise<void> {
      // A worker whose script or wasm 404s never REPLIES — comlink's promise does not
      // reject, it simply never settles. That is the shape being guarded against.
      if (control.hangInit) return new Promise<void>(() => {});
    }
    async generateAtlas(o: { font: Uint8Array; charset: string }): Promise<unknown> {
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
        // the fingerprint: which font this atlas was actually drawn from
        info: { name: this.loaded },
      };
    }
    async dispose(): Promise<void> {}
  }
  return { loadOrder, control, FakeWorkerBackedMsdf };
});

vi.mock('@zappar/msdf-generator', () => ({ MSDF: shared.FakeWorkerBackedMsdf }));

import { generateMsdf, disposeMsdfGenerator } from '../../src/runtime/rendering/text/msdfGenerate';

const bytesOf = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

beforeEach(async () => {
  await disposeMsdfGenerator();
  shared.loadOrder.length = 0;
  shared.control.hangInit = false;
  shared.control.hangGenerate = false;
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
      const assertion = expect(p).rejects.toThrow(/worker init timed out/);
      await vi.advanceTimersByTimeAsync(10_001);
      await assertion;
    } finally { vi.useRealTimers(); }
  });

  it('rejects instead of hanging when a generation never replies', async () => {
    vi.useFakeTimers();
    try {
      shared.control.hangGenerate = true;
      const p = generateMsdf(bytesOf('AAA'), 'H');
      const assertion = expect(p).rejects.toThrow(/generation of 1 glyph\(s\) timed out/);
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

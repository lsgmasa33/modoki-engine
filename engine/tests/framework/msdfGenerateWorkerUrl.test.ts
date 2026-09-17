/** msdfGenerate hands the lib BOTH bundler-resolved URLs (#1356).
 *
 *  The lib's own worker fallback ships an unbundled worker whose bare `comlink` import cannot start
 *  in a production build, and msdfWorkerAssetStrip now turns that fallback into a throw. So the
 *  `workerUrl` handed over here is the only way a shipped build gets a generator at all. The lib is
 *  replaced by a recorder: what is under test is the config OUR code builds, not the lib. */
import { describe, it, expect, vi, afterEach } from 'vitest';

const configs: Array<Record<string, unknown>> = [];

vi.mock('@zappar/msdf-generator', () => ({
  MSDF: class {
    constructor(config: Record<string, unknown>) { configs.push(config); }
    initialize() { return Promise.resolve(); }
    generateAtlas() { return Promise.resolve({ glyphs: [] }); }
    dispose() { return Promise.resolve(); }
  },
}));

afterEach(async () => {
  const { disposeMsdfGenerator } = await import('../../packages/modoki/src/runtime/rendering/text/msdfGenerate');
  await disposeMsdfGenerator();
  configs.length = 0;
});

describe('msdfGenerate generator config', () => {
  it('passes a bundled workerUrl and wasmUrl to the lib', async () => {
    const { generateMsdf } = await import('../../packages/modoki/src/runtime/rendering/text/msdfGenerate');
    await generateMsdf(new Uint8Array(0), 'A');
    expect(configs).toHaveLength(1);
    const { workerUrl, wasmUrl } = configs[0] as { workerUrl?: unknown; wasmUrl?: unknown };
    expect(typeof workerUrl, 'workerUrl must come from `?worker&url`, not the lib fallback').toBe('string');
    // Vite's WORKER marker, not just "a URL with worker in it": `?url` would also hand back a string
    // path to dist/worker.js — and in a build, that is the unbundled copy #1356 is about.
    expect(workerUrl).toMatch(/[?&]worker_file\b/);
    expect(typeof wasmUrl).toBe('string');
    expect(wasmUrl).toMatch(/msdfgen_wasm\.wasm/);
  });
});

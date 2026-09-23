/**
 * #1259 — a rejection inside an SSE route must still end the stream with a `FAILED:` status.
 * One case per symptom, each driving the REAL middleware the plugin registers in `configureServer`:
 *
 *  1. `/api/build`, android: `healNativeProject` rejects inside the detached pipeline (observed for
 *     real on a malformed project package.json; stubbed here so the case does not depend on
 *     `ensureCapacitorDeps`'s wording). Before the fix the response never ended.
 *  2. `/api/build`: a throw in the synchronous prefix, after the SSE headers and before the pipeline
 *     starts. Before the fix the dialog spun AND the build slot stayed held until a disconnect.
 *  3. `/api/ota/publish`: the CORS step's temp-file write fails (TMPDIR points nowhere) after the
 *     build step succeeded.
 *
 * Each asserts the route's own HEADLINE, not just "some FAILED" — the middleware-level catch also
 * sends FAILED, so a fixture that broke earlier than intended would otherwise pass for the wrong reason.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';
import { conversionToolchainDir, conversionCliDist } from '../../toolchain';

const { spawned, healCalls, scaffoldCalls, installs } = vi.hoisted(() => ({ spawned: [] as string[], healCalls: { n: 0 }, scaffoldCalls: { n: 0 }, installs: [] as Array<{ id: string; toolchainDir: string }> }));
/** Every answer a route's slot gave `onPipelineStart` — the observable that a route's setup has
 *  finished and it has DECIDED whether to start (#1478). Pass-through: the real policy answers. */
const pipelineStarts = vi.hoisted(() => [] as boolean[]);
vi.mock('../../plugins/backend/buildLock', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../plugins/backend/buildLock')>();
  return {
    ...orig,
    releasePolicy: (release: () => void) => {
      const policy = orig.releasePolicy(release);
      return { ...policy, onPipelineStart: () => { const ok = policy.onPipelineStart(); pipelineStarts.push(ok); return ok; } };
    },
  };
});

vi.mock('../../plugins/addNativeTarget', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../plugins/addNativeTarget')>();
  return { ...real, scaffoldNativeTarget: async () => { scaffoldCalls.n++; return { warnings: [] }; } };
});

const stubs = vi.hoisted(() => ({
  healRejects: null as Error | null,
  buildNumbersThrows: null as Error | null,
}));

vi.mock('../../plugins/healNativeProject', () => ({
  healNativeProject: async () => {
    healCalls.n++;
    if (stubs.healRejects) throw stubs.healRejects;
    return { ok: true };
  },
}));

vi.mock('../../plugins/healNativeConfig', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../plugins/healNativeConfig')>();
  return {
    ...real,
    injectedBuildNumbers: (): ReturnType<typeof real.injectedBuildNumbers> => {
      if (stubs.buildNumbersThrows) throw stubs.buildNumbersThrows;
      return { notes: [], platformNotes: { android: [], ios: [] } } as unknown as ReturnType<typeof real.injectedBuildNumbers>;
    },
    writeBuildNumberArgFiles: () => {},
  };
});

// Every tool present, so the android build is not refused before it reaches the pipeline. `install`
// records instead of downloading — the /api/toolchain/install cases assert WHERE it would install.
vi.mock('../../toolchain', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../toolchain')>();
  return {
    ...real,
    preflight: (target: string) => ({ target, ready: true, tools: [] }),
    install: async (id: string, opts: { toolchainDir: string }) => {
      installs.push({ id, toolchainDir: opts.toolchainDir });
      return { path: '/fake/installed' };
    },
  };
});

vi.mock('../../plugins/backend/androidDevices', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../plugins/backend/androidDevices')>();
  return {
    ...real,
    listAndroidDevices: () => [],
    resolveBuildAndroidSerial: () => ({ serial: 'emulator-5554' }),
  };
});

// OTA: past every gate that asks about the real world (signing key, git tree, gcloud).
vi.mock('../../scripts/ota/publishPreflight.mjs', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    readRawOtaBlock: () => ({ ok: true, ota: {} }),
    otaPublishPreflight: () => ({ ok: true, target: { kind: 'self' }, version: 'v1', bucket: 'gs://fixture-bucket/ota' }),
  };
});
vi.mock('../../scripts/ota/buildStamp.mjs', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, readGitProvenance: () => ({ commit: 'abc123', dirty: false }) };
});
vi.mock('../../plugins/backend/gcloud', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../plugins/backend/gcloud')>();
  return { ...real, resolveGcloudDir: () => '/usr/bin' };
});

// Steps "run" and exit 0 without spawning anything.
vi.mock('../../plugins/buildStepShell', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../plugins/buildStepShell')>();
  return {
    ...real,
    spawnBuildCommand: (cmd: string) => {
      spawned.push(cmd);
      const proc = new EventEmitter() as EventEmitter & { stdout: null; stderr: null; pid: undefined };
      proc.stdout = null; proc.stderr = null; proc.pid = undefined;
      setTimeout(() => proc.emit('close', 0), 0);
      return proc;
    },
    killBuildProcess: () => {},
  };
});

const { assetScannerPlugin } = await import('../../plugins/vite-asset-scanner');
const { acquireBuildSlot, resetBuildLockForTests } = await import('../../plugins/backend/buildLock');
const { resetBuildClaimsForTests } = await import('../../scripts/buildClaimsStore.mjs');

type Middleware = (req: unknown, res: unknown, next: (err?: unknown) => void) => void;

class FakeRes extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string> = {};
  chunks: string[] = [];
  writableEnded = false;
  destroyed = false;
  headersSent = false;
  setHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v; }
  getHeader(k: string) { return this.headers[k.toLowerCase()]; }
  write(c: string) { this.headersSent = true; this.chunks.push(c); return true; }
  end(c?: string) {
    if (c) this.chunks.push(c);
    this.writableEnded = true;
    this.headersSent = true;
    // Node emits `close` after a response finishes — the build slot's pre-pipeline release rides it.
    setImmediate(() => this.emit('close'));
    return this;
  }
  statuses(): string[] {
    return this.chunks
      .filter((c) => c.startsWith('event: status\n'))
      .map((c) => JSON.parse(c.slice('event: status\ndata: '.length).trim()) as string);
  }
}

let projectRoot: string;
let home: string;
const saved: Record<string, string | undefined> = {};
let middleware: Middleware;

function setEnv(k: string, v: string | undefined) {
  if (!(k in saved)) saved[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

function drive(url: string, opts: { disconnectDuringSetup?: boolean } = {}): { res: FakeRes; next: ReturnType<typeof vi.fn> } {
  const req = Object.assign(new EventEmitter(), { url, method: 'GET', headers: {} });
  const res = new FakeRes();
  if (opts.disconnectDuringSetup) {
    // The client leaves the moment the route registers its slot's close handler — i.e. inside the
    // setup `await` that follows, before the pipeline starts. Both halves of a real disconnect fire.
    let armed = true;
    res.on('newListener', (event) => {
      if (event !== 'close' || !armed) return;
      armed = false;
      queueMicrotask(() => {
        res.destroyed = true;
        req.emit('close');
        res.emit('close');
      });
    });
  }
  const next = vi.fn();
  middleware(req, res, next);
  return { res, next };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  stubs.healRejects = null;
  stubs.buildNumbersThrows = null;
  projectRoot = fs.realpathSync(makeScratchDir('modoki-sse-reject-'));
  home = makeScratchDir('modoki-sse-home-');
  fs.writeFileSync(path.join(projectRoot, 'game.ts'), 'export const game = {};');
  fs.writeFileSync(path.join(projectRoot, 'project.config.json'), JSON.stringify({ app: { appId: 'com.example.fixture', appName: 'Fixture' } }));
  // A scaffolded android target, so the build heals rather than auto-scaffolding.
  fs.mkdirSync(path.join(projectRoot, 'android', 'app'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'android', 'app', 'build.gradle'), '');
  fs.writeFileSync(path.join(projectRoot, 'android', 'variables.gradle'), '');
  setEnv('MODOKI_PROJECT', projectRoot);
  setEnv('MODOKI_HOME', home);
  setEnv('MODOKI_PROVISION_NODE', undefined);

  const p = assetScannerPlugin() as unknown as { configResolved: (c: { root: string }) => void; configureServer: (s: unknown) => void };
  p.configResolved({ root: path.join(projectRoot, 'engine') });
  let captured: Middleware | undefined;
  p.configureServer({
    ws: { send: () => {}, on: () => {} },
    watcher: { add: () => {}, on: () => {} },
    middlewares: { use: (fn: Middleware) => { captured ??= fn; } },
    httpServer: null,
  });
  if (!captured) throw new Error('fixture: configureServer registered no middleware');
  middleware = captured;
});

afterEach(() => {
  // A failing case can leave the in-process slot held (its response never ended); without this the
  // NEXT case is refused as "already running" and fails for a reason that is not its own.
  resetBuildLockForTests();
  resetBuildClaimsForTests();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete saved[k];
  }
  fs.rmSync(projectRoot, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('#1259: a rejection in an SSE route ends the stream with FAILED', () => {
  it('/api/build: healNativeProject rejecting in the pipeline sends the build\'s FAILED and ends', async () => {
    stubs.healRejects = new Error('Expected double-quoted property name in JSON at position 15');
    const { res, next } = drive('/api/build?platform=android');
    await vi.waitFor(() => expect(res.writableEnded).toBe(true), { timeout: 5000 });
    expect(res.statuses().at(-1)).toBe('FAILED:android build\nExpected double-quoted property name in JSON at position 15');
    expect(next).not.toHaveBeenCalled();
    // The pipeline gave the slot back: a second build is not refused as already running.
    await vi.waitFor(() => {
      const again = acquireBuildSlot('probe', projectRoot);
      expect(again.ok).toBe(true);
      if (again.ok) again.release();
    });
  });

  it('/api/build: a throw between the SSE headers and the pipeline sends FAILED and frees the slot', async () => {
    stubs.buildNumbersThrows = new Error('build number source unreadable');
    const { res, next } = drive('/api/build?platform=android');
    await vi.waitFor(() => expect(res.writableEnded).toBe(true), { timeout: 5000 });
    expect(res.getHeader('Content-Type')).toBe('text/event-stream');
    expect(res.statuses().at(-1)).toBe('FAILED:Unexpected error\nbuild number source unreadable');
    expect(next).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      const again = acquireBuildSlot('probe', projectRoot);
      expect(again.ok).toBe(true);
      if (again.ok) again.release();
    });
  });

  it('/api/ota/publish: the CORS step\'s temp write failing after the build sends the publish\'s FAILED and ends', async () => {
    const noTmp = path.join(home, 'no-such-tmp-dir');
    setEnv('TMPDIR', noTmp);
    setEnv('TMP', noTmp);
    setEnv('TEMP', noTmp);
    const { res } = drive('/api/ota/publish?version=v1');
    await vi.waitFor(() => expect(res.writableEnded).toBe(true), { timeout: 5000 });
    const last = res.statuses().at(-1) ?? '';
    expect(last.startsWith('FAILED:OTA publish\n'), `last status: ${JSON.stringify(res.statuses())}`).toBe(true);
    expect(last).toContain('no-such-tmp-dir');
    // It got there by way of the build step, not a refusal before it.
    expect(res.statuses()).toContain('Verifying bucket CORS...');
  });
});

describe('#1259 close-out: a client that leaves during setup starts no job', () => {
  // The slot is released on `close` until the pipeline starts, and every route awaits setup in that
  // window. Before the fix the pipeline started anyway: the OTA route (whose abort listener is
  // registered AFTER its await) ran the build step and the upload holding no slot, and a native
  // build ran its in-process heal writes the same way.
  it.each([
    ['/api/ota/publish?version=v1'],
    ['/api/build?platform=android'],
    ['/api/add-native-target?platform=ios'],
  ])('%s', async (url) => {
    spawned.length = 0;
    healCalls.n = 0;
    scaffoldCalls.n = 0;
    pipelineStarts.length = 0;
    drive(url, { disconnectDuringSetup: true });
    // Setup has run and the route has ASKED to start and been refused — rather than a 50ms bet that
    // setup's await had finished (#1478). Under load the bet could end mid-setup, and the empty
    // `spawned` below would then pass whether or not the route checks at all. A route that starts
    // without asking never records an answer, and this times out red.
    await vi.waitFor(() => expect(pipelineStarts).toEqual([false]));
    expect(spawned).toEqual([]);
    expect(healCalls.n).toBe(0);
    expect(scaffoldCalls.n).toBe(0);
    const again = acquireBuildSlot('probe', projectRoot);
    expect(again.ok).toBe(true);
    if (again.ok) again.release();
  });
});

/** #1297: ffmpeg/ffprobe are looked for under `conversionToolchainDir()` even in a plain dev editor
 *  (no MODOKI_TOOLCHAIN_DIR), so Build Support reports them missing there — and must be able to
 *  install them there too, or the dialog's auto-install fails with advice that no longer applies. */
describe('/api/toolchain/install without MODOKI_TOOLCHAIN_DIR (#1297)', () => {
  beforeEach(() => {
    installs.length = 0;
    setEnv('MODOKI_TOOLCHAIN_DIR', undefined);
  });

  it('a pinned conversion CLI installs into the machine default dir', async () => {
    const { res } = drive('/api/toolchain/install?id=ffmpeg');
    await vi.waitFor(() => expect(res.writableEnded).toBe(true), { timeout: 5000 });
    expect(res.statuses().at(-1)).toBe('DONE');
    expect(installs).toEqual([{ id: 'ffmpeg', toolchainDir: conversionToolchainDir() }]);
  });

  it('an EMPTY MODOKI_TOOLCHAIN_DIR counts as unset, as it does for the resolver', async () => {
    setEnv('MODOKI_TOOLCHAIN_DIR', '');
    const { res } = drive('/api/toolchain/install?id=ffprobe');
    await vi.waitFor(() => expect(res.writableEnded).toBe(true), { timeout: 5000 });
    expect(res.statuses().at(-1)).toBe('DONE');
    expect(installs).toEqual([{ id: 'ffprobe', toolchainDir: conversionToolchainDir() }]);
  });

  // #1327: the native conversion CLIs are pinned the same way, so the same route must serve them.
  // Only where a pinned build exists for this host (none on Linux) — elsewhere it is not installable.
  for (const id of ['toktx', 'msdf-atlas-gen'] as const) {
    it.skipIf(!conversionCliDist(id))(`${id} installs into the machine default dir too (#1327)`, async () => {
      const { res } = drive(`/api/toolchain/install?id=${id}`);
      await vi.waitFor(() => expect(res.writableEnded).toBe(true), { timeout: 5000 });
      expect(res.statuses().at(-1)).toBe('DONE');
      expect(installs).toEqual([{ id, toolchainDir: conversionToolchainDir() }]);
    });
  }

  it('any other tool is still refused — a dev editor provisions no SDKs', async () => {
    const { res } = drive('/api/toolchain/install?id=gltfpack');
    await vi.waitFor(() => expect(res.writableEnded).toBe(true), { timeout: 5000 });
    expect(res.statuses().at(-1)).toBe('FAILED:No toolchain dir');
    expect(installs).toEqual([]);
  });
});

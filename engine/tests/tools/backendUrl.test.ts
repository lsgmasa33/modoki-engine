import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveBackend, repoRootForEntry, describeBackend, DEFAULT_BACKEND_URL } from '../../tools/shared/backendUrl';
import { backendUrlForClone, CLONE_BACKEND_PORTS } from '../../scripts/cloneBackendPorts.mjs';
import { readScannedSource } from '@modoki/engine/testing';

/**
 * #1894 — the MCP servers' backend when `.mcp.json` sets none: MODOKI_BACKEND if the environment
 * has it, else the pinned port of the clone the server's OWN FILE lives in, else the server's old
 * default. The clone paths below need not exist: the lookup keys on the directory's basename.
 */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const entry = (root: string, rel: string) => pathToFileURL(path.join(root, rel)).href;
const FALLBACK = 'http://127.0.0.1:5179';

describe('resolveBackend (#1894)', () => {
  it('with MODOKI_BACKEND unset, picks the clone\'s pinned port from the entry file — src (tsx) and dist (bundle) alike', () => {
    for (const rel of ['engine/tools/modoki-mcp/src/index.ts', 'engine/tools/modoki-mcp/dist/index.js', 'engine/tools/game-debug-mcp/src/backend.ts']) {
      const r = resolveBackend({ env: undefined, entryModuleUrl: entry('/work/modoki-ai2', rel), fallback: FALLBACK });
      expect(r).toEqual({ url: 'http://127.0.0.1:5181', source: 'clone', repoRoot: path.resolve('/work/modoki-ai2') });
    }
  });

  it('an EMPTY MODOKI_BACKEND counts as unset, as `${VAR:-default}` did', () => {
    const r = resolveBackend({ env: '', entryModuleUrl: entry('/work/modoki-qa', 'engine/tools/modoki-mcp/src/index.ts'), fallback: FALLBACK });
    expect(r.url).toBe('http://127.0.0.1:5183');
  });

  it('MODOKI_BACKEND still wins when set — a clone\'s settings.local.json env, or a Connect-written config', () => {
    const r = resolveBackend({ env: 'http://127.0.0.1:5999/', entryModuleUrl: entry('/work/modoki-ai2', 'engine/tools/modoki-mcp/src/index.ts'), fallback: FALLBACK });
    expect(r).toMatchObject({ url: 'http://127.0.0.1:5999', source: 'env' });
  });

  it('outside a clone (the packaged app\'s app.asar.unpacked) keeps the server\'s old default', () => {
    const r = resolveBackend({ env: undefined, entryModuleUrl: entry('/Applications/Modoki.app/Contents/Resources/app.asar.unpacked', 'engine/tools/modoki-mcp/dist/index.js'), fallback: 'http://localhost:5173' });
    expect(r).toMatchObject({ url: 'http://localhost:5173', source: 'default' });
  });

  it('outside a clone with no fallback passed, BOTH servers land on one derived default — the hub\'s port', () => {
    expect(DEFAULT_BACKEND_URL).toBe(`http://127.0.0.1:${CLONE_BACKEND_PORTS['modoki']}`);
    const r = resolveBackend({ env: undefined, entryModuleUrl: entry('/work/scratch-clone', 'engine/tools/modoki-mcp/src/index.ts') });
    expect(r).toMatchObject({ url: DEFAULT_BACKEND_URL, source: 'default' });
  });

  it('no server or harness supplies its own fallback — a literal there is how the two servers drifted apart (5173 vs 5179)', () => {
    const callers = ['engine/tools/modoki-mcp/src/index.ts', 'engine/tools/game-debug-mcp/src/backend.ts', 'engine/tools/modoki-mcp/test-live-tools.ts'];
    for (const rel of callers) {
      const code = readScannedSource(path.join(REPO_ROOT, rel)).code;
      expect(code, rel).toContain('resolveBackend(');
      // The bare word, not `fallback:` — a shorthand `{ …, fallback }` would slip past that.
      expect(code, rel).not.toMatch(/\bfallback\b/);
    }
    // The plain-node smoke harness cannot import the .ts, so it must name the same table entry.
    const smoke = readScannedSource(path.join(REPO_ROOT, 'engine/tools/modoki-mcp/test-smoke.mjs')).code;
    expect(smoke).toContain("CLONE_BACKEND_PORTS['modoki']");
    expect(smoke).not.toContain('localhost:5173');
  });

  it('a module URL it cannot map does not throw — the server must still start', () => {
    expect(resolveBackend({ env: undefined, entryModuleUrl: 'data:text/javascript,0', fallback: FALLBACK })).toMatchObject({ url: FALLBACK, source: 'default' });
  });

  it('the banner says where the URL came from', () => {
    expect(describeBackend({ url: 'http://127.0.0.1:5182', source: 'clone', repoRoot: '/r/modoki-ai3' })).toContain('derived from /r/modoki-ai3');
    expect(describeBackend({ url: 'http://x', source: 'env', repoRoot: null })).toContain('from MODOKI_BACKEND');
  });

  it('the entry depth matches THIS repo: a file directly in a server\'s src/ resolves to the repo root', () => {
    expect(repoRootForEntry(entry(REPO_ROOT, 'engine/tools/modoki-mcp/src/index.ts'))).toBe(REPO_ROOT);
  });
});

describe('game-debug-mcp resolves its backend from its REAL module location (#1894)', () => {
  const saved = process.env.MODOKI_BACKEND;
  afterEach(() => {
    if (saved === undefined) delete process.env.MODOKI_BACKEND; else process.env.MODOKI_BACKEND = saved;
    vi.resetModules();
  });

  it('MODOKI_BACKEND unset → this checkout\'s own clone port (or the old default outside a known clone)', async () => {
    delete process.env.MODOKI_BACKEND;
    vi.resetModules();
    const { BACKEND_RESOLUTION } = await import('../../tools/game-debug-mcp/src/backend');
    expect(BACKEND_RESOLUTION.repoRoot).toBe(REPO_ROOT);
    // This clone's answer differs per checkout (5182 here, 5179 on the hub, null in the public
    // snapshot), so assert it against the table rather than a literal.
    expect(BACKEND_RESOLUTION.url).toBe(backendUrlForClone(REPO_ROOT) ?? DEFAULT_BACKEND_URL);
  });

  it('MODOKI_BACKEND set → it wins', async () => {
    process.env.MODOKI_BACKEND = 'http://127.0.0.1:5998';
    vi.resetModules();
    const { BACKEND_RESOLUTION } = await import('../../tools/game-debug-mcp/src/backend');
    expect(BACKEND_RESOLUTION).toMatchObject({ url: 'http://127.0.0.1:5998', source: 'env' });
  });
});

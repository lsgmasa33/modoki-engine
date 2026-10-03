/**
 * The packaged editor writes no sidecar into its own bundle (B3 R6, #1656; #326, #1959).
 *
 * Packaged, the engine's built-in root is inside the signed app bundle. Observed in a dev editor before the fix: a 2D
 * text in the built-in Nunito font missed the font's atlas in the project's `.cache/`, the static server's auto-bake
 * reimported the font, and `writeMetaSidecar` rewrote the committed `Nunito-VariableFont_wght.ttf.meta.json` and added
 * a `.meta.local.json` beside it. In the packaged editor that write lands in the bundle and breaks its code signature.
 * The scan's GUID heals write there by the same route (`writeAssetGuid`).
 *
 * `findAssetRoots` now marks the built-in root read-only when MODOKI_PACKAGED is set. A sidecar write there is held in
 * memory (the serve path re-reads it to find the baked variant), and a GUID heal there is refused.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';
import { serveProjectAsset } from '../../plugins/backend/staticAssets';
import { registerReimportHandler } from '../../plugins/reimport-registry';
import { textureReimportHandler } from '../../plugins/reimport-texture';
import {
  inReadOnlySidecarRoot, markSidecarRootReadOnly, readMetaSidecar, resetReadOnlySidecarRoots, writeMetaSidecar,
} from '../../plugins/meta-sidecar';
import { findAssetRoots, scanDevManifest, ENGINE_ASSETS_URL_PREFIX } from '../../plugins/vite-asset-scanner';

const G = 'aaaaaaaa-1111-4111-8111-111111111111';

let root: string;
let engine: string;
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  root = makeScratchDir('modoki-b3-r6-');
  engine = path.join(root, 'engine-assets');
  fs.mkdirSync(engine, { recursive: true });
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  resetReadOnlySidecarRoots();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function builtinTexture(): Promise<string> {
  const abs = path.join(engine, 'favicon.png');
  const sharp = (await import('sharp')).default;
  await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 10, g: 200, b: 40, alpha: 1 } } }).png().toFile(abs);
  fs.writeFileSync(abs + '.meta.json', JSON.stringify({ id: G, version: 2, type: '2d' }, null, 2) + '\n');
  return abs;
}

describe('a variant cache miss on a packaged built-in (B3 R6)', () => {
  const ctx = () => ({
    projectRoot: root,
    editorRoot: root,
    autoConvert: true,
    resolveAssetPath: (u: string) => u.startsWith(ENGINE_ASSETS_URL_PREFIX + '/')
      ? path.join(engine, u.slice(ENGINE_ASSETS_URL_PREFIX.length + 1))
      : path.join(root, u.replace(/^\//, '')),
  });

  it('bakes into the project cache and serves it, and leaves the bundle bytes alone', async () => {
    registerReimportHandler('texture', textureReimportHandler);
    const abs = await builtinTexture();
    const before = fs.readFileSync(abs + '.meta.json', 'utf-8');
    markSidecarRootReadOnly(engine);
    const res = await serveProjectAsset(ctx(), `${ENGINE_ASSETS_URL_PREFIX}/favicon.png~webp.webp`);
    expect(res?.kind).toBe('file');
    expect(fs.readFileSync(abs + '.meta.json', 'utf-8')).toBe(before);
    expect(fs.readdirSync(engine).sort()).toEqual(['favicon.png', 'favicon.png.meta.json']);
    // The record the bake would have written is what the next request (and the next scan) reads.
    expect((readMetaSidecar(abs).textureCache as { hash?: string }).hash).toMatch(/\w/);
    expect(readMetaSidecar(abs).id).toBe(G);
  }, 30_000);

  it('a root nobody marked is written as before (a dev clone)', async () => {
    const abs = await builtinTexture();
    writeMetaSidecar(abs, { id: G, type: '2d', textureCache: { hash: 'h1', variants: ['webp'] } });
    expect(JSON.parse(fs.readFileSync(abs + '.meta.json', 'utf-8')).textureCache.hash).toBe('h1');
  });
});

describe('the scan heals in a packaged built-in root (B3 R6)', () => {
  it('refuses the missing-id heal there, and still heals the project', () => {
    const project = path.join(root, 'assets');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(engine, 'bare.png'), 'pretend-png');
    fs.writeFileSync(path.join(project, 'bare.png'), 'pretend-png');
    markSidecarRootReadOnly(engine);
    scanDevManifest(
      [{ urlPrefix: ENGINE_ASSETS_URL_PREFIX, absDir: engine }, { urlPrefix: '/assets', absDir: project }],
      { storeDir: path.join(root, 'store'), now: 1 },
    );
    expect(fs.existsSync(path.join(engine, 'bare.png.meta.json'))).toBe(false);
    expect(fs.existsSync(path.join(project, 'bare.png.meta.json'))).toBe(true);
    expect(warn.mock.calls.some((c: unknown[]) => /read-only built-in root/.test(String(c[0])))).toBe(true);
  });
});

describe('findAssetRoots marks the built-in root read-only only when packaged (B3 R6)', () => {
  const builtinOf = (projectRoot: string) => findAssetRoots(projectRoot).find((r) => r.urlPrefix === ENGINE_ASSETS_URL_PREFIX)!.absDir;
  // A pure check, not a write: the real built-in root is the engine repo, and a live editor watches it.
  const probe = (dir: string) => !inReadOnlySidecarRoot(path.join(dir, 'fonts', 'x.ttf'));

  it('packaged: the built-in root is read-only', () => {
    vi.stubEnv('MODOKI_PACKAGED', '1');
    const dir = builtinOf(root);
    expect(probe(dir)).toBe(false);
  });

  it('dev: the built-in root is the engine repo and stays writable', () => {
    vi.stubEnv('MODOKI_PACKAGED', '');
    const dir = builtinOf(root);
    expect(probe(dir)).toBe(true);
  });
});

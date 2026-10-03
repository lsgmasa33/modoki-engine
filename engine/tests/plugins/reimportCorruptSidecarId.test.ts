/**
 * A reimport over a sidecar that does not parse keeps the asset's GUID when the `id` line survived (B3 R11, #1656).
 *
 * `readMetaSidecar` answers `{}` for a corrupt sidecar, just as for a missing one, and every binary reimport handler
 * minted a fresh `id` whenever its read came back id-less. `writeMetaSidecar` salvages the old id only when its caller
 * supplied none, so a merge conflict anywhere in a texture's sidecar re-minted the texture on its next reimport, and
 * every scene and prefab reference to it dangled. The handlers now take the id from `reimportSidecarId`.
 *
 * The texture handler runs for real here (sharp-built PNG, the real conversion): it is the one every other handler
 * copied the mint from, and the source guard below holds the other five to the same helper.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';
import { textureReimportHandler } from '../../plugins/reimport-texture';
import { reimportSidecarId } from '../../plugins/meta-sidecar';
import { clearManifest, registerAsset } from '../../packages/modoki/src/runtime/loaders/assetManifest';
import { guidToKeep } from '../../packages/modoki/src/editor/scene/guidToKeep';
import { readScannedSource } from '@modoki/engine/testing';

const G = 'aaaaaaaa-1111-4111-8111-111111111111';
const S0 = 'bbbbbbbb-2222-4222-8222-222222222222';
const sidecar = (id = G) => JSON.stringify({
  id, version: 2, spriteSheet: { width: 16, height: 16 },
  sprites: [{ guid: S0, name: 's', rect: { x: 0, y: 0, w: 8, h: 8 }, pivot: { x: 0.5, y: 0.5 } }],
}, null, 2);
/** What a git merge leaves when two clones moved the same slice: the `id` line is common, the rect conflicts. */
const conflicted = (text: string) => text.replace('"x": 0,', '<<<<<<< HEAD\n        "x": 0,\n=======\n        "x": 8,\n>>>>>>> work-ai');

let warn: ReturnType<typeof vi.spyOn> | undefined;
afterEach(() => { warn?.mockRestore(); warn = undefined; });

async function scratchTexture(sidecarText: string): Promise<{ root: string; abs: string }> {
  const root = makeScratchDir('modoki-b3-r11-');
  const abs = path.join(root, 'assets', 't.png');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const sharp = (await import('sharp')).default;
  await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 200, g: 40, b: 40, alpha: 1 } } }).png().toFile(abs);
  fs.writeFileSync(abs + '.meta.json', sidecarText);
  return { root, abs };
}
const reimport = (root: string, abs: string) =>
  textureReimportHandler('/assets/t.png', abs, { projectRoot: root, resolveAssetPath: (u) => path.join(root, u) });
const idOnDisk = (abs: string) => JSON.parse(fs.readFileSync(abs + '.meta.json', 'utf-8')).id as string;

describe('a reimport over a corrupt sidecar (B3 R11)', () => {
  it('keeps the GUID a merge conflict left readable, and still quarantines the damaged file', async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { root, abs } = await scratchTexture(conflicted(sidecar()));
    await reimport(root, abs);
    expect(idOnDisk(abs)).toBe(G);
    expect(fs.readFileSync(abs + '.meta.json.corrupt', 'utf-8')).toContain('<<<<<<<');
  }, 30_000);

  it('mints a fresh GUID when the damaged sidecar carries none it can recover (rule 11)', async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { root, abs } = await scratchTexture('{ "version": 2, <<<<<<< HEAD');
    await reimport(root, abs);
    expect(idOnDisk(abs)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }, 30_000);

  it('the id the handler read wins over the one on disk', () => {
    const root = makeScratchDir('modoki-b3-r11-');
    const abs = path.join(root, 't.png');
    fs.writeFileSync(abs + '.meta.json', conflicted(sidecar()));
    const other = 'cccccccc-3333-4333-8333-333333333333';
    expect(reimportSidecarId({ id: other }, abs)).toBe(other);
    expect(reimportSidecarId({}, abs)).toBe(G);
  });

  // Source guard for the handlers this file cannot run (audio, video and font need ffmpeg or a font toolchain;
  // environment and model need fixtures far heavier than the mint they share): none may mint its own `id`.
  it('no reimport handler mints its own id', () => {
    const dir = path.resolve(__dirname, '../../plugins');
    const handlers = fs.readdirSync(dir).filter((n) => /^reimport-.*\.ts$/.test(n) && n !== 'reimport-registry.ts');
    const minting = handlers.filter((n) => /\bmeta\.id\s*=(?!=)\s*(?!\s|reimportSidecarId\(|src\.id\b)/.test(readScannedSource(path.join(dir, n)).code));
    expect(handlers.length).toBeGreaterThanOrEqual(7);
    expect(minting).toEqual([]);
  });

  // The renderer's model import reads the GLB's sidecar through `/api/read-meta`, which answers `{}` for a corrupt one
  // too. It used to mint on that, so dragging a GLB with a conflict-marked sidecar into a scene re-minted the model
  // (opus-reviewer, #2071). It keeps the manifest's id instead, which the scan salvaged.
  describe("the renderer's model import", () => {
    afterEach(() => clearManifest());

    it('keeps the id the manifest holds when the sidecar read came back id-less', () => {
      registerAsset(G, '/assets/hero.glb', 'model');
      expect(guidToKeep(undefined, '/assets/hero.glb')).toBe(G);
      const other = 'cccccccc-3333-4333-8333-333333333333';
      expect(guidToKeep(other, '/assets/hero.glb')).toBe(other);
      expect(guidToKeep(undefined, '/assets/new.glb')).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('both GLB import paths (static and rigged) take their id from guidToKeep', () => {
      const src = readScannedSource(path.resolve(__dirname, '../../packages/modoki/src/editor/scene/modelImport.ts')).code;
      expect(src.match(/const glbGuid = guidToKeep\(\w+\.id, glbPath\);/g)).toHaveLength(2);
    });
  });
});


/** The two KTX2 transcoder pairs every build that renders KTX2 ships: three.js's Basis transcoder
 *  (`KTX2Loader`, 3D textures) and PixiJS's libktx (`loadKTX2`, 2D sprites). Each pair is copied out
 *  of `node_modules` under its FIXED file names, because the loaders ask for those names.
 *
 *  A fixed name is a stale-cache hazard on a published web build (#1586): the CDN in front of
 *  modoki-engine.com caches non-HTML/JSON files for a day, so after a three/pixi bump a returning
 *  visitor or an edge can pair the OLD `.js` with the NEW `.wasm` and every KTX2 texture fails to
 *  decode. So each pair also has a VERSION — one content hash over both of its files — which the
 *  runtime appends as `?v=<version>` (the engine's cache-bust convention, like textures, fonts, the
 *  favicon and the boot splash). One hash per PAIR, so the `.js` and `.wasm` URLs always move together.
 *
 *  The copy ({@link shipTranscoders}), the version ({@link transcoderVersions}) and the dev backend
 *  (`backend/staticAssets.ts`) all resolve the source through {@link transcoderSourceDir}, so the
 *  version cannot describe different bytes from the ones shipped. */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const TRANSCODERS = {
  basis: {
    src: 'node_modules/three/examples/jsm/libs/basis',
    files: ['basis_transcoder.js', 'basis_transcoder.wasm'],
    out: 'basis',
  },
  pixiKtx: {
    src: 'node_modules/pixi.js/transcoders/ktx',
    files: ['libktx.js', 'libktx.wasm'],
    out: 'pixi-ktx',
  },
} as const;

export type TranscoderKey = keyof typeof TRANSCODERS;
export type TranscoderVersions = Record<TranscoderKey, string>;

/** The first of `roots` whose `node_modules` holds this transcoder. The project is tried before the
 *  editor: a FLAT in-repo project (games/<id>) has no node_modules of its own — three and pixi live
 *  at the editor/repo root — so without the fallback the build ships no transcoder and every KTX2
 *  texture 404s. */
export function transcoderSourceDir(key: TranscoderKey, roots: readonly string[]): string | undefined {
  return roots.map((r) => path.join(r, TRANSCODERS[key].src)).find((p) => fs.existsSync(p));
}

/** Which pair a served URL path names (`/basis/basis_transcoder.js`, `/pixi-ktx/libktx.wasm`, …),
 *  or `undefined`. Exact match only — the dev backend serves these four paths and nothing else. */
export function transcoderForUrl(urlPath: string): TranscoderKey | undefined {
  return (Object.keys(TRANSCODERS) as TranscoderKey[]).find((k) =>
    (TRANSCODERS[k].files as readonly string[]).some((f) => urlPath === `/${TRANSCODERS[k].out}/${f}`));
}

/** One content hash over a pair's files (name + bytes, in a fixed order), 16 hex chars. `''` when
 *  the transcoder is not installed — the runtime then requests the bare URL. */
export function transcoderVersion(key: TranscoderKey, roots: readonly string[]): string {
  const dir = transcoderSourceDir(key, roots);
  if (!dir) return '';
  const h = createHash('sha256');
  for (const f of TRANSCODERS[key].files) {
    const p = path.join(dir, f);
    h.update(f).update('\0');
    if (fs.existsSync(p)) h.update(fs.readFileSync(p));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

export function transcoderVersions(roots: readonly string[]): TranscoderVersions {
  return { basis: transcoderVersion('basis', roots), pixiKtx: transcoderVersion('pixiKtx', roots) };
}

/** The value `vite.config.ts` bakes into `__MODOKI_TRANSCODER_VERSIONS__`. Blank in the editor
 *  (served live from node_modules, no CDN) and in a playable (ships no transcoder), so those keep
 *  bare URLs; every other build — web, native, OTA — gets the real versions. A function rather than
 *  an inline ternary so the condition itself is tested: blanking it would put every published build
 *  back on bare, day-cached URLs with nothing else going red. */
export function transcoderDefine(
  build: { editor: boolean; playable: boolean },
  roots: readonly string[],
): TranscoderVersions {
  return build.editor || build.playable ? { basis: '', pixiKtx: '' } : transcoderVersions(roots);
}

/** Copy both pairs into `<distDir>/basis` and `<distDir>/pixi-ktx`. Needed by every build that
 *  renders KTX2 — the game web build and the editor build alike. A pair that is not installed is
 *  skipped. */
export function shipTranscoders(distDir: string, roots: readonly string[]): void {
  for (const key of Object.keys(TRANSCODERS) as TranscoderKey[]) {
    const src = transcoderSourceDir(key, roots);
    if (!src) continue;
    const dest = path.join(distDir, TRANSCODERS[key].out);
    fs.mkdirSync(dest, { recursive: true });
    for (const f of TRANSCODERS[key].files) {
      const s = path.join(src, f);
      if (fs.existsSync(s)) fs.copyFileSync(s, path.join(dest, f));
    }
  }
}

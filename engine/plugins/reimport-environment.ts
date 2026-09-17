/** Environment (HDR) reimport handler — reads import settings from the meta sidecar,
 *  produces the variant the settings' `format` names, and persists the cache bookkeeping
 *  back to the meta. Registered for the `environment` asset type.
 *
 *  This is the ONLY place an environment is converted from an explicit action: the
 *  Environment Inspector's Apply, the Assets-panel re-import and `modoki_reimport_asset`
 *  all arrive here through `/api/reimport` (#1314 — the ultrahdr encode used to run in the
 *  renderer, so the other two ran the `hdr` downscale on an `ultrahdr` asset and stamped
 *  its stats into `environmentCache`).
 *  - `hdr` → the downscaled `~env.hdr` in the gitignored content cache.
 *  - `ultrahdr` → the `~ultrahdr.jpg` gainmap written NEXT TO THE SOURCE and committed
 *    (the build copies it rather than re-encoding — `vite-asset-scanner.ts`). */

import fs from 'fs';
import { randomUUID } from 'crypto';
import { resolveEnvSettings, ULTRAHDR_VARIANT_SUFFIX } from '../packages/modoki/src/runtime/core/environmentSettings';
import { convertEnvironment } from './env-convert';
import { convertEnvironmentUltraHdr } from './env-ultrahdr';
import { assertSidecarWritable, readMetaSidecar, writeMetaSidecar } from './meta-sidecar';
import type { ReimportHandler } from './reimport-registry';

export const environmentReimportHandler: ReimportHandler = async (sourceUrlPath, absPath, ctx) => {
  // ⚠️ Refuse BEFORE converting, not at `writeMetaSidecar` (#1314 close-out). The ultrahdr branch
  // overwrites a COMMITTED file, so a sidecar we then could not write (too new) would leave new
  // bytes under the old committed `hash` — and that hash is the prod `?v=` cache-bust.
  // `/api/reimport` pre-checks this; the static server's on-demand bake does not.
  assertSidecarWritable(absPath);
  const meta = readMetaSidecar(absPath);
  const settings = resolveEnvSettings(meta as { environment?: Record<string, unknown> });
  let cache: Record<string, unknown>;
  if (settings.format === 'ultrahdr') {
    const { bytes, hash } = await convertEnvironmentUltraHdr(absPath);
    // tmp + rename: the build copies this file and cannot regenerate it, so an interrupted
    // write must not leave a truncated one in its place.
    const variant = absPath + ULTRAHDR_VARIANT_SUFFIX;
    const tmp = variant + '.tmp';
    try {
      fs.writeFileSync(tmp, bytes);
      fs.renameSync(tmp, variant);
    } catch (e) {
      fs.rmSync(tmp, { force: true }); // not gitignored next to a source asset
      throw e;
    }
    // The whole block is replaced, so an `hdr` conversion's width/height/srcWidth/srcHeight
    // cannot survive a format switch and describe a file this block no longer points at.
    cache = { hash, bytes: bytes.length };
  } else {
    const result = await convertEnvironment({
      projectRoot: ctx.projectRoot,
      sourceUrlPath,
      absSource: absPath,
      settings,
    });
    cache = {
      hash: result.hash,
      width: result.width,
      height: result.height,
      srcWidth: result.srcWidth,
      srcHeight: result.srcHeight,
      bytes: result.bytes,
    };
  }
  if (typeof meta.id !== 'string') meta.id = randomUUID();
  meta.environment = settings;
  meta.environmentCache = cache;
  writeMetaSidecar(absPath, meta);
};

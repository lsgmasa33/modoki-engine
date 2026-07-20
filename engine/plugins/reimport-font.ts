/** Font reimport handler — reads import settings from the meta sidecar, bakes the
 *  source `.ttf`/`.otf` into an mtsdf atlas + Chlumsky metrics via msdf-atlas-gen,
 *  and persists the cache bookkeeping back to the meta. Registered for the `font`
 *  asset type. Minting a GUID here is what makes a baked font GUID-referenceable
 *  (a plain CSS-family-name font never goes through this path, so it stays
 *  guid-less and is referenced by `fontFamily` instead). */

import { randomUUID } from 'crypto';
import { resolveFontSettings, type FontImportSettings } from '../packages/modoki/src/runtime/loaders/fontSettings';
import { convertFont } from './font-convert';
import { readMetaSidecar, writeMetaSidecar } from './meta-sidecar';
import type { ReimportHandler } from './reimport-registry';

export const fontReimportHandler: ReimportHandler = async (sourceUrlPath, absPath, ctx) => {
  const meta = readMetaSidecar(absPath);
  const settings = resolveFontSettings(meta as { font?: Partial<FontImportSettings> });
  const result = await convertFont({
    projectRoot: ctx.projectRoot,
    sourceUrlPath,
    absSource: absPath,
    settings,
  });
  if (typeof meta.id !== 'string') meta.id = randomUUID();
  meta.version = 2;
  meta.font = settings;
  meta.fontCache = {
    hash: result.hash,
    ...(result.atlasWidth != null ? { atlasWidth: result.atlasWidth } : {}),
    ...(result.atlasHeight != null ? { atlasHeight: result.atlasHeight } : {}),
    ...(result.glyphCount != null ? { glyphCount: result.glyphCount } : {}),
    ...(result.bytes != null ? { bytes: result.bytes } : {}),
  };
  writeMetaSidecar(absPath, meta);
};

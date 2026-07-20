/** Texture reimport handler — reads import settings from the meta sidecar,
 *  converts the source into its derived variants, and persists the cache
 *  bookkeeping back to the meta. Registered for the `texture` asset type. */

import { randomUUID } from 'crypto';
import { resolveTextureSettings, resolveTextureType, type TextureType } from '../packages/modoki/src/runtime/loaders/textureSettings';
import { convertTexture } from './texture-convert';
import { readMetaSidecar, writeMetaSidecar } from './meta-sidecar';
import type { ReimportHandler } from './reimport-registry';

// Re-export so existing imports (`./reimport-texture`'s readMetaSidecar) keep
// working without touching every caller.
export { readMetaSidecar } from './meta-sidecar';

export const textureReimportHandler: ReimportHandler = async (sourceUrlPath, absPath, ctx) => {
  const meta = readMetaSidecar(absPath);
  const typedMeta = meta as { type?: TextureType; texture?: Record<string, unknown> };
  const type = resolveTextureType(typedMeta);
  const settings = resolveTextureSettings(typedMeta);
  const result = await convertTexture({
    projectRoot: ctx.projectRoot,
    sourceUrlPath,
    absSource: absPath,
    settings,
    textureType: type, // 2d/ui → also emit a WebP browser sibling for editor/DOM
  });
  if (typeof meta.id !== 'string') meta.id = randomUUID();
  meta.version = 2;
  // Stamp the resolved type explicitly so legacy textures gain one on first
  // re-import (the scanner + validation key off `meta.type`).
  meta.type = type;
  meta.texture = settings;
  meta.textureCache = {
    hash: result.hash,
    variants: result.variants,
    width: result.width,
    height: result.height,
    srcWidth: result.srcWidth,
    srcHeight: result.srcHeight,
    mipLevels: result.mipLevels,
    variantBytes: result.variantBytes,
  };
  writeMetaSidecar(absPath, meta);
};

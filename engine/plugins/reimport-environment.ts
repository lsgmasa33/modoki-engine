/** Environment (HDR) reimport handler — reads import settings from the meta
 *  sidecar, downscales the source HDR into the `~env.hdr` variant, and persists the
 *  cache bookkeeping back to the meta. Registered for the `environment` asset type. */

import { randomUUID } from 'crypto';
import { resolveEnvSettings } from '../packages/modoki/src/runtime/loaders/environmentSettings';
import { convertEnvironment } from './env-convert';
import { readMetaSidecar, writeMetaSidecar } from './meta-sidecar';
import type { ReimportHandler } from './reimport-registry';

export const environmentReimportHandler: ReimportHandler = async (sourceUrlPath, absPath, ctx) => {
  const meta = readMetaSidecar(absPath);
  const settings = resolveEnvSettings(meta as { environment?: Record<string, unknown> });
  const result = await convertEnvironment({
    projectRoot: ctx.projectRoot,
    sourceUrlPath,
    absSource: absPath,
    settings,
  });
  if (typeof meta.id !== 'string') meta.id = randomUUID();
  meta.version = 2;
  meta.environment = settings;
  meta.environmentCache = {
    hash: result.hash,
    width: result.width,
    height: result.height,
    srcWidth: result.srcWidth,
    srcHeight: result.srcHeight,
    bytes: result.bytes,
  };
  writeMetaSidecar(absPath, meta);
};

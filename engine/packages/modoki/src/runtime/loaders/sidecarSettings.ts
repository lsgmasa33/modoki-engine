/** The committed `.meta.json` sidecar's content-cache blocks, and the comparison of two sidecars' IMPORT SETTINGS.
 *
 *  Defined here, beside the settings resolvers, rather than in `plugins/meta-sidecar.ts` (which re-exports both), so the
 *  engine package's own tests can share them (#1696). Pure — no filesystem — and reached only by the build plugins and
 *  tests. */

import { resolveTextureSettings, resolveTextureType } from './textureSettings';
import { resolveModelSettings } from './modelSettings';
import { resolveAudioSettings } from './audioSettings';
import { resolveVideoSettings } from './videoSettings';
import { resolveFontSettings } from '../core/fontSettings';
import { resolveEnvSettings } from '../core/environmentSettings';

/** Content-cache blocks whose contents are split between the COMMITTED sidecar and this machine's
 *  gitignored one. Being listed here does NOT mean "peel everything" — what gets peeled is decided
 *  per block by `LOCAL_KEYS` (plugins/meta-sidecar.ts). */
export const CACHE_BLOCKS = ['textureCache', 'modelCache', 'fontCache', 'audioCache', 'environmentCache', 'atlasCache', 'videoCache'] as const;
export type CacheBlock = (typeof CACHE_BLOCKS)[number];

/** Keys a sidecar gets written with no user action: the GUID the scanner heals, the format stamp every write adds,
 *  and each bake's content cache. {@link sameImportSettings} ignores them. */
const SELF_WRITTEN_KEYS: ReadonlySet<string> = new Set(['id', 'version', ...CACHE_BLOCKS]);

/** The settings blocks a bake REWRITES with resolved defaults (`meta.texture = resolveTextureSettings(meta)`, and so
 *  on in each `reimport-*.ts`), with the resolver it uses. {@link sameImportSettings} compares these through the
 *  resolver, so a bake filling in defaults compares equal to the sidecar before it. ⚠️ Every settings key a bake
 *  writes must be here — `metaSidecarSettings.test.ts` reads the handlers' `meta.<key> =` writes and fails on one
 *  that is in neither this list nor {@link SELF_WRITTEN_KEYS}. */
const BAKE_RESOLVED: ReadonlyArray<{ keys: readonly string[]; resolve: (meta: Record<string, unknown>) => unknown }> = [
  { keys: ['texture', 'type'], resolve: (m) => ({ texture: resolveTextureSettings(m), type: resolveTextureType(m) }) },
  { keys: ['model'], resolve: (m) => resolveModelSettings(m) },
  { keys: ['audio'], resolve: (m) => resolveAudioSettings(m) },
  { keys: ['video'], resolve: (m) => resolveVideoSettings(m) },
  { keys: ['font'], resolve: (m) => resolveFontSettings(m) },
  { keys: ['environment'], resolve: (m) => resolveEnvSettings(m) },
];

/** Every key a bake writes on its own — for the test that keeps {@link BAKE_RESOLVED} complete. */
export const BAKE_WRITABLE_KEYS: ReadonlySet<string> = new Set([...SELF_WRITTEN_KEYS, ...BAKE_RESOLVED.flatMap((b) => b.keys)]);

/** JSON text with object keys sorted — equal for two values that serialise to the same document in any key order. */
function canonicalJson(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : x)) ?? 'undefined';
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Do two COMMITTED sidecar documents hold the same import settings (#1696)? The precondition an undo/redo states
 *  when it trashes a binary asset's `.meta.json`, which is where that asset's import settings live.
 *
 *  Not a byte compare, and not a raw compare of the settings either, because a sidecar is rewritten with nobody
 *  editing anything: the scanner heals `id`, every write stamps `version`, every bake rewrites its `*Cache` block —
 *  and **every bake also rewrites its settings block with resolved defaults**. So:
 *   - {@link SELF_WRITTEN_KEYS} are ignored;
 *   - each {@link BAKE_RESOLVED} block present on EITHER side is compared through its bake's resolver, so an
 *     unbaked `{texture:{maxSize:512}}` equals the baked `{type:'2d', texture:{maxSize:512, …defaults}}`, while a
 *     changed value does not;
 *   - every other key (sprites, border, postprocessor, rig, generated, …) is compared as a document, key order
 *     ignored.
 *  Either side not an object → false. The `.meta.local.json` half is never part of it: it holds only cache stats. */
export function sameImportSettings(expected: unknown, onDisk: unknown): boolean {
  if (!isRecord(expected) || !isRecord(onDisk)) return false;
  const rest = new Set([...Object.keys(expected), ...Object.keys(onDisk)]);
  for (const k of SELF_WRITTEN_KEYS) rest.delete(k);
  for (const { keys, resolve } of BAKE_RESOLVED) {
    if (!keys.some((k) => k in expected || k in onDisk)) continue;
    for (const k of keys) rest.delete(k);
    if (canonicalJson(resolve(expected)) !== canonicalJson(resolve(onDisk))) return false;
  }
  for (const k of rest) if (canonicalJson(expected[k]) !== canonicalJson(onDisk[k])) return false;
  return true;
}

/** makeTexture2D — the "Make 2D" fix action offered by the SpritePicker's
 *  spriteless-texture section (#293). A texture imported with the default
 *  `format: 'ktx2-uastc'` resolves to `textureType: '3d'`, and the asset scanner
 *  only auto-emits the whole-image `#default` sprite for a `2d`/`ui` texture — so
 *  a 3D-typed texture has no sprite to assign anywhere, silently.
 *
 *  Writing `type: '2d'` into the meta alone does not fix that: the sprite is
 *  minted by the RE-IMPORT (`/api/reimport`), not by the meta write, so this
 *  action does both — mirroring `changeType` + the Apply button in
 *  `TextureAssetView.tsx`, collapsed into one call so the picker doesn't have to
 *  walk the user through Inspector → Type → Apply for a fix that has only one
 *  reasonable outcome. */

import { backendFetch } from '../backend/editorBackend';
import { deriveSettingsForType, type TextureImportSettings } from '../../runtime/loaders/textureSettings';
import { invalidateTexture } from '../../runtime/loaders/textureResolver';
import { writeMetaOrWarn } from './assetViews/widgets';

/** Sets a texture's type to `2d` and re-imports it so it gets a whole-image
 *  sprite. Resolves `true` on success; the caller (SpritePicker) is responsible
 *  for `refreshAssets()` afterward. */
export async function makeTexture2D(path: string): Promise<boolean> {
  // ⚠️ A FAILED READ MUST ABORT — it must never fall back to `{}`.
  //
  // `/api/write-meta` → `writeMetaSidecar` overwrites the sidecar WHOLESALE; it does not
  // merge with what is on disk. So spreading an empty object would write a sidecar with no
  // `id`, and the scanner's "heal MISSING guids" pass (`vite-asset-scanner.ts`) then MINTS A
  // NEW GUID and persists it — silently orphaning every scene/prefab ref to the old one. A
  // transient 500 on the read would therefore destroy the asset's identity, and `sprites` /
  // `textureCache` with it. This is a `return false`, not a best-effort continue.
  //
  // Requiring `res.ok` costs nothing, because the route is explicit about every failure
  // (F10): bad path 400, outside-root 403, missing asset 404 — so an ok response carrying
  // `{}` unambiguously means "this asset exists and simply has no sidecar yet", which is a
  // safe thing to spread.
  const metaRes = await backendFetch(`/api/read-meta?path=${encodeURIComponent(path)}`).catch(() => null);
  if (!metaRes || !metaRes.ok) {
    console.error(`[SpritePicker] could not read the meta for ${path} (${metaRes ? metaRes.status : 'network error'}) — not converting, because overwriting the sidecar from a failed read would discard its GUID.`);
    return false;
  }
  const meta = await metaRes.json().catch(() => null);
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    console.error(`[SpritePicker] the meta for ${path} did not parse as an object — not converting (see above).`);
    return false;
  }

  // Carry the authored knobs that are NOT derived from the type. `changeType` in
  // TextureAssetView resets the whole codec block, and that is right THERE — the user is
  // looking at the texture's own settings in the Inspector and can see what moved. Here the
  // click comes from a list of every spriteless texture in the project (130 of them in
  // `demos/forest-camp`), so the same wholesale reset silently destroys authored intent on
  // whatever was clicked: a normal map's `colorspace:'linear'` forced back to `'srgb'` is
  // gamma-decoded data — wrong lighting, no error. `flipY`/`flipGreen`/`maxSize` and the
  // encoder knobs are likewise orthogonal to 2d-vs-3d, so they ride along.
  //
  // `format`/`mipmaps`/`wrapS`/`wrapT` are dropped on purpose: those four ARE the type's
  // meaning (no mips, clamped — see `deriveSettingsForType`), and preserving them would make
  // the button a no-op that claims to have converted something.
  const prior = (meta as { texture?: Partial<TextureImportSettings> }).texture ?? {};
  const { format: _format, mipmaps: _mipmaps, wrapS: _wrapS, wrapT: _wrapT, ...carried } = prior;
  const updatedMeta = { ...meta, version: 2, type: '2d', texture: deriveSettingsForType('2d', carried) };
  const wrote = await writeMetaOrWarn(path, updatedMeta);
  if (!wrote) return false;

  const res = await backendFetch('/api/reimport', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  const summary = await res.json().catch(() => ({}));
  if (!res.ok || (summary.errors && summary.errors.length)) {
    console.error(`[SpritePicker] texture re-import failed for ${path}:`, summary.errors ?? summary);
    return false;
  }

  invalidateTexture(path);
  return true;
}

/** How many assets reference this texture, or `null` when the answer is unknown
 *  (endpoint missing, error, malformed body).
 *
 *  Used to qualify the SpritePicker's "Make 2D" confirm: converting a texture a 3D
 *  material samples is what makes the button destructive, and `/api/find-references`
 *  already computes the reverse reference graph the Find References dialog renders. One
 *  call for the ONE armed row — never for the whole list, which routinely runs to 130+.
 *
 *  `null` is deliberately distinct from `0`: "unused" is a claim strong enough to make a
 *  user click through, and a failed lookup must not be able to make it. The caller shows
 *  nothing on `null` rather than reassuring on no evidence. */
export async function textureRefCount(target: string): Promise<number | null> {
  try {
    const res = await backendFetch(`/api/find-references?target=${encodeURIComponent(target)}`);
    const j = (await res.json()) as { totalCount?: number; error?: string };
    if (!res.ok || j.error || typeof j.totalCount !== 'number') return null;
    return j.totalCount;
  } catch {
    return null;
  }
}

/** The ONE decision "may this resolved entity aim be acted on, and if not, what does the refusal
 *  say" — shared by the editor's host input routes (`electron/inputRoutes.ts` `resolvePoint`) and the
 *  device page (`bridge.ts` `resolveAim`), #1223 P3.
 *
 *  Both call `resolve-entity-point` and then have to make the same two calls on its answer: a
 *  resolution that failed is refused with the resolver's code, options and `stale`, and a point that
 *  something COVERS is refused `OCCLUDED` unless the caller passed `allowOccluded` (§3: a resolvable
 *  aim names a thing, so a press landing on something else is a failed intent). The editor had both
 *  calls inline; the device had neither, because it had no entity aim. Written twice, the two would
 *  drift the way §9 predicts — so the device reuses the editor's code rather than restating it.
 *
 *  DOM-free on purpose: the Electron main process imports it, and its tsconfig has no `dom` lib (the
 *  same rule as `entityPointContract.ts`). The #261 settling hint is the editor route's alone: it
 *  samples the editor's dock chrome, which a shipped game does not have. */

import { NOTHING_AT_POINT } from './domPointContract';
import type { EntityPointResolution } from './entityPointContract';
import type { ErrorCode } from '../../tools/shared/mcpResult';

/** A refused aim: the message plus the §5 fields a caller relays verbatim. */
export interface AimRefusal {
  error: string;
  code?: ErrorCode;
  /** The real choices — an ambiguous name's guids, the guid to use instead of an `{id}`. */
  options?: string[];
  /** Why a runtime guid missed (`'despawned'` | `'world-swapped'`), on a `NOT_FOUND`. */
  stale?: string;
}

/** A resolution that may be acted on — its point narrowed to numbers. */
export type AimableEntityPoint = EntityPointResolution & { ok: true; x: number; y: number };

/** Accept the resolution (`{point}`) or refuse it (`{refusal}`). `which` prefixes the message (`tap`,
 *  `from`, `pointer down`); `allowOccluded` is the value ALREADY sent to the resolver, so the picker's
 *  check and this DOM-level one cannot answer differently for one flag. */
export function entityAimOutcome(
  which: string, res: EntityPointResolution | null | undefined, allowOccluded: boolean | undefined,
): { point: AimableEntityPoint } | { refusal: AimRefusal } {
  if (!res || !res.ok || typeof res.x !== 'number' || typeof res.y !== 'number') {
    return { refusal: {
      error: `${which}: ${res?.error ?? 'entity did not resolve'}`,
      ...(res?.code ? { code: res.code } : {}),
      ...(res?.options?.length ? { options: res.options } : {}),
      ...(res?.stale ? { stale: res.stale } : {}),
    } };
  }
  const point = res as AimableEntityPoint;
  if (!point.occluded || allowOccluded) return { point };
  // Only the MESH-level half of §3's rule lives in the resolver (it refuses when the surface's own
  // picker says another entity is in front). DOM-level covering — a modal, a menu, a panel over the
  // viewport — comes back `occluded:true` on an `ok` resolution, and is refused here.
  const scope = res.occlusionScope === 'canvas'
    ? ' (this surface has no pick provider, so only DOM-level covering was checked — a mesh in '
      + 'front of it would not be detected at all)'
    : '';
  // "Nothing" is not something you can dismiss. When the hit-test found NO element the point is
  // clipped away or off-window, and telling the caller to move the thing covering it — which the
  // message itself calls "nothing" — is self-contradictory advice: `centreIsInWindow` admits
  // `x === innerWidth` while `elementFromPoint` is exclusive at that same edge.
  const nothingThere = !res.hitTarget || res.hitTarget === NOTHING_AT_POINT;
  return { refusal: {
    error: nothingThere
      ? `${which}: ${res.matched ?? 'the entity'} resolves to a point with NOTHING at it — `
        + `(${Math.round(res.x)}, ${Math.round(res.y)}) is clipped away or past the window edge, so the `
        + `input would go nowhere${scope}. Move the camera (or the entity) so it is framed well `
        + 'inside the viewport, then re-aim.'
      : `${which}: ${res.matched ?? 'the entity'} resolves to a point covered by `
        + `${res.hitTarget} — the input would land on THAT, not on your target${scope}. `
        + 'Dismiss/move what covers it, or pass allowOccluded:true to aim there anyway and see '
        + 'what happens.',
    code: 'OCCLUDED',
  } };
}


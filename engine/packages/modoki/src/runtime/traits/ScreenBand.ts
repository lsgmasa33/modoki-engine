import { trait } from 'koota';

/**
 * ScreenBand — one authored horizontal strip of the design box (#800).
 *
 * The stack is solved by `solveBands` (`runtime/core/screenBands.ts`) and read out of a world by
 * `readScreenBands` (`runtime/ui/readScreenBands.ts`). Authoring a band is a scene edit: drop an
 * entity carrying this trait, name its role, and give it a floor and/or a flex share.
 *
 * ⚠️ **The engine deliberately does NOT register this trait — each GAME calls `registerTrait` with
 * this object and its OWN `fields` map.** That is not an oversight and must not be "fixed":
 *
 *  - `registerTrait` EVICTS the previous Trait object when a name is re-registered with a different
 *    one, silently (no throw, no warning). Engine traits register before a game's do, so an engine
 *    registration plus any surviving game registration would delete this object from the registry —
 *    `getTraitMeta` returns undefined, engine queries see zero entities, and nothing says why.
 *  - There is no seam for a game to supply Inspector metadata for an engine-registered trait, and
 *    the metadata here is genuinely per-game: each game accepts a DIFFERENT role vocabulary, and
 *    its tooltips explain what that game's bands mean.
 *
 * Registering the same trait OBJECT from two games is safe — `registerTrait` only evicts when the
 * object differs, and one project is loaded at a time regardless.
 *
 * ⚠️ **`role` defaults to `''` on purpose.** Saving a scene omits every field equal to its trait
 * default, so a default of a real role name would delete that band's identity on the next save.
 * No real role can equal `''`, so every authored role survives a round trip — and "somebody added
 * a band and never picked a role" stays a detectable state.
 */
export const SCREEN_BAND_DEFAULTS = {
  /** Which band this is. The vocabulary is the GAME's — see its own role list. */
  role: '' as string,
  /** Top-to-bottom position in the stack. Ties are unspecified, so keep them distinct. */
  order: 0 as number,
  /** Design px this band never shrinks below. For a rigid band (`flex: 0`) this IS its height. */
  minHeight: 0 as number,
  /** Share of the height left over once every band's `minHeight` is paid. 0 = rigid. */
  flex: 0 as number,
};

export const ScreenBand = trait(SCREEN_BAND_DEFAULTS);

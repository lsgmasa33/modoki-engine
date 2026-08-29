/** The pinned app-icon generator and its flags — the SINGLE definition, imported by both
 *  `engine/plugins/iconAssets.ts` (which hashes them into the freshness stamp) and
 *  `engine/scripts/generate-icons.mjs` (which runs the tool).
 *
 *  ⚠️ `ICON_COLORS` is hashed into every project's `.cache/icon-stamp-*`. Changing its TEXT —
 *  even to a form that expands to the same flags — invalidates every stamp and makes the next
 *  build of every project rewrite ~60 committed PNGs. That churn is the thing #236 is about, so
 *  treat this string as a value with a wire format, not as formatting. */

export const ICON_TOOL = '@capacitor/assets@3.0.5';

export const ICON_COLORS = '--iconBackgroundColor "#ffffff" --iconBackgroundColorDark "#111111" '
  + '--splashBackgroundColor "#ffffff" --splashBackgroundColorDark "#111111"';

/** `ICON_COLORS` as an argv array, for spawning without a shell. Derived rather than written
 *  twice so the two can't drift — the string stays the source of truth because the stamp
 *  hashes it. The tokenizer only has to handle the shape above: whitespace-separated tokens,
 *  values optionally wrapped in double quotes. */
export function iconColorArgs() {
  return ICON_COLORS.split(/\s+/).filter(Boolean).map((t) => t.replace(/^"|"$/g, ''));
}

/** PNG options for every image this repo GENERATES AND COMMITS.
 *
 *  ⚠️ **sharp's defaults are the wrong trade for a committed artifact.** They optimise for encode
 *  speed, which is right for a throwaway buffer and wrong for a binary that is written once and
 *  then carried in git and in every app bundle forever. Measured on Court:
 *
 *      iOS splash (2732², painted)   17.6 MB → 4.2 MB   (-76%)
 *      iOS dark icon variant (1024²)  2.58 MB → 0.75 MB (-71%)
 *      iOS tinted variant (1024²)     1.20 MB → 0.85 MB (-29%)
 *
 *  All LOSSLESS — same pixels, no quality decision to make and nothing to review. The splash case
 *  alone was 163 MB of committed binaries before this.
 *
 *  Deliberately shared rather than restated per call site: the splash path was fixed first and the
 *  icon-variant path kept the default for a while, which is exactly the drift a shared constant
 *  prevents. It is NOT hashed into the stamp directly — `SPLASH_PIPELINE_VERSION`
 *  (`plugins/iconAssets.ts`) covers changes to our own post-processing, and bumping that is what
 *  makes an already-stamped project pick up a change here. */
export const GENERATED_PNG = { compressionLevel: 9, effort: 10 };

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

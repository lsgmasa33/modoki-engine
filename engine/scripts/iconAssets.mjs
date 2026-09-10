/** The pinned app-icon generator and its flags — the SINGLE definition, imported by both
 *  `engine/plugins/iconAssets.ts` (which hashes them into the freshness stamp) and
 *  `engine/scripts/generate-icons.mjs` (which runs the tool).
 *
 *  ⚠️ `ICON_COLORS` is hashed into every project's `.cache/icon-stamp-*`. Changing its TEXT —
 *  even to a form that expands to the same flags — invalidates every stamp and makes the next
 *  build of every project rewrite ~60 committed PNGs. That churn is the thing #236 is about, so
 *  treat this string as a value with a wire format, not as formatting. */

import fs from 'node:fs';
import path from 'node:path';

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

/** The bundled Modoki app icon — what a project that authors NO `app.iconSource` of its own gets.
 *
 *  ⚠️ This lived in exactly one caller and that was #1027. `iconStep`
 *  (`engine/plugins/vite-asset-scanner.ts`) fell back to it; `resolveIconInputs`
 *  (`engine/scripts/generate-icons.mjs`) did not, and reported "nothing to generate; committed
 *  icons untouched" instead. So the EDITOR's build plan maintained the icons of the 22 native
 *  projects that author none, and the CLI native build maintained nothing — same project, same
 *  config, two different answers, which is `family/one-entry-point` (#827) by name.
 *
 *  It lives HERE, in the plain-Node module, rather than in `plugins/iconAssets.ts`, because
 *  `generate-icons.mjs` cannot import the TS one directly — it loads it through esbuild, which the
 *  PACKAGED editor does not ship. A default that vanishes in the packaged editor would be a third
 *  answer rather than a fix. Both real callers already import this file.
 *
 *  ⚠️ NOT hashed into the stamp as a path. `iconStampValue` hashes the icon's CONTENT, so the
 *  editor resolving this against its build cwd and the CLI resolving it against the repo root
 *  produce the SAME stamp — which is what stops the two callers regenerating over each other.
 *
 *  ⚠️ **Under `engine/`, NOT `build/`, and that is the whole point of the path.** This was
 *  `build/icon.png` — the editor's own icon — and `electron-builder.yml`'s `files:` ships
 *  `engine/**` + `dist/**` + `package.json` and NOTHING else; `build/` reaches the package only as
 *  `build/bin` via extraResources. So in the PACKAGED editor the default resolved to a file that is
 *  not there, `iconStep` passed `--icon ""`, and the script took its "no icon named anywhere"
 *  branch: nothing generated, exit 0, silently — a THIRD answer for the same project, which is
 *  exactly what moving the default here was supposed to prevent.
 *
 *  This is the identical trap `vite-asset-scanner.ts` already records for the splash badge art,
 *  which was moved out of `build/` for this reason after a packaged-editor build produced
 *  title-less, badge-less splashes. The art itself is unchanged — `git mv build/icon.png` — and
 *  `electron-builder` is unaffected because it packs the committed `build/icon.ico` / `.icns`, not
 *  the PNG. */
export const BUNDLED_ICON_REL = 'engine/assets/app-icon-default.png';

/** Absolute path to {@link BUNDLED_ICON_REL} under a repo/engine root, or `undefined` when it is
 *  not there.
 *
 *  ⚠️ The existence check is load-bearing, not defensive. #1011 facet C made an unreadable
 *  REQUESTED icon FATAL, so handing back a path that does not resolve would turn "this checkout has
 *  no bundled icon" into a failed build for every project that authors no icon of its own. Absent
 *  means absent: the caller then reports "nothing to generate" and leaves committed art alone,
 *  which is the pre-#1027 behaviour and the safe one. */
export function bundledIconPath(rootAbs) {
  const abs = path.join(rootAbs, BUNDLED_ICON_REL);
  return fs.existsSync(abs) ? abs : undefined;
}

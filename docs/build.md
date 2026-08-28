# Build & deploy

How a Modoki game goes from source to a running app — web compile, per-game Capacitor
native, and on-device install. `CLAUDE.md` keeps the everyday commands (`npm run dev`,
`MODOKI_PROJECT=… npm run build`, the test/verify gate) and points here for the full
native pipeline and the device build recipes.

Related: [native-and-sdks.md](./native-and-sdks.md) (SPM plugins, SDKs, per-game signing),
[electron-signing-optimization.md](./plans/electron-signing-optimization.md) (desktop-editor
codesign speed).

## One project = one game (#29)

Post-#29 the repo root is **not** a buildable game — it's the engine + Electron editor.
Every `games/<id>` is a fully self-contained Capacitor app with its **own** `ios/`,
`android/`, and `capacitor.config.json`. A bare `npm run build` with no `MODOKI_PROJECT`
fails fast by design.

**`MODOKI_PROJECT=games/<id>`** steers three things in lockstep:
- **Output** → `games/<id>/dist` (`vite.config.ts` `buildProjectRoot`).
- **Identity** → the project's `project.config.json` (`appId`/`appName`).
- **Capacitor** → `webDir` = `games/<id>/dist` (`games/<id>/capacitor.config.json`).

Only the **web compile** (`npm run build`) runs from the repo root (shared vite/engine,
steered by `MODOKI_PROJECT`). `cap sync` and the native build run **from the project dir**,
because its config + native folders live there.

## Creating a new game — use the scaffolder, never hand-craft

```bash
node engine/scripts/scaffold-project.mjs games/<id> "Project Name"
```
This is the same template + token contract the editor's **File → New Project** uses
(`engine/electron/newProject.ts`). It copies `engine/templates/starter`, substitutes identity
tokens, and mints fresh scene GUIDs → a complete, runnable hello-world project (`game.ts` ·
`project.config.json` · `runtime/config.ts` · `runtime/setup.ts` ·
`runtime/assets/scenes/main.scene.json`). **Do NOT hand-write `game.ts` / config / scene JSON** —
you'll miss the GUID/manifest/config wiring.

## Per-clone dependency bootstrap

The engine plugins and each game's Capacitor plugins ship their JS only in a **gitignored
`dist/`**. After `git clone` or any pull that touches a `package.json`/lockfile, a plain
`npm install` does the full setup: the root `postinstall` chains `build:plugins` (engine
native plugins → `dist/`) **and** `engine/scripts/bootstrap-game-deps.mjs`, which for every
`games/<id>` that is a workspace root runs its own `npm install` + `build:plugins`. A missing
`dist/` is what makes `npm test` / the editor fail with `Failed to resolve import
"capacitor-<x>"`. See the Two Clones section of `CLAUDE.md`.

The chain also runs `engine/scripts/stamp-plugin-builds.mjs` immediately after `build:plugins`
(#395). `build:plugins` builds each plugin's `dist/` directly and wrote no **build stamp**, so the
next caller of `ensurePluginBuilt` (the editor on open, the vendorer, a test) read a perfectly
current `dist/` as STALE and rebuilt it — deleting and recreating `dist/` *inside the repo* while
other processes were importing it. Under `npm run verify` that raced the app lane's
`await import('capacitor-game-debug')` and failed the suite with exactly the resolve error above —
once. It never reproduced on a re-run, because by then the rebuild had written the stamp. The
stamp is source-derived and shares `pluginSourceHash` with `ensurePluginBuilt`, so the two cannot
disagree about what counts as a build input.

Two properties make that stamp safe rather than merely convenient, and both are easy to break:

- **It stamps only the workspaces `build:plugins` names**, parsed out of the script — NOT the set
  `listEnginePlugins` discovers. Those two are allowed to diverge (`pluginBuildCoverage.test.ts`
  says so: a plugin used solely by a game reaches it as a vendored `.tgz` and needs no workspace
  build). Stamping the discovered set would vouch for a plugin this install never built — and a
  stale `dist/` left over from an earlier build would then be trusted **forever**, since the stamp
  is computed from the plugin's CURRENT sources. That is the #90 failure the stamp exists to
  prevent: a tarball whose name is current and whose bytes are stale.
- **The `&&` chaining** means a failed build never reaches the stamper. Note npm does *not* abort
  at the first failing workspace — later ones still build — but the overall exit is non-zero, so
  nothing is stamped and the successful siblings simply pay one redundant rebuild.

⚠️ **That same error can mean a HALF-built `dist/`, not a missing one — and the install will
have told you it succeeded.** A plugin's `build` is `tsc && rollup`, so a `tsc` failure leaves
`dist/esm` present and `dist/plugin.cjs.js` (the `main` entry) absent; `bootstrap-game-deps.mjs`
swallows the per-game failure and reports a clean install. Measured 2026-08-02: the #57 dep bump
hoisted `minimatch` 3.1.5 → 10.2.5 to the repo root, and `@types/glob@8.1.0` — pulled in
transitively by `@gltf-transform/cli`, deprecated and frozen since glob started shipping its own
types at v9 — still references `minimatch.IOptions`, which v10 dropped. `tsc` auto-includes every
`@types/*` it can see, so the four plugin tsconfigs that set neither `skipLibCheck` nor `types`
died on a package none of them import. **Check `dist/plugin.cjs.js` exists, not just `dist/`**, and
if a plugin build fails, run it directly (`npm --prefix <pkg> run build`) — the root install hides
the real error. Guarded now by `engine/tests/architecture/ambientTypesOptOut.test.ts`.

## Native scaffolding: auto on first build

A game with no `ios/`/`android/` yet is **auto-scaffolded on the first native build** —
`/api/build` runs the same pipeline as **Build → Add iOS/Android Target…**: deps +
`capacitor.config.json` + vendor plugins → `npm install` → web build → `npx cap add` → heal.
It then continues into the build, pausing first only if the scaffold surfaces a warning you
must act on (e.g. missing Firebase config). The explicit **Add … Target** menu items do just
the scaffold. Manual CLI equivalent: `cd games/<id> && npx cap add ios|android`.

`healNativeConfig` (`engine/plugins/healNativeConfig.ts`) runs on project open **and** at the
start of every iOS/Android build — it syncs the project's `build.appleTeamId` into the iOS
project's `DEVELOPMENT_TEAM` (so a Team ID edited after `cap add` still lands; the VALUE lives in
the gitignored `project.user.json` — see [engine-oss-publishing.md](./engine-oss-publishing.md)
§ "Private build fields") and repairs
other drift. `add-native-target` (`engine/plugins/addNativeTarget.ts`) and the vendor plugin
wire in per-game native plugins. Restart the editor after pulling build-pipeline changes — the
Vite plugin loads once at dev-server start.

**Crash reporting is one of the things it repairs, on BOTH platforms, for any project that depends
on `@capacitor-firebase/crashlytics`** — gated on that dependency alone (`usesCrashlytics`), and
deliberately independent of `build.debugBuild`: whether a crash report is readable has nothing to
do with the debug bridge, and a Release build needs it more, not less. iOS gets
`dwarf-with-dsym` in every configuration plus the `Upload Crashlytics dSYMs` phase (#279); Android
gets the `firebase-crashlytics-gradle` classpath, the `firebase-crashlytics-ndk` artifact, and
`apply plugin: 'com.google.firebase.crashlytics'` **inside** the `google-services.json` guard
(#282) — outside it, a project with no such file fails to build. Both were hand edits in
`games/court` first; generalizing them is what gave `games/3d-test` native crash reporting it had
silently never had. ⚠️ **The NDK version is emitted as an EXPRESSION**
(`rootProject.ext.firebaseCrashlyticsVersion` with a fallback), not a frozen number: it and the
artifact the Capacitor plugin resolves are a matched pair, and a mismatch is a RUNTIME failure —
no NDK reporting at all — rather than a resolution error, so no build log would catch it.

**Four rules the heal follows here, each of them a bug that was found and fixed rather than a
principle someone thought of first** (close-out, 2026-08-20):

- **An ordinary-path warn is a LOG, and the sweep for them is not done by grepping one shape.**
  `console.warn` files a Crashlytics issue (owner, 2026-08-20), so anything that fires on a healthy
  launch becomes an alerting issue per session. The first sweep caught `tierResolve`'s boot lines
  and the OTA confirmBoot catch, and MISSED `tierCalibration`'s tier switch and hold reports —
  because they only fire on a device that actually changes tier, which the iPad never did. Measured
  on a Galaxy S22: a cold boot demoted to `mid` then `low` as the first frames came in over budget,
  filing **4** `recordException` calls for the adaptive system working as designed; after the fix,
  **0**. ⚠️ The device that needs the headroom most is the one that files the most noise, so a
  one-device check is not a check. Genuine anomalies still warn — a scene that never finishes
  loading (the `ARM_BACKSTOP_MS` failsafe) is a real problem and stays a warning.
- **A note means a real change.** The dSYM phase and the archive-time "Debug build is ON" phase
  both used to splice in right after the `PBXShellScriptBuildPhase` section-open line, so each put
  ITSELF first and shoved the other second: the two objects swapped on every project open, each
  heal rewrote the pbxproj, and each reported "synced …" for work that netted to nothing. Measured
  on `games/court` — two writes of equal length and opposite content, file byte-identical before
  and after. They now take deterministic slots (warning first, dSYM **last**), so both are fixed
  points and both projects heal to ZERO notes. A heal note is the editor's report to the human
  that something was repaired; one that fires every time is a false success that hides the real ones.
- **An inline comment must not make an anchor invisible.** The anchors matched `[ \t]*$`, so
  `apply plugin: 'com.google.gms.google-services' // keep with crashlytics` read as "no guard
  present" — the plugin apply was skipped while the classpath and NDK artifact still landed, and
  the heal still returned a success note. That is the half-wired shape this whole section exists to
  end. Anchors now tolerate a trailing `//` comment (and only a comment — `dependencies { impl 'x' }`
  is a one-line block, and inserting "after" it would put the artifact outside the block).
- **A skipped apply-plugin says so.** When there genuinely is no `com.google.gms.google-services`
  apply to anchor on, the note now carries `⚠️ apply-plugin NOT wired … Crashlytics symbol upload
  is inert` instead of listing the two cosmetic edits as success.
- **CRLF in, CRLF out.** Every edit here is written as LF text, so a CRLF gradle file came back
  with mixed endings, differing from its input — the heal then rewrote it on the next pass too,
  drifting a blank line each time. `.gitattributes` pins `*.gradle text eol=lf` so this needs a
  non-git write path, but Windows-only EOL bugs are a documented recurring class here
  ([windows.md](./windows.md)) and the guard is one regex: edit in LF, restore what the file had.

⚠️ **`healNativeConfig` mints pbxproj objects from HARDCODED id spaces, and there are TWO of
them.** `GD_UUID` owns `DD0000000000000000000001` … `DD0000000000000000000007` (the
MainViewController + GameDebug plugin file/build-file pairs, the retired Release strip phase, the
archive-time "Debug build is ON" warning phase, and — since #279 — the `Upload Crashlytics dSYMs`
phase at `…0007`), and `WRAPPER_UUID` separately owns
`D0D0D0D0D0D0D0D0D0D0D0D0` (the `modoki.xcconfig` file reference). Fixed ids rather than random
ones are what keep the heal idempotent and its diff stable — so **anything else that hand-writes
an object id into a pbxproj must avoid BOTH ranges.** (This entry named only the first until the
close-out that followed it; a reader taking it at its word would have thought `D0D0…` was free.)

Getting this wrong produces a failure that looks nothing like its cause. A pbxproj is an object
graph keyed by 24-char ids; defining one id twice is not a syntax error (`plutil -lint` says the
file is fine), the later definition silently wins, and every reference to that id then resolves to
an object of the WRONG CLASS. Xcode refuses the entire project:

```
xcodebuild: error: Unable to read project 'App.xcodeproj' …
  Reason: The project 'App' is damaged and cannot be opened.
  Exception: -[PBXShellScriptBuildPhase buildPhase]: unrecognized selector sent to instance
```

`games/ota-test` shipped exactly this and was **unbuildable for iOS on every clone** from
`7de8607fc` until 2026-08-20: the OTA bring-up had hand-written `OtaCore.swift`'s `PBXBuildFile` at
`DD…0006`, which the archive-warning phase later claimed. Nobody noticed because that fixture is
only built when someone runs the OTA device case — which could then never run. Fixed by renumbering
the OTA side to `DD…000C`, and guarded by
`engine/tests/architecture/pbxprojObjectIds.test.ts`, which fails `npm test` on any duplicate
object definition in a committed `games/**` or `demos/**` pbxproj.

## Committing native folders (SOURCE only)

Each game's `ios/` + `android/` are tracked (pbxproj, gradle scripts, `res/`, `Info.plist`,
`Package.swift`, the vendored `plugins/*.tgz`) — 3d-test + 2d-physics-demo are the references.
Build junk is kept out by two layers: Capacitor's own generated `games/<id>/ios/.gitignore` +
`android/.gitignore`, **plus** centralized `games/*/` rules in the repo-root `.gitignore`
(Pods/, `App/build/`, `android/**/build/`, `.gradle/`, `.cxx/`, xcuserdata, Capacitor-regenerated
config copies…). The belt-and-suspenders root rules exist because the OLD anchored `ios/…` +
`android/…` lines are pre-#29 repo-root paths that don't match `games/<id>/…`. After scaffolding
a new game's native, sanity-check:
```bash
git ls-files 'games/*/ios/**' 'games/*/android/**' | git check-ignore --stdin
# must print nothing — no tracked source should be ignored
```

### App icons + splash are GENERATED, but still tracked

`res/` counts as tracked source above, yet its icons and splashes are produced by
`@capacitor/assets` during the native build. That combination is only safe because the build
**skips regeneration when nothing changed** (`engine/plugins/iconAssets.ts`).

**Where the source image comes from, and the trap in it.** `app.iconSource` in
`<project>/project.config.json` is a **project-relative** path (absolute is honoured too). When it
is **empty — the scaffolder's default — the build falls back to the repo-root `build/icon.png`,
which is the Modoki EDITOR's own icon**, so an unconfigured project silently ships Modoki's panda
as its app icon and looks authored. ⚠️ **`<project>/assets/icon.png` is NOT the source**, however
much it reads like one: `generate-icons.mjs` COPIES the resolved source there because that is
`@capacitor/assets`' input convention, and `games/*/assets/` + `demos/*/assets/` are **gitignored**.
Editing that file changes nothing and is overwritten on the next run — put the master somewhere
tracked (`games/court/art/icon-app-master.png` is the worked example) and point `iconSource` at it.

**Keep the committed value project-relative** (#394). `project.config.json` is tracked, so
`/Users/<name>/Projects/modoki/games/court/art/…` is dead on every other clone, dead on `win`, and
dead in a copied-out `games/<id>` (#29) — besides being a home path in a file `demos/`' publish
scan hard-fails on. Project Settings' **Browse…** can only ever return an absolute path, so
`/api/pick-path` relativises one that resolves under the project root (`relativiseUnderProject`,
symlinked ancestors included) and keeps absolute only what genuinely escapes — which is right for
the `user.sdk.*` fields, since those live in the gitignored `project.user.json`, and wrong here.
Two routes still reach an absolute value in this field: **picking a file that lives outside the
project** (it has no relative form) and typing one in. Neither is refused — the build honours an
absolute `iconSource` — so instead the dialog shows an inline warning under any `committedPath`
field holding a non-portable value (`committedPathWarning`: absolute, `~`, a drive letter, a `\`
separator, or a `..` segment that escapes the project). The gate imports that same predicate rather
than restating it, and
`tests/architecture/trackedConfigPaths.test.ts` fails the gate before one reaches a commit. That
guard reads the schema, so a new `type: 'path'` field outside `user.*` (#396's splash source) has
to be listed in it or the guard goes red.

Two things went wrong before it did:

- The step ran on **every** native build, rewriting every tracked mipmap/splash PNG each time,
  so any game that had been built carried a permanently dirty working tree — 95 such files
  across two games in one day, burying real diffs in re-encoded binaries.
- The generator was invoked as a bare `npx --yes @capacitor/assets` beneath a comment claiming
  it was "verified against 3.0.5". `npx --yes` installs **latest**, so the comment described a
  version the build never used.
  ⚠️ That fix also blamed the **extra density buckets** (`drawable-*-night-*`, `*-ldpi`,
  `mipmap-ldpi`, `mipmap-<dpi>/ic_launcher_background.png`) on the floating version. Measured
  2026-08-19 on `demos/forest-camp`: the **pinned 3.0.5 emits them too** — 21 paths no project
  commits. Pinning made them stop *changing*; it did not make them stop *appearing*. Whether
  they should be committed or gitignored is still open (#236).

Now: the tool version is **pinned** (`ICON_TOOL`), and a stamp under the project's gitignored
`.cache/` records the tool version + platform + colour flags + the **content hash** of the
source image. Regeneration happens when any of those change, or when the generated output has
been deleted (a sentinel file is checked, so a wiped `res/` still comes back). Content-hashing
means repointing `app.iconSource` at a byte-identical file is correctly a no-op, while editing
an image in place is not.

⚠️ **Everything #396/#397 added is in that stamp too** — the splash master and its dark twin, the
title wordmark, the three icon-variant overrides, the badge artwork, the two placement numbers, the
badge flag, the **orientation** (it decides where the overlays go, so it changes the output with
every source file byte-identical), and a `SPLASH_PIPELINE_VERSION` for changes to our own
post-processing, which no source file can express. This is not belt-and-braces: `iconStep` **drops
itself from the build plan** on a stamp match, so an input the hash cannot see does not merely take
an extra build to appear — it never appears, until someone deletes `.cache/icon-stamp-*` by hand.
One case per input in `tests/plugins/iconAssets.test.ts`.

### The splash: authored, not derived from the icon (#396)

**`app.splashSource`** is the native launch screen — shown before the web view has booted at all,
and NOT an in-game title card. Empty means what every project shipped before this: the splash is
derived from `app.iconSource`, i.e. the app icon centred on white. `app.splashDarkSource` fills the
iOS `-dark` slots and the Android `drawable-night-*` buckets, which had existed all along holding
the light art; unset, it reuses the light splash.

The generation half is smaller than it looks: `@capacitor/assets` has always read
`assets/splash.png` and `assets/splash-dark.png` as first-class inputs and cover-crops them into
every bucket. Nothing had ever put a file there — `generate-icons.mjs` staged only `assets/icon.png`
— so every project's splash was its icon **by default rather than by design**.

⚠️ **The staging directory is gitignored scratch that SURVIVES between builds**, so clearing
`splashSource` has to actively delete `assets/splash*.png`; otherwise "remove the custom splash"
regenerates the old one and appears to do nothing.

**Both platforms COVER-FILL, so a splash is always shown cropped** — and on iOS the crop happens at
RUNTIME, not at generation: `LaunchScreen.storyboard` shows a single square 2732² image with
`contentMode="scaleAspectFill"`, which on a 19.5:9 phone leaves only **the central ~45% of the
width** visible. `engine/scripts/splashLayout.mjs` derives that crop-safe box (the intersection of
every crop the project's orientation allows) and the title and badge are placed inside it, per
bucket, against that bucket's own dimensions. Nothing can rescue subject matter authored into the
corners of the master, so compose around the centre column. `tests/plugins/splashLayout.test.ts`
pins the derivation.

**The title is composited, never painted into the art.** An image generator mangles lettering often
enough that the one element which must be perfect cannot be trusted to it, and typesetting it at
build time keeps `splashTitleWidthPct` / `splashTitleOffsetPct` tunable without regenerating
artwork. `app.splashBadge` adds the small "Made by Modoki Engine" mark at the bottom of the safe
box — **default OFF** (owner, 2026-08-28), so nothing already shipped grows a mark it did not have.
The badge ships as two committed PNGs and picks cream or navy per image by **measuring** the mean
luminance underneath it; its artwork is rebuilt by `engine/scripts/make-splash-badge.mjs`, whose
output is committed precisely because it typesets through the system's fonts and would otherwise
differ per machine.

⚠️ **A real splash is enormous under sharp's defaults, and this is worth knowing before you author
one.** `@capacitor/assets` writes PNGs with default options, which do almost nothing on a
photographic image: Court's painted 2732² master came out at **17.6 MB per iOS slot** against 22 MB
raw, and its first real generation produced **163 MB of committed binaries**. The panda-on-white it
replaced compressed to nothing, so nothing had ever exercised this. `compressionLevel: 9` +
`effort: 10` takes the same image to 4.2 MB **losslessly** (163 MB → 41 MB overall), and that
re-encode runs for every splash of a project with a custom master, overlays or not.

### ⚠️ On Android the generated splash buckets are NEVER DRAWN — the system splash is

Measured on a Galaxy S22 (API 34), and it is not an old-device edge case: **at `minSdkVersion 31`
this is every supported Android device.** The launch theme inherits `Theme.SplashScreen`, and from
API 31 the platform draws its own splash and ignores `android:background`, so all 26
`drawable-*` splash PNGs are dead weight in the APK and the player saw **the app icon on black**.

**And the art cannot be moved there.** Google's splash-screen documentation is explicit — *"Set a
single window background color with no transparency"*, *"The window background consists of a single
opaque color"*. There is no documented opt-out; `windowSplashScreenAnimatedIcon` is an ICON
(circularly masked, 240 dp with an icon background or 288 dp without); and the only image slot,
`windowSplashScreenBrandingImage`, is 200x80 dp at the bottom, absent from the AndroidX compat
library, and recommended against by Google. A full-bleed painted launch screen is **not achievable
as the system splash on Android 12+**, by platform design.

So the launch screen is split across two surfaces, and both halves are needed:

1. **Colour** — `androidSplashTheme.mjs` samples the splash master's EDGE RING and writes it into
   the launch theme (both the AndroidX and the platform spelling of the attribute). The icon then
   sits on the game's own colour rather than black. The edge, not the whole image: what fills the
   perimeter of the frame that follows is the master's border, and averaging the whole thing
   returns a colour that appears nowhere — for Court, the wood averaged with the cream page.
2. **Art** — the WEB boot splash below, which is why `App.tsx` hands the native splash over as soon
   as that has painted rather than holding it until the game is ready.

Verified on device: home → icon on Court's wood → the painted splash with its title and badge →
the game. ⚠️ The dead `drawable-*` buckets are still generated and still committed (~16 MB on
Court) — a project that lowered its floor below API 31 would need them, so removing them is an
owner call rather than a cleanup.

### The WEB boot splash — the same image as the loading screen

The splash art is also emitted as `boot-splash.webp` and injected into `index.html` as a fixed,
full-bleed element (`engine/plugins/bootSplash.ts`), so the browser paints the game's launch image
from its **first paint** instead of the four hardcoded dark-navy surfaces that used to fill boot
(white → `#0f0f23` → a "Loading..." string → the spinner overlay). It is injected into the HTML
rather than rendered by React on purpose: the window being closed is precisely the one React is not
alive for. `App.tsx` fades it out on the same "fully booted" signal that hides the native splash —
so on device the native splash hands over to the identical composition rather than cutting to dark
— and also whenever something must be seen underneath it (a boot error, an OTA download's
progress), since a launch image outranking an error would turn an explained failure into a hang.
Build-only, and skipped for the editor shell and for a playable.

⚠️ **The native splash is handed over as soon as the boot splash has painted**, not when the game
is ready — `hasBootSplash()` gates it, so a project with no boot splash keeps the old
hold-until-booted behaviour. Phase 3b held it so nobody saw an unstyled white web view; that reason
is gone now that the web view's first paint IS the artwork. On Android this is what makes the
authored splash visible at all (see above). **There is deliberately no minimum display time**
(owner, 2026-08-28: *"faster load is more important"*) — the splash is as brief as the boot is, and
that is the intent, not a defect to tune out.

### Icon variants — dark, tinted, monochrome (#397)

`@capacitor/assets@3.0.5` emits one `universal` 1024 entry with no `appearances` and an
`ic_launcher.xml` with no `<monochrome>`, so iOS 18's dark and tinted icons and Android 13's themed
icon were all missing. `engine/scripts/iconVariants.mjs` writes them **after** the generator has
run: both files it edits (the iOS `AppIcon.appiconset/Contents.json` and Android's
`mipmap-anydpi-v26/ic_launcher*.xml`) sit INSIDE the running platform's product directory, so the
#236 snapshot-and-restore never sees them — provided this keeps running after the restore, not
before it. The XML edit is idempotent, because it runs on every build.

Each variant is **derived by default and overridable per project** (`app.iconDarkSource`,
`iconTintedSource`, `iconMonochromeSource`). ⚠️ **The derivations are fallbacks, not answers.** They
take a finished painting and try to recover a mark from it, which is the wrong direction: Court's
derived monochrome kept the region cells and the wood grain and gave a themed launcher a
knight-shaped smudge. Any project whose icon is artwork rather than a flat mark should author that
one — `games/court/art/make-icon-monochrome.mjs` is the worked example, and its header records why
the obvious "the knight is the bright bit" key does not work.

**Judging any of this needs a contact sheet, not a file browser.** `engine/scripts/review-icons.mjs
--project <dir>` composites the real generated output at true size over both a light and a dark
ground, simulates the Android adaptive mask at the real inset, shows the tinted variant under a
tint, and shows each splash as a device crops it.

**The generator does not stay inside the platform it is given** (#236). Measured on
`forest-camp`: `generate --android` also rewrites `ios/App/App.xcodeproj/project.pbxproj`,
stripping the leading zero off `LastUpgradeCheck = 0920` → `920` — an **iOS** file mangled by an
**Android** build — and re-serializes `AndroidManifest.xml` (blank lines dropped, `<?xml … ?>`
respaced). Neither is a semantic change, and about half the repo's projects already carry the
mangled `920` in a commit, which is how quietly it travels. `demos/` is the publishable tree, so
this is CLAUDE.md's #18 hazard arriving from the build instead of the editor.

So the step now runs through **`engine/scripts/generate-icons.mjs`** rather than a shell
one-liner. It snapshots everything under `ios/`+`android/` outside the running platform's
**product directory** — `android/app/src/main/res/**` for `--android`,
`ios/App/App/Assets.xcassets/**` for `--ios`, both measured rather than assumed — runs the
generator, then puts back anything it wrote outside that scope and **reports what it put back**,
so a project that genuinely needs such an edit sees a line every build rather than silence.
The scope is a PATH, not a file type: an extension-based rule also reverted
`res/mipmap-anydpi-v26/ic_launcher.xml`, where the generator legitimately repoints the adaptive
icon's background at the PNG it just made. Guard: `engine/tests/plugins/generateIcons.test.ts`.

**Why not just gitignore the icons?** Generation is deliberately non-fatal (`|| echo '[icon]
generation skipped'`) and needs `npx` to reach the network. Untracked icons would let an
offline or upstream-broken build ship an app with no icon and no committed fallback — trading
visible churn for an invisible release defect. To force a rebuild, delete
`<project>/.cache/icon-stamp-<platform>`.

## The canonical path: build from the editor

Open the project, then **Build → iOS Device / Android Device / Web**. `/api/build` runs the
steps below with the right cwd per step (web compile at repo root, native at the project dir) and
consumes the SSE pipeline to completion. This is the validated path; the CLI recipes below are the
manual equivalent.

The editor build path **resolves (and, in a packaged editor, downloads) its toolchain
automatically** — Node, the JDK 21, and the Android SDK — and preflight-gates a build on the tools
it needs, pointing you at **Build → Build Support…** to install anything missing. It exports
`JAVA_HOME`/`ANDROID_HOME` from that shared, version-strict detection. **The CLI recipes below reach
the SAME resolution** via `eval "$(node engine/scripts/print-toolchain-env.mjs)"` — that script
bundles and calls `engine/toolchain`'s own `detect()` rather than probing for itself, because a
second probe is precisely what this module was consolidated to remove (#159). Full detail:
[editor-toolchain.md](./editor-toolchain.md).

### From an agent: `modoki_build` IS that menu item

An agent does not need the CLI recipes below. **`modoki_build {platform}`** drives the same
`/api/build` the menu does — same toolchain resolution, same per-step cwd, same one-at-a-time slot
— and consumes the SSE stream to completion, returning `{ok, log}` or the failure tail. For a
native platform it also **installs and launches on the attached device**, so a successful call
leaves the app running rather than leaving you an artifact to deploy by hand.

```
modoki_build {platform: 'android'}   // → gradle, install, launch
modoki_build {platform: 'ios'}       // → xcodebuild, install, launch
modoki_build {platform: 'web'}       // → games/<id>/dist
modoki_build {platform: 'playable'}  // → games/<id>/ads/index.html
```

Prefer it over shelling out. The CLI recipes exist for a human at a terminal and for the cases the
tool cannot express; reaching for them from an agent means re-deriving cwd, toolchain env, and the
build slot by hand, which is where the drift starts.

Three things that bite:

- **It is HEAVY** — a native build runs gradle/xcodebuild and installs. Minutes, not seconds. Slow
  is not hung; do not kill it and retry.
- **`force` here is the NON-destructive one.** `modoki_build {force:true}` proceeds despite unsaved
  live-world edits; the artifact is built from the FILES, so your unsaved work is left alone and
  merely not included. This is why the build family kept the name `force` while the world-swapping
  tools (`load_scene`, `prefab`, `new_scene`) renamed theirs to `discardUnsaved` — they DESTROY
  that work. Prefer `modoki_save_all` first and pass nothing.
- **The project must be OPEN in the editor**, and for a device build that open is load-bearing
  beyond convenience: `healNativeConfig` runs on open and is what actually registers
  `GameDebugPlugin` and the local-network keys after a `build.debugBuild` change. Set the flag →
  reopen → *then* build. Build before the reopen and you get an app with no debug bridge, which
  presents as a lease handshake failure and reads like a network fault. See
  [qa/README.md](../qa/README.md) § "Device cases".

⚠️ **Several phones of the same platform attached? The install target is whichever device this
clone has CLAIMED**, and a raw `adb`/`devicectl` command against an unclaimed one is refused by the
`PreToolUse` hook (#285) naming the holder. Claim before building (`npm run device:claim <serial>`,
or connect it in the editor), and release the moment you are done — a claim is machine-wide and
locks that phone out of every other clone and out of the owner's own hands.

### One build at a time (#173)

**Three routes compile into the same `<project>/dist`, so they share ONE slot** — not one lock each.
`/api/build`, `/api/ota/publish`, and `/api/add-native-target` all run the byte-identical
`node engine/scripts/build-web.mjs --target native` from the same cwd into the same `dist`
(`vite-asset-scanner.ts` build steps · the publish route's step 1 · `addNativeTarget.ts`). Whichever
starts second rewrites that dist while the first is still copying it, and the failure is quiet:

- **build ↔ build** → `cap sync` copies a half-written dist into `ios/`, and the build then
  *succeeds*. A signed app with a torn JS bundle, surfacing on the device hours later.
- **publish ↔ build** → the worst one, and the reason the slot is shared. `/api/ota/publish`
  uploads that dist to the OTA bucket, so the torn bundle reaches **every installed device that
  checks for an update**, with no local artifact to inspect first. One human doing two ordinary
  things in one window (start Build → iOS, then Publish OTA while it runs) reaches it.
- **scaffold ↔ anything** → `npm install` + `cap add` into the project on top of the dist race;
  two scaffolds for one platform also race the `existsSync(nativeDir)` gate that is supposed to
  make the route a no-op.

Refused, not queued: these run for minutes and nothing cancels one, so a queued SSE stream would sit
silent and read as a wedged editor. The refusal is a `FAILED:` status naming what holds the slot
(`ios build`, `OTA publish`, `android native scaffold`) and how long it has been running.

**Which signal gives the slot back is the subtle part** (`releasePolicy` in
`engine/plugins/backend/buildLock.ts`). Each of these handlers has two halves that stop at different
times, and one release rule cannot serve both:

- The **preflight gates** (invalid config, no iOS device, no Team ID, no `webBucket`, missing
  toolchain) return synchronously and spawn nothing → released on the response closing.
- The **pipeline** owns its own release once started. Releasing it on `close` — which the first
  version did — frees the slot the instant the client disconnects, while the step loop is still
  awaiting a spawned child. The editor's own force-reload reaches that: editing a game `.ts`
  reloads the page, tearing down the EventSource mid-build, and a retry then writes the same dist
  from two processes. Exactly the bug the lock exists to prevent, re-entered through the back door.

**Aborting a step kills the process GROUP, not the shell (#176).** For a long time the slot's
guarantee was bounded by what "the pipeline stopped" could observe — the step's `bash` exiting — and
that is weaker than it sounds. `bash -c` *exec-replaces* itself for a simple command (so vite,
xcodebuild and gradlew did get the signal) but *forks* for a compound one, and three real steps are
compound: the iOS `Installing on device...` (`APP_PATH=$(…) && { xcrun devicectl … }`), icon
generation (`mkdir && cp && … && printf`), and the web deploy's `for ext in glb ktx2 webp; do gcloud
storage objects update …; done`. `kill('SIGTERM')` on that one pid killed the shell and left
`devicectl`/`gcloud` running, orphaned, holding no slot — free to race the retry the freed slot
immediately admits. The `(D6)` comments claimed a disconnect left nothing that "can't conflict with
a retry"; that was never true, and #173's slot only narrowed the window.

The fix lives entirely in `engine/plugins/buildStepShell.ts`: posix steps spawn `detached` (their
own process group) and every abort path calls `killBuildProcess`, which signals `-pid` — SIGTERM,
then SIGKILL to the group after a 5s grace. Two things fall out for free: a group signal reaches a
tool's own workers (xcodebuild's `clang`/`swift-frontend`, gradle's `--no-daemon` single-use JVM)
without depending on that tool to forward it, and the backend kills what it still owns on
`SIGINT`/`SIGTERM`/`exit` — necessary, because a detached child no longer receives the Ctrl-C that
stops `npm run dev`, so detaching without that hook would have opened a new orphan path while closing
this one.

The shutdown path gives an in-flight child **2s to honour the SIGTERM** before `exit`'s SIGKILL
lands, and pays that delay only when a build is actually running. The first version skipped it —
SIGTERM with no grace, `process.exit` on the next line, so the SIGKILL arrived in the *same tick*.
That is not "graceful then forceful", it is just forceful, and a gradle or xcodebuild killed
mid-write leaves a lock file or a torn artifact for the next build to trip over.

Windows takes the other road: no `detached` (there it allocates a new **console**, which the GUI
editor would flash per step) and `taskkill /T /F /PID <pid>`, which walks the tree by parent pid.
**Validated on a real Windows box (#182)**, and the premise turned out to be worse there than on
posix: `spawn(cmd, {shell:true})` is `cmd.exe /d /s /c "<command>"`, and Windows has no
exec-replace, so **every** step carries the extra `cmd.exe` layer — where on posix only the three
compound steps did. Measured: aborting a real build killed a 5-process, 4-level tree
(`cmd.exe` → `node build-web.mjs` → `cmd.exe` → `tsc`) in **350ms**, against an **11175ms**
uninterrupted lifetime in the control run. No console window ever appeared (`MainWindowHandle` 0
for all 7 processes across 11 samples of a full build).

⚠️ **One residual hole, and one that was closed by measuring it (#185):**

- **A SIGKILL'd backend** executes no hook and orphans whatever was mid-step. A process that is
  not allowed to run code cannot clean up, so this is not closable *in-process* — but it is
  closable from the PARENT, and on Windows that is now done: `devServer.ts` force-kills its Vite
  child with a `taskkill /T` tree kill rather than `child.kill()` (#185). There, `kill()` is a
  `TerminateProcess` on the Vite pid alone — Vite runs no handler, this module's shutdown hook
  never fires, and an in-flight build's grandchildren are orphaned. So **quitting the editor
  mid-build** is covered; only main itself being SIGKILL'd is still open. posix is deliberately
  unchanged: a real signal there runs Vite's handlers, which reap the build children properly.
- **The graceful-exit hook used to skip Windows entirely — CLOSED (#185).** `process.on('exit')`
  reaped posix children and took `if (e.platform === 'win32') continue`, commented "no synchronous
  tree-kill on Windows". Both halves of that were wrong: `execFileSync('taskkill', …)` runs fine
  inside an `exit` handler, and the gap was real. It now calls **`killBuildProcessSync`**, the
  synchronous twin of `killBuildProcess`, on every platform.

  **Why it hid for so long is the part worth remembering.** Measured both shutdown paths on a real
  build and the tree came down within ~900ms — which looked like proof the shutdown worked. It was
  not. Every step here is a **node** process writing to the stdout pipe it inherited for the SSE
  log, and node exits when that pipe breaks. A 4-cell probe isolates it: node+piped+writing **dies
  in 718ms**; node+piped+silent **survives**; node+unpiped+writing **survives**; `ping`+piped
  **survives**. The tools were covering for the shutdown path, so a *clean* observation was
  measuring the wrong mechanism.

  A JVM's `PrintStream` swallows the failed write, which puts `gradle` in the `ping` row. Measured
  with the real step (`android\gradlew.bat -p android assembleDebug --no-daemon`):

  | scenario | gradle JVMs |
  |---|---|
  | parent hard-killed, nothing reaping | **2 alive at +62s** |
  | `taskkill /T` on the tree (the abort path) | both gone in **1s** |
  | graceful exit, hook as shipped | **2 alive** 6s later |
  | graceful exit, hook fixed | **0** |

  General lesson: when a guard's success depends on the *tool* rather than the mechanism, a passing
  observation is not evidence the mechanism works. Vary the tool, not just the input.

  (Note for anyone repeating this on Windows: the toolchain is resolved through
  `MODOKI_TOOLCHAIN_DIR`, **not** `JAVA_HOME`/`ANDROID_HOME` — those are empty on the `win` box even
  though a pinned JDK 21 and a full Android SDK are installed. Probing the env vars, or `java` on
  PATH, reports a false "no toolchain here". Ask the editor instead: `GET /api/toolchain` returns
  each tool's resolved `path` and `source`.)

**Known gap, deliberate:** the slot is per backend **process**, so two editor processes on one
project (a packaged editor beside a dev one) are still unguarded. That needs a cross-process claim on
the filesystem, the shape `backend/deviceClaims.ts` implements for hardware — note its
same-pid-is-a-no-op rule means the claim machinery alone would *not* have caught the agent-vs-human
case, so that work needs both mechanisms. Left open on #173.

## Assets the build cannot see — why an asset ref never belongs in code

The build's asset passes are **static**: they read authored DATA, never `.ts`. So an asset
referenced only from game code is dropped, and the game is perfect in dev and broken when built.
This is the single nastiest failure mode in the pipeline, because **dev serves every asset off
disk** — nothing is missing until you ship.

Found on `games/court`, the first project whose content is created almost entirely by game code
rather than authored in a scene. It broke **three independent passes at once**, against a build
whose log was clean:

| Pass | What it walks | What it missed | Symptom in the build |
|---|---|---|---|
| Asset tree-shaker | scene → prefab → mesh → material ref graph | `PIECE_ICON` texture GUIDs, the font | no piece art, no text |
| Asset manifest | filtered to the kept assets | same | `resolveGuidToPath` resolves nothing |
| `detectType` | filename/dir convention | `assets/levels/index.json` typed `scene` | level manifest offered as the BOOT scene |

That same `detectType` misclassification also broke GUID stamping, independent of the tree-shaker
bugs above. Rule: an asset's GUID lives in a top-level `id` field ONLY when the parsed JSON is a
stampable plain object; anything else gets the same `<file>.meta.json` sidecar that binary assets
use. The two halves of that rule failed together: `detectType` **then** ended in a catch-all that
typed any leftover `.json` as `'scene'` — an `ID_BEARING_TYPES` kind whose guid is meant to live in
a top-level `id` — and `games/court/runtime/assets/levels/index.json`
is a top-level JSON **array**, so `json.id = guid` on it was silently dropped by
`JSON.stringify` (arrays serialize only numeric-index elements). So `writeAssetGuid` wrote the file
back unchanged yet still returned `true`, the heal loop logged "minted missing GUID" as if it had
succeeded, the next scan found no `id`, and it re-minted forever — a non-deterministic GUID on
every scan. **Both halves are now closed, and either one alone would have been enough** — which is
why the rule is worth stating rather than treating as a footnote to #54. `detectType` no longer
guesses (it returns `null` for an uncategorized `.json`; see the row above), *and* `writeAssetGuid`
takes the in-place-`id` path only when `isStampableObject` holds (`!!json && typeof json ===
'object' && !Array.isArray(json)`), falling back to the sidecar otherwise. Regression cover in
`engine/tests/plugins/viteAssetScanner.test.ts` — the `writeAssetGuid` array fallback and
`buildManifest` heal stability across repeated scans. That Court file is the live proof the
fallback fires: it carries a committed `index.json.meta.json` rather than an inert in-file `id`.

**The fix is to author the ref, not to patch the keep-list.** Put it on a **resource trait** in
the scene: the tree-shaker's generic sweep (`probeTraitRefs`, `engine/plugins/asset-tree-shaker.ts`)
keeps any GUID on any trait bag that resolves in the asset index — **game-defined traits included,
with no registration** — so the ref becomes visible automatically, gains scene validation, and
becomes editor-editable (drag a texture onto the field to reskin).

`games/<id>/asset-keep.json` is the escape hatch, and it is a **patch, not a fix**: hand-maintained,
and nothing fails when someone forgets an entry. That is precisely why the guard below exists.

**Guard**: `engine/tests/assets/codeAssetRefs.test.ts` (in `npm test`) fails on an asset ref held in
game code, in either form — a GUID **literal**, or an imported **engine constant** such as
`DEFAULT_FONT_GUID`. It discriminates by resolving each candidate against the real asset index: a
GUID a real asset owns is a failure, while an **entity** GUID in code is legitimate and ignored
(addressing a scene-authored entity from code is a normal pattern — `demos/postfx-demo` does it).
That distinction is why this is a vitest guard rather than an ESLint rule: a static rule cannot
consult the asset index, and a blanket "no GUID literals" rule fires on ~10 legitimate entity refs.

**The other half of the trade** (#53): moving a ref off a code constant and onto an authored trait
field buys build visibility at the price of a failure mode a code constant could not have — the
field can be left **blank**. An empty string is neither dangling nor a literal path, so
`assetRefIntegrity.test.ts` passes it and it surfaces only in a production build or on device.
`engine/tests/assets/authoredAssetRefs.test.ts` closes that direction: a `(trait, field)` pair is
**proven** an asset ref when some instance anywhere resolves to a real asset GUID, and every blank
instance of a proven pair then fails. Legitimate blanks (an optional override slot, a field with a
code fallback) are pinned in its `BASELINE` with a reason and a two-way staleness check — a new
blank fails, and so does an exemption that no longer fires. The baseline is a record of what
already existed, not an approval: shrink it, never grow it.

**Companion guard — a code GUID that resolves to NOTHING**:
`engine/tests/assets/danglingCodeGuids.test.ts`. The guard above skips unresolvable GUIDs, by
design (its job is refs the build cannot see, not broken refs), and #70 fell through that gap: a
`thumbnailUrl` GUID whose asset had been deleted sat in `games/3d-test/game.ts` unnoticed. Note the
"~10 legitimate entity refs" caveat above applies to the **asset index alone** — an entity guid is
not an asset, but it *is* defined in committed scene JSON. So resolving against asset `id`s **and**
entity `guid`s makes "unresolvable ⇒ broken" exact rather than noisy: measured across `games/` +
`demos/`, 2319 defined GUIDs, 33 code literals, **0** false positives. A guid minted at runtime
(never serialised) would be the one legitimate exception; there is none today, and the guard has an
`ALLOWED` map that demands a reason rather than a widened rule.

Two things it deliberately does not reach: a GUID assembled at runtime from non-constant parts, and
an asset fetched by PATH rather than GUID (Court's generated `levels/index.json` — a resource trait
cannot enumerate a generated set; that needs `index.json` to become a real ID-bearing asset type).

Pre-existing refs are listed in that file's `PENDING_MIGRATION`, pinned per `file:guid` and
stale-checked both ways so the backlog can only shrink. **Verify any migration with a real
production build** (`MODOKI_PROJECT=games/<id> npm run build -- --target web`) — `npm test` cannot
see this class.

### The other direction — a ref the walker cannot SEE (#237)

Everything above is a ref the build cannot see because it lives in **code**. There is a second half,
and it bites authored data that is doing everything right: a ref in a **scene or prefab**, in a
*shape* the walker does not reach.

`SkinnedMeshRenderer.materials` is the worked example. It is a `Record<string, string>` — material
slot NAME → `.mat.json` GUID — and `probeTraitRefs` reached exactly two shapes: a scalar field named
in `REF_FIELDS_BY_TRAIT` (scalar-only, and with no `SkinnedMeshRenderer` entry) and one level of
string ARRAY. A map is neither, so **every per-slot material override was shaken out of every
production build**. Measured across all 23 committed projects: 11 such refs in 3 projects
(`demos/forest-camp` ×1, `games/alien-animal` ×5, `games/timeline-demo` ×5), 11 dropped.

Two things make this class nastier than the code-ref one:

- **The runtime and the build disagreed, and the runtime was right.**
  `collectResourceRefsFromEntities` (`runtime/loaders/loadSceneFile.ts`) has had an explicit
  `SkinnedMeshRenderer.materials` branch all along, so the material is acquired and applied in dev
  and in the editor. Only the *build* was blind. Two walkers over the same authored data, one with a
  hole in it, and nothing compared them.
- **The failure is silent by construction.** An authored material override that resolves to nothing
  does not error — it simply does not apply, and the mesh keeps whatever material its GLB brought.
  It shipped in the flagship published demo and surfaced only as a single
  `[MeshCache] Unknown asset guid:` line in a device log.

**Guard**: `computeKeptAssets` returns `unreachableRefs`, and a build with any entry **fails**.
After the walk it re-reads every KEPT walkable asset JSON as text and flags any GUID that (a) the
asset index resolves to a real shippable asset and (b) the keep-set does not contain. Both
conditions carry weight: a GUID the asset index does not know is an entity ref and is ignored, which
is what makes the check exact rather than noisy — measured **0 false positives across all 23
projects**, against exactly the 11 true positives above. It is deliberately **shape-blind**: it does
not care how the ref was written, so the *next* blind spot fails the build instead of shipping.

Two details that are load-bearing rather than incidental:

- It runs **before** the `build.modules.video` drop, so a clip excluded on purpose is never
  misreported as a ref the walker missed.
- It scans exactly the types the walk opens, asked via `classify()` — **not a suffix regex of its
  own**. A second hand-maintained list of "files that carry refs" would be the same walker-vs-checker
  drift the guard exists to catch (concretely: a legacy pre-migration scene is a plain `.json` under
  `/scenes/`, which `classify` types `scene` and the walker reads, and which a `.scene.json` regex
  would have skipped).

As with the keep-list above, the fix for a flagged ref is to **teach `probeTraitRefs` the shape**,
not to paper over it with an `asset-keep.json` entry.

**The sweep that follows from this** — and it found a second instance immediately. State the defect
as "the RUNTIME collector and the BUILD walker disagree about a trait", and the two lists are both
readable: `collectResourceRefsFromEntities` (`runtime/loaders/loadSceneFile.ts`) carries explicit
handlers for 14 traits, `probeTraitRefs` for 5. Differencing them turned up **`AudioSource.clips`** —
a JSON-STRING bank `[{key, ref}]`, parsed by the runtime and by nothing in the build.
`REF_FIELDS_BY_TRAIT` covers only the scalar `clip`, and the generic sweep sees one JSON string, so
`isGuid()` is false and every ref inside is invisible to it. Now handled.

Nothing was broken on committed content, and *why* is the part worth carrying: every committed
`AudioSource` lives in a **scene**, and a scene carries a `resources[]` manifest — regenerated from
that same runtime collector — which the walk reads, so the bank refs were reached by that route. A
**prefab** has no `resources[]`. That is the asymmetry behind both bugs: a ref authored in a prefab
gets exactly one chance to be seen, and it is the walker's own trait handling. `char_Ranger.prefab.json`
is why #237 shipped; an `AudioSource` bank in a prefab would have shipped the same way, with
`audio.play` on every non-active key silently playing nothing on device.

**And a THIRD instance, which that sweep could not have found** — worth stating because it corrects
the sweep's own framing. Differencing the two walkers' *trait handler* lists is a field-shape test,
and the remaining gap was **structural**: `extractEntityRefs` walked an entity's `traits` and its
`overrides`, while `collectResourceRefsFromEntities` also walks `nestedOverrides` (one level deeper —
`{ path: { localId: { Trait } } }`) and every `added` subtree, each of which carries its own override
maps. So the right pattern statement is not "which traits does each walker know" but **"which STORES
can hold an override, and does each walker read all of them"** — and the answer now lives in one
recursive helper per walker, so the two can be compared by eye.

Nothing in committed content reaches it (`space-console`'s `Station.scene.json` is the only
`nestedOverrides` user, and it overrides two scalar floats). The reason to fix it anyway is the guard
above: since a ref the walker cannot see now **fails the build**, leaving the gap would have turned a
silent 404 into a hard stop on legitimate authoring.

## Find References — the same walk, inverted (#284)

"What references this?" is the reverse of the question the tree-shaker above answers, and it is
served by **inverting that same walk** rather than by a second one. `enumerateRefEdges`
(`engine/plugins/asset-tree-shaker.ts`) runs `computeKeptAssets` with three options a production
shake never sets — an `onRef` observer, an `onEntity` observer, and `seedAllWalkable` — and
`engine/plugins/assetRefGraph.ts` builds the reverse index out of the edges it emits. Consumers:
`GET /api/find-references`, the `modoki_find_references` MCP tool, and the editor's **Find
References** on an Assets row and a Hierarchy row.

⚠️ **Do not write a second walker for this.** Two graphs over the same data drift, and the one that
drifts is the one nothing in CI runs — which would be this one. The failure is silent: a wrong
"0 references" looks exactly like a right one, and the reader acts on it by deleting something.

**Why an ad-hoc grep is not merely inconvenient but WRONG.** The graph has edges no file records,
and they are the majority of the 2D/UI surface:

| implicit edge | what holds it | why a grep misses it |
|---|---|---|
| **derived sprite** | a `Renderable2D.sprite` / `UIElement.imageSrc` holds `deriveGuid('sprite:' + textureGuid)` | that guid appears in **no file** as the texture's id |
| **slice** | a sprite-sheet slice guid, living in the texture's `.meta.json` `sprites[]` | the ref names the slice, not the sheet |
| **atlas member** | a packed member guid, redirected to the built `.atlas.json` | the ref names the member, not the atlas |

This is not hypothetical. An agent asked "is this texture still used?", swept for each texture's own
guid, and reported **every icon in `games/court` as orphaned** — including two wired minutes
earlier. Measured on Court today, over the DEDUPED graph: **108 of its 233 asset-to-asset edges are
`derived-sprite`** — 46%, so that sweep was blind to nearly half the graph it was reasoning about.
`buildGuidIndex` already models all three, which is exactly why the inversion reuses it.

**What it returns, and the two distinctions that make an answer actionable:**
- **Paths, not a count.** `Coin@tray-badge.prefab.json [Renderable2D.sprite derived-sprite]` names
  the file AND the field to edit; "12 references" names nothing.
- **direct vs indirect.** A texture reached only through material → mesh is still used, but what
  you edit to break the link is a different file.
- **`reachable`.** A referrer that is itself dropped from a production build is a weaker reference
  than one that ships. Computed by forward BFS from the shake's real seeds (scenes + keep-list),
  which is why `seedAllWalkable` is a graph-only option: the reverse index needs an orphan
  prefab's OUTBOUND edges, but must not let seeding it make it look live.

**Three traps recorded because each one produced a wrong answer during the build:**
- **A prefab instance's identity is the entry's top-level `guid`, not `EntityAttributes.guid`** —
  measured on Court, where all 25 instances are shaped that way and `PrefabInstance.rootInstanceId`
  names that same guid. Reading only the trait made 26 live entity refs look dangling. That rule now
  lives in ONE place, `entityGuid` in `runtime/scene/sceneMutate.ts`, and the walk calls it: the
  mutate path already had it right, this walk re-derived it and got the fallback order wrong — which
  is the same single-source-of-truth failure the feature itself is about, one level down.
- **A self-edge is not a reference.** `rootInstanceId` on an instance root names its own guid, so
  every prefab instance reported itself as its own referrer — which also made `unreferenced` wrong,
  since a self-edge is an inbound edge.
- **`meta` sidecars are not assets.** Both halves (`.meta.json` and the machine-local
  `.meta.local.json`) are metadata ABOUT an asset; listing them added a phantom row per imported
  binary, the same defect the Clean Up dialog already fixed once (QA-DLG-0006).

**"What would the build drop?" has exactly ONE owner: `/api/unused-assets`.** Find References
briefly shipped an `?unreferenced=1` mode — "list every asset nothing points at" — and it was
measured and deleted in the same close-out. Its result is a strict SUBSET of the tree-shaker's
orphan list on every committed project (court 17/17, 3d-test 29/31, forest-camp 30/60, sling 38/73,
particle-demo 19/21), and nothing ever appeared in it that was not already an orphan. That is
structural rather than lucky: a file nothing points at cannot be reachable unless it is a seed, and
seeds were excluded. Where the two differed it was strictly WORSE — it reported only the ENTRY
POINTS of a dead subtree while the orphan list reports the whole subtree (38 against 73 on sling).
A second, weaker answer to a question that already has one is the cross-tool inconsistency
[mcp-tool-conventions.md](mcp-tool-conventions.md) § 2 exists to prevent, so it is gone rather than
kept "for completeness". If the Clean Up dialog ever wants its orphans GROUPED by dead-subtree
root, that is a presentation pass over `orphanDetails`, not a second query.

**There are TWO reachability implementations, and a test is what keeps them equal.** The shake
already computes reachability — its keep-set IS that answer, and it is the one production ships by.
`computeReachable` in `assetRefGraph.ts` re-derives it from the edge list, because
`enumerateRefEdges` seeds every walkable file (to see orphans' outbound edges), which makes that
run's keep-set useless as a reachability answer. That is a real reason for the second walk and not
a reason to trust it: `reachable` is what tells a reader whether a reference survives the build, so
a drift shows up as a reference quietly mislabelled and nothing else. Measured, they agree exactly
— **1168/1168 paths on Court**, zero disagreement either way across court / sling / forest-camp /
3d-test / particle-demo — and `assetRefGraphCourt.test.ts` asserts that equality over three real
projects. Real projects rather than a fixture on purpose: the shapes that could diverge (a
keep-listed prefab, font-family resolution, a shader's sibling `.wgsl`, atlas redirection) exist in
committed content and not in anything hand-built. Dropping the entity-fold from `computeReachable`
fails `sling` and NOT `court`, because Court's scenes carry `resources[]` manifests that make the
file a graph node anyway — which is why one project would not have caught it.

**`dangling` is a superset of the shake's `unresolved GUID ref:` warnings, not a competitor.**
Every warned guid appears in `dangling`; the reverse does not hold, because the generic entity-ref
sweep deliberately does not warn (an entity guid is never in the asset index, so warning there
would flood every build log). Measured across court / 3d-test / sling: nothing warned was missing
from `dangling`. Don't "reconcile" them — one is unstructured build-log text, the other a
structured per-node projection that also covers entity refs.

**`dangling` is a lead, not a verdict.** A guid that resolves to neither a tracked asset nor an
entity is reported as "could not resolve" — never as "broken" — because the guid index only covers
asset kinds `classify()` knows, so a ref to a game-defined JSON kind lands there even when the file
exists (Court's `.court.json` levels are `unknown-json`).

Cost, measured warm on this Mac: **6-64 ms** to enumerate and **0-2 ms** to build the graph, across
five committed projects (56-1,185 files). No caching — the query is on-demand and the walk is
cheaper than the round trip. (It was roughly double that until the close-out review noticed
`buildGuidIndex` — which stats every shippable file and reads every `.meta.json` sidecar — was
running twice per query; `computeKeptAssets` now takes a prebuilt index.)

**`dangling` covers declared asset slots too, and that is not where it started.** It was populated
only from the generic entity-ref sweep, so a `.mesh.json` whose `model` guid pointed at nothing
answered `unresolvedRefsFromTarget: []` — the structured signal silently absent for exactly the
asset-to-asset refs this section is about, while the doc comment promised the opposite. Caught in
the #284 close-out review, pinned by a mutation-checked test. A `font-family` edge is deliberately
NOT dangling: a CSS family name is not a guid, and `resolveFontsByFamily` resolves it at the end of
the walk.

⚠️ **It reads FILES ON DISK.** An unsaved live-world edit is invisible to it, so a user who just
wired something up and did not save will be told "0 references". Save first.

## Packaged editor loop (test the DMG faithfully, fast)

⚠️ **Why the packaged reaper is anchored to a bundle PATH, and must stay that way.** For months,
dev editors across every clone died at random and it read as a GPU fault. The cause was
`killPackaged()` called with no `appDir`, reaping by the bare product name:

    pkill -f "Modoki Editor"

Electron passes the app name to every child in `--user-data-dir`, so that pattern matched every
clone's DEV editor helpers (GPU/network/audio) while MISSING the main process. **That asymmetry is
what disguised it**: the helpers died, the main process survived and dutifully logged their deaths
with nothing to blame. Now anchored to `Modoki Editor.app/Contents/`, which keeps the machine-wide
scope the caller wants while making a dev editor structurally unmatchable, and
`engine/tests/architecture/reapScoping.test.ts` fails any `pkill -f` pattern under
`engine/scripts/**` that is not anchored to `/` or `$`. `main.ts` also dumps a filtered `ps`
snapshot on any `reason=killed`, naming the processes that could have sent it — an EMPTY list is
itself evidence (the killer already exited). Do not "simplify" the pattern back.

Three loops, three jobs — don't conflate them:

- **`npm run editor:dev`** — the **HMR dev loop**. Vite dev server + Electron; edit a file, see it in
  ~200ms. This is for *building* the software and is your default. It works unchanged in every clone:
  the backend port comes from the clone DIRECTORY via `engine/scripts/editorPorts.mjs`, so no
  `MODOKI_BACKEND_PORT=…` prefix is needed (#349 — that prefix used to be mandatory on every worker
  clone, and forgetting it aimed the launch at the hub's 5179). The old clone-named `editor:main` /
  `editor:ai` scripts were deleted with #349 — a per-clone NAME cannot be right in a repo every clone
  shares, which is the same mistake as the per-clone port default they carried.
- **`npm run test:packaged` / `smoke:packaged`** — the **faithful packaged loop**. Both run
  `electron-builder --dir` to produce the REAL `Modoki Editor.app` (asar packed, workspace symlinks
  dereferenced, devDeps pruned) — it is **the DMG minus code-signing + dmg-packaging** (the only slow
  parts), so ~20–40s, not ~7 min. `test:packaged` launches it interactively (main-process logs stream
  live); `smoke:packaged` launches headless and auto-asserts render, **CSP** (via
  `assert-app-csp.mjs`), and that the app **provisioned its own pinned Node** — see "What the
  packaged smoke asserts" below. This is for *checking that it packages* — a periodic fidelity check, NOT a
  dev environment (the `.app` serves from a FROZEN copy of engine source, so it has **no HMR** — every
  edit needs a rebuild).
  - **Both legs pin a per-clone port, and must keep doing so.** `smoke:packaged` runs two boots — the
    render leg, then the CSP leg — and each derives its own backend port from `clonePort.mjs`
    (render `38600+200`, CSP `38800+200`; the CSP leg also seeds `MODOKI_VITE_PORT`). Separate
    blocks on purpose: the legs run seconds apart against the same clone, so a shared block could
    hand the second boot a port the just-killed first is still releasing. Until 2026-08-02 the CSP
    leg pinned **nothing** and bound whatever was free — measured **5179/5173, the main clone's
    editor lane** — so a throwaway smoke build could silently answer an agent's `modoki_*` calls
    (#68). `engine/tests/architecture/clonePortHardcoding.test.ts` now fails any packaged-app
    spawner that doesn't derive a port.
  - **Per-clone MCP-targetable packaged editor**: `npm run editor:packaged` (or
    `bash engine/scripts/test-packaged.sh games/<id>`) builds the `.app` and
    launches it on the clone's pinned backend port — which `test-packaged.sh` now derives from the
    clone directory itself (#349). It has to: the pin used to arrive only as a literal prefix on the
    two npm entries, so running the script directly, or from ai2/ai3/qa, left `main.ts`'s
    sticky-then-scan to pick — and that list *starts at 5179*. The packaged app honors `MODOKI_BACKEND_PORT`, so
    `MODOKI_BACKEND=http://127.0.0.1:<port>` drives it exactly like the dev editor. It uses the SAME
    port as that clone's dev editor, so run one **or** the other per clone, not both (the packaged app
    pins the port and refuses to drift). The launch stops the local dev editor + any packaged app
    first — it's a **single-instance** check, unlike the coexisting dev editors.
- **Why the `.app` is built to `/tmp`, never in-repo**: the packaged app's Node resolution walks UP
  the tree, so an in-repo `.app` would find the repo's `node_modules` and **mask** the exact
  "dependency excluded from the package" bugs the test exists to catch. Building outside the repo is a
  deliberate correctness property — do NOT relocate the build into the project folder.
  - **…and each loop owns its OWN directory there, per clone.** The temp dir is machine-wide, so the
    name is the only thing separating them: `test-packaged.sh` builds at `modoki-pkg-test-<clone>`,
    `smoke-packaged.sh` at `modoki-pkg-smoke-<clone>`. They must not converge — `editor:*:packaged`
    is `test-packaged.sh` `exec`ing a long-lived interactive editor out of its dir, while the smoke
    reaps packaged apps and `rm -rf`s its own before every build. `repro-cold-boot.sh` is the one
    deliberate SHARER: its default `OUT` reuses the **smoke** dir, because its job is to relaunch the
    app that gate just built. That coupling is invisible when it breaks — the script finds an older
    app and reports on it — so `engine/tests/architecture/tempPathScoping.test.ts` pins the two names
    to each other, and fails any temp path that lacks a per-clone discriminator.

⚠️ **`fs.stat` timestamps are FABRICATED for paths inside `app.asar`.** Electron's asar shim
reports a real `size` but synthesizes the times — measured on packaged Windows (2026-08-02),
`fs.statSync(__filename).mtimeMs` returned the current wall-clock on every launch. This silently
broke the Vite dep-cache bust in `engine/electron/main.ts`, whose signature was
`version:size:mtimeMs`: it never matched itself, so the packaged editor wiped and **cold
re-optimized its whole dep graph on every boot** instead of only after an app update — the
opposite of the intent, and it paid the cold-scan race window of #21 on every launch. The
signature is a content hash now, guarded by
`engine/tests/architecture/viteCacheBustSignature.test.ts`. **Never key packaged-build identity on
a file timestamp**; hash the bytes — reading + hashing `main.cjs` measures ~0.5ms (523KB), against
a full cold dep-optimize every launch. Measured after the fix: the wipe fires once per build and
then never again, and boot drops 9.6s → 7.8s across relaunches.

Why this loop exists: packaged-only bugs (minimal Finder PATH, asar-sealed `package.json`,
dereferenced `@modoki/engine` symlink, pruned devDeps, PROD-only CSP) are **invisible to
`npm run dev`** — the dev env has full PATH, live symlinks, no asar, no CSP. Static guards
(`engine/tests/electron/cspContract.test.ts`, `packagingManifest.test.ts`, run every `npm test`)
catch the cheap contract regressions; the `--dir` smoke catches the env-boundary class they can't.

**Before pushing a packaging change** (anything under `engine/electron/**`, `electron-builder.yml`,
`engine/plugins/**`, `engine/scripts/build-web.mjs`, `engine/toolchain/**`): run
**`npm run verify:packaged`** — it's `verify` **plus** `smoke:packaged` (build the faithful `--dir`
`.app` + assert it renders and enforces its prod CSP). This is a **manual** gate (no pre-push hook)
because it does a real `--dir` build + boots an editor window (~1–2 min) — too heavy for
every `verify`. Plain `verify` already runs the cheap static packaging guards, and release CI
(`release.yml`) runs the smoke on a tag, so `verify:packaged` is the local belt-and-suspenders for
the env-boundary class.

⚠️ **It runs on Windows too — it is not a macOS-only gate**, despite having been described as one
until 2026-08-02. `smoke-packaged.sh` carries no platform table: `engine/scripts/packagedAppPaths.mjs`
resolves the output dir, the executable (`.app/Contents/MacOS/…` vs `win-unpacked\….exe`), the
userData/vite-cache location, and the reap mechanism (`pkill -f` vs a `Win32_Process` filter on
`ExecutablePath`). Believing it was macOS-only is part of why a *packaged Windows* bug — the editor
being unable to extract any provisioned toolchain — survived undetected; see "Never assume `tar` is
bsdtar" in [editor-toolchain.md](editor-toolchain.md). Its release-time sibling
`assert-app-renders.sh` genuinely WAS macOS-only until the same date, which is why the Windows
release shipped without a render gate for as long as it did. It is wired in now (#94): the public
repo's `oss/.github/workflows/release-windows.yml` scaffolds a throwaway starter project and runs
`assert-app-renders.sh release/win-unpacked "$RUNNER_TEMP/smoke"` as a **fatal** step, matching
macOS. (The private `.github/workflows/release-windows.yml` was deleted 2026-08-03 — releases are
cut from the public repo now, see docs/engine-oss-publishing.md.) The explicit project argument is
load-bearing: the script defaults to `$REPO/games/3d-test`, and the public snapshot has no `games/`.

It stops the local dev editor and builds a throwaway `.app` on a **per-clone port outside the
5179/5180/5181 human-editor range** — the block and its override live in the harness port table in
[editor.md](editor.md) § "Port selection", not restated here.

### What the packaged smoke asserts

Four things, and the last two exist because this gate has twice reported a cheerful result while the
thing it was watching was broken:

1. **The renderer mounted** — `entityCount > 0` from `/api/scene-state`, which relays through the
   renderer, so a non-zero count already proves it answered.
2. **No Vite resolve/transform error** in the dev-server log, and no renderer console error.
3. **The app provisioned its own pinned Node.** `ensureNodeProvisioned()` catches its own failure and
   falls back to system npm, so on a dev box — which *has* npm — a total provisioning failure is
   invisible and every other assertion still passes. That is not hypothetical: a bare `tar` on Windows
   resolved to Git's GNU tar, which cannot read a zip and treats `C:\…` as a remote host, so the
   packaged Windows editor could **never** extract its toolchain while this gate printed `PASS ✅`.
   The asymmetry that makes it worth guarding: an end user has no system Node, so what degrades
   gracefully here is a dead build for them. The assertion compares against `PINNED_NODE.version`
   read from `engine/toolchain/nodeProvision.ts`, so it also catches a **stale packaged build**
   shipping an older Node than the tree pins.
4. **Nothing leaked in from another clone.** The launch passes `--user-data-dir`, because
   `resolveUserDataDir` scopes the profile per clone only for **dev** — packaged returns the single
   `<appData>/Modoki Editor`, correctly assuming a shipped app is installed once. Our harnesses break
   that assumption: four clones each build and smoke their own packaged app. Since
   `modoki-last-scene:<project name>` is keyed by project NAME with a clone-ABSOLUTE value, a run
   restored another clone's scene, `/@fs` correctly 403'd it, and assertion 2 failed for a reason
   unrelated to the commit. `shouldOverrideUserData()` stands down for that switch precisely so a
   harness can isolate itself. `assert-app-renders.sh` (the release gate) does the same.
   Guarded by `engine/tests/architecture/packagedLaunchIsolation.test.ts`.

### Two packaged-boot flakes, both closed unreproduced (#21, #68)

Both were rare, neither was ever reproduced on demand, and both are **closed** — recorded here
because a closed ticket is where this kind of knowledge goes to die, and because the next person
to see either symptom should not restart the investigation from zero.

They are **different defects** despite a similar smell. Do not merge them in your head: one
*crashes* with a module error, the other *exits 0* without crashing.

**Cold-boot crash (#21)** — the first boot after an install/upgrade could crash the renderer with
`… does not provide an export named …`. Seen 1-in-6 on a real Windows install, never on a warm
relaunch. Two things came out of it:

- **Root-caused and fixed:** Vite keys its dep-optimize cache on the **lockfile**, not on
  `@modoki/engine` source (a symlinked workspace dep), so after an app update the old pre-bundled
  chunk was reused and every import of a newly-added export failed. `main.ts` now busts the cache on
  a build-signature change. That signature must hash the **bytes** of `main.cjs` — never an
  `fs.stat` mtime, because `__filename` lives inside `app.asar` and Electron's asar shim fabricates
  stat times, so an mtime-keyed signature never matches itself and wipes on *every* boot. Guarded by
  `engine/tests/architecture/viteCacheBustSignature.test.ts`.
- **Not root-caused *at the time*:** a residual crash on a genuinely *cold* cache (the wipe fired on
  the same boot that then crashed) — read then as a race during the cold optimize rather than
  staleness. **#110 later explained this shape** (see below) and, in doing so, showed the mitigation
  could not work. `main.log` carries `retryCount=` / `staleDepOptimizeSignature=` / `willRetry=` on
  every catch — that is still the trail to pull.

**Stale HTTP cache across an update (#110)** — the same `does not provide an export named …` crash,
on packaged Windows 0.3.7 opening `demos/postfx-demo`, *with the dep-cache wipe working correctly*.

Wiping `vite-cache` is necessary but **not sufficient**. Vite serves `/deps/*.js?v=<browserHash>`
with `Cache-Control: immutable`, and `browserHash` keys on the **lockfile + optimizeDeps config**,
not on `@modoki/engine` source. An engine-only update therefore leaves the dep URL **byte-identical**,
and Chromium replays the **pre-update body** from its own disk cache — which lives in `userData` and
survives the update exactly like the dep-cache does. The freshly re-optimized, *correct* chunk sits
on disk unread.

What was measured, on the running failed instance:

| Observation | Value |
|---|---|
| `waitForEditorJournal` in the on-disk dep (written **before** the crash) | **present** |
| `browserHash` on disk vs the failing URL's `?v=` | `d000db2e` — **identical** |
| Chromium HTTP-cache entries for that exact URL | **4** |
| Delete the **browser** caches — `Cache/` + `Code Cache/` (vite-cache untouched, same browserHash) | **boots clean** |

⚠️ That repair deleted **both** browser cache dirs, so the evidence does not isolate the HTTP cache
from V8's compiled-code cache. `session.clearCache()` and `session.clearCodeCaches()` are separate
APIs over separate dirs. In principle V8 revalidates its entry against the source it compiled, so
the code cache alone should not resurrect a stale chunk — but that is reasoning, not measurement,
so `clearBrowserCaches()` clears both rather than shipping something narrower than what was proven.

Two things follow, and both were wrong in the code before:

- **The cold-scan-race theory did not fit this failure.** The pre-bundle was complete and correct
  before the renderer ever asked for it — nothing raced. (This does *not* retire the race as an
  explanation for #21's *fresh-install* 1-in-6 rate: a fresh profile has no stale HTTP cache to
  replay. It does explain the "cold cache, still crashed" shape.)
- **`EditorBootBoundary`'s bare `location.reload()` could never clear it** — the reload re-requests
  the same immutable URL and receives the same stale body, so the one capped retry was spent for
  nothing and the red screen was painted anyway. That is exactly what `willRetry=false` after
  `retryCount=1` recorded.

Fixed by clearing the browser caches on a build-signature change (`clearBrowserCaches()` alongside
the `vite-cache` wipe), and by making the boundary's retry clear them over IPC *before* reloading.
Guarded by `viteCacheBustSignature.test.ts` (the clears must stay together, and the helper must
cover the code cache as well as the HTTP one)
and `editorBootBoundary.test.tsx` (which pins the clear-then-reload **order** — a clear that lands
after the reload is indistinguishable from no clear at all).

⚠️ **Why no gate caught it, and still won't:** this only bites on **update-over-install**, where
`userData` carries forward. `smoke:packaged` and `repro-cold-boot.sh` both start from a fresh
profile, so neither exercises the path. Testing an upgrade means installing the *previous* version,
running it once, then installing the new one over it.

Measured 2026-08-03 (v0.3.6, macOS): **30/30 cold boots clean** via
`engine/scripts/repro-cold-boot.sh` — no crash, no boundary fire, no console errors. At the observed
Windows rate that outcome has p≈0.4%, so the rate really is **materially lower on macOS**, which is
consistent with the leading theory (one-time Defender/SmartScreen read latency over a freshly
extracted `app.asar.unpacked` — something a Mac cannot exercise). The same run positively confirmed
the build-signature fix against the real packaged binary: a reused profile wiped on boot 1 and
**not** on boot 2. **So run that loop on the Windows clone, not here.**

Two traps that script encodes, both of which cost a wrong answer while writing it:

- **Cold means a fresh `--user-data-dir`**, not a cache wipe. `vite-cache` lives under userData, so a
  throwaway profile is colder *and* leaves the shared `Modoki Editor` profile alone —
  `clean-packaged-cache.mjs` would have destroyed a human's recents, layouts, and prefs.
- **`$TMPDIR` is not `/tmp` on macOS.** Defaulting the build dir to `${TMPDIR:-/tmp}` resolved a
  *different, day-old* app than the one just built, and reported it green. The script now derives the
  path from `packagedAppPaths.mjs tmpdir` (the same helper `smoke-packaged.sh` uses) and warns when
  the packaged binary is older than `engine/electron/dist/main.cjs`.

**Smoke CSP flake (#68)** — `smoke:packaged` failed its CSP leg once in three runs on identical code:
the app **exited cleanly (code 0)** before the editor page appeared, so there was nothing to
diagnose. Both of its suspects were addressed in `5a663d56`: `assert-app-csp.mjs` now keeps a rolling
tail of the child's stdout/stderr and reports it with the exit code/signal on failure, and
`smoke-packaged.sh` no longer races teardown with a fixed `sleep 1` — it **polls for the first
instance's actual death** (bounded, so a genuinely stuck process still fails loud). Never recurred
in 15+ runs afterwards. If it returns, the failure now self-reports instead of printing `code 0`.

The one thread genuinely shared with #21 — a suspected teardown race on the packaged `userData` /
Vite dep-cache — is a *hypothesis overlap*, not an established common cause. Worth checking both if
either recurs.

### Packaged renderer boot + build-chain bugs (fixed)

Four bugs found stress-testing the very first packaged DMG (`dist:dir`), each invisible to
`npm run dev` because each depends on a packaging-only boundary:

- **Renderer never mounted** — the Vite error overlay reported `Failed to resolve import
  "@zappar/msdf-generator"` from the pre-bundled `SceneManager` chunk, so React never mounted and
  the whole `/api/*` backplane was dead. Root cause: `main.ts` relocates Vite's dep cache to
  `userData/vite-cache`, OUT of the `node_modules` tree (the bundle itself is read-only), so the
  `optimizeDeps.exclude`d `@zappar` package (WASM + worker, self-resolves via `import.meta.url`)
  could no longer resolve a bare import from there. Reproduced only packaged — an on-disk
  `MODOKI_PROD=1` smoke test worked, because that keeps the dep cache in-tree. Fixed with a
  `resolve.alias['@zappar/msdf-generator']` in `engine/vite.config.ts` pointing at the absolute
  `<repoRoot>/node_modules/@zappar/msdf-generator` path (guarded with `existsSync`, so it's a no-op
  in dev).
- **`npm run build` → "Missing script: build"** — electron-builder strips `scripts` from the
  packaged app's `package.json` unconditionally, even via `extraMetadata`. Fixed by invoking the
  script directly at every build-step call site: `node engine/scripts/build-web.mjs`.
- **`tsc: command not found`** — the packaged app ships no `node_modules/.bin` symlinks, and
  `typescript` is a pruned devDependency (only `dependencies` + `optionalDependencies` ship — `vite`
  is a real dep so it's present). Fixed in `build-web.mjs`: run Vite via its resolved JS entry with
  `process.execPath` (`node node_modules/vite/bin/vite.js`) instead of a `.bin` shim, and **skip the
  tsc typecheck when `node_modules/typescript/bin/tsc` is absent** — the engine ships pre-built, an
  external project's game code isn't in the tsc scope anyway, and Vite transpiles TS via esbuild
  regardless.
- **Misleading "Connection lost"** — the no-`webBucket` deploy path sent a bare SSE `status` event
  then closed the stream, so the client's `onerror` fired and reported a generic connection failure
  instead of the real message. Fixed by sending an explicit `FAILED:` status (matching the
  missing-tools path), so build/deploy failures now surface cleanly instead of reading as a dropped
  connection.

All four verified end-to-end on a clean-from-source repackage: renderer mounts, `/api/scene-state`
returns 200 entities, a "Build → Web" run on a clean packaged install completes and deploys.

### The packaged editor must not write inside its own bundle (#326)

A packaged editor's `REPO_ROOT` is `<Resources>/app.asar.unpacked` — **inside the signed `.app`**.
Anything the build chain writes relative to it lands in the bundle, where a write is not a
permission problem but an **integrity seal** problem: nothing errors, and only `codesign --verify`
and `spctl --assess` ever notice. Three writers were found and closed:

| writer | fix |
|---|---|
| `engine/tsconfig.app.scoped.json` | not written at all in a packaged build — deferred into the `existsSync(tscBin)` branch that already gates the typecheck (`3df0e65d4`) |
| `.modoki/device-guid` +3 backend state defaults | routed through `modokiStateDir()`, which points at `~/.modoki` when `MODOKI_PACKAGED=1` (`ed17ff8a2`) |
| `node_modules/.vite-temp/…mjs` — Vite's compiled config | the packaged app is handed a **CJS** config, whose loader branch never writes (below) |

**The `.vite-temp` mechanism, and the one asymmetry the fix rests on.** Vite's default `bundle`
config loader esbuild-bundles the config, then `loadConfigFromBundledFile` branches on
`isFilePathESM(configPath)` — which is decided by extension first, and only then by the nearest
`package.json` `type`:

- **ESM** (`engine/vite.config.ts` under this repo's `"type": "module"` root) → writes the compiled
  config to `<nearest node_modules>/.vite-temp/…mjs`, imports it, unlinks it. The directory is
  chosen by walking up from the **config file**, not from `root` or `cacheDir`, so no option moves
  it — which is why every attempt to configure this away failed.
- **CJS** (`.cjs`) → hooks `require.extensions` and compiles **in memory**. It writes nothing.

So `engine/scripts/stage-vite-config.cjs` (a `beforePack` stager) esbuild-bundles `vite.config.ts`
into a gitignored `engine/vite.config.cjs` shipped in the bundle, and `chooseViteConfig()`
(`engine/scripts/viteConfigChoice.mjs`) hands Vite that one when the engine is running **packaged**
(not by whether a `.cjs` happens to exist — a stray one left behind by an interrupted pack would
otherwise make a dev clone silently build against a frozen snapshot, and a packaged app whose
`.cjs` never got staged would otherwise silently fall back to the writing config with nothing
said). Deciding on packaged-ness makes a stray `.cjs` in a clone inert and a missing one in a
packaged app loud instead.

⚠️ **Bundling to CJS empties `import.meta`, and this plugin graph is full of self-locating modules.**
Three already branch to `__filename`/`__dirname` when it is absent — and `native-dynamic-import.ts`
**depends** on the absence, so do NOT "fix" the esbuild warnings with a `--define:import.meta.url=…`;
that silently takes the wrong branch. The one module that did not branch, `courtAuthored.mjs`, killed
the entire packaged build at config load with `fileURLToPath(undefined)`.
⚠️ And **everywhere in this graph `import.meta.url` must appear verbatim.** Vite's own config
bundler rewrites that exact expression to the defining module's URL; a paraphrase like
`(import.meta as { url?: string }).url` slips past the define and silently resolves to the **temp
file** under `node_modules/.vite-temp/` instead. Measured against vite 8.2.0 under the repo's own
shape — a `.ts` config beneath a `"type": "module"` root — for the entry config *and* for an
imported module. (Probe it under any other shape and it looks clean: a `.cjs`/non-`type: module`
config takes the in-memory branch, and with no `node_modules` above it the temp file lands beside
the original, where the wrong path is indistinguishable from the right one.) In `vite.config.ts`
the paraphrase killed the build outright — `engine/node_modules/.vite-temp/index.html`; in
`font-instance.ts` it was silently wrong for months and merely benign, because `require.resolve`
walks up to the same `node_modules` anyway. Both classes are pinned by
`engine/tests/plugins/packagedViteConfig.test.ts`.

**Measured 2026-08-22 — two corrections to what was previously believed here.**

1. **`.vite-temp` alone does not persistently break the seal.** On a build that completes, Vite
   unlinks the temp file and leaves an **empty** directory, and `codesign` does not seal empty
   directories — `codesign --verify --deep --strict` still exits 0. It does leave a window *during*
   the build where the bundle is invalid, and a build that dies mid-config-load leaves the file. The
   persistent breaks measured on the v0.5.1/v0.5.2 rcs were the other two writers in the table.
   The fix is still worth having (no write at all, and it removes the Windows EPERM at its source —
   confirmed on Windows, grant removed entirely, see `docs/windows.md`) but do not re-derive the
   causal story from this paragraph: **re-measure**, per QA-PKG-0009 step 7.
2. **A broken seal does not strand users.** Measured against the real GitHub feed with the published
   signed `v0.4.0` (feed latest `v0.4.1`): a seal-broken app still launches, its main binary still
   reports a Developer ID signature so the ad-hoc skip in `autoUpdate.ts` never fires, the check
   finds the update, downloads it, and **the install succeeds** — replacing the whole bundle, which
   both applies the fix and restores a valid signature. The update path is self-healing.

**`npm run smoke:packaged` now checks this automatically.** It snapshots the bundle's file list
after `electron-builder` finishes and re-lists it after both app boots, failing on any added or
removed path (`engine/scripts/assertBundleUnchanged.mjs`). Directories are deliberately not
listed — an empty `.vite-temp` is not a seal break, and listing it would report the wrong writer.
An empty snapshot fails rather than passing vacuously. It does NOT cover a *build*, only startup;
for the build path the manual protocol below is still the check.

**How to verify a fix in this class — nothing cheaper distinguishes the outcomes.** Build the
packaged `.app` (`npm run smoke:packaged` leaves one under the temp dir); it is ad-hoc signed by
`--dir` in a state that already fails `--verify`, so give it a real seal first with
`codesign --force --deep --sign - <app>` and confirm exit 0. Then launch it with a scaffolded
throwaway project, run **Build → Web from its own menu**, and re-assess:

```bash
codesign --verify --deep --strict "<app>"; echo "exit=$?"     # must still be 0
find "<app>" -type f | sort > after.txt; comm -13 before.txt after.txt   # must be empty
```

Two traps this class keeps setting. **Never read the exit code through a pipe** — `codesign … | tail`
reports `tail`'s status, and a broken signature reads as a pass. And **verify on a project that
exercises the asset pipeline**: `games/anim-bug` has no rigged model, so it builds identically with
or without the `--configLoader runner` that was wrongly declared good on it; `demos/forest-camp` is
the distinguishing fixture.

## CLI recipes

The examples use `games/<id>`; substitute the project and its appId. Note the **project-dir cwd**
for `cap`/`xcodebuild`/`gradle`. A game's concrete bundle id, Apple Team ID, and device IDs live in
its own `games/<id>/CLAUDE.md`.

### Web
```bash
MODOKI_PROJECT=games/<id> npm run build -- --target web   # TypeScript check + Vite build → games/<id>/dist
```
`--target` is required (#40) — `web` honors the project's `build.webBasePath` (sub-path hosting), so
the SAME command run for an iOS/Android pre-`cap sync` build must say `--target native` instead
(base `"/"`, since Capacitor serves the dist from the app root). There is no default in either
direction: defaulting would be silently wrong for one of the two callers.

#### `--target native` runs the same three in-process heals as the editor (#148, #150)

Before its shell steps, `build-web.mjs` now runs the SAME three in-process heals as the editor's
`/api/build`, in the same order, for the same reason each exists:

| In-process heal | Editor `/api/build` | CLI `--target native` |
|---|---|---|
| `healNativeConfig` — sync `build.appleTeamId` → iOS `DEVELOPMENT_TEAM`, Android `local.properties` | ✅ | ✅ |
| `ensureCapacitorDeps` — add engine-REQUIRED Capacitor plugins the project predates | ✅ | ✅ |
| `vendorEnginePlugins` — re-pack + install a changed engine plugin | ✅ | ✅ |

Games don't build `engine/packages/capacitor-*` from source — they depend on a content-addressed
tarball committed into the project (`"capacitor-game-debug": "file:plugins/…-<hash>.tgz"`). So a
plugin edit only reaches a device once that tarball is re-packed and installed; a project that
predates an engine-required Capacitor plugin (`@capacitor/preferences`, `@capacitor/app`, …) never
gets one just by building; and `build.appleTeamId` only reaches a device build once it's synced
into the generated native project. On `web`/`playable` none of this runs (every heal here is a
native-artifact concern; a web build has nothing to keep fresh and must not pay for it).

Landed in two steps: #148 added only the third heal, which meant following the CLI recipes after a
plugin edit produced an IPA/APK containing the PREVIOUS native code while every signal reported
success; #150 closed the remaining two, using the exact editor semantics — same ordering, same
install condition — rather than re-deriving them:

- **Order is load-bearing.** `ensureCapacitorDeps` runs BEFORE `vendorEnginePlugins`: when it adds
  `capacitor-game-debug`, it writes a placeholder dep spec (`'*'`), and `vendorEnginePlugins`
  rewrites that placeholder to the real `file:plugins/<name>-<ver>.tgz`. Vendoring first would
  leave the placeholder unrewritten — a project stuck depending on a spec npm can't install.
- **Install is conditioned on EITHER heal changing something** (`depHeal.changed ||
  v.needsInstall`), not just the vendor step — a newly-added dep spec is just as inert until
  installed as a fresh tarball.
- `ensureCapacitorDeps` needs a platform, and `--target native` covers both; the CLI heals
  whichever of `ios/`/`android/` the project already has on disk (a project with neither yet is
  the editor's scaffold-then-build path, which the CLI has no equivalent entry point for).
- ⚠️ **A PACKAGED editor must never let this chain BUILD a plugin, and that is decided by an env
  var, not by the call site.** `vendorEnginePlugins`'s `canBuild` defaults to
  `process.env.MODOKI_PACKAGED !== '1'`; `main.ts` sets `MODOKI_PACKAGED=1` when `app.isPackaged`,
  and every child inherits it (`devServer.ts` spawns Vite with `...process.env`, and `build-web.mjs`
  runs under that). A packaged app ships each plugin's `src/` **and** `dist/` but no
  devDependencies — and packaging strips every binary shim, so its root `node_modules/.bin/` is
  EMPTY. `npm run build` there runs `rimraf` and exits 127.
  **Why the default and not the three call sites:** it was the call sites, and it shipped broken.
  `ensurePluginBuilt` has had the guard all along and `main.ts` passed it correctly, but the two
  sites that run during a native build — `vite-asset-scanner`'s build path and `addNativeTarget`'s
  auto-scaffold — live in the Vite dev-server process and passed nothing, so `?? true` won. In the
  v0.5.0 packaged editor the first iOS/Android build of any project killed its own dev server;
  the Electron backend survived, so every later build reported **"Connection lost"** and it read
  as a network fault rather than a dead server. Found building `demos/forest-camp`, fixed in 0.5.1.
  Pinned from both ends: `tests/electron/packagedEnvSignal.test.ts` (the signal is SET and
  inherited) and `vendorPlugins.test.ts` § "the packaged-editor default" (it is READ).

#### The engine-required Capacitor plugins must be COMMITTED, not just healed

`ENGINE_REQUIRED_CAP_PLUGINS` (`engine/plugins/addNativeTarget.ts`) is the list the engine runtime
calls on every platform — `@capacitor/preferences` (PlayerPrefs), `@capacitor/app` (lifecycle /
back-button), `@capacitor/keyboard`, `@capacitor/splash-screen`. Every project with a native target
must carry them in its own `package.json`.

**A heal is not a substitute for committing them, and the reason is not obvious.** Because
`ensureCapacitorDeps` adds them on every native build, a project that has drifted off the list still
builds fine here — the editor heals on the way past, and the tree it writes is never the tree that
gets committed. That is precisely how four projects drifted unnoticed (`alien-animal`,
`audio-demo`, `chess`, `demos/2d-physics-demo` — each missing all four).

The one that mattered was the demo. `publish-demo.sh` exports **committed** content, and it strips
only `file:` deps and `workspaces` from the staged `package.json` — registry deps are retained. So
the published snapshot shipped a manifest with no `@capacitor/preferences`, and anyone building
from that snapshot (`npm install` → `npx cap add` → `cap sync`, with no Modoki editor anywhere in
the loop) never runs the heal and gets `"Preferences" plugin is not implemented on <platform>` at
launch, the first time PlayerPrefs is touched. **A heal that only runs on our machines cannot
protect someone building from the snapshot; only the committed file can.**

Guarded by `engine/tests/architecture/nativeProjectDeps.test.ts`, which asserts committed state and
reads the list from `ENGINE_REQUIRED_CAP_PLUGINS` rather than restating it. If it fails: run a
native build for the named project, then `npm install` in it, and **commit the `package.json` +
`package-lock.json`** — committing is the part that matters.

Two notes worth carrying:
- **`npm` ships `README.md` regardless of the `files` field**, so editing a plugin's DOCS re-hashes
  its tarball. Expect a re-vendor after a docs-only plugin edit.
- To re-vendor **without** building: `node engine/scripts/vendor-plugins.mjs games/<id>`, then
  `npm install` in the project. `engine/tests/architecture/vendoredPluginFreshness.test.ts` fails
  `npm test` on a project whose pin has gone stale — and, since #375, on a tarball whose NAME is
  current while its BYTES are not. That second check OPENS the `.tgz` and compares it to the plugin
  source file by file; the name check alone let an interrupted re-vendor, a merge that took the new
  `package.json` with the old `plugins/*.tgz`, or a `git checkout <old-sha> -- <project>/plugins/`
  pass green and ship the previous native code. It compares the shipped set MINUS `dist/` — the same
  set the tarball's NAME is computed over. `dist/` is deliberately out of scope: it is gitignored,
  rebuilt per clone, and the vendorer already refuses to re-pack on a dist-only change (the
  "toolchain-drift churn killer" test), so failing on one would demand a re-vendor of all 21
  tarballs plus 21 lockfiles for a tsc patch bump — the exact churn that decision exists to
  prevent. Two halves of one system cannot hold opposite positions on the same input. A third check hashes each tarball and compares it to the `integrity` its
  project's `package-lock.json` records (driven off the lockfile, so a project that drops the dep
  from `package.json` while the lock keeps it is still seen) — a re-vendor can rewrite a tarball under an UNCHANGED name
  (the name omits `dist/` by design), and a lockfile not refreshed in the same commit breaks
  `npm ci` in CI and in every fresh clone while a warm `node_modules` hides it locally.
- **Re-vendoring is NOT automatic on an ordinary build** — it only runs on project open/scaffold,
  or when `ensureCapacitorDeps` detects a missing dep. So editing `engine/packages/capacitor-<x>/**`
  mid-session and then just re-running a build silently builds against the STALE vendored copy.
  Re-vendor after **every** plugin source edit, not once per session: `node
  engine/scripts/vendor-plugins.mjs games/<id>` then `npm install` in that game dir — verify by
  grepping the new source string into `games/<id>/node_modules/<plugin>/...` before trusting a
  device build. A `git status` on `games/<id>/plugins/*.tgz`/`package.json` after re-vendoring
  confirms whether it actually changed.

#### Why the vendored tarball's hash churns, and the fix

The tarball naming (`games/<id>/plugins/<plugin>-<hash>.tgz`) used to re-pin constantly across
clones/over time with **zero shipped-content changes**, forcing a spurious re-vendor + re-commit
in every game that depends on the plugin. Root cause: `engine/plugins/vendorPlugins.ts`'s
`pluginContentHash` hashed the plugin's **built output** (`dist/`, rebuilt on every `npm install`
and sensitive to the exact tsc/rollup version, plus local uncommitted `android/build/` +
`android/.gradle/` litter) instead of its source. That output drifts across clones/over time with
no source change → new hash → new filename → re-vendor churn. An earlier fix ("scope to the
published fileset") was insufficient — it still hashed `dist/` and assumed `src/` was the volatile
input, when it's the reverse.

**Fix:** hash the plugin's SOURCE inputs instead — every file EXCEPT derived build/cache dirs
(`dist`, `build`, `.gradle`, `.build`, `DerivedData`, `Pods`, `.cxx`, at any depth) plus npm junk.
The tarball identity now answers "did the source change?", not "did the build output shift?". Plus
`.gitattributes` forces `eol=lf` on the hashed source text types (`.mjs`/`.cjs`/`.mts`/`.cts`/
`.kt`/`.kts`/`.podspec`) so a Windows CRLF checkout can't drift it on its own. Guard test in
`engine/tests/plugins/vendorPlugins.test.ts` ("does NOT re-pack when ONLY the built `dist/`
changes" + a build-litter test). **If it churns again, the hash differing between clones means
their checked-out SOURCE differs — check line endings or an untracked file leaking into the plugin
dir, not the build output.**

⚠️ **STILL OPEN: the hash covers non-shipped files.** `pluginHashInputs` hashes everything not
under `dist`/build dirs, which still includes a plugin's **test** files (`android/src/test/`,
`ios/Tests/`, `test-vectors/`) — not in the plugin's npm `files` allowlist and not shipped in the
tarball. Adding/editing plugin tests therefore still re-pins the vendored tarball in every game
that depends on it, with a byte-identical shipped-content diff. The correct fix is NOT simply
"scope to the npm `files` allowlist" — that would drop `src/` from the hash and break the
deliberate, tested contract (`vendorPlugins.test.ts`) that a `src/` edit MUST re-pack (`src/` is
hashed as a proxy for the excluded, toolchain-volatile `dist/`). The correct input set is
`(shipped files MINUS dist/) ∪ (dist build-inputs: src/ + tsconfig + rollup + package.json)` —
keep `src/` + shipped native, exclude only non-shipped/non-build dirs (tests, test-vectors).
Deferred as medium+delicate, not small — changing the algorithm re-pins every game's tarball once.

#### Web deploy (`gcloud`)

The web deploy step (`gsutil`/`gcloud storage` upload + CDN invalidation to `webBucket`) shells out
to `gcloud`, which is a **sanctioned system tool like `xcodebuild`** — it carries the user's cloud
auth, so it can never be provisioned by the toolchain the way Node/JDK/Android SDK are (see
[editor-toolchain.md](editor-toolchain.md)). A **Finder-launched** packaged editor gets a minimal
PATH with no Google Cloud SDK on it, so a deploy that works from a full-PATH shell can fail on the
exact same machine when launched normally, with `gcloud: command not found`.

`resolveGcloudDir(override?)` (`engine/plugins/vite-asset-scanner.ts`) resolves it in order:

1. **Project Settings override** — `user.sdk.gcloudPath` (a binary or bin dir), the per-machine
   `project.user.json` field surfaced in the editor as Web Deploy → "gcloud path override".
2. **Well-known dirs** — `/opt/homebrew/bin`, `/usr/local/bin`, `~/google-cloud-sdk/bin`,
   `/usr/local/google-cloud-sdk/bin`, `~/.local/bin`.
3. **Login-shell `command -v gcloud`** — a last resort that only works when launched from a shell
   that sources the user's profile.

The web-deploy step prepends the resolved dir onto every deploy step's PATH (mirroring the
iOS/CocoaPods PATH block); if `gcloud` is genuinely absent, the step fails fast with an install
hint instead of the mid-stream "command not found" a bare shell-out would produce. Verified on the
packaged app under a minimal PATH (no `/opt/homebrew`): the deploy resolves `gcloud` via the
well-known dirs and completes ("✅ deployed successfully").

### iOS Simulator
```bash
MODOKI_PROJECT=games/<id> npm run build -- --target native
(cd games/<id> && npx cap sync ios)
xcodebuild -project games/<id>/ios/App/App.xcodeproj -scheme App -configuration Debug \
  -sdk iphonesimulator -destination 'id=<SIM_UDID>' build
xcrun simctl boot <SIM_UDID>
xcrun simctl install booted <path-to-App.app>
xcrun simctl launch booted <appId>
```

### iOS Device
```bash
MODOKI_PROJECT=games/<id> npm run build -- --target native
(cd games/<id> && npx cap sync ios)
xcodebuild -project games/<id>/ios/App/App.xcodeproj -scheme App -configuration Debug \
  -destination 'id=<DEVICE_UDID>' -allowProvisioningUpdates build
xcrun devicectl device install app --device <DEVICE_ID> \
  ~/Library/Developer/Xcode/DerivedData/App-*/Build/Products/Debug-iphoneos/App.app
xcrun devicectl device process launch --device <DEVICE_ID> <appId>
```
First device install requires trusting the developer profile: Settings → General →
VPN & Device Management → Trust.

⚠️ **Those last two lines are iOS 17+ ONLY.** `devicectl` is CoreDevice-only and **cannot see an
iOS ≤16 device at all** — including this Mac's main iOS test device, the iPhone 8 (16.7.16). Read
without this note, the recipe above looks like the only route and the answer looks like "open Xcode
and press ⌘R"; it is not, and an agent can deploy to a 16.x phone unattended — both from the CLI
recipes below and, as of #217, from `Build → iOS Device` itself (next section).

**iOS ≤16 — go-ios** (`engine/toolchain/goIosProvision.ts`; installable from **Build Support…** or
provisioned automatically by a build that needs it). This is what `Build → iOS Device` now uses —
see "Hands-free install (go-ios)" below. The manual equivalent is shorter than libimobiledevice:
`ios install` takes the built `.app` **folder** directly, no `Payload`/zip step:

```bash
xcodebuild -project games/<id>/ios/App/App.xcodeproj -scheme App -configuration Debug \
  -destination 'id=<UDID>' -allowProvisioningUpdates -derivedDataPath /tmp/<id>-dd build
ios install --path=/tmp/<id>-dd/Build/Products/Debug-iphoneos/App.app --udid=<UDID>
ios launch <appId> --udid=<UDID>
```

No sudo, no tunnel, no manual Developer Disk Image mount is needed on 16.x — measured on the iPhone
8 (16.7.16): kill the running app, `ios install` + `ios launch`, whole cycle ~4s, verified by a new
pid that outlives the tool.

⚠️ **`ios install` is INTERMITTENT, and `ideviceinstaller` is the fallback that has never failed
here** (2026-08-20, QA-BUILD-0004). The ~4s success above is real and reproducible at other times —
but the same command also fails outright, and when it does the message points at the wrong thing:

```
ERROR failed writing — "your app is not properly signed for this device, check your codesigning
and provisioningprofile. original error: 'ApplicationVerificationFailed' errorDescription:'Failed
to verify code signature of .../installd.staging/temp.XXXX/extracted/App.app.ipa.app :
0xe8008017 (A signed resource has been added, modified, or deleted.)'"
```

**Do not go hunting the signing — it is verifiably correct when this happens.** Measured on
`games/3d-test`: `codesign --verify --deep --strict` reports *valid on disk* and *satisfies its
Designated Requirement*; zero extended attributes; no AppleDouble, `.DS_Store`, symlinks or empty
directories; six nested framework seals all validating; and the `embedded.mobileprovision` is the
wildcard team profile **containing the target device's UDID**.

Five controlled installs isolate it — and the discriminator is **nested frameworks**, not the
device and not iOS 16:

| installer | bundle | frameworks | device | result |
|---|---|---|---|---|
| go-ios 1.3.2 | 3d-test | 6 | iPhone 8 (16.7.16) | FAIL `0xe8008017` @ VerifyingApplication 40% — debug-dylib build |
| go-ios 1.3.2 | 3d-test | 6 | iPhone 8 (16.7.16) | FAIL `0xe8008017` @ 40% — rebuilt `ENABLE_DEBUG_DYLIB=NO`, monolithic |
| go-ios 1.3.2 | 3d-test | 6 | iPad mini (18.7.8) | FAIL `0xe8008017` @ 40% — same bundle |
| go-ios 1.3.2 | 3d-test | 6 | iPhone 8 (16.7.16) | FAIL — 4th attempt, *after* ideviceinstaller had installed it |
| **go-ios 1.3.2** | **court** | **2** | **iPhone 8 (16.7.16)** | **SUCCESS — InstallComplete (100%)** |
| **ideviceinstaller 1.2.0** | 3d-test | 6 | iPhone 8 (16.7.16) | **SUCCESS — InstallComplete (100%)** |

⚠️ **So go-ios is NOT broken generally, and this is the correction that matters.** An earlier
version of this section said the installs isolated the fault "to go-ios, not to the bundle" — the
`court` control disproves that. `com.apiary.court` carries 2 frameworks (Capacitor, Cordova)
and installs first try; `com.modokiengine.tropicalisland` carries 6 (those two plus
FirebaseAnalytics, GoogleAppMeasurement, GoogleAppMeasurementIdentitySupport,
GoogleAdsOnDeviceConversion) and fails **4/4**. Both pass `codesign --verify --deep --strict` and
both embed a profile containing the device UDID. **It is deterministic per bundle**, which is why
it reads as "works sometimes": nearly every project here has 2 frameworks, and only `3d-test`
carries the Firebase/Google set.

`ios install` zips the `.app` and lets `installd` extract it (note the `.ipa.app` in the error
path); that round-trip is what breaks the signature's resource seal, and more nested signed code
means more seal to preserve. libimobiledevice does not use that path. Three dead ends already ruled
out, so nobody repeats them: it is **not** the Xcode 16 debug-dylib layout (rebuilding monolithic
changed nothing), **not** an iOS-16 limitation (the iPadOS 18.7.8 control failed identically), and
**not fixable by updating go-ios** — v1.3.2 (2026-08-11) is already the newest release, main's
commits since are dtx/instruments work, and the alternative install path is open and unmerged
upstream (danielpaulus/go-ios #810 AFC staging, #400 InstallProxy).

**So: when `Build → iOS Device` fails this way, install with `ideviceinstaller` rather than
debugging the certificate.** On 1.2.0 it takes the `.app` folder directly — no `Payload`/zip step:

```bash
ideviceinstaller -u <UDID> install /tmp/<id>-dd/Build/Products/Debug-iphoneos/App.app
```

⚠️ **`ideviceinstaller` is NOT part of Modoki's toolchain — do not design around it as a fallback.**
`engine/toolchain/` provisions go-ios, the JDK, the Android SDK, Node, Ruby and WDA; libimobiledevice
appears nowhere in engine code except two comments. It is on THIS Mac because it was `brew
install`ed, so the recipe above is a machine-local workaround an agent can use here — not something
a fresh clone on a fresh Mac will have. The product fix therefore cannot be "fall back to
`ideviceinstaller`" as-is; it has to be either fixing/upgrading go-ios past 1.3.2, or provisioning
libimobiledevice the way `goIosProvision.ts` provisions go-ios.

Tracked as testboard bug `QMomlhq4qN3dFQfpfSVT` (p1).

**iOS ≤16 — libimobiledevice** (`brew install libimobiledevice ideviceinstaller`; already on PATH on
this Mac) is the older manual route — kept because it still works and #205 proved it, on a device
class (an iPhone 7) that took a development-signed build with **no Xcode run at all**:

```bash
idevice_id -l                                   # the UDID; xcrun xctrace also lists 16.x devices
xcodebuild -project games/<id>/ios/App/App.xcodeproj -scheme App -configuration Debug \
  -destination 'id=<UDID>' -allowProvisioningUpdates -derivedDataPath /tmp/court-dd build
mkdir -p /tmp/ipa/Payload && cp -R /tmp/court-dd/Build/Products/Debug-iphoneos/App.app /tmp/ipa/Payload/
(cd /tmp/ipa && zip -qry app.ipa Payload)
ideviceinstaller -u <UDID> install /tmp/ipa/app.ipa
idevicedebug -u <UDID> run <appId>              # launch + attach stdout; idevicesyslog for logs
```

Three caveats, none of which the install step can fix for you:
- **This replaces the INSTALL, not the SIGNING.** The `.app` must already be development-signed —
  that is what the `xcodebuild` step above does, and it still needs a Team ID
  (`project.user.json`).
- **`idevicedebug run` needs the Developer Disk Image mounted**, which it is on any device Xcode
  has already run something on.
- **It does NOT buy trusted input.** That needs a WebDriverAgent XCUITest bundle, and Xcode refuses
  the iPhone 8 as a TEST destination — six theories tested and disproved, see
  [trusted-device-input.md](./trusted-device-input.md) § "WebDriverAgent lifecycle" (the "iOS 16 devices" entry). Getting there is `go-ios`
  territory and an owner decision, not something to re-diagnose.

The intended split, per [plans/low-end-device-support.md](./plans/low-end-device-support.md):
**iOS 15/16 → go-ios** (`ios install`/`ios launch`, what the editor build now uses; the manual
libimobiledevice recipe above still works as a fallback);
**iOS 17+ → `xcrun devicectl … --console`**.

**Normally you never type either of these — pick the phone from the Build menu.** `Build → iOS
Device` names its current target in the label and lists every device this Mac can see in a
submenu; picking one writes BOTH ids below into `project.user.json` **and starts the build**, so
the menu and Project Settings stay one source of truth. (`Set target without building…` in the
same submenu is the way to change the target without committing to a build — a started build
cannot be cancelled.) The submenu also says which install each device will get ("hands-free
install" for a devicectl-reachable iPhone, "hands-free install (go-ios)" for an older one) — see
[editor.md](./editor.md) § "Build → picking the target device". The fields stay editable by hand
for a device no listing can see (remote/WiFi, an unusual setup).

**Two DIFFERENT ids, and only the first is required.** Both live in the project's gitignored
`project.user.json` (per-machine, never committed — Project Settings → Build → "This Machine"):

| Field | From | Required? | Used by |
|---|---|---|---|
| `iosDeviceId` | `xcrun xctrace list devices` — the hardware UDID | **Yes** | `xcodebuild -destination 'id=…'` |
| `iosDevicectlId` | `xcrun devicectl list devices` — a different GUID | No | `devicectl` install + launch |

They are not interchangeable **in that direction**: `xcodebuild` rejects the devicectl GUID (see
`wdaLauncher.parseIosDevices`, which reads `hardwareProperties.udid` for exactly this reason). The
reverse is fine — `devicectl` accepts the hardware UDID as well as its own GUID (measured
2026-08-08: `xcrun devicectl device info details --device <id>` resolves the same phone for either
form), which is why the Build-menu picker can fill both fields from the one id it parses.

⚠️ **`devicectl` is CoreDevice-only — iOS 17+.** A pre-iOS-17 device has no devicectl id *in
existence*: `xcrun devicectl list devices` lists it `unavailable`, with no
`hardwareProperties.udid` at all. So leave `iosDevicectlId` **empty** for such a device — the build
then installs via **go-ios** instead (#217), provisioning it on demand if it isn't already present,
and only falls all the way back to the Xcode handoff (open the `.xcodeproj`, press Run ⌘R) when
go-ios is neither present nor provisionable. The decision is `planIosInstall`
(`engine/plugins/vite-asset-scanner.ts`), deliberately one exported pure function so the
preflight guard and the step plan cannot disagree — it now returns one of three modes:
`'devicectl'`, `'go-ios'`, `'xcode-handoff'`.

That disagreement is exactly what shipped for a while: the preflight demanded BOTH ids, so a
build that `xcodebuild` handles perfectly was refused before it started, and the refusal named
`project.config.json` — the wrong file. Caught on an iPhone 8 / iOS 16.7.16, whose build then
succeeded unchanged once the demand was dropped.

⚠️ **On some legacy hardware the INSTALL is hands-free and the LAUNCH never will be — the build
says so rather than reporting a failure** (measured 2026-08-19, iPhone 8 / iOS 16.7.16, Xcode
26.5). `ios install` lands the `.app` over usbmuxd in ~8 s; `ios launch` then fails with
`processcontrol failed: instruments service
"com.apple.instruments.remoteserver.DVTSecureSocketProxy" unavailable`, exit 1. That is the SAME
dead instruments stack that stops WebDriverAgent on that phone and hides it from `xctrace` — see
[trusted-device-input.md](./trusted-device-input.md) § "WebDriverAgent lifecycle" (the "iOS 16 devices" entry); do not re-diagnose it, and
note that mounting the Developer Disk Image is not the fix (`ios image auto` reports one is already
mounted and the launch fails identically).

The launch step is deliberately non-fatal — the new build is already ON the phone, which is the
part a tap cannot redo — so the build stays green and prints that the install succeeded, that the
app did not come to the foreground, and that launching goes through a service some older devices
do not provide. It used to say only "unlock the device and tap the icon", which names the one
cause that can never apply here and reads as "the deploy failed" while the app sits installed one
tap away. A locked or asleep device is still a real cause on healthy hardware, so it stays in the
message as the first thing to check — the correction is that it is no longer presented as the only
one. The install step's own failure message was corrected the same way: it asserted "it requires
iOS 17+", which is wrong-by-construction whenever `iosDevicectlId` came from the Build menu's
picker (the picker only fills it for a device devicectl can already see).

`idevicedebug --detach run <bundle-id>` (libimobiledevice, Homebrew) DOES launch that phone —
verified, exit 0, and the app outlives the tool. It is deliberately **not** wired into the build:
the editor does not provision libimobiledevice, so depending on it would make the deploy behave
differently on two machines depending on what Homebrew happens to have installed. Run it by hand
when you want the loop hands-free on such a device.

### Android Device
```bash
MODOKI_PROJECT=games/<id> npm run build -- --target native
(cd games/<id> && npx cap sync android)
eval "$(node engine/scripts/print-toolchain-env.mjs)"   # JAVA_HOME + ANDROID_HOME, resolved as the editor does
games/<id>/android/gradlew -p games/<id>/android assembleDebug
adb install games/<id>/android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n <appId>/.MainActivity
```

## Converted assets: the manifest points at the SOURCE, the build ships the VARIANT

A sibling of the section above, and the same "fine in dev, broken when built" shape. Five asset
kinds go through a converter — **textures, audio, environment HDRs, models, fonts** — and on a
successful conversion the shaker ships only the derived variant and **drops the source**. But a
manifest entry's `path` is still the SOURCE path. So a consumer that does `assetUrl(entry.path)`
gets a URL that resolves in dev (Vite serves everything off disk) and 404s in production.

Every consumer must therefore go through its variant resolver — `resolveTextureVariantUrl` /
`servedAudioUrl` / `modelGlbUrl` — each of which falls back to the bare source **only when the
asset is unconverted**, which is exactly the case where the source *is* shipped.

**Fonts are the exception that proves it**, and the one that shipped broken. A font has two
independent consumers needing different files:

| consumer | authored as | needs |
|---|---|---|
| canvas text (`Text2D.font`) | a **GUID** | `~atlas.png` + `~metrics.json` |
| DOM text (`UIElement.fontFamily`) | a **GUID** (a family NAME before #231) | the source `.ttf`/`.otf`, via FontFace |

`loadAllFonts` FontFace-loads the manifest path directly, so dropping the source 404'd every baked
font at boot in every game — visible only as `[FontLoader] N/N fonts failed to load`, with the
canvas text still rendering perfectly. It took an iPhone 7 to notice.

The source now ships **iff** a DOM consumer needs it:
`shipTtf = shipSource === 'always' || (shipSource !== 'never' && domUsed)`, where `domUsed` reuses
the tree-shaker's font-family walk (`TreeShakeResult.domFontFiles`). The build logs the decision
per font, and the manifest records `font.sourceShipped`, which `loadAllFonts` reads so a
deliberately-dropped font is skipped rather than fetched-and-warned.

⚠️ **`shipSource: 'auto'` cannot see a font named in CSS or assigned from game code** — a static
scan only reaches scene/prefab `fontFamily` (a GUID since #231, so the walk follows it as a real
ref and keeps its family's other variants too). A game that styles DOM text from a stylesheet must set
`shipSource: 'always'` in the font's `.meta.json`, or its text silently falls back to a system face.
This is the one known blind spot in the rule.

The DEV-EDITOR half of the same class — a scene's fonts registered by whichever editor panel
happened to be mounted, so the Game panel rendered serif with the Assets tab closed — is #253,
written up in [UI System](./ui-system.md) § "Who registers a scene's fonts". The runtime's
family→asset match (`loadFontFamily`) deliberately uses the SAME `parseFontFilename(path).family`
rule as `resolveFontsByFamily` here; if they ever diverge, a font works in the editor and is
absent from the shipped game.

## The app version + build number (`app.version` / `app.buildNumber`)

Two committed fields, synced into both platforms by `healNativeConfig` on project open and before
every native build — the same shape as the platform floors below:

| field | Android | iOS |
|---|---|---|
| `app.version` (marketing string, e.g. `"1.0"`) | `versionName` | `MARKETING_VERSION` → `CFBundleShortVersionString` |
| `app.buildNumber` (monotonic integer) | `versionCode` | `CURRENT_PROJECT_VERSION` → `CFBundleVersion` |

⚠️ **This exists because a duplicate build number is refused SILENTLY.** Play does not say "that
`versionCode` is taken" — the bundle never attaches, and the release page then reports three errors
that all mean *"this release is empty"* and none of which mention versions. It reads as a broken
upload rather than a refused one, so the first instinct is to re-upload, re-export, or re-check
signing. App Store Connect behaves the same way for a duplicate `CFBundleVersion`, with a different
but equally indirect message. Before #199 nothing in the engine managed either number, so every
project shipped the scaffolder's hardcoded `1` — which only mattered once a project published, and
then cost a diagnosis cycle.

**The heal never LOWERS a build number.** Lowering is the one direction that is always a mistake,
and it is exactly what a stale config, a fresh clone, or a forgotten bump would produce on a project
that has already uploaded. A would-be lowering is reported instead — naming the current value and
the smallest number that would work — rather than silently written.

⚠️ **A value the heal cannot READ is refused, not treated as absent** — that distinction is what
makes the never-lower rule hold, and getting it wrong defeated the rule in the version that first
shipped it. Two shapes reach it:

- **A dotted build number.** `CURRENT_PROJECT_VERSION = 1.2;` is legal — Apple compares
  `CFBundleVersion` component-wise, so `1.2` > `1` — but it is not an integer to order against.
  Skipping it read as "no existing value", which let the write lower `1.2` to `1`: the exact silent
  rejection this heal exists to prevent, produced by the code preventing it. Normalise such a value
  to a plain integer if you want `app.buildNumber` to manage it.
- **A form the pattern cannot see.** Both the Groovy `versionCode 1` and the AGP-8
  `versionCode = 1` are handled (the file's own separator is preserved, since these `build.gradle`
  files already mix the two — `namespace = `, `compileSdk = `). A *third* form — a variable
  reference, a syntax a later template introduces — is reported rather than silently unmanaged,
  which is the failure mode that would quietly reintroduce #199.

⚠️ **The two platforms' counters DRIFT APART**, because each store counts its own uploads:
`games/iap-test` measured Android 11 against iOS 5 (2026-08-20). One `app.buildNumber` still serves
both — the stores only require the number to RISE, so the lagging platform takes a one-time jump and
both stay valid from then on. That is why the never-lower guard compares per platform rather than
once, and why it reads the **highest** of a file's occurrences: a pbxproj carries the key per build
configuration, and a Debug left at 1 must not authorise lowering a Release at 11.

**Auto-increment is deliberately not offered.** A build number that changes itself makes builds
non-reproducible and churns a committed file on every build (the write-behind-your-back hazard in
CLAUDE.md). The owner bumps it, in the same change as the native edit it ships — a native change
that is not bumped never reaches the device.

### `app.buildNumberAuto` — derive it from the commit count (2026-08-25)

Hand-bumping per upload is exactly the chore this checkbox removes. With **Auto build number**
checked in Project Settings (General → App Identity), the typed `app.buildNumber` is IGNORED and
the effective number is derived from `git rev-list --count HEAD` of the project's repo at every
open/build, with the typed value kept as a **FLOOR** (`max` of the two) — so a store-forced jump
typed by hand still wins, and the never-lower guard keeps its role as the last line of defence
either way. The native files always see ONE resolved number; how it was derived never leaks into
them.

⚠️ **Typing that floor means unchecking Auto first.** `app.buildNumber`'s input carries
`disabledIf: { key: 'app.buildNumberAuto', is: 'true' }`, which is a real native `disabled` — not
dimming — so while Auto is on the field cannot be focused or typed into. The escape hatch is
three steps: **uncheck Auto, type the higher number, re-check Auto**, which is what the field's own
help text says. (This paragraph used to claim the floor could be raised *without* turning auto off;
it never could, and the help text added in the same commit contradicted it.) The floor survives the
round-trip because `buildNumber` is stored independently of `buildNumberAuto` — that is precisely
why the field is greyed out rather than hidden.

Two known wrinkles, both absorbed by the floor + never-lower pair rather than by cleverness:
commit counts differ between clones (`main` vs a worker branch), and the count is shared by every
game in the repo. Only store uploads care about the absolute value, and only monotonicity matters
there. A project copied OUT of its repo (no git) falls back to `app.buildNumber` with a note.

⚠️ **Auto mode re-introduces committed-file churn on purpose.** The rationale above rejects a
self-incrementing build number because it churns committed native files on every build — auto does
exactly that (the count moves with every merged commit, so whichever clone builds first rewrites
`versionCode`/`CURRENT_PROJECT_VERSION`). That is accepted noise here, not an accident: the churn
is the number staying TRUE instead of drifting stale, and merge conflicts from two concurrent
builds resolve to the higher value either way. The #18 rule still applies — don't sweep these into
unrelated commits.

The defaults (`"1.0"` / `1`) are exactly what `cap add` scaffolds, so adopting these fields rewrote
nothing: running the heal across all 20 projects touched **one file**, `games/iap-test`'s pbxproj,
raising the lagging iOS counter to its Android value.

## The app identity (`app.appId` / `app.appName`)

Synced into **every** native file that carries them by `healNativeConfig` on open/build — they were
WRITE-ONCE before 2026-08-25: `cap add` baked them in at scaffold time, `ensureCapacitorConfig`
never clobbers an existing `capacitor.config.json`, so changing Project Settings afterwards
silently changed nothing anywhere (a device app kept its old identity forever).

| field | lands in |
|---|---|
| `app.appId` | `capacitor.config.json` · gradle `applicationId` · strings.xml `package_name` + `custom_url_scheme` · pbxproj `PRODUCT_BUNDLE_IDENTIFIER` (Info.plist's `CFBundleIdentifier` reads it via `$(PRODUCT_BUNDLE_IDENTIFIER)`) |
| `app.appName` | `capacitor.config.json` · strings.xml `app_name` + `title_activity_main` (AndroidManifest labels reference these) · Info.plist `CFBundleDisplayName` |

Deliberately NOT touched: gradle `namespace` (the code package — renaming it strands MainActivity),
and `CFBundleName` (stays `$(PRODUCT_NAME)`).

⚠️ **A changed appId is a NEW app to both stores** — previously uploaded builds and installed
updates no longer connect to it. The heal performs the change but logs a WARNING naming both ids
every time it rewrites one; an id that fails the bundle-id shape check is REFUSED outright rather
than written into four files at once.

## The shipped platform floors (`build.iosMinVersion` / `build.androidMinSdk`)

**Never let the bundler pick this.** Vite 8's default `build.target` is
`'baseline-widely-available'`, which resolves to `["chrome111","edge111","firefox114",
"safari16.4","ios16.4"]` — silently making **iOS 16.4 the minimum for every game we ship**. esbuild
then emits ES2022 static class blocks (three.js uses them), which are a **parse** error on older
WebKit: the chunk never parses, the eager module graph dies, and the app hangs on the splash screen
with *zero* JavaScript console output. `three.core` is on the eager boot path
(`index → renderSettings → three.core`), so it takes down 2D-only games too.

`build.iosMinVersion` (default **`16.4`**, raised from `15.4` on 2026-08-04 by owner decision —
deliberately dropping the iPhone 7 / 6s / SE1 era) is the single source of truth, with two
consumers that must never disagree.

⚠️ That the floor now *equals* the `ios16.4` the bundler default would have picked is a
coincidence, not a regression. The bug above was never the number — it was the floor being
**implicit**: inherited from a default that moves between bundler majors, and disagreeing with the
native deployment target. A deliberate, pinned 16.4 driving both consumers is the opposite of that.

The **three** consumers:

- **`vite.config.ts`** → `build.target` gets `ios<v>` / `safari<v>`
- **`healNativeConfig`** → `healIosDeploymentTarget` rewrites `IPHONEOS_DEPLOYMENT_TARGET` in the
  pbxproj (every build configuration — patching only the first leaves Release on the old floor)
- **`healNativeConfig`** → `healIosSpmPlatform` rewrites `platforms: [.iOS(.vNN)]` in
  `ios/App/CapApp-SPM/Package.swift` — the SPM package's own floor, **floored to the MAJOR**
  (16.4 → `.v16`), because SPM's `SupportedPlatform` enumerates majors. Coarser than the pbxproj
  target on purpose: a package minimum below the app's target always builds, and this is exactly
  what Capacitor's generator emits from the same value, so the heal agrees with `cap sync` rather
  than fighting it.

They were previously independent literals that DID disagree — pbxproj `15.0` vs a bundle needing
`15.4` — so the App Store would offer the game to a device that installs it and then dies on a
missing API.

⚠️ **The SPM floor was the third consumer, and it was unhealed until 2026-08-07** — so the "single
source of truth" reached two of three places. Raising the default from 15.4 to 16.4 moved the
pbxproj and the bundle and left `Package.swift` behind: **six of nine projects still declared
`.v15`** while every pbxproj read `16.4`. The three that had moved were simply the three someone
had run `cap sync` on since, which is the tell — the floor was tracking *who ran what*, not the
config. Not a build break (SPM tolerates a package minimum under the app target), but precisely
the per-project drift this config value exists to prevent. Both the heal and a
**committed-state** guard now exist; the mechanism-only guard could not see it, since the heal
runs on project open / native build and a project nobody opens stays stale on disk.

Note both files carry `// DO NOT MODIFY THIS FILE - managed by Capacitor CLI commands`. We rewrite
them anyway, for the same reason in both cases: regeneration is occasional and manual, and the
floor must not wait for someone to remember.

**15.4 remains the hard LOWER bound, not a round number.** esbuild lowers *syntax* but cannot
polyfill *runtime APIs*; scanning a built bundle for APIs it can't reach finds exactly
`structuredClone`, `Array.at` and `Object.hasOwn` — all three shipped in iOS 15.4. Lowering the
floor below 15.4 therefore needs polyfills, not just a smaller number; `16.4` sits comfortably
above that line, so no polyfills are needed at the current floor.

Guarded by `engine/tests/architecture/buildTargetFloor.test.ts`, which fails if the pin is removed,
replaced by a moving alias, if the two consumers are decoupled, or if the pinned floor value moves
without someone deliberately updating the test.

`build.androidMinSdk` (default **`31`**, Android 12 — reviewed alongside the iOS raise) is the
Android sibling, with the same shape:

- **`healNativeConfig`** → `healAndroidMinSdk` rewrites `minSdkVersion` in
  `android/variables.gradle` (every occurrence, `/g`, on open/build)

`cap add` scaffolds `minSdkVersion = 24` and nothing else ever revisits it, so without the heal a
newly-scaffolded project silently ships API 24 and the floor drifts per-project — the same drift
`iosMinVersion` was introduced to close on iOS. Same test file adds parallel Android coverage.

## Testing on hardware BELOW the shipping floor (Y6, iPhone 7)

The two weakest devices this engine has real measurements from are **below the target floor on
purpose** (`androidMinSdk: 31`, `iosMinVersion: '16.4'`), so a stock build refuses to install. They
are still the most valuable hardware for a low-end campaign — they are the devices the shipping
floors exist because of. **Lower the floor temporarily; never commit it.**

### Android (Huawei Y6 2019 — API 28)

`INSTALL_FAILED_OLDER_SDK` is the symptom. **Two files must move together** — a guard fails the
build if a committed native floor disagrees with its config (that gate has gone red before):

```bash
# 1. the config
node -e "const f=require('fs'),p='games/<id>/project.config.json',c=JSON.parse(f.readFileSync(p));\
  c.build.androidMinSdk=28; f.writeFileSync(p,JSON.stringify(c,null,2)+'\n')"
# 2. the native floor healNativeConfig syncs FROM it
gsed -i 's/minSdkVersion = 31/minSdkVersion = 28/' games/<id>/android/variables.gradle

# build + install as usual, then REVERT BOTH:
git checkout -- games/<id>/project.config.json games/<id>/android/variables.gradle
```

⚠️ **Revert before committing anything.** Verified working 2026-08-12: `games/sling` installed and
ran on the Y6 at API 28, and produced a probe-vs-identity A/B that nothing else could.
⚠️ `npx cap sync android` also rewrites the **#206** escaping `@capacitor/haptics` gradle path on
every run — revert that too (`git status` after every build).

### iOS (iPhone 7 — iOS 15.x max)

Same shape, different knob: the floor is `build.iosMinVersion` (`'16.4'`), synced into the Xcode
project's `IPHONEOS_DEPLOYMENT_TARGET` by `healNativeConfig`. Lower both, build, **revert both**.
⚠️ The iPhone 7 additionally cannot run WebDriverAgent, so its input is synthetic-only — see
[trusted-device-input.md](./trusted-device-input.md). It is a MEASUREMENT device, not an
interaction device.

**Why this is written down**: both devices are permanently out of the shipping floor, so this is
not a one-off — it is the standing procedure for every future campaign that wants the low end.

## Release builds (#370)

Until #370 the native pipeline was **dev-install-only on both platforms**: Android ran
`assembleDebug` + `adb install`, iOS ran `xcodebuild -configuration Debug` + a device install, and
no project set a `signingConfig`. Nothing shippable had ever come out of it — which was fine until
`games/court` and `games/wordweave` needed to ship.

**Build → iOS Release (App Store .ipa)** and **Build → Android Release (Play AAB)** are the entry
points; over HTTP it is `GET /api/build?platform=ios|android&variant=release`, and over MCP it is
`modoki_build {platform, variant:'release'}`. An **absent `variant` still means `debug`**, so every
caller that predates this is unchanged.

A release build **installs nothing and deploys nowhere.** It leaves a file:

| platform | artifact |
|---|---|
| Android | `android/app/build/outputs/bundle/release/app-release.aab` (Play) + `.../apk/release/app-release.apk` |
| iOS | `ios/App/build/ipa/*.ipa`, from an `xcodebuild archive` + `-exportArchive` |

The APK is not redundant. It is the only way to `adb install` and actually TEST the build that
ships — and for Google Sign-In (#360) that is not optional, because sign-in matches on the signing
CERTIFICATE and a debug build cannot exercise the release one at all.

Both variants share everything up to the compile — the web bundle, the OTA manifest, icons,
`cap sync`, the dep heal, the version heal. Only the compile step and the device requirement
differ, which is why `variant` is a separate parameter rather than two more `BUILD_PLATFORMS`
values: a release build must never miss a check the debug build gets.

### The Android upload key

Release signing reads `android/keystore.properties`, which the release build **generates** from the
gitignored, per-machine `games/<id>/project.user.json`:

```jsonc
{ "keystore": {
    "storeFile": "/Users/you/.modoki/keystores/com.apiary.court-upload.jks",
    "storePassword": "…", "keyAlias": "upload", "keyPassword": "…" } }
```

Edit it in **Project Settings → Android → Android release signing**, or create a key with:

```bash
keytool -genkeypair -v -keystore ~/.modoki/keystores/<appId>-upload.jks \
  -alias upload -keyalg RSA -keysize 2048 -validity 10000
```

⚠️ **The upload key is ONE key across every machine.** Play matches the AAB against the key the app
was enrolled with and rejects any other, so a second machine **copies the same `.jks`** — it does
not generate its own. This is the opposite of `~/.android/debug.keystore`, which is legitimately
per-machine (and whose per-machine-ness causes `INSTALL_FAILED_UPDATE_INCOMPATIBLE` across
machines). Keep the file OUTSIDE the repo.

A release Android build **refuses** when the key is missing or the `.jks` is not on disk, naming
what to set. That refusal is the point: Gradle happily builds an unsigned release AAB and reports
success, and Play then rejects it at **upload** time with "signed in debug mode" — a failure
discovered long after the build looked fine.

⚠️ **`modoki_project_settings action=get` REDACTS the two keystore passwords** (`••••••••`), and
`action=set` drops that sentinel rather than writing it. The route itself returns them — the Project
Settings dialog needs them — but an agent asking for `appId` should not pull a signing password into
its transcript. `storeFile` and `keyAlias` stay readable, so "why did the release build refuse" is
still diagnosable. The `set` half is what makes this safe: without it a get → edit → set round-trip
would write the sentinel in as the literal password.

`healAndroidReleaseSigning` writes the `signingConfigs.release` block into
`android/app/build.gradle` (a fenced, re-derived block), and it is **inert without
`keystore.properties`** — a keyless clone or CI still builds debug exactly as before.
`games/iap-test` configures signing by hand (#196) and the heal deliberately skips it.

⚠️ **`healAndroidGitignoreKeystore` exists because `cap add` regenerates `android/.gitignore` from
the upstream Android template, where `#*.jks` / `#*.keystore` are COMMENTED OUT.** A keystore
dropped in that folder would be committed by default — into a repo whose snapshot is published
publicly. Fixing the existing projects by hand fixes exactly those projects; the heal is what holds
for the next one.

### The iOS archive

`build.iosExportMethod` (committed, Project Settings → iOS → Signing) becomes the `method` in a
generated `ios/App/build/exportOptions.plist`. `app-store-connect` is the shipping path;
`ad-hoc`/`development` produce an .ipa installable on registered devices, for testing the
release-signed build before it goes near a store. The Team ID is `build.appleTeamId` — for Court and
wordweave that is the **Apiary publisher team**, not the dev one — the two ids, and which projects
are the exceptions, are in the root `CLAUDE.md` § "App Identity". The literal is deliberately not
repeated here: `docs/` is the publish switch for modoki-engine.com, and `verify:publish` aborts on a
real Team ID reaching it.

⚠️ The generated plist and the archive live under `ios/App/build/`, which every project's
`ios/.gitignore` already covers — they carry the Apple Team ID, a `PRIVATE_BUILD_FIELDS` value.
`verify:publish` is the backstop, not the defence; do not relocate them.

⚠️ `manageAppVersionAndBuildNumber` is pinned **false**. Xcode's default is true, which lets the
export rewrite `CFBundleVersion` — silently overwriting the number the version heal just wrote from
`app.buildNumber` (see § "The app version + build number" above), so the build would ship a number
the project never chose.

### What still has to happen by hand

**Play App Signing and the Firebase SHA-1s are console work, not build work.** Google Sign-In
matches an app by package name + signing certificate SHA-1, and with Play App Signing there are
**three** certificates: debug, the upload key, and the **app signing key Google generates and
re-signs every install with**. Registering only the first two makes sign-in work in every test
anyone runs and fail for every single person who installs from Play. All three fingerprints belong
in the Firebase console, and the third only exists once the app is enrolled in Play App Signing —
i.e. after the first AAB upload.

⚠️ **Adding a FINGERPRINT does not need a rebuild. Enabling the PROVIDER does.** The two look like
the same console visit and are not:

| console change | reaches the app how | rebuild? |
|---|---|---|
| Register another certificate SHA-1 | server-side only — nothing cert-derived is in the artifact | **no** |
| Enable the Google provider (mints the web OAuth client) | `default_web_client_id`, a compiled string resource | **yes** |

The `com.google.gms.google-services` plugin turns `google-services.json` into Android string
resources, and **the set it emits depends on what the JSON contains** — do not memorise a fixed
list. (4.4.4 knows ten: `default_web_client_id`, `gcm_defaultSenderId`, `google_api_key`,
`google_app_id`, `google_crash_reporting_api_key`, `google_storage_bucket`, `project_id`,
`firebase_database_url`, `ga_trackingId`, `google_maps_key`. Court's release build emits seven; its
older *debug* build emitted six, missing `default_web_client_id`, because it predates the web client
being added.) **The invariant that actually holds is narrower and stable: no emitted resource is
derived from `certificate_hash`.**

Measured on Court, 2026-08-28, against the real artifacts — and deliberately using the
fingerprints that were ALREADY in the JSON when the artifact was built, since grepping for a
newly-added one passes whether the claim is true or false:

- `google-services.json` is not packaged in the APK or the AAB at all.
- The pre-existing fingerprints and their Android client ids: **0 occurrences** in either archive
  (whole-archive decompressed byte grep, plus `res/raw/`, uppercase and colon-separated forms).
- The web client id: **1 occurrence** — the control that proves the grep can find what IS shipped.

So a build that already shipped does not need rebuilding for a fingerprint. ⚠️ **What was measured
is "no rebuild required", not "works instantly"** — nobody signed in on a Play-installed build after
registering, because Court was rebuilt anyway and destroyed the counterfactual. Google's propagation
for a newly registered SHA-1 (minutes to hours) and Credential Manager's client-side credential
caching both sit between registration and a working sign-in, and neither was measured.

Committing the regenerated `google-services.json` is still right — the source of truth should match
the console — it is just not what unblocks sign-in. (This section exists because the opposite was
asserted first, reasoned from the shape of the JSON rather than from what the plugin emits, and it
cost a build-and-upload cycle.)

## iOS build notes

- **`.xcodeproj` vs `.xcworkspace` depends on the game's deps.** A Firebase-only / SPM-only game
  (3d-test) has NO CocoaPods → build with `-project …/App.xcodeproj`. A game that pulls CocoaPods
  mediation adapters (AppLovin MAX, etc.) gets an `App.xcworkspace` from `pod install` → build with
  `-workspace …/App.xcworkspace` instead.
- **Use `-allowProvisioningUpdates`** for device builds (auto-signing). `DEVELOPMENT_TEAM` must be
  the Team ID of an account signed into Xcode — see per-game signing in
  [native-and-sdks.md](./native-and-sdks.md).
- First build is slow — SPM downloads all SDK frameworks.
- If SPM fails with "already exists in file system", clear the cache:
  `rm -rf ~/Library/Caches/org.swift.swiftpm/artifacts/*`.
- Use exact device IDs in `-destination` (not names — they can be ambiguous).
- dSYMs auto-upload to Firebase Crashlytics via a build-phase script.
- Firebase DebugView: add `-FIRAnalyticsDebugEnabled` to the Xcode scheme arguments.

## Android build notes

- Requires **JDK 21** (Capacitor 8 / AGP) — get it, and `ANDROID_HOME`, from
  `eval "$(node engine/scripts/print-toolchain-env.mjs)"`, which resolves through the same
  version-strict `detect()` the editor build uses (provisioned toolchain first).
  ⚠️ **Do NOT use `$(/usr/libexec/java_home -v 21)`** — it does not fail when no SYSTEM JDK 21 is
  registered, it returns the newest one it knows. Measured on this Mac: it answered with **25.0.3**
  while the provisioned Temurin 21 sat unused, and Gradle died with `Unsupported class file major
  version 69`, which reads as an AGP bug rather than a wrong-Java one (#159).
- Stock Gradle heap is `-Xmx1536m`; raise it (e.g. `-Xmx4096m`) only when a game bundles the 12
  AppLovin mediation adapters — none do yet.
- Device must show as `device` (not `unauthorized`) in `adb devices`.

**AppLovin SDK 13.x API notes** (only relevant to a game that bundles mediation):
`MaxAdFormat` replaces `AppLovinAdSize` for ad-format comparisons; `setUserIdentifier` moved to
`AppLovinSdk.getSettings()`; `setIsAgeRestrictedUser` / `setTestDeviceAdvertisingIds` removed (use
the dashboard); Adjust SDK v5 sets purchase time via `AdjustPlayStoreSubscription.setPurchaseTime(long)`.

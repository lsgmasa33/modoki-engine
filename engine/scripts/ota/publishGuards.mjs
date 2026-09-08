/** Pure publish-identity guards for OTA publishing (docs/ota-updates.md), shared by BOTH
 *  publishing surfaces: the editor's `/api/ota/publish` route (vite-asset-scanner.ts) and
 *  `ota-publish.mjs` itself. No Node/fs/crypto here beyond what the callers already resolved —
 *  every function takes plain values so each is unit-testable without gcloud, a bucket, a real
 *  publish, or a live editor.
 *
 *  Living here (not only in the route) is the point of #582: the route's own refusal message
 *  for a sub-game publish tells a human to run `ota-publish.mjs` by hand, but the CLI enforced
 *  neither of these guards, so the by-hand path it sends people to was unguarded. One decision
 *  must not be enforced by only one of two entry points. */

/** Why an OTA publish must be REFUSED on the signing key, or null when the key is usable.
 *
 *  `keyPublicKey` is the public half of `build/ota-keys/<name>.json`; `projectPublicKey` is
 *  `project.config.json` `ota.publicKey`, the value baked into the SHIPPED BINARY and the only key
 *  `verifyReleaseSignature` accepts. The preflight used to check merely that the key FILE existed
 *  (independent review, 2026-07-30), so publishing with a non-matching key produced a well-formed,
 *  signed release that every installed app silently refused while the tool reported success — and
 *  `/api/ota/status` then confirmed the version as live. Pure, so the invariant is unit-testable
 *  without gcloud, a bucket, or a real publish (the same reason its two siblings here are pure).
 *
 *  Moved here from `engine/plugins/vite-asset-scanner.ts` for #582: BOTH publishing surfaces
 *  (the `/api/ota/publish` route and `ota-publish.mjs` itself) enforce this same refusal now,
 *  and a second, independently-written copy of it is exactly the shape of bug #577 was about —
 *  so it lives once, here, and each surface imports it. */
export function otaSigningKeyRefusal(keyPublicKey, projectPublicKey) {
  if (!keyPublicKey) return 'no-key-public-half';
  if (!projectPublicKey) return 'project-public-key-empty';
  return keyPublicKey === projectPublicKey ? null : 'mismatch';
}

/** Why an OTA publish must be REFUSED on the dist's KIND vs. the identity it's published
 *  under, or null when it's consistent.
 *
 *  This is the CLI's equivalent of the route's `otaPublishBundleNameAllowed` — but it is a
 *  DIFFERENT check, deliberately not a port of that one. `otaPublishBundleNameAllowed` is a
 *  strict `requestedBundleName === projectOtaBundleName` equality guard, and it is
 *  route-specific: the route only ever builds a plain shell `dist/` via `build-web.mjs`, so for
 *  IT any name other than the project's own is definitely wrong. But the route's own refusal
 *  message directs a human to `build-subgame.mjs` plus a hand invocation of THIS CLI for exactly
 *  the case that guard exists to block — publishing a sub-game module under its own bundle
 *  name. Porting the equality guard into the CLI verbatim would refuse the exact use the route
 *  sends people here for.
 *
 *  The invariant the CLI can actually enforce is the one that matters: the dist's KIND must
 *  match the identity it is published under.
 *   - A plain shell `dist/` published under a sub-game's bundle name ships shell content under
 *     someone else's identity — the bug `otaPublishBundleNameAllowed` exists to prevent.
 *   - A `subgame-dist/` published under the project's own shell bundleName REPLACES the shell
 *     with a module the OTA client cannot boot (it expects `subgame.json` +
 *     `globalThis.__MODOKI_SUBGAME__`, not a standalone app).
 *  Both are silent on the publishing side — they fail only once a device fetches the release.
 *
 *  ⚠️ CAVEAT: this pins the dist's kind to the SHAPE of the identity (plain shell vs.
 *  subgame-dist/), not to a SPECIFIC sub-game's identity — `subgame.json` carries no name, and
 *  neither this function nor its caller ever checks that `--dist` belongs to `--project`. So
 *  `--dist games/A/subgame-dist --name B` (A's sub-game content published under B's name) is
 *  allowed. Still strictly better than the pre-#582 no-guard state, and left this way
 *  DELIBERATELY: a sub-game publish legitimately pairs a sub-game's own dist with the shell
 *  project it's staged from (`--dist games/A/subgame-dist --project games/<shell>`), so a
 *  containment check here would refuse the very case this guard exists to allow. See the #582
 *  Gotchas entry in docs/ota-updates.md. */
export function otaBundleDistKindRefusal({ bundleName, projectBundleName, distIsSubgameModule }) {
  if (bundleName !== projectBundleName && !distIsSubgameModule) return 'subgame-name-with-shell-dist';
  if (bundleName === projectBundleName && distIsSubgameModule) return 'shell-name-with-subgame-dist';
  return null;
}

/** The bundle name `project.config.json`'s `ota.bundleName` resolves to when the key is
 *  ABSENT from the raw file. MUST equal `DEFAULT_PROJECT_CONFIG.ota.bundleName` in
 *  `engine/project-config.ts` — a `.mjs` script cannot import that TS module, so this is a
 *  deliberate second authored copy of the same default, not a coincidence. Kept from drifting
 *  by the guard test in `engine/tests/plugins/ota/publishGuards.test.ts` that imports both and
 *  asserts they're equal.
 *
 *  Why this constant needs to exist at all: `pruneProjectConfig` (project-config.ts) omits any
 *  field equal to its default when the on-disk file didn't already carry that key — so a
 *  project that enables OTA through Project Settings and leaves the bundle name at its
 *  placeholder default gets an `ota` block with NO `bundleName` key at all. That is a
 *  perfectly valid config, not a malformed one: absent means "the default", exactly the way
 *  every other pruned field behaves. Treating an absent `bundleName` as a fatal error (as an
 *  earlier version of this guard did) refuses a config that Project Settings itself produces. */
export const OTA_DEFAULT_BUNDLE_NAME = 'shell';

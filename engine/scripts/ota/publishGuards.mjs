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

/** Why an OTA publish must be REFUSED on the dist's KIND vs. the target it's published as, or null
 *  when they agree. `targetKind` is `otaPublishPreflight`'s answer (`publishPreflight.mjs`): the
 *  shell's own bundle name, or a sub-game LISTED in `ota.subgames`.
 *   - A plain shell `dist/` published as a sub-game ships shell content under someone else's identity.
 *   - A `subgame-dist/` published as the shell REPLACES the shell with a module the OTA client cannot
 *     boot (it expects `subgame.json` + `globalThis.__MODOKI_SUBGAME__`, not a standalone app).
 *  Both are silent on the publishing side — they fail only once a device fetches the release. Only
 *  `ota-publish.mjs` needs this: the editor route builds whatever kind its target names.
 *
 *  ⚠️ CAVEAT: this pins the dist's kind, not WHICH sub-game it is — `subgame.json` carries no name.
 *  Since #827 the name must at least be one the shell lists, but `--dist games/A/subgame-dist --name B`
 *  with B listed still publishes A's content as B. Left that way DELIBERATELY: a sub-game publish
 *  legitimately pairs a sub-game's own dist with the shell project it is published into
 *  (`--dist games/A/subgame-dist --project games/<shell>`), so a containment check here would refuse
 *  the very case this guard exists to allow. See the #582 Gotchas entry in docs/ota-updates.md. */
export function otaBundleDistKindRefusal({ targetKind, distIsSubgameModule }) {
  if (targetKind === 'subgame' && !distIsSubgameModule) return 'subgame-name-with-shell-dist';
  if (targetKind === 'shell' && distIsSubgameModule) return 'shell-name-with-subgame-dist';
  return null;
}

/** The engine-API value a SUB-GAME publish stamps, or why it must be REFUSED (#837).
 *
 *  A device loads a sub-game only when its manifest's `engineApi` EXACTLY equals the running shell's
 *  `ENGINE_API_VERSION` (`engine/app/subgameLoader.ts`, never `>=`) and refuses anything else — but
 *  on the device, long after the publish reported success. So the value comes from what the build
 *  actually stamped (`subgame.json.engineApi`), a flag may only agree with it, and it must equal the
 *  SHELL project's own `ota.engineApi`, the value that shell's builds declare they run.
 *
 *   - `stamped`: `subgame.json`'s `engineApi` as parsed (any value).
 *   - `requested`: the `--engine-api` flag as a number, or `undefined` when it was omitted.
 *   - `shellEngineApi`: the shell project's `ota.engineApi`, with an absent key already resolved to
 *     {@link OTA_DEFAULT_ENGINE_API}.
 *
 *  Returns `{ engineApi }` when publishable, else `{ refusal }`. Pure. */
export function otaSubgameEngineApi({ stamped, requested, shellEngineApi }) {
  if (!Number.isInteger(stamped) || stamped < 1) return { refusal: 'stamped-invalid' };
  if (requested !== undefined && requested !== stamped) return { refusal: 'flag-mismatch' };
  if (stamped !== shellEngineApi) return { refusal: 'shell-mismatch' };
  return { engineApi: stamped };
}

/** The engine-API value `project.config.json`'s `ota.engineApi` resolves to when the key is ABSENT.
 *  MUST equal `DEFAULT_PROJECT_CONFIG.ota.engineApi` — the same deliberate second authored copy as
 *  {@link OTA_DEFAULT_BUNDLE_NAME} below, for the same reason, pinned by the same test file. */
export const OTA_DEFAULT_ENGINE_API = 1;

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

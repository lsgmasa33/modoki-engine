/** THE publish-request check — every refusal an OTA publish must make before it builds, hashes or
 *  uploads anything, run by BOTH entry points: the editor's `/api/ota/publish` route and
 *  `ota-publish.mjs` (#827).
 *
 *  Before #827 each composed these checks by hand. They mostly called the same leaf guards, but in
 *  different orders and not the same set: the route refused a bundle name that is neither the
 *  shell's own nor listed in `ota.subgames` (`otaPublishTarget`, #837), and the CLI never asked —
 *  measured on 2026-09-13, `ota-publish.mjs` took a sub-game dist under an unlisted name all the way
 *  to `gcloud storage rsync`. That is #582 and #649's shape a third time: a guard the route enforces
 *  before spawning a CLI the CLI itself lacked. Now a check added here refuses on both.
 *
 *  What is NOT here, because it is not the same step on both sides:
 *   - the wording for an unreadable config file: both read the RAW `ota` block through
 *     {@link readRawOtaBlock} (never the merged `ProjectConfig`, which coerces), and the defaults an
 *     absent key takes are resolved in the preflight, once.
 *   - the bucket's source: the route derives it from `ota.baseUrl`; the CLI takes `--bucket`.
 *   - the dist's KIND (`otaBundleDistKindRefusal`): only the CLI receives a pre-built dist. The
 *     route builds whatever kind the target names, so it cannot mismatch.
 *   - the engine API: the route checks the config a sub-game will be BUILT from; the CLI checks what
 *     the build actually stamped. Different artifacts, same number.
 *   - the refusal WORDING: a route answers HTTP and names Project Settings, the CLI names its flags.
 *     Each side keys its messages by {@link OTA_PUBLISH_REFUSALS}, and a test holds both maps to the
 *     full list, so a new refusal cannot ship with one side silent.
 *
 *  Plain `.mjs` in `ota/` beside the leaf guards it composes, so `ota-publish.mjs` imports it with no
 *  loader and `otaPublishReleaseRace.test.ts`'s copied-subset repo (which copies `ota/` whole) carries
 *  it. It reads one file — the signing key — and nothing else. */

import fs from 'node:fs';
import path from 'node:path';
import { OTA_SAFE_TOKEN, OTA_SAFE_BUCKET } from './otaSafeTokens.mjs';
import { OTA_DEFAULT_BUNDLE_NAME, otaSigningKeyRefusal } from './publishGuards.mjs';

/** Every refusal {@link otaPublishPreflight} can return, in the order it checks them. */
export const OTA_PUBLISH_REFUSALS = Object.freeze([
  'no-ota-block',
  'not-enabled',
  'bad-version',
  'bad-name',
  'bad-key-name',
  'bad-bucket',
  'bad-project-bundle-name',
  'bad-project-subgames',
  'ambiguous-bundle',
  'unknown-bundle',
  'key-missing',
  'key-unparseable',
  'no-key-public-half',
  'project-public-key-empty',
  'mismatch',
]);

/** The RAW `ota` block of `<projectRoot>/project.config.json` — what BOTH entry points hand
 *  {@link otaPublishPreflight}, so the check sees the same inputs on both.
 *
 *  Raw, not the merged `ProjectConfig`, and the difference is observable: merging coerces
 *  (`stringListOf` silently drops a non-string `ota.subgames` entry), so a route that passed the merged
 *  block let a hand-edited `"subgames": ["x", 7]` past its early 400, ran the multi-minute sub-game
 *  build and rewrote the bucket's CORS, and only then saw `ota-publish.mjs` refuse the raw file. The
 *  CLI must read raw anyway — it fails closed on a malformed config instead of defaulting it.
 *
 *  Returns `{ ok: true, file, ota }` (`ota` may be undefined — the preflight refuses that), or
 *  `{ ok: false, file, reason: 'missing' | 'unparseable', error? }`. */
export function readRawOtaBlock(projectRoot) {
  const file = path.join(projectRoot, 'project.config.json');
  if (!fs.existsSync(file)) return { ok: false, file, reason: 'missing' };
  try {
    return { ok: true, file, ota: JSON.parse(fs.readFileSync(file, 'utf8'))?.ota };
  } catch (e) {
    return { ok: false, file, reason: 'unparseable', error: e instanceof Error ? e.message : String(e) };
  }
}

/** What a publish under `name` IS, or null when it must refuse (#837). The shell's own
 *  `bundleName` publishes the shell; an id listed in `subgames` publishes that sub-game; anything
 *  else — including a name that is BOTH, which cannot say which it means — is refused. Pure. */
export function otaPublishTarget(name, ota) {
  const isShell = name === ota.bundleName;
  const isSubgame = ota.subgames.includes(name);
  if (isShell && isSubgame) return null;
  if (isShell) return { kind: 'shell' };
  if (isSubgame) return { kind: 'subgame', id: name };
  return null;
}

/** Check a publish request. `ota` is the project's `ota` block — merged or raw; an absent
 *  `bundleName`/`subgames` resolves to its default here. `repoRoot` is where
 *  `build/ota-keys/<keyName>.json` lives.
 *
 *  Returns `{ ok: true, target, keypair, keyPath, bundleName, subgames, name, version, keyName, bucket }`
 *  (the four inputs echoed back as CHECKED strings, so a typed caller narrows through the result), or
 *  `{ ok: false, refusal, bundleName?, subgames?, keyPath?, keyPublicKey? }` — the extra fields are
 *  whatever the check had resolved, for the caller's message. */
export function otaPublishPreflight({ ota, name, version, keyName, bucket, repoRoot }) {
  if (typeof ota !== 'object' || ota === null || Array.isArray(ota)) return { ok: false, refusal: 'no-ota-block' };
  // `enabled` defaults to false, so an ABSENT field correctly means "not enabled". Strictly `true`:
  // a hand-edited `"enabled": "false"` is truthy, and merging passes it through unchanged, so a
  // truthiness test published a project whose config says it opted out.
  if (ota.enabled !== true) return { ok: false, refusal: 'not-enabled' };
  // The four tainted inputs. `version`/`name`/`bucket` are interpolated into `gcloud storage`
  // commands; a `/` in `name` would also write objects under a NESTED path while release.json records
  // the flat string, so #577's collision guard would read back a path nothing wrote (#649). `keyName`
  // is joined into a path, so its exposure is traversal.
  if (typeof version !== 'string' || !OTA_SAFE_TOKEN.test(version)) return { ok: false, refusal: 'bad-version' };
  if (typeof name !== 'string' || !OTA_SAFE_TOKEN.test(name)) return { ok: false, refusal: 'bad-name' };
  if (typeof keyName !== 'string' || !OTA_SAFE_TOKEN.test(keyName)) return { ok: false, refusal: 'bad-key-name' };
  if (typeof bucket !== 'string' || !OTA_SAFE_BUCKET.test(bucket)) return { ok: false, refusal: 'bad-bucket' };

  // An ABSENT bundleName is the default, not a defect: `pruneProjectConfig` omits a field equal to its
  // default, so Project Settings itself writes an `ota` block with no `bundleName`. Only a PRESENT
  // value that is not a non-empty string is a genuine config defect.
  const bundleName = ota.bundleName === undefined ? OTA_DEFAULT_BUNDLE_NAME : ota.bundleName;
  if (typeof bundleName !== 'string' || !bundleName) return { ok: false, refusal: 'bad-project-bundle-name' };
  const subgames = ota.subgames === undefined ? [] : ota.subgames;
  if (!Array.isArray(subgames) || subgames.some((s) => typeof s !== 'string')) {
    return { ok: false, refusal: 'bad-project-subgames', bundleName };
  }

  const target = otaPublishTarget(name, { bundleName, subgames });
  if (!target) {
    return { ok: false, refusal: name === bundleName ? 'ambiguous-bundle' : 'unknown-bundle', bundleName, subgames };
  }

  // The key must be the one the SHIPPED APP verifies against, not merely a key that exists:
  // `ota.publicKey` is baked into the binary and is the only key `verifyReleaseSignature` accepts,
  // so any other keypair signs a well-formed release every installed app silently refuses.
  const keyPath = path.join(repoRoot, 'build', 'ota-keys', `${keyName}.json`);
  if (!fs.existsSync(keyPath)) return { ok: false, refusal: 'key-missing', bundleName, subgames, keyPath };
  let keypair;
  try {
    keypair = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  } catch {
    return { ok: false, refusal: 'key-unparseable', bundleName, subgames, keyPath };
  }
  const keyPublicKey = keypair?.publicKey ?? null;
  const keyRefusal = otaSigningKeyRefusal(keyPublicKey, ota.publicKey);
  if (keyRefusal) return { ok: false, refusal: keyRefusal, bundleName, subgames, keyPath, keyPublicKey };

  return { ok: true, target, keypair, keyPath, bundleName, subgames, name, version, keyName, bucket };
}

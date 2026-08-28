/** Project-level: identity, console logs, settings, import, build, native targets, OTA.
 *
 *  Registered by `registerAllTools` (`../registerAll.ts`). Side-effect-free on import:
 *  nothing here runs until the register function is called, which is what lets a test
 *  build a context against a stub backend and call these handlers. See `../context.ts`.
 */

import { z } from 'zod';
import type { ToolDef } from '../toolDef.js';
import type { ToolContext } from '../context.js';
import { unsavedForceParam } from '../shapes.js';

/** What `modoki_project_settings action=get` shows instead of a signing password (#370).
 *
 *  Chosen to be obviously-not-a-password and stable, so `action=set` can recognise it coming back. */
export const REDACTED = '••••••••';

/** The `user.keystore` fields that must never reach an agent's context. The Android upload key's
 *  two passwords — the key itself lives outside the repo, but these unlock it.
 *
 *  ⚠️ `storeFile` and `keyAlias` are deliberately NOT redacted: a path and an alias are not secrets,
 *  and an agent diagnosing "why did the release build refuse" needs to see whether they are set. */
const SECRET_PATHS: readonly [string, string][] = [
  ['keystore', 'storePassword'],
  ['keystore', 'keyPassword'],
];

/** Blank the signing passwords out of a `/api/project-settings` GET reply.
 *
 *  The route nests the whole per-machine `user` subtree in its response, and since #370 that subtree
 *  holds the Play upload key's passwords in plaintext. Before this, an agent making the cheap,
 *  routine, read-only call to check `appId` or `debugBuild` pulled those passwords into its context,
 *  its transcript, and any paste of that response. The Project Settings dialog is unaffected — it
 *  calls `backendFetch` directly, not through this tool.
 *
 *  Redacts rather than deleting the keys: their PRESENCE is the useful signal ("a key is
 *  configured"), and an absent field reads identically to an unconfigured one. */
export function redactSecrets(reply: unknown): unknown {
  if (!reply || typeof reply !== 'object') return reply;
  const r = reply as Record<string, unknown>;
  const user = r.user;
  if (!user || typeof user !== 'object') return reply;
  const u = { ...(user as Record<string, unknown>) };
  for (const [section, field] of SECRET_PATHS) {
    const sec = u[section];
    if (!sec || typeof sec !== 'object') continue;
    const s = sec as Record<string, unknown>;
    if (typeof s[field] === 'string' && s[field] !== '') u[section] = { ...s, [field]: REDACTED };
  }
  return { ...r, user: u };
}

/** Drop any redaction sentinel from an `action=set` patch before it is written.
 *
 *  ⚠️ This is the half that makes redaction SAFE rather than destructive. The natural agent pattern
 *  is get → modify one field → set the whole object back; without this, that round-trip writes
 *  `'••••••••'` into `project.user.json` as the literal password and the next release build fails
 *  with `Keystore was tampered with, or password was incorrect` — a redaction that destroys the
 *  secret it was protecting. Omitting the key means "leave it alone", which is exactly what the
 *  route's patch semantics already do for an absent field. */
export function redactedBack(values: Record<string, unknown>): Record<string, unknown> {
  const user = values.user;
  if (!user || typeof user !== 'object') return values;
  const u = { ...(user as Record<string, unknown>) };
  let touched = false;
  for (const [section, field] of SECRET_PATHS) {
    const sec = u[section];
    if (!sec || typeof sec !== 'object') continue;
    const s = { ...(sec as Record<string, unknown>) };
    if (s[field] === REDACTED) { delete s[field]; u[section] = s; touched = true; }
  }
  return touched ? { ...values, user: u } : values;
}

export function registerProjectTools(tool: ToolDef, ctx: ToolContext): void {
  const { fail, getJson, postJson, unsavedChangesWarning, consumeBuildStream } = ctx;

  // ── identity — WHICH editor is MODOKI_BACKEND pointing at? ──
  tool(
    'modoki_identity',
    'Report which checkout, project and process the configured MODOKI_BACKEND is actually ' +
      'serving: {repoRoot, projectRoot, backendPort, pid, branch, packaged}. Call this FIRST ' +
      'when editor calls "succeed" but nothing you expect changes — with two clones of the ' +
      'repo on one machine it is easy to be driving the sibling clone\'s editor, which fails ' +
      'silently. A mismatch against this session\'s working directory is also warned about ' +
      'automatically on every tool result. `repoRoot` also doubles as the path to the ' +
      'ENGINE SOURCE this editor is running: the monorepo root in dev, or ' +
      '`<resourcesPath>/app.asar.unpacked` (unpacked, readable TypeScript — not a compiled ' +
      'bundle) when `packaged` is true. Read files under `${repoRoot}/engine/packages/modoki/src` ' +
      'when you need to understand WHY the engine behaves a certain way, not just what it\'s ' +
      'doing right now.',
    {},
    () => getJson('/api/identity'),
  );

  // ── console logs (endpoint already existed; this exposes it as a tool) ──
  tool(
    'modoki_get_console_logs',
    'Read the editor renderer\'s recent console output (errors/warns/logs + uncaught errors ' +
      'and unhandled rejections). Use to diagnose a failed scene/mesh load or a runtime throw ' +
      'without a devtools attach. RETURNS {count, total, ringTotal, byLevel, logs}: `count` is what ' +
      'came back (last 50 by default), `total` is what MATCHED level=/since=, and `ringTotal`+`byLevel` ' +
      'describe the WHOLE 500-entry ring regardless of the filter — so a level="warn" read still tells ' +
      'you whether any errors exist. (Error entries carry full stacks, so the ring can exceed 20k ' +
      'tokens.) Raise limit=N for more, or narrow with level=/since=.',
    {
      level: z.enum(['log', 'warn', 'error']).optional().describe('Filter to one level.'),
      limit: z.number().optional().describe('Return the last N entries (default 50). An explicit limit always wins; pass a large one for the whole ring.'),
      since: z.number().optional().describe('Only entries with ts > this (ms epoch).'),
    },
    async ({ level, limit, since }) => {
      const q = new URLSearchParams();
      if (level) q.set('level', level);
      if (limit != null) q.set('limit', String(limit));
      if (since != null) q.set('since', String(since));
      const qs = q.toString();
      return getJson(`/api/console-logs${qs ? `?${qs}` : ''}`);
    },
  );

  // ── project settings ──
  tool(
    'modoki_project_settings',
    'Read or write project.config.json (app identity, build pipeline, default game). ' +
      'action=get returns the RESOLVED config (file over engine defaults) — plus `configErrors` if ' +
      'a config file EXISTS but does not parse, in which case EVERY value beside it is an engine ' +
      'default and not the project\'s own. Do not report those values as the project\'s settings; ' +
      'the file needs repairing by hand first. action=set deep-merges ' +
      '`values` onto what is ON DISK and persists: a section you omit is left untouched, and only ' +
      'what the project actually chose is written (engine defaults are not baked in). A PARTIAL SET ' +
      'IS SAFE — edit one field at a time. Arrays (content.scenes, physics.layers) AND ' +
      '`rendering.three.tiers` replace wholesale rather than merging, and a key you DO pass always ' +
      'wins — including "" and false, which is how you clear a field. Refused with 400 (nothing ' +
      'written) if: a build field would be unsafe to interpolate into a shell command; the patch ' +
      'contains a `null` anywhere (no field is nullable — use ""/false/0 to clear); ' +
      '`rendering.three.tiers` is present but any named tier object is missing a field (it is NOT ' +
      'merged onto the on-disk tier — post the complete tier block or omit the key entirely); or ' +
      'project.config.json exists but is not valid JSON, since a patch onto a file that cannot be ' +
      'read would replace it. Contract + rationale: docs/editor.md ' +
      '"Project Settings — the save contract". ' +
      '⚠️ The two Android signing passwords (user.keystore.storePassword / .keyPassword) come back ' +
      'REDACTED as \u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022 — they are a signing secret and this is a channel that ends up in a ' +
      'transcript. action=set drops that exact sentinel rather than writing it, so a get\u2192edit\u2192set ' +
      'round-trip cannot destroy the real password; the corollary is that you cannot SET a password ' +
      'whose literal value is the sentinel. storeFile and keyAlias are NOT redacted.',
    {
      action: z.enum(['get', 'set']),
      values: z.record(z.any()).optional().describe(
        'For action=set: the config fields to merge, e.g. {"app":{"appName":"X"}}. Partial is fine — ' +
          'sections you leave out keep their on-disk values. No value may be null.',
      ),
    },
    async ({ action, values }) => {
      if (action === 'set') return postJson('/api/project-settings', redactedBack(values ?? {}));
      // `getJson`'s `transform` hook, NOT a raw `call`. The secret must be removed from the PARSED
      // body before it is encoded — scrubbing the encoded text afterwards means pattern-matching a
      // password inside JSON that may already be elided or bannered. But reaching for raw `call` to
      // get at the body silently drops three things `getJson` does and this tool needs: the §5
      // unreachable-backend envelope (a raw call THROWS, and the SDK turns that into the bare
      // free-text error §5 exists to eliminate), the SPA-fallthrough guard (the Vite dev server
      // answers a missing /api route with index.html at status 200, which this tool would then
      // report as the project's settings), and `ensureIdentity`'s wrong-clone banner — which, on a
      // tool that is a natural FIRST call, is exactly when #349 bites.
      return getJson('/api/project-settings', undefined, undefined, redactSecrets);
    },
  );

  // ── import a new asset from disk ──
  tool(
    'modoki_import_file',
    'Import a NEW file from anywhere on disk into the project (the human "drag from Finder" ' +
      'path): copies it under destFolder, assigns a fresh GUID, and runs the asset-type import ' +
      'pipeline (texture→KTX2/WebP, model→GLB) unless reimport=false. Returns {path, guid, type}.\n\n' +
      'FAILS (422) if the file copied but the import PIPELINE did not run — the response still ' +
      'carries the path + guid, so retry the pipeline with modoki_reimport_asset rather than ' +
      'importing again. It is not reported as a success: an unconverted texture has no runtime ' +
      'variant and will fail to load later, with nothing connecting that back to this call.',
    {
      srcPath: z.string().describe('Absolute path of the source file on disk.'),
      destFolder: z.string().describe('Asset-root URL of the destination folder, e.g. /games/x/assets/textures'),
      reimport: z.boolean().optional().describe('Run the import pipeline after copy (default true).'),
    },
    async ({ srcPath, destFolder, reimport }) => postJson('/api/import-file', { srcPath, destFolder, reimport }, 120_000),
  );

  // ── build / deploy (SSE consumed to completion) ──
  tool(
    'modoki_build',
    'Run a build + deploy exactly like the editor Build menu (web / iOS device / Android ' +
      'device / playable ad). Consumes the build stream to completion and returns {ok, log} or ' +
      'the failure tail. HEAVY: native builds run xcodebuild/gradle and install on a device — ' +
      'minutes long. playable = a single self-contained HTML at games/<id>/ads/index.html.',
    {
      platform: z.enum(['web', 'ios', 'android', 'playable'])
        .describe("Build target. 'web' → dist/; 'ios'/'android' → the native app (auto-scaffolds the platform on first build); 'playable' → a single self-contained MRAID ad HTML."),
      variant: z.enum(['debug', 'release']).optional()
        .describe("ios/android ONLY; default 'debug'. 'debug' = the historical behaviour (a dev-signed build INSTALLED on the configured device). 'release' = a store artifact and NO device: Android produces a signed .aab + .apk (refuses unless the upload key is set in project.user.json user.keystore), iOS archives and exports an .ipa using build.iosExportMethod. A release build installs nothing and deploys nowhere — it leaves a file you upload by hand."),
      force: unsavedForceParam,
    },
    async ({ platform, variant, force }) => {
      // A build reads the scene FILE. The live-world tools (create_entity / duplicate / prefab)
      // do NOT save — so an unsaved editor builds a world that is missing exactly the work the
      // agent just did, reports ok:true, and the deployed web build / device install is stale
      // with nothing anywhere saying why. For a native build that is MINUTES of xcodebuild or
      // gradle producing the wrong artifact. Refuse instead. (C7)
      if (!force) {
        const stale = await unsavedChangesWarning();
        if (stale) {
          return fail({
            code: 'REQUIRES_SAVE',
            what: `build the ${platform}${variant === 'release' ? ' release' : ''} target`,
            why: stale,
            options: [
              'call modoki_save_all first — then the build sees your work',
              'pass force:true to build the ON-DISK scene deliberately, accepting that it is missing the live edits',
            ],
          });
        }
      }
      // ⚠️ `variant` MUST reach the URL. It was accepted, documented and dropped here for a while:
      // the server then read no variant, defaulted to `debug` (correctly — that is the contract for
      // an absent one), and `modoki_build {variant:'release'}` ran assembleDebug + `adb install`
      // onto the owner's phone, reported "✅ Android build deployed successfully", and produced no
      // AAB. The keystore refusal and the debugBuild warning never fired either, because nothing on
      // the server ever knew a release was asked for. Omitted for `debug` so the request stays
      // byte-identical to what every pre-#370 caller sent. Pinned by
      // `engine/tests/tools/releaseBuildTools.test.ts`.
      const q = variant === 'release' ? `?platform=${platform}&variant=release` : `?platform=${platform}`;
      return consumeBuildStream(`/api/build${q}`, 30 * 60_000);
    },
  );
  tool(
    'modoki_add_native_target',
    'Scaffold a native target (cap add + deps + config + heal) like Build → "Add iOS/Android ' +
      'Target…". Consumes the stream to completion.',
    {
      platform: z.enum(['ios', 'android']).describe('Which native platform to scaffold into the project (creates games/<id>/ios or /android).'),
      force: unsavedForceParam,
    },
    async ({ platform, force }) => {
      // The third build-family tool, and the last one without the stale-scene gate: it runs a web
      // build from the scene FILE exactly like modoki_build, so unsaved live-world work is missing
      // from the artifact it produces while the call reports success. (§8)
      if (!force) {
        const stale = await unsavedChangesWarning();
        if (stale) {
          return fail({
            code: 'REQUIRES_SAVE',
            what: `scaffold the ${platform} native target`,
            why: `${stale} This runs a web build from the file, so the scaffolded target would be built from a scene missing that work.`,
            options: [
              'call modoki_save_all first',
              'pass force:true to scaffold from the ON-DISK scene deliberately',
            ],
          });
        }
      }
      return consumeBuildStream(`/api/add-native-target?platform=${platform}`, 15 * 60_000);
    },
  );

  // ── OTA publish (SSE consumed to completion) + status/keygen (JSON) ──
  // No editor menu entry exists yet for any of these (docs/plans/mobile-ota-updates-plan.md,
  // Phase 5a — the UI half is deliberately deferred); this tool surface is the ONLY way to
  // publish an OTA update short of hand-invoking the CLIs, so an agent is a first-class
  // consumer here, not an afterthought.
  tool(
    'modoki_ota_publish',
    'Publish an OTA update for the open project (docs/ota-updates.md): builds FRESH from the ' +
      "current project.config.json (never a stale dist/), refuses a version string that's " +
      "already published (suggests the next free vN), verifies/sets the bucket's CORS, then " +
      'runs ota-publish.mjs. Requires ota.enabled + a signing key already generated ' +
      '(modoki_ota_keygen). Consumes the stream to completion — can take a minute+.\n\n' +
      'REFUSED when the editor has UNSAVED live-world changes: this builds from the scene FILE and ' +
      'ships the result to INSTALLED APPS, so unsaved work would be missing from a real release. ' +
      'Run modoki_save_all, or pass force:true to publish the on-disk state deliberately.',
    {
      version: z.string().describe('New version string, e.g. "v18". Must not already be published for this bundleName.'),
      mandatory: z.boolean().optional().describe('Mandatory update: blocks with a restart-to-continue gate instead of applying next launch.'),
      bundleName: z.string().optional().describe('Must equal (or be omitted, defaulting to) this project\'s own project.config.json ota.bundleName — the server refuses any other value. This route always builds the CURRENTLY OPEN project as a normal web build and publishes it as itself; it does NOT build/publish a Phase 4 sub-game module bundle (that needs build-subgame.mjs + a manual publish, not this tool). To publish a sub-game, open ITS OWN project and call this tool there.'),
      key: z.string().optional().describe('Signing key name under build/ota-keys/<key>.json (default "default").'),
      bucket: z.string().optional().describe('gs://bucket[/prefix] override — only needed when ota.baseUrl is a custom CDN domain that cannot be reverse-derived to its gs:// form.'),
      force: unsavedForceParam,
    },
    async ({ version, mandatory, bundleName, key, bucket, force }) => {
      // Same gate as modoki_build, and it belongs here MORE: a build produces a local artifact you
      // can inspect, whereas this ships to installed apps over the air. Publishing a bundle that
      // silently omits the work the agent just did — and answering "Published" — is the worst
      // reachable outcome on this surface. It had no gate at all. (conventions §8)
      if (!force) {
        const stale = await unsavedChangesWarning();
        if (stale) {
          return fail({
            code: 'REQUIRES_SAVE',
            what: `publish OTA version ${version}`,
            why: `${stale} An OTA release goes to INSTALLED APPS — the update would ship without that work, and report success.`,
            options: [
              'call modoki_save_all first — then the published bundle contains your work',
              'pass force:true to publish the ON-DISK state deliberately',
            ],
          });
        }
      }
      const qs = new URLSearchParams({ version });
      if (mandatory) qs.set('mandatory', '1');
      if (bundleName) qs.set('bundleName', bundleName);
      if (key) qs.set('key', key);
      if (bucket) qs.set('bucket', bucket);
      // 35 min, NOT 5 (independent review, 2026-07-30). A publish does strictly MORE than
      // modoki_build's 30-minute web build: the same build, then a `gcloud storage rsync` of the
      // whole dist plus a zip upload. On the client's abort the server SIGTERMs the active child,
      // so the old 5-minute budget killed a slow-but-HEALTHY publish part-way — and because
      // ota-publish.mjs uploads content → manifest.json → bundle.zip → release.json LAST, the
      // interrupted state leaves a versioned manifest with no release: that version is poisoned,
      // and the retry reads as "already published". The timeout must not be tighter than the work.
      return consumeBuildStream(`/api/ota/publish?${qs}`, 35 * 60_000);
    },
  );
  tool(
    'modoki_ota_status',
    "Read-only: the current release.json for the open project's OTA bucket (which version is " +
      'live per bundle, mandatory flag, minEngineApi). `release:null` means the bucket WAS read and ' +
      'nothing has been published yet — it is an answer, not a shrug. If the bucket could not be ' +
      'read at all (expired credentials, no network, wrong bucket, missing permission) the call ' +
      'FAILS instead, because "could not look" must never be reported as "nothing is there".',
    { bucket: z.string().optional().describe('gs://bucket[/prefix] override — see modoki_ota_publish.') },
    async ({ bucket }) => getJson(`/api/ota/status${bucket ? `?bucket=${encodeURIComponent(bucket)}` : ''}`, 15_000),
  );
  tool(
    'modoki_ota_keygen',
    'Generate the Ed25519 OTA signing keypair (build/ota-keys/<name>.json) needed before the ' +
      'first modoki_ota_publish. REFUSES to overwrite an existing key — regenerating orphans ' +
      'every already-shipped binary (they have the old public key baked in). There is ' +
      'deliberately no force/overwrite option on this tool; if you need to rotate a key, that ' +
      "is a decision for the project owner, not something to script around this refusal.",
    { name: z.string().optional().describe('Key identity name (default "default"). The public key belongs in project.config.json ota.publicKey.') },
    async ({ name }) => postJson(`/api/ota/keygen${name ? `?name=${encodeURIComponent(name)}` : ''}`, undefined, 15_000),
  );
}

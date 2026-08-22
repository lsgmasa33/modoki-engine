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
      '"Project Settings — the save contract".',
    {
      action: z.enum(['get', 'set']),
      values: z.record(z.any()).optional().describe(
        'For action=set: the config fields to merge, e.g. {"app":{"appName":"X"}}. Partial is fine — ' +
          'sections you leave out keep their on-disk values. No value may be null.',
      ),
    },
    async ({ action, values }) =>
      action === 'get' ? getJson('/api/project-settings') : postJson('/api/project-settings', values ?? {}),
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
      force: unsavedForceParam,
    },
    async ({ platform, force }) => {
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
            what: `build the ${platform} target`,
            why: stale,
            options: [
              'call modoki_save_all first — then the build sees your work',
              'pass force:true to build the ON-DISK scene deliberately, accepting that it is missing the live edits',
            ],
          });
        }
      }
      return consumeBuildStream(`/api/build?platform=${platform}`, 30 * 60_000);
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

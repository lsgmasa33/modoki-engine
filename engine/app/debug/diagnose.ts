/** diagnose agent op — a STRUCTURED render/scene health report so "the render is
 *  black / looks wrong" becomes a list of concrete causes instead of a screenshot
 *  Claude has to interpret.
 *
 *  Collects: recent console errors, dangling/illegal asset refs in the live world,
 *  NaN / zero-scale transforms, off-screen entity count, and whether a camera
 *  exists. Pure-ish (reads the live world); the caller passes the console errors
 *  (the ring buffer lives in agentBridge). */

import {
  getAllEntities, getAllTraits, readTraitData, readTraitDataFull,
  REF_FIELDS_BY_TRAIT, isGuid, isExternalUrl, isInternalAssetPath, resolveGuidToPath,
  getDeviceCaps, getDeviceCapsSync, readPerfProfile, getActiveQualityTier, getAutoLightCapStats,
  getShadowCasterCapStats,
  getAssessedQualityTier, getEffectiveTargetFps, getRenderSettings, configCount,
} from '@modoki/engine/runtime';
import { getActiveTextureSizeCap } from '@modoki/engine/runtime';
import { computeLayoutBounds } from './layoutDump';

export interface DiagnoseConsoleEntry { level: string; ts: number; text: string }

interface RefIssue { entity: number; trait: string; field: string; value: string; kind: 'unresolved-guid' | 'literal-path' }
interface TransformIssue { entity: number; field: string; value: number }

const TRANSFORM_FIELDS = ['x', 'y', 'z', 'rx', 'ry', 'rz', 'sx', 'sy', 'sz'] as const;

export function computeDiagnostics(opts: { consoleErrors?: DiagnoseConsoleEntry[]; now?: number; errorWindowMs?: number } = {}) {
  const entities = getAllEntities();
  const metaByName = new Map(getAllTraits().map((m) => [m.name, m] as const));

  // ── Asset-ref integrity: ref fields must be a resolvable GUID (or external/primitive). ──
  const refIssues: RefIssue[] = [];
  for (const info of entities) {
    for (const traitName of info.traits) {
      const fields = REF_FIELDS_BY_TRAIT[traitName];
      if (!fields) continue;
      const meta = metaByName.get(traitName);
      if (!meta) continue;
      // Full field set (Decision A): a ref field can live in an AoS object the
      // curated readTraitData drops, which would make the ref check blind to it.
      const data = readTraitDataFull(info.id, meta) as Record<string, unknown> | null;
      if (!data) continue;
      for (const field of fields) {
        const v = data[field];
        if (typeof v !== 'string' || v === '') continue;
        if (isExternalUrl(v)) continue;                 // http/data/blob — fine
        // A font PATH is a literal-path issue in these fields too — Text2D/Text3D.font and
        // (since #231) UIElement.fontFamily are all manifest GUIDs. QA-INSP-0004.
        if (isInternalAssetPath(v)) { refIssues.push({ entity: info.id, trait: traitName, field, value: v, kind: 'literal-path' }); continue; }
        if (isGuid(v) && !resolveGuidToPath(v)) refIssues.push({ entity: info.id, trait: traitName, field, value: v, kind: 'unresolved-guid' });
        // non-guid non-path (e.g. primitive sprite keyword 'circle') passes through.
      }
    }
  }

  // ── Transform sanity: NaN/Infinity positions or zero scale (renders invisible). ──
  const nan: TransformIssue[] = [];
  const zeroScale: number[] = [];
  const tfMeta = metaByName.get('Transform');
  if (tfMeta) {
    for (const info of entities) {
      if (!info.traits.includes('Transform')) continue;
      const t = readTraitData(info.id, tfMeta) as Record<string, number> | null;
      if (!t) continue;
      for (const f of TRANSFORM_FIELDS) {
        const val = t[f];
        if (typeof val === 'number' && !Number.isFinite(val)) nan.push({ entity: info.id, field: f, value: val });
      }
      if ((t.sx ?? 1) * (t.sy ?? 1) * (t.sz ?? 1) === 0) zeroScale.push(info.id);
    }
  }

  // ── Camera presence. Only 3D CONTENT renders black without a camera; a pure 2D/UI scene
  //    (e.g. chess) legitimately has no Camera, so gating `ok` on one there was a false alarm
  //    ("3D renders black" on a scene with zero 3D). Detect 3D content by the 3D-renderable
  //    traits (a Renderable3DPrimitive can sit at layer:'' so layer alone under-counts) OR
  //    layer==='3d'. (C7 re-audit.) ──
  const THREE_D_RENDERABLE = ['Renderable3D', 'Renderable3DPrimitive', 'SkinnedModel'];
  const has3DContent = entities.some((e) => e.layer === '3d' || THREE_D_RENDERABLE.some((t) => e.traits.includes(t)));
  const cameraCount = entities.filter((e) => e.traits.includes('Camera')).length;
  const cameraMissing = has3DContent && cameraCount === 0;

  // ── Off-screen (from the layout-bounds op). ──
  let offScreen: number[] = [];
  try { offScreen = computeLayoutBounds().offScreen; } catch { /* no renderer mounted */ }

  // Only errors within the recency window feed the health verdict. Otherwise one benign load-time or
  // fixed-scene-A error sits in the 500-entry ring and forces ok:false FOREVER — and "recent console
  // error(s)" mislabels a minutes-old error. Windowing is opt-in (needs `now`, supplied by the op via
  // Date.now()); without it — the unit tests that pass a fixed list — behavior is unchanged. (F14)
  //
  // #152: the window may gate the VERDICT but must never gate REPORTING. Errors outside it used to
  // be dropped silently — not summarised, not counted — so `consoleErrors: []` read as "this app
  // has logged no errors" when it only ever meant "none in the last N seconds". Boot errors are the
  // ones that pay for this: nobody connects a device, attaches an agent and runs diagnose inside
  // 30s, so a real 4-second frame-loop stall at startup was reported as `ok:true, "No issues
  // detected."` on a Huawei Y6 while the owner watched the freeze happen. Everything outside the
  // window is now COUNTED and TIMESTAMPED (`olderErrors`), and the window itself is named in the
  // payload (`errorWindowMs`) so `0` cannot be read as an absolute. The load-bearing property:
  // a diagnose that SAYS it is clean must not be reachable while unread errors exist.
  const raw = opts.consoleErrors ?? [];
  const windowing = opts.now != null && opts.errorWindowMs != null;
  const cutoff = windowing ? opts.now! - opts.errorWindowMs! : -Infinity;
  const windowed = windowing ? raw.filter((e) => e.ts >= cutoff) : raw;
  const older = windowing ? raw.filter((e) => e.ts < cutoff) : [];
  const consoleErrors = windowed.slice(-20);
  const olderErrors = older.length
    ? {
        count: older.length,
        oldestTs: Math.min(...older.map((e) => e.ts)),
        newestTs: Math.max(...older.map((e) => e.ts)),
      }
    : null;

  // Hard problems fail `ok`. zeroScale is a SOFT signal — an entity can be intentionally scaled to
  // 0 (hidden, or a pop-in animation at t=0), so it does NOT fail `ok`; but it must still be
  // SURFACED so `ok:true` never sits next to a populated `transforms.zeroScale` claiming "No
  // issues detected" (the contradiction the audit flagged). off-screen stays soft + unlisted. (C7 re-audit.)
  const ok = refIssues.length === 0 && nan.length === 0 && !cameraMissing && consoleErrors.length === 0;
  const zeroScaleNote = zeroScale.length ? `${zeroScale.length} zero-scale (invisible) entit(ies)` : '';
  // Older errors do NOT fail `ok` — that is what pinned the verdict forever and is why the window
  // exists. They do get SAID, in every branch, because a summary reading "No issues detected."
  // above a ring holding a boot error is the exact overclaim #152 is about.
  const olderNote = olderErrors
    ? `${olderErrors.count} older console error(s) outside the ${Math.round((opts.errorWindowMs ?? 0) / 1000)}s ` +
      `window (newest ${Math.round(((opts.now ?? olderErrors.newestTs) - olderErrors.newestTs) / 1000)}s ago) ` +
      // NAME BOTH TOOLS. This string is built in the renderer, which serves the editor AND the
      // device, so it cannot know which surface is reading it — and a hint that names the wrong
      // one is the #151 failure in miniature: advice the reader cannot act on. Caught on a real
      // phone, where the payload said "modoki_get_console_logs", a tool that does not exist there.
      '— read them with modoki_get_console_logs (editor) / device_console_logs (device), level=error'
    : '';
  // ── Device capabilities (#121 P0) ──
  // What hardware this is and what it can do — so "why is it slow / black on that phone?" is
  // answerable as DATA rather than by asking the human to read a device log. Read from the
  // cache: the probe is async (a WebGPU adapter request + a native plugin call) and this op is
  // sync, so the FIRST diagnose after boot omits it and arms the probe for every later call.
  // Deliberately fire-and-forget rather than coupling this to renderer bring-up.
  const deviceCaps = getDeviceCapsSync();
  if (!deviceCaps) void getDeviceCaps().catch(() => { /* a probe failure must never fail diagnose */ });

  // ── Performance (#121 P2) ──
  // ALWAYS present, unlike the fault channels above, because "is it fast enough?" has no
  // healthy-means-silent answer — the 30fps target is a number that must be readable at any
  // time, not only once something has already gone wrong.
  const perf = readPerfProfile();

  // ── Quality tier (#121 P3) ──
  // The tier AND why it was chosen. Without the reason a surprising tier is unexplainable
  // without an eval: "low" could mean the project pinned it, the device failed calibration, or
  // the player picked it, and those want completely different responses. Omitted entirely until
  // a renderer has resolved one, matching the healthy-means-silent convention above.
  const tier = getActiveQualityTier();
  // Three cheap fields beside the tier name — added because "did the clamp take?" was otherwise
  // answerable only from source, on a subsystem whose entire failure history is fields that read
  // as wired and did nothing (#188, R6.3). Deliberately NOT the whole resolved
  // `TierRenderOverrides` object — that spends response budget on a subsystem most `diagnose`
  // calls are not asking about.
  // `assessed`: the tier this session STARTED at (boot probe / allowlist / calibrating), distinct
  // from `tier` once live calibration has promoted/demoted away from it.
  const assessed = getAssessedQualityTier();
  // `configCount`: how many tier configs the project actually authored (1 = default only, and the
  // boot probe never ran). Through the engine's own `configCount`, never re-derived here — the
  // probe gate reads that function, and a second inline copy of `1 + mid? + low?` would be a
  // hand-synced duplicate of the rule that decides whether a device is measured at all.
  const tierConfigCount = configCount(getRenderSettings().three.tiers);
  // `targetFps`: the EFFECTIVE frame cap (authored `rendering.targetFps` clamped by the active
  // tier), never `getRenderSettings().targetFps` — see `getEffectiveTargetFps`'s own doc for why
  // the raw value looks right in the editor and on desktop and is wrong on the device that matters.
  const effectiveTargetFps = getEffectiveTargetFps();
  // The automatic light cap (#188 item 7), reported ONLY when it is doing something. A tier's
  // light limits are invisible otherwise — and they were literally inert for months — so "how many
  // of this scene's lights is this object actually lit by?" needs an answer from data. Omitted
  // when disengaged, matching the healthy-means-silent convention above.
  const lightCap = getAutoLightCapStats();
  // The shadow-caster cap (#229), on the same "reported only when it is doing something" rule.
  // A shadow the tier dropped has no error and no visible cause — the scene just renders one
  // fewer shadow than it authored — so this is the only place that can answer "where did it go?".
  const shadowCap = getShadowCasterCapStats();

  return {
    ok,
    ...(deviceCaps ? { deviceCaps } : {}),
    ...(tier
      ? {
        qualityTier: {
          ...tier, assessed, configCount: tierConfigCount, targetFps: effectiveTargetFps,
          // The tier's TEXTURE cap, in force right now (#212). Reported because it is the one
          // tier knob with no visible symptom when it fails: a texture resolved before the cap
          // was published silently fetches the full-size URL and looks perfectly correct on
          // screen. Verifying this needs data, not pixels.
          textureSizeCap: getActiveTextureSizeCap(),
        },
      }
      : {}),
    ...(lightCap.engaged ? { lightCap } : {}),
    ...(shadowCap.engaged ? { shadowCap } : {}),
    perf,
    refs: { issues: refIssues, count: refIssues.length },
    transforms: { nan, zeroScale },
    camera: { count: cameraCount, ok: !cameraMissing, needed: has3DContent },
    offScreen: { ids: offScreen, count: offScreen.length },
    consoleErrors,
    // Named so `consoleErrors: []` cannot be read as an absolute — it always means "none in the
    // last errorWindowMs", and now says so. Omitted (with olderErrors) when no window was applied.
    ...(windowing ? { errorWindowMs: opts.errorWindowMs, olderErrors } : {}),
    summary: ok
      ? (() => {
          const notes = [zeroScaleNote, olderNote].filter(Boolean).join('; ');
          return notes ? `No blocking issues. Note: ${notes}.` : 'No issues detected.';
        })()
      : [
          refIssues.length && `${refIssues.length} bad asset ref(s)`,
          nan.length && `${nan.length} NaN transform field(s)`,
          zeroScaleNote,
          cameraMissing && 'no Camera entity (3D renders black)',
          consoleErrors.length && (windowing
            ? `${consoleErrors.length} console error(s) in the last ${Math.round(opts.errorWindowMs! / 1000)}s`
            : `${consoleErrors.length} recent console error(s)`),
          olderNote,
        ].filter(Boolean).join('; '),
  };
}

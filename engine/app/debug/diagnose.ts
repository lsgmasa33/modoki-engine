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
} from '@modoki/engine/runtime';
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
  const raw = opts.consoleErrors ?? [];
  const windowed = (opts.now != null && opts.errorWindowMs != null)
    ? raw.filter((e) => e.ts >= opts.now! - opts.errorWindowMs!)
    : raw;
  const consoleErrors = windowed.slice(-20);

  // Hard problems fail `ok`. zeroScale is a SOFT signal — an entity can be intentionally scaled to
  // 0 (hidden, or a pop-in animation at t=0), so it does NOT fail `ok`; but it must still be
  // SURFACED so `ok:true` never sits next to a populated `transforms.zeroScale` claiming "No
  // issues detected" (the contradiction the audit flagged). off-screen stays soft + unlisted. (C7 re-audit.)
  const ok = refIssues.length === 0 && nan.length === 0 && !cameraMissing && consoleErrors.length === 0;
  const zeroScaleNote = zeroScale.length ? `${zeroScale.length} zero-scale (invisible) entit(ies)` : '';
  return {
    ok,
    refs: { issues: refIssues, count: refIssues.length },
    transforms: { nan, zeroScale },
    camera: { count: cameraCount, ok: !cameraMissing, needed: has3DContent },
    offScreen: { ids: offScreen, count: offScreen.length },
    consoleErrors,
    summary: ok
      ? (zeroScaleNote ? `No blocking issues. Note: ${zeroScaleNote}.` : 'No issues detected.')
      : [
          refIssues.length && `${refIssues.length} bad asset ref(s)`,
          nan.length && `${nan.length} NaN transform field(s)`,
          zeroScaleNote,
          cameraMissing && 'no Camera entity (3D renders black)',
          consoleErrors.length && `${consoleErrors.length} recent console error(s)`,
        ].filter(Boolean).join('; '),
  };
}

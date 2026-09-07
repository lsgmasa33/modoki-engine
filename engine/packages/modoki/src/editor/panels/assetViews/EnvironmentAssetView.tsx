/** EnvironmentAssetView — inspector detail for `.hdr` environment assets.
 *
 *  HDR files are equirectangular, high-dynamic-range, and can't be shown in an
 *  <img> (the browser can't decode Radiance .hdr). We load it with three's
 *  HDRLoader, tonemap a downsampled copy onto a <canvas>, and expose an exposure
 *  slider so the user can preview how bright the map is. The Import section exposes
 *  per-asset settings (format `hdr`/`ultrahdr` + max size) PARKED to the `.meta.json`
 *  sidecar (#845 — Cmd+S is the write) and applied via re-import, mirroring
 *  `TextureAssetView`. */

import { useState, useEffect, useRef, useCallback } from 'react';
import * as THREE from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { backendFetch } from '../../backend/editorBackend';
import { useEditorStore } from '../../store/editorStore';
import { DEFAULT_ENV_SETTINGS, ENV_MAX_SIZES, ULTRAHDR_VARIANT_SUFFIX, resolveEnvSettings, type EnvImportSettings, type EnvMaxSize, type EnvCacheInfo } from '../../../runtime/core/environmentSettings';
import { invalidateEnvironment } from '../../../runtime/loaders/meshTemplateCache';
import { useAssetInvalidationEpoch } from '../useAssetInvalidationEpoch';
import { assetUrl } from '../../../runtime/loaders/assetUrl';
import { inputStyle } from '../fields';
import { formatBytes, reimportBtnStyle } from './widgets';
import { encodeUltraHDR, hashBytes, bytesToBase64 } from './encodeUltraHDR';
import { withCurrentValue } from './importSettingOptions';
import {
  parkMetaEdit, readMetaPreferringPark, flushPendingMetaFor, writeMetaWholesale,
  metaCameFromFailedRead,
} from '../../scene/pendingMeta';
import { useMetaDirty } from '../useMetaDirty';
import { UnsavedMetaBadge } from './UnsavedMetaBadge';

// Preview canvas width (equirect is 2:1). Kept small — we nearest-sample the
// source down to this so tonemapping a 2k HDR stays cheap.
const PREVIEW_W = 256;

/** ACES filmic tonemap (Narkowicz fit) — matches three's ACESFilmicToneMapping
 *  closely enough for a thumbnail. Input linear, output linear (gamma applied
 *  after). */
function acesToneMap(x: number): number {
  const a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return Math.min(1, Math.max(0, (x * (a * x + b)) / (x * (c * x + d) + e)));
}

export function EnvironmentAssetView({ path, name }: { path: string; name: string }) {
  // #870: a parked import-settings edit was invisible in the panel that MADE it.
  const metaDirty = useMetaDirty(path);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Decoded HDR pixel data (linear RGB, one float per channel) + native dims.
  const hdrRef = useRef<{ data: Float32Array | Uint16Array; type: number; w: number; h: number } | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [exposure, setExposure] = useState(1);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [meta, setMeta] = useState<Record<string, unknown> | null>(null);
  const [settings, setSettings] = useState<EnvImportSettings>(DEFAULT_ENV_SETTINGS);
  const [importing, setImporting] = useState(false);
  const [converted, setConverted] = useState(false);
  const refreshAssets = useEditorStore((s) => s.refreshAssets);
  const setImportStatus = useEditorStore((s) => s.setImportStatus);

  // Same path-keyed staleness ModelAssetView + TextureAssetView had (#303/#304): this
  // re-read the sidecar on mount and after its OWN Apply button only, so a re-import
  // from the Assets panel or the agent bridge left the stats and the `converted` flag
  // showing pre-reimport values. The epoch cache-busts the URL, so it is a value this
  // callback genuinely reads — the sidecar is rewritten in place at an unchanged URL.
  const reimportEpoch = useAssetInvalidationEpoch('environment', (p) => p === path);

  const applyMeta = useCallback((m: Record<string, unknown>) => {
    setMeta(m);
    setSettings(resolveEnvSettings(m as { environment?: Partial<EnvImportSettings> }));
    setConverted(!!m.environmentCache);
  }, []);

  const loadMeta = useCallback((signal?: AbortSignal) => {
    // #845: ASK THE REGISTRY BEFORE THE FILE — a settings edit here is PARKED, so disk still holds
    // the PRE-edit doc until Cmd+S. `apply` flushes this path before it reimports/re-writes, so by
    // the time this runs after one, nothing is parked here and this falls through to a fresh read.
    return readMetaPreferringPark(path, { signal, reimportEpoch })
      .then(({ meta: m }) => applyMeta(m))
      .catch(() => { /* keep defaults */ });
  }, [path, reimportEpoch, applyMeta]);

  useEffect(() => {
    const ac = new AbortController();
    loadMeta(ac.signal);
    return () => ac.abort();
  }, [loadMeta]);

  const update = useCallback((patch: Partial<EnvImportSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      const updatedMeta = { ...(meta ?? {}), environment: next };
      setMeta(updatedMeta);
      parkMetaEdit(path, updatedMeta);
      return next;
    });
  }, [meta, path]);

  const apply = useCallback(async () => {
    // ⚠️ REFUSE BEFORE THE EXPENSIVE WORK, not after the write (#880 close-out review 3).
    //
    // The first version of this guard checked `writeMetaWholesale`'s return, which is the LAST
    // step: by then `encodeUltraHDR` had run the WebGL gainmap encode and `/api/write-file` had
    // committed a multi-MB `~ultrahdr.jpg` into the asset tree — so a refusal left that variant
    // orphaned on disk with nothing in the sidecar pointing at it, and the re-read that followed
    // snapped the format dropdown back to `hdr`, discarding the user's choice with no toast.
    // It traded a visible sticky refusal for silent loss, which is worse.
    //
    // The answer is decidable here, before anything is spent: if this panel's document came from
    // a failed read it has no `id`, and a wholesale write of it would cost the asset its GUID.
    if (metaCameFromFailedRead(meta)) {
      console.error(
        `[Inspector] not converting ${path} — its .meta.json was never read successfully, so `
        + 'writing the result would replace the file with a document missing its GUID. Reselect '
        + 'the asset to re-read it, then retry.',
      );
      useEditorStore.getState().showToast(
        `Cannot convert ${name} — its import settings could not be read. Reselect the asset and try again.`,
        'warn',
      );
      return;
    }
    setImporting(true);
    try {
      // #845: both branches below are about to read (the reimport route, off disk) or write (the
      // ultrahdr route, a full-document merge) this sidecar — flush any still-parked settings edit
      // first, or the branch would work from a stale doc and a leftover park would overwrite its
      // own fresh write at the next Cmd+S. See pendingMeta.ts's header.
      await flushPendingMetaFor(path);
      if (settings.format === 'ultrahdr') {
        // Browser-side gainmap encode (needs WebGL) → commit `~ultrahdr.jpg` next to
        // the source (the Node build can't regenerate it), then write the meta so the
        // scanner emits the manifest env block.
        setImportStatus(true, `Encoding UltraHDR for ${name}...`);
        const jpeg = await encodeUltraHDR(assetUrl(path));
        const variantPath = path + ULTRAHDR_VARIANT_SUFFIX;
        const w = await backendFetch('/api/write-file', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: variantPath, content: bytesToBase64(jpeg), encoding: 'base64' }),
        });
        if (!w.ok) { console.error('[Inspector] UltraHDR write failed'); return; }
        const hash = hashBytes(jpeg);
        const updatedMeta = { ...(meta ?? {}), environment: settings, environmentCache: { hash, bytes: jpeg.length } };
        setMeta(updatedMeta);
        // #874: the write AND the forget-on-success, in one call — see writeMetaWholesale.
        //
        // ⚠️ The result is CHECKED (#880 close-out review). Discarding it made a refused write —
        // which is now a real outcome, since `writeMetaWholesale` refuses a document built on a
        // failed read — look like a completed Apply: the status cleared, the asset list refreshed,
        // and `~ultrahdr.jpg` sat on disk with nothing in the sidecar pointing at it, explained
        // only by a `console.error`. `makeTexture2D` returns `false` to its caller and the two
        // modal editors keep their dialog open; this was the one of the four that swallowed it.
        // ⚠️ A failed write returns WITHOUT re-reading. The provenance case is refused at the top
        // of this function now, so the only way to reach this branch is a genuine write failure
        // (a dev-server blip) — and re-reading there would reseed `settings` from disk and throw
        // away the user's dropdown choice for a reason that has nothing to do with it. Same rule
        // the two modal editors follow by keeping their dialog open.
        if (!await writeMetaWholesale(path, updatedMeta)) return;
      } else {
        // Node-side downscale (dependency-free) via the reimport handler.
        setImportStatus(true, `Downscaling ${name}...`);
        const res = await backendFetch('/api/reimport', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path }),
        });
        const summary = await res.json().catch(() => ({}));
        if (!res.ok || (summary.errors && summary.errors.length)) {
          console.error('[Inspector] Environment convert failed:', summary.errors ?? summary);
        }
      }
      await loadMeta();
      invalidateEnvironment(path);
      refreshAssets();
    } catch (e) {
      console.error('[Inspector] Environment convert failed:', e);
    } finally {
      setImporting(false);
      setImportStatus(false);
    }
  }, [path, name, settings, meta, loadMeta, refreshAssets, setImportStatus]);

  // Load + decode the HDR once per asset. FloatType keeps decoding simple
  // (Float32 channels); HalfFloat is handled too via DataUtils for safety.
  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    hdrRef.current = null;
    setDims(null);
    const loader = new HDRLoader();
    loader.setDataType(THREE.FloatType);
    loader.load(
      path,
      (tex) => {
        if (cancelled) return;
        const img = tex.image as { data: Float32Array | Uint16Array; width: number; height: number };
        hdrRef.current = { data: img.data, type: tex.type, w: img.width, h: img.height };
        setDims({ w: img.width, h: img.height });
        setStatus('ready');
        tex.dispose();
      },
      undefined,
      () => { if (!cancelled) setStatus('error'); },
    );
    return () => { cancelled = true; };
  }, [path]);

  // Re-tonemap onto the canvas whenever the decode finishes or exposure changes.
  const render = useCallback(() => {
    const hdr = hdrRef.current;
    const canvas = canvasRef.current;
    if (!hdr || !canvas) return;
    const tw = Math.min(PREVIEW_W, hdr.w);
    const th = Math.max(1, Math.round(tw * (hdr.h / hdr.w)));
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const out = ctx.createImageData(tw, th);
    const isHalf = hdr.type === THREE.HalfFloatType;
    const readCh = (i: number): number => (isHalf
      ? THREE.DataUtils.fromHalfFloat((hdr.data as Uint16Array)[i])
      : (hdr.data as Float32Array)[i]);
    for (let y = 0; y < th; y++) {
      const sy = Math.min(hdr.h - 1, (y / th * hdr.h) | 0);
      for (let x = 0; x < tw; x++) {
        const sx = Math.min(hdr.w - 1, (x / tw * hdr.w) | 0);
        const si = (sy * hdr.w + sx) * 4;
        const di = (y * tw + x) * 4;
        for (let c = 0; c < 3; c++) {
          const lin = readCh(si + c) * exposure;
          const mapped = acesToneMap(lin);
          out.data[di + c] = Math.round(Math.pow(mapped, 1 / 2.2) * 255); // linear→sRGB gamma
        }
        out.data[di + 3] = 255;
      }
    }
    ctx.putImageData(out, 0, 0);
  }, [exposure]);

  useEffect(() => { render(); }, [render, status]);

  const labelStyle: React.CSSProperties = { flex: 1, color: '#888', fontSize: '11px' };
  const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 };
  const sectionStyle: React.CSSProperties = { color: '#f1c40f', fontSize: '10px', textTransform: 'uppercase', margin: '8px 0 3px' };

  return (
    <>
      <div style={sectionStyle}>Preview (equirectangular)</div>
      <div style={{ position: 'relative', width: '100%', aspectRatio: '2 / 1', background: '#1a1a1a', border: '1px solid #333', marginBottom: 6, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <canvas ref={canvasRef} style={{ width: '100%', height: '100%', objectFit: 'contain', imageRendering: 'auto' }} />
        {status !== 'ready' && (
          <div style={{ position: 'absolute', color: status === 'error' ? '#e74c3c' : '#666', fontSize: 11 }}>
            {status === 'error' ? 'Failed to decode HDR' : 'Decoding…'}
          </div>
        )}
      </div>

      <div style={rowStyle}>
        <span style={labelStyle}>Exposure</span>
        <input data-ui-id="assetView.environment.exposure" data-ui-kind="field" data-ui-label="Exposure" type="range" min={-3} max={3} step={0.1} value={Math.log2(exposure)}
          onChange={(e) => setExposure(Math.pow(2, Number(e.target.value)))}
          style={{ flex: 2 }} />
        <span style={{ color: '#ccc', fontSize: 11, width: 34, textAlign: 'right' }}>{exposure.toFixed(2)}×</span>
      </div>
      <div style={{ color: '#666', fontSize: 10, marginBottom: 4 }}>
        ACES-tonemapped preview only — exposure here does not affect the scene. Per-entity brightness is the Environment trait&apos;s <code>intensity</code>.
      </div>

      <div style={sectionStyle}>Import</div>
      <div style={rowStyle}>
        <span style={labelStyle}>Format</span>
        <select data-ui-id="assetView.environment.format" data-ui-kind="field" data-ui-label="Format" value={settings.format} onChange={(e) => update({ format: e.target.value as EnvImportSettings['format'] })} style={{ ...inputStyle, flex: 1 }}>
          <option value="hdr">HDR (downscaled Radiance)</option>
          <option value="ultrahdr">UltraHDR (gainmap JPEG, ~10× smaller)</option>
        </select>
      </div>
      {settings.format === 'hdr' && (
        <div style={rowStyle}>
          <span style={labelStyle}>Max Size</span>
          <select value={String(settings.maxSize)} onChange={(e) => update({ maxSize: Number(e.target.value) as EnvMaxSize })} style={{ ...inputStyle, flex: 1 }}>
            {/* Splice an off-list authored size in — an unmatched `value` would display as
                the FIRST option and misreport the setting (#131). */}
            {withCurrentValue(ENV_MAX_SIZES, settings.maxSize).map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      )}
      <div style={{ color: '#666', fontSize: 10, margin: '2px 0 4px' }}>
        {settings.format === 'ultrahdr'
          ? 'UltraHDR gainmap JPEG — ~10× smaller, universal device support, encoded in the editor (needs WebGL); the ~ultrahdr.jpg variant is committed next to the source. NOTE: it is display-referred, so it renders dimmer/muted for scene lighting (IBL) than HDR — the env intensity is auto-boosted to compensate, but prefer HDR when lighting accuracy matters.'
          : 'Downscales the equirect HDR to the max edge (never upscales). A 2K env is ~6 MB; 1K is ~3× smaller and, since the map feeds a blurred PMREM, the detail loss is largely invisible.'}
      </div>
      <button
        data-ui-id="assetView.environment.apply" data-ui-kind="button" data-ui-label={converted ? 'Re-import' : 'Apply'}
        disabled={importing}
        onClick={apply}
        style={{ ...reimportBtnStyle, marginTop: 4, background: importing ? '#555' : '#2ecc71', color: '#fff', border: `1px solid ${importing ? '#444' : '#27ae60'}`, cursor: importing ? 'wait' : 'pointer' }}
      >
        {importing ? (settings.format === 'ultrahdr' ? 'Encoding...' : 'Downscaling...') : converted ? 'Re-import' : 'Apply'}
      </button>

      <div style={sectionStyle}>Info</div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, padding: '1px 0' }}>
        <span style={{ color: '#888' }}>Source resolution</span>
        <span style={{ color: '#ccc' }}>{dims ? `${dims.w} × ${dims.h}` : '—'}</span>
      </div>
      {converted && (() => {
        const cache = meta?.environmentCache as EnvCacheInfo | undefined;
        if (!cache) return null;
        return (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, padding: '1px 0' }}>
              <span style={{ color: '#888' }}>Downscaled</span>
              <span style={{ color: '#ccc' }}>{cache.width != null ? `${cache.width} × ${cache.height}` : '—'}</span>
            </div>
            {cache.bytes != null && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, padding: '1px 0' }}>
                <span style={{ color: '#888' }}>Variant size</span>
                <span style={{ color: '#ccc' }}>{formatBytes(cache.bytes)}</span>
              </div>
            )}
          </>
        );
      })()}
      <UnsavedMetaBadge dirty={metaDirty} dataUiId="assetView.environment.unsaved" />
    </>
  );
}

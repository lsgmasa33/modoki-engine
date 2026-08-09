/** VideoAssetView (+ VideoImportedStats) — video import settings editor + Apply
 *  (ffmpeg convert) action, mirroring AudioAssetView. Settings persist to the clip's
 *  .meta.json on change; Apply runs the conversion through /api/reimport and reloads.
 *  Preview is a native <video controls> pointed at the converted variant.
 *
 *  There is no output-format control on purpose — video is H.264/mp4 only, because
 *  that is the sole codec the iOS WKWebView plays. See docs/video.md. */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { backendFetch } from '../../backend/editorBackend';
import { useEditorStore } from '../../store/editorStore';
import {
  DEFAULT_VIDEO_SETTINGS, VIDEO_QUALITIES, VIDEO_PRESETS, VIDEO_MAX_DIMENSIONS, VIDEO_MAX_FPS,
  VIDEO_SCALE_PERCENTS, resolveVideoSettings,
  type VideoImportSettings, type VideoDelivery, type VideoDeliveryPolicy,
  type VideoPreset, type VideoAudioMode, type VideoResizeMode, type VideoCacheInfo,
} from '../../../runtime/loaders/videoSettings';
import { inputStyle, BufferedNumberInput } from '../fields';
import { formatBytes, reimportBtnStyle, writeMetaOrWarn } from './widgets';
import {
  videoPreviewUrl, describeVideoDelivery, videoSettingsWarnings, conversionSettingsDiffer,
} from './videoAssetLogic';
import { withCurrentValue } from './importSettingOptions';

const DELIVERY_LABELS: Record<VideoDelivery, string> = {
  bundled: 'Bundled — ships in the build',
  remote: 'Remote — fetched from a host',
};

const POLICY_LABELS: Record<VideoDeliveryPolicy, string> = {
  auto: 'Auto — download if small, else stream',
  stream: 'Stream — play from the URL, store nothing',
  download: 'Download — fetch first, then play offline',
};

const AUDIO_LABELS: Record<VideoAudioMode, string> = {
  keep: 'Keep — re-encode the source track',
  strip: 'Strip — no audio track (silent clip)',
};

/** CRF is inverted (lower = better), which reads backwards without a hint. */
const QUALITY_LABELS: Record<number, string> = {
  18: '18 — near-lossless (large)',
  20: '20 — high',
  23: '23 — default',
  26: '26 — smaller',
  30: '30 — low (smallest)',
};

const RESIZE_LABELS: Record<VideoResizeMode, string> = {
  bounds: 'Max size — no bigger than W×H',
  percent: 'Percentage — a fraction of the source',
};

const AUDIO_BITRATES = [64, 96, 128, 192, 256];

const labelStyle: React.CSSProperties = { flex: 1, color: '#888', fontSize: '11px' };
const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 };
const sectionStyle: React.CSSProperties = { color: '#f1c40f', fontSize: '10px', textTransform: 'uppercase', margin: '8px 0 3px' };

export function VideoAssetView({ path, name }: { path: string; name: string }) {
  const [meta, setMeta] = useState<Record<string, unknown> | null>(null);
  const [settings, setSettings] = useState<VideoImportSettings>(DEFAULT_VIDEO_SETTINGS);
  /** What the last load/apply saw — the baseline `conversionSettingsDiffer` compares
   *  against, so an edit can announce that it needs a re-encode. */
  const [applied, setApplied] = useState<VideoImportSettings>(DEFAULT_VIDEO_SETTINGS);
  const [importing, setImporting] = useState(false);
  const [converted, setConverted] = useState(false);
  const refreshAssets = useEditorStore((s) => s.refreshAssets);
  const setImportStatus = useEditorStore((s) => s.setImportStatus);

  const loadMeta = useCallback((signal?: AbortSignal) => {
    return backendFetch(`/api/read-meta?path=${encodeURIComponent(path)}`, signal ? { signal } : undefined)
      .then((r) => (r.ok ? r.json() : {}))
      .then((m: Record<string, unknown>) => {
        setMeta(m);
        const s = resolveVideoSettings(m as { video?: Partial<VideoImportSettings> });
        setSettings(s);
        setApplied(s);
        setConverted(!!m.videoCache);
      })
      .catch(() => { /* keep defaults */ });
  }, [path]);

  useEffect(() => {
    const ac = new AbortController();
    loadMeta(ac.signal);
    return () => ac.abort();
  }, [loadMeta]);

  // Persist a settings change to the meta sidecar immediately, preserving the rest of
  // the meta (id/videoCache) — same contract as audio/texture.
  const update = useCallback((patch: Partial<VideoImportSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      const updatedMeta = { ...(meta ?? {}), version: 2, video: next };
      setMeta(updatedMeta);
      writeMetaOrWarn(path, updatedMeta);
      return next;
    });
  }, [meta, path]);

  const apply = useCallback(async () => {
    setImporting(true);
    setImportStatus(true, `Converting ${name}...`);
    try {
      const res = await backendFetch('/api/reimport', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      const summary = await res.json().catch(() => ({}));
      if (!res.ok || (summary.errors && summary.errors.length)) {
        console.error('[Inspector] Video convert failed:', summary.errors ?? summary);
      }
      await loadMeta();
      refreshAssets();
    } finally {
      setImporting(false);
      setImportStatus(false);
    }
  }, [path, name, loadMeta, refreshAssets, setImportStatus]);

  const cache = meta?.videoCache as VideoCacheInfo | undefined;
  const warnings = useMemo(() => videoSettingsWarnings(settings, cache), [settings, cache]);
  const pending = converted && conversionSettingsDiffer(settings, applied);
  const remote = settings.delivery === 'remote';

  return (
    <>
      {/* The CONVERTED variant, not the source — a .mkv/.mov source often won't decode
          in Chromium at all, and previewing it would libel a perfectly good clip.
          `key` forces a reload when the variant changes underneath us (re-import). */}
      <video
        key={`${path}:${cache?.hash ?? 'src'}`}
        controls
        preload="metadata"
        src={videoPreviewUrl(path, converted)}
        style={{ width: '100%', maxHeight: 160, background: '#111', border: '1px solid #333', borderRadius: 3, marginBottom: 6, display: 'block' }}
      />

      <div style={sectionStyle}>Delivery</div>
      <div style={rowStyle}>
        <span style={labelStyle}>Delivery</span>
        <select data-ui-id="inspector.video.delivery" value={settings.delivery} onChange={(e) => update({ delivery: e.target.value as VideoDelivery })} style={{ ...inputStyle, flex: 1 }}>
          {(Object.keys(DELIVERY_LABELS) as VideoDelivery[]).map((v) => <option key={v} value={v}>{DELIVERY_LABELS[v]}</option>)}
        </select>
      </div>
      {remote && (
        <>
          <div style={rowStyle}>
            <span style={labelStyle}>Policy</span>
            <select data-ui-id="inspector.video.policy" value={settings.policy} onChange={(e) => update({ policy: e.target.value as VideoDeliveryPolicy })} style={{ ...inputStyle, flex: 1 }}>
              {(Object.keys(POLICY_LABELS) as VideoDeliveryPolicy[]).map((v) => <option key={v} value={v}>{POLICY_LABELS[v]}</option>)}
            </select>
          </div>
          <TextCommitField
            label="Remote URL"
            uiId="inspector.video.remoteUrl"
            value={settings.remoteUrl ?? ''}
            placeholder="https://..."
            onCommit={(v) => update({ remoteUrl: v.trim() || undefined })}
          />
        </>
      )}
      <div style={{ color: '#777', fontSize: '10px', margin: '2px 0 4px', lineHeight: 1.4 }}>
        {describeVideoDelivery(settings, cache)}
      </div>

      <div style={sectionStyle}>Encoding</div>
      <div style={rowStyle}>
        <span style={labelStyle}>Quality (CRF)</span>
        <select data-ui-id="inspector.video.quality" value={String(settings.quality)} onChange={(e) => update({ quality: Number(e.target.value) })} style={{ ...inputStyle, flex: 1 }}>
          {withCurrentValue(VIDEO_QUALITIES, settings.quality).map((q) => <option key={q} value={q}>{QUALITY_LABELS[q] ?? String(q)}</option>)}
        </select>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>Preset</span>
        <select data-ui-id="inspector.video.preset" value={settings.preset} onChange={(e) => update({ preset: e.target.value as VideoPreset })} style={{ ...inputStyle, flex: 1 }}>
          {VIDEO_PRESETS.map((p) => <option key={p} value={p}>{p}{p === 'veryfast' ? ' (default)' : ''}</option>)}
        </select>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>Resize</span>
        <select data-ui-id="inspector.video.resizeMode" value={settings.resizeMode} onChange={(e) => update({ resizeMode: e.target.value as VideoResizeMode })} style={{ ...inputStyle, flex: 1 }}>
          {(Object.keys(RESIZE_LABELS) as VideoResizeMode[]).map((v) => <option key={v} value={v}>{RESIZE_LABELS[v]}</option>)}
        </select>
      </div>
      {/* One mode's controls at a time — showing both invites setting a percentage AND
          a bound, where the result tells you nothing about which one applied. */}
      {settings.resizeMode === 'percent' ? (
        <div style={rowStyle}>
          <span style={labelStyle}>Scale</span>
          <select data-ui-id="inspector.video.scalePercent" value={String(settings.scalePercent)} onChange={(e) => update({ scalePercent: Number(e.target.value) })} style={{ ...inputStyle, flex: 1 }}>
            {withCurrentValue(VIDEO_SCALE_PERCENTS, settings.scalePercent).map((p) => <option key={p} value={p}>{p === 100 ? '100% — source size' : `${p}%`}</option>)}
          </select>
        </div>
      ) : (
        <>
          <div style={rowStyle}>
            <span style={labelStyle}>Max Width</span>
            <select data-ui-id="inspector.video.maxWidth" value={String(settings.maxWidth)} onChange={(e) => update({ maxWidth: Number(e.target.value) })} style={{ ...inputStyle, flex: 1 }}>
              {withCurrentValue(VIDEO_MAX_DIMENSIONS, settings.maxWidth).map((d) => <option key={d} value={d}>{d === 0 ? 'Source' : `${d} px`}</option>)}
            </select>
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>Max Height</span>
            <select data-ui-id="inspector.video.maxHeight" value={String(settings.maxHeight)} onChange={(e) => update({ maxHeight: Number(e.target.value) })} style={{ ...inputStyle, flex: 1 }}>
              {withCurrentValue(VIDEO_MAX_DIMENSIONS, settings.maxHeight).map((d) => <option key={d} value={d}>{d === 0 ? 'Source' : `${d} px`}</option>)}
            </select>
          </div>
        </>
      )}
      <div style={rowStyle}>
        <span style={labelStyle}>Max FPS</span>
        <select data-ui-id="inspector.video.maxFps" value={String(settings.maxFps)} onChange={(e) => update({ maxFps: Number(e.target.value) })} style={{ ...inputStyle, flex: 1 }}>
          {withCurrentValue(VIDEO_MAX_FPS, settings.maxFps).map((f) => <option key={f} value={f}>{f === 0 ? 'Source' : `${f} fps`}</option>)}
        </select>
      </div>
      <div style={rowStyle}>
        {/* Load-bearing for streaming: a seek can only land on a keyframe, so a long
            interval makes scrubbing coarse and a short one costs bytes. */}
        <span style={labelStyle}>Keyframe Interval (s)</span>
        <BufferedNumberInput
          value={settings.keyframeIntervalSec}
          onChange={(v) => update({ keyframeIntervalSec: v })}
          step={0.5}
          min={0.5}
          max={30}
          style={{ ...inputStyle, flex: 1 }}
        />
      </div>

      <div style={sectionStyle}>Audio</div>
      <div style={rowStyle}>
        <span style={labelStyle}>Audio</span>
        <select data-ui-id="inspector.video.audio" value={settings.audio} onChange={(e) => update({ audio: e.target.value as VideoAudioMode })} style={{ ...inputStyle, flex: 1 }}>
          {(Object.keys(AUDIO_LABELS) as VideoAudioMode[]).map((v) => <option key={v} value={v}>{AUDIO_LABELS[v]}</option>)}
        </select>
      </div>
      {settings.audio === 'keep' && (
        <div style={rowStyle}>
          <span style={labelStyle}>Bitrate (kbps)</span>
          <select data-ui-id="inspector.video.audioBitrate" value={String(settings.audioBitrate)} onChange={(e) => update({ audioBitrate: Number(e.target.value) })} style={{ ...inputStyle, flex: 1 }}>
            {withCurrentValue(AUDIO_BITRATES, settings.audioBitrate).map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
      )}

      {warnings.map((w) => (
        <div key={w} style={{ color: '#e0a06c', fontSize: '10px', lineHeight: 1.4, marginTop: 4, padding: '3px 5px', background: '#3a2e1e', border: '1px solid #5a452a', borderRadius: 3 }}>
          ⚠ {w}
        </div>
      ))}

      <button
        data-ui-id="inspector.video.reimport"
        disabled={importing}
        onClick={apply}
        style={{ ...reimportBtnStyle, marginTop: 8, background: importing ? '#555' : '#2ecc71', color: '#fff', border: `1px solid ${importing ? '#444' : '#27ae60'}`, cursor: importing ? 'wait' : 'pointer' }}
      >
        {importing ? 'Converting...' : converted ? 'Re-import' : 'Apply'}
      </button>
      {pending && (
        <div style={{ color: '#f1c40f', fontSize: '10px', marginTop: 3 }}>
          Encoding settings changed — re-import to apply them.
        </div>
      )}
      {converted && <VideoImportedStats cache={cache} />}
    </>
  );
}

/** Text field that commits on blur or Enter, not per keystroke — the sidecar write is
 *  a network round-trip, and a URL typed a character at a time would fire one per
 *  letter (and persist a dozen invalid intermediate URLs). Escape reverts. */
function TextCommitField({ label, uiId, value, placeholder, onCommit }: {
  label: string; uiId?: string; value: string; placeholder?: string; onCommit: (v: string) => void;
}) {
  const [local, setLocal] = useState(value);
  const [focused, setFocused] = useState(false);
  // Re-sync when the asset changes underneath us, but never while the user is typing.
  useEffect(() => { if (!focused) setLocal(value); }, [value, focused]);
  return (
    <div style={rowStyle}>
      <span style={labelStyle}>{label}</span>
      <input
        type="text"
        data-ui-id={uiId}
        spellCheck={false}
        value={local}
        placeholder={placeholder}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); if (local !== value) onCommit(local); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
          else if (e.key === 'Escape') { setLocal(value); (e.currentTarget as HTMLInputElement).blur(); }
        }}
        onChange={(e) => setLocal(e.target.value)}
        style={{ ...inputStyle, flex: 1, minWidth: 0 }}
      />
    </div>
  );
}

/** Post-conversion stats read back from the meta sidecar. */
function VideoImportedStats({ cache }: { cache: VideoCacheInfo | undefined }) {
  const statRow: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', fontSize: '11px', padding: '1px 0' };
  const key: React.CSSProperties = { color: '#888' };
  const val: React.CSSProperties = { color: '#ccc' };

  if (!cache) {
    return <div style={{ color: '#666', fontSize: '10px', marginTop: 4 }}>Converted ✓ — re-import to compute stats</div>;
  }
  return (
    <>
      <div style={sectionStyle}>Imported</div>
      <div style={statRow}><span style={key}>Format</span><span style={val}>{cache.ext}</span></div>
      {cache.width !== undefined && cache.height !== undefined && (
        <div style={statRow}><span style={key}>Resolution</span><span style={val}>{cache.width}×{cache.height}</span></div>
      )}
      {cache.durationSec !== undefined && <div style={statRow}><span style={key}>Duration</span><span style={val}>{cache.durationSec.toFixed(2)}s</span></div>}
      {cache.fps !== undefined && <div style={statRow}><span style={key}>Frame rate</span><span style={val}>{cache.fps.toFixed(2)} fps</span></div>}
      {cache.hasAudio !== undefined && <div style={statRow}><span style={key}>Audio track</span><span style={val}>{cache.hasAudio ? 'yes' : 'none'}</span></div>}
      {cache.bytes !== undefined && (
        <div style={{ ...statRow, borderTop: '1px solid #333', marginTop: 2, paddingTop: 3 }}>
          <span style={{ ...key, color: '#aaa' }}>Size</span><span style={{ ...val, color: '#fff' }}>{formatBytes(cache.bytes)}</span>
        </div>
      )}
    </>
  );
}

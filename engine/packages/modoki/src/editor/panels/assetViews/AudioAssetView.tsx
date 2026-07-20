/** AudioAssetView (+ AudioImportedStats) — audio import settings editor + Apply
 *  (ffmpeg convert) action, mirroring TextureAssetView. Settings persist to the
 *  clip's .meta.json on change; Apply runs the conversion + reloads. Preview is a
 *  native <audio controls> (play/stop/scrub for free) plus a decoded waveform. */

import { useState, useEffect, useCallback, useRef } from 'react';
import { backendFetch } from '../../backend/editorBackend';
import { useEditorStore } from '../../store/editorStore';
import {
  DEFAULT_AUDIO_SETTINGS, AUDIO_FORMATS, AUDIO_BITRATES, AUDIO_SAMPLE_RATES, OPUS_SAMPLE_RATES, AUDIO_BIT_DEPTHS,
  resolveAudioSettings, audioFormatIsLossy,
  type AudioImportSettings, type AudioFormat, type AudioLoadType, type AudioCacheInfo,
} from '../../../runtime/loaders/audioSettings';
import { invalidateAudio } from '../../../runtime/loaders/audioBufferCache';
import { getAudioContext } from '../../../runtime/audio/audioContext';
import { inputStyle } from '../fields';
import { formatBytes, reimportBtnStyle, writeMetaOrWarn } from './widgets';

const FORMAT_LABELS: Record<AudioFormat, string> = {
  mp3: 'MP3 (default — license-free, universal)',
  aac: 'AAC / M4A (hardware-decoded)',
  opus: 'Opus (small; iOS 18.4+ only)',
  wav: 'WAV (lossless, uncompressed)',
  flac: 'FLAC (lossless, compressed)',
};

const LOAD_TYPE_LABELS: Record<AudioLoadType, string> = {
  buffer: 'Buffer — decode to memory (short SFX)',
  stream: 'Stream — play on demand (long music)',
};

export function AudioAssetView({ path, name }: { path: string; name: string }) {
  const [meta, setMeta] = useState<Record<string, unknown> | null>(null);
  const [settings, setSettings] = useState<AudioImportSettings>(DEFAULT_AUDIO_SETTINGS);
  const [importing, setImporting] = useState(false);
  const [converted, setConverted] = useState(false);
  const refreshAssets = useEditorStore((s) => s.refreshAssets);
  const setImportStatus = useEditorStore((s) => s.setImportStatus);

  const loadMeta = useCallback((signal?: AbortSignal) => {
    return backendFetch(`/api/read-meta?path=${encodeURIComponent(path)}`, signal ? { signal } : undefined)
      .then((r) => (r.ok ? r.json() : {}))
      .then((m: Record<string, unknown>) => {
        setMeta(m);
        setSettings(resolveAudioSettings(m as { audio?: Partial<AudioImportSettings> }));
        setConverted(!!m.audioCache);
      })
      .catch(() => { /* keep defaults */ });
  }, [path]);

  useEffect(() => {
    const ac = new AbortController();
    loadMeta(ac.signal);
    return () => ac.abort();
  }, [loadMeta]);

  // Persist a settings change to the meta sidecar immediately (discrete controls,
  // no debounce). The full meta is preserved (id/audioCache).
  const update = useCallback((patch: Partial<AudioImportSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      const updatedMeta = { ...(meta ?? {}), version: 2, audio: next };
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
        console.error('[Inspector] Audio convert failed:', summary.errors ?? summary);
      }
      await loadMeta();
      invalidateAudio(path);
      refreshAssets();
    } finally {
      setImporting(false);
      setImportStatus(false);
    }
  }, [path, name, loadMeta, refreshAssets, setImportStatus]);

  const labelStyle: React.CSSProperties = { flex: 1, color: '#888', fontSize: '11px' };
  const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 };
  const sectionStyle: React.CSSProperties = { color: '#f1c40f', fontSize: '10px', textTransform: 'uppercase', margin: '8px 0 3px' };
  const lossy = audioFormatIsLossy(settings.format);

  return (
    <>
      {/* Source preview — native transport gives play/stop/scrub for free. */}
      <Waveform path={path} />
      <audio controls src={path} style={{ width: '100%', height: 32, marginBottom: 6 }} />

      <div style={sectionStyle}>Load Type</div>
      <div style={rowStyle}>
        <span style={labelStyle}>Load Type</span>
        <select value={settings.loadType} onChange={(e) => update({ loadType: e.target.value as AudioLoadType })} style={{ ...inputStyle, flex: 1 }}>
          {(Object.keys(LOAD_TYPE_LABELS) as AudioLoadType[]).map((v) => <option key={v} value={v}>{LOAD_TYPE_LABELS[v]}</option>)}
        </select>
      </div>

      <div style={sectionStyle}>Format</div>
      <div style={rowStyle}>
        <span style={labelStyle}>Format</span>
        <select value={settings.format} onChange={(e) => update({ format: e.target.value as AudioFormat })} style={{ ...inputStyle, flex: 1 }}>
          {AUDIO_FORMATS.map((f) => <option key={f} value={f}>{FORMAT_LABELS[f]}</option>)}
        </select>
      </div>
      {lossy && (
        <div style={rowStyle}>
          <span style={labelStyle}>Bitrate (kbps)</span>
          <select value={String(settings.quality)} onChange={(e) => update({ quality: Number(e.target.value) })} style={{ ...inputStyle, flex: 1 }}>
            {AUDIO_BITRATES.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
      )}
      <div style={rowStyle}>
        <span style={labelStyle}>Sample Rate</span>
        <select value={String(settings.sampleRate ?? 0)} onChange={(e) => update({ sampleRate: Number(e.target.value) })} style={{ ...inputStyle, flex: 1 }}>
          {/* opus only accepts a fixed set of rates — offer just those for opus. */}
          {(settings.format === 'opus' ? OPUS_SAMPLE_RATES : AUDIO_SAMPLE_RATES).map((r) => <option key={r} value={r}>{r === 0 ? 'Source' : `${r} Hz`}</option>)}
        </select>
      </div>
      {settings.format === 'wav' && (
        <div style={rowStyle}>
          <span style={labelStyle}>Bit Depth</span>
          <select value={String(settings.bitDepth ?? 16)} onChange={(e) => update({ bitDepth: Number(e.target.value) })} style={{ ...inputStyle, flex: 1 }}>
            {AUDIO_BIT_DEPTHS.map((b) => <option key={b} value={b}>{b}-bit{b === 32 ? ' (float)' : ''}</option>)}
          </select>
        </div>
      )}

      <div style={sectionStyle}>Processing</div>
      <div style={rowStyle}>
        <span style={labelStyle}>Force Mono</span>
        <input type="checkbox" checked={settings.forceMono} onChange={(e) => update({ forceMono: e.target.checked })} />
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>Normalize Loudness</span>
        <input type="checkbox" checked={settings.normalize} onChange={(e) => update({ normalize: e.target.checked })} />
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>Trim Silence</span>
        <input type="checkbox" checked={settings.trimSilence} onChange={(e) => update({ trimSilence: e.target.checked })} />
      </div>

      <button
        disabled={importing}
        onClick={apply}
        style={{ ...reimportBtnStyle, marginTop: 8, background: importing ? '#555' : '#2ecc71', color: '#fff', border: `1px solid ${importing ? '#444' : '#27ae60'}`, cursor: importing ? 'wait' : 'pointer' }}
      >
        {importing ? 'Converting...' : converted ? 'Re-import' : 'Apply'}
      </button>
      {converted && <AudioImportedStats cache={meta?.audioCache as AudioCacheInfo | undefined} />}
    </>
  );
}

/** Decode the source clip and draw a min/max peak waveform. Best-effort — needs
 *  an AudioContext (present in the editor after the first gesture); silently shows
 *  nothing headless or on a decode error. */
function Waveform({ path }: { path: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const ctx = getAudioContext();
    const canvas = canvasRef.current;
    if (!ctx || !canvas) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(path);
        if (!res.ok) return;
        const buf = await ctx.decodeAudioData(await res.arrayBuffer());
        if (cancelled) return;
        drawPeaks(canvas, buf);
      } catch { /* no waveform — the <audio> element still plays */ }
    })();
    return () => { cancelled = true; };
  }, [path]);

  return (
    <canvas
      ref={canvasRef}
      width={280}
      height={56}
      style={{ width: '100%', height: 56, background: '#1a1a1a', border: '1px solid #333', borderRadius: 3, marginBottom: 4, display: 'block' }}
    />
  );
}

/** Draw a mono min/max peak envelope of the first channel across the canvas width. */
function drawPeaks(canvas: HTMLCanvasElement, buf: AudioBuffer): void {
  const g = canvas.getContext('2d');
  if (!g) return;
  const { width: W, height: H } = canvas;
  const data = buf.getChannelData(0);
  const step = Math.max(1, Math.floor(data.length / W));
  const mid = H / 2;
  g.clearRect(0, 0, W, H);
  g.strokeStyle = '#2ecc71';
  g.lineWidth = 1;
  g.beginPath();
  for (let x = 0; x < W; x++) {
    let min = 1, max = -1;
    const start = x * step;
    for (let i = 0; i < step; i++) {
      const v = data[start + i] ?? 0;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    g.moveTo(x + 0.5, mid + min * mid);
    g.lineTo(x + 0.5, mid + max * mid);
  }
  g.stroke();
}

/** Post-conversion stats read back from the meta sidecar. */
function AudioImportedStats({ cache }: { cache: AudioCacheInfo | undefined }) {
  const rowStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', fontSize: '11px', padding: '1px 0' };
  const labelStyle: React.CSSProperties = { color: '#888' };
  const valStyle: React.CSSProperties = { color: '#ccc' };
  const sectionStyle: React.CSSProperties = { color: '#f1c40f', fontSize: '10px', textTransform: 'uppercase', margin: '10px 0 3px' };

  if (!cache) {
    return <div style={{ color: '#666', fontSize: '10px', marginTop: 4 }}>Converted ✓ — re-import to compute stats</div>;
  }
  return (
    <>
      <div style={sectionStyle}>Imported</div>
      <div style={rowStyle}><span style={labelStyle}>Format</span><span style={valStyle}>{cache.ext}</span></div>
      {cache.durationSec !== undefined && <div style={rowStyle}><span style={labelStyle}>Duration</span><span style={valStyle}>{cache.durationSec.toFixed(2)}s</span></div>}
      {cache.channels !== undefined && <div style={rowStyle}><span style={labelStyle}>Channels</span><span style={valStyle}>{cache.channels === 1 ? 'mono' : cache.channels === 2 ? 'stereo' : cache.channels}</span></div>}
      {cache.sampleRate !== undefined && <div style={rowStyle}><span style={labelStyle}>Sample rate</span><span style={valStyle}>{(cache.sampleRate / 1000).toFixed(1)} kHz</span></div>}
      {cache.bytes !== undefined && (
        <div style={{ ...rowStyle, borderTop: '1px solid #333', marginTop: 2, paddingTop: 3 }}>
          <span style={{ ...labelStyle, color: '#aaa' }}>Size</span><span style={{ ...valStyle, color: '#fff' }}>{formatBytes(cache.bytes)}</span>
        </div>
      )}
    </>
  );
}

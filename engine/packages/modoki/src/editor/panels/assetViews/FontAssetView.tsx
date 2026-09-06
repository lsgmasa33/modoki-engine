/** FontAssetView — MSDF font import settings editor + Apply (bake) action.
 *  Mirrors TextureAssetView: settings persist to the font's `.meta.json` `font`
 *  block on change; Apply runs msdf-atlas-gen (via /api/reimport) and reloads.
 *  The baked mtsdf atlas + Chlumsky metrics are served at `<src>~atlas.png` +
 *  `<src>~metrics.json`; the font is then GUID-referenceable by the Text traits. */

import { useState, useEffect, useCallback, useRef } from 'react';
import { backendFetch } from '../../backend/editorBackend';
import { useEditorStore } from '../../store/editorStore';
import {
  DEFAULT_FONT_SETTINGS, resolveFontSettings, FONT_ATLAS_SUFFIX,
  type FontImportSettings, type FontFieldType, type FontCharsetPreset, type FontMode, type FontCacheInfo,
} from '../../../runtime/core/fontSettings';
import { assetUrl } from '../../../runtime/loaders/assetUrl';
import { inputStyle } from '../fields';
import { DropdownField, formatBytes, reimportBtnStyle, writeMetaOrWarn } from './widgets';
import { withCurrentValue } from './importSettingOptions';
import { commitAxisDraft, applyAxisEdit } from './fontAxisEdit';
import { OUTLINE_MAX_SPREAD } from '../../../runtime/rendering/text/mtsdfStyle';

const CHARSET_OPTIONS: { value: FontCharsetPreset; label: string }[] = [
  { value: 'ascii', label: 'ASCII (printable, 95 glyphs)' },
  { value: 'latin1', label: 'Latin-1 (ASCII + accents)' },
  { value: 'custom', label: 'Custom…' },
];

const MODE_OPTIONS: { value: FontMode; label: string }[] = [
  { value: 'baked', label: 'Baked (fixed atlas only)' },
  { value: 'dynamic', label: 'Dynamic (baked + runtime glyph gen)' },
];

const FIELD_TYPE_OPTIONS: { value: FontFieldType; label: string }[] = [
  { value: 'mtsdf', label: 'MTSDF (4-channel — outline / glow)' },
  { value: 'msdf', label: 'MSDF (3-channel — fill only, smaller)' },
];

const ATLAS_MAX_OPTIONS = [512, 1024, 2048, 4096];
/** Hoisted out of the JSX so `withCurrentValue` can splice an off-list authored value in
 *  without rebuilding the array on every render (it returns the same reference when nothing
 *  needs adding, which an inline literal would defeat). See #131. */
const FONT_SIZES = [32, 40, 48, 64, 96, 128];
/** Distance range options. Reaches well past 8 on purpose: this is the ONLY control over
 *  how thick an outline or how far a shadow can go (both are bands inside the baked
 *  field, budgeted by `pxRange / size`), and capping the list at 8 meant a font baked at
 *  size 128 could never exceed a 0.025 em outline — about 1.5 px on 60 px text, which
 *  reads as a slider that does nothing. Bigger values cost atlas area, which is why the
 *  Effect budget panel states the trade rather than the list hiding it. See #189. */
const FONT_PX_RANGES = [2, 4, 6, 8, 12, 16, 24, 32];

/** One variation axis the SOURCE font exposes, from `/api/font-axes` (its `fvar` table). */
interface FontAxisInfo { tag: string; min: number; def: number; max: number }

/** Human labels for the axis tags actually present in the bundled families. An unknown
 *  tag falls back to its raw 4-char tag, which is what the spec calls it anyway. */
const AXIS_LABELS: Record<string, string> = {
  wght: 'Weight',
  wdth: 'Width',
  slnt: 'Slant',
  ital: 'Italic',
  opsz: 'Optical size',
  CRSV: 'Cursive',
  SHRP: 'Sharpness',
};

export function FontAssetView({ path, name }: { path: string; name: string }) {
  const [meta, setMeta] = useState<Record<string, unknown> | null>(null);
  const [settings, setSettings] = useState<FontImportSettings>(DEFAULT_FONT_SETTINGS);
  const [customChars, setCustomChars] = useState('');
  const [importing, setImporting] = useState(false);
  const [converted, setConverted] = useState(false);
  const [axes, setAxes] = useState<FontAxisInfo[]>([]);
  const refreshAssets = useEditorStore((s) => s.refreshAssets);
  const setImportStatus = useEditorStore((s) => s.setImportStatus);

  const loadMeta = useCallback((signal?: AbortSignal) => {
    return backendFetch(`/api/read-meta?path=${encodeURIComponent(path)}`, signal ? { signal } : undefined)
      .then((r) => (r.ok ? r.json() : {}))
      .then((m: Record<string, unknown>) => {
        setMeta(m);
        const s = resolveFontSettings(m as { font?: Partial<FontImportSettings> });
        setSettings(s);
        setCustomChars(s.customChars ?? '');
        setConverted(!!m.fontCache);
      })
      .catch(() => { /* keep defaults */ });
  }, [path]);

  useEffect(() => {
    const ac = new AbortController();
    loadMeta(ac.signal);
    return () => ac.abort();
  }, [loadMeta]);

  // The axes come from the SOURCE font, not the sidecar — a font is variable or it isn't,
  // and the sidecar only records which instance was CHOSEN. Fetched once per asset.
  useEffect(() => {
    const ac = new AbortController();
    backendFetch(`/api/font-axes?path=${encodeURIComponent(path)}`, { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : { axes: [] }))
      .then((d: { axes?: FontAxisInfo[] }) => setAxes(d.axes ?? []))
      .catch(() => setAxes([]));
    return () => ac.abort();
  }, [path]);

  /** Set one axis, or clear it (undefined) to fall back to the font's own default. An
   *  empty map is deleted entirely so the sidecar does not carry `variationAxes: {}` —
   *  which hashes the same as absent but reads as if something were authored. */
  const setAxis = useCallback((tag: string, value: number | undefined) => {
    setSettings((prev) => {
      const nextAxes = applyAxisEdit(prev.variationAxes, tag, value);
      const next: FontImportSettings = { ...prev };
      if (nextAxes) next.variationAxes = nextAxes;
      else delete next.variationAxes;
      const updatedMeta = { ...(meta ?? {}), font: next };
      setMeta(updatedMeta);
      writeMetaOrWarn(path, updatedMeta);
      return next;
    });
  }, [meta, path]);

  // Persist a settings change to the meta sidecar immediately (discrete controls).
  // Full meta preserved (id/fontCache).
  const update = useCallback((patch: Partial<FontImportSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      const updatedMeta = { ...(meta ?? {}), font: next };
      setMeta(updatedMeta);
      writeMetaOrWarn(path, updatedMeta);
      return next;
    });
  }, [meta, path]);

  // Commit the custom-charset field. Not a naive `onBlur`-only commit (#233, same class
  // as `RenameInput`/`AxisRow` below): Chromium only dispatches focus/blur while
  // `document.hasFocus()`, so in an agent-driven session (window never OS-focused) the
  // old blur-only version never committed at all. Enter now commits DIRECTLY, and the
  // trailing `.blur()` it issues still fires `onBlur` when the window IS focused — which
  // would double-write the sidecar if not guarded: `settings.customChars` is a state
  // closure that has not caught up yet in that same synchronous tick, so comparing
  // against it alone is not enough. `lastCommittedCustomCharsRef` is updated
  // synchronously and closes that gap.
  const lastCommittedCustomCharsRef = useRef<string | null>(null);
  // Clear the latch whenever the value changes from OUTSIDE (undo, another panel, a
  // reselect). It exists only to swallow the trailing blur that Enter fires in the SAME
  // synchronous tick, and that window closes at the next render — held any longer it
  // becomes the very bug this fix removes: re-entering a previously-committed value
  // after an external change would compare equal to the latch and silently do nothing.
  useEffect(() => { lastCommittedCustomCharsRef.current = null; }, [settings.customChars]);
  const commitCustomChars = useCallback((v: string) => {
    if (v !== (settings.customChars ?? '') && v !== lastCommittedCustomCharsRef.current) {
      lastCommittedCustomCharsRef.current = v;
      update({ customChars: v });
    }
  }, [settings.customChars, update]);

  const apply = useCallback(async () => {
    setImporting(true);
    setImportStatus(true, `Baking ${name}...`);
    try {
      const res = await backendFetch('/api/reimport', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      const summary = await res.json().catch(() => ({}));
      if (!res.ok || (summary.errors && summary.errors.length)) {
        console.error('[Inspector] Font bake failed:', summary.errors ?? summary);
      }
      await loadMeta();
      refreshAssets();
    } finally {
      setImporting(false);
      setImportStatus(false);
    }
  }, [path, name, loadMeta, refreshAssets, setImportStatus]);

  const labelStyle: React.CSSProperties = { flex: 1, color: '#888', fontSize: '11px' };
  const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 };
  const sectionStyle: React.CSSProperties = { color: '#f1c40f', fontSize: '10px', textTransform: 'uppercase', margin: '8px 0 3px' };

  return (
    <>
      <div style={{ color: '#ccc', fontSize: 12, marginBottom: 6, wordBreak: 'break-all' }}>{name}</div>

      <div style={sectionStyle}>Atlas</div>
      {/* Field type is BAKED-only. The dynamic path's WASM generator emits MSDF and
          synthesizes alpha as median(RGB), so it cannot honour this — and an unwired
          field is a lie with a tooltip. Shown as a disabled row with the reason rather
          than hidden, so the setting does not appear to vanish when mode flips. */}
      {settings.mode === 'dynamic' ? (
        <div style={rowStyle}>
          <span style={labelStyle}>Field type</span>
          <span style={{ flex: 1, color: '#666', fontSize: 11, fontStyle: 'italic' }}>
            MTSDF-equivalent (runtime generator is MSDF-only)
          </span>
        </div>
      ) : (
        <>
          <div style={rowStyle}>
            <span style={labelStyle}>Field type</span>
            <select data-ui-id="assetView.font.fieldType" data-ui-kind="field" data-ui-label="Field type" value={settings.fieldType} onChange={(e) => update({ fieldType: e.target.value as FontFieldType })} style={{ ...inputStyle, flex: 1 }}>
              {FIELD_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          {/* MSDF is a real option, not a broken one — but only since the shader stopped
              reading the (absent) alpha SDF ungated, which used to turn glow and soft
              shadow into solid rectangles. State what it costs rather than leaving it to
              be discovered. */}
          {settings.fieldType === 'msdf' && (
            <div style={{ color: '#666', fontSize: 10, marginTop: 2 }}>
              No alpha channel, so glow and a SOFT shadow fall back to the median field —
              very slightly softer at concave corners. Fill, outline and a crisp shadow are
              unaffected. Pick MTSDF if the font is for heavily-glowed text.
            </div>
          )}
        </>
      )}
      <div style={rowStyle}>
        <span style={labelStyle}>Glyph size (px/em)</span>
        <select data-ui-id="assetView.font.size" data-ui-kind="field" data-ui-label="Glyph size" value={String(settings.size)} onChange={(e) => update({ size: Number(e.target.value) })} style={{ ...inputStyle, flex: 1 }}>
          {withCurrentValue(FONT_SIZES, settings.size).map((s) => <option key={s} value={s}>{s}{s >= 96 ? ' (sharp corners)' : ''}</option>)}
        </select>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>Distance range (px)</span>
        <select data-ui-id="assetView.font.pxRange" data-ui-kind="field" data-ui-label="Distance range" value={String(settings.pxRange)} onChange={(e) => update({ pxRange: Number(e.target.value) })} style={{ ...inputStyle, flex: 1 }}>
          {withCurrentValue(FONT_PX_RANGES, settings.pxRange).map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {axes.length > 0 && (
        <>
          <div style={sectionStyle}>Variation axes</div>
          {axes.map((a) => (
            <AxisRow
              key={a.tag}
              axis={a}
              value={settings.variationAxes?.[a.tag]}
              onChange={(v) => setAxis(a.tag, v)}
            />
          ))}
          <div style={{ color: '#666', fontSize: 10, marginTop: 2 }}>
            Picks which INSTANCE of this variable font is rasterized — the real typeface
            weight, not <code style={{ color: '#888' }}>Text2D.weight</code> (an SDF edge
            shift). One font asset = one instance: for a second weight, duplicate the font.
            Re-bake to apply.
          </div>
        </>
      )}

      <EffectBudget size={settings.size} pxRange={settings.pxRange} />

      <div style={sectionStyle}>Charset</div>
      <DropdownField
        label="Preset"
        value={settings.charset}
        options={CHARSET_OPTIONS.map((o) => o.value)}
        onChange={(v) => update({ charset: v as FontCharsetPreset })}
      />
      {settings.charset === 'custom' && (
        <div style={rowStyle}>
          <span style={labelStyle}>Characters</span>
          <input
            value={customChars}
            onChange={(e) => setCustomChars(e.target.value)}
            // Reads the DOM node, never the `customChars` state closure: the trailing blur below
            // fires inside the same synchronous stack, where that closure is still pre-Escape.
            onBlur={(e) => commitCustomChars(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { commitCustomChars(e.currentTarget.value); (e.target as HTMLInputElement).blur(); }
          // Escape must revert ORDER-INDEPENDENTLY. `setX(...)` only SCHEDULES a React update, and
          // the `.blur()` on the next line dispatches synchronously in a genuinely focused window —
          // before that flush — so an onBlur that reads state (or a DOM node the revert has not
          // reached) would commit the very text just discarded, then repaint as reverted so it LOOKS
          // like Escape worked. Writing the DOM node first makes the trailing blur see the reverted
          // value and no-op, whichever order they run in. Same shape as SkinEditor's InlineNameField,
          // which is uncontrolled and was always safe for exactly this reason.
              else if (e.key === 'Escape') {
                const persisted = settings.customChars ?? '';
                e.currentTarget.value = persisted;
                setCustomChars(persisted);
                (e.target as HTMLInputElement).blur();
              }
            }}
            placeholder="e.g. 0123ABC…"
            style={{ ...inputStyle, flex: 1 }}
          />
        </div>
      )}

      <div style={sectionStyle}>Mode</div>
      <DropdownField
        label="Glyph source"
        value={settings.mode}
        options={MODE_OPTIONS.map((o) => o.value)}
        onChange={(v) => update({ mode: v as FontMode })}
      />
      <div style={{ color: '#666', fontSize: 10, marginTop: 2 }}>
        {settings.mode === 'dynamic'
          ? 'Baked glyphs render instantly; unseen glyphs (accents, CJK) are generated at runtime.'
          : 'Only the baked charset renders; missing glyphs show a fallback box.'}
      </div>
      {/* atlasMax sizes the RUNTIME dynamic-page atlas only — the baked atlas
          auto-sizes (msdf-atlas-gen `-potr`), so this control is meaningless for a
          baked font and is shown only in dynamic mode. */}
      {settings.mode === 'dynamic' && (
        <>
          <div style={rowStyle}>
            <span style={labelStyle}>Runtime page size (px)</span>
            <select value={String(settings.atlasMax)} onChange={(e) => update({ atlasMax: Number(e.target.value) })} style={{ ...inputStyle, flex: 1 }}>
              {withCurrentValue(ATLAS_MAX_OPTIONS, settings.atlasMax).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div style={{ color: '#666', fontSize: 10, marginTop: 2 }}>
            Size of each runtime-generated glyph page. The baked atlas auto-sizes independently.
          </div>
        </>
      )}

      <button
        data-ui-id="assetView.font.apply" data-ui-kind="button" data-ui-label={converted ? 'Re-bake' : 'Apply'}
        disabled={importing}
        onClick={apply}
        style={{ ...reimportBtnStyle, marginTop: 8, background: importing ? '#555' : '#2ecc71', color: '#fff', border: `1px solid ${importing ? '#444' : '#27ae60'}`, cursor: importing ? 'wait' : 'pointer' }}
      >
        {importing ? 'Baking...' : converted ? 'Re-bake' : 'Apply'}
      </button>
      {converted && <FontImportedStats cache={meta?.fontCache as FontCacheInfo | undefined} />}
      {converted && <FontAtlasPreview path={path} cache={meta?.fontCache as FontCacheInfo | undefined} />}
    </>
  );
}

/** What this font's baked field can actually afford in EFFECTS — stated outright,
 *  because it is otherwise invisible and it is set HERE, by `pxRange` / `size`.
 *
 *  Every effect is a threshold band inside the distance field, so the field's em width
 *  (`pxRange / size`) is a hard budget: at the shipped defaults (8 / 128) the widest
 *  outline is 0.025 em — about 1.5 px on 60 px text, which reads as "the outline slider
 *  does nothing". A drop shadow is an offset sample of the same atlas, so it cannot reach
 *  further than the padding either. Neither limit was discoverable, and raising `pxRange`
 *  is the fix for both. See #189. */
function EffectBudget({ size, pxRange }: { size: number; pxRange: number }) {
  const sectionStyle: React.CSSProperties = { color: '#f1c40f', fontSize: '10px', textTransform: 'uppercase', margin: '10px 0 3px' };
  const rowStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', fontSize: '11px', padding: '1px 0' };
  const em = size > 0 ? pxRange / size : 0;
  const outlineEm = em * OUTLINE_MAX_SPREAD;
  const REF = 60; // a plausible body size, so the em figures land somewhere concrete
  const px = (v: number) => `${(v * REF).toFixed(1)} px`;
  const thin = outlineEm * REF < 2;
  return (
    <>
      <div style={sectionStyle}>Effect budget</div>
      <div style={rowStyle}>
        <span style={{ color: '#888' }}>Max outline</span>
        <span style={{ color: thin ? '#e67e22' : '#ccc' }}>{outlineEm.toFixed(3)} em · {px(outlineEm)} @ {REF}px</span>
      </div>
      <div style={rowStyle}>
        <span style={{ color: '#888' }}>Max shadow offset</span>
        <span style={{ color: '#ccc' }}>{em.toFixed(3)} em · {px(em)} @ {REF}px</span>
      </div>
      <div style={{ color: thin ? '#e67e22' : '#666', fontSize: 10, marginTop: 2 }}>
        {thin
          ? `Distance range ${pxRange} at glyph size ${size} leaves almost no room for effects — an outline at full width is only ${px(outlineEm)}. Raise Distance range (and re-bake) for thicker outlines or larger shadows; it costs atlas area.`
          : `Set by Distance range ÷ glyph size. Outline and shadow are bands inside the baked field, so raising Distance range is what buys thicker effects (at the cost of atlas area).`}
      </div>
    </>
  );
}

/** One variation axis: a slider over the font's REAL range plus a numeric box, and a
 *  "default" affordance that clears the authored value rather than writing the default
 *  as a literal — those are different states, and only the cleared one keeps following
 *  the font if it is ever replaced.
 *
 *  The default is labelled inline because it is the surprising part: it is frequently the
 *  axis MINIMUM, not Regular 400 (Geologica 100/Thin, Nunito 200/ExtraLight), which is why
 *  an unauthored font renders lighter than anyone expects. */
function AxisRow({ axis, value, onChange }: {
  axis: FontAxisInfo;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
}) {
  const authored = value !== undefined;
  const shown = authored ? value : axis.def;
  const label = AXIS_LABELS[axis.tag] ?? axis.tag;
  // Integer-ish axes (wght/wdth/opsz) step by 1; normalized ones (CRSV 0..1) need finer.
  const step = axis.max - axis.min <= 2 ? 0.01 : 1;

  // The number box is UNCONTROLLED while focused, committing on blur/Enter.
  //
  // Clamping every keystroke instead is unusable and not obviously so until you try it:
  // typing "700" into a 100..900 axis clamps "7" up to 100, then "70" to 100, then lands
  // on 900 — the field fights the typist and silently writes a value nobody asked for.
  // (Measured by driving the real input, which is the only thing that catches it.)
  const [draft, setDraft] = useState<string | null>(null);
  const commitDraft = () => {
    const committed = commitAxisDraft(draft, axis);
    setDraft(null);
    if (committed !== undefined) onChange(committed);
  };

  return (
    <div style={{ marginBottom: 5 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ flex: 1, color: authored ? '#ccc' : '#888', fontSize: 11 }}>
          {label} <span style={{ color: '#666' }}>({axis.tag})</span>
        </span>
        <input
          type="number"
          // Addressable for agent/e2e drive-through: the axis controls are otherwise
          // indistinguishable from every other number input in the Inspector.
          data-axis={axis.tag}
          value={draft ?? shown}
          min={axis.min}
          max={axis.max}
          step={step}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { commitDraft(); (e.target as HTMLInputElement).blur(); }
            else if (e.key === 'Escape') { setDraft(null); (e.target as HTMLInputElement).blur(); }
          }}
          style={{ ...inputStyle, width: 62 }}
        />
        <button
          title={authored ? `Clear — follow the font's default (${axis.def})` : `Not authored — using the font's default (${axis.def})`}
          disabled={!authored}
          onClick={() => onChange(undefined)}
          style={{
            background: 'transparent', border: '1px solid #333', borderRadius: 3,
            color: authored ? '#888' : '#444', fontSize: 10, padding: '1px 5px',
            cursor: authored ? 'pointer' : 'default',
          }}
        >clear</button>
      </div>
      <input
        type="range"
        data-axis-slider={axis.tag}
        value={shown}
        min={axis.min}
        max={axis.max}
        step={step}
        onChange={(e) => { setDraft(null); onChange(Number(e.target.value)); }}
        style={{ width: '100%', accentColor: authored ? '#2ecc71' : '#555' }}
      />
      <div style={{ color: '#666', fontSize: 10, marginTop: -2 }}>
        {axis.min}–{axis.max} · default {axis.def}
        {!authored && ' (unauthored)'}
      </div>
    </div>
  );
}

/** The baked mtsdf atlas image (`~atlas.png`), on a dark backing so the alpha
 *  channel doesn't wash it out. It's a 4-channel MTSDF, so the RGB reads as
 *  colorful glyph edges (the multi-channel distance field) — that's expected, not a
 *  bug. Cache-busted by the content hash so a re-bake refreshes the preview. */
function FontAtlasPreview({ path, cache }: { path: string; cache: FontCacheInfo | undefined }) {
  const sectionStyle: React.CSSProperties = { color: '#f1c40f', fontSize: '10px', textTransform: 'uppercase', margin: '10px 0 3px' };
  const url = assetUrl(path + FONT_ATLAS_SUFFIX) + (cache?.hash ? `?v=${cache.hash}` : '');
  return (
    <>
      <div style={sectionStyle}>Atlas preview</div>
      <div style={{
        background: '#0d0d16 url(\'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="8" height="8" fill="%23161622"/><rect x="8" y="8" width="8" height="8" fill="%23161622"/></svg>\')',
        border: '1px solid #333', borderRadius: 3, padding: 4,
      }}>
        <img src={url} alt="MTSDF atlas" style={{ display: 'block', width: '100%', height: 'auto', imageRendering: 'pixelated' }} />
      </div>
      <div style={{ color: '#666', fontSize: 10, marginTop: 2 }}>
        MTSDF — RGB is the multi-channel distance field (colorful edges are normal); alpha is the true SDF.
      </div>
    </>
  );
}

/** Post-bake stats read back from the meta sidecar: atlas dimensions, glyph count,
 *  and atlas PNG size. */
function FontImportedStats({ cache }: { cache: FontCacheInfo | undefined }) {
  const rowStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', fontSize: '11px', padding: '1px 0' };
  const labelStyle: React.CSSProperties = { color: '#888' };
  const valStyle: React.CSSProperties = { color: '#ccc' };
  const sectionStyle: React.CSSProperties = { color: '#f1c40f', fontSize: '10px', textTransform: 'uppercase', margin: '10px 0 3px' };
  if (!cache) return null;
  return (
    <>
      <div style={sectionStyle}>Imported</div>
      {cache.atlasWidth != null && (
        <div style={rowStyle}><span style={labelStyle}>Atlas</span><span style={valStyle}>{cache.atlasWidth} × {cache.atlasHeight}</span></div>
      )}
      {cache.glyphCount != null && (
        <div style={rowStyle}><span style={labelStyle}>Glyphs</span><span style={valStyle}>{cache.glyphCount}</span></div>
      )}
      {cache.bytes != null && (
        <div style={rowStyle}><span style={labelStyle}>Atlas size</span><span style={valStyle}>{formatBytes(cache.bytes)}</span></div>
      )}
    </>
  );
}

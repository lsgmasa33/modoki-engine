/** AtlasAssetView — the `.atlas.json` inspector: edit the member sprite list + pack
 *  options, Re-pack (POST /api/reimport), and preview the generated pages.
 *
 *  The authored fields (members / pageSize / padding / extrude / maxPages) live in the
 *  committed `.atlas.json`; this view reads + writes that file. The DERIVED bookkeeping
 *  (pages + frame map) lives in the atlas's `.meta.json` sidecar and is surfaced through
 *  the live manifest (`getAssetEntry(guid).atlas`) for the page preview + stats — it
 *  refreshes after a Re-pack via the watcher's manifest broadcast. */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  persistAtlasDoc, classifyAtlasLoad, canPersistAtlasDoc,
  DEFAULT_ATLAS_DOC, type AtlasSourceDoc, type AtlasLoadState,
} from './atlasPersist';
import { backendFetch } from '../../backend/editorBackend';
import { useEditorStore } from '../../store/editorStore';
import { getAssetEntry, getGuidForPath, type AtlasCacheBlock } from '../../../runtime/loaders/assetManifest';
import { resolveAtlasPageUrl } from '../../../runtime/loaders/textureResolver';
import { markScene2DDirty } from '../../../runtime/rendering/Scene2D';
import { TEXTURE_MAX_SIZES } from '../../../runtime/loaders/textureSettings';
import { AssetRefField } from '../AssetRefField';
import { inputStyle } from '../fields';
import { reimportBtnStyle } from './widgets';
import { withCurrentValue } from './importSettingOptions';

const DEFAULT_DOC = DEFAULT_ATLAS_DOC;

/** Serialize an edit WITHOUT dropping anything the file already carried.
 *
 *  This view only understands the fields it renders, and it used to write only those — so any
 *  other key in the `.atlas.json` was deleted on the first edit, silently. Measured on
 *  `games/skin-test/…/dark-assassin.atlas.json` (bug `EDnpmBkOOLbeqgDCaQC1`, QA-ASSET-0013): an
 *  add-member/remove-member round-trip that left `members[]` byte-identical still deleted the
 *  whole top-level `texture` block — `{format:'ktx2-uastc', maxSize, mipmaps, wrapS, wrapT,
 *  colorspace}`, the settings that decide how the packed page is actually ENCODED. Nothing
 *  errored and the members list looked right, so only `git diff` could see it.
 *
 *  `raw` is the document as parsed from disk. Spreading it FIRST both preserves the unknown keys
 *  and keeps their original position (object spread takes each key's first-seen order), so an
 *  edit produces a minimal diff instead of a reshuffled file. The trailing newline is restored
 *  for the same reason — its loss was the other half of that diff. */
export function serializeAtlasDoc(raw: Record<string, unknown>, next: AtlasSourceDoc): string {
  const merged: Record<string, unknown> = { ...raw, ...next };
  // `maxPages: undefined` is how the Max-pages field says "unset"; JSON.stringify drops an
  // undefined value, but only if the key is genuinely absent from the object it walks.
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  return `${JSON.stringify(merged, null, 2)}\n`;
}

export function AtlasAssetView({ path, name }: { path: string; name: string }) {
  const [doc, setDoc] = useState<AtlasSourceDoc>(DEFAULT_DOC);
  /** The document exactly as parsed from disk, so a write can carry forward every field this
   *  view does not render. See {@link serializeAtlasDoc}. */
  const rawDoc = useRef<Record<string, unknown>>({});
  /** The path `rawDoc`/`doc` were actually loaded FROM, set only alongside a successful load and
   *  reset to `null` at the top of every (re)load. `update()` compares this against the current
   *  `path` prop rather than trusting `loadState` alone — see `canPersistAtlasDoc`'s header for
   *  why state alone cannot close the A→B selection-change window (review findings 1 + 3). */
  const loadedPath = useRef<string | null>(null);
  /** 'loading' until the fetch below settles, 'failed' on a bad response/network error, 'ok'
   *  once `doc`/`rawDoc` hold a real (or genuinely empty) atlas. Every control that writes is
   *  gated on this — see `update()` and the `disabled=` props below (#430): editing on top of a
   *  load failure used to silently overwrite the real `.atlas.json` with `DEFAULT_DOC`. */
  const [loadState, setLoadState] = useState<AtlasLoadState>('loading');
  const [reloadNonce, setReloadNonce] = useState(0); // bump (Retry) to re-run the load effect
  const [packing, setPacking] = useState(false);
  const [blockVersion, setBlockVersion] = useState(0); // bump to re-read the manifest block
  const refreshAssets = useEditorStore((s) => s.refreshAssets);
  const setImportStatus = useEditorStore((s) => s.setImportStatus);

  const guid = getGuidForPath(path) ?? doc.id;
  const assetsVersion = useEditorStore((s) => s.assetsVersion);
  const block = (guid ? getAssetEntry(guid)?.atlas : undefined) as AtlasCacheBlock | undefined;
  // `assetsVersion`/`blockVersion` are read so the preview recomputes after a re-pack
  // re-registers the atlas entry; reference them to satisfy the deps lint without effect.
  void assetsVersion; void blockVersion;

  // Load the authored `.atlas.json` (served as a normal project asset file).
  useEffect(() => {
    const ac = new AbortController();
    // Drop the previous atlas's document before loading this one — the ref is passthrough data
    // keyed to a specific FILE, and carrying it across a selection change would write one
    // atlas's fields into another's. `doc` gets the same reset (#430): leaving the OLD atlas's
    // `doc` state in place on a path change meant a failed load on the NEW file still showed (and
    // let you edit + overwrite the new file with) the previous atlas's content.
    rawDoc.current = {};
    loadedPath.current = null;
    setDoc(DEFAULT_DOC);
    setLoadState('loading');
    backendFetch(path, { signal: ac.signal })
      .then((r) => (r.ok ? r.json().then((body: unknown) => classifyAtlasLoad({ kind: 'ok', body }))
        : classifyAtlasLoad({ kind: 'httpError' })))
      .catch((err) => {
        if (ac.signal.aborted || (err as { name?: string })?.name === 'AbortError') return null;
        return classifyAtlasLoad({ kind: 'networkError' });
      })
      .then((result) => {
        if (result === null) return; // aborted — a newer load wins
        if (result.loadState === 'failed') { setLoadState('failed'); return; }
        rawDoc.current = result.raw;
        loadedPath.current = path;
        setDoc(result.doc);
        setLoadState('ok');
      });
    return () => ac.abort();
  }, [path, reloadNonce]);

  // Persist a change to the `.atlas.json` (discrete controls — no debounce). Empty
  // member slots are kept while editing; the packer ignores blanks.
  const update = useCallback((patch: Partial<AtlasSourceDoc>) => {
    // A load that hasn't landed (or failed) has no real document to edit onto — writing here
    // would overwrite the real `.atlas.json` with DEFAULT_DOC (#430). Every control that calls
    // `update` is also disabled while !ok, so reaching this is a caller bug, not a normal path.
    // Compares IDENTITY (`loadedPath.current` vs `path`), not just `loadState` — see
    // `canPersistAtlasDoc`'s header for the A→B selection-change window this closes.
    if (!canPersistAtlasDoc(loadState, loadedPath.current, path)) { console.warn('[AtlasAssetView] update() called while no matching load is loaded; ignored'); return; }
    setDoc((prev) => {
      const next = { ...prev, ...patch, version: 1 as const };
      // The write happens OUTSIDE this updater (not chained in-place below) — a setState updater
      // must be pure, and React StrictMode double-invokes it in dev, so writing here issued two
      // disk writes per edit (#308-adjacent, review finding E-3). `next` is still returned so the
      // panel updates optimistically; the write follows once, right after this call.
      return next;
    });
    const next = { ...doc, ...patch, version: 1 as const };
    // Report a write that did not land, instead of discarding the boolean (#308 sweep).
    // The panel updates optimistically either way — same order as persistAssetEdit, which
    // every SIBLING asset view uses; without the failure path that optimism is a LIE: the
    // atlas shows the edited member list while the .atlas.json on disk still holds the old
    // one, and nothing anywhere says so. Not an undo/redo site (this view pushes no undo
    // entry), so it reports through the write-failure reporter rather than reportUndoFailure.
    // The write+report itself lives in atlasPersist.ts (#308 close-out) so it's unit-testable
    // without mounting this component.
    void persistAtlasDoc(path, serializeAtlasDoc(rawDoc.current, next));
  }, [path, loadState, doc]);

  const setMember = (i: number, v: string) => update({ members: doc.members.map((m, j) => (j === i ? v : m)) });
  const addMember = () => update({ members: [...doc.members, ''] });
  const removeMember = (i: number) => update({ members: doc.members.filter((_, j) => j !== i) });

  const repack = useCallback(async () => {
    setPacking(true);
    setImportStatus(true, `Packing ${name}...`);
    try {
      const res = await backendFetch('/api/reimport', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      const summary = await res.json().catch(() => ({}));
      if (!res.ok || (summary.errors && summary.errors.length)) {
        console.error('[AtlasAssetView] pack failed:', summary.errors ?? summary);
      }
      refreshAssets();          // re-scan panel; the watcher broadcast re-registers the block
      setBlockVersion((v) => v + 1);
      markScene2DDirty();       // refresh on-screen packed sprites to the new page
    } finally {
      setPacking(false);
      setImportStatus(false);
    }
  }, [path, name, refreshAssets, setImportStatus]);

  const labelStyle: React.CSSProperties = { flex: 1, color: '#888', fontSize: '11px' };
  const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 };
  const sectionStyle: React.CSSProperties = { color: '#f1c40f', fontSize: '10px', textTransform: 'uppercase', margin: '8px 0 3px' };
  // Not-yet-loaded and failed-to-load both block writes (`update()`'s own guard mirrors this),
  // so every control that writes stays disabled for either — only 'ok' means there is a real
  // document underneath to edit. See `loadState` above (#430).
  const editingDisabled = loadState !== 'ok';
  // One consistent disabled look for every writing control this panel disables — previously each
  // call site rolled its own (or none), so `+ Add member` rendered indistinguishable from an
  // enabled button while doing nothing on click, and the `<select>` fell back to the browser's own
  // 0.7 dimming instead of matching the rest. Explicitly sets `opacity: 1` in the enabled branch so
  // spreading this onto a `<select>` overrides that browser default rather than merely omitting it.
  // Does NOT apply to `assetView.atlas.retry` (the escape hatch, must stay opacity 1 / pointer) or
  // `assetView.atlas.repack` (dims via its own inline style already, kept as-is).
  // Spread LAST over a control's own style. Note the empty object when enabled rather than
  // `{cursor: undefined}`: spreading an explicit `undefined` OVERWRITES the base style's cursor,
  // which silently cost the enabled "+ Add member" button its `pointer` (measured in the running
  // editor — the unit tests cannot see a computed style).
  const disabledStyle: React.CSSProperties = editingDisabled ? { opacity: 0.5, cursor: 'default' } : {};
  const num = (v: number, on: (n: number) => void, min = 0, uiId?: string, uiLabel?: string) => (
    <input data-ui-id={uiId} data-ui-kind="field" data-ui-label={uiLabel} type="number" min={min} value={v} disabled={editingDisabled} onChange={(e) => on(Math.max(min, Number(e.target.value) || 0))} style={{ ...inputStyle, width: 70, ...disabledStyle }} />
  );
  // The load banner shows the FILE's basename, not `name` — `name` is the asset name, which
  // already ends in `.Atlas` (the manifest calls the real one `Dark Assassin.Atlas`), so
  // interpolating it and appending `.atlas.json` doubled the suffix
  // ("Does Not Exist.Atlas.atlas.json"). `path.split('/').pop()` gives the real file
  // ("dark-assassin.atlas.json"); fall back to `name` if that's somehow empty.
  const fileLabel = path.split('/').pop() || name;

  return (
    <>
      {loadState !== 'ok' && (
        <div data-ui-id="assetView.atlas.loadBanner" style={{ color: '#e0a06c', fontSize: '10px', lineHeight: 1.4, marginBottom: 8, padding: '3px 5px', background: '#3a2e1e', border: '1px solid #5a452a', borderRadius: 3, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ flex: 1 }}>
            {loadState === 'loading'
              ? `Loading ${fileLabel}…`
              : `⚠ Could not load ${fileLabel} — editing disabled so it is not overwritten.`}
          </span>
          {/* Kept mounted (not `failed`-only) so a load that HANGS — rather than failing outright,
              e.g. the dev server accepting the socket mid-restart with no timeout set on the
              fetch — is still escapable. Retry itself lands on 'loading', which used to unmount
              this banner and its own button, making a second retry unreachable. */}
          <button data-ui-id="assetView.atlas.retry" data-ui-kind="button" data-ui-label="Retry" onClick={() => setReloadNonce((n) => n + 1)} style={{ ...reimportBtnStyle, width: 'auto', padding: '2px 8px' }}>Retry</button>
        </div>
      )}
      <div style={sectionStyle}>Members ({doc.members.length})</div>
      {doc.members.map((m, i) => (
        <div key={i} style={rowStyle}>
          <div style={{ flex: 1, opacity: editingDisabled ? 0.5 : 1, pointerEvents: editingDisabled ? 'none' : undefined }}>
            <AssetRefField label="" value={m} accept={['sprite']} onChange={(v) => setMember(i, v)} placeholder="drop / pick a sprite" />
          </div>
          <button data-ui-id={`assetView.atlas.member.${i}.remove`} data-ui-kind="button" data-ui-label="Remove" disabled={editingDisabled} onClick={() => removeMember(i)} title="Remove" style={{ ...reimportBtnStyle, width: 24, padding: 0 }}>✕</button>
        </div>
      ))}
      <button data-ui-id="assetView.atlas.addMember" data-ui-kind="button" data-ui-label="Add member" disabled={editingDisabled} onClick={addMember} style={{ ...reimportBtnStyle, marginTop: 2, ...disabledStyle }}>+ Add member</button>

      <div style={sectionStyle}>Pack options</div>
      <div style={rowStyle}>
        <span style={labelStyle}>Page size</span>
        <select data-ui-id="assetView.atlas.pageSize" data-ui-kind="field" data-ui-label="Page size" value={String(doc.pageSize)} disabled={editingDisabled} onChange={(e) => update({ pageSize: Number(e.target.value) })} style={{ ...inputStyle, flex: 1, ...disabledStyle }}>
          {withCurrentValue(TEXTURE_MAX_SIZES, doc.pageSize).map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <div style={rowStyle}><span style={labelStyle}>Padding</span>{num(doc.padding, (n) => update({ padding: n }), 0, 'assetView.atlas.padding', 'Padding')}</div>
      <div style={rowStyle}><span style={labelStyle}>Extrude (bleed)</span>{num(doc.extrude, (n) => update({ extrude: n }), 0, 'assetView.atlas.extrude', 'Extrude')}</div>
      <div style={rowStyle}>
        <span style={labelStyle}>Max pages</span>
        {num(doc.maxPages ?? 0, (n) => update(n > 0 ? { maxPages: n } : { maxPages: undefined }), 0, 'assetView.atlas.maxPages', 'Max pages')}
      </div>

      <button
        data-ui-id="assetView.atlas.repack" data-ui-kind="button" data-ui-label={block ? 'Re-pack' : 'Pack'}
        disabled={packing || editingDisabled}
        onClick={repack}
        // A solid green fill renders identically enabled or disabled, unlike every other
        // control in this panel (the member rows dim to opacity 0.5; disabled `<select>`
        // inputs pick up the browser's own dimming) — dim the same way here so a disabled
        // Pack/Re-pack doesn't look clickable while doing nothing (#430).
        style={{ ...reimportBtnStyle, marginTop: 8, background: packing ? '#555' : '#2ecc71', color: '#fff', border: `1px solid ${packing ? '#444' : '#27ae60'}`, cursor: packing ? 'wait' : editingDisabled ? 'default' : 'pointer', opacity: editingDisabled ? 0.5 : 1 }}
      >
        {packing ? 'Packing...' : block ? 'Re-pack' : 'Pack'}
      </button>

      {block && <AtlasPagePreview guid={guid!} block={block} />}
    </>
  );
}

/** Page-count + per-page thumbnails read from the built manifest block. */
function AtlasPagePreview({ guid, block }: { guid: string; block: AtlasCacheBlock }) {
  const sectionStyle: React.CSSProperties = { color: '#f1c40f', fontSize: '10px', textTransform: 'uppercase', margin: '10px 0 3px' };
  const memberCount = Object.keys(block.frames).length;
  return (
    <>
      <div style={sectionStyle}>Pages ({block.pages.length}) · {memberCount} packed</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {block.pages.map((pg, p) => {
          const url = resolveAtlasPageUrl({ atlasGuid: guid, page: p, rect: { x: 0, y: 0, w: pg.w, h: pg.h }, pivot: { x: 0, y: 0 }, pageW: pg.w, pageH: pg.h, texture: block.texture, hash: pg.hash }, '2d');
          return (
            <div key={p} style={{ width: 132, fontSize: 10, color: '#888' }}>
              {url
                ? <img src={url} alt={`page ${p}`} style={{ width: 132, height: 132, objectFit: 'contain', background: '#1a1a1a', border: '1px solid #333', imageRendering: 'pixelated' }} />
                : <div style={{ width: 132, height: 132, background: '#1a1a1a', border: '1px solid #333' }} />}
              <div>page {p} — {pg.w}×{pg.h}</div>
            </div>
          );
        })}
      </div>
    </>
  );
}

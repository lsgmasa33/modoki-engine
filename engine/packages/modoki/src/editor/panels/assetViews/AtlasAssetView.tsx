/** AtlasAssetView — the `.atlas.json` inspector: edit the member sprite list + pack
 *  options, Re-pack (POST /api/reimport), and preview the generated pages.
 *
 *  The authored fields (members / pageSize / padding / extrude / maxPages) live in the
 *  committed `.atlas.json`; this view reads + writes that file. The DERIVED bookkeeping
 *  (pages + frame map) lives in the atlas's `.meta.json` sidecar and is surfaced through
 *  the live manifest (`getAssetEntry(guid).atlas`) for the page preview + stats — it
 *  refreshes after a Re-pack via the watcher's manifest broadcast. */

import { useState, useEffect, useCallback, useRef } from 'react';
import { persistAtlasDoc } from './atlasPersist';
import { backendFetch } from '../../backend/editorBackend';
import { useEditorStore } from '../../store/editorStore';
import { getAssetEntry, getGuidForPath, type AtlasCacheBlock } from '../../../runtime/loaders/assetManifest';
import { defaultAtlasSource } from '../../../runtime/loaders/spriteAtlas';
import { resolveAtlasPageUrl } from '../../../runtime/loaders/textureResolver';
import { markScene2DDirty } from '../../../runtime/rendering/Scene2D';
import { TEXTURE_MAX_SIZES } from '../../../runtime/loaders/textureSettings';
import { AssetRefField } from '../AssetRefField';
import { inputStyle } from '../fields';
import { reimportBtnStyle } from './widgets';
import { withCurrentValue } from './importSettingOptions';

interface AtlasSourceDoc {
  id?: string;
  version?: number;
  members: string[];
  pageSize: number;
  padding: number;
  extrude: number;
  maxPages?: number;
}

const DEFAULT_DOC: AtlasSourceDoc = defaultAtlasSource();

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
    // atlas's fields into another's.
    rawDoc.current = {};
    backendFetch(path, { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Partial<AtlasSourceDoc> | null) => {
        if (!d) return;
        rawDoc.current = d as Record<string, unknown>;
        setDoc({
          id: d.id, version: d.version,
          members: Array.isArray(d.members) ? d.members.filter((m): m is string => typeof m === 'string') : [],
          pageSize: typeof d.pageSize === 'number' ? d.pageSize : DEFAULT_DOC.pageSize,
          padding: typeof d.padding === 'number' ? d.padding : DEFAULT_DOC.padding,
          extrude: typeof d.extrude === 'number' ? d.extrude : DEFAULT_DOC.extrude,
          ...(typeof d.maxPages === 'number' ? { maxPages: d.maxPages } : {}),
        });
      })
      .catch(() => { /* keep defaults */ });
    return () => ac.abort();
  }, [path]);

  // Persist a change to the `.atlas.json` (discrete controls — no debounce). Empty
  // member slots are kept while editing; the packer ignores blanks.
  const update = useCallback((patch: Partial<AtlasSourceDoc>) => {
    setDoc((prev) => {
      const next = { ...prev, ...patch, version: 1 as const };
      // Report a write that did not land, instead of discarding the boolean (#308 sweep).
      // The panel updates optimistically either way — same order as persistAssetEdit, which
      // every SIBLING asset view uses; without the failure path that optimism is a LIE: the
      // atlas shows the edited member list while the .atlas.json on disk still holds the old
      // one, and nothing anywhere says so. Not an undo/redo site (this view pushes no undo
      // entry), so it reports through the write-failure reporter rather than reportUndoFailure.
      // The write+report itself lives in atlasPersist.ts (#308 close-out) so it's unit-testable
      // without mounting this component.
      void persistAtlasDoc(path, serializeAtlasDoc(rawDoc.current, next));
      return next;
    });
  }, [path]);

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
  const num = (v: number, on: (n: number) => void, min = 0, uiId?: string, uiLabel?: string) => (
    <input data-ui-id={uiId} data-ui-kind="field" data-ui-label={uiLabel} type="number" min={min} value={v} onChange={(e) => on(Math.max(min, Number(e.target.value) || 0))} style={{ ...inputStyle, width: 70 }} />
  );

  return (
    <>
      <div style={sectionStyle}>Members ({doc.members.length})</div>
      {doc.members.map((m, i) => (
        <div key={i} style={rowStyle}>
          <div style={{ flex: 1 }}>
            <AssetRefField label="" value={m} accept={['sprite']} onChange={(v) => setMember(i, v)} placeholder="drop / pick a sprite" />
          </div>
          <button data-ui-id={`assetView.atlas.member.${i}.remove`} data-ui-kind="button" data-ui-label="Remove" onClick={() => removeMember(i)} title="Remove" style={{ ...reimportBtnStyle, width: 24, padding: 0 }}>✕</button>
        </div>
      ))}
      <button data-ui-id="assetView.atlas.addMember" data-ui-kind="button" data-ui-label="Add member" onClick={addMember} style={{ ...reimportBtnStyle, marginTop: 2 }}>+ Add member</button>

      <div style={sectionStyle}>Pack options</div>
      <div style={rowStyle}>
        <span style={labelStyle}>Page size</span>
        <select data-ui-id="assetView.atlas.pageSize" data-ui-kind="field" data-ui-label="Page size" value={String(doc.pageSize)} onChange={(e) => update({ pageSize: Number(e.target.value) })} style={{ ...inputStyle, flex: 1 }}>
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
        disabled={packing}
        onClick={repack}
        style={{ ...reimportBtnStyle, marginTop: 8, background: packing ? '#555' : '#2ecc71', color: '#fff', border: `1px solid ${packing ? '#444' : '#27ae60'}`, cursor: packing ? 'wait' : 'pointer' }}
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

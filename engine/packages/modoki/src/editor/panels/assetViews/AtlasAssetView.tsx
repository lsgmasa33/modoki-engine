/** AtlasAssetView — the `.atlas.json` inspector: edit the member sprite list + pack
 *  options, Re-pack (POST /api/reimport), and preview the generated pages.
 *
 *  The authored fields (members / pageSize / padding / extrude / maxPages) live in the
 *  committed `.atlas.json`; this view reads + writes that file. The DERIVED bookkeeping
 *  (pages + frame map) lives in the atlas's `.meta.json` sidecar and is surfaced through
 *  the live manifest (`getAssetEntry(guid).atlas`) for the page preview + stats — it
 *  refreshes after a Re-pack via the watcher's manifest broadcast. */

import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from 'react';
import {
  classifyAtlasLoad, canPersistAtlasDoc, buildNextAtlasDoc, normalizeAtlasBody,
  DEFAULT_ATLAS_DOC, type AtlasSourceDoc, type AtlasLoadState,
} from './atlasPersist';
import { persistAssetEdit, invalidateAtlasFile, useAssetViewRefresher } from './persist';
import { pendingAssetDoc } from '../pendingAssetDoc';
import {
  subscribeDirtyAssets, getDirtyAssetsVersion, getAssetFlushError, getLastFlushedAssetHash,
  peekDirtyAsset, clearAssetIfMatch, discardDirtyAssets, forgetFlushedAssetHash,
} from '../../scene/dirtyAssets';
import { sha256Hex } from '../../utils/contentHash';
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
 *  edit produces a minimal diff instead of a reshuffled file.
 *
 *  ⚠️ Returns the OBJECT to park, not bytes (#831). It used to return
 *  `JSON.stringify(merged, null, 2) + '\n'` and POST that string; the bytes are now the server's
 *  to produce, through `assetJsonBytes` — the ONE definition of them, which two self-write
 *  fingerprints also hash. A client that re-serialises here would be a second copy of that
 *  format, and the trailing newline this used to restore by hand is exactly what drifted last
 *  time. `maxPages: undefined` (how the Max-pages field says "unset") is deleted rather than left
 *  in place, so the key genuinely leaves the document instead of relying on `JSON.stringify`
 *  dropping it — `/api/asset-write`'s dropped-field guard reads `Object.keys`, not the JSON. */
export function buildAtlasDocToPark(raw: Record<string, unknown>, next: AtlasSourceDoc): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...raw, ...next };
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  return merged;
}

export function AtlasAssetView({ path, name }: { path: string; name: string }) {
  const [doc, setDoc] = useState<AtlasSourceDoc>(DEFAULT_DOC);
  /** `doc`, readable synchronously. `update()` builds the document it PARKS from this rather than
   *  from the render-time `doc`, so two edits landing before React re-renders compose instead of
   *  the second silently discarding the first. The optimistic `setDoc` beside it already used the
   *  functional form for exactly this reason; the parked document has to agree with it, and since
   *  #831 that document is also what the panel is re-seeded FROM (see the refresher below), so a
   *  stale read here would be visible on screen and not only on disk. */
  const docRef = useRef(doc);
  docRef.current = doc;
  /** The document exactly as parsed from disk (or as parked), so an edit can carry forward every
   *  field this view does not render. See {@link buildAtlasDocToPark}. */
  const rawDoc = useRef<Record<string, unknown>>({});
  /** The path `rawDoc`/`doc` were actually loaded FROM, set only alongside a successful load and
   *  reset to `null` at the top of every (re)load. `update()` compares this against the current
   *  `path` prop rather than trusting `loadState` alone — see `canPersistAtlasDoc`'s header for
   *  why state alone cannot close the A→B selection-change window (review findings 1 + 3). */
  const loadedPath = useRef<string | null>(null);
  /** The sha256 of the file's bytes as this panel last agreed with them — parked alongside every
   *  edit as `DirtyAsset.ifMatch`, and applied by the flush as a write precondition (#439).
   *
   *  The panel serializes the WHOLE document, so writing on top of a document that changed
   *  underneath — a `git checkout` under a live editor, CLAUDE.md's documented hazard — silently
   *  reverts whatever changed. Nothing notifies this panel of a same-path content change:
   *  `assetsVersion` is keyed on the asset PATH SET (assetSetSignature.ts), and `atlas` is not a
   *  `SceneChangedKind`, so `dropParkedWriteFor` never fires for it either. The check therefore
   *  has to sit on the WRITE.
   *
   *  Seeded at load from the fetched text, re-seeded after a save from `getLastFlushedAssetHash`
   *  (the server's hash of what it actually wrote — this panel cannot compute those bytes), and
   *  adopted from the parked entry when the panel opens onto an already-parked edit. `null` means
   *  no baseline: the park then carries no precondition, which is the same unconditional write
   *  every other asset view does. */
  const baselineHash = useRef<string | null>(null);
  /** 'loading' until the fetch below settles, 'failed' on a bad response/network error, 'ok'
   *  once `doc`/`rawDoc` hold a real (or genuinely empty) atlas. Every control that writes is
   *  gated on this — see `update()` and the `disabled=` props below (#430): editing on top of a
   *  load failure used to silently overwrite the real `.atlas.json` with `DEFAULT_DOC`. */
  const [loadState, setLoadState] = useState<AtlasLoadState>('loading');
  /** Set alongside `loadState === 'refused'` — the human-readable reason a too-new/unreadable
   *  format version was refused, surfaced in the banner instead of the generic load-failure text. */
  const [refusalMessage, setRefusalMessage] = useState('');
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
  // Re-render whenever the dirty-asset registry moves, so the save outcome for THIS path is
  // visible here. Since #831 the write happens at Cmd+S, in `flushDirtyAssets` — the panel is not
  // the caller any more and cannot see the response, so a compare-and-swap conflict would
  // otherwise be invisible exactly where the human is looking.
  useSyncExternalStore(subscribeDirtyAssets, getDirtyAssetsVersion, getDirtyAssetsVersion);
  const flushError = getAssetFlushError(path);
  // The saved baseline moved on when the file did: adopt what the flush actually wrote, so the
  // NEXT edit parks a precondition the server can still match. Without this every save after the
  // first would 409 against the text this panel loaded, with no way out.
  //
  // ⚠️ This used to be gated on nothing being parked, and that gate was itself a bug. An edit made
  // WHILE a flush is in flight re-parks — so the gate held the panel's ref at the pre-flush hash,
  // and the very next keystroke parked that stale value again (an explicitly-passed `ifMatch` wins
  // over the entry's), undoing the flush's own advance of that entry. The gate is gone because the
  // record is now cleared wherever it stops describing the file — a discard, a panel write, and
  // this panel's own re-read below — so anything still recorded here IS what disk holds.
  const flushedHash = getLastFlushedAssetHash(path);
  if (flushedHash && loadedPath.current === path) baselineHash.current = flushedHash;

  // An agent's `modoki_write_asset {type:'atlas'}` parks a doc this panel must show — the same
  // contract every other asset view has through `persistAssetEdit`'s refresher. Without it the
  // panel keeps rendering the pre-agent document AND, on the next control interaction, parks that
  // stale document straight over the agent's.
  useAssetViewRefresher(path, useCallback((updated: Record<string, unknown>) => {
    rawDoc.current = updated;
    const normalized = normalizeAtlasBody(updated);
    docRef.current = normalized;
    setDoc(normalized);
  }, []));

  // Load the authored `.atlas.json` (served as a normal project asset file). Fetches as text
  // (rather than `.json()`) so the exact bytes can be hashed into `baselineHash` — the write
  // path's compare-and-swap baseline (#439) — even though this effect itself only needs the
  // parsed doc.
  useEffect(() => {
    const ac = new AbortController();
    // Drop the previous atlas's document before loading this one — the ref is passthrough data
    // keyed to a specific FILE, and carrying it across a selection change would write one
    // atlas's fields into another's. `doc` gets the same reset (#430): leaving the OLD atlas's
    // `doc` state in place on a path change meant a failed load on the NEW file still showed (and
    // let you edit + overwrite the new file with) the previous atlas's content.
    rawDoc.current = {};
    loadedPath.current = null;
    baselineHash.current = null;
    setDoc(DEFAULT_DOC);
    setLoadState('loading');
    setRefusalMessage('');
    // ⚠️ ASK THE REGISTRY BEFORE THE FILE. Since #831 an edit here is PARKED, so between the edit
    // and Cmd+S the file on disk still holds the PRE-edit document — fetching it would re-seed
    // this panel with the older doc while the newer one is still queued to be written, which is
    // the QA-CTX-0008 / EhE6JQkHRYttDGeGmtPK shape `pendingAssetDoc` exists to prevent. The
    // baseline comes from the parked entry too: it is the hash of what disk held when this edit
    // was first parked, and re-hashing the current file would silently re-arm the CAS against
    // content nobody has looked at.
    const parked = pendingAssetDoc(path, 'atlas') as Record<string, unknown> | null;
    if (parked) {
      rawDoc.current = parked;
      loadedPath.current = path;
      baselineHash.current = peekDirtyAsset(path)?.ifMatch ?? null;
      setDoc(normalizeAtlasBody(parked));
      setLoadState('ok');
      return () => ac.abort();
    }
    let fetchedText: string | null = null;
    backendFetch(path, { signal: ac.signal })
      .then((r) => (r.ok ? r.text().then((text) => {
        fetchedText = text;
        let body: unknown;
        try { body = JSON.parse(text); } catch { return classifyAtlasLoad({ kind: 'networkError' }); }
        return classifyAtlasLoad({ kind: 'ok', body });
      }) : classifyAtlasLoad({ kind: 'httpError' })))
      .catch((err) => {
        if (ac.signal.aborted || (err as { name?: string })?.name === 'AbortError') return null;
        return classifyAtlasLoad({ kind: 'networkError' });
      })
      .then(async (result) => {
        if (result === null) return; // aborted — a newer load wins
        if (result.loadState === 'failed') { setLoadState('failed'); return; }
        if (result.loadState === 'refused') { setLoadState('refused'); setRefusalMessage(result.message); return; }
        // Hash BEFORE publishing the load, so `loadedPath`/`loadState` never say "editable" while
        // `baselineHash` is still null — `update()` would then park with no precondition and the
        // compare-and-swap would be silently off for exactly one edit. `sha256Hex` can reject
        // outright (`crypto.subtle` is undefined in a non-secure context), which must NOT read as
        // "no baseline needed": refuse the load instead, the same way a too-new version does.
        let hash: string;
        try {
          hash = await sha256Hex(fetchedText ?? '');
        } catch (e) {
          console.error('[AtlasAssetView] could not hash the loaded atlas — editing disabled so a write cannot land unguarded:', e);
          setLoadState('refused');
          setRefusalMessage('this build cannot compute a content hash here (crypto.subtle is unavailable), so an edit could not be protected against a change on disk');
          return;
        }
        if (ac.signal.aborted) return; // a newer load won while we were hashing
        rawDoc.current = result.raw;
        loadedPath.current = path;
        baselineHash.current = hash;
        // This read IS the truth about the file, so whatever an earlier flush recorded for this
        // path is obsolete — and the re-seed above would otherwise put it straight back. Reachable
        // with nothing parked and no discard in sight: save the atlas, `git checkout` the file,
        // press Retry. See `forgetFlushedAssetHash`.
        forgetFlushedAssetHash(path);
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
    // `buildNextAtlasDoc` deliberately adds NO `version:` key — see its own header (#784, § 2b)
    // for the clobber this used to be (`{ ...prev, ...patch, version: 1 as const }`).
    setDoc((prev) => {
      const next = buildNextAtlasDoc(prev, patch);
      // The write happens OUTSIDE this updater (not chained in-place below) — a setState updater
      // must be pure, and React StrictMode double-invokes it in dev, so writing here issued two
      // disk writes per edit (#308-adjacent, review finding E-3). `next` is still returned so the
      // panel updates optimistically; the write follows once, right after this call.
      return next;
    });
    const next = buildNextAtlasDoc(docRef.current, patch);
    // PARK, don't write (#831). This used to POST the whole document on every control
    // interaction — a keystroke in Padding, an add or remove of a member — so a committed
    // `.atlas.json` was rewritten behind the human's back while `get_editor_state` reported
    // `persistenceMode: 'manual'`. Now it queues in the dirty-asset registry with every other
    // asset edit and Cmd+S is the write.
    //
    // `baselineHash` rides along as the compare-and-swap precondition (#439). The panel parks the
    // WHOLE document, so a save landing on top of a file that changed underneath — a `git
    // checkout` under a live editor — would silently revert whatever changed; `/api/asset-write`
    // refuses that write instead. Note this is not a weaker guard than the old per-keystroke one:
    // the baseline is the same, but it is now checked against a file that has had longer to move.
    //
    // `buildAtlasDocToPark` re-merges from `rawDoc` every time, which is what keeps the unknown
    // keys this view does not render (`texture`, chiefly — QA-ASSET-0013) alive across every edit.
    // ⚠️ `rawDoc` IS advanced by this call, through the refresher above — `persistAssetEdit` calls
    // the setter registered for this path, which is this panel's own. Harmless (the merged doc is
    // a superset of what it replaces), and said out loud because an earlier draft of this comment
    // claimed the opposite and would have sent the next reader hunting a bug that is not there.
    persistAssetEdit(path, 'atlas', buildAtlasDocToPark(rawDoc.current, next), invalidateAtlasFile, baselineHash.current ?? undefined);
  }, [path, loadState]);

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
      {(loadState !== 'ok' || flushError) && (
        <div data-ui-id="assetView.atlas.loadBanner" style={{ color: '#e0a06c', fontSize: '10px', lineHeight: 1.4, marginBottom: 8, padding: '3px 5px', background: '#3a2e1e', border: '1px solid #5a452a', borderRadius: 3, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ flex: 1 }}>
            {/* ⚠️ The wording changed with #831 and the change is the point. This used to read
                "your edit was not applied. Reloaded from disk." — true then, because the write
                fired per keystroke and the panel reloaded itself. Now the edits are PARKED and
                still here: nothing was discarded, and nothing will be until the human says so. A
                banner that says "reloaded" over unsaved work in memory is the lie that gets it
                thrown away. */}
            {flushError
              ? (flushError.conflict
                ? `⚠ ${fileLabel} changed on disk since you opened it, so Save did NOT write it. Your edits are still here and still unsaved — pick one below.`
                // No "try saving again": a 409 from the format-version or drop-key guard refuses
                // the SAME bytes every time, so that advice is a loop. The server's own message
                // carries the remedy; repeat it and stop.
                : `⚠ Save FAILED for ${fileLabel} — ${flushError.error} Your edits are still here and still unsaved.`)
              : loadState === 'loading'
                ? `Loading ${fileLabel}…`
                : loadState === 'refused'
                  // Distinct from the generic load-failure text below: this file parsed FINE, but
                  // ${refusalMessage} means it was written by a build newer than this one — "Retry"
                  // re-reads the same file and will refuse it again until either the file or this
                  // build changes. A network hiccup deserves "try again"; this deserves "update".
                  ? `⚠ Cannot open ${fileLabel} — ${refusalMessage}. Editing is disabled; update to a build that supports it, or re-save this atlas from the build that wrote it.`
                  : `⚠ Could not load ${fileLabel} — editing disabled so it is not overwritten.`}
          </span>
          {/* A conflict is the one state with no way out of its own accord: every save will 409
              against the same baseline until either the parked edits go or the precondition does.
              Both exits are the HUMAN's to choose — the compare-and-swap exists to stop a SILENT
              overwrite, not to stop a deliberate one — so both are offered, and neither happens
              on the panel's own judgement. */}
          {flushError?.conflict ? (
            <>
              <button
                data-ui-id="assetView.atlas.discardAndReload" data-ui-kind="button" data-ui-label="Discard and reload"
                title="Throw away your unsaved atlas edits and re-read the file as it now is on disk"
                onClick={() => { discardDirtyAssets([path]); setReloadNonce((n) => n + 1); }}
                style={{ ...reimportBtnStyle, width: 'auto', padding: '2px 8px' }}
              >Discard &amp; reload</button>
              <button
                data-ui-id="assetView.atlas.overwrite" data-ui-kind="button" data-ui-label="Overwrite on save"
                title="Keep your edits and let the next Save overwrite whatever changed on disk"
                onClick={() => clearAssetIfMatch(path)}
                style={{ ...reimportBtnStyle, width: 'auto', padding: '2px 8px' }}
              >Overwrite on save</button>
            </>
          ) : (
            /* Kept mounted (not `failed`-only) so a load that HANGS — rather than failing outright,
               e.g. the dev server accepting the socket mid-restart with no timeout set on the
               fetch — is still escapable. Retry itself lands on 'loading', which used to unmount
               this banner and its own button, making a second retry unreachable. */
            <button data-ui-id="assetView.atlas.retry" data-ui-kind="button" data-ui-label="Retry" onClick={() => setReloadNonce((n) => n + 1)} style={{ ...reimportBtnStyle, width: 'auto', padding: '2px 8px' }}>Retry</button>
          )}
        </div>
      )}
      <div style={sectionStyle}>Members ({doc.members.length})</div>
      {doc.members.map((m, i) => (
        <div key={i} style={rowStyle}>
          <div style={{ flex: 1, opacity: editingDisabled ? 0.5 : 1, pointerEvents: editingDisabled ? 'none' : undefined }}>
            <AssetRefField label="" value={m} accept={['sprite']} onChange={(v) => setMember(i, v)} placeholder="drop / pick a sprite"
              dataUiId={`assetView.atlas.member.${i}.sprite`} dataUiLabel={`member ${i}`} />
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

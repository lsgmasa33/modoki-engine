/** ModelBatchView — multi-select editor for N model (.glb) assets. Batch-sets the
 *  postprocessor across the selection (differing values show "Mixed") and offers a
 *  single "Re-import all (N)".
 *
 *  ⚠️ A member whose sidecar could not be read is EXCLUDED from the batch — absent from `metas`,
 *  named in the banner (#903). `parkMetaEdit` refuses a document built on a failed read, and this
 *  view used to set the row's value anyway and let the refusal vanish into the console. The
 *  decision lives in `metaBatchLoad.ts`.
 *
 *  ⚠️ Meta writes here are READ-MODIFY-WRITE, and must stay that way. `/api/write-meta`
 *  REPLACES the sidecar (`writeMetaSidecar` → `writeJsonAtomic`, no merge), so posting a bare
 *  `{version, postprocessor}` destroyed everything else in it — including the asset's stable
 *  `id`. See the note on the single-asset path in `Inspector.tsx`. */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useEditorStore } from '../../store/editorStore';
import { getModelPostprocessorIds } from '../../../runtime/loaders/modelPostprocessorRegistry';
import { inputStyle, MIXED_PLACEHOLDER } from '../fields';
import { reimportBtnStyle } from './widgets';
import { reimportPaths } from './reimport';
import { readMetaPreferringPark } from '../../scene/pendingMeta';
import { loadMetaBatch, planMetaBatchWrite, parkPlannedMetaEdits, type MetaMap, type UnreadableMeta } from './metaBatchLoad';
import { AssetLoadRefusedBanner } from '../AssetLoadRefusedBanner';
import type { SelectedAsset } from '../../store/editorStore';
import { useMetaDirty } from '../useMetaDirty';
import { UnsavedMetaBadge } from './UnsavedMetaBadge';

export function ModelBatchView({ assets }: { assets: SelectedAsset[] }) {
  // ⚠️ MEMOISED, and this is a fix rather than a tidy-up. `assets.map(...)` is a fresh array every
  // render, so `loadAll`'s `useCallback([paths])` identity churned, and `useEffect(…, [loadAll])`
  // re-fired after every completed load — a self-sustaining re-fetch loop that predates this branch
  // (confirmed at f2f67a74e). It was survivable while the loop was silent; #903 made each pass emit
  // a per-excluded-member `console.error`, which turns it into an endless log. Keyed on the joined
  // paths so a selection that is equal but newly-allocated does not restart it.
  const pathKey = assets.map((a) => a.path).join('\0');
  const paths = useMemo(() => pathKey.split('\0').filter(Boolean), [pathKey]);
  // #870: a parked import-settings edit was invisible in the panel that MADE it. ALL the selected
  // paths, not the first — a batch view parks N sidecars and "any of mine is unsaved" is the only
  // honest claim it can make.
  const metaDirty = useMetaDirty(paths);
  const [postprocessors, setPostprocessors] = useState<Record<string, string>>({});
  // The FULL sidecar per path, kept so a postprocessor change can merge into it instead of
  // replacing it. Without this the batch destroyed one guid per selected model, per click.
  const [metas, setMetas] = useState<MetaMap>({});
  /** Members of the selection an edit CANNOT reach — excluded from `metas` rather than represented
   *  by a tagged fallback, so no row can show an edit that Cmd+S will not write (#903). */
  const [unreadable, setUnreadable] = useState<UnreadableMeta[]>([]);
  /** The selection `metas`/`unreadable` were loaded FOR, or null while a load is outstanding.
   *
   *  ⚠️ A plain `loaded` boolean is wrong for one committed frame on every selection change: React
   *  renders with the NEW `paths` and the OLD state before the effect runs, and in that frame
   *  `loaded` is still true — so `editable` is empty and the panel rendered the PREVIOUS selection's
   *  banner, naming paths that are no longer selected ("2 of 3 selected could not be read"). The
   *  epoch guard cannot help: that stale data is already committed to state. Comparing the key the
   *  state was loaded for against the current one closes the window by construction. */
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const postprocessorIds = getModelPostprocessorIds();
  const setImportStatus = useEditorStore((s) => s.setImportStatus);
  const refreshAssets = useEditorStore((s) => s.refreshAssets);

  /** Bumped by every load; a stale resolution is dropped. `unreadable` is rendered RAW (not
   *  path-keyed), so a superseded load could otherwise name paths no longer selected and print
   *  "2 of 1 selected models". Same reasoning as `MaterialBatchView`'s. */
  const loadEpoch = useRef(0);

  const loadAll = useCallback(async () => {
    const epoch = ++loadEpoch.current;
    const key = paths.join('\0');
    setLoadedFor(null);
    // #845: ASK THE REGISTRY BEFORE THE FILE, per path — see TextureBatchView's `loadAll` for why.
    // `reimportAll` flushes every path before it reimports, so nothing is parked here after one.
    //
    // ⚠️ The `catch` that substituted `metaReadFallback()` is gone, and its absence is the #903 fix.
    // It was worse here than on the texture side: `applyPostprocessor` parks EVERY selected path
    // per click, and a model's sidecar carries `generated`/`rig` as well as the guid — so a
    // present-but-unwritable member showed the new postprocessor and wrote none of it.
    const { metas: next, unreadable: bad } = await loadMetaBatch(paths, { readMeta: readMetaPreferringPark });
    if (epoch !== loadEpoch.current) return; // a newer load won while this one was in flight
    setPostprocessors(Object.fromEntries(Object.keys(next).map((p) => [p, (next[p].postprocessor as string) ?? 'none'])));
    setMetas(next);
    setUnreadable(bad);
    for (const { path, message } of bad) {
      console.error(`[ModelBatchView] excluding ${path} from this batch — ${message}. A batch edit will not write to it.`);
    }
    setLoadedFor(key);
  }, [paths]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // ⚠️ EDITABLE members only. An excluded path used to contribute its 'none' default here, so one
  // unreadable member could make a uniform selection read "Mixed" and invite the human to fix a
  // divergence that does not exist. The banner names it instead.
  const editable = paths.filter((p) => metas[p]);
  const values = editable.map((p) => postprocessors[p] ?? 'none');
  const mixed = values.length > 0 && !values.every((v) => v === values[0]);
  const common = mixed ? '' : (values[0] ?? 'none');

  const applyPostprocessor = useCallback((next: string) => {
    // MERGE — a bare {version, postprocessor} would replace the whole sidecar. Parked, not written
    // immediately (#845) — Cmd+S is the write. `planMetaBatchWrite` reaches only the members an
    // edit can reach, so the `?? {}` that used to sit here — which turned an absent member into an
    // untagged empty document — has nothing left to guard against (#903).
    const plan = planMetaBatchWrite(paths, metas, (m) => ({ ...m, postprocessor: next }));
    parkPlannedMetaEdits(plan, 'ModelBatchView');
    setMetas((prev) => ({ ...prev, ...plan }));
    setPostprocessors((prev) => {
      const updated: Record<string, string> = { ...prev };
      for (const p of Object.keys(plan)) updated[p] = next;
      return updated;
    });
  }, [paths, metas]);

  const reimportAll = useCallback(async () => {
    setImporting(true);
    try {
      await reimportPaths(paths.map((p) => ({ path: p, type: 'model' })), setImportStatus, `Re-importing ${paths.length} models…`);
      await loadAll();
      refreshAssets();
    } finally {
      setImporting(false);
      setImportStatus(false);
    }
  }, [paths, setImportStatus, loadAll, refreshAssets]);

  // #903: excluded members are NAMED, not silently dropped — the human has to be able to see which
  // models their edit did not reach. Same component and same wording grammar as
  // `MaterialBatchView`/`TextureBatchView`, so the three batch surfaces do not fork.
  const banner = unreadable.length > 0 ? (
    <AssetLoadRefusedBanner
      uiId="assetView.modelBatch.unreadable"
      onRetry={loadAll}
      style={{ margin: '0 0 6px' }}
      message={`⚠ ${unreadable.length} of ${paths.length} selected ${paths.length === 1 ? 'model' : 'models'} could not be read — ${unreadable.length === 1 ? 'it is' : 'they are'} excluded from this batch, so an edit here will not write to ${unreadable.length === 1 ? 'it' : 'them'}:`}
      details={(
        <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
          {unreadable.map(({ path, message }) => (
            <li key={path}>{`${path.split('/').pop() || path} — ${message}`}</li>
          ))}
        </ul>
      )}
    />
  ) : null;

  // ⚠️ The banner is DECLARED above the early returns and rendered by each one that can show it —
  // which is the property that matters, not the declaration order. (An earlier comment here said it
  // "renders BEFORE the early return". It does not: the `!loaded` return renders no banner. A
  // comment that overstates a placement guarantee is how the SkinEditor/TimelineEditor scar was
  // written in the first place, so it is corrected rather than reworded.) Showing nothing while
  // loading is deliberate — mid-load the exclusion set is not known, and the stale one belongs to
  // the previous selection.
  const loaded = loadedFor !== null && loadedFor === paths.join('\0');
  if (!loaded) return <div style={{ color: '#666', fontSize: 11 }}>Loading {paths.length} models…</div>;
  // Every member was excluded — say THAT rather than offering a control that can write to nothing.
  if (editable.length === 0) {
    return banner ?? <div style={{ color: '#666', fontSize: 11 }}>Nothing to edit.</div>;
  }

  return (
    <>
      {banner}
      <div style={{ marginBottom: 6 }}>
        <div style={{ color: '#888', fontSize: '10px', marginBottom: 2 }}>Postprocessor</div>
        <select value={common} onChange={(e) => { if (e.target.value) applyPostprocessor(e.target.value); }} style={{ ...inputStyle, width: '100%' }}>
          {mixed && <option value="">{MIXED_PLACEHOLDER}</option>}
          {postprocessorIds.map((id) => <option key={id} value={id}>{id}</option>)}
        </select>
      </div>
      <button
        disabled={importing}
        onClick={reimportAll}
        style={{ ...reimportBtnStyle, background: importing ? '#555' : '#2ecc71', color: '#fff', border: `1px solid ${importing ? '#444' : '#27ae60'}`, cursor: importing ? 'wait' : 'pointer' }}
      >
        {importing ? 'Converting…' : `Re-import all (${paths.length})`}
      </button>
      <UnsavedMetaBadge dirty={metaDirty} dataUiId="assetView.modelBatch.unsaved" />
    </>
  );
}

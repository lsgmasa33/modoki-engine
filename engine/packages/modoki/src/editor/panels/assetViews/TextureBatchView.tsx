/** TextureBatchView — multi-select import-settings editor for N textures. Mirrors
 *  TextureAssetView but merges settings across the selection (differing fields show
 *  "Mixed"), parks each changed field for every selected .meta.json AN EDIT CAN REACH (#845 —
 *  Cmd+S is the write, same as single-select), and offers a single "Re-import all (N)".
 *
 *  ⚠️ "can reach" is load-bearing, not a hedge (#903): a member whose sidecar could not be read is
 *  EXCLUDED — absent from `metas`, named in the banner — because `parkMetaEdit` refuses a document
 *  built on a failed read, and this view used to show such a member as edited anyway and drop it
 *  at Cmd+S. The decision lives in `metaBatchLoad.ts`. */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useEditorStore } from '../../store/editorStore';
import { resolveTextureSettings, resolveTextureType, deriveSettingsForType, type TextureImportSettings, type TextureType } from '../../../runtime/loaders/textureSettings';
import { reimportBtnStyle } from './widgets';
import { mergeRecords } from '../assetMerge';
import { reimportPaths } from './reimport';
import { readMetaPreferringPark } from '../../scene/pendingMeta';
import { loadMetaBatch, planMetaBatchWrite, parkPlannedMetaEdits, type MetaMap, type UnreadableMeta } from './metaBatchLoad';
import { AssetLoadRefusedBanner } from '../AssetLoadRefusedBanner';
import { TextureSettingsControls, type TextureSettingKey } from './TextureAssetView';
import { useMetaDirty } from '../useMetaDirty';
import { UnsavedMetaBadge } from './UnsavedMetaBadge';

const SETTING_KEYS: (keyof TextureImportSettings)[] = ['format', 'maxSize', 'mipmaps', 'wrapS', 'wrapT', 'colorspace'];

export function TextureBatchView({ paths }: { paths: string[] }) {
  // #870: a parked import-settings edit was invisible in the panel that MADE it.
  const metaDirty = useMetaDirty(paths);
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
  const refreshAssets = useEditorStore((s) => s.refreshAssets);
  const setImportStatus = useEditorStore((s) => s.setImportStatus);

  /** Bumped by every load; a resolution whose epoch is stale is dropped. `metas` is path-keyed so
   *  a superseded load could not write under the wrong path — but `unreadable` is rendered RAW, so
   *  without this a stale load could name paths that are no longer selected and print "2 of 1
   *  selected textures". Same reasoning as `MaterialBatchView`'s. */
  const loadEpoch = useRef(0);

  // Load all metas in parallel; store the full object per path so writes preserve
  // each asset's id/textureCache/border.
  const loadAll = useCallback(async () => {
    const epoch = ++loadEpoch.current;
    const key = paths.join('\0');
    setLoadedFor(null);
    // Decision extracted to `metaBatchLoad.ts` so it is testable without mounting this component;
    // this effect only supplies the I/O and applies the result. #845: ASK THE REGISTRY BEFORE THE
    // FILE, per path — a still-parked edit means disk holds the PRE-edit doc, and re-seeding this
    // view from it would read as the edit having been lost. `reimportAll` flushes every path
    // before it reimports, so nothing is parked here after one.
    //
    // ⚠️ The `catch` that used to sit here — substituting `metaReadFallback()` for a THROWN read —
    // is gone, and its absence is the #903 fix rather than a regression. A tagged fallback IS what
    // `parkMetaEdit` refuses, so installing one made the member present-but-unwritable: the row
    // showed the edit and the park was dropped. The loader excludes it instead, keeping the reason.
    const { metas: next, unreadable: bad } = await loadMetaBatch(paths, { readMeta: readMetaPreferringPark });
    if (epoch !== loadEpoch.current) return; // a newer load won while this one was in flight
    setMetas(next);
    setUnreadable(bad);
    for (const { path, message } of bad) {
      console.error(`[TextureBatchView] excluding ${path} from this batch — ${message}. A batch edit will not write to it.`);
    }
    setLoadedFor(key);
  }, [paths]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Merge the per-path resolved settings + type into a representative value + a
  // set of "mixed" keys.
  // ⚠️ EDITABLE members only. An excluded path used to contribute `{}` here, whose resolved values
  // are the type defaults — so one unreadable member could make a uniform selection read "Mixed"
  // and invite the human to "fix" a divergence that does not exist. The banner names it instead.
  const editable = paths.filter((p) => metas[p]);
  const resolved = editable.map((p) => {
    const m = metas[p] as { type?: TextureType; texture?: Partial<TextureImportSettings> };
    return { type: resolveTextureType(m), ...resolveTextureSettings(m) };
  });
  const { merged, mixed } = mergeRecords(resolved, ['type', ...SETTING_KEYS] as (keyof (typeof resolved)[number])[]);
  const type = (merged.type ?? '3d') as TextureType;
  const settings: TextureImportSettings = {
    format: merged.format ?? 'ktx2-uastc',
    maxSize: merged.maxSize ?? 1024,
    mipmaps: merged.mipmaps ?? true,
    wrapS: merged.wrapS ?? 'repeat',
    wrapT: merged.wrapT ?? 'repeat',
    colorspace: merged.colorspace ?? 'srgb',
  } as TextureImportSettings;
  const mixedKeys = mixed as Set<TextureSettingKey>;

  // Write one changed setting field into every selected meta THAT AN EDIT CAN REACH (#903).
  // `planMetaBatchWrite` skips a member absent from `metas`; the park is then guaranteed to be
  // accepted, so the verdict below is an assert rather than the guard.
  const applyPatch = useCallback((patch: Partial<TextureImportSettings>) => {
    // ⚠️ The plan is built and PARKED outside the `setMetas` updater, matching `ModelBatchView`.
    // A React updater runs in the render phase and StrictMode double-invokes it, so it must be pure
    // — this repo has ruled that twice (`AtlasAssetView`, `SpritePicker`). `parkMetaEdit`'s own
    // refusal report already defers its store write to a microtask for exactly this reason, but
    // `bump()` still notifies `useMetaDirty`'s subscribers synchronously, and from inside another
    // component's render that is React's "cannot update a component while rendering a different
    // component".
    //
    // ⚠️ **The residual this trade buys, recorded rather than left to be rediscovered.** Reading
    // `metas` from the CLOSURE instead of the updater's `prev` is correct only because every
    // control here commits through a React DISCRETE event, which React 18 flushes synchronously —
    // so the next handler always closes over the committed map. The one non-discrete entry is
    // `useWheelStep`'s `wheel` handler (React gives `wheel` ContinuousEventPriority: scheduled, not
    // sync-flushed), so two wheel ticks CAN run this before a commit. Inert today — both ticks
    // patch the same key from the same base, and `onStep` reads a DOM value that has not
    // re-rendered, so tick 2 computes the same number. It becomes a real dropped field the moment
    // two DIFFERENT fields can fire without an intervening commit (a drag-slider, or an agent op
    // dispatching two changes in one microtask). The `prev`-updater form did not have this
    // coupling; it had a render-phase side effect instead, which is worse.
    const plan = planMetaBatchWrite(paths, metas, (m) => {
      const cur = m as { type?: TextureType; texture?: Partial<TextureImportSettings> };
      return { ...m, type: resolveTextureType(cur), texture: { ...resolveTextureSettings(cur), ...patch } };
    });
    parkPlannedMetaEdits(plan, 'TextureBatchView');
    setMetas((prev) => ({ ...prev, ...plan }));
  }, [paths, metas]);

  // Changing the type RESETS the codec block to that type's derived defaults for
  // every selected texture (matches single-select changeType semantics).
  const applyType = useCallback((nextType: TextureType) => {
    // ⚠️ Derive PER MEMBER (the mutate callback runs once per path). Hoisted, one `derived` object
    // would be shared by all N parked docs — and `parkMetaEdit` copies only the TOP level, so every
    // parked entry's `texture` would be the same reference. Nothing mutates it today, which is why
    // this is a trap rather than a live bug; but it is the one place among the park sites where a
    // nested object could be shared ACROSS paths, so a future in-place tweak to one texture's codec
    // block would silently rewrite every other selected texture's parked edit too.
    const plan = planMetaBatchWrite(paths, metas, (m) => ({ ...m, type: nextType, texture: deriveSettingsForType(nextType) }));
    parkPlannedMetaEdits(plan, 'TextureBatchView');
    setMetas((prev) => ({ ...prev, ...plan }));
  }, [paths, metas]);

  const reimportAll = useCallback(async () => {
    setImporting(true);
    try {
      await reimportPaths(paths.map((p) => ({ path: p, type: 'texture' })), setImportStatus, `Re-importing ${paths.length} textures…`);
      await loadAll();
      refreshAssets();
    } finally {
      setImporting(false);
      setImportStatus(false);
    }
  }, [paths, setImportStatus, loadAll, refreshAssets]);

  // #903: excluded members are NAMED, not silently dropped. A batch edit that quietly writes to 5
  // of the 8 textures the human selected is the same class of silent-partial-success as the `{}`
  // park #886 replaced — the human has to be able to see which ones their edit did not reach.
  const banner = unreadable.length > 0 ? (
    // The SHARED component, not a hand-rolled copy of its palette; `message` rather than `fileName`
    // because this refusal is about several files at once. Wording mirrors `MaterialBatchView`'s so
    // the two batch surfaces say the same thing about the same situation.
    <AssetLoadRefusedBanner
      uiId="assetView.textureBatch.unreadable"
      onRetry={loadAll}
      style={{ margin: '0 0 6px' }}
      message={`⚠ ${unreadable.length} of ${paths.length} selected ${paths.length === 1 ? 'texture' : 'textures'} could not be read — ${unreadable.length === 1 ? 'it is' : 'they are'} excluded from this batch, so an edit here will not write to ${unreadable.length === 1 ? 'it' : 'them'}:`}
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
  if (!loaded) return <div style={{ color: '#666', fontSize: 11 }}>Loading {paths.length} textures…</div>;
  // Every member was excluded — say THAT rather than rendering controls that can write to nothing.
  if (editable.length === 0) {
    return banner ?? <div style={{ color: '#666', fontSize: 11 }}>Nothing to edit.</div>;
  }

  return (
    <>
      {banner}
      <TextureSettingsControls type={type} settings={settings} mixed={mixedKeys} onChangeType={applyType} onChange={applyPatch} advancedOpen={true} />
      <button
        disabled={importing}
        onClick={reimportAll}
        style={{ ...reimportBtnStyle, marginTop: 8, background: importing ? '#555' : '#2ecc71', color: '#fff', border: `1px solid ${importing ? '#444' : '#27ae60'}`, cursor: importing ? 'wait' : 'pointer' }}
      >
        {importing ? 'Converting…' : `Re-import all (${paths.length})`}
      </button>
      <UnsavedMetaBadge dirty={metaDirty} dataUiId="assetView.textureBatch.unsaved" />
    </>
  );
}

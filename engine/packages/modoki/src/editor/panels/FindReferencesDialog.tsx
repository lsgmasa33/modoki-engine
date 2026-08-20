/** "Find References" dialog (#284).
 *
 *  Runs the reverse reference graph over the open project (GET /api/find-references)
 *  for one asset or entity target and shows everything that (transitively) points at
 *  it — direct references, indirect chains through intermediate assets, and the
 *  IMPLICIT edges no file records (a derived sprite, a slice, an atlas member, an
 *  entity ref). Answers "is this safe to delete?" — modelled closely on
 *  CleanupAssetsDialog (same styling idiom, same fetch/loading/error handling).
 *
 *  Gated by editorStore.findReferencesTarget (opened from the Assets/Hierarchy
 *  context menus). Clicking a result reveals it in the Assets panel or selects it
 *  in the Hierarchy, reusing the SAME store-driven selection path those panels
 *  already react to (`selectAsset` / `selectEntity`) — there is no second selection
 *  mechanism to invent. */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useEditorStore } from '../store/editorStore';
import { backendFetch } from '../backend/editorBackend';
import { assetTypeFromPath } from './AssetRefField';
import { getAllEntities } from '../../runtime/core/ecs/entityUtils';
import { hasUnsavedChanges } from '../scene/serialize';
import { formatChainStep, originBadge, type FindReferencesResultLike, type RefHitLike, type RefNodeLike } from './findReferencesFormat';

const btn = (extra?: React.CSSProperties): React.CSSProperties => ({
  padding: '5px 16px', border: '1px solid #555', borderRadius: 3,
  background: '#2a2a40', color: '#ccc', cursor: 'pointer',
  fontFamily: 'monospace', fontSize: 11, ...extra,
});

const rowStyle: React.CSSProperties = {
  padding: '6px 10px', borderBottom: '1px solid #2a2a3a', fontSize: 11, cursor: 'pointer',
};

export default function FindReferencesDialog() {
  const info = useEditorStore((s) => s.findReferencesTarget);
  const close = useEditorStore((s) => s.closeFindReferences);
  const selectAsset = useEditorStore((s) => s.selectAsset);
  const selectEntity = useEditorStore((s) => s.selectEntity);

  const [data, setData] = useState<FindReferencesResultLike | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  // Why a result row did nothing when clicked. A dead click is its own small lie:
  // the user cannot tell "this row is not clickable" from "the editor ignored me".
  const [navNote, setNavNote] = useState<string | null>(null);

  const target = info?.target ?? null;

  // Which target the newest scan was for. A scan is not cancellable (backendFetch has
  // no AbortController), so the guard is on the LANDING instead: a response whose target
  // is no longer the current one is dropped. Without it, closing the dialog on a slow
  // target A and reopening on B let A's late response overwrite B's results while the
  // header still read "B" — a body that belongs to a different asset, in the one feature
  // whose whole purpose is not lying about what references what.
  const inFlightFor = useRef<string | null>(null);

  const scan = useCallback(async (t: string) => {
    inFlightFor.current = t;
    setLoading(true);
    setError(null);
    // Read live, not disk: a target the user just wired up but hasn't saved yet
    // would otherwise read as "0 references" — the exact wrong "unreferenced"
    // verdict this whole feature exists to prevent (see the CLAUDE.md invariant).
    setStale(hasUnsavedChanges());
    setNavNote(null);
    try {
      const res = await backendFetch(`/api/find-references?target=${encodeURIComponent(t)}`);
      const j = (await res.json()) as FindReferencesResultLike & { error?: string };
      if (inFlightFor.current !== t) return;   // superseded — see inFlightFor
      if (!res.ok || j.error) throw new Error(j.error || `find-references failed (${res.status})`);
      setData(j);
    } catch (e) {
      if (inFlightFor.current !== t) return;
      setError(e instanceof Error ? e.message : String(e));
      setData(null);
    } finally {
      if (inFlightFor.current === t) setLoading(false);
    }
  }, []);

  // The staleness banner asserts a PRESENT-TENSE fact ("there are unsaved edits"), and
  // `hasUnsavedChanges()` is a pull function with no reactive signal behind it — so a
  // user who reads the banner, saves, and comes back was still being warned about work
  // that no longer exists. Re-check on a light tick while the dialog is open; the read
  // is three cheap comparisons (serialize.ts), not a scan.
  useEffect(() => {
    if (!target) return;
    const id = setInterval(() => setStale(hasUnsavedChanges()), 1000);
    return () => clearInterval(id);
  }, [target]);

  // Re-scan each time a new target opens (the previous target's dialog state
  // must not leak into the next).
  useEffect(() => { if (target) void scan(target); }, [target, scan]);

  if (!target) return null;

  const navigateTo = (node: RefNodeLike) => {
    setNavNote(null);
    if (node.kind === 'asset') {
      selectAsset({ path: node.path, type: assetTypeFromPath(node.path), name: node.name });
      close();
      return;
    }
    // Entity — address by guid (runtime ids are reassigned on every scene reload),
    // and only if it's actually resolvable in the CURRENTLY LOADED world; a hit
    // found on disk may belong to a scene that isn't open right now.
    if (!node.guid) {
      setNavNote(`"${node.name}" has no GUID of its own, so there is nothing to select — it is authored inside ${node.path}.`);
      return;
    }
    const live = getAllEntities().find((e) => e.guid === node.guid);
    if (live) { selectEntity(live.id); close(); return; }
    // Found on disk, not in the world that is loaded right now. Say which file it
    // is in, so the reader's next move is obvious (open that scene) instead of
    // wondering whether the click registered.
    setNavNote(`"${node.name}" is not in the open scene — it is authored in ${node.path}. Open that scene to select it.`);
  };

  const renderHit = (hit: RefHitLike) => (
    <div
      key={hit.chain.map((s) => s.node.id + s.via).join('|') + hit.from.id}
      style={{ ...rowStyle, opacity: hit.reachable ? 1 : 0.6 }}
      onClick={() => navigateTo(hit.from)}
      data-testid="find-references-hit"
      data-hops={hit.hops}
      data-node-kind={hit.from.kind}
      title={hit.reachable ? undefined : 'This referrer does not survive a production build'}
    >
      {hit.chain.map((step, i) => (
        <span key={i}>
          <span style={{ color: '#ddd' }}>{formatChainStep(step)}</span>
          {originBadge(step.origin) && (
            <span style={{ color: '#e0a030', marginLeft: 4 }}>[{originBadge(step.origin)}]</span>
          )}
          <span style={{ color: '#666' }}> {'→'} </span>
        </span>
      ))}
      <span style={{ color: '#8ab4f8' }}>{data?.target.name}</span>
      {!hit.reachable && <span style={{ color: '#e74c3c', marginLeft: 8 }}>⚠ not shipped</span>}
    </div>
  );

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={close}>
      <div onClick={(e) => e.stopPropagation()} data-testid="find-references-dialog" style={{
        background: '#1e1e30', border: '1px solid #555', borderRadius: 6, padding: '16px 20px',
        minWidth: 560, maxWidth: 760, maxHeight: '82vh', display: 'flex', flexDirection: 'column', fontFamily: 'monospace',
      }}>
        <div style={{ color: '#fff', fontSize: 13, marginBottom: 4 }}>
          Find References — {info!.label}
          {data && <span style={{ color: '#888', fontWeight: 'normal' }}> ({data.target.kind}{data.target.path ? `, ${data.target.path}` : ''})</span>}
        </div>
        <div style={{ color: '#888', fontSize: 11, marginBottom: 10 }}>
          What references this, direct and indirect — including references no file records
          (a derived sprite, a slice, an atlas member).
        </div>

        {stale && (
          <div data-testid="find-references-stale" style={{ color: '#e0a030', fontSize: 11, marginBottom: 10, padding: '6px 8px', border: '1px solid #7a5a20', borderRadius: 4, background: '#2a2410' }}>
            ⚠ This scan reads FILES ON DISK. There are unsaved live-world edits — a reference you
            just wired up (or removed) may not show here yet. Save, then re-open this dialog.
          </div>
        )}

        {navNote && (
          <div style={{ color: '#8ab4d8', fontSize: 11, marginBottom: 10, padding: '6px 8px', border: '1px solid #34506a', borderRadius: 4, background: '#16202a' }}>
            {navNote}
          </div>
        )}

        {loading ? (
          <div style={{ color: '#888', fontSize: 12, padding: '20px 0' }}>Scanning…</div>
        ) : error && !data ? (
          <div style={{ color: '#e74c3c', fontSize: 12, padding: '12px 0', whiteSpace: 'pre-wrap' }}>{error}</div>
        ) : data ? (
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {data.unreferenced ? (
              <div data-testid="find-references-unreferenced" style={{ color: '#2ecc71', fontSize: 12, padding: '10px 0', fontWeight: 'bold' }}>
                Nothing references this{data.reachable ? '' : ' — and it is already excluded from a production build'}.
              </div>
            ) : (
              <div style={{ color: '#e0a030', fontSize: 11, padding: '4px 0 10px' }}>
                Referenced — not safe to assume unused.
              </div>
            )}

            <div style={{ color: '#aaa', fontSize: 11, marginBottom: 6 }}>
              Showing {data.returnedCount} of {data.totalCount}
              {data.truncated ? ' (truncated — narrow the search or raise the limit to see the rest)' : ''}
            </div>

            <div style={{ color: '#ccc', fontSize: 12, margin: '10px 0 4px' }}>Direct references ({data.direct.length})</div>
            {data.direct.length === 0 ? (
              <div style={{ color: '#666', fontSize: 11, padding: '4px 0 8px' }}>None.</div>
            ) : (
              <div style={{ border: '1px solid #333', borderRadius: 4 }}>{data.direct.map(renderHit)}</div>
            )}

            <div style={{ color: '#ccc', fontSize: 12, margin: '14px 0 4px' }}>Indirect references ({data.indirect.length})</div>
            {data.indirect.length === 0 ? (
              <div style={{ color: '#666', fontSize: 11, padding: '4px 0 8px' }}>None.</div>
            ) : (
              <div style={{ border: '1px solid #333', borderRadius: 4 }}>{data.indirect.map(renderHit)}</div>
            )}

            {data.unresolvedRefsFromTarget.length > 0 && (
              <div style={{ marginTop: 14, color: '#7a9ad0', fontSize: 10 }}>
                Could not resolve ({data.unresolvedRefsFromTarget.length}) — a reference this target holds that the
                classifier couldn't place. Not necessarily broken: a game-defined JSON kind the shaker doesn't
                classify lands here even when the file exists.
                <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                  {data.unresolvedRefsFromTarget.slice(0, 10).map((u, i) => (
                    <li key={i}>{u.via}: {u.guid}</li>
                  ))}
                  {data.unresolvedRefsFromTarget.length > 10 && <li>…and {data.unresolvedRefsFromTarget.length - 10} more</li>}
                </ul>
              </div>
            )}

            {data.warnings.length > 0 && (
              <div style={{ marginTop: 10, color: '#e0a030', fontSize: 10, maxHeight: 72, overflowY: 'auto' }}>
                ⚠ {data.warnings.length} scan warning{data.warnings.length === 1 ? '' : 's'}:
                <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                  {data.warnings.slice(0, 8).map((w, i) => <li key={i}>{w}</li>)}
                  {data.warnings.length > 8 && <li>…and {data.warnings.length - 8} more</li>}
                </ul>
              </div>
            )}
          </div>
        ) : null}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
          <button onClick={close} data-testid="find-references-close" style={btn()}>Close</button>
        </div>
      </div>
    </div>
  );
}

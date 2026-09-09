/** "Clean Up Unused Assets" dialog.
 *
 *  Runs the static asset tree-shaker over the open project (GET /api/unused-assets)
 *  and lists every orphan — a file on disk that no scene/prefab reaches, i.e. what
 *  the production build would tree-shake out. The user checks which to remove and
 *  hits Delete; each goes to the OS trash (recoverable) via /api/delete-asset,
 *  alongside its `.meta.json` sidecar when present.
 *
 *  Gated by editorStore.cleanupAssetsOpen (opened from the Assets menu). */

import { useState, useEffect, useCallback } from 'react';
import { useEditorStore } from '../store/editorStore';
import { backendFetch, backendPostJson } from '../backend/editorBackend';
import { describeRefusedDeletes, readUnusedStaleness } from './assetOps';

interface Orphan { path: string; type: string; bytes: number }
interface UnusedResponse {
  orphans?: Orphan[];
  totalBytes?: number;
  sceneCount?: number;
  warnings?: string[];
  error?: string;
  /** ⚠️ **THE STALENESS DISCLOSURE, and this dialog is the reason it exists** (#889).
   *
   *  The tree-shaker reads every scene/prefab/material off DISK. While the editor holds unsaved
   *  work, the orphan list below is computed from the PRE-EDIT graph — so an asset referenced ONLY
   *  by an edit that has not been saved reads as unused. This dialog pre-selects every orphan and
   *  posts the selection to `/api/delete-asset`, so that asset gets trashed.
   *
   *  The route computes these and the close-out review found nothing consuming them: the disclosure
   *  reached agents through the MCP surface while the HUMAN path — the one that actually deletes —
   *  threw it away. Absent when the editor is clean, never an empty array, so presence IS the signal.
   *
   *  ⚠️ Read from the RESPONSE rather than re-polled client-side, and that is the rule rather than
   *  this dialog's preference: the server's note is derived from the same probe that computed this
   *  very answer, so it cannot disagree with it, and that probe carries the type-level
   *  exhaustiveness check that a client-side hand-list cannot. `FindReferencesDialog` was the
   *  counter-example — it grew its own banner from `unsavedChangeCauses()` and checked
   *  `sceneDirty || dirtyAssetPaths`, missing three of the five causes — and #972 moved it onto
   *  this same `staleInputsNote`. */
  staleInputs?: Array<{ path: string; registry: string; detail?: string }>;
  staleInputsUnknown?: { reason: string };
  staleInputsNote?: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const btn = (extra?: React.CSSProperties): React.CSSProperties => ({
  padding: '5px 16px', border: '1px solid #555', borderRadius: 3,
  background: '#2a2a40', color: '#ccc', cursor: 'pointer',
  fontFamily: 'monospace', fontSize: 11, ...extra,
});

export default function CleanupAssetsDialog() {
  const open = useEditorStore((s) => s.cleanupAssetsOpen);
  const close = useEditorStore((s) => s.closeCleanupAssets);

  const [data, setData] = useState<UnusedResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // ⚠️ SEPARATE from `error`, deliberately. `scan()` owns `error` — it clears it on entry and
  // writes its own failure into it — so a refusal written before a scan is wiped and one written
  // after clobbers the scan's own message. They are two different facts about two different
  // operations, and one slot cannot hold both (#884 close-out review). Same shape as `missing`
  // vs `failed` one layer down: conflating two meanings in one field loses one of them.
  const [refusalNote, setRefusalNote] = useState<string | null>(null);

  const scan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await backendFetch('/api/unused-assets');
      const j = (await res.json()) as UnusedResponse;
      if (!res.ok || j.error) throw new Error(j.error || `scan failed (${res.status})`);
      setData(j);
      // Default every orphan selected — cleanup is the intent, and delete is
      // recoverable (OS trash). Select-all/none below flips it.
      setSelected(new Set((j.orphans ?? []).map((o) => o.path)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // Re-scan each time the dialog opens (the project may have changed since last).
  useEffect(() => { if (open) scan(); }, [open, scan]);

  if (!open) return null;

  const orphans = data?.orphans ?? [];

  // #889 — the DECISION lives in assetOps so it is testable without mounting this dialog.

  const staleness = readUnusedStaleness(data);
  const toggle = (path: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });
  const allSelected = orphans.length > 0 && selected.size === orphans.length;
  const selectAll = () => setSelected(allSelected ? new Set() : new Set(orphans.map((o) => o.path)));

  const selectedBytes = orphans.filter((o) => selected.has(o.path)).reduce((s, o) => s + o.bytes, 0);

  const deleteSelected = async () => {
    const paths = orphans.filter((o) => selected.has(o.path)).map((o) => o.path);
    if (paths.length === 0) return;
    setDeleting(true);
    setError(null);
    setRefusalNote(null);
    try {
      // Trash each orphan AND BOTH its sidecars (missing ones are skipped server-side, so
      // binaries-with-sidecar and JSON-assets-without both work).
      // ⚠️ `.meta.local.json` is not optional here. It was omitted until 2026-08-22, so every
      // cleanup left the local sidecar orphaned on disk — the file the scan had just called
      // unreachable kept a companion nothing would ever collect again. `sidecarsFor()`
      // (assetOps.ts) has always named both, and `assetUndo.ts` deletes both; this route was the
      // one that hand-rolled its own list and drifted from them.
      // Deliberately NOT routed through `deletionPathsFor()` despite it owning this rule: that
      // helper skips sidecars for text assets (`isTextAsset`), and real `.json` assets DO carry a
      // `.meta.json` here (games/court/.../levels/index.json, games/skin-test/.../dark-assassin.atlas.json),
      // so adopting it would strand those instead — trading one orphan class for another.
      // Asking for a path that is not there is free: the backend skips it and reports it in
      // `missing` rather than failing.
      const withSidecars = paths.flatMap((p) => [p, `${p}.meta.json`, `${p}.meta.local.json`]);
      const res = await backendPostJson('/api/delete-asset', { paths: withSidecars });
      const j = (await res.json()) as { ok?: boolean; error?: string; trashed?: number; failed?: string[] };
      if (!res.ok || !j.ok) throw new Error(j.error || `delete failed (${res.status})`);
      // ⚠️ A PARTIAL refusal is `ok:true`, so the throw above cannot see it — this dialog was the
      // FOURTH consumer of this route and #884's close-out review is what found it. Without this
      // the re-scan below silently re-lists the file the OS refused, with nothing saying why: the
      // human ticks it, hits Delete, and watches it come back. Same helper the Assets panel uses,
      // so both surfaces say the same thing about the same event.
      const refusal = describeRefusedDeletes(
        Array.isArray(j.failed) ? j.failed : [],
        { trashed: typeof j.trashed === 'number' ? j.trashed : 0 },
      );
      if (refusal) console.error(`[Cleanup] The OS refused to trash: ${refusal.detail}`);
      // Re-scan to show what remains (the manifest refreshes via the file watcher).
      await scan();
      // Set AFTER the scan, into its OWN slot — `scan()` clears `error` on entry, so setting this
      // before it would simply be erased. In the dialog rather than a toast: the refused file is
      // about to reappear in the list right here, and the explanation belongs next to it.
      if (refusal) setRefusalNote(refusal.toast);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={close}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: '#1e1e30', border: '1px solid #555', borderRadius: 6, padding: '16px 20px',
        minWidth: 480, maxWidth: 640, maxHeight: '80vh', display: 'flex', flexDirection: 'column', fontFamily: 'monospace',
      }}>
        <div style={{ color: '#fff', fontSize: 13, marginBottom: 4 }}>Clean Up Unused Assets</div>
        <div style={{ color: '#888', fontSize: 11, marginBottom: 12 }}>
          Files no scene or prefab references — what the production build would drop.
          Deleting moves them to the Trash (recoverable).
        </div>

        {/* ⚠️ Rendered OUTSIDE the loading/error/empty/list chain below, not inside the list arm.
            A refused SIDECAR leaves the rescan with zero orphans, so the chain takes its
            "No unused assets" arm and a note rendered inside the list would never appear —
            defeating the point of showing it next to the file (#884 close-out review). */}
        {refusalNote && (
          <div style={{ color: '#e0a030', fontSize: 11, padding: '6px 0', whiteSpace: 'pre-wrap' }}>{refusalNote}</div>
        )}

        {/* #889: the scan read DISK. Say so BEFORE the list, because the list is pre-selected and the
            next click trashes it. Rendered above the results rather than beside them for the same
            reason `AssetLoadRefusedBanner` sits above a batch view's controls: a caveat under the
            thing it qualifies is read after the decision. */}
        {staleness && (
          <div
            data-testid="cleanup-stale"
            data-ui-id="assets.cleanup.stale"
            role="alert"
            style={{
              color: '#e0a030', fontSize: 11, marginBottom: 8, padding: '6px 8px',
              border: '1px solid #7a5a20', borderRadius: 4, background: '#2a2410', whiteSpace: 'pre-wrap',
              // ⚠️ BOUNDED. `staleness.note` comes from `describeHolds`, which names EVERY held
              // path grouped by kind, and the probe is global — so on a busy editor this is
              // arbitrarily long. The modal is maxHeight:80vh with no overflow of its own and the
              // orphan list below holds a minHeight, so an uncapped banner pushes Close/Delete
              // outside the box with nothing to scroll. The `warnings` block below caps itself at
              // 72px for exactly this reason (close-out review 2).
              maxHeight: 96, overflowY: 'auto', flexShrink: 0,
            }}
          >
            ⚠ {staleness.note}
            {staleness.inputs.length ? (
              <div style={{ marginTop: 4, color: '#c9a35a' }}>
                An asset referenced only by that unsaved work is listed below as unused — deleting it
                would break a reference you cannot see yet.
              </div>
            ) : null}
          </div>
        )}

        {loading ? (
          <div style={{ color: '#888', fontSize: 12, padding: '20px 0' }}>Scanning…</div>
        ) : error && !data ? (
          <div style={{ color: '#e74c3c', fontSize: 12, padding: '12px 0', whiteSpace: 'pre-wrap' }}>{error}</div>
        ) : orphans.length === 0 ? (
          <div style={{ color: '#2ecc71', fontSize: 12, padding: '20px 0' }}>
            No unused assets — every shippable file is referenced by a scene or prefab
            {data?.sceneCount != null ? ` (${data.sceneCount} scene${data.sceneCount === 1 ? '' : 's'} scanned).` : '.'}
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, fontSize: 11, color: '#aaa' }}>
              <button data-ui-id="assets.cleanup.selectAll" data-ui-kind="button" data-ui-label={allSelected ? 'Select none' : 'Select all'} onClick={selectAll} style={btn({ padding: '3px 10px' })}>
                {allSelected ? 'Select none' : 'Select all'}
              </button>
              <span>{orphans.length} unused · {formatBytes(data?.totalBytes ?? 0)} total</span>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', border: '1px solid #333', borderRadius: 4, minHeight: 120 }}>
              {orphans.map((o, i) => {
                const slash = o.path.lastIndexOf('/');
                const name = slash >= 0 ? o.path.slice(slash + 1) : o.path;
                const dir = slash >= 0 ? o.path.slice(0, slash + 1) : '';
                const checked = selected.has(o.path);
                return (
                  <label key={o.path} style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px',
                    borderBottom: '1px solid #2a2a3a', cursor: 'pointer', fontSize: 11,
                    background: checked ? '#26263c' : 'transparent',
                  }}>
                    <input data-ui-id={`assets.cleanup.orphan.${i}`} data-ui-kind="toggle" data-ui-label={name} data-ui-state={checked ? 'checked' : 'unchecked'} type="checkbox" checked={checked} onChange={() => toggle(o.path)} />
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <span style={{ color: '#666' }}>{dir}</span>
                      <span style={{ color: '#ddd' }}>{name}</span>
                    </span>
                    <span style={{ color: '#7a7aa0', minWidth: 64, textAlign: 'right' }}>{o.type}</span>
                    <span style={{ color: '#999', minWidth: 64, textAlign: 'right' }}>{formatBytes(o.bytes)}</span>
                  </label>
                );
              })}
            </div>

            {(data?.warnings?.length ?? 0) > 0 && (
              <div style={{ marginTop: 8, color: '#e0a030', fontSize: 10, maxHeight: 72, overflowY: 'auto' }}>
                ⚠ {data!.warnings!.length} scan warning{data!.warnings!.length === 1 ? '' : 's'} — an asset reached only by an
                unresolved reference could be listed here in error. Review before deleting:
                <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                  {data!.warnings!.slice(0, 8).map((w, i) => <li key={i}>{w}</li>)}
                  {data!.warnings!.length > 8 && <li>…and {data!.warnings!.length - 8} more</li>}
                </ul>
              </div>
            )}

            {error && <div style={{ marginTop: 8, color: '#e74c3c', fontSize: 11, whiteSpace: 'pre-wrap' }}>{error}</div>}
          </>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
          <button data-ui-id="assets.cleanup.close" data-ui-kind="button" data-ui-label="Close" onClick={close} style={btn()}>Close</button>
          {orphans.length > 0 && (
            <button
              data-ui-id="assets.cleanup.delete" data-ui-kind="button" data-ui-label="Delete selected"
              onClick={deleteSelected}
              disabled={deleting || selected.size === 0}
              style={btn({
                background: selected.size === 0 ? '#3a2a2a' : '#5c2a2a',
                borderColor: '#7a3a3a',
                color: selected.size === 0 ? '#888' : '#fff',
                cursor: deleting || selected.size === 0 ? 'default' : 'pointer',
              })}
            >
              {deleting ? 'Deleting…' : `Delete ${selected.size} selected (${formatBytes(selectedBytes)})`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

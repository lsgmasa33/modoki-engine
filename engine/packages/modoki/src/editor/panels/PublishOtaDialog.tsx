/** "Publish OTA Update…" dialog (docs/plans/mobile-ota-updates-plan.md Phase 5a) —
 *  the primary Build → OTA action. Shows what's LIVE on the bucket right now vs what
 *  this project would publish, collects a version string + mandatory flag, then drives
 *  GET /api/ota/publish (SSE) to completion. That endpoint already carries the safety
 *  rails (fresh build from the current project.config.json, version-collision refusal,
 *  CORS preflight) — this dialog is just the human-facing surface over it.
 *
 *  Gated by editorStore.otaPublishOpen (opened from Build → Publish OTA Update…). */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useEditorStore } from '../store/editorStore';
import { backendFetch, backendEventSource } from '../backend/editorBackend';

interface ReleaseInfo { bundles?: Record<string, string>; mandatory?: boolean; minEngineApi?: number }
interface StatusResponse { ok: boolean; bucket?: string; release?: ReleaseInfo | null; error?: string }
interface SettingsResponse { ota?: { enabled?: boolean; bundleName?: string; engineApi?: number } }

/** "v17" -> "v18"; anything else is left alone (the server suggests a fix on collision). */
function nextVersion(v: string | undefined): string {
  const m = v?.match(/^v(\d+)$/);
  return m ? `v${Number(m[1]) + 1}` : '';
}

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '4px 8px',
  background: '#15151f', color: '#ddd', border: '1px solid #444', borderRadius: 3,
  fontFamily: 'monospace', fontSize: 12,
};
const btn = (extra?: React.CSSProperties): React.CSSProperties => ({
  padding: '5px 16px', border: '1px solid #555', borderRadius: 3,
  background: '#2a2a40', color: '#ccc', cursor: 'pointer',
  fontFamily: 'monospace', fontSize: 11, ...extra,
});

export default function PublishOtaDialog() {
  const open = useEditorStore((s) => s.otaPublishOpen);
  const close = useEditorStore((s) => s.closeOtaPublish);

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [bucket, setBucket] = useState<string | null>(null);
  const [release, setRelease] = useState<ReleaseInfo | null>(null);
  const [enabled, setEnabled] = useState(true);

  const [bundleName, setBundleName] = useState('shell');
  const [version, setVersion] = useState('');
  const [mandatory, setMandatory] = useState(false);
  const [key, setKey] = useState('');

  const [publishing, setPublishing] = useState(false);
  const [done, setDone] = useState(false);
  const [failed, setFailed] = useState(false);
  const [statusLine, setStatusLine] = useState('');
  const [log, setLog] = useState<string[]>([]);
  const esRef = useRef<EventSource | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [statusRes, settingsRes] = await Promise.all([
        backendFetch('/api/ota/status'),
        backendFetch('/api/project-settings'),
      ]);
      const statusJson = await statusRes.json() as StatusResponse;
      const settings = await settingsRes.json() as SettingsResponse;
      const defaultBundle = settings.ota?.bundleName || 'shell';
      setEnabled(settings.ota?.enabled !== false);
      if (!statusRes.ok || !statusJson.ok) {
        // A bucket that can't be read yet (nothing published, or gcloud/derivation
        // issue) isn't fatal — publishing FIRST version is a real, valid flow.
        setLoadError(statusJson.error || null);
      } else {
        setBucket(statusJson.bucket ?? null);
        setRelease(statusJson.release ?? null);
      }
      setBundleName(defaultBundle);
      setVersion((prev) => prev || nextVersion(statusJson.release?.bundles?.[defaultBundle]));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setDone(false); setFailed(false); setStatusLine(''); setLog([]);
    load();
  }, [open, load]);

  // Close the SSE connection if the dialog unmounts/closes mid-publish — a half-open
  // stream would otherwise leak (and the server's req.on('close') aborts the child
  // process on the far end, so this is also how a mid-publish "Close" cancels it).
  useEffect(() => () => { esRef.current?.close(); }, []);

  if (!open) return null;

  const liveVersion = release?.bundles?.[bundleName];

  const publish = () => {
    if (!version.trim()) return;
    setPublishing(true);
    setDone(false);
    setFailed(false);
    setLog([]);
    setStatusLine('Starting…');

    const qs = new URLSearchParams({ version: version.trim() });
    if (bundleName.trim()) qs.set('bundleName', bundleName.trim());
    if (key.trim()) qs.set('key', key.trim());
    if (mandatory) qs.set('mandatory', '1');

    const es = backendEventSource(`/api/ota/publish?${qs}`);
    esRef.current = es;

    es.addEventListener('status', (e) => {
      const status = JSON.parse((e as MessageEvent).data) as string;
      if (status === 'DONE') {
        setDone(true);
        setPublishing(false);
        setStatusLine('Published.');
        es.close();
      } else if (status.startsWith('FAILED:')) {
        setFailed(true);
        setPublishing(false);
        setStatusLine(status.slice('FAILED:'.length).trim());
        es.close();
      } else {
        setStatusLine(status);
      }
    });
    es.addEventListener('message', (e) => {
      const line = JSON.parse((e as MessageEvent).data) as string;
      if (line) setLog((prev) => (prev.length > 300 ? prev.slice(-300) : prev).concat(line));
    });
    es.onerror = () => {
      setFailed(true);
      setPublishing(false);
      setStatusLine('Connection lost.');
      es.close();
    };
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={publishing ? undefined : close}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: '#1e1e30', border: '1px solid #555', borderRadius: 6, padding: '16px 20px',
        minWidth: 520, maxWidth: 640, maxHeight: '82vh', display: 'flex', flexDirection: 'column', fontFamily: 'monospace',
      }}>
        <div style={{ color: '#fff', fontSize: 13, marginBottom: 4 }}>Publish OTA Update</div>
        <div style={{ color: '#888', fontSize: 11, marginBottom: 12 }}>
          Builds fresh from the current project settings, refuses a version already
          published, verifies bucket CORS, then publishes. Players on a routine (non-
          mandatory) update pick it up next launch.
        </div>

        {!enabled && (
          <div style={{ color: '#e0a030', fontSize: 11, marginBottom: 10 }}>
            ⚠ ota.enabled is OFF in Project Settings → OTA. Turn it on before publishing —
            the shell won't check for updates otherwise.
          </div>
        )}

        {loading ? (
          <div style={{ color: '#888', fontSize: 12, padding: '8px 0' }}>Loading current bucket state…</div>
        ) : (
          <div style={{ fontSize: 11, color: '#aaa', marginBottom: 10 }}>
            {bucket && <div>Bucket: <span style={{ color: '#7a7aa0' }}>{bucket}</span></div>}
            {loadError && <div style={{ color: '#e0a030' }}>{loadError}</div>}
            {release?.bundles && Object.keys(release.bundles).length > 0 && (
              <div style={{ marginTop: 4 }}>
                Live now: {Object.entries(release.bundles).map(([n, v]) => `${n}@${v}`).join(', ')}
              </div>
            )}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
          <div>
            <div style={{ color: '#aaa', fontSize: 11, marginBottom: 3 }}>Bundle</div>
            <input type="text" style={{ ...inputStyle, opacity: 0.6, cursor: 'not-allowed' }} value={bundleName} disabled
              title="This dialog always builds + publishes the CURRENTLY OPEN project as its own configured ota.bundleName — the server refuses any other value. Automated sub-game bundle publish isn't wired up yet; open the sub-game's own project to publish it." readOnly />
          </div>
          <div>
            <div style={{ color: '#aaa', fontSize: 11, marginBottom: 3 }}>
              Version {liveVersion && <span style={{ color: '#666' }}>(live: {liveVersion})</span>}
            </div>
            <input type="text" style={inputStyle} value={version} disabled={publishing}
              onChange={(e) => setVersion(e.target.value)} placeholder="v18" />
          </div>
          <div>
            <div style={{ color: '#aaa', fontSize: 11, marginBottom: 3 }}>Signing key name</div>
            <input type="text" style={inputStyle} value={key} disabled={publishing}
              onChange={(e) => setKey(e.target.value)} placeholder="default" />
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#ddd', fontSize: 12 }}>
              <input type="checkbox" checked={mandatory} disabled={publishing} onChange={(e) => setMandatory(e.target.checked)} />
              Mandatory (blocks with a restart gate)
            </label>
          </div>
        </div>

        {(publishing || done || failed) && (
          <div style={{ marginBottom: 10 }}>
            <div style={{ color: failed ? '#e74c3c' : done ? '#2ecc71' : '#ddd', fontSize: 12, marginBottom: 4 }}>
              {statusLine}
            </div>
            <div style={{
              background: '#101018', border: '1px solid #333', borderRadius: 4, padding: 8,
              maxHeight: 220, overflowY: 'auto', fontSize: 10, color: '#999', whiteSpace: 'pre-wrap',
            }}>
              {log.join('\n')}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 6 }}>
          <button onClick={close} disabled={publishing} style={btn({ opacity: publishing ? 0.5 : 1 })}>
            {done || failed ? 'Close' : 'Cancel'}
          </button>
          {!done && (
            <button
              onClick={publish}
              disabled={publishing || !version.trim() || !bundleName.trim()}
              style={btn({
                background: publishing || !version.trim() ? '#2a2a40' : '#245c2a',
                borderColor: publishing || !version.trim() ? '#555' : '#3a7a3a',
                color: publishing || !version.trim() ? '#666' : '#fff',
                cursor: publishing || !version.trim() ? 'default' : 'pointer',
              })}
            >
              {publishing ? 'Publishing…' : failed ? 'Retry' : 'Publish'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** "OTA Keys…" dialog — generate/inspect the Ed25519 signing keypair OTA releases are
 *  signed with (docs/ota-updates.md, docs/plans/mobile-ota-updates-plan.md Phase 5a).
 *
 *  There is deliberately NO overwrite/regenerate control here, on either side of the
 *  wire: `POST /api/ota/keygen` (engine/scripts/ota-keygen.mjs underneath) refuses to
 *  overwrite an existing key file, full stop — regenerating orphans every already-shipped
 *  binary (they have the OLD public key baked in and will reject every future update).
 *  A typed-confirmation guard only makes sense for a capability that exists; since this
 *  one doesn't, the dialog's job is just to make that refusal LEGIBLE, not to route
 *  around it. Rotating a key on purpose is a decision for the project owner, made by
 *  choosing a different key NAME (a second identity), not by forcing this one.
 *
 *  Gated by editorStore.otaKeysOpen (opened from Build → OTA Keys…). */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useEditorStore } from '../store/editorStore';
import { backendFetch, backendPostJson } from '../backend/editorBackend';

interface KeyStatus { exists: boolean; publicKey: string | null }

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

export default function OtaKeysDialog() {
  const open = useEditorStore((s) => s.otaKeysOpen);
  const close = useEditorStore((s) => s.closeOtaKeys);

  const [name, setName] = useState('default');
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const [configPublicKey, setConfigPublicKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Guards against an out-of-order response: the name field can plausibly fire more
  // than one refresh() in quick succession (edit, blur, edit again before the first
  // request lands), and network ordering does not guarantee the LATEST call's response
  // arrives last. Only the most recently STARTED call is allowed to apply its result.
  const refreshSeq = useRef(0);
  const refresh = useCallback(async (checkName: string) => {
    const seq = ++refreshSeq.current;
    setLoading(true);
    setError(null);
    try {
      const [keyRes, settingsRes] = await Promise.all([
        backendFetch(`/api/ota/keys?name=${encodeURIComponent(checkName)}`),
        backendFetch('/api/project-settings'),
      ]);
      const keyJson = await keyRes.json() as { ok: boolean; exists?: boolean; publicKey?: string | null; error?: string };
      if (!keyRes.ok || !keyJson.ok) throw new Error(keyJson.error || `check failed (${keyRes.status})`);
      const settings = await settingsRes.json() as { ota?: { publicKey?: string } };
      if (seq !== refreshSeq.current) return; // a newer refresh() superseded this one
      setStatus({ exists: !!keyJson.exists, publicKey: keyJson.publicKey ?? null });
      setConfigPublicKey(settings?.ota?.publicKey ?? null);
    } catch (e) {
      if (seq !== refreshSeq.current) return;
      setError(e instanceof Error ? e.message : String(e));
      setStatus(null);
    } finally {
      if (seq === refreshSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => { if (open) { setNotice(null); refresh(name); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  const generate = async () => {
    setGenerating(true);
    setError(null);
    setNotice(null);
    try {
      const res = await backendPostJson(`/api/ota/keygen?name=${encodeURIComponent(name)}`, undefined);
      const j = await res.json() as { ok: boolean; publicKey?: string; error?: string };
      if (!res.ok || !j.ok) throw new Error(j.error || `keygen failed (${res.status})`);
      setNotice(`Generated. Public key:\n${j.publicKey}`);
      await refresh(name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  };

  const syncToProjectSettings = async () => {
    if (!status?.publicKey) return;
    setSyncing(true);
    setError(null);
    setNotice(null);
    try {
      // A PARTIAL post: it relies on /api/project-settings deep-merging onto the
      // on-disk config and leaving every other section alone. It used to merge onto
      // the DEFAULTS instead, so this button reset the whole project config (app
      // identity, signing) as a side effect of saving one key. Don't "simplify" the
      // route back to a full replace without fixing this caller too.
      const res = await backendPostJson('/api/project-settings', { ota: { publicKey: status.publicKey } });
      const j = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !j.ok) throw new Error(j.error || `save failed (${res.status})`);
      setConfigPublicKey(status.publicKey);
      setNotice('Saved to Project Settings → OTA → Public key.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  };

  const mismatch = !!status?.exists && !!status.publicKey && configPublicKey !== status.publicKey;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={close}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: '#1e1e30', border: '1px solid #555', borderRadius: 6, padding: '16px 20px',
        minWidth: 460, maxWidth: 560, display: 'flex', flexDirection: 'column', fontFamily: 'monospace',
      }}>
        <div style={{ color: '#fff', fontSize: 13, marginBottom: 4 }}>OTA Keys</div>
        <div style={{ color: '#888', fontSize: 11, marginBottom: 12 }}>
          The Ed25519 keypair OTA releases are signed with. The private key lives at
          build/ota-keys/&lt;name&gt;.json (gitignored) — losing it means these installed
          binaries can never be updated again. There is no overwrite here on purpose.
        </div>

        <div style={{ marginBottom: 10 }}>
          <div style={{ color: '#aaa', fontSize: 11, marginBottom: 3 }}>Key name</div>
          <input data-ui-id="ota.keys.name" data-ui-kind="field" data-ui-label="Key name" type="text" style={inputStyle} value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => refresh(name)}
            placeholder="default" />
        </div>

        {loading ? (
          <div style={{ color: '#888', fontSize: 12, padding: '8px 0' }}>Checking…</div>
        ) : status && (
          <div style={{ fontSize: 11, color: '#ccc', marginBottom: 8 }}>
            {status.exists ? (
              <>
                <div style={{ color: '#2ecc71', marginBottom: 4 }}>Key "{name}" exists.</div>
                <div style={{ wordBreak: 'break-all', color: '#7a7aa0', marginBottom: 4 }}>{status.publicKey}</div>
                {mismatch ? (
                  <div style={{ color: '#e0a030' }}>
                    ⚠ Project Settings ota.publicKey does not match this key.{' '}
                    <button data-ui-id="ota.keys.sync" data-ui-kind="button" data-ui-label="Sync to Project Settings" onClick={syncToProjectSettings} disabled={syncing} style={btn({ padding: '2px 8px', fontSize: 10 })}>
                      {syncing ? 'Saving…' : 'Sync to Project Settings'}
                    </button>
                  </div>
                ) : (
                  <div style={{ color: '#666' }}>Matches Project Settings ota.publicKey.</div>
                )}
              </>
            ) : (
              <div style={{ color: '#888' }}>No key generated yet for "{name}".</div>
            )}
          </div>
        )}

        {notice && <div style={{ color: '#2ecc71', fontSize: 11, marginBottom: 8, whiteSpace: 'pre-wrap' }}>{notice}</div>}
        {error && <div style={{ color: '#e74c3c', fontSize: 11, marginBottom: 8, whiteSpace: 'pre-wrap' }}>{error}</div>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 6 }}>
          <button data-ui-id="ota.keys.close" data-ui-kind="button" data-ui-label="Close" onClick={close} style={btn()}>Close</button>
          <button
            data-ui-id="ota.keys.generate" data-ui-kind="button" data-ui-label="Generate"
            onClick={generate}
            disabled={generating || !!status?.exists}
            title={status?.exists ? 'Already exists — pick a different name to create a second identity' : undefined}
            style={btn({
              background: status?.exists ? '#2a2a40' : '#245c2a',
              borderColor: status?.exists ? '#555' : '#3a7a3a',
              color: status?.exists ? '#666' : '#fff',
              cursor: generating || status?.exists ? 'default' : 'pointer',
            })}
          >
            {generating ? 'Generating…' : 'Generate'}
          </button>
        </div>
      </div>
    </div>
  );
}

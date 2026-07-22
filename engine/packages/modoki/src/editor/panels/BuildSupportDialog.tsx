/** "Build Support" dialog — the Unity-Hub-style toolchain manager.
 *
 *  Reads GET /api/toolchain (detection + install/guide affordance + per-target
 *  preflight) and lists every build tool grouped by platform module. Each row
 *  shows its detected status; a missing tool that `install()` can provision gets
 *  an Install button (streams GET /api/toolchain/install?id=<id> — same SSE
 *  protocol as /api/build), and a missing tool that can only be guided (Xcode)
 *  gets an expandable Guide with steps + links. iOS is macOS-only.
 *
 *  Gated by editorStore.buildSupportOpen (opened from the Build menu). */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useEditorStore } from '../store/editorStore';
import { backendFetch, backendEventSource } from '../backend/editorBackend';

interface GuideLink { label: string; url: string }
interface GuideDoc { id: string; title: string; steps: string[]; links?: GuideLink[]; canAutoInstall: boolean }
interface ToolStatus {
  id: string; present: boolean; source: string; version?: string; path?: string;
  installable: boolean; stale?: boolean; guide: GuideDoc;
}
interface PreflightReport { target: string; ready: boolean; tools: { id: string; present: boolean; message?: string }[] }
interface ToolchainStatus {
  platform: string;
  toolchainDir: string | null;
  allowSystemToolchain: boolean;
  tools: ToolStatus[];
  adb: { present: boolean; path?: string };
  preflight: Record<string, PreflightReport>;
  error?: string;
}

/** Friendly display names, keyed by tool id (falls back to the raw id). */
const TOOL_LABEL: Record<string, string> = {
  'npm': 'Node / npm',
  'java': 'Java 21 JDK',
  'android-sdk': 'Android SDK',
  'adb': 'adb (platform-tools)',
  'xcodebuild': 'Xcode',
  'cocoapods': 'CocoaPods (adapter games only)',
  'toktx': 'KTX-Software (toktx)',
  'gltf-transform-cli': 'glTF-Transform CLI',
  'ffmpeg': 'ffmpeg',
  'ffprobe': 'ffprobe',
  'msdf-atlas-gen': 'msdf-atlas-gen (MTSDF fonts)',
};
const label = (id: string) => TOOL_LABEL[id] ?? id;

/** Cross-platform asset CLIs auto-installed on first launch (like Node) so model +
 *  audio import just works. Everything EXCEPT the mobile build modules (Android/iOS)
 *  auto-installs; toktx is bundled, so it's not listed here. */
const AUTO_INSTALL_IDS = ['gltf-transform-cli', 'gltfpack', 'ffmpeg', 'ffprobe'];

/** Which registry tools each module box lists. `adb` is derived (from the SDK), so
 *  it rides in the Android box as an extra status row without its own action. */
const GROUPS: { title: string; subtitle: string; ids: string[]; adb?: boolean; iosOnly?: boolean }[] = [
  { title: 'Android Build Support', subtitle: 'Build & deploy Android APKs', ids: ['java', 'android-sdk'], adb: true },
  { title: 'iOS Build Support', subtitle: 'Build & deploy iOS apps (macOS only)', ids: ['xcodebuild', 'cocoapods'], iosOnly: true },
  { title: 'Model Tools', subtitle: 'GLB import / KTX2 compression', ids: ['toktx', 'gltf-transform-cli'] },
  { title: 'Text Tools', subtitle: 'MTSDF font-atlas baking (dynamic / CJK text) — bundled', ids: ['msdf-atlas-gen'] },
  { title: 'Audio Tools', subtitle: 'Audio import — auto-installed by the editor', ids: ['ffmpeg', 'ffprobe'] },
  { title: 'Core', subtitle: 'Auto-installed by the editor (Node / npm)', ids: ['npm'] },
];

const btn = (extra?: React.CSSProperties): React.CSSProperties => ({
  padding: '4px 12px', border: '1px solid #555', borderRadius: 3,
  background: '#2a2a40', color: '#ccc', cursor: 'pointer',
  fontFamily: 'monospace', fontSize: 11, ...extra,
});

export default function BuildSupportDialog() {
  const open = useEditorStore((s) => s.buildSupportOpen);
  const close = useEditorStore((s) => s.closeBuildSupport);

  const [data, setData] = useState<ToolchainStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set()); // guide rows expanded
  const [installing, setInstalling] = useState<string | null>(null); // tool id mid-install
  const [removing, setRemoving] = useState<string | null>(null); // tool id (or 'all') mid-remove
  const [confirmRemoveAll, setConfirmRemoveAll] = useState(false); // two-click confirm for the nuke
  const [log, setLog] = useState<string[]>([]);
  const esRef = useRef<EventSource | null>(null);
  // Tools we've already kicked an auto-install for this dialog session — so a failed
  // one isn't retried in a loop (the effect re-runs on every `data` refresh).
  const autoInstalledRef = useRef<Set<string>>(new Set());
  // Packaged editor opens this on launch until setup's done (EditorApp effect). This
  // checkbox is the manual opt-out — persisted so the auto-open reads it next launch.
  const [autoShowDisabled, setAutoShowDisabled] = useState(() => !!localStorage.getItem('modoki.buildSupportDismissed'));

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await backendFetch('/api/toolchain');
      const j = (await res.json()) as ToolchainStatus;
      if (!res.ok || j.error) throw new Error(j.error || `status failed (${res.status})`);
      setData(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (open) refresh(); }, [open, refresh]);
  // Tear down any in-flight install stream when the dialog closes.
  useEffect(() => {
    if (!open) { esRef.current?.close(); esRef.current = null; setInstalling(null); setLog([]); }
  }, [open]);
  useEffect(() => () => { esRef.current?.close(); }, []);

  const installTool = useCallback((id: string) => {
    if (installing) return; // one at a time (shared userData npm-tools dir)
    setInstalling(id);
    setLog([`Installing ${label(id)}…`]);
    const es = backendEventSource(`/api/toolchain/install?id=${encodeURIComponent(id)}`);
    esRef.current = es;
    es.onmessage = (ev) => {
      try { const line = JSON.parse(ev.data) as string; if (line) setLog((l) => [...l, line]); } catch { /* ignore */ }
    };
    es.addEventListener('status', (ev) => {
      let status = '';
      try { status = JSON.parse((ev as MessageEvent).data) as string; } catch { /* ignore */ }
      if (status.startsWith('DONE')) {
        es.close(); esRef.current = null; setInstalling(null);
        refresh(); // re-detect: the row should flip to present
      } else if (status.startsWith('FAILED:')) {
        es.close(); esRef.current = null; setInstalling(null);
        setLog((l) => [...l, `❌ ${status.slice('FAILED:'.length)}`]);
      }
    });
    es.onerror = () => { es.close(); esRef.current = null; setInstalling(null); setLog((l) => [...l, '❌ Connection lost']); };
  }, [installing, refresh]);

  // Auto-install the asset toolchain (Model Tools + Audio Tools) the way Node auto-
  // provisions — so model + audio import work out of the box, no manual click. Runs
  // while the onboarding dialog is open (packaged) and the user hasn't opted out;
  // installs the missing tools ONE AT A TIME via the same SSE flow + progress log as
  // the Install button (installTool serializes on `installing`, and each DONE →
  // refresh() re-runs this effect for the next tool). toktx is bundled and the MOBILE
  // modules (Android/iOS) stay opt-in — everything ELSE auto-installs. A tool that
  // fails isn't retried in a loop (autoInstalledRef).
  useEffect(() => {
    if (!open || !data?.toolchainDir || installing) return;
    if (localStorage.getItem('modoki.buildSupportDismissed')) return; // user manages installs
    const next = (data.tools ?? []).find(
      (t) => AUTO_INSTALL_IDS.includes(t.id) && t.installable && (!t.present || t.stale) && !autoInstalledRef.current.has(t.id),
    );
    if (next) {
      autoInstalledRef.current.add(next.id);
      installTool(next.id);
    }
  }, [open, data, installing, installTool]);

  const uninstallTool = useCallback(async (id: string, allLabel?: string) => {
    if (installing || removing) return;
    setRemoving(id);
    setLog([`Removing ${allLabel ?? label(id)}…`]);
    try {
      const res = await backendFetch('/api/toolchain/uninstall', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((j as { error?: string }).error || `remove failed (${res.status})`);
      // Let the model tools re-auto-install after a manual removal only if the user re-opts-in;
      // clear the session guard so a fresh removal+reopen can re-trigger onboarding intentionally.
      autoInstalledRef.current.add(id); // don't immediately re-install what the user just removed
      setLog((l) => [...l, `✅ Removed ${allLabel ?? label(id)}`]);
    } catch (e) {
      setLog((l) => [...l, `❌ ${e instanceof Error ? e.message : String(e)}`]);
    } finally {
      setRemoving(null);
      refresh();
    }
  }, [installing, removing, refresh]);

  const setSystemToolchain = useCallback(async (allow: boolean) => {
    // Optimistic: reflect immediately, then persist + re-detect (a swapped source can
    // flip a tool present↔missing).
    setData((d) => (d ? { ...d, allowSystemToolchain: allow } : d));
    try {
      await backendFetch('/api/toolchain/settings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowSystemToolchain: allow }),
      });
    } catch { /* best-effort */ }
    refresh();
  }, [refresh]);

  if (!open) return null;

  const toolById = new Map((data?.tools ?? []).map((t) => [t.id, t]));
  const isMac = data?.platform === 'darwin';

  const toggleGuide = (id: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  /** One status pill: green ✓ present, amber ⟳ present-but-stale (update due), grey ✗ missing. */
  const StatusPill = ({ present, version, stale }: { present: boolean; version?: string; stale?: boolean }) => (
    <span style={{ color: !present ? '#e07a5a' : stale ? '#e0a030' : '#2ecc71', fontSize: 11, minWidth: 110, textAlign: 'right' }}>
      {!present ? '✗ not found' : `${stale ? '⟳' : '✓'} ${version ? version.split('\n')[0].slice(0, 22) : 'installed'}${stale ? ' (update)' : ''}`}
    </span>
  );

  const busy = !!installing || !!removing;
  const renderToolRow = (t: ToolStatus, disabled: boolean) => {
    const guided = !t.installable; // only Xcode today; installable tools get a button
    const needsAction = !t.present || !!t.stale; // missing OR a pinned tool that's out of date
    const showInstall = needsAction && t.installable && !disabled;
    const showGuide = !t.present && guided && !disabled;
    // Removable = present AND provisioned into OUR toolchain (path under toolchainDir) — NOT a
    // bundled tool (toktx ships read-only inside the .app, path outside toolchainDir → excluded),
    // NOT a system PATH tool (Xcode / a dev's own install), and NOT Core/npm (essential + auto-
    // re-provisioned on launch; deleting it per-tool would break npm mid-session — the "Remove all
    // tools" reset still clears it).
    const removable = t.present && t.id !== 'npm' && !!t.path && !!data?.toolchainDir && t.path.startsWith(data.toolchainDir);
    return (
      <div key={t.id}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid #2a2a3a', fontSize: 11 }}>
          <span style={{ flex: 1, color: '#ddd' }}>{label(t.id)}</span>
          <StatusPill present={t.present} version={t.version} stale={t.stale} />
          {showInstall && (
            <button onClick={() => installTool(t.id)} disabled={busy} style={btn({
              background: busy ? '#2a2a3a' : '#2a4a2a', borderColor: '#3a6a3a',
              color: busy ? '#888' : '#fff', cursor: busy ? 'default' : 'pointer', minWidth: 84,
            })}>
              {installing === t.id ? (t.stale ? 'Updating…' : 'Installing…') : t.stale ? 'Update' : 'Install'}
            </button>
          )}
          {showGuide && (
            <button onClick={() => toggleGuide(t.id)} style={btn({ minWidth: 84 })}>
              {expanded.has(t.id) ? 'Hide guide' : 'How to…'}
            </button>
          )}
          {removable ? (
            <button onClick={() => uninstallTool(t.id)} disabled={busy} title={`Remove ${label(t.id)} from the editor toolchain`} style={btn({
              minWidth: 84, borderColor: '#5a3a3a', background: busy ? '#2a2a3a' : '#3a2020',
              color: busy ? '#888' : '#e0a0a0', cursor: busy ? 'default' : 'pointer',
            })}>
              {removing === t.id ? 'Removing…' : '✕ Delete'}
            </button>
          ) : (!showInstall && !showGuide && <span style={{ minWidth: 84 }} />)}
        </div>
        {showGuide && expanded.has(t.id) && (
          <div style={{ padding: '8px 14px 10px', background: '#181828', borderBottom: '1px solid #2a2a3a', fontSize: 11, color: '#bbb' }}>
            <div style={{ color: '#ddd', marginBottom: 6 }}>{t.guide.title}</div>
            <ol style={{ margin: '0 0 6px', paddingLeft: 18, lineHeight: 1.5 }}>
              {t.guide.steps.map((s, i) => <li key={i}>{s}</li>)}
            </ol>
            {t.guide.links?.map((lnk) => (
              <a key={lnk.url} href={lnk.url} target="_blank" rel="noreferrer" style={{ color: '#5aa0e0', marginRight: 12 }}>{lnk.label} ↗</a>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    // Backdrop does NOT close on click — the dialog is dismissed only via the Close button (and never
    // while an install/remove is in flight). A stray outside click shouldn't lose your place mid-setup.
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{
        position: 'relative',
        background: '#1e1e30', border: '1px solid #555', borderRadius: 6, padding: '16px 20px',
        minWidth: 560, maxWidth: 680, maxHeight: '84vh', display: 'flex', flexDirection: 'column', fontFamily: 'monospace',
      }}>
        <style>{'@keyframes modoki-indeterminate{0%{transform:translateX(-110%)}100%{transform:translateX(320%)}}'}</style>
        {/* Modal progress — while installing/removing, a centered card BLOCKS all input in the dialog
            (nothing else is clickable) and shows the indeterminate bar + live log until it finishes. */}
        {busy && (
          <div onClick={(e) => e.stopPropagation()} style={{ position: 'absolute', inset: 0, zIndex: 20, cursor: 'wait', background: 'rgba(10,10,20,0.62)', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
            <div style={{ background: '#1a1a2c', border: '1px solid #3a3a55', borderRadius: 6, padding: '18px 22px', minWidth: 340, maxWidth: 460, boxShadow: '0 8px 30px rgba(0,0,0,0.5)' }}>
              <div style={{ color: '#cdd', fontSize: 12, marginBottom: 9 }}>
                {installing ? `Installing ${label(installing)}…` : removing === 'all' ? 'Removing all tools…' : `Removing ${label(removing!)}…`}
              </div>
              <div style={{ height: 6, borderRadius: 3, background: '#2a2a3a', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: '35%', borderRadius: 3, background: removing ? 'linear-gradient(90deg,#a04a4a,#e08080)' : 'linear-gradient(90deg,#3a6fb0,#5aa0e0)', animation: 'modoki-indeterminate 1.15s ease-in-out infinite' }} />
              </div>
              <div style={{ color: '#777', fontSize: 10, marginTop: 8 }}>{installing ? 'This can take a minute — downloading + installing. Please wait…' : 'Working…'}</div>
              {log.length > 0 && (
                <div style={{ marginTop: 10, maxHeight: 120, overflowY: 'auto', fontSize: 10 }}>
                  {log.slice(-8).map((l, i) => <div key={i} style={{ color: l.startsWith('❌') ? '#e74c3c' : l.startsWith('✅') ? '#2ecc71' : '#9a9', whiteSpace: 'pre-wrap' }}>{l}</div>)}
                </div>
              )}
            </div>
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
          <div style={{ color: '#fff', fontSize: 13 }}>Build Support</div>
          <button onClick={refresh} disabled={loading} style={btn({ padding: '2px 10px' })}>{loading ? 'Checking…' : 'Re-check'}</button>
        </div>
        <div style={{ color: '#888', fontSize: 11, marginBottom: 8 }}>
          Toolchain the editor uses to build native apps. Missing tools install on demand
          (or, for Xcode, follow the guide). Node auto-installs — the rest are optional modules.
        </div>
        {data?.toolchainDir && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12, color: '#9a9ac0', fontSize: 11, cursor: 'pointer' }}
            title="Off (default): build ONLY with the tools the editor installs here — a tool already on your machine (PATH, JAVA_HOME, ANDROID_HOME, Android Studio's SDK) is ignored, so builds don't depend on what happens to be installed. On: fall back to those system installs when the editor doesn't have its own. Xcode is always taken from the system (it can't be bundled).">
            <input type="checkbox" checked={!!data.allowSystemToolchain} onChange={(e) => setSystemToolchain(e.target.checked)} />
            Use system-installed tools when available
            <span style={{ color: '#666' }}>— off = the editor&apos;s own installs only</span>
          </label>
        )}

        {loading && !data ? (
          <div style={{ color: '#888', fontSize: 12, padding: '20px 0' }}>Checking toolchain…</div>
        ) : error && !data ? (
          <div style={{ color: '#e74c3c', fontSize: 12, padding: '12px 0', whiteSpace: 'pre-wrap' }}>{error}</div>
        ) : (
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {GROUPS.map((g) => {
              const gTools = g.ids.map((id) => toolById.get(id)).filter((t): t is ToolStatus => !!t);
              if (gTools.length === 0 && !g.adb) return null;
              const iosBlocked = g.iosOnly && !isMac;
              return (
                <div key={g.title} style={{ marginBottom: 14 }}>
                  <div style={{ color: '#9a9ac0', fontSize: 11, marginBottom: 2 }}>{g.title}</div>
                  <div style={{ color: '#666', fontSize: 10, marginBottom: 4 }}>{g.subtitle}</div>
                  <div style={{ border: '1px solid #333', borderRadius: 4, overflow: 'hidden' }}>
                    {iosBlocked ? (
                      <div style={{ padding: '8px 10px', fontSize: 11, color: '#e0a030' }}>
                        iOS apps can only be built on macOS — not available on this machine ({data?.platform}).
                      </div>
                    ) : (
                      <>
                        {gTools.map((t) => renderToolRow(t, false))}
                        {g.adb && data && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', fontSize: 11 }}>
                            <span style={{ flex: 1, color: '#ddd' }}>{label('adb')}</span>
                            <StatusPill present={data.adb.present} />
                            <span style={{ minWidth: 84, color: '#666', textAlign: 'right', fontSize: 10 }}>
                              {data.adb.present ? '' : 'ships with SDK'}
                            </span>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            })}

            {/* Persistent log AFTER an operation (the live progress is the modal above during busy). */}
            {!busy && log.length > 0 ? (
              <div style={{ marginTop: 8, border: '1px solid #333', borderRadius: 4, background: '#12121e', padding: '6px 12px 8px', maxHeight: 140, overflowY: 'auto' }}>
                {log.map((line, i) => (
                  <div key={i} style={{ color: line.startsWith('❌') ? '#e74c3c' : line.startsWith('✅') ? '#2ecc71' : '#9a9', fontSize: 10, whiteSpace: 'pre-wrap' }}>{line}</div>
                ))}
              </div>
            ) : null}

            {data && !data.toolchainDir && (
              <div style={{ marginTop: 8, color: '#e0a030', fontSize: 10 }}>
                No toolchain directory configured (dev editor). Tool installs run in the packaged editor;
                to enable them in dev, launch with MODOKI_PROVISION_NODE=1 and MODOKI_TOOLCHAIN_DIR set.
              </div>
            )}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', marginTop: 14 }}>
          {data?.toolchainDir && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginRight: 'auto', color: '#888', fontSize: 11, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={autoShowDisabled}
                onChange={(e) => {
                  const v = e.target.checked;
                  setAutoShowDisabled(v);
                  if (v) localStorage.setItem('modoki.buildSupportDismissed', '1');
                  else localStorage.removeItem('modoki.buildSupportDismissed');
                }}
              />
              Don&apos;t show automatically on startup
            </label>
          )}
          {data?.toolchainDir && (
            <button
              onClick={() => {
                if (busy) return;
                if (!confirmRemoveAll) { setConfirmRemoveAll(true); return; }
                setConfirmRemoveAll(false);
                autoInstalledRef.current.clear(); // a full reset can re-trigger onboarding installs
                uninstallTool('all', 'all tools');
              }}
              onMouseLeave={() => setConfirmRemoveAll(false)}
              disabled={busy}
              title="Delete the entire toolchain folder (Node, JDK, Android SDK, model tools, Ruby/CocoaPods). Re-provisions on demand."
              style={btn({ marginRight: 8, borderColor: '#5a3a3a', background: busy ? '#2a2a3a' : '#3a2020', color: busy ? '#888' : '#e0a0a0', cursor: busy ? 'default' : 'pointer' })}
            >
              {removing === 'all' ? 'Removing…' : confirmRemoveAll ? 'Click again to confirm' : '✕ Remove all tools'}
            </button>
          )}
          <button onClick={close} style={btn()}>Close</button>
        </div>
      </div>
    </div>
  );
}

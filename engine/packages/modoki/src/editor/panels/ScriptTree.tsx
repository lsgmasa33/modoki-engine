/**
 * ScriptTree — the Assets-panel "Scripts" + "Engine" sections (Phase C of the
 * in-browser code editor). Self-contained on purpose: scripts are NOT asset-
 * manifest entries (no GUID/.meta.json), so they deliberately bypass the asset
 * folder/category machinery (drag-drop, context menus, sprites) and render their
 * own lightweight collapsible tree from /api/scripts/tree. Modoki has no in-app
 * code editor — clicking a file REVEALS it in the OS file manager
 * (/api/reveal-in-finder) so the user opens it in their own editor (VS Code, …)
 * and/or drives it with their own Claude Code (see docs/connect-claude-code.md).
 *
 * Two roots: the project working copy (writable) and the engine source
 * (read-only). Re-fetches on the Assets panel's refresh (assetsVersion).
 */

import { useEffect, useMemo, useState } from 'react';
import { backendFetch } from '../backend/editorBackend';
import { useEditorStore } from '../store/editorStore';
import { AssetTypeGlyph } from './assetTypeIcons';
import { SectionHeader, TreeFolderRow, treeRowPadLeft as rowPadLeft } from './treeChrome';
import { useExpandedSet } from './useExpandedSet';

/** POST a path to a backend action, logging a clear error if it fails (the
 *  backend can 403 an out-of-root path or 500 if the OS opener errors — a silent
 *  fire-and-forget would leave a failed click with no feedback). */
async function postPath(endpoint: string, filePath: string): Promise<void> {
  try {
    const r = await backendFetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath }),
    });
    if (!r.ok) {
      const detail = await r.json().catch(() => ({}));
      console.error(`[ScriptTree] ${endpoint} failed (${r.status})`, (detail as { error?: string }).error ?? '', filePath);
    }
  } catch (e) {
    console.error(`[ScriptTree] ${endpoint} request failed`, e, filePath);
  }
}

/** Open a script in the OS default editor (whatever app is associated with the
 *  file type — e.g. VS Code for .ts). This is the primary click action. */
function openScriptFile(filePath: string): void {
  void postPath('/api/open-file', filePath);
}

/** Reveal a script in the OS file manager (Alt-click fallback). */
function revealScript(filePath: string): void {
  void postPath('/api/reveal-in-finder', filePath);
}

interface ScriptFile { rel: string; path: string; name: string }
interface ScriptRoot { label: string; rootPath: string; writable: boolean; files: ScriptFile[] }

interface DirNode { dirs: Map<string, DirNode>; files: { path: string; name: string }[] }
const emptyDir = (): DirNode => ({ dirs: new Map(), files: [] });

function buildTree(files: ScriptFile[]): DirNode {
  const root = emptyDir();
  for (const f of files) {
    const parts = f.rel.split('/');
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = cur.dirs.get(parts[i]);
      if (!next) { next = emptyDir(); cur.dirs.set(parts[i], next); }
      cur = next;
    }
    cur.files.push({ path: f.path, name: f.name });
  }
  return root;
}

/** Every folder key in a subtree (for Option/Alt-click expand/collapse all).
 *  Keys mirror the render: `${keyPrefix}/${name}` chains. */
function collectDirKeys(node: DirNode, keyPrefix: string, out: string[] = []): string[] {
  for (const name of node.dirs.keys()) {
    const key = `${keyPrefix}/${name}`;
    out.push(key);
    collectDirKeys(node.dirs.get(name)!, key, out);
  }
  return out;
}

// Default-expand the Scripts root AND its `runtime/` folder — that's the game's
// own code, so it should be visible without a click; packages/ stays collapsed.
// Key is bumped (…:v2) so this new default lands even where an older set was saved.
const DEFAULT_EXPANDED = ['Scripts', 'Scripts/runtime'];
const LS_EXPANDED = 'editor:scripts:expanded:v2';

// Engine source is a read-only reference tree — hidden by default; opt in via the checkbox.
const LS_SHOW_ENGINE = 'editor:scripts:showEngine';
function loadShowEngine(): boolean {
  try { return localStorage.getItem(LS_SHOW_ENGINE) === '1'; } catch { return false; }
}

const ROW = { display: 'flex', alignItems: 'center', gap: 5, padding: '2px 8px', cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap' as const, userSelect: 'none' as const };

export default function ScriptTree({ filter = '', hidden = false, onCount }: { filter?: string; hidden?: boolean; onCount?: (n: number) => void }) {
  const [roots, setRoots] = useState<ScriptRoot[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { expanded, toggle, toggleMany } = useExpandedSet(LS_EXPANDED, DEFAULT_EXPANDED);
  const [showEngine, setShowEngine] = useState<boolean>(loadShowEngine);
  const assetsVersion = useEditorStore((s) => s.assetsVersion);
  const q = filter.trim().toLowerCase();
  const searching = q.length > 0;

  useEffect(() => {
    let cancelled = false;
    backendFetch('/api/scripts/tree')
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((data: { roots: ScriptRoot[] }) => { if (!cancelled) { setRoots(data.roots ?? []); setError(null); } })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [assetsVersion]);

  // Report the total script count up so the Assets panel can offer a "script"
  // type-filter chip (scripts aren't asset-manifest entries, so the parent can't
  // count them itself). Total across all roots, independent of the search /
  // showEngine filters, so the chip count is stable.
  const totalScripts = roots.reduce((n, r) => n + r.files.length, 0);
  useEffect(() => { onCount?.(totalScripts); }, [totalScripts, onCount]);

  // Option/Alt-click: expand or collapse `key` and every folder under it at once.
  const toggleAll = (key: string, descendants: string[]) => toggleMany([key, ...descendants], key);

  const toggleShowEngine = () => setShowEngine((prev) => {
    const next = !prev;
    try { localStorage.setItem(LS_SHOW_ENGINE, next ? '1' : '0'); } catch { /* ignore */ }
    return next;
  });

  // Engine source is the read-only reference root — surfaced only when opted in.
  const isEngineRoot = (r: ScriptRoot) => !r.writable;
  const hasEngine = roots.some(isEngineRoot);
  // When searching, filter files by the query (path or name) and drop roots with
  // no matches; the section/dirs render fully expanded so every hit is visible.
  const trees = useMemo(() =>
    roots
      .filter((r) => showEngine || !isEngineRoot(r))
      .map((r) => {
        const files = searching ? r.files.filter((f) => f.rel.toLowerCase().includes(q)) : r.files;
        return { root: r, files, tree: buildTree(files) };
      })
      .filter(({ files }) => !searching || files.length > 0),
  [roots, showEngine, searching, q]);

  const renderDir = (node: DirNode, keyPrefix: string, writable: boolean, depth: number) => {
    const dirNames = [...node.dirs.keys()].sort((a, b) => a.localeCompare(b));
    const files = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
    return (
      <>
        {dirNames.map((name) => {
          const key = `${keyPrefix}/${name}`;
          const child = node.dirs.get(name)!;
          const open = searching || expanded.has(key);
          return (
            <div key={key}>
              <TreeFolderRow
                name={name} depth={depth} open={open}
                onToggle={(e) => { if (e.altKey) toggleAll(key, collectDirKeys(child, key)); else toggle(key); }}
              />
              {open && renderDir(child, key, writable, depth + 1)}
            </div>
          );
        })}
        {files.map((f) => {
          return (
            <div
              key={f.path}
              onClick={(e) => (e.altKey ? revealScript(f.path) : openScriptFile(f.path))}
              title={f.path.replace(/^\/@fs/, '') + (writable ? '' : '  (read-only)') + '\nClick: open in your default editor · Alt-click: reveal in file manager'}
              style={{ ...ROW, paddingLeft: rowPadLeft(depth), color: '#cbd2d9' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#23233a'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
            >
              <span style={{ width: 10 }} />
              <span style={{ color: '#9aa7b4', display: 'flex' }}><AssetTypeGlyph type="script" size={13} /></span>
              <span>{f.name}</span>
            </div>
          );
        })}
      </>
    );
  };

  // Hidden by an active type filter that doesn't include 'script' — render nothing,
  // but keep the hooks above running so the fetch + onCount still report the count
  // (so the parent can always offer the 'script' chip to bring the section back).
  if (hidden) return null;

  return (
    <div style={{ borderTop: '1px solid #333' }}>
      {trees.map(({ root, files, tree }) => {
        const open = searching || expanded.has(root.label);
        return (
          <div key={root.label}>
            <SectionHeader
              label={root.label}
              count={files.length}
              open={open}
              onToggle={(e) => { if (e.altKey) toggleAll(root.label, collectDirKeys(tree, root.label)); else toggle(root.label); }}
              tag={root.writable ? undefined : 'read-only'}
            />
            {open && (files.length === 0
              ? <div style={{ padding: '4px 8px 4px 20px', color: '#555', fontSize: 11 }}>No scripts</div>
              : renderDir(tree, root.label, root.writable, 1))}
          </div>
        );
      })}
      {hasEngine && (
        <label
          title="Show the engine's own source (read-only reference)"
          style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 8px', cursor: 'pointer', fontSize: 11, color: '#888', userSelect: 'none' }}
        >
          <input type="checkbox" checked={showEngine} onChange={toggleShowEngine} style={{ cursor: 'pointer', margin: 0 }} />
          Show Engine source
        </label>
      )}
      {error && <div style={{ padding: '4px 8px', color: '#a55', fontSize: 11 }}>Scripts unavailable: {error}</div>}
    </div>
  );
}

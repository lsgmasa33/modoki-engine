/** Scene build-list editor — the widget behind the 'scene-list' Project Settings
 *  field. Edits `SceneEntry[]` ({ guid, include }): an ordered checklist of the
 *  project's scenes. Order + include come from the value; the universe of scenes
 *  is discovered on disk and passed in as `options` ({ value: guid, label }).
 *  The FIRST included scene is the project's boot scene (shown with a BOOT badge).
 *  Scenes found on disk but absent from the value are appended (included).
 *
 *  `options` is discovered ONCE, at editor setup (`/api/scenes` in
 *  `engine/app/editor/setup.ts`), and baked into the static Project Settings schema — so on
 *  its own it can only ever describe the scenes that existed when the app BOOTED. A scene
 *  authored live (New Scene → Save As) was therefore invisible here until a relaunch, with no
 *  error: measured on games/anim-bug, where `modoki_list_assets {type:'scene'}` and the file on
 *  disk both showed the new scene while this dialog listed only the boot-time one (QA-DLG-0005).
 *  So the universe is taken from the LIVE asset manifest — the same source `list_assets` reads,
 *  kept current by the editor's own asset refresh — and `options` supplies the labels plus the
 *  fallback for any environment where the manifest is not populated (tests, a bare host). */

export interface SceneEntry {
  guid: string;
  include: boolean;
}

import { getAllAssets } from '../../runtime/loaders/assetManifest';

type Option = { value: string; label: string };

/** The scenes that exist RIGHT NOW: the live asset manifest, labelled by file name, with the
 *  boot-time `options` merged in — its labels win (the host built them from the backend's own
 *  paths), and it is the whole answer when the manifest is empty. Deliberately not memoized:
 *  the dialog mounts on open, which is exactly when the answer must be re-read. */
export function discoverScenes(options: Option[]): Option[] {
  const out: Option[] = [];
  const seen = new Set<string>();
  for (const o of options) { if (!seen.has(o.value)) { seen.add(o.value); out.push(o); } }
  for (const a of getAllAssets()) {
    if (a.type !== 'scene' || !a.guid || seen.has(a.guid)) continue;
    seen.add(a.guid);
    out.push({ value: a.guid, label: a.path.split('/').pop() || a.path });
  }
  return out;
}

const row: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px',
  border: '1px solid #333', borderRadius: 3, background: '#15151f', marginBottom: 4,
};
const smallBtn: React.CSSProperties = {
  padding: '1px 7px', border: '1px solid #555', borderRadius: 3, background: '#2a2a40',
  color: '#ccc', cursor: 'pointer', fontFamily: 'monospace', fontSize: 12, lineHeight: '16px',
};
const bootBadge: React.CSSProperties = {
  fontSize: 9, fontWeight: 'bold', color: '#8fd', border: '1px solid #295', borderRadius: 3,
  padding: '0 4px', letterSpacing: 0.5,
};

/** Merge the persisted entries with the discovered scenes: keep value order for
 *  known guids, drop stale guids (scene deleted on disk), append newly-discovered
 *  scenes as included. */
function merge(value: unknown, options: Option[]): SceneEntry[] {
  const known = new Map(options.map((o) => [o.value, o]));
  const seen = new Set<string>();
  const out: SceneEntry[] = [];
  for (const e of Array.isArray(value) ? (value as SceneEntry[]) : []) {
    if (e && typeof e.guid === 'string' && known.has(e.guid) && !seen.has(e.guid)) {
      out.push({ guid: e.guid, include: e.include !== false });
      seen.add(e.guid);
    }
  }
  for (const o of options) {
    if (!seen.has(o.value)) out.push({ guid: o.value, include: true });
  }
  return out;
}

export default function SceneListEditor({ value, options, onChange }: {
  value: unknown;
  options: Option[];
  onChange: (v: SceneEntry[]) => void;
}) {
  const discovered = discoverScenes(options);
  const entries = merge(value, discovered);
  const labelFor = new Map(discovered.map((o) => [o.value, o.label]));
  const firstIncluded = entries.findIndex((e) => e.include);

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= entries.length) return;
    const next = entries.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const toggle = (i: number) => {
    const next = entries.slice();
    next[i] = { ...next[i], include: !next[i].include };
    onChange(next);
  };

  if (entries.length === 0) {
    return <div style={{ color: '#888', fontSize: 12 }}>No scenes found under a <code style={{ color: '#aaa' }}>scenes/</code> folder yet.</div>;
  }

  return (
    <div style={{ color: '#ddd', fontSize: 12 }}>
      <div style={{ color: '#aaa', fontSize: 11, marginBottom: 6 }}>
        Scenes bundled into the build
        <span style={{ color: '#666', marginLeft: 6 }}>first checked = boot scene</span>
      </div>
      {entries.map((e, i) => (
        <div key={e.guid} style={row}>
          <input type="checkbox" checked={e.include} onChange={() => toggle(i)} title="Include in build" />
          <span style={{ flex: 1, color: e.include ? '#ddd' : '#666', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            title={labelFor.get(e.guid) ?? e.guid}>
            {labelFor.get(e.guid) ?? e.guid}
          </span>
          {i === firstIncluded && <span style={bootBadge}>BOOT</span>}
          <button style={{ ...smallBtn, opacity: i === 0 ? 0.4 : 1 }} disabled={i === 0} title="Move up" onClick={() => move(i, -1)}>↑</button>
          <button style={{ ...smallBtn, opacity: i === entries.length - 1 ? 0.4 : 1 }} disabled={i === entries.length - 1} title="Move down" onClick={() => move(i, 1)}>↓</button>
        </div>
      ))}
    </div>
  );
}

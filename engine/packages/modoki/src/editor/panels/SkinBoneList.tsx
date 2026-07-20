/** Skin-panel bone hierarchy — the rig's bones as a depth-indented tree (click to select,
 *  drag a row onto another to re-parent). The per-bone transform inspector now lives in the
 *  unified inspector beside the canvas (SkinEditor). Reparent is one undo entry. */

import { useCallback } from 'react';
import { useEditorStore } from '../store/editorStore';
import { reparentBone } from '../../runtime/skinning/rig2dEdit';
import { pushAction } from '../undo/undoManager';
import { type Rig2DFile } from '../../runtime/loaders/rig2dCache';

type Bone = { name: string; parent: number };
function coerce(raw: Rig2DFile['bones']): Bone[] {
  return (raw ?? []).map((b, i) => ({ name: b.name ?? `bone${i}`, parent: b.parent ?? -1 }));
}

export default function SkinBoneList({ selBone, setSelBone }: { selBone: number; setSelBone: (i: number) => void }) {
  const def = useEditorStore((s) => s.editingSkinDef);
  useEditorStore((s) => s.skinEditNonce); // re-render when the rig changes

  const commitDef = useCallback((next: Rig2DFile, label: string) => {
    const store = useEditorStore.getState();
    const before = store.editingSkinDef;
    const path = store.editingSkinAsset?.path;
    if (!before || !path || next === before) return;
    pushAction({ label: `rig2d ${label}`, undo: () => useEditorStore.getState().applySkinDef(path, before), redo: () => useEditorStore.getState().applySkinDef(path, next) });
    store.applySkinDef(path, next);
  }, []);

  const onReparent = useCallback((child: number, newParent: number) => {
    const cur = useEditorStore.getState().editingSkinDef;
    if (cur) commitDef(reparentBone(cur, child, newParent), 'reparent bone');
  }, [commitDef]);

  if (!def) return null;
  const bones = coerce(def.bones);

  // Depth-ordered rows (DFS from roots).
  const rows: { i: number; depth: number }[] = [];
  const walk = (parent: number, depth: number) => {
    for (let i = 0; i < bones.length; i++) if (bones[i].parent === parent) { rows.push({ i, depth }); walk(i, depth + 1); }
  };
  walk(-1, 0);
  // Any bones with a broken parent index still show at root so they're reachable.
  for (let i = 0; i < bones.length; i++) if (!rows.some((r) => r.i === i)) rows.push({ i, depth: 0 });

  const dragBone = (e: React.DragEvent): number => { const v = +e.dataTransfer.getData('application/skin-bone'); return Number.isNaN(v) ? -1 : v; };

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, minHeight: 60, overflowY: 'auto', border: '1px solid #2a2a3a', borderRadius: 4, background: '#141420' }}>
        {rows.length === 0 && <div style={{ color: '#666', padding: 5 }}>No bones</div>}
        {rows.map(({ i, depth }) => (
          <div
            key={i}
            draggable
            onDragStart={(e) => e.dataTransfer.setData('application/skin-bone', String(i))}
            onDragOver={(e) => { if (e.dataTransfer.types.includes('application/skin-bone')) e.preventDefault(); }}
            onDrop={(e) => { e.preventDefault(); const c = dragBone(e); if (c >= 0 && c !== i) onReparent(c, i); }}
            onClick={() => setSelBone(i)}
            title="Drag onto another bone to re-parent"
            style={{ paddingLeft: 6 + depth * 14, paddingRight: 6, height: 20, lineHeight: '20px', cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: i === selBone ? '#cde' : '#bbb', background: i === selBone ? '#20303f' : 'transparent', fontSize: 11 }}
          >
            {depth > 0 ? '↳ ' : ''}{bones[i].name}
          </div>
        ))}
        {/* Drop into empty space → re-parent to root. */}
        <div onDragOver={(e) => { if (e.dataTransfer.types.includes('application/skin-bone')) e.preventDefault(); }} onDrop={(e) => { e.preventDefault(); const c = dragBone(e); if (c >= 0) onReparent(c, -1); }} style={{ height: 14 }} />
      </div>
    </div>
  );
}

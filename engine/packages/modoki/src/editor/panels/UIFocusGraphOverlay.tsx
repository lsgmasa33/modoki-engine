/** UIFocusGraphOverlay — visualizes the UIFocusable navigation graph in the 2D
 *  SceneView (the optional focus-graph authoring aid — see the focus-navigation section of docs/ui-system.md).
 *
 *  Purely a VISUALIZATION — it never edits. For every focusable currently rendered
 *  in the UI preview it draws, per direction (up/down/left/right):
 *    • a SOLID arrow for an explicit hand-authored `navUp/navDown/navLeft/navRight`
 *      link (only when the target is a live, same-scope focusable — matching the
 *      runtime), and
 *    • a DASHED arrow for the spatial fallback the runtime WOULD pick when no
 *      explicit link exists, computed with the SAME `pickInDirection` the
 *      `uiFocusSystem` uses — so what you see is exactly where a controller/keyboard
 *      would move focus.
 *  Each focusable also gets a `focusOrder` badge and, if `autoFocus`, a gold ring
 *  (the entry point when the scene's UI first gains focus).
 *
 *  Rendered INSIDE `[data-ui-preview-frame]` at `inset:0`, so it shares the frame's
 *  logical device coordinate space (the frame itself is CSS-scaled to fit). Rects
 *  are read from the live UIRenderer DOM (`[data-entity-id]`) and converted to that
 *  logical space with `frameToLogicalRect` — the same approach as UIResizeOverlay.
 *  DOM presence doubles as the visibility gate: a pruned/invisible focusable isn't
 *  in the DOM, so it's skipped, mirroring `gatherCandidates`. */

import { useEffect, useState } from 'react';
import { getCurrentWorld } from '../../runtime/ecs/worldRegistry';
import { UIFocusable } from '../../runtime/traits/UIFocusable';
import { EntityAttributes } from '../../runtime/traits/EntityAttributes';
import { onEditorDirty, useUITreeStore } from '../../runtime/ui/uiTreeStore';
import { pickInDirection, type NavDir } from '../../runtime/ui/focusManager';
import type { ScreenRect } from '../../runtime/rendering/screenBounds';
import { frameToLogicalRect } from '../scene/uiResizeMath';
import { useEditorStore } from '../store/editorStore';

const DIRS: NavDir[] = ['up', 'down', 'left', 'right'];

interface LRect { left: number; top: number; width: number; height: number }
interface FNode {
  guid: string;
  entityId: number;
  order: number;
  autoFocus: boolean;
  scope: string;
  nav: Record<NavDir, string>;
  rect: LRect;
}
interface FEdge { x1: number; y1: number; x2: number; y2: number; explicit: boolean; key: string }

const EXPLICIT = '#2effa6';
const SPATIAL = '#58a6ff';
const AUTO_RING = '#ffd54a';
const PERP_OFFSET = 4; // separate the two arrows of a bidirectional pair

function toScreen(r: LRect): ScreenRect { return { x: r.left, y: r.top, w: r.width, h: r.height }; }
function centerOf(r: LRect) { return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }

/** Point on `rect`'s border in the direction of `toward`, from the rect center —
 *  so an arrow ends AT the box edge, not hidden inside it. */
function borderPoint(rect: LRect, toward: { x: number; y: number }) {
  const c = centerOf(rect);
  const dx = toward.x - c.x, dy = toward.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const tx = dx !== 0 ? (rect.width / 2) / Math.abs(dx) : Infinity;
  const ty = dy !== 0 ? (rect.height / 2) / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty);
  return { x: c.x + dx * t, y: c.y + dy * t };
}

/** Gather every rendered focusable + its logical rect, then resolve edges exactly
 *  as the runtime would (explicit same-scope link, else spatial pickInDirection). */
function buildGraph(): { nodes: FNode[]; edges: FEdge[] } {
  const frame = document.querySelector('[data-ui-preview-frame]') as HTMLElement | null;
  if (!frame) return { nodes: [], edges: [] };
  const fr = frame.getBoundingClientRect();
  const world = getCurrentWorld();
  const logW = useEditorStore.getState().gameViewSize.width || 390;

  const nodes: FNode[] = [];
  world.query(UIFocusable, EntityAttributes).updateEach(([f, attrs]: any[], entity: any) => {
    if (!f.focusable) return;
    const id = entity.id();
    const el = frame.querySelector(`[data-entity-id="${id}"]`) as HTMLElement | null;
    if (!el) return; // not rendered (pruned/invisible) → not a live candidate
    const rect = frameToLogicalRect(el.getBoundingClientRect(), fr, logW);
    nodes.push({
      guid: attrs.guid || '', entityId: id, order: f.focusOrder ?? 0,
      autoFocus: !!f.autoFocus, scope: f.focusScope || '',
      nav: { up: f.navUp || '', down: f.navDown || '', left: f.navLeft || '', right: f.navRight || '' },
      rect,
    });
  });

  const byGuid = new Map<string, FNode>();
  for (const n of nodes) if (n.guid) byGuid.set(n.guid, n);

  const edges: FEdge[] = [];
  for (const n of nodes) {
    const scoped = nodes.filter((m) => m.scope === n.scope && m.guid !== n.guid);
    for (const dir of DIRS) {
      let target: FNode | undefined;
      let explicit = false;
      const linked = n.nav[dir];
      if (linked && scoped.some((m) => m.guid === linked)) { target = byGuid.get(linked); explicit = true; }
      else {
        const cands = scoped.filter((m) => m.guid).map((m) => ({ guid: m.guid, rect: toScreen(m.rect) }));
        const g = pickInDirection(toScreen(n.rect), cands, dir);
        if (g) target = byGuid.get(g);
      }
      if (!target || target === n) continue;

      const a = borderPoint(n.rect, centerOf(target.rect));
      const b = borderPoint(target.rect, centerOf(n.rect));
      // Nudge perpendicular so A→B and B→A don't draw on top of each other.
      const vx = b.x - a.x, vy = b.y - a.y;
      const len = Math.hypot(vx, vy) || 1;
      const ox = (-vy / len) * PERP_OFFSET, oy = (vx / len) * PERP_OFFSET;
      edges.push({
        x1: a.x + ox, y1: a.y + oy, x2: b.x + ox, y2: b.y + oy,
        explicit, key: `${n.guid}:${dir}:${target.guid}`,
      });
    }
  }
  return { nodes, edges };
}

/** Overlay: draws the nav graph. Recomputes on UI-tree commits, panel/device
 *  resize, and window resize (deferred to rAF so DOM rects are read post-layout). */
export function UIFocusGraphOverlay() {
  const gameViewSize = useEditorStore((s) => s.gameViewSize);
  // Re-run after React commits a fresh UIRenderer pass (a moved/edited button
  // repositions its arrows). onEditorDirty fires synchronously during the ECS
  // write — too early to measure — so we also key on the committed tree + rAF.
  const tree = useUITreeStore((s) => s.tree);
  const [graph, setGraph] = useState<{ nodes: FNode[]; edges: FEdge[] }>({ nodes: [], edges: [] });

  useEffect(() => {
    let pending = false;
    const update = () => setGraph(buildGraph());
    const schedule = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; update(); });
    };
    update();
    const unsubDirty = onEditorDirty(schedule);
    const frame = document.querySelector('[data-ui-preview-frame]') as HTMLElement | null;
    const ro = frame ? new ResizeObserver(schedule) : null;
    if (ro && frame) ro.observe(frame);
    window.addEventListener('resize', schedule);
    return () => { unsubDirty(); ro?.disconnect(); window.removeEventListener('resize', schedule); };
    // gameViewSize/tree deps: buildGraph reads gameViewSize; tree re-runs after commit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, gameViewSize]);

  const logW = gameViewSize.width || 390;
  const logH = gameViewSize.height || 844;
  if (graph.nodes.length === 0) return null;

  return (
    <svg
      width={logW} height={logH}
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'visible', zIndex: 90000 }}
    >
      <defs>
        <marker id="focusarrow-explicit" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto" markerUnits="userSpaceOnUse">
          <path d="M0,0 L6,3 L0,6 Z" fill={EXPLICIT} />
        </marker>
        <marker id="focusarrow-spatial" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto" markerUnits="userSpaceOnUse">
          <path d="M0,0 L6,3 L0,6 Z" fill={SPATIAL} />
        </marker>
      </defs>

      {graph.edges.map((e) => (
        <line
          key={e.key}
          x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2}
          stroke={e.explicit ? EXPLICIT : SPATIAL}
          strokeWidth={e.explicit ? 2 : 1.5}
          strokeDasharray={e.explicit ? undefined : '5 4'}
          opacity={e.explicit ? 0.95 : 0.75}
          markerEnd={`url(#focusarrow-${e.explicit ? 'explicit' : 'spatial'})`}
        />
      ))}

      {graph.nodes.map((n) => (
        <g key={n.guid || n.entityId}>
          {n.autoFocus && (
            <rect
              x={n.rect.left - 2} y={n.rect.top - 2}
              width={n.rect.width + 4} height={n.rect.height + 4}
              fill="none" stroke={AUTO_RING} strokeWidth={2} strokeDasharray="2 3" rx={4}
            />
          )}
          <circle cx={n.rect.left + 2} cy={n.rect.top + 2} r={9} fill="#12121e" stroke={n.autoFocus ? AUTO_RING : EXPLICIT} strokeWidth={1.5} />
          <text x={n.rect.left + 2} y={n.rect.top + 2} fill="#e8e8f0" fontSize={11} fontFamily="monospace" fontWeight="bold" textAnchor="middle" dominantBaseline="central">{n.order}</text>
        </g>
      ))}

      {/* Legend */}
      <g transform={`translate(8, ${logH - 54})`}>
        <rect x={0} y={0} width={196} height={46} rx={4} fill="#12121ecc" stroke="#333" />
        <line x1={10} y1={14} x2={34} y2={14} stroke={EXPLICIT} strokeWidth={2} />
        <text x={40} y={14} fill="#bbb" fontSize={10} fontFamily="monospace" dominantBaseline="central">explicit link</text>
        <line x1={10} y1={30} x2={34} y2={30} stroke={SPATIAL} strokeWidth={1.5} strokeDasharray="5 4" />
        <text x={40} y={30} fill="#bbb" fontSize={10} fontFamily="monospace" dominantBaseline="central">spatial (auto)</text>
        <circle cx={132} cy={14} r={6} fill="#12121e" stroke={EXPLICIT} strokeWidth={1.5} />
        <text x={144} y={14} fill="#bbb" fontSize={10} fontFamily="monospace" dominantBaseline="central">order</text>
        <rect x={126} y={25} width={12} height={10} fill="none" stroke={AUTO_RING} strokeWidth={1.5} strokeDasharray="2 3" />
        <text x={144} y={30} fill="#bbb" fontSize={10} fontFamily="monospace" dominantBaseline="central">auto</text>
      </g>
    </svg>
  );
}

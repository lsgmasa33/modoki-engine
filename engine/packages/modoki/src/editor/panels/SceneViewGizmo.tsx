/** SceneViewGizmo — the Unity-style orientation gizmo in the SceneView's top-right corner.
 *
 *  A rotating axis tripod that mirrors the live editor camera: each of the six axis cones
 *  (+X/+Y/+Z solid R/G/B, negatives hollow) snaps the orbit camera to that view when clicked
 *  (animated, via the sceneViewBus controller). It has no access to SceneView's closure-scoped
 *  camera, so it READS the live camera object from the bus (`getEditorViewportCamera`) and
 *  COMMANDS snaps through it (`snapEditorViewToAxis`).
 *
 *  Rendering is a tiny SVG driven by its OWN rAF: each frame it reads the camera quaternion and,
 *  only when it actually changed, re-projects the axes and re-renders. That keeps it cheap and
 *  independent of the viewport's idle-gated render loop. The projection/depth-sort math is the
 *  pure `projectGizmoAxis` + `GIZMO_AXES` in sceneViewMath (unit-tested). */

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { getEditorViewportCamera, snapEditorViewToAxis, getEditorProjection, toggleEditorProjection, type EditorProjection } from '../scene/sceneViewBus';
import { GIZMO_AXES, projectGizmoAxis } from '../scene/sceneViewMath';

const SIZE = 72;           // widget box (px)
const R = SIZE / 2;        // center
const ARM = R - 12;        // axis arm length (leaves room for the cone + label)
const CONE = 7;            // cone radius (px)

const AXIS_COLOR: Record<string, string> = {
  '+x': '#e0533f', '-x': '#e0533f',
  '+y': '#7db93f', '-y': '#7db93f',
  '+z': '#3f7fe0', '-z': '#3f7fe0',
};
/** Sentinel for the center projection-hub hover (no axis is named this). */
const HUB_HOVER = 'projection';

export interface Projected { name: string; label: string; dir: THREE.Vector3; x: number; y: number; depth: number; positive: boolean; }

/** Project all six axes for the current camera orientation, in draw order (back-to-front).
 *  Exported for unit testing the painter's-order depth sort. */
export function layoutAxes(quat: THREE.Quaternion): Projected[] {
  const out: Projected[] = GIZMO_AXES.map(({ name, label, dir }) => {
    const d = new THREE.Vector3(dir[0], dir[1], dir[2]);
    const p = projectGizmoAxis(d, quat);
    return {
      name, label, dir: d,
      x: R + p.x * ARM,
      y: R - p.y * ARM, // SVG y grows downward → flip
      depth: p.depth,
      positive: name[0] === '+',
    };
  });
  // Painter's order: smallest depth (farthest from viewer) first.
  return out.sort((a, b) => a.depth - b.depth);
}

export function SceneViewGizmo() {
  const [axes, setAxes] = useState<Projected[]>([]);
  const [hover, setHover] = useState<string | null>(null);
  const [projection, setProjection] = useState<EditorProjection>('perspective');
  const lastQuat = useRef(new THREE.Quaternion(NaN, NaN, NaN, NaN));

  useEffect(() => {
    let raf = 0;
    let lastProj: EditorProjection | null = null;
    const tick = () => {
      const cam = getEditorViewportCamera();
      if (cam && !quatApproxEqual(cam.quaternion, lastQuat.current)) {
        lastQuat.current.copy(cam.quaternion);
        setAxes(layoutAxes(cam.quaternion));
      }
      const proj = getEditorProjection();
      if (proj && proj !== lastProj) { lastProj = proj; setProjection(proj); }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const onSnap = (a: Projected) => {
    // dir is the OFFSET from target toward the camera; clicking +Y looks straight down.
    snapEditorViewToAxis(a.dir);
    // Clear hover explicitly: the snap tween re-lays-out the cones out from under a stationary
    // pointer, and Chromium fires no pointerleave for a scripted move — so the tooltip would
    // otherwise stick on the clicked axis until the next real mouse move.
    setHover(null);
  };

  return (
    <div
      data-ui-id="sceneview.gizmo"
      style={{
        position: 'absolute', top: 8, right: 8, width: SIZE, height: SIZE,
        zIndex: 20, userSelect: 'none', pointerEvents: 'auto',
      }}
    >
      <svg width={SIZE} height={SIZE} style={{ overflow: 'visible' }}>
        {/* Axis stems: only for the front-facing (positive-depth) half, so the tripod reads clean. */}
        {axes.filter(a => a.depth > -0.05 && a.positive).map(a => (
          <line key={`stem-${a.name}`} x1={R} y1={R} x2={a.x} y2={a.y}
            stroke={AXIS_COLOR[a.name]} strokeWidth={2} strokeLinecap="round" opacity={0.9} />
        ))}
        {axes.map(a => {
          const color = AXIS_COLOR[a.name];
          const isHover = hover === a.name;
          const scale = 0.72 + 0.28 * (a.depth * 0.5 + 0.5); // nearer cones a touch larger
          const r = CONE * scale;
          return (
            <g key={a.name}
              data-ui-id={`sceneview.gizmo.axis.${a.name}`}
              data-ui-kind="button"
              data-ui-label={`view ${a.label.toLowerCase()}`}
              style={{ cursor: 'pointer' }}
              onPointerDown={(e) => { e.preventDefault(); onSnap(a); }}
              onPointerEnter={() => setHover(a.name)}
              onPointerLeave={() => setHover(h => (h === a.name ? null : h))}
            >
              {/* generous transparent hit target */}
              <circle cx={a.x} cy={a.y} r={CONE + 5} fill="transparent" />
              <circle cx={a.x} cy={a.y} r={r}
                fill={a.positive ? color : (isHover ? color : '#2a2a3a')}
                stroke={color} strokeWidth={1.5}
                opacity={a.positive ? 1 : 0.95} />
              {a.positive && (
                <text x={a.x} y={a.y} textAnchor="middle" dominantBaseline="central"
                  fontSize={8} fontFamily="monospace" fontWeight="bold" fill="#12121e"
                  style={{ pointerEvents: 'none' }}>
                  {a.name[1].toUpperCase()}
                </text>
              )}
            </g>
          );
        })}
        {/* Center hub = perspective/orthographic toggle (Unity's center cube). Rendered LAST so
            it stays on top of — and clickable over — an axis cone pointing at the viewer in an
            axis-aligned view (which otherwise sits over the center and steals the click). */}
        <g
          data-ui-id="sceneview.gizmo.projection"
          data-ui-kind="button"
          data-ui-label={`projection: ${projection}`}
          style={{ cursor: 'pointer' }}
          onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); toggleEditorProjection(); setHover(null); }}
          // Custom hover label (below) — an SVG <title> tooltip does NOT render in the Electron
          // editor (native-tooltip mechanism; see memory electron-native-title-tooltips-dead).
          onPointerEnter={() => setHover(HUB_HOVER)}
          onPointerLeave={() => setHover(h => (h === HUB_HOVER ? null : h))}
        >
          <rect x={R - 7} y={R - 7} width={14} height={14} rx={2}
            fill={projection === 'orthographic' ? '#3a3a55' : '#2a2a3a'}
            stroke="#8a8aa5" strokeWidth={1.2} />
          <text x={R} y={R} textAnchor="middle" dominantBaseline="central"
            fontSize={8} fontFamily="monospace" fontWeight="bold" fill="#cfcfe5"
            style={{ pointerEvents: 'none' }}>
            {projection === 'orthographic' ? 'O' : 'P'}
          </text>
        </g>
      </svg>
      {hover && (
        <div style={{
          position: 'absolute', top: SIZE + 2, right: 0, whiteSpace: 'nowrap',
          background: '#12121e', color: '#ccc', border: '1px solid #3a3a4a', borderRadius: 3,
          padding: '1px 5px', fontSize: 10, fontFamily: 'monospace', pointerEvents: 'none',
        }}>
          {hover === HUB_HOVER
            ? (projection === 'orthographic' ? 'Orthographic' : 'Perspective')
            : GIZMO_AXES.find(g => g.name === hover)?.label}
        </div>
      )}
    </div>
  );
}

function quatApproxEqual(a: THREE.Quaternion, b: THREE.Quaternion): boolean {
  return Math.abs(a.x - b.x) < 1e-4 && Math.abs(a.y - b.y) < 1e-4
    && Math.abs(a.z - b.z) < 1e-4 && Math.abs(a.w - b.w) < 1e-4;
}

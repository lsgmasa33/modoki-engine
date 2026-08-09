/** Hit-region overlay (#139) — draws the shapes a `hitTest` uses, and the presses that hit them.
 *
 *  The companion half of `pointerRecorder` (#134): that one MEASURES a miss, this one makes it
 *  VISIBLE. From the Court session that produced both — the failing press rendered in the gap
 *  between the badge's drawn circle and its hit circle, and the picture said at a glance what the
 *  number (27.6 px against a 22.76 px radius) said only once someone thought to measure.
 *
 *  ── WHY SVG, AND WHY NOT DRAWN INTO THE GAME'S OWN CANVAS ───────────────────────────────────
 *  The regions come from ANY surface (a Pixi board, a Three viewport, DOM chrome), so there is no
 *  one canvas to draw into. Viewport CSS px is the space every source already reports in
 *  (`screenBounds`, `InteractionHandle`, `InputPressRecord`), so a fixed full-screen SVG needs no
 *  transform at all and cannot drift from the coordinates the records are stated in.
 *
 *  ⚠️ `pointerEvents: 'none'` on the root, and NO pointer blocker registered. An overlay that
 *  swallowed a press would change the very interaction it exists to diagnose — the observer
 *  becoming the bug. It is also why this deliberately does not offer click-to-inspect.
 *
 *  ── IT SAMPLES; IT DOES NOT SUBSCRIBE ───────────────────────────────────────────────────────
 *  Regions are recomputed from live game state every frame, so there is nothing to subscribe to.
 *  `useInterval` at a modest cadence keeps the overlay off the frame budget of the device it is
 *  most needed on — this is a diagnostic for a phone dropping frames, and a diagnostic that
 *  costs frames measures itself. */

import { useSyncExternalStore, type CSSProperties } from 'react';
import { useInterval } from './useSampled';
import {
  collectHitRegions, isHitRegionOverlayVisible, subscribeHitRegionOverlay, hitShapeContains,
  type HitRegion, type HitShape,
} from '../rendering/hitRegions';
import { readInputPresses, isInputWatchOpen, type InputPressRecord } from '../input/pointerRecorder';

/** Presses plotted, newest brightest. Enough to see a pattern (three misses in the same gap is a
 *  different story from one), few enough that the overlay stays readable. */
const PRESS_TRAIL = 6;
/** Redraw cadence. 8 fps: fast enough to follow a board rebuild, slow enough to stay off the
 *  budget of a device that is already struggling. */
const SAMPLE_MS = 125;

/** A colour per region kind, so the same control keeps its colour between frames and two adjacent
 *  kinds never read as one shape. Cycled by a hash of the kind rather than by index — index would
 *  recolour everything the moment a game added a region type. */
const KIND_COLORS = ['#4ea1ff', '#ffd166', '#06d6a0', '#ef476f', '#c77dff', '#f78c6b'];
function colorFor(kind: string): string {
  let h = 0;
  for (let i = 0; i < kind.length; i++) h = (h * 31 + kind.charCodeAt(i)) >>> 0;
  return KIND_COLORS[h % KIND_COLORS.length];
}

function shapeEl(s: HitShape, props: Record<string, unknown>, key: string) {
  if (s.type === 'circle') return <circle key={key} cx={s.x} cy={s.y} r={s.r} {...props} />;
  if (s.type === 'rect') return <rect key={key} x={s.x - s.w / 2} y={s.y - s.h / 2} width={s.w} height={s.h} {...props} />;
  return <polygon key={key} points={s.points.map((p) => `${p.x},${p.y}`).join(' ')} {...props} />;
}

/** Does this press land inside any region? Decides the press marker's colour — the whole
 *  "targeting versus latching" distinction in one glyph.
 *
 *  ⚠️ A GEOMETRIC test, and deliberately NOT the game's verdict. `press.resolved` already carries
 *  what the game's own hit-test decided; showing that here would just restate it. The useful
 *  question is the one only the shapes can answer: did the press land inside a region and STILL
 *  resolve to nothing? That combination — a green ring on a press the game resolved as `none` —
 *  is the latching/frame-rate class, and it is invisible if this reuses the game's answer. */
function insideAny(p: InputPressRecord, regions: HitRegion[]): boolean {
  for (const r of regions) if (hitShapeContains(r.shape, p.x, p.y)) return true;
  return false;
}


export function HitRegionOverlay({ anchor }: { anchor: 'viewport' | 'container' }) {
  const visible = useSyncExternalStore(subscribeHitRegionOverlay, isHitRegionOverlayVisible, isHitRegionOverlayVisible);
  useInterval(visible ? SAMPLE_MS : 0);
  if (!visible) return null;

  const regions = collectHitRegions();
  // Only plot presses when a watch is actually open. With none, `readInputPresses` returns an
  // empty ring, and drawing nothing would be indistinguishable from "no presses missed" — the
  // absence-reads-as-evidence trap. The legend says which case it is instead.
  const watching = isInputWatchOpen();
  const presses = watching ? readInputPresses().presses.slice(-PRESS_TRAIL) : [];

  const root: CSSProperties = {
    position: anchor === 'viewport' ? 'fixed' : 'absolute',
    inset: 0,
    pointerEvents: 'none',   // see the header — an overlay that ate a press would BE the bug
    zIndex: 2147483000,
  };

  return (
    <div style={root} data-hit-region-overlay>
      <svg width="100%" height="100%" style={{ display: 'block', overflow: 'visible' }}>
        {regions.map((r) => {
          const c = colorFor(r.kind);
          return (
            <g key={r.id}>
              {/* The DRAWN shape, dashed and dim — present only when it differs from the hit
                  shape. Seeing the two together is what killed the "(i) badge is bigger than it
                  looks" theory: it is visibly smaller. */}
              {r.drawnShape && shapeEl(r.drawnShape, {
                fill: 'none', stroke: c, strokeWidth: 1, strokeDasharray: '3 3', opacity: 0.45,
              }, `${r.id}:drawn`)}
              {shapeEl(r.shape, { fill: c, fillOpacity: 0.1, stroke: c, strokeWidth: 1.5, opacity: 0.9 }, `${r.id}:hit`)}
            </g>
          );
        })}
        {presses.map((p, i) => {
          // Newest brightest — a trail reads as a sequence rather than as a cloud.
          const age = presses.length - 1 - i;
          const opacity = 1 - (age / Math.max(1, PRESS_TRAIL)) * 0.75;
          const hit = insideAny(p, regions);
          const c = hit ? '#06d6a0' : '#ff3b30';
          return (
            <g key={p.seq} opacity={opacity}>
              {/* A drag is a line from down to up; a tap collapses to a point. */}
              {p.maxD > 2 && (
                <line x1={p.x} y1={p.y} x2={p.upX} y2={p.upY} stroke={c} strokeWidth={1.5} strokeDasharray="2 2" />
              )}
              <circle cx={p.x} cy={p.y} r={7} fill="none" stroke={c} strokeWidth={2} />
              <circle cx={p.x} cy={p.y} r={2} fill={c} />
              <text x={p.x + 10} y={p.y - 8} fill={c} fontSize={10} fontFamily="ui-monospace, monospace">
                {p.seq}
              </text>
            </g>
          );
        })}
      </svg>
      <Legend regionCount={regions.length} pressCount={presses.length} watching={watching} />
    </div>
  );
}

/** Says what is on screen AND what is missing. A blank overlay with no legend is the failure this
 *  whole surface exists to avoid: "no regions" and "no game registered a provider" look identical
 *  as pixels and are completely different findings. */
function Legend({ regionCount, pressCount, watching }: { regionCount: number; pressCount: number; watching: boolean }) {
  const style: CSSProperties = {
    position: 'absolute', left: 8, bottom: 8, padding: '5px 8px', borderRadius: 4,
    background: 'rgba(0,0,0,0.72)', color: '#fff', fontSize: 10, lineHeight: 1.5,
    fontFamily: 'ui-monospace, monospace', maxWidth: 320,
  };
  return (
    <div style={style}>
      <div><b>Hit regions</b> — solid = hit shape, dashed = drawn shape</div>
      {regionCount === 0 ? (
        <div style={{ color: '#ffb4a2' }}>
          No regions. Either nothing is hit-testable right now, or this game registers no provider
          (see registerHitRegionProvider).
        </div>
      ) : (
        <div>{regionCount} region(s)</div>
      )}
      {watching ? (
        <div>
          <span style={{ color: '#06d6a0' }}>●</span> inside a region{'  '}
          <span style={{ color: '#ff3b30' }}>●</span> outside every region{'  '}({pressCount} press(es))
        </div>
      ) : (
        <div style={{ opacity: 0.7 }}>No input watch open — presses are not being recorded, so
          none are plotted. Start one to see misses.</div>
      )}
    </div>
  );
}

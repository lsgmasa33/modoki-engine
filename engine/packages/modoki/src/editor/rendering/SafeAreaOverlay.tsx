/** SafeAreaOverlay — draws the device chrome a preview is inset by (the notch /
 *  Dynamic Island band and the home-indicator band) over a device preview frame.
 *
 *  Simulating the insets without SHOWING them would trade one invisible failure for
 *  another: an element would sit somewhere unexpected with nothing on screen to say why.
 *  The bands are the explanation. They are always on with a device preset (owner,
 *  2026-08-20) — the preview's job is to stop lying about the phone, and a toggle that
 *  can be left off reintroduces exactly the gap #271 exists to close.
 *
 *  Purely decorative: `pointerEvents: 'none'` throughout, so it can never eat a click
 *  meant for the game underneath, and it renders nothing at all when the device has no
 *  insets (every Android preset in landscape aside, that is the whole `Free` + `Aspect`
 *  half of the catalog). */
import type { SafeAreaInsets } from '../scene/devicePresets';

/** Faint warm tint + a dashed inner edge: legible over both a dark scene and a light
 *  one, and unmistakably editor chrome rather than something the game drew. */
const BAND = 'rgba(255, 170, 60, 0.10)';
const EDGE = 'rgba(255, 170, 60, 0.55)';

export default function SafeAreaOverlay({ insets }: { insets: SafeAreaInsets }) {
  const { top, right, bottom, left } = insets;
  if (!top && !right && !bottom && !left) return null;
  return (
    <div
      data-safe-area-overlay
      style={{ position: 'absolute', inset: 0, zIndex: 4, pointerEvents: 'none' }}
    >
      {top > 0 && (
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: top, background: BAND, borderBottom: `1px dashed ${EDGE}` }} />
      )}
      {bottom > 0 && (
        <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: bottom, background: BAND, borderTop: `1px dashed ${EDGE}` }} />
      )}
      {/* Side bands stop at the horizontal ones rather than overlapping them — two
          translucent layers stacked in a corner read as a third, darker inset that the
          device does not have. */}
      {left > 0 && (
        <div style={{ position: 'absolute', top, bottom, left: 0, width: left, background: BAND, borderRight: `1px dashed ${EDGE}` }} />
      )}
      {right > 0 && (
        <div style={{ position: 'absolute', top, bottom, right: 0, width: right, background: BAND, borderLeft: `1px dashed ${EDGE}` }} />
      )}
    </div>
  );
}

/** Shared layout primitives for debug-menu tabs.
 *
 *  The menu body is a FIXED-HEIGHT flex column (`contentStyle` in DebugMenu.tsx) with
 *  `overflow: hidden` — it does NOT scroll. Scrolling is the tab's own job, which is
 *  what lets a list fill the dialog instead of sitting in a 240px box with dead space
 *  underneath. Every tab picks one of two roots:
 *
 *   - `fillRootStyle`   — the tab has ONE growing region (a list/tree). Put
 *                         `fillRegionStyle` on it; the header/filter row stays put and
 *                         the region takes all remaining height and scrolls itself.
 *   - `scrollRootStyle` — the tab is a stack of short sections with no natural
 *                         growing region (Stats, Time, Device, Cheats). The whole
 *                         root scrolls when it overflows.
 *
 *  Both need `minHeight: 0` — a flex child's default `min-height: auto` refuses to
 *  shrink below its content, which silently defeats the inner `overflow: auto`. */

import type { CSSProperties } from 'react';

/** Root for a tab whose content grows to fill the body (pair with `fillRegionStyle`). */
export function fillRootStyle(gap = 8): CSSProperties {
  return { display: 'flex', flexDirection: 'column', gap, height: '100%', minHeight: 0 };
}

/** Root for a tab that is a stack of short sections; the root itself scrolls. */
export function scrollRootStyle(gap = 8): CSSProperties {
  return { ...fillRootStyle(gap), overflowY: 'auto' };
}

/** The one region inside a `fillRootStyle` tab that absorbs the leftover height. */
export const fillRegionStyle: CSSProperties = { flex: 1, minHeight: 0, overflowY: 'auto' };

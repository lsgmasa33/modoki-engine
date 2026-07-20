/** Floating stat-widget registry + open-state.
 *
 *  Stat widgets (FPS/Memory/GPU) are small, half-transparent, draggable windows that
 *  spawn from the Stats launcher and stay on screen INDEPENDENTLY of the fullscreen
 *  debug modal — so you can watch performance while actually playing (the modal would
 *  block the game). This module tracks which widgets are registered and which are open
 *  + where. Pure (only a `type` import of React). */

import type React from 'react';
import type { Point } from './useDraggable';

export interface StatWidgetDef {
  id: string;
  title: string;
  /** Widget body (no props — reads perf sources internally). */
  Component: React.ComponentType;
  /** Default spawn position (viewport/container px). Cascaded if omitted. */
  defaultPos?: Point;
  /** Launcher sort order (ascending). */
  order?: number;
}

const widgets = new Map<string, StatWidgetDef>();
const open = new Map<string, Point>();
const listeners = new Set<() => void>();
let version = 0;

function bump(): void {
  version++;
  for (const l of listeners) l();
}

export function registerStatWidget(def: StatWidgetDef): void {
  widgets.set(def.id, def);
  bump();
}

export function getStatWidgets(): StatWidgetDef[] {
  return [...widgets.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}

/** Spawn/dismiss a widget. Spawning cascades its window so stacked widgets don't
 *  perfectly overlap. */
export function toggleWidget(id: string): void {
  if (open.has(id)) {
    open.delete(id);
  } else {
    const def = widgets.get(id);
    const base = def?.defaultPos;
    const cascade = open.size * 16;
    open.set(id, base ? { x: base.x, y: base.y } : { x: 16 + cascade, y: 16 + cascade });
  }
  bump();
}

export function isWidgetOpen(id: string): boolean {
  return open.has(id);
}

/** Open widgets with their current positions, in registration order. */
export function getOpenWidgets(): Array<{ def: StatWidgetDef; pos: Point }> {
  return getStatWidgets()
    .filter((d) => open.has(d.id))
    .map((def) => ({ def, pos: open.get(def.id)! }));
}

export function setWidgetPos(id: string, pos: Point): void {
  if (open.has(id)) open.set(id, pos); // position only — no bump (drag re-renders locally)
}

export function closeWidget(id: string): void {
  if (open.delete(id)) bump();
}

export function subscribeWidgets(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getWidgetVersion(): number {
  return version;
}

/** Test-only reset. */
export function __resetWidgetStore(): void {
  widgets.clear();
  open.clear();
  bump();
}

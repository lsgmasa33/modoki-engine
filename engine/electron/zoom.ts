// Editor UI zoom (VS Code–style) — whole-app zoom via Electron webContents.
//
// Single source of truth lives here in MAIN: webContents zoom is a main-process
// property, and the three entry points (Cmd/Ctrl+wheel forwarded from the renderer,
// the View-menu items, and their accelerators) all funnel through ONE controller so
// clamp + persistence stay consistent. We deliberately do NOT use Electron's built-in
// zoomIn/zoomOut/resetZoom menu ROLES — they neither clamp to our range nor persist,
// and would drift out of sync with the wheel path.
//
// Model: Electron setZoomLevel(level), factor = 1.2^level (Chromium's scale). We match
// VS Code's feel: step 0.5 level, clamped to a sane range, persisted per editor identity
// (userData is scoped per clone/identity — see userDataDir.ts — which is exactly right
// for a UI pref, unlike recents which deliberately avoid userData).

import fs from 'node:fs';
import path from 'node:path';
import { app, type BrowserWindow } from 'electron';
import { atomicWriteFileSync } from './atomicWrite';

export const ZOOM_MIN = -3;   // factor ≈ 0.58×
export const ZOOM_MAX = 4;    // factor ≈ 2.07×
export const ZOOM_STEP = 0.5; // one notch, matches VS Code

const clamp = (level: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, level));

let currentLevel = 0;

const prefsFile = (): string => path.join(app.getPath('userData'), 'ui-prefs.json');

/** Best-effort read of the persisted zoom level (clamped). Defaults to 0. */
export function loadZoomLevel(): number {
  try {
    const raw = JSON.parse(fs.readFileSync(prefsFile(), 'utf8')) as { zoomLevel?: unknown };
    if (typeof raw.zoomLevel === 'number' && Number.isFinite(raw.zoomLevel)) return clamp(raw.zoomLevel);
  } catch { /* no file / unreadable → default */ }
  return 0;
}

function persist(): void {
  try {
    // Merge onto any existing prefs so future keys aren't clobbered.
    let prefs: Record<string, unknown> = {};
    try { prefs = JSON.parse(fs.readFileSync(prefsFile(), 'utf8')) as Record<string, unknown>; } catch { /* fresh */ }
    prefs.zoomLevel = currentLevel;
    atomicWriteFileSync(prefsFile(), JSON.stringify(prefs, null, 2));
  } catch { /* best-effort — a failed pref write must never crash the editor */ }
}

/** Apply an absolute zoom level to the window (clamped), then persist. */
export function applyZoom(win: BrowserWindow | null, level: number): void {
  const next = clamp(level);
  const changed = next !== currentLevel;
  currentLevel = next;
  if (win && !win.isDestroyed()) {
    win.webContents.setZoomLevel(currentLevel);
    // Tell the renderer the authoritative page-zoom factor so the engine can keep game
    // input presentation-invariant (calibratePresentationScale). Harmless if the renderer
    // hasn't subscribed yet — main also re-sends on the mount signal. See presentationScale.ts.
    win.webContents.send('modoki:bridge-zoom-factor', win.webContents.getZoomFactor());
  }
  // Only touch disk when the level actually moved — a wheel/pinch burst that saturates at the
  // clamp must not slam a synchronous readFileSync+atomic write per event on the UI thread.
  if (changed) persist();
}

/** Restore the persisted level onto a freshly-loaded window. */
export function restoreZoom(win: BrowserWindow | null): void {
  applyZoom(win, loadZoomLevel());
}

// deltaY that accumulates to one ZOOM_STEP notch. A mouse wheel tick is ~100-120, so it
// still steps once per tick; a trackpad pinch emits many small deltas that now accumulate
// proportionally instead of saturating a full notch per event.
const WHEEL_NOTCH = 100;
let wheelAccum = 0;

/** Handle a zoom request from the menu / accelerators / renderer wheel forwarder. */
export function handleZoom(win: BrowserWindow | null, req: { dir?: 'in' | 'out' | 'reset'; deltaY?: number }): void {
  if (req.dir === 'reset') { wheelAccum = 0; applyZoom(win, 0); return; }
  if (req.dir === 'in') { applyZoom(win, currentLevel + ZOOM_STEP); return; }
  if (req.dir === 'out') { applyZoom(win, currentLevel - ZOOM_STEP); return; }
  if (typeof req.deltaY === 'number' && req.deltaY !== 0) {
    // Accumulate; emit a notch each whole WHEEL_NOTCH crossed. Wheel up (deltaY < 0) = zoom in.
    wheelAccum += req.deltaY;
    let steps = 0;
    while (wheelAccum <= -WHEEL_NOTCH) { steps += 1; wheelAccum += WHEEL_NOTCH; }
    while (wheelAccum >= WHEEL_NOTCH) { steps -= 1; wheelAccum -= WHEEL_NOTCH; }
    if (steps !== 0) applyZoom(win, currentLevel + steps * ZOOM_STEP);
  }
}

/** Current level — for tests. */
export function getZoomLevel(): number { return currentLevel; }

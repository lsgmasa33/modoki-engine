/** Editor UI zoom controller (VS Code–style whole-app zoom).
 *
 *  Verifies the pure clamp/step/wheel-sign logic, the reset, and the persist↔restore
 *  round-trip through `ui-prefs.json`. `electron` is mocked (app.getPath → temp dir);
 *  fs is real; the BrowserWindow is a stub that records setZoomLevel calls. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = { dir: '' };
vi.mock('electron', () => ({
  app: { getPath: (name: string) => path.join(root.dir, name) },
}));

import {
  applyZoom, restoreZoom, handleZoom, loadZoomLevel, getZoomLevel,
  ZOOM_MIN, ZOOM_MAX, ZOOM_STEP,
} from '../../electron/zoom';
import * as atomicWrite from '../../electron/atomicWrite';

// A minimal BrowserWindow stub — only what zoom.ts touches.
function makeWin() {
  const calls: number[] = [];
  const sent: Array<{ channel: string; arg: unknown }> = [];
  let level = 0;
  const win = {
    isDestroyed: () => false,
    webContents: {
      setZoomLevel: (l: number) => { calls.push(l); level = l; },
      // applyZoom pushes the authoritative page-zoom factor to the renderer; the real
      // webContents derives it from the zoom level (factor = 1.2^level).
      getZoomFactor: () => Math.pow(1.2, level),
      send: (channel: string, arg: unknown) => { sent.push({ channel, arg }); },
    },
  };
  return { win: win as unknown as import('electron').BrowserWindow, calls, sent };
}

const prefsFile = () => path.join(root.dir, 'userData', 'ui-prefs.json');
const readPrefs = () => JSON.parse(fs.readFileSync(prefsFile(), 'utf-8'));

let counter = 0;
beforeEach(() => {
  root.dir = fs.mkdtempSync(path.join(os.tmpdir(), `modoki-zoom-${counter++}-`));
  fs.mkdirSync(path.join(root.dir, 'userData'), { recursive: true });
  handleZoom(null, { dir: 'reset' }); // reset module state (level AND wheel accumulator) between tests
});
afterEach(() => { fs.rmSync(root.dir, { recursive: true, force: true }); });

describe('zoom controller', () => {
  it('applies + persists an absolute level', () => {
    const { win, calls } = makeWin();
    applyZoom(win, 1.5);
    expect(getZoomLevel()).toBe(1.5);
    expect(calls).toEqual([1.5]);
    expect(readPrefs().zoomLevel).toBe(1.5);
  });

  it('clamps to [ZOOM_MIN, ZOOM_MAX]', () => {
    const { win } = makeWin();
    applyZoom(win, 999);
    expect(getZoomLevel()).toBe(ZOOM_MAX);
    applyZoom(win, -999);
    expect(getZoomLevel()).toBe(ZOOM_MIN);
  });

  it('steps in/out by ZOOM_STEP and resets to 0', () => {
    const { win } = makeWin();
    handleZoom(win, { dir: 'in' });
    expect(getZoomLevel()).toBe(ZOOM_STEP);
    handleZoom(win, { dir: 'in' });
    expect(getZoomLevel()).toBe(2 * ZOOM_STEP);
    handleZoom(win, { dir: 'out' });
    expect(getZoomLevel()).toBe(ZOOM_STEP);
    handleZoom(win, { dir: 'reset' });
    expect(getZoomLevel()).toBe(0);
  });

  it('maps a wheel notch to a step (up = zoom in) and accumulates sub-notch deltas', () => {
    const { win } = makeWin();
    handleZoom(win, { deltaY: -100 }); // one full notch up
    expect(getZoomLevel()).toBe(ZOOM_STEP);
    handleZoom(win, { deltaY: 100 });  // one full notch down
    expect(getZoomLevel()).toBe(0);
    handleZoom(win, { deltaY: 0 });    // no-op
    expect(getZoomLevel()).toBe(0);
    // Sub-notch deltas (a trackpad pinch) accumulate rather than stepping per event.
    handleZoom(win, { deltaY: -40 });
    expect(getZoomLevel()).toBe(0);    // not enough yet
    handleZoom(win, { deltaY: -40 });
    expect(getZoomLevel()).toBe(0);    // 80 < 100
    handleZoom(win, { deltaY: -40 });  // 120 total -> one notch, 20 carried
    expect(getZoomLevel()).toBe(ZOOM_STEP);
  });

  it('sends the authoritative zoom factor to the renderer on apply (the calibration source)', () => {
    const { win, sent } = makeWin();
    applyZoom(win, 2);
    const push = sent.find((s) => s.channel === 'modoki:bridge-zoom-factor');
    expect(push).toBeTruthy();
    expect(push!.arg as number).toBeCloseTo(Math.pow(1.2, 2), 6); // stub getZoomFactor = 1.2^level
  });

  it('does not throw when win is null (no renderer to notify)', () => {
    expect(() => applyZoom(null, 1)).not.toThrow();
    expect(getZoomLevel()).toBe(1);
  });

  it('skips the disk write when the level does not change (no clamp/pinch thrash)', () => {
    const { win } = makeWin();
    const spy = vi.spyOn(atomicWrite, 'atomicWriteFileSync');
    applyZoom(win, 1);        // 0 -> 1 : writes
    applyZoom(win, 1);        // unchanged : no write
    applyZoom(win, 999);      // clamps to MAX (changed) : writes
    applyZoom(win, ZOOM_MAX); // unchanged : no write
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('persists an applied level to disk', () => {
    const { win } = makeWin();
    applyZoom(win, 2);
    expect(loadZoomLevel()).toBe(2);
  });

  it('restore reads the persisted level and applies it to a fresh window', () => {
    // Simulate a fresh process: a prefs file already on disk, module state at 0.
    fs.writeFileSync(prefsFile(), JSON.stringify({ zoomLevel: 2 }));
    const { win, calls } = makeWin();
    restoreZoom(win);
    expect(getZoomLevel()).toBe(2);
    expect(calls).toEqual([2]);
  });

  it('load clamps a persisted out-of-range value and defaults when absent', () => {
    fs.writeFileSync(prefsFile(), JSON.stringify({ zoomLevel: 500 }));
    expect(loadZoomLevel()).toBe(ZOOM_MAX);
    fs.rmSync(prefsFile());
    expect(loadZoomLevel()).toBe(0);
  });

  it('merges onto existing prefs without clobbering sibling keys', () => {
    fs.writeFileSync(prefsFile(), JSON.stringify({ other: 'keep' }));
    const { win } = makeWin();
    applyZoom(win, 1);
    const p = readPrefs();
    expect(p.other).toBe('keep');
    expect(p.zoomLevel).toBe(1);
  });
});

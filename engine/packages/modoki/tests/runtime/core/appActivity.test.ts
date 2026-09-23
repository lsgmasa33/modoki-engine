/**
 * App activity timeline (#1475) — the native app-active edge and the page's visibility/focus edges
 * become boot-timeline spans, and the stall log's clause names an inactive app. Driven through plain
 * EventTargets: the module takes its DOM targets as parameters, so no browser is needed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getBootTimeline, resetBootTimeline } from '../../../src/runtime/core/bootTimeline';
import {
  describeAppActivity, installPageActivityTimeline, noteAppActive, resetAppActivity,
} from '../../../src/runtime/core/appActivity';

const spans = (name: string) => getBootTimeline().spans.filter((s) => s.name === name);

function fakeDoc(visibilityState = 'visible') {
  const doc = Object.assign(new EventTarget(), { visibilityState });
  const set = (v: string) => { doc.visibilityState = v; doc.dispatchEvent(new Event('visibilitychange')); };
  return { doc, set };
}

beforeEach(() => { resetBootTimeline(); resetAppActivity(); });
afterEach(() => { resetBootTimeline(); resetAppActivity(); });

describe('app-inactive', () => {
  it('opens a span when the app resigns active and closes it when it comes back', () => {
    noteAppActive(false);
    expect(spans('app-inactive')).toHaveLength(1);
    expect(spans('app-inactive')[0].endMs).toBe(-1);
    noteAppActive(true);
    expect(spans('app-inactive')).toHaveLength(1);
    expect(spans('app-inactive')[0].endMs).toBeGreaterThanOrEqual(0);
  });

  it('an unpaired or repeated edge opens no second span (Android fires `true` on every resume)', () => {
    noteAppActive(true); // unpaired foreground: nothing to close, nothing opened
    expect(spans('app-inactive')).toHaveLength(0);
    noteAppActive(false);
    noteAppActive(false);
    expect(spans('app-inactive')).toHaveLength(1);
  });

  it('the stall clause names an inactive app, and goes silent once it is active again', () => {
    expect(describeAppActivity()).toBe('');
    noteAppActive(false);
    expect(describeAppActivity()).toContain('INACTIVE');
    noteAppActive(true);
    expect(describeAppActivity()).toBe('');
  });
});

describe('page-hidden and window-blur', () => {
  it('records a hidden period from the visibilitychange edges', () => {
    const { doc, set } = fakeDoc();
    const uninstall = installPageActivityTimeline(doc, new EventTarget());
    expect(spans('page-hidden')).toHaveLength(0);
    set('hidden');
    expect(spans('page-hidden')[0].endMs).toBe(-1);
    set('visible');
    expect(spans('page-hidden')).toHaveLength(1);
    expect(spans('page-hidden')[0].endMs).toBeGreaterThanOrEqual(0);
    uninstall();
  });

  it('a page already hidden at install counts from install', () => {
    const { doc } = fakeDoc('hidden');
    const uninstall = installPageActivityTimeline(doc, new EventTarget());
    expect(spans('page-hidden')).toHaveLength(1);
    expect(spans('page-hidden')[0].endMs).toBe(-1);
    uninstall();
  });

  it('records a blur→focus period, and names it in the stall clause while it lasts', () => {
    const { doc } = fakeDoc();
    const win = new EventTarget();
    const uninstall = installPageActivityTimeline(doc, win);
    win.dispatchEvent(new Event('blur'));
    win.dispatchEvent(new Event('blur'));
    expect(spans('window-blur')).toHaveLength(1);
    expect(describeAppActivity()).toContain('lost focus');
    win.dispatchEvent(new Event('focus'));
    expect(spans('window-blur')[0].endMs).toBeGreaterThanOrEqual(0);
    expect(describeAppActivity()).toBe('');
    uninstall();
  });

  it('a re-install while blurred (Fast Refresh) keeps the span open and closes it on the REAL focus', () => {
    // The only uninstall in practice is a remount, and no new `blur` arrives for a window already blurred.
    const { doc } = fakeDoc();
    const win = new EventTarget();
    const first = installPageActivityTimeline(doc, win);
    win.dispatchEvent(new Event('blur'));
    first();
    const second = installPageActivityTimeline(doc, win);
    expect(spans('window-blur')[0].endMs, 'still open across the remount').toBe(-1);
    expect(describeAppActivity()).toContain('lost focus');
    win.dispatchEvent(new Event('focus'));
    expect(spans('window-blur')[0].endMs).not.toBe(-1);
    second();
  });

  it('uninstall removes every listener', () => {
    const { doc, set } = fakeDoc();
    const win = new EventTarget();
    installPageActivityTimeline(doc, win)();
    set('hidden');
    win.dispatchEvent(new Event('blur'));
    expect(spans('page-hidden')).toHaveLength(0);
    expect(spans('window-blur')).toHaveLength(0);
  });
});

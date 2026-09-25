// @vitest-environment jsdom
/** Pins the WIRING of #1475's activity timeline: the shipping hook (`engine/app/useAppActivityTimeline.ts`)
 *  must feed both the page's own edges and the native `appStateChange` edge into the boot timeline.
 *  `appActivity.test.ts` covers the span logic; this covers what that suite cannot — that the hook
 *  actually installs it, and that the native edge reaches it. The engine runtime is REAL here, so a
 *  hook that registered a listener and dropped the edge would fail. Only Capacitor is faked.
 *
 *  ⚠️ `.test.tsx`, not `.test.ts`: `engine/vite.config.ts` collects only `tests/app/**\/*.test.tsx`
 *  (see backgroundFlush.test.tsx's header). */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import React from 'react';

const spies = vi.hoisted(() => ({
  isNativePlatform: vi.fn(() => false),
  addListener: vi.fn(async (_event: string, _handler: (...args: unknown[]) => void) => ({ remove: vi.fn(async () => {}) })),
}));

vi.mock('@capacitor/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@capacitor/core')>();
  return { ...actual, Capacitor: { ...actual.Capacitor, isNativePlatform: spies.isNativePlatform } };
});
vi.mock('@capacitor/app', () => ({ App: { addListener: spies.addListener } }));

import { getBootTimeline, resetBootTimeline } from '@modoki/engine/runtime';
import { useAppActivityTimeline } from '../../app/useAppActivityTimeline';

function Probe() {
  useAppActivityTimeline();
  return null;
}

const spans = (name: string) => getBootTimeline().spans.filter((s) => s.name === name);
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  spies.isNativePlatform.mockReturnValue(false);
  setVisibility('visible');
  resetBootTimeline();
});

describe('useAppActivityTimeline (#1475)', () => {
  it('records a hidden period from the page\'s own edges, and stops listening on unmount', () => {
    resetBootTimeline();
    const { unmount } = render(React.createElement(Probe));
    setVisibility('hidden');
    setVisibility('visible');
    expect(spans('page-hidden')).toHaveLength(1);
    expect(spans('page-hidden')[0].endMs).not.toBe(-1);
    unmount();
    setVisibility('hidden');
    expect(spans('page-hidden')).toHaveLength(1);
  });

  it('on native, the appStateChange edge becomes an `app-inactive` span', async () => {
    resetBootTimeline();
    spies.isNativePlatform.mockReturnValue(true);
    render(React.createElement(Probe));
    await flush();
    const call = spies.addListener.mock.calls.find((c) => c[0] === 'appStateChange');
    expect(call, 'the hook must register appStateChange on native').toBeDefined();
    const onChange = call![1] as (s: { isActive: boolean }) => void;
    onChange({ isActive: false });
    expect(spans('app-inactive')[0]?.endMs).toBe(-1);
    onChange({ isActive: true });
    expect(spans('app-inactive')).toHaveLength(1);
    expect(spans('app-inactive')[0].endMs).not.toBe(-1);
  });

  it('registers no native listener off-device', async () => {
    render(React.createElement(Probe));
    await flush();
    expect(spies.addListener).not.toHaveBeenCalled();
  });
});

/** Debug-menu registry + sparkline math — unit tests (Phase 1).
 *
 *  Guards the extensibility seam a game plugs into: tab register/replace/unregister,
 *  command grouping into tabs, change notifications, the enablement gate, and the
 *  pure Sparkline point-mapping. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerDebugTab,
  unregisterDebugTab,
  getDebugTabs,
  registerDebugCommand,
  unregisterDebugCommand,
  getDebugCommands,
  getDebugCommandTabs,
  subscribeDebugMenu,
  getDebugMenuVersion,
  isDebugMenuEnabled,
  setDebugMenuEnabled,
  __resetDebugMenuRegistry,
} from '../../packages/modoki/src/runtime/debug/debugMenuRegistry';
import { sparkPoints } from '../../packages/modoki/src/runtime/debug/Sparkline';

const Noop = () => null;

beforeEach(() => __resetDebugMenuRegistry());

describe('debug-menu tab registry', () => {
  it('registers tabs and returns them sorted by order then title', () => {
    registerDebugTab({ id: 'b', title: 'Beta', order: 10, Component: Noop });
    registerDebugTab({ id: 'a', title: 'Alpha', order: 0, Component: Noop });
    registerDebugTab({ id: 'z', title: 'Zed', Component: Noop }); // default order 100
    expect(getDebugTabs().map((t) => t.id)).toEqual(['a', 'b', 'z']);
  });

  it('sorts equal-order tabs alphabetically by title', () => {
    registerDebugTab({ id: 'x', title: 'Xylophone', order: 5, Component: Noop });
    registerDebugTab({ id: 'm', title: 'Mango', order: 5, Component: Noop });
    expect(getDebugTabs().map((t) => t.title)).toEqual(['Mango', 'Xylophone']);
  });

  it('replaces a tab registered with the same id', () => {
    registerDebugTab({ id: 'a', title: 'First', Component: Noop });
    registerDebugTab({ id: 'a', title: 'Second', Component: Noop });
    expect(getDebugTabs()).toHaveLength(1);
    expect(getDebugTabs()[0].title).toBe('Second');
  });

  it('unregisters a tab by id', () => {
    registerDebugTab({ id: 'a', title: 'Alpha', Component: Noop });
    registerDebugTab({ id: 'b', title: 'Beta', Component: Noop });
    unregisterDebugTab('a');
    expect(getDebugTabs().map((t) => t.id)).toEqual(['b']);
  });
});

describe('debug-menu command registry', () => {
  it('groups commands under the default "Cheats" tab', () => {
    registerDebugCommand({ label: 'Win', run: () => {} });
    expect(getDebugCommandTabs()).toEqual(['Cheats']);
    expect(getDebugCommands('Cheats').map((c) => c.label)).toEqual(['Win']);
  });

  it('groups commands by explicit tab and sorts by order', () => {
    registerDebugCommand({ tab: 'Econ', label: 'B', run: () => {}, order: 20 });
    registerDebugCommand({ tab: 'Econ', label: 'A', run: () => {}, order: 10 });
    registerDebugCommand({ tab: 'Level', label: 'Skip', run: () => {} });
    expect(getDebugCommandTabs()).toEqual(['Econ', 'Level']);
    expect(getDebugCommands('Econ').map((c) => c.label)).toEqual(['A', 'B']);
  });

  it('unregisters a command by identity', () => {
    const cmd = { label: 'Temp', run: () => {} };
    registerDebugCommand(cmd);
    expect(getDebugCommands()).toHaveLength(1);
    unregisterDebugCommand(cmd);
    expect(getDebugCommands()).toHaveLength(0);
  });
});

describe('debug-menu change notifications', () => {
  it('bumps the version and notifies subscribers on change', () => {
    const listener = vi.fn();
    const v0 = getDebugMenuVersion();
    const unsub = subscribeDebugMenu(listener);
    registerDebugTab({ id: 'a', title: 'Alpha', Component: Noop });
    expect(getDebugMenuVersion()).toBeGreaterThan(v0);
    expect(listener).toHaveBeenCalled();
    unsub();
    const v1 = getDebugMenuVersion();
    registerDebugTab({ id: 'b', title: 'Beta', Component: Noop });
    expect(listener).toHaveBeenCalledTimes(1); // no more calls after unsub
    expect(getDebugMenuVersion()).toBeGreaterThan(v1);
  });
});

describe('debug-menu enablement gate', () => {
  it('defaults to disabled and toggles', () => {
    expect(isDebugMenuEnabled()).toBe(false);
    setDebugMenuEnabled(true);
    expect(isDebugMenuEnabled()).toBe(true);
    setDebugMenuEnabled(false);
    expect(isDebugMenuEnabled()).toBe(false);
  });
});

describe('sparkPoints mapping', () => {
  it('returns no points for empty data', () => {
    expect(sparkPoints([], 100, 40, 0, 10)).toEqual([]);
  });

  it('maps min value to the bottom and max to the top', () => {
    const pts = sparkPoints([0, 10], 100, 40, 0, 10);
    expect(pts[0]).toEqual({ x: 0, y: 40 }); // lo → bottom (y = h)
    expect(pts[1]).toEqual({ x: 100, y: 0 }); // hi → top (y = 0)
  });

  it('spaces points evenly across the width', () => {
    const pts = sparkPoints([1, 2, 3], 100, 40, 1, 3);
    expect(pts.map((p) => p.x)).toEqual([0, 50, 100]);
  });

  it('clamps values outside the [lo, hi] range', () => {
    const pts = sparkPoints([-5, 15], 100, 40, 0, 10);
    expect(pts[0].y).toBe(40); // below lo → clamped to bottom
    expect(pts[1].y).toBe(0); // above hi → clamped to top
  });
});

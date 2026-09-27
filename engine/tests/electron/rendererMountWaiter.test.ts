/** Readiness for an agent's project switch (#1587): a wait settles on the mount of a document
 *  committed AFTER its reload, never on the old document's last menu push. */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRendererMountWaiter } from '../../electron/rendererMountWaiter';

afterEach(() => { vi.useRealTimers(); });

describe('createRendererMountWaiter', () => {
  it('settles on the mount that follows the reload\'s navigation', async () => {
    const w = createRendererMountWaiter();
    const epoch = w.armReload();
    const p = w.waitForMount(epoch, 10_000);
    w.onNavigate();
    w.onMounted();
    await expect(p).resolves.toBe(true);
  });

  it('does NOT settle on a mount from the OLD document, pushed before the new one navigated', async () => {
    vi.useFakeTimers();
    const w = createRendererMountWaiter();
    // The old editor was mounted before the switch.
    w.onNavigate();
    w.onMounted();
    const epoch = w.armReload();
    const p = w.waitForMount(epoch, 1_000);
    // Its last menu-structure push lands after reloadIgnoringCache() but before did-navigate.
    w.onMounted();
    vi.advanceTimersByTime(1_000);
    await expect(p).resolves.toBe(false);
  });

  it('settles at once when the new document already mounted before the wait was registered', async () => {
    const w = createRendererMountWaiter();
    const epoch = w.armReload();
    w.onNavigate();
    w.onMounted();
    await expect(w.waitForMount(epoch, 0)).resolves.toBe(true);
  });

  it('a navigation BEFORE the reload was armed does not count', async () => {
    vi.useFakeTimers();
    const w = createRendererMountWaiter();
    w.onNavigate();
    const epoch = w.armReload();
    const p = w.waitForMount(epoch, 500);
    w.onMounted();
    vi.advanceTimersByTime(500);
    await expect(p).resolves.toBe(false);
  });
});

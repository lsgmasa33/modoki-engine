/** `system.openUrl` against the REAL `@capacitor/core` (#1196 close-out).
 *
 *  `systemControls.test.ts` mocks `registerPlugin`, so it cannot see what the real one does when a
 *  plugin is registered twice: it returns the same proxy and `console.warn`s. Wordweave registers
 *  `ModokiSystem` itself (its reminder row imports the plugin's JS), and in a shipped build a
 *  `console.warn` is a Crashlytics issue — so a second registration from the engine files one issue
 *  per player who taps a Privacy link. Only the platform answers are faked here; registration is real. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Capacitor, registerPlugin } from '@capacitor/core';

const PRIVACY = 'https://apiarygames.com/privacy.html';

describe('system.openUrl reuses a plugin the game already registered', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does not register ModokiSystem a second time — no "already registered" warning', async () => {
    vi.resetModules();
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    vi.spyOn(Capacitor, 'isPluginAvailable').mockReturnValue(true);

    // What wordweave's `packages/app-services/src/notifications.ts` import does at boot. A web
    // implementation stands in for the native bridge, which a node run does not have.
    const openUrl = vi.fn(async () => ({ opened: true }));
    registerPlugin('ModokiSystem', { web: { openUrl } as never });

    const warn = vi.spyOn(console, 'warn');
    const { registerSystemControls } = await import('../../src/runtime/actions/systemControls');
    const { dispatchUIAction } = await import('../../src/runtime/core/actionRegistry');
    registerSystemControls();

    await dispatchUIAction('system.openUrl', { params: { url: PRIVACY } });

    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/already registered/);
    // The positive half: the game's registration is the one the tap reached.
    expect(openUrl).toHaveBeenCalledWith({ url: PRIVACY });
  });
});


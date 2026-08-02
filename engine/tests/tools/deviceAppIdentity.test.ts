/** `handleAppIdentity` (`engine/app/debug/bridge.ts`, #88) — the device-side handler behind the
 *  MCP's `device_status` app-identity line (see `deviceToolSurface.test.ts` for the MCP-side
 *  merge). This is the ONLY place the handler itself lives, so a test against the MCP tool's stub
 *  backend cannot exercise it — it can only assert the tool relays whatever the (fake) device
 *  bridge returns.
 *
 *  WHY THIS MOCKS `@capacitor/app` RATHER THAN LEANING ON JSDOM. The first version of this suite
 *  asserted only the web/jsdom path, where `getInfo()` throws "Not implemented on web" and the
 *  handler falls back to an empty `appId`. That version PASSED against a handler gutted to
 *  `return { platform, appId: '', appName: '' }` with the `getInfo()` call deleted outright
 *  (mutation-checked during the #88 close-out). An assertion that cannot tell "the platform could
 *  not answer" apart from "the handler never asked" is not coverage of a handler whose entire job
 *  is to ask.
 *
 *  So the SUCCESS branch is pinned explicitly below. That branch is the one that matters: it is
 *  what lets `device_status` name the app actually holding the socket, which is the whole point of
 *  #88. Only the real native `getInfo()` (Android/iOS returning a true package id) still needs
 *  hardware — and that is a Capacitor guarantee, not ours. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getInfo = vi.fn();
vi.mock('@capacitor/app', () => ({ App: { getInfo: () => getInfo() } }));

const { handleAppIdentity } = await import('../../app/debug/bridge');

describe('handleAppIdentity', () => {
  beforeEach(() => { getInfo.mockReset(); });

  it('reports the id and name the platform gives it — the branch device_status depends on', async () => {
    getInfo.mockResolvedValue({ id: 'com.modokiengine.court', name: 'Court', build: '1', version: '1.0' });

    const info = await handleAppIdentity();

    // The measured shape from the live Samsung lease (#88 close-out):
    //   {"platform":"android","appId":"com.modokiengine.court","appName":"Court"}
    expect(info.appId).toBe('com.modokiengine.court');
    expect(info.appName).toBe('Court');
    expect(getInfo).toHaveBeenCalledTimes(1); // it ASKED — a gutted handler fails here
  });

  it('never throws — an unanswerable platform degrades to an empty appId, not a rejection', async () => {
    // `@capacitor/app`'s web plugin throws "Not implemented on web" (verified against
    // node_modules/@capacitor/app/dist/esm/web.js). The handler must stay total: the router would
    // otherwise have to translate a rejection, and `device_status` treats a missing app line as
    // "unknown", never as a tool failure.
    getInfo.mockRejectedValue(new Error('Not implemented on web'));

    const info = await handleAppIdentity();

    expect(info.appId).toBe('');
    expect(info.appName).toBe('');
    expect(typeof info.platform).toBe('string'); // still reports the platform it DID know
  });
});

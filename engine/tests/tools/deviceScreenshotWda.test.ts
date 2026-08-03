/** `device_screenshot {source:'wda'}` — the iOS full-device capture (#102), at the MCP surface.
 *
 *  WHY THIS EXISTS. The native iOS capture is the APP'S OWN, so a system permission/ATT dialog —
 *  a different window — comes back showing the app UNDERNEATH it. That reads as a perfectly good
 *  screenshot of the wrong thing, which is why the fix could not be "fall back when the native
 *  capture fails": in the motivating case it does not fail.
 *
 *  The hazard this feature introduces, and what these tests are really guarding: screenshot pixels
 *  are an AIM SPACE. `device_tap {x,y}` scales through the mapping a NATIVE capture establishes. A
 *  WDA image is the whole device screen (status bar, any system UI), so its pixels are not page
 *  pixels — and a tap aimed off one would be silently, plausibly wrong. Every WDA reply therefore
 *  carries the coordinate warning AND drops the "use these pixel coordinates for device_tap" hint
 *  the native path prints. A test that only checked "an image came back" would pass while the
 *  reply actively misled the reader.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { loadDeviceSurface, deviceReply, type DeviceSurface, type StubRequest } from './deviceSurface';

let surface: DeviceSurface | null = null;
afterEach(() => { surface?.restore(); surface = null; });

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const WARNING = '⚠️  DEVICE-SCREEN pixels, not page coordinates.';

/** What the backend returns for a WDA capture (see `tryDeviceWdaScreenshot`). */
const WDA_REPLY = {
  image: PNG, source: 'trusted-wda', warning: WARNING,
  imageWidth: 1170, imageHeight: 2532, screenWidth: 1170, screenHeight: 2532,
};

async function shoot(args: Record<string, unknown>, reply: unknown): Promise<{ text: string; req: StubRequest | undefined }> {
  surface = await loadDeviceSurface((r) =>
    r.path === '/api/device/request' ? deviceReply(reply) : undefined,
  );
  const out = await surface.call('device_screenshot', args);
  return { text: surface.text(out), req: surface.last() };
}

describe('device_screenshot source:"wda" (#102)', () => {
  it('asks the backend for the WDA capture explicitly', async () => {
    const { req } = await shoot({ source: 'wda' }, WDA_REPLY);
    expect(req?.body).toMatchObject({ method: 'screenshot', params: { source: 'wda' } });
  });

  it('carries the coordinate warning and does NOT tell the reader to tap with these pixels', async () => {
    const { text } = await shoot({ source: 'wda' }, WDA_REPLY);
    expect(text).toContain('DEVICE-SCREEN pixels');
    // The native path's hint would be a lie here. Its absence IS the fix.
    expect(text).not.toContain('Use these pixel coordinates for device_tap');
  });

  it('reports the size as one full-screen resolution, not a page→screen scale pair', async () => {
    // "1170x2532 (from 1170x2532)" would imply a mapping this capture does not have.
    const { text } = await shoot({ source: 'wda' }, WDA_REPLY);
    expect(text).toContain('[wda] 1170x2532 full device screen.');
    expect(text).not.toContain('(from 1170x2532)');
  });

  it('the DEFAULT path still prints the aim hint — the warning is not global noise', async () => {
    const native = { image: PNG, imageWidth: 390, imageHeight: 844, screenWidth: 1170, screenHeight: 2532 };
    const { text, req } = await shoot({}, native);
    expect(req?.body).toMatchObject({ method: 'screenshot' });
    expect((req?.body as { params?: Record<string, unknown> }).params?.source).toBeUndefined();
    expect(text).toContain('Use these pixel coordinates for device_tap');
    expect(text).not.toContain('DEVICE-SCREEN pixels');
  });

  it('an AUTOMATIC fallback (backend chose WDA after the native capture failed) still suppresses the hint', async () => {
    // This is the dangerous direction: nobody asked for WDA, so a stale "tap with these" hint would
    // be believed. The reply is recognised by its `source`, not by what the caller requested.
    const { text } = await shoot({}, { ...WDA_REPLY, nativeCaptureFailed: 'Error: no window to capture' });
    expect(text).toContain('DEVICE-SCREEN pixels');
    expect(text).not.toContain('Use these pixel coordinates for device_tap');
  });

  it('refuses with an actionable reason when the backend says WDA is unavailable', async () => {
    surface = await loadDeviceSurface((r) =>
      r.path === '/api/device/request'
        ? { status: 409, body: { error: 'WebDriverAgent is not answering on the phone' } }
        : undefined,
    );
    const out = await surface.call('device_screenshot', { source: 'wda' });
    expect(out.isError).toBe(true);
    expect(surface.text(out)).toMatch(/WebDriverAgent/);
  });
});

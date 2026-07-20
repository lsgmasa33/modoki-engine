/** DeviceConnectSection stateful/effect tests (code-review T8) — the component had ZERO coverage,
 *  and the untested paths are exactly the race/leak-prone ones: the one-time server hydration vs
 *  in-progress typing, the connect/disconnect commit, and the disconnect error path (L14). The pure
 *  backend calls are mocked; the pure helpers (deviceSummary/deviceButtonLabel) stay real. */
// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { DeviceStatus } from '../../src/editor/panels/deviceConnectModel';

const h = vi.hoisted(() => ({
  fetchDeviceStatus: vi.fn(),
  deviceConnect: vi.fn(),
  deviceDisconnect: vi.fn(),
}));

vi.mock('../../src/editor/panels/deviceConnectModel', async (importActual) => {
  const actual = await importActual<typeof import('../../src/editor/panels/deviceConnectModel')>();
  return { ...actual, fetchDeviceStatus: h.fetchDeviceStatus, deviceConnect: h.deviceConnect, deviceDisconnect: h.deviceDisconnect };
});

import DeviceConnectSection from '../../src/editor/panels/DeviceConnectSection';

const mk = (over: Partial<DeviceStatus>): DeviceStatus => ({ state: 'disconnected', guid: 'g', target: null, ...over });

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('DeviceConnectSection', () => {
  it('the one-time server hydration does not stomp in-progress typing', async () => {
    let resolveStatus!: (s: DeviceStatus) => void;
    h.fetchDeviceStatus.mockReturnValue(new Promise<DeviceStatus>((r) => { resolveStatus = r; }));

    const { container } = render(<DeviceConnectSection />);
    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '10.0.0.7' } });          // type before status resolves
    resolveStatus(mk({ lastTarget: { ip: '192.168.1.99', useAdb: false } }));

    await waitFor(() => expect(h.fetchDeviceStatus).toHaveBeenCalled());
    expect(input.value).toBe('10.0.0.7');                                // hydration did NOT overwrite
  });

  it('a connect click sends the typed IP and reflects connected (button → Disconnect)', async () => {
    h.fetchDeviceStatus.mockResolvedValue(mk({ state: 'disconnected' }));
    h.deviceConnect.mockResolvedValue(mk({ state: 'connected', target: { host: '10.0.0.7', port: 9095, useAdb: false } }));

    const { container, getByText } = render(<DeviceConnectSection />);
    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '10.0.0.7' } });
    fireEvent.click(getByText('Connect'));

    await waitFor(() => expect(h.deviceConnect).toHaveBeenCalledWith({ ip: '10.0.0.7', useAdb: false }));
    await waitFor(() => getByText('Disconnect'));                        // commitStatus updated the UI
  });

  it('surfaces a disconnect failure as a note instead of an unhandled rejection (L14)', async () => {
    h.fetchDeviceStatus.mockResolvedValue(mk({ state: 'connected', target: { host: '10.0.0.7', port: 9095, useAdb: false } }));
    h.deviceDisconnect.mockRejectedValue(new Error('backend down'));

    const { getByText, findByText } = render(<DeviceConnectSection />);
    await waitFor(() => getByText('Disconnect'));
    fireEvent.click(getByText('Disconnect'));

    expect(await findByText(/Disconnect failed: backend down/)).toBeTruthy();
  });
});

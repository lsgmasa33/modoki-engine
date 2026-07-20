/** devServer.findFreePort — port selection + the pinned-port fail-loud contract
 *  (E6). Binds a real loopback listener to occupy a port. */
import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { findFreePort } from '../../electron/devServer';

let occupied: net.Server | null = null;

function occupy(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      occupied = srv;
      resolve((srv.address() as net.AddressInfo).port);
    });
  });
}

afterEach(() => {
  occupied?.close();
  occupied = null;
});

describe('findFreePort', () => {
  it('returns the preferred port when it is free', async () => {
    const p = await occupy();
    occupied!.close(); occupied = null; // free it again
    const got = await findFreePort(p);
    expect(got).toBe(p);
  });

  it('falls back to an ephemeral port when preferred is taken (default)', async () => {
    const taken = await occupy();
    const got = await findFreePort(taken);
    expect(got).not.toBe(taken);
    expect(got).toBeGreaterThan(0);
  });

  it('REJECTS instead of drifting when allowFallback=false and the port is taken (E6)', async () => {
    const taken = await occupy();
    await expect(findFreePort(taken, false)).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });

  it('returns an ephemeral port for preferred<=0', async () => {
    const got = await findFreePort(0);
    expect(got).toBeGreaterThan(0);
  });
});

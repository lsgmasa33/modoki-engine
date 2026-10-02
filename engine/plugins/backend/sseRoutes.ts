/** The build-family routes' method rule (#1967), shared by the two hosts that serve them: the Vite middleware that runs
 *  them (`vite-asset-scanner.ts`) and the Electron backend that proxies them there (`backendServer.ts`). */

/** The build-family SSE routes: each STARTS a job (a build, a scaffold, an install, an OTA publish), so each is a POST
 *  (#1967), and the Electron backend proxies exactly these to this server (`backendServer.ts`). */
export const SSE_ROUTES = ['/api/build', '/api/add-native-target', '/api/toolchain/install', '/api/ota/publish'];

/** A 405 for a state-changing route reached by anything but POST (#1967): a GET is assumed safe by everything from a
 *  link prefetcher to an `<img src>`, so no route that changes state answers one. True when it refused. */
export function refuseUnlessPost(
  req: { method?: string; url?: string },
  res: { statusCode: number; setHeader(k: string, v: string): unknown; end(body: string): unknown },
): boolean {
  if (req.method === 'POST') return false;
  const route = (req.url ?? '').split('?')[0];
  res.statusCode = 405;
  res.setHeader('Allow', 'POST');
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: false, error: `${route} changes state, so it takes POST only (got ${req.method ?? 'no method'}).` }));
  return true;
}

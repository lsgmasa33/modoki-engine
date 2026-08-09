/** Build the standalone ramp-probe page (#188) and serve it on the LAN.
 *
 *  `node engine/tools/ramp-probe-page/build.mjs [--serve] [--port 8899]`
 *
 *  Deliberately standalone rather than a route on the dev server:
 *   - a phone pulling several hundred unbundled ESM modules over WiFi is slow on exactly the old
 *     hardware worth measuring, and a bundle is closer to what actually ships;
 *   - the editor backend binds 127.0.0.1 and should stay that way. This serves ONE directory of
 *     static files, and nothing else on this machine becomes reachable from the LAN.
 *
 *  Output goes to a temp dir, never in-repo. */

import { build } from 'vite';
import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(os.tmpdir(), 'modoki-ramp-probe-page');

const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]) || 8899;

/** Stamped into the page so a device can PROVE which build it is running.
 *
 *  This is not cosmetic. A phone silently serving a cached older bundle reports numbers about the
 *  wrong code, and — measured, on the first real run — a page that could not send its results
 *  still said it had. A visible stamp is the difference between "the send is broken" and "you are
 *  looking at yesterday's page", which are opposite fixes. */
const buildId = new Date().toISOString().replace('T', ' ').slice(0, 19) + 'Z';

await build({
  root: here,
  base: './',
  logLevel: 'warn',
  define: { __BUILD_ID__: JSON.stringify(buildId) },
  build: { outDir, emptyOutDir: true, target: 'es2020' },
});
console.log(`[ramp-probe-page] built → ${outDir}`);
console.log(`[ramp-probe-page] BUILD ID: ${buildId}   (the page must show exactly this)`);

if (!args.includes('--serve')) process.exit(0);

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json' };

/** Where a device's results land. The whole point of this endpoint is that the person holding
 *  the phone should not have to transcribe anything — they tap Run, and the numbers arrive here.
 *
 *  ⚠️ **OUTSIDE `outDir`, and that is not a detail.** It lived inside it once, and the build runs
 *  with `emptyOutDir: true` — so the very next rebuild DELETED a device's results. Measurements
 *  are the expensive, unrepeatable half of this tool (someone has to be holding the phone); the
 *  bundle is regenerated in seconds. They must not share a directory whose lifecycle is owned by
 *  the cheap one. */
const resultsFile = path.join(os.tmpdir(), 'modoki-ramp-probe-results.txt');

createServer((req, res) => {
  // Log EVERY request, with the peer address. Without this a device that reports "sent" while
  // nothing arrives is undiagnosable: you cannot tell a failed POST from a page cached off an
  // older server instance from a device that never reached this process at all.
  const peer = req.socket.remoteAddress?.replace('::ffff:', '') ?? '?';
  console.log(`[req] ${req.method} ${req.url} from ${peer}`);

  // POST /result — append a device's block. Deliberately the ONLY write this server accepts:
  // a fixed path, append-only, text, and nothing from the request touches a filename. It is
  // LAN-reachable (that is the point), so it must not be able to become anything more.
  if (req.method === 'POST' && (req.url || '').split('?')[0] === '/result') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 64_000) req.destroy(); });
    req.on('end', () => {
      fs.appendFileSync(resultsFile, `\n===== ${new Date().toISOString()} =====\n${body}\n`);
      console.log(`[ramp-probe-page] result received (${body.length}b) → ${resultsFile}`);
      res.writeHead(204, { 'access-control-allow-origin': '*' }).end();
    });
    return;
  }

  const rel = decodeURIComponent((req.url || '/').split('?')[0]);
  const file = path.join(outDir, rel === '/' ? 'index.html' : rel);
  // Contain it to outDir — this is bound to 0.0.0.0, so a traversal would expose the machine.
  if (!file.startsWith(outDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, {
    'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
    // No caching: a phone that ran an older build would report numbers about the wrong code.
    'cache-control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
}).listen(port, '0.0.0.0', () => {
  const nets = Object.values(os.networkInterfaces()).flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal);
  console.log(`[ramp-probe-page] serving on port ${port}. Open on the device:`);
  for (const n of nets) console.log(`    http://${n.address}:${port}/`);
  console.log(`[ramp-probe-page] results → ${resultsFile}`);
  console.log('[ramp-probe-page] ctrl-c to stop.');
});

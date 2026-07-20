#!/usr/bin/env node
/**
 * Assert an ALREADY-BUILT packaged .app applies its PROD Content-Security-Policy
 * correctly — the CSP analog of assert-app-renders.sh (render gate). Does NOT
 * build; point it at the .app you want to gate (so release.yml can check the
 * signed artifact it just produced, and smoke-packaged.sh can chain it after its
 * render assertions on the app it built).
 *
 * WHY a dedicated gate: the prod CSP is applied ONLY in the packaged app
 * (app.isPackaged) — dev sets none — so a wrong policy ships silently and only
 * breaks a real install. The render gate can't see it (a CSP-blocked CDN script
 * doesn't blank the editor). Concrete regression this guards: `script-src` once
 * lacked `https:`, CSP-blocking MediaPipe's GenAI wasm loader `<script>` (chess /
 * llm-test on-device LLM, from jsdelivr) → "Resource load error:
 * genai_wasm_internal.js" and the game never loaded. Its static twin is
 * engine/tests/electron/cspContract.test.ts (asserts the source policy); THIS
 * asserts the SHIPPED binary actually enforces it — the layer that would have
 * caught DMG 0.2.0, whose binary predated the source fix.
 *
 * Method (needs CDP — a script-injection probe is the faithful check): boot the
 * binary with --remote-debugging-port, wait for the renderer, then FROM the page
 *   B1. inject MediaPipe's real CDN wasm-loader <script> → must LOAD, no CSP violation
 *   B2. inject a bare http: <script> → must be BLOCKED (proves the policy is present
 *       + enforced, not merely absent — a missing CSP would pass B1 but fail B2)
 *
 *   node engine/scripts/assert-app-csp.mjs <app-path> [project-dir]
 * Exit 0 = CSP correct; non-zero = a shipped-CSP regression (details printed).
 */
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const app = process.argv[2];
if (!app) { console.error('usage: assert-app-csp.mjs <app-path> [project-dir]'); process.exit(1); }
const PROJECT = path.resolve(process.argv[3] ?? path.join(REPO, 'games/3d-test'));
const BOOT_TIMEOUT_MS = 120_000;

const bin = path.join(app, 'Contents', 'MacOS', path.basename(app, '.app'));
if (!existsSync(bin)) { console.error(`[csp] FAIL: no executable at ${bin}`); process.exit(1); }

let failed = false;
const log = (...a) => console.log('[csp]', ...a);
const fail = (msg) => { console.error('[csp] FAIL:', msg); failed = true; };

/** A free loopback TCP port, so the CDP endpoint can't collide with a leftover. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

// The packaged app force-opens Chromium's CDP port ITSELF (engine/electron/cdp.ts),
// honoring MODOKI_CDP_PORT — and Chromium's --remote-debugging-port fails SILENTLY when
// the port is already taken. The render smoke that runs just before opens the app's
// default CDP (9222) and can leave it briefly held, so this smoke's app then can't bind
// it (and looked at a different port than the app actually opened). Fix: (1) kill any
// leftover app instance, (2) pick a guaranteed-free port, (3) tell the app that port via
// MODOKI_CDP_PORT — do NOT also pass --remote-debugging-port (the app appends it; a
// duplicate/mismatched flag was the bug).
try { execFileSync('pkill', ['-f', `${path.basename(app)}/Contents/MacOS`]); } catch { /* none */ }
await new Promise((r) => setTimeout(r, 1500)); // let the OS release the old CDP port
const CDP_PORT = Number(process.env.CSP_CDP_PORT) || (await freePort());

const userData = mkdtempSync(path.join(tmpdir(), 'modoki-csp-ud-'));
const child = spawn(bin, [`--user-data-dir=${userData}`], {
  env: { ...process.env, MODOKI_NO_AUTOUPDATE: '1', MODOKI_PROJECT: PROJECT, MODOKI_CDP_PORT: String(CDP_PORT) },
  stdio: ['ignore', 'inherit', 'inherit'],
});
const cleanup = () => {
  try { child.kill('SIGKILL'); } catch { /* gone */ }
  try { execFileSync('pkill', ['-f', `${path.basename(app)}/Contents/MacOS`]); } catch { /* none */ }
  try { rmSync(userData, { recursive: true, force: true }); } catch { /* best effort */ }
};
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function editorPage() {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
    return targets.find((t) => t.type === 'page' && String(t.url).includes('/editor'));
  } catch { return null; }
}
function cdpSession(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result); pending.delete(d.id); } };
  const ready = new Promise((r) => { ws.onopen = r; });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'evaluate threw');
    return r?.result?.value;
  };
  return { ready, send, evaluate, close: () => ws.close() };
}

try {
  log(`waiting for the editor page (up to ${BOOT_TIMEOUT_MS / 1000}s)…`);
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let page = null;
  while (Date.now() < deadline) {
    page = await editorPage();
    if (page?.webSocketDebuggerUrl) break;
    if (child.exitCode !== null) { fail(`app exited early (code ${child.exitCode})`); break; }
    await sleep(1000);
  }
  if (!page?.webSocketDebuggerUrl) {
    fail('editor page never appeared — cannot probe CSP');
  } else {
    const s = cdpSession(page.webSocketDebuggerUrl);
    await s.ready;
    await s.send('Runtime.enable');
    // Wait until the document is live enough to inject into (the render gate owns
    // the deeper mount assertion).
    const mountDeadline = Date.now() + 45_000;
    while (Date.now() < mountDeadline) {
      if (await s.evaluate(`!!document.getElementById('root')`)) break;
      await sleep(1000);
    }

    // The probe injects two scripts and awaits their load/error/timeout — a ~20s async op over CDP
    // plus a live CDN fetch. It occasionally comes back `undefined` (a transient CDP/serialization
    // hiccup on that long await), and JSON.parse(undefined) then throws — a FALSE failure. A real
    // CSP regression reproduces on every attempt; a flake does not. So retry a few times and only
    // fail on the verdict (or a persistently empty probe). A genuine network-down shows up as a
    // parseable TIMEOUT/ERRORED result, caught by the B1 check below — not as this retry.
    const probeExpr = `(async () => {
      const inject = (url) => new Promise((res) => {
        const violations = [];
        const onV = (e) => violations.push(e.violatedDirective);
        document.addEventListener('securitypolicyviolation', onV);
        const el = document.createElement('script');
        el.src = url;
        const done = (result) => { document.removeEventListener('securitypolicyviolation', onV); res({ result, violations }); };
        el.onload = () => done('LOADED');
        el.onerror = () => done('ERRORED');
        document.head.appendChild(el);
        setTimeout(() => done('TIMEOUT'), 10000);
      });
      const cdn = await inject('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-genai/wasm/genai_wasm_internal.js');
      const bad = await inject('http://example.com/blocked.js');
      return JSON.stringify({ cdn, bad });
    })()`;
    let csp = null;
    for (let attempt = 1; attempt <= 3 && !csp; attempt++) {
      const raw = await s.evaluate(probeExpr);
      if (typeof raw === 'string') { try { csp = JSON.parse(raw); } catch { /* non-JSON → retry */ } }
      if (!csp && attempt < 3) { log(`CSP probe returned no result (attempt ${attempt}/3) — transient CDP/network hiccup, retrying…`); await sleep(2000); }
    }
    if (!csp) {
      fail('CSP probe returned no parseable result after 3 attempts — the injection eval kept coming back empty (a CDP/network flake, NOT a CSP verdict). Re-run; if it persists, check network egress to the CDN.');
    } else {
      if (csp.cdn.result === 'LOADED' && csp.cdn.violations.length === 0) {
        log('PASS B1 — MediaPipe CDN wasm-loader script permitted by CSP');
      } else {
        fail(`B1 — MediaPipe CDN script was ${csp.cdn.result} (violations: ${csp.cdn.violations.join(',') || 'none'}). The prod CSP likely dropped https: from script-src.`);
      }
      if (csp.bad.violations.some((v) => v.startsWith('script-src'))) {
        log('PASS B2 — bare http: script blocked (CSP present + enforced)');
      } else {
        fail(`B2 — a bare http: script was NOT blocked (violations: ${csp.bad.violations.join(',') || 'none'}). The prod CSP may be absent entirely.`);
      }
    }
    s.close();
  }
} catch (e) {
  fail(String(e?.stack ?? e));
} finally {
  cleanup();
  process.removeAllListeners('exit');
  if (failed) console.error('[csp] FAILED ❌');
  else console.log('[csp] PASS ✅');
  process.exit(failed ? 1 : 0);
}

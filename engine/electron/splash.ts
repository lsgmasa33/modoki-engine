/**
 * Launch splash window. The editor's real window isn't created until the main-owned
 * Vite server is up (main.ts) — and on a FIRST packaged launch that waits on Node
 * provisioning + a cold Vite dep-optimize (esbuild pre-bundling three.js et al.,
 * badly slowed by Windows Defender), which can take a minute or two. Without a splash
 * the user stares at nothing / a black frame the whole time and assumes it hung.
 *
 * This shows an immediate, self-contained window (a `data:` URL — no Vite, no network,
 * renders instantly) with a spinner + a live status line the launch flow updates at
 * each milestone. Closed once the editor window has loaded. Best-effort throughout: a
 * splash failure must never break launch.
 */

import { BrowserWindow } from 'electron';

let splash: BrowserWindow | null = null;
let loaded = false;
let pending = 'Starting…';

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%}
  body{background:#1e1e1e;color:#e6e6e6;font-family:'Segoe UI',system-ui,-apple-system,sans-serif;
    display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px;user-select:none}
  .logo{font-size:30px;font-weight:600;letter-spacing:2px;color:#f0f0f0}
  .spin{width:34px;height:34px;border:3px solid #333;border-top-color:#59b4ff;border-radius:50%;
    animation:s .9s linear infinite}
  @keyframes s{to{transform:rotate(360deg)}}
  #status{font-size:13px;color:#bdbdbd;min-height:16px}
  .hint{font-size:11px;color:#7a7a7a;max-width:300px;text-align:center;line-height:1.5}
</style></head><body>
  <div class="logo">Modoki</div>
  <div class="spin"></div>
  <div id="status">Starting…</div>
  <div class="hint">First launch sets up the build tools (Node, dependencies).<br>This can take a minute or two — later launches are fast.</div>
</body></html>`;

function apply(text: string): void {
  if (!splash || splash.isDestroyed() || !loaded) return;
  splash.webContents
    .executeJavaScript(`(()=>{const e=document.getElementById('status');if(e)e.textContent=${JSON.stringify(text)}})()`)
    .catch(() => {});
}

/** Show the splash immediately (idempotent). */
export function showSplash(): void {
  if (splash) return;
  try {
    loaded = false;
    splash = new BrowserWindow({
      width: 460,
      height: 300,
      frame: false,
      resizable: false,
      center: true,
      show: false,
      backgroundColor: '#1e1e1e',
      // Not alwaysOnTop: a native folder-picker / error dialog must be able to sit above it.
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    splash.once('ready-to-show', () => splash?.show());
    splash.webContents.once('did-finish-load', () => { loaded = true; apply(pending); });
    splash.on('closed', () => { splash = null; loaded = false; });
    void splash.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
  } catch {
    splash = null; // never let a splash failure break launch
  }
}

/** Update the status line (buffered until the page loads). No-op if the splash is gone. */
export function setSplashStatus(text: string): void {
  pending = text;
  apply(text);
}

/** Close + drop the splash (idempotent). */
export function closeSplash(): void {
  try { if (splash && !splash.isDestroyed()) splash.destroy(); } catch { /* best-effort */ }
  splash = null;
}

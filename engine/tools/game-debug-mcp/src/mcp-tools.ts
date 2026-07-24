/**
 * Device MCP tools — a THIN CLIENT of Modoki's device lease.
 *
 * These tools do NOT talk to the device directly. They proxy every request through the editor
 * backend's `/api/device/request`, which forwards it over Modoki's held lease socket. The device
 * connection is DELIBERATE + owned by Modoki (the human clicks Connect in the AI panel); this MCP
 * never discovers, never auto-connects, and never holds the lease GUID (it stays server-side).
 * See docs/debug-tools-mcp.md.
 *
 * Because the connection is owned by one backend per clone, there is a single device — no
 * `target: android|ios` param and no platform in the tool name. `device_status` reflects the
 * lease; if it isn't connected, the human connects in the editor.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { writeFileSync, readFileSync, unlinkSync, statSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { tmpdir } from 'os';
import { join } from 'path';

const pExecFile = promisify(execFile);
import { encodeEvalResult, encodeStructuredResult, extFor, describeScreenshot } from './result.js';
import { parseReply, isDeviceError, decodeScreenshotReply, describeLease, type LeaseStatus } from './reply.js';

const BACKEND = (process.env.MODOKI_BACKEND ?? 'http://127.0.0.1:5179').replace(/\/$/, '');

// ── Android screenshots go through adb (NOT the lease) ───────────────────────
// A WebGL/WebGPU (Dawn/Vulkan) canvas inside an Android WebView is composited in a separate GPU
// surface, so the device's native `captureScreen` (rootView.draw / PixelCopy of the window) renders
// it BLACK — only the DOM HUD survives. `adb screencap` reads the post-composition framebuffer, so it
// captures the 3D scene + HUD together. It's a read-only side channel (no game commands), so it
// doesn't touch the lease. Used ONLY when the LEASE ITSELF is the adb-connected device (F2) — never
// just because some Android is on USB (that would screenshot the wrong device when the lease is a
// WiFi iPhone). iOS captures fine natively through the lease.

/** Screenshot dims from the last adb capture, so `device_tap`/`device_drag` can convert coordinates
 *  (the device's own `lastScreenInfo` is only set by native `captureScreen`, which Android skips). */
let adbScreenInfo: { imgW: number; imgH: number; nativeW: number; nativeH: number } | null = null;

/** Resolve the adb binary the editor PROVISIONS, not a bare `adb` on PATH. The packaged editor's adb
 *  is the provisioned SDK's `platform-tools/adb(.exe)`, which is NOT on PATH — a bare `adb` spawn
 *  ENOENTs there, so `adbAvailable()` reports false and Android WebGPU screenshots silently fall back
 *  to the native captureScreen (which renders the 3D canvas BLACK). The backend already resolves it
 *  via `detectAdb()` and reports it at `GET /api/toolchain` (`adb.path`) — mirrors the server-side
 *  fix in deviceConnection.ts. Cached once resolved (a device session doesn't swap SDKs); falls back
 *  to bare `adb` when the backend is unreachable or reports it absent (dev machines with adb on PATH). */
let adbBinCache: string | undefined;
async function resolveAdb(): Promise<string> {
  if (adbBinCache) return adbBinCache;
  try {
    const tc = (await backendGet('/api/toolchain')) as { adb?: { present?: boolean; path?: string } };
    if (tc?.adb?.present && tc.adb.path) return (adbBinCache = tc.adb.path);
  } catch { /* backend unreachable → PATH fallback below */ }
  return 'adb'; // uncached: a later probe (once the SDK resolves) can still find the provisioned path
}

async function adbAvailable(): Promise<boolean> {
  try {
    const { stdout } = await pExecFile(await resolveAdb(), ['devices'], { timeout: 2000 });
    return stdout.split('\n').some((l) => l.includes('\tdevice'));
  } catch { return false; }
}

async function sipsDims(file: string): Promise<{ w: number; h: number }> {
  const { stdout } = await pExecFile('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { timeout: 2000 });
  return {
    w: parseInt(stdout.match(/pixelWidth:\s*(\d+)/)?.[1] ?? '0'),
    h: parseInt(stdout.match(/pixelHeight:\s*(\d+)/)?.[1] ?? '0'),
  };
}

/** PNG intrinsic size from the IHDR chunk (width@16, height@20, big-endian) — pure Node, so it works
 *  where `sips` (macOS-only) is absent. `adb … screencap -p` always emits a PNG, so this suffices. */
function pngDims(buf: Buffer): { w: number; h: number } {
  return buf.length >= 24 && buf.toString('ascii', 12, 16) === 'IHDR'
    ? { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
    : { w: 0, h: 0 };
}

/** Monotonic per-process counter so concurrent captures (and sibling clones sharing this machine)
 *  don't collide on a fixed temp filename (L11). */
let capCounter = 0;

/** Full-framebuffer capture via adb. `adb exec-out` streams the PNG on stdout (no CRLF translation vs
 *  `adb shell`). On macOS we downscale to a light JPEG with `sips`; elsewhere (Windows/Linux — no
 *  `sips`) we ship the full-resolution PNG straight from screencap, reading dims from the PNG header so
 *  no external image tool is needed. `base64` is computed only when `inline` is set (P2). */
async function adbScreencap(savePath?: string, inline = false): Promise<{ path: string; base64: string; mimeType: string; bytes: number; imgW: number; imgH: number; nativeW: number; nativeH: number }> {
  const { stdout: pngBuf } = (await pExecFile(await resolveAdb(), ['exec-out', 'screencap', '-p'],
    { timeout: 8000, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 })) as unknown as { stdout: Buffer };
  const native = pngDims(pngBuf);

  if (process.platform === 'darwin') {
    const png = join(tmpdir(), `_device_screencap-${process.pid}-${++capCounter}.png`);
    writeFileSync(png, pngBuf);
    const out = savePath ?? join(tmpdir(), `device-screenshot-${process.pid}.jpg`);
    await pExecFile('sips', ['-s', 'format', 'jpeg', '--resampleWidth', '600', png, '--out', out], { timeout: 3000 });
    const img = await sipsDims(out);
    const bytes = statSync(out).size;                              // size without reading the file
    const base64 = inline ? readFileSync(out).toString('base64') : ''; // encode only when needed (P2)
    try { unlinkSync(png); } catch { /* */ }
    return { path: out, base64, mimeType: 'image/jpeg', bytes, imgW: img.w, imgH: img.h, nativeW: native.w, nativeH: native.h };
  }

  // No `sips` (Windows/Linux): ship the full-resolution PNG as-is (screencap already gave us the bytes).
  const out = savePath ? savePath.replace(/\.jpe?g$/i, '.png') : join(tmpdir(), `device-screenshot-${process.pid}.png`);
  writeFileSync(out, pngBuf);
  const base64 = inline ? pngBuf.toString('base64') : '';
  return { path: out, base64, mimeType: 'image/png', bytes: pngBuf.length, imgW: native.w, imgH: native.h, nativeW: native.w, nativeH: native.h };
}

/** F2 gate: is the LEASE connected via adb? (Not "is any Android on USB?".) When the lease is adb,
 *  `adb forward` already succeeded — so there is exactly one usable adb device and it IS the leased
 *  one; a bare `adb screencap` targets it. When the lease is WiFi (iOS, or Android-over-WiFi) we must
 *  NOT touch adb — a plugged-in sibling Android would be the wrong device. */
async function leaseUsesAdb(): Promise<boolean> {
  try {
    const s = (await backendGet('/api/device/status')) as { target?: { useAdb?: boolean } | null };
    return s?.target?.useAdb === true;
  } catch { return false; }
}

// ── Backend HTTP helpers ─────────────────────────────────────

class BackendError extends Error {}

async function backendGet(path: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${BACKEND}${path}`);
  } catch (e) {
    throw new BackendError(
      `Can't reach the Modoki backend at ${BACKEND} — is the editor running for this clone? ` +
        `(${(e as Error).message}). The MCP targets $MODOKI_BACKEND; each clone pins its own port.`,
    );
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new BackendError(String((body as { error?: string }).error ?? `HTTP ${res.status}`));
  return body;
}

async function backendPost(path: string, payload: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${BACKEND}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    throw new BackendError(
      `Can't reach the Modoki backend at ${BACKEND} — is the editor running for this clone? ` +
        `(${(e as Error).message}).`,
    );
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new BackendError(String((body as { error?: string }).error ?? `HTTP ${res.status}`));
  return body;
}

/** Proxy one data-plane request through Modoki's held lease. Returns the device's `result`
 *  (usually a JSON string — the device `safeStringify`s its replies). */
async function deviceRequest(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const body = (await backendPost('/api/device/request', { method, params })) as { result?: unknown };
  return body.result;
}

// ── Tool registration ────────────────────────────────────────

export function registerTools(server: McpServer) {

  // ── Status ─────────────────────────────────────────────────

  server.tool('device_status', 'Report the Modoki device lease (connected device, or how to connect).', {}, async () => {
    try {
      return { content: [{ type: 'text' as const, text: describeLease((await backendGet('/api/device/status')) as LeaseStatus) }] };
    } catch (e) {
      return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true };
    }
  });

  // ── Connect / Disconnect ───────────────────────────────────
  // Open/close the Modoki device lease — the same backend action as the AI panel's "Connect a Device"
  // (the panel controls have no stable selectors, so a tool is the robust path; the panel reflects the
  // lease change reactively). This is a DELIBERATE, explicit connect — it is NOT the removed Bonjour
  // auto-connect, and the lease is first-wins, so it can't storm a device another editor holds.

  server.tool('device_connect',
    'Connect the editor to a device (open the Modoki lease) — the same action as the AI panel\'s ' +
      '"Connect a Device". Pass `ip` (WiFi — the IP shown in the game\'s debug menu → Device tab) or ' +
      '`useAdb:true` (Android over USB via `adb forward`). With NEITHER, reconnects to the last target ' +
      'this clone used. Bounded (~6s); on failure it reports why (wrong IP / not same WiFi / not a Debug ' +
      'build / firewalled). Then device_* tools proxy through the lease.',
    {
      ip: z.string().optional().describe('Device LAN IP (WiFi). Omit when useAdb, or to reuse the last IP.'),
      useAdb: z.boolean().optional().describe('Android over USB via adb forward (ignores ip).'),
    },
    async ({ ip, useAdb }) => {
      try {
        const s = (await backendPost('/api/device/connect', {
          ...(ip ? { ip } : {}),
          ...(useAdb !== undefined ? { useAdb } : {}),
        })) as LeaseStatus;
        const ok = s.state === 'connected';
        return { content: [{ type: 'text' as const, text: describeLease(s) }], ...(ok ? {} : { isError: true }) };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  server.tool('device_disconnect',
    'Close the Modoki device lease (release the device so another editor can connect) — the same action ' +
      'as the AI panel\'s Disconnect.',
    {},
    async () => {
      try {
        return { content: [{ type: 'text' as const, text: describeLease((await backendPost('/api/device/disconnect', {})) as LeaseStatus) }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  // ── Eval ───────────────────────────────────────────────────

  server.tool('device_eval',
    'Execute JavaScript in the connected game page context.',
    { code: z.string().describe('JavaScript code. Use `return` for a value.') },
    async ({ code }) => {
      try {
        const result = await deviceRequest('eval', { code });
        // A device-side eval failure comes back as an `Error: …` string, not a thrown error — flag
        // it so the caller sees a tool error, not a success with error text (F15).
        return {
          content: [{ type: 'text' as const, text: encodeEvalResult(result) }],
          ...(isDeviceError(result) ? { isError: true } : {}),
        };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  // ── Percept (read-by-data) ─────────────────────────────────
  // Verify game state by DATA, not pixels — critical on device, where Claude is weak at pixels AND
  // Android WebGPU screenshots come back black (only the adb framebuffer has the scene). These proxy
  // the SAME summary-first, GUID-addressed, float-rounded ops the editor MCP uses (agentBridge), now
  // reachable on the device path. See docs/plans/device-percept-enact-plan.md.

  /** Run a structured op over the lease and shape its reply (compact JSON, or `isError` for a device
   *  `Error:` reply). Shared by the Percept tools. */
  async function perceptCall(method: string, params: Record<string, unknown> = {}) {
    try {
      const parsed = parseReply<unknown>(await deviceRequest(method, params));
      if (isDeviceError(parsed)) {
        return { content: [{ type: 'text' as const, text: String(parsed) }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: encodeStructuredResult(parsed) }] };
    } catch (e) {
      return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true };
    }
  }

  server.tool('device_get_scene_state',
    'Read the live ECS world on the connected device as DATA (no screenshot). Bare call = a compact ' +
      'INDEX (entity id/guid/name/traits, no values); drill down with a filter or enricher. Address ' +
      'entities by guid (stable across reloads), never by id. Floats are rounded — verify with a ' +
      'tolerance, not ===.',
    {
      id: z.number().int().optional().describe('Only the entity with this runtime id — reassigned on every scene hot-reload, so PREFER guid. Useful to resolve a numeric id pulled from a journal/contact payload.'),
      guid: z.string().optional().describe('Only the entity with this stable guid.'),
      name: z.string().optional().describe('Filter to entities whose name CONTAINS this (case-insensitive).'),
      trait: z.string().optional().describe('Only include this trait\'s data (still lists all entities).'),
      where: z.string().optional().describe('Predicate "Trait.field <op> value", op ∈ = != > >= < <= ~ (~ = contains).'),
      full: z.boolean().optional().describe('Every persistent trait field, not just the curated Inspector subset.'),
      world: z.boolean().optional().describe('Add resolved WORLD transform + activeInHierarchy per entity.'),
      bounds: z.boolean().optional().describe('Add each entity\'s screen-space rect + onScreen flag.'),
      contacts: z.boolean().optional().describe('Add current physics contacts/overlaps (GUID arrays) per body.'),
      limit: z.number().optional().describe('Cap entities returned (sets truncated/totalCount).'),
      precision: z.number().optional().describe('Significant digits for floats (default 9; 0 = exact).'),
    },
    async (args) => perceptCall('scene-state', Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined))),
  );

  server.tool('device_diagnose',
    'Structured render/scene health on the connected device — the CAUSES behind a black or wrong ' +
      'frame, as data (recent console errors, off-screen entities, missing renderers, …). Use this ' +
      'instead of a screenshot on Android, where the native screenshot is black on WebGPU.',
    {},
    async () => perceptCall('diagnose'),
  );

  server.tool('device_journal',
    'Read the tick-stamped game-event trace on the device (match/score/win/@contact/…) — the ' +
      'screenshot-free way to verify game LOGIC. Returns the last 100 events + byType counts over the ' +
      'whole ring, plus `captures` (Tier-2 diagnostic state). Narrow with type= and/or level=, raise ' +
      'limit=N; pair with device_dispatch_action to drive the game.\n' +
      'LEVEL: every event carries a triage severity, `info` (default) / `warn` / `error`. ' +
      'level:"warn" returns warn AND error, skipping normal-gameplay noise.\n' +
      'TIERS: lean events (semantic + @collision/@sensor/@zone transitions) are always recorded. ' +
      'High-frequency DIAGNOSTIC events (@contact) are WATCH-GATED — they record NOTHING until you ' +
      'open a capture and only from that point forward. Open/close with action:"start"/"stop" + ' +
      'type:"@contact" (do this BEFORE the moment you want to trace), then read, then stop.',
    {
      type: z.string().optional().describe('Read: only events of this type. With action: the watch-gated type to start/stop (e.g. "@contact").'),
      level: z.enum(['info', 'warn', 'error']).optional().describe('Read: only events at this severity OR ABOVE (e.g. "warn" returns warn + error).'),
      action: z.enum(['start', 'stop']).optional().describe('Open ("start") or close ("stop") a Tier-2 capture window for type=. Omit to just read.'),
      limit: z.number().optional().describe('Return the last N events (default 100).'),
      clear: z.boolean().optional().describe('Clear the journal after reading.'),
    },
    async (args) => perceptCall('journal-events', Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined))),
  );

  server.tool('device_resolve_refs',
    'Resolve journal/contact refs (GUIDs and/or numeric ids from @contact/@collision/@sensor/@zone ' +
      'payloads) to entity display NAMES — the deliberate second hop that keeps names OUT of the ' +
      'journal stream. Batch every ref you care about into one call. Names resolve even for entities ' +
      'that have since DESPAWNED (captured at emit time). Returns { resolved: { ref: {name, alive} }, ' +
      'unresolved: [...] } — an unresolved ref was never seen named (nameless/stale).',
    {
      refs: z.array(z.union([z.string(), z.number()])).describe('Refs to resolve — GUIDs and/or numeric ids.'),
    },
    async (args) => perceptCall('resolve-refs', args),
  );

  server.tool('device_introspect',
    'Discover what the game on the device exposes: dispatchable action names (+ param schemas) and ' +
      'live named read-values (e.g. canGoBack, timeSinceGameStart). Use before device_dispatch_action.',
    {},
    async () => perceptCall('game-introspect'),
  );

  server.tool('device_layout_bounds',
    'Numeric screen-space layout on the device (viewport CSS px) — UI DOM rects, 2D, and 3D world ' +
      'AABBs projected through the game camera. Use instead of eyeballing a screenshot to check ' +
      'alignment/overlap/clipping. Bare = COUNTS + the cheap offScreen/zeroSize id lists; pass ids/layer ' +
      'for per-entity rects, overlaps=true for the O(n²) pair list. Floats rounded — verify by tolerance.',
    {
      layer: z.enum(['ui', '2d', '3d']).optional().describe('Limit to one layer (implies per-entity rects).'),
      ids: z.array(z.number()).optional().describe('Limit to these entity ids (implies per-entity rects).'),
      entities: z.boolean().optional().describe('Force the per-entity rect list on an untargeted call.'),
      overlaps: z.boolean().optional().describe('Materialize the overlapping-pair list (O(n²); default off).'),
      limit: z.number().optional().describe('Cap per-entity rects (sets truncated/totalCount).'),
      precision: z.number().optional().describe('Significant digits for floats (default 9; 0 = exact).'),
    },
    async (args) => perceptCall('layout-bounds', Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined))),
  );

  server.tool('device_watch',
    'Percept WATCH on the device — a standing, change-detected numeric time-series over the live ' +
      'world (jump overshoot, spring settle, velocity decay), the feel questions a screenshot can\'t ' +
      'answer. action:start opens a focused watch (one component, optional guids/names/fields); a value ' +
      'records only when it moves > epsilon. action:read returns per-field STATS (first/last/min/max/' +
      'delta/settled) — pass samples=true for the raw curve. action:list/clear manage them.',
    {
      action: z.enum(['start', 'read', 'list', 'clear']).describe('start | read | list | clear'),
      component: z.string().optional().describe('(start) Component whose numeric fields to sample, e.g. Transform, RigidBody2D.'),
      guids: z.array(z.string()).optional().describe('(start) Restrict to these guids. (read) Filter returned series to these guids.'),
      names: z.array(z.string()).optional().describe('(start) Scope to entities whose NAME contains any of these (case-insensitive; new spawns auto-join).'),
      fields: z.array(z.string()).optional().describe('(start) Restrict to these numeric fields; omit for all.'),
      epsilon: z.number().optional().describe('(start) Change threshold (default 1e-4).'),
      everyNFrames: z.number().optional().describe('(start) Sample every Nth frame (default 1).'),
      maxSamples: z.number().optional().describe('(start) Ring cap per series (default 600).'),
      maxSeries: z.number().optional().describe('(start) Cap on moving series (default 512).'),
      expireFrames: z.number().optional().describe('(start) Auto-remove after N frames (0 = never).'),
      id: z.string().optional().describe('(read/clear) Watch id from start/list. Omit on clear to clear ALL.'),
      name: z.string().optional().describe('(read) Filter returned series to entities whose name contains this.'),
      limit: z.number().optional().describe('(read) Cap the number of series returned.'),
      clear: z.boolean().optional().describe('(read) Clear the recorded series after reading.'),
      samples: z.boolean().optional().describe('(read) Include the RAW time-series (default false — stats only).'),
      precision: z.number().optional().describe('Significant digits for floats (default 9; 0 = exact).'),
    },
    async ({ action, id, name, guids, limit, clear, samples, precision, ...start }) => {
      if (action === 'list') return perceptCall('watch-list');
      if (action === 'clear') return perceptCall('watch-clear', id ? { id } : {});
      if (action === 'read') {
        return perceptCall('watch-read', Object.fromEntries(
          Object.entries({ id, name, guids, limit, clear, samples, precision }).filter(([, v]) => v !== undefined)));
      }
      // start
      return perceptCall('watch-start', Object.fromEntries(Object.entries(start).filter(([, v]) => v !== undefined)));
    },
  );

  // ── Screenshot ─────────────────────────────────────────────

  server.tool('device_screenshot',
    'Take a screenshot of the connected device. Saves it to a file, opens it in Preview, and ' +
      'returns the PATH + dimensions as text. Use those pixel coordinates for device_tap/device_drag. ' +
      'The image is NOT inlined by default (a full-res base64 blob crowds out the task). Pass ' +
      'inline:true if you actually need to look at it.',
    {
      savePath: z.string().optional().describe('Where to save (e.g., /tmp/screenshot.jpg). Defaults to a temp file.'),
      inline: z.boolean().optional().describe('Also embed the image in the response. Large — only when you need to SEE it.'),
    },
    async ({ savePath, inline }) => {
      try {
        // Android over adb: full framebuffer via adb (captures the WebGL/WebGPU canvas the native path
        // can't). ONLY when the LEASE itself is the adb device (F2) — never just because some Android
        // is on USB, which would screenshot the wrong device when the lease is a WiFi iPhone.
        if (await leaseUsesAdb() && await adbAvailable()) {
          const cap = await adbScreencap(savePath, inline);
          adbScreenInfo = { imgW: cap.imgW, imgH: cap.imgH, nativeW: cap.nativeW, nativeH: cap.nativeH };
          if (process.platform === 'darwin') void pExecFile('open', ['-a', 'Preview', cap.path]).catch(() => {}); // fire-and-forget (macOS)
          const info = `[adb] ${cap.imgW}x${cap.imgH} (from ${cap.nativeW}x${cap.nativeH}). Use these pixel coordinates for device_tap/device_drag.`;
          return inline
            ? { content: [{ type: 'image' as const, data: cap.base64, mimeType: cap.mimeType }, { type: 'text' as const, text: info }] }
            : { content: [{ type: 'text' as const, text: describeScreenshot(info, cap.path, cap.bytes) }] };
        }
        // The lease is WiFi (or no adb): clear any stale adb dims so a later tap doesn't send the wrong
        // device's screenInfo (the iOS device sets its own lastScreenInfo on native capture).
        adbScreenInfo = null;

        // Otherwise (iOS / no adb) go through the lease → the device's native captureScreen.
        const decoded = decodeScreenshotReply(await deviceRequest('screenshot'));
        if ('error' in decoded) {
          return { content: [{ type: 'text' as const, text: decoded.error }], isError: true };
        }
        const imageDataUrl = decoded.dataUrl;
        const base64 = imageDataUrl.includes(',') ? imageDataUrl.split(',')[1] : imageDataUrl;
        const mimeType = imageDataUrl.startsWith('data:image/jpeg') ? 'image/jpeg' : 'image/png';
        const info = decoded.info + ' Use these pixel coordinates for device_tap/device_drag.';

        const buf = Buffer.from(base64, 'base64');
        const outPath = savePath ?? join(tmpdir(), `device-screenshot.${extFor(mimeType)}`);
        writeFileSync(outPath, buf);
        if (process.platform === 'darwin') void pExecFile('open', ['-a', 'Preview', outPath]).catch(() => {}); // fire-and-forget (macOS)

        const text = describeScreenshot(info, outPath, buf.length);
        return inline
          ? { content: [{ type: 'image' as const, data: base64, mimeType }, { type: 'text' as const, text: info }] }
          : { content: [{ type: 'text' as const, text }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  // ── Tap ────────────────────────────────────────────────────

  server.tool('device_tap',
    'Tap a target on the connected device. Prefer selector aiming — pass a CSS `selector` (e.g. a ' +
      'button) and the device resolves it to the element center, occlusion-checked, with NO ' +
      'screenshot needed (the fix for tapping DOM chrome like a debug-menu close button). Otherwise ' +
      'pass screenshot pixel `x`/`y` (take a device_screenshot first). Selector wins if both are given.',
    {
      selector: z.string().optional().describe('CSS selector to aim at (resolved on-device to the element center; refuses if occluded). Preferred for DOM targets.'),
      x: z.number().optional().describe('X (screenshot pixels) — used when no selector.'),
      y: z.number().optional().describe('Y (screenshot pixels) — used when no selector.'),
    },
    async ({ selector, x, y }) => {
      if (!selector && (x == null || y == null)) {
        return { content: [{ type: 'text' as const, text: 'Error: pass a selector, or both x and y (screenshot pixels).' }], isError: true };
      }
      try {
        const params = selector ? { selector } : { x, y, ...(adbScreenInfo ? { screenInfo: adbScreenInfo } : {}) };
        const reply = await deviceRequest('tap', params);
        // The device returns an `Error: …` string (no canvas, selector miss/occluded) as a normal
        // result — don't report a phantom tap as success (F9).
        if (isDeviceError(reply)) return { content: [{ type: 'text' as const, text: String(reply) }], isError: true };
        return { content: [{ type: 'text' as const, text: `Tapped ${selector ? JSON.stringify(selector) : `(${x},${y})`} — ${String(reply)}` }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  // ── Drag ───────────────────────────────────────────────────

  server.tool('device_drag',
    'Drag between two points on the connected device. Aim each end by CSS selector ' +
      '(`fromSelector`/`toSelector`, resolved + occlusion-checked on-device) or by screenshot pixel ' +
      'coords (`fromX/fromY`→`toX/toY`; take a device_screenshot first). A selector wins over coords ' +
      'for that endpoint.',
    {
      fromSelector: z.string().optional().describe('CSS selector for the start point.'),
      toSelector: z.string().optional().describe('CSS selector for the end point.'),
      fromX: z.number().optional(), fromY: z.number().optional(),
      toX: z.number().optional(), toY: z.number().optional(),
      steps: z.number().optional().describe('Intermediate steps (default: 5)'),
      delayMs: z.number().optional().describe('Delay per step ms (default: 20)'),
      dom: z.boolean().optional().describe('Drag DOM chrome (a debug widget, slider) by dispatching the pointer sequence ON the grabbed element instead of the game canvas. Auto-engages when the grab lands on a non-canvas element; pass false to force the canvas/world path.'),
    },
    async ({ fromSelector, toSelector, fromX, fromY, toX, toY, steps, delayMs, dom }) => {
      const haveFrom = fromSelector != null || (fromX != null && fromY != null);
      const haveTo = toSelector != null || (toX != null && toY != null);
      if (!haveFrom || !haveTo) {
        return { content: [{ type: 'text' as const, text: 'Error: each endpoint needs a selector or both coords (fromSelector|fromX+fromY, toSelector|toX+toY).' }], isError: true };
      }
      try {
        const reply = await deviceRequest('drag', {
          ...(fromSelector ? { fromSelector } : { fromX, fromY }),
          ...(toSelector ? { toSelector } : { toX, toY }),
          steps: steps ?? 5, delayMs: delayMs ?? 20,
          ...(dom !== undefined ? { dom } : {}),
          ...(adbScreenInfo ? { screenInfo: adbScreenInfo } : {}),
        });
        if (isDeviceError(reply)) return { content: [{ type: 'text' as const, text: String(reply) }], isError: true };
        return { content: [{ type: 'text' as const, text: `Dragged — ${String(reply)}` }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  // ── Enact: dispatch a game action directly ─────────────────

  server.tool('device_dispatch_action',
    'Trigger a game intent directly on the device (no pixel-hunting a button) — dispatches a UI/game ' +
      'action from the action vocabulary. An unknown name comes back with the known list; a stale ' +
      'targetGuid or a not-playing game is reported as an error, not a phantom success.',
    {
      name: z.string().describe('Action name (e.g. engine.playClip). Unknown → the reply lists known names.'),
      payload: z.union([z.string(), z.number()]).optional().describe('Simple scalar payload.'),
      targetGuid: z.string().optional().describe('Stable guid of the entity the action targets.'),
      params: z.record(z.string(), z.any()).optional().describe('Structured params (e.g. { clip: "Walk" }).'),
    },
    async ({ name, payload, targetGuid, params }) => {
      try {
        const sent = { name, ...(payload !== undefined ? { payload } : {}), ...(targetGuid ? { targetGuid } : {}), ...(params ? { params } : {}) };
        const parsed = parseReply<{ dispatched?: boolean; ok?: boolean; reason?: string }>(await deviceRequest('dispatch-action', sent));
        if (isDeviceError(parsed)) return { content: [{ type: 'text' as const, text: String(parsed) }], isError: true };
        // The op signals a no-op via {dispatched:false, reason} at a 200 — flag it rather than
        // reporting a phantom success (the device twin of editor finding F8).
        const failed = parsed && typeof parsed === 'object' && (parsed.dispatched === false || parsed.ok === false);
        return { content: [{ type: 'text' as const, text: encodeStructuredResult(parsed) }], ...(failed ? { isError: true } : {}) };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  // ── Enact: keyboard / hover / scroll ───────────────────────

  /** Send a device method whose reply is a bare `ok …` / `Error: …` string, flagging errors. */
  async function enactCall(method: string, params: Record<string, unknown>, ok: (reply: string) => string) {
    try {
      const reply = await deviceRequest(method, params);
      if (isDeviceError(reply)) return { content: [{ type: 'text' as const, text: String(reply) }], isError: true };
      return { content: [{ type: 'text' as const, text: ok(String(reply)) }] };
    } catch (e) {
      return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true };
    }
  }

  server.tool('device_press_key',
    'Press a key chord (keydown, brief hold, keyup) on the connected device — open the debug menu ' +
      '(key "F12"), Escape a modal, or drive gameplay keys. Dispatched on the focused element and ' +
      'bubbles to window, where the menu and input sources listen. The hold lets per-frame input ' +
      'sampling catch the down edge.',
    {
      key: z.string().describe('KeyboardEvent.key, e.g. "F12", "Escape", "ArrowLeft", "a".'),
      modifiers: z.array(z.enum(['ctrl', 'shift', 'alt', 'meta'])).optional().describe('Held modifiers, e.g. ["meta"] for Cmd+key.'),
    },
    async ({ key, modifiers }) => enactCall('press-key', { key, ...(modifiers ? { modifiers } : {}) }, (r) => r.replace(/^ok /, 'Pressed ')),
  );

  server.tool('device_hover',
    'Hover the pointer over a target on the device (pointerover/enter/move) so :hover styles, ' +
      'tooltips, and hover-gated UI activate. Aim by CSS `selector` (resolved on-device) or ' +
      'screenshot pixel `x`/`y`.',
    {
      selector: z.string().optional().describe('CSS selector to hover (preferred).'),
      x: z.number().optional().describe('X (screenshot pixels) — used when no selector.'),
      y: z.number().optional().describe('Y (screenshot pixels) — used when no selector.'),
    },
    async ({ selector, x, y }) => {
      if (!selector && (x == null || y == null)) {
        return { content: [{ type: 'text' as const, text: 'Error: pass a selector, or both x and y.' }], isError: true };
      }
      return enactCall('hover', selector ? { selector } : { x, y }, (r) => r);
    },
  );

  server.tool('device_scroll',
    'Scroll on the device by dispatching a wheel event. Aim by CSS `selector` or screenshot pixel ' +
      '`x`/`y` (defaults to viewport center). Positive `dy` scrolls down, positive `dx` scrolls right.',
    {
      dx: z.number().optional().describe('Horizontal wheel delta (default 0).'),
      dy: z.number().optional().describe('Vertical wheel delta (default 0; positive = down).'),
      selector: z.string().optional().describe('CSS selector to scroll over.'),
      x: z.number().optional().describe('X (screenshot pixels) — the point to scroll over.'),
      y: z.number().optional().describe('Y (screenshot pixels).'),
    },
    async ({ dx, dy, selector, x, y }) =>
      enactCall('scroll', { ...(dx != null ? { dx } : {}), ...(dy != null ? { dy } : {}), ...(selector ? { selector } : {}), ...(x != null ? { x } : {}), ...(y != null ? { y } : {}) }, (r) => r),
  );

  // ── Console Logs ───────────────────────────────────────────

  server.tool('device_console_logs',
    'Return captured console.log/warn/error/info from the game.',
    {
      limit: z.number().optional().describe('Max entries (default: 50)'),
      level: z.enum(['log', 'warn', 'error', 'info']).optional(),
    },
    async ({ limit, level }) => {
      try {
        const raw = await deviceRequest('consoleLogs', { limit: limit ?? 50, ...(level ? { level } : {}) });
        const result = parseReply<Array<{ level: string; args: string[]; timestamp: number }>>(raw);
        const text = !result || result.length === 0
          ? 'No console logs.'
          : result.map((l) => `[${new Date(l.timestamp).toLocaleTimeString()}] [${l.level}] ${l.args.join(' ')}`).join('\n');
        return { content: [{ type: 'text' as const, text }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  // ── Native Logs ────────────────────────────────────────────

  server.tool('device_native_logs',
    'Return native logs from the device (logcat on Android, os_log on iOS).',
    {
      limit: z.number().optional().describe('Max lines (default: 50)'),
      filter: z.string().optional().describe('Text filter (case-insensitive). Only return lines containing this string.'),
      seconds: z.number().optional().describe('Time window in seconds (default: 60)'),
    },
    async ({ limit, filter, seconds }) => {
      try {
        const raw = await deviceRequest('nativeLogs', {
          limit: limit ?? 50,
          seconds: seconds ?? 60,
          ...(filter ? { filter } : {}),
        });
        const result = parseReply<string[]>(raw);
        return { content: [{ type: 'text' as const, text: (Array.isArray(result) ? result.join('\n') : String(result)) || 'No logs.' }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );
}

# Electron Migration — Code & Architecture Review

> **Resolution (2026-06-12):** All P0–P2 findings and most P3 have been fixed
> (Phases A–F). Verified: typecheck clean, 735 app + 1353 engine tests pass, lint 0
> errors, prod editor build succeeds, asset streaming confirmed end-to-end (correct
> `Content-Length`), and the prod CSP confirmed safe (the only `eval` is in the
> dev/native-gated game debug bridge, never the packaged editor). **Intentionally
> deferred:** P3-4 (extract a shared `readJsonBody` — the size cap was added to the
> Electron host; the Vite dev host keeps its own reader), P3-5 (`/api/build` SSE is
> dev-only by design — the packaged editor has no "build a game" window yet), P3-9
> (over-broad `entitlementsInherit` on toktx — harmless; only `disable-library-
> validation` matters and it works), P3-10 (cosmetic not-found semantics / scaffold
> `castShadow`).

Branch: `electron-migration` · Reviewed: 2026-06-12 · Surface: ~8.2k LoC across the
Electron main process, the backend-router extraction, offscreen WebGPU capture, the
build/signing pipeline, and the MCP server.

Five focused reviews were run in parallel; findings below are **de-duplicated,
verified against the source, and prioritized**. False positives that the review
surfaced are listed at the end so we don't re-investigate them.

Overall the migration is well-structured. The asset-path traversal guard in
`resolveAssetPath` is solid, the offscreen capture's prior three WebGPU fixes are
correct, the toktx staging + dmg double-notarization are sound, and the MCP↔backend
contract matches. The real problems cluster in **(1) Electron security hardening**,
**(2) a packaged-build runtime crash for model reimport**, **(3) offscreen-capture
concurrency/allocation**, and **(4) build verification/versioning gaps**.

---

## P0 — Blockers (fix before calling the build shippable)

### P0-1. `meshoptimizer` missing from `dependencies` → model reimport crashes in packaged app
- **Where:** `package.json` (absent from `dependencies`); used at `plugins/model-convert.ts:257` (`await import('meshoptimizer')`) and `:70`.
- **Verified:** `deps.meshoptimizer = undefined`. electron-builder's collector only walks `dependencies`, so the module is not bundled; `import('meshoptimizer')` throws `Cannot find module` in the packaged app.
- **Compounding:** `model-convert.ts:70` resolves `../node_modules/meshoptimizer/package.json` via a relative URL that won't resolve inside `app.asar` (try/catch'd → only breaks the meshopt cache key, not a hard crash, but signals wrong packaged-layout assumptions).
- **Also note:** model reimport additionally shells out to `npx --no-install @gltf-transform/cli` (a *devDependency*) and `gltfpack` (an external PATH binary) — **neither is bundled**, so even with meshoptimizer fixed, model reimport is non-functional in a shipped build (texture reimport *does* work — it's the documented path).
- **Decision required:** is model reimport an end-user feature in the packaged editor, or dev-only?
  - **(a) Make it work:** add `meshoptimizer` + `@gltf-transform/cli` to `dependencies`, fix the pkg-path resolution to `require.resolve('meshoptimizer/package.json')`, and stage `gltfpack` the way toktx is staged (beforePack copy + sign + `disable-library-validation`).
  - **(b) Gate it dev-only:** detect `app.isPackaged` and surface a clear "model reimport requires the dev toolchain" message instead of a stack trace; update the electron-builder.yml header comment (which currently only promises *texture* degradation).
- **Fix effort:** (b) ~1h · (a) ~half-day (gltfpack native staging is the cost).

---

## P1 — High (real bugs / security; fix this pass)

### P1-1. No navigation / window-open / CSP hardening on the BrowserWindow
- **Where:** `electron/main.ts` `createWindow` — `contextIsolation:true` + `nodeIntegration:false` are set (good) but **verified: no `will-navigate`, no `setWindowOpenHandler`, no CSP** anywhere in `electron/*.ts`.
- **Why:** The renderer loads a full origin (Vite/HMR in dev) that runs arbitrary game + scene-asset code and may load remote `http(s)://` refs. Any in-page navigation or `window.open` can point the *main editor window* (or an un-hardened child) at an attacker origin that still holds the preload `bridge` — an IPC handle to a backend that writes/moves/deletes files and runs `osascript`/`open`/`execFileSync`.
- **Fix:** add `will-navigate` (deny cross-origin), `setWindowOpenHandler` (deny + `shell.openExternal`), set `sandbox: true` explicitly, and a CSP via `session.webRequest.onHeadersReceived` (at least in prod).
- **Effort:** ~1–2h.

### P1-2. Bridge IPC trusts any sender frame
- **Where:** `electron/main.ts:247` `ipcMain.on('modoki:bridge-send', …)` — no `event.senderFrame` / origin check (verified).
- **Why:** Combined with P1-1, a navigated or child frame can (a) poison `cachedSchema` so all later validate/mutate type-checks are wrong, or (b) forge `response` messages to resolve a pending `requestRenderer` with attacker data.
- **Fix:** validate `event.senderFrame === mainWindow.webContents.mainFrame` in the handler; gate the preload `bridge` exposure on the expected origin.
- **Effort:** ~30m.

### P1-3. Offscreen captures are not serialized → concurrent captures corrupt the renderer
- **Where:** `packages/modoki/src/runtime/rendering/offscreenCapture.ts` (single-slot registry, **no queue** — verified) + `Scene3D.tsx` `offscreenRender` (two `await` points, shared `capturing` flag).
- **Why:** A `render-sequence` overlapping a `render-scene` (two MCP clients, or sequence + manual) interleaves: the second capture binds its own RT mid-readback of the first, the `finally` restores the renderer to a *disposed* RT, and whichever finishes first clears `capturing`, unparking the live loop into the other capture's bound target. Result: wrong pixels + renderer left bound to a disposed target (later live frames render garbage / throw). Reachable from normal MCP use.
- **Fix:** serialize at the registry boundary with a module-level promise chain (`queue = queue.then(() => fn(opts))`, `.catch` so a failure doesn't poison the chain). This also makes the `capturing` prevRT/reset logic correct (capture only ever nests against the live loop, never another capture).
- **Effort:** ~30m.

### P1-4. `requestRenderer` pending requests leak / hang across project reload
- **Where:** `electron/main.ts` — `setProject()` calls `webContents.reload()` but never rejects in-flight `pendingRenderer` entries; `requestRenderer` checks `!mainWindow` but not `webContents.isDestroyed()`.
- **Why:** A request outstanding across Open-Project only resolves via its 3s timeout; new requests during reload are silently dropped by `webContents.send` and hang to timeout — exactly when an MCP client is likely polling `/api/scene-state`. A send during teardown can throw.
- **Fix:** on `reload()` and `win.on('closed')`, reject + clear all `pendingRenderer` (clearing timers); guard `send` with `!wc.isDestroyed()`. Consider serializing project swaps (build new backend before stopping old — mirror the scene resource "acquire-before-release" pattern).
- **Effort:** ~1h.

### P1-5. Synchronous `readFileSync` of large assets on the Electron main/UI thread, per request
- **Where:** `plugins/backend/staticAssets.ts` (`statSync`+`readFileSync` in `serveProjectAsset`/`serveAppShell`) and `electron/backendServer.ts` body buffering.
- **Why:** GLB/HDR/KTX2 assets are tens of MB. In dev the Vite server did this in its own process; in Electron it's **in-process with the UI**, so a large read blocks the event loop → window + IPC stall. Also `req.on('data', c => raw += c)` buffers POST bodies (base64 asset writes can be large) into a JS string with no size cap → O(n²) growth + OOM risk.
- **Fix:** stream large assets with `fs.createReadStream` + `Content-Length` (needs a stream-capable `BackendResult` variant), or at minimum `fs.promises.readFile`. Accumulate request bodies into `Buffer[]` + `Buffer.concat` with a max-size guard.
- **Effort:** ~2–3h (the stream-result variant touches both hosts).

### P1-6. Forward-version scenes load silently with no warning
- **Where:** `packages/modoki/src/runtime/loaders/loadSceneFile.ts` migration chain (forward-only no-op guards) + `version.ts` (`SCENE_FORMAT_VERSION`).
- **Why:** A scene authored by a *newer* engine (`version > SCENE_FORMAT_VERSION`) passes through every migration step untouched and loads as-is — no error, no warning — even though the engine may not understand its data.
- **Fix:** after the chain, `if (data.version > SCENE_FORMAT_VERSION) console.warn(...)` and surface it through `validate-scene` warnings.
- **Effort:** ~30m.

### P1-7. No post-notarization verification in the release pipeline + version pinned at `0.0.0`
- **Where:** `scripts/notarize.cjs` / `scripts/staple-dmg.cjs` (no `stapler validate`/`spctl` assertion); `.github/workflows/release.yml` (never verifies); `package.json` version `0.0.0`.
- **Why:** If Apple returns "Accepted" with issues or stapling silently no-ops, the build still "succeeds." And every artifact ships as `Modoki Editor-0.0.0` regardless of git tag — auto-update (`latest-mac.yml`) would be permanently broken since the version never increases.
- **Fix:** add a CI verify step (`xcrun stapler validate` + `spctl -a -vvv -t install` on `.app` and `.dmg`, fail on non-zero); map the release tag → version (`npm version --no-git-tag-version ${TAG#v}` or `--config.extraMetadata.version`).
- **Effort:** ~1h.

---

## P2 — Medium (correctness/robustness; fix soon)

### P2-1. `serveAppShell` traversal guard is a prefix-match, not a boundary-match
- **Where:** `plugins/backend/staticAssets.ts:130` — `candidate.startsWith(distDir)` (verified). `DIST_DIR` has no trailing separator, so a sibling dir sharing the prefix (`/app/dist` vs `/app/dist-secrets`) passes.
- **Why:** This is the exact unsafe check the codebase explicitly rejected in `resolveAssetPath`. Loopback-only + prod-only bounds the impact, but it's trivially wrong and the inconsistency will bite when someone changes the join.
- **Fix:** reuse the `path.relative(distDir, candidate)` + `..`/`isAbsolute` reject pattern from `resolveAssetPath`. Add a unit test (both functions are pure).
- **Effort:** ~30m.

### P2-2. SPA fallback masks missing-asset 404s as `index.html` + 200
- **Where:** `staticAssets.ts` — `serveProjectAsset` returns `null` for a missing plain asset → Electron falls through to `serveAppShell` → returns `index.html` with **200**. A missing `.webp`/`.glb` then gets parsed as HTML by the texture/model loader.
- **Why:** Classic prod-only footgun; inconsistent with the explicit 404 returned for missing *cached variants*.
- **Fix:** in `serveAppShell`, only fall back to index.html for extensionless SPA routes; return a real 404 for extensioned asset paths (or have `serveProjectAsset` 404 any `/games//modoki//basis/` miss).
- **Effort:** ~30m.

### P2-3. RenderTarget + canvas/context/ImageData allocated per capture (never pooled)
- **Where:** `Scene3D.tsx` `offscreenRender` — fresh `RenderTarget` (GPU color tex + depth + bind groups) **and** a new `<canvas>`/2D context/`ImageData`/base64 string every call.
- **Why:** A 120-frame `render-sequence` churns 120 RTs + 120 canvases; at 4096² that's 64 MB `ImageData` + multi-MB base64 each, thrown away every frame. WebGPU `dispose()` frees lazily, so a tight sequence can outrun the driver and spike VRAM. `getContext('2d')!` also throws unhelpfully if the browser canvas cap is hit.
- **Fix:** pool one RT per (w,h) and one offscreen canvas/context on the closure; `setSize` on dimension change; dispose only in `cleanupRef`. Reuse a single capture camera via `.copy(camera)` instead of `.clone()`. Consider `OffscreenCanvas.convertToBlob` to skip the base64 round-trip (the backend base64-decodes it immediately anyway).
- **Effort:** ~2h.

### P2-4. A hung GPU op permanently parks the live render loop
- **Where:** `Scene3D.tsx` — if `renderAsync`/`readRenderTargetPixelsAsync` hangs (GPU stall / lost device), the `finally` never runs, `capturing` stays `true`, and `renderFrame` early-returns forever → editor viewport freezes silently (the IPC times out at 15s but the renderer stays wedged).
- **Fix:** `Promise.race` the GPU ops with a timeout that rejects (so `finally` resets `capturing`); add a watchdog.
- **Effort:** ~1h.

### P2-5. Temp render/capture files accumulate in `os.tmpdir()` unbounded (flagged by 3 reviewers)
- **Where:** `electron/rendererOps.ts` (`captureViewport`) + `editorBackendRouter.ts` (`/api/render-scene`, `/api/render-sequence` via `writeDataUrlToTemp`). Nothing ever deletes `modoki-capture-*` / `modoki-render-*`.
- **Why:** A long MCP session leaves hundreds of MB. On mid-sequence failure the already-written frames also leak (and the MCP layer drops the partial `paths` on a 504 — see P2-6).
- **Fix:** sweep `modoki-{capture,render}-${pid}-*` older than N minutes on each render (or on process exit / startup). Optionally write into a dedicated subdir.
- **Effort:** ~45m.

### P2-6. MCP `postJson` drops the body on non-2xx → partial render frames lost; no fetch timeout
- **Where:** `tools/modoki-mcp/src/index.ts` — `call()` has no `AbortSignal` (a wedged backend hangs the user's Claude session forever); render tools' 504 partial-failure body (with already-rendered `paths`) is discarded as plain error text.
- **Fix:** add `signal: AbortSignal.timeout(ms)` (generous for `render-sequence`: ~`frames/fps + buffer`, default ~180s); for the render tools, surface the response body even on non-2xx so partial `paths` reach the agent.
- **Effort:** ~45m.

### P2-7. Missing cache headers + non-ASCII LOD cache miss
- **Where:** `staticAssets.ts` — content-hashed variant/LOD URLs (`~uastc.ktx2`, `.lod0.glb`) are immutable by construction but served with **no `Cache-Control`**, so the renderer re-fetches on every reload (the GCS build path *does* set `immutable, max-age=31536000` — local server should mirror for parity). Separately, branch 3 (model LOD) passes the still-URL-encoded `sourceUrl` to `lodCachePath` (branch 4/texture decodes it) → a CJK/Cyrillic-named GLB's LOD won't be found.
- **Fix:** add `Cache-Control: public, max-age=31536000, immutable` to the content-hashed branches, `no-cache` for `.json`/manifest. `decodeURIComponent(mm[1])` in the LOD branch to match the texture branch.
- **Effort:** ~30m.

---

## P3 — Low (cleanups / hardening; opportunistic)

- **P3-1** `electron/main.ts` `before-quit` is `async` but Electron won't await it — `server.close()`/watcher close may not finish (harmless on quit; remove the false-graceful `await`s or `preventDefault()` + `app.exit()` after).
- **P3-2** `electron/ssrLoader.ts` `creating` promise isn't reset on failure → a one-time `createServer()` error wedges all later SSR loads until `closeSsrLoader`.
- **P3-3** `electron/main.ts` `waitForServer` leaks `ClientRequest`s on each failed poll and can `resolve`/`reject` after settling — track + `clearTimeout` the retry, `req.destroy()` on error, settled flag.
- **P3-4** Shared JSON body-read is duplicated in `vite-asset-scanner.ts` and `backendServer.ts` (the one bit the refactor *didn't* centralize) — extract `readJsonBody(req)` with the size cap from P1-5.
- **P3-5** `/api/build` (SSE) and `/api/exit` exist only in the Vite host; `/api/build` 404s in the packaged editor — confirm "build a game" is intended dev-only, else the Build window is dead in the shipped app.
- **P3-6** Two copies of `SCENE_FORMAT_VERSION` (`scripts/scaffold-project.mjs:29` vs `version.ts:14`) — add a tiny test asserting they match so a future bump doesn't leave the scaffold stamping a stale version.
- **P3-7** Docs stale vs shipped pipeline: `electron/SIGNING.md` "Still pending" lists toktx-bundling + app-icon (both done); `electron-builder.yml` header still says "toktx is NOT yet bundled."
- **P3-8** `release.yml` keychain relies on `CSC_IDENTITY_AUTO_DISCOVERY` — prefer first-class `CSC_KEYCHAIN`/`CSC_LINK`+`CSC_KEY_PASSWORD`; `rm` the `.p8` from runner temp in an `if: always()` step.
- **P3-9** `entitlementsInherit` gives bundled `toktx` JIT/unsigned-memory entitlements it doesn't need (only `disable-library-validation` matters) — harmless, tighten if desired.
- **P3-10** `serveProjectAsset` not-found semantics inconsistent (branch 1 `null` vs branches 3/4 explicit 404); `scaffold-project.mjs` `Sun` light sets `castShadow:true` with no shadow config + nothing to receive (cosmetic for a starter scene).
- **P3-11** Preload `bridge.on` never returns an unsubscribe handle → renderer listeners accumulate across HMR.
- **P3-12** Explicit `arch: [arm64]` (or `[arm64, x64]`) in `electron-builder.yml` for clarity; Intel currently gets no native build.

---

## Investigated — NOT bugs (don't re-litigate)

- **Electron prod serves a stale/source manifest** — false. `electron/assetBackend.ts:43` builds a **live** manifest with settings baked (`buildManifest(scanAllAssets(roots), true)`). The editor serves the opened project's assets live (like the old Vite dev server); the baked `dist/assets.manifest.json` is for *shipping a game*, a different pipeline. Variant resolution works in the packaged editor.
- **Scaffold entity-id collision** — false. Hardcoded ids `1,2,3,10,11`; `nextId` returns `max+1 = 12`. The gap is harmless.
- **HTTP server exposed beyond loopback** — false. Binds `127.0.0.1` (`backendServer.ts`).
- **`resolveAssetPath` traversal** — solid. Uses `path.relative` + `..`/absolute reject; `write-file`/move/delete are confined to discovered asset roots. (Only `serveAppShell`'s *separate, weaker* guard is wrong — P2-1.)
- **MCP injection surface** — clean. POST bodies are JSON; `osascript`/`open` use `execFileSync` argv form (no shell); server-side `resolveAssetPath` rejects path escapes.
- **The three prior offscreen WebGPU fixes** (buffer return, 256-byte stride unpad, alpha forcing) — all correct. (H3 stride-inference robustness is a hardening, not a present bug.)

---

## Suggested execution order

1. **Phase A — packaged-build correctness (P0-1 decision + P1-7):** decide model-reimport scope, fix or gate it, add CI verify + tag→version. *Without this the shipped artifact is either crashing or unverifiable.*
2. **Phase B — Electron hardening (P1-1, P1-2):** navigation/window-open/CSP + IPC sender check. Small, high-value, self-contained.
3. **Phase C — capture & lifecycle robustness (P1-3, P1-4, P2-3, P2-4, P2-5):** serialize captures, pool resources, fix reload races, sweep temp files. Mostly in `offscreenCapture.ts` / `Scene3D.tsx` / `main.ts`.
4. **Phase D — serving correctness & perf (P1-5, P2-1, P2-2, P2-7):** streaming + body cap, traversal boundary fix, 404 semantics, cache headers. Touches both hosts via shared `staticAssets.ts`.
5. **Phase E — MCP & versioning polish (P1-6, P2-6, P3-6):** forward-version warn, fetch timeout + partial-result surfacing, version-sync test.
6. **Phase F — P3 cleanups** opportunistically.

Each phase is independently shippable and testable. Phases A–B are the ones that
gate "this is a real signed product"; C–D are the ones most likely to cause
user-visible flakiness during an MCP-driven editing session.

import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { isAbsolute } from 'path';

/** Perform a genuine native `import()`, bypassing Vite's SSR module-runner rewrite.
 *
 *  Vite's `ssrTransform` unconditionally rewrites EVERY `import(...)` call inside code
 *  it loads through its runner-based pipeline into a call routed through its SSR module
 *  runner (`__vite_ssr_dynamic_import__` → `ModuleRunner.dynamicRequest`). The editor
 *  launches Vite with `--configLoader runner` (see `engine/electron/devServer.ts` — it
 *  avoids writing an esbuild-bundled config into a read-only packaged tree), so
 *  `vite.config.ts` AND every plugin it statically imports (this file among them) load
 *  that way. That runner can be CLOSED independently of the dev server itself (an
 *  internal Vite 8 lifecycle detail — `_ssrCompatModuleRunner`), and once closed, every
 *  dynamic import routed through it throws `Vite module runner has been closed.` —
 *  silently breaking on-demand asset baking (texture/env/model conversion) with no
 *  recovery short of a full editor restart. This is what caused the "white models on a
 *  cold asset cache" bug: the auto-heal bake's `import('sharp')` / `import('three/...')`
 *  threw, `autoBakeThenServe` swallowed it, and the texture/env request just 404'd.
 *
 *  The usual `/* @vite-ignore *\/` escape hatch does NOT help — that only suppresses a
 *  client-side analysis WARNING, not this SSR rewrite, which is unconditional and has no
 *  opt-out. The only reliable bypass is hiding the `import()` syntax from Vite's parser
 *  entirely: `new Function` evaluates its body as fresh source text Vite never sees or
 *  transforms, so the `import()` inside it is Node's own native dynamic import.
 *
 *  ── Two runtime contexts, two code paths ──
 *  This helper runs in TWO places, and the `new Function` bypass is only correct in one:
 *
 *  1. The Vite dev-server child (`--configLoader runner`, plain ESM through the runner).
 *     `import.meta.url` is a real file URL here. This is the ONLY context where the SSR
 *     rewrite (and thus the runner-closed bug) applies, so the `new Function` bypass is
 *     needed. BUT `new Function`-scoped code has no module referrer, so its `import()`
 *     resolves BARE specifiers relative to `process.cwd()`, NOT this module — fine for the
 *     Vite child (cwd is always the repo/app root) but fragile. We harden it by resolving
 *     the specifier to an ABSOLUTE `file://` URL first (`createRequire` walks up to the
 *     right `node_modules`; `pathToFileURL` is mandatory on Windows, where a raw `C:\…`
 *     path is not a valid `import()` specifier), so resolution never depends on cwd.
 *
 *  2. The Electron main process (esbuild-bundled `main.cjs` — the `/api/reimport` path the
 *     "Reimport All" button + MCP tool hit). This code is NOT loaded through Vite's
 *     runner, so there is nothing to bypass — and esbuild leaves a dynamic `import(spec)`
 *     as a NATIVE import that resolves relative to `main.cjs` (module-relative, so it
 *     finds the unpacked `node_modules` regardless of the process cwd — which for a
 *     Finder-launched packaged app is `/`). Using `new Function` here would be actively
 *     WRONG: it would switch that correct module-relative resolution to cwd-relative and
 *     404 in the packaged editor. We detect this context by `import.meta.url` being
 *     falsy: esbuild compiles `import.meta.url` in a CJS bundle to `undefined`.
 *
 *  Do NOT use this for loading PROJECT source that needs Vite's transform (TS/JSX
 *  compilation) — that's what `ctx.ssrLoadModule` is for. */
/** Pure resolution logic for context (1) above, factored out so it's unit-testable without
 *  needing a real Vite-runner `import.meta.url` or a `new Function` import (which throws under
 *  Vitest — see the VITEST guard in `nativeDynamicImport`). Given the caller's `import.meta.url`
 *  (`undefined` in a bundled CJS context — see context (2)) and a specifier, returns:
 *  - `null` when there's nothing to resolve against (context (2) — caller should fall through
 *    to a plain, unmodified `import(specifier)`)
 *  - an absolute `file://` URL when the specifier resolves to a real path (the common case:
 *    `sharp`, `three`, a subpath like `three/examples/jsm/loaders/HDRLoader.js`)
 *  - the ORIGINAL specifier unchanged when it can't be resolved this way (a Node builtin like
 *    `node:fs`, which `require.resolve` returns as a bare id — not a path — or anything that
 *    throws, e.g. an already-URL specifier) */
export function resolveNativeImportTarget(specifier: string, metaUrl: string | undefined): string | null {
  if (!metaUrl) return null;
  try {
    const resolved = createRequire(metaUrl).resolve(specifier);
    // `require.resolve` returns a bare id for Node builtins ('fs', 'node:fs') — only
    // real filesystem paths get turned into a file:// URL.
    return isAbsolute(resolved) ? pathToFileURL(resolved).href : specifier;
  } catch {
    // Unresolvable (a builtin some other way, or already a URL) — pass through unchanged.
    return specifier;
  }
}

export function nativeDynamicImport(specifier: string): Promise<unknown> {
  // Vitest's own test-run Vite server transforms this file too, but it wires a
  // dynamic-import callback only for literal `import()` syntax it can see — a
  // `new Function`-constructed script is a detached scope with no such callback
  // registered, so Node throws "A dynamic import callback was not specified."
  // Vitest's per-run server is short-lived and never hits the runner-closes-mid-session
  // bug this bypass exists for, so a plain dynamic import is fine (and required) here.
  if (process.env.VITEST) return import(specifier);

  // esbuild-bundled Electron main (CJS): `import.meta.url` compiles to `undefined`, and
  // this code isn't under Vite's runner. A plain dynamic import stays native (esbuild
  // preserves `import(<variable>)`) and resolves module-relative — correct in the
  // packaged app where cwd is unreliable. See context (2) above.
  const target = resolveNativeImportTarget(specifier, import.meta.url);
  if (target === null) return import(specifier);

  // Vite dev-server runner (ESM): the specifier is already resolved to an absolute file URL
  // (cwd-independent, Windows-safe) — hide the import() from Vite's SSR rewrite. See context
  // (1) above.
  return new Function('specifier', 'return import(specifier)')(target) as Promise<unknown>;
}

import { describe, it, expect } from 'vitest'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { resolveNativeImportTarget } from '../../plugins/native-dynamic-import'

/**
 * Regression guard for the "white models on a cold asset cache" fix (texture-load-bug.md).
 *
 * `resolveNativeImportTarget` is the resolution logic behind `nativeDynamicImport`'s bypass of
 * Vite's SSR module-runner rewrite. It's tested directly (rather than through
 * `nativeDynamicImport` itself) because the two things that select its branches — a bundled CJS
 * context's `import.meta.url` being `undefined`, and the real Vite-runner `import.meta.url` — are
 * both static per-module and can't be faked from a test; and `process.env.VITEST` is already
 * `true` under Vitest, short-circuiting `nativeDynamicImport` to a plain `import()` before this
 * logic would even run. This file's own `import.meta.url` stands in for "a real ESM module URL"
 * (the shape context (1), the Vite dev-server runner, actually has).
 */
describe('resolveNativeImportTarget', () => {
  const require_ = createRequire(import.meta.url)

  it('returns null when metaUrl is undefined (bundled Electron main — nothing to resolve against)', () => {
    // Mirrors context (2): esbuild compiles `import.meta.url` to `undefined` in the CJS bundle,
    // so the caller must fall through to a plain, module-relative `import()` instead.
    expect(resolveNativeImportTarget('sharp', undefined)).toBeNull()
  })

  it('resolves a real package to an absolute file:// URL, independent of the specifier string', () => {
    // The bug this guards: a bare specifier handed to `new Function`'s import() resolves
    // relative to process.cwd(), not this module — so the target must be an ABSOLUTE URL.
    const target = resolveNativeImportTarget('sharp', import.meta.url)
    expect(target).not.toBeNull()
    expect(target).toMatch(/^file:\/\//)

    const expected = pathToFileURL(require_.resolve('sharp')).href
    expect(target).toBe(expected)
  })

  it('resolves a deep subpath (three/examples/jsm/loaders/HDRLoader.js) the same way', () => {
    // env-convert.ts's actual specifier — subpaths must resolve, not just bare package names.
    const specifier = 'three/examples/jsm/loaders/HDRLoader.js'
    const target = resolveNativeImportTarget(specifier, import.meta.url)
    expect(target).toBe(pathToFileURL(require_.resolve(specifier)).href)
  })

  it('resolves @gltf-transform/core and meshoptimizer (model-convert.ts specifiers)', () => {
    for (const specifier of ['@gltf-transform/core', '@gltf-transform/extensions', 'meshoptimizer']) {
      const target = resolveNativeImportTarget(specifier, import.meta.url)
      expect(target).toBe(pathToFileURL(require_.resolve(specifier)).href)
    }
  })

  it('passes a Node builtin through UNCHANGED, not as a file:// URL', () => {
    // require.resolve('node:fs') returns the bare id 'node:fs' — not a filesystem path — so
    // isAbsolute() must reject turning it into a (nonsensical) file:// URL.
    expect(resolveNativeImportTarget('node:fs', import.meta.url)).toBe('node:fs')
  })

  it('passes an unresolvable specifier through unchanged instead of throwing', () => {
    // require.resolve() throws MODULE_NOT_FOUND for a nonexistent package — the caller (an
    // asset-bake plugin) must not crash the whole convert pipeline on this; falling through to
    // the original specifier reproduces plain `import()`'s own (equally loud) failure instead.
    expect(resolveNativeImportTarget('this-package-does-not-exist-xyz', import.meta.url)).toBe(
      'this-package-does-not-exist-xyz',
    )
  })
})

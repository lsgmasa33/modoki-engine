/** Shape-agnostic readers for `resolve.alias` in vite.config.
 *
 *  The non-playable branch is an ARRAY of `{find, replacement}`, not an object, because the
 *  msdfgen wasm entry has to be a REGEX and has to come FIRST: the runtime imports
 *  `@zappar/msdf-generator/msdfgen_wasm.wasm?url` so Vite emits the wasm as an asset, and the
 *  package-DIR alias would otherwise rewrite that subpath to a file that does not exist. A
 *  plain string `find` cannot pre-empt it, because @rollup/plugin-alias will not match an id
 *  carrying a `?url` query.
 *
 *  These helpers exist so the guards keep testing the GUARANTEE (this specifier maps to that
 *  path) rather than the container it is expressed in — the array switch broke two guard tests
 *  that indexed the object form, while every property they assert was still intact. */

type AliasEntry = { find: string | RegExp; replacement: string };
type AliasShape = Record<string, string> | AliasEntry[] | undefined;

function entries(alias: AliasShape): AliasEntry[] {
  if (!alias) return [];
  return Array.isArray(alias)
    ? alias
    : Object.entries(alias).map(([find, replacement]) => ({ find, replacement }));
}

/** The replacement for an exact STRING `find`, in either shape. */
export function aliasFor(alias: AliasShape, name: string): string | undefined {
  const hit = entries(alias).find((e) => e.find === name);
  return hit ? String(hit.replacement) : undefined;
}

/** Every string `find` key, in either shape (regex finds are skipped — no key to report). */
export function aliasKeys(alias: AliasShape): string[] {
  return entries(alias).map((e) => e.find).filter((f): f is string => typeof f === 'string');
}

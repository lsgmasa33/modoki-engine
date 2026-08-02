/** Fills in the parts of `Response` the asset-cache `fetch` stubs leave out.
 *
 *  WHY THIS EXISTS. Each cache test hand-rolled `{ ok: true, json: async () => body }`. That double
 *  has no `text()`, which a real `Response` always has — so when the loaders moved to
 *  `parseAssetJson` (which reads the body as TEXT so it can tell Vite's `index.html` SPA fallback
 *  from a real asset), twelve tests failed with `res.text is not a function` while the production
 *  path was correct. An incomplete fake failing a correct change is the least useful kind of test
 *  failure, and the same gap was duplicated across four files.
 *
 *  Derives `text()` from `json()` when a stub only supplies the latter, which is the direction a
 *  real `Response` works too: bytes are the truth and `json()` is a convenience over them. A stub
 *  that supplies its own `text()` (to exercise the SPA fallback, or a truncated file) is passed
 *  through untouched. */
export async function completeResponse(r: unknown): Promise<Response> {
  const partial = r as Partial<Response> & { json?: () => Promise<unknown> };
  if (!partial || typeof partial !== 'object' || typeof partial.text === 'function') return r as Response;
  if (typeof partial.json !== 'function') return r as Response;
  const body = await partial.json();
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ...partial, text: async () => text, json: async () => body } as Response;
}

/** The editor backend this server aims at, resolved ONCE (#1894). Its own module because two
 *  files need the same answer — `mcp-tools.ts` calls it and `index.ts` banners it — and because
 *  `resolveBackend` finds the clone from the `import.meta.url` of a file directly in `src/`. */

import { resolveBackend } from '../../shared/backendUrl.js';

export const BACKEND_RESOLUTION = resolveBackend({
  env: process.env.MODOKI_BACKEND,
  entryModuleUrl: import.meta.url,
});

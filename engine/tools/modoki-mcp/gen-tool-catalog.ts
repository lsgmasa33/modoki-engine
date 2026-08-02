/** Regenerate the tool catalog table inside `docs/debug-tools-mcp.md`.
 *
 *      npm --prefix engine/tools/modoki-mcp run gen:catalog
 *
 *  The rendering lives in `src/toolCatalog.ts` so the sync GUARD
 *  (`engine/tests/tools/toolCatalogSync.test.ts`) checks the doc against the same function this
 *  writes with — otherwise the guard would be testing a second implementation, which is the drift it
 *  exists to prevent (conventions §9).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spliceCatalog, extractCatalog, renderCatalog } from './src/toolCatalog.js';

const here = dirname(fileURLToPath(import.meta.url));
const docPath = join(here, '../../../docs/debug-tools-mcp.md');

const before = readFileSync(docPath, 'utf8');
const after = spliceCatalog(before);
if (before === after) {
  console.log(`catalog already up to date (${docPath})`);
  process.exit(0);
}
writeFileSync(docPath, after);
const rows = renderCatalog().split('\n').filter((l) => l.startsWith('| `modoki_')).length;
console.log(`catalog regenerated: ${rows} tool rows → ${docPath}`);
console.log(`(${extractCatalog(after).length} chars between the markers)`);

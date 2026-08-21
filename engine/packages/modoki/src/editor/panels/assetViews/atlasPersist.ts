/** AtlasAssetView's write+report, extracted (#308 close-out, part D-2) so it is
 *  unit-testable without mounting the component. `AtlasAssetView.tsx`'s `update` callback used
 *  to inline `void writeAssetFile(...).then((ok) => { if (!ok) reportWriteFailed(...) })` —
 *  which is plain logic, but it lived INSIDE the component, so covering it meant mounting the
 *  panel (forbidden — see CLAUDE.md § Panels: editor `.tsx` carries no tests, `.ts` does).
 *  Minimal extraction: same write, same order, same failure message; the component now just
 *  calls this instead of inlining the write+report itself. */

import { writeAssetFile } from '../assetOps';
import { reportWriteFailed } from './persist';

/** Write an atlas document's serialized content to `path` and report (console + toast) if the
 *  write did not land. Fire-and-forget by design — the caller does not await this, matching the
 *  optimistic-update-then-report shape every sibling asset view uses (see `persist.ts`'s
 *  `reportWriteFailed` header). Returns the write's own boolean so a test can await it. */
export async function persistAtlasDoc(path: string, content: string): Promise<boolean> {
  const ok = await writeAssetFile(path, content);
  if (!ok) reportWriteFailed(path, 'the atlas write was rejected');
  return ok;
}

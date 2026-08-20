/** Compile-time guard on the Find References wire shape (#284).
 *
 *  The editor dialog cannot import `engine/plugins/assetRefGraph.ts` — that module
 *  reaches the tree-shaker's filesystem walk, which has no business in the browser
 *  bundle — so `editor/panels/findReferencesFormat.ts` hand-mirrors the response
 *  shape. A hand-mirrored type drifts, silently, and the drift surfaces as a dialog
 *  quietly rendering `undefined` for a field the server renamed.
 *
 *  This file is the guard. It lives under `engine/tests/` because that is the only
 *  TS program that can see BOTH sides (the plugin and the package's editor source),
 *  and it is typechecked by `engine/tsconfig.test.json` in `npm run typecheck` — so
 *  a drift is a red build, not a discovery.
 *
 *  Direction, deliberately one-way: the SERVER's type must be assignable to the
 *  MIRROR's. That is what the dialog actually needs — it must be able to consume
 *  everything the route sends. The reverse is intentionally not asserted, because
 *  the mirror is legitimately WIDER in one spot (`origin: string` against the
 *  server's `GuidOrigin | 'entity-ref'`), which is a display-only looseness and
 *  cannot cause a wrong reading.
 *
 *  Both imports are `import type`, so nothing here pulls code into any bundle. */

import { describe, it, expect } from 'vitest';
import type { FindReferencesResponse } from '../../plugins/assetRefGraph';
import type { FindReferencesResultLike } from '../../packages/modoki/src/editor/panels/findReferencesFormat';

// The assertion IS the type annotation: if the server's shape stops satisfying the
// dialog's, this line fails `tsc` and the build goes red. `satisfies` would not do —
// it checks the literal, and there is no literal here.
type ServerFitsDialog = FindReferencesResponse extends FindReferencesResultLike ? true : never;
const _serverFitsDialog: ServerFitsDialog = true;

describe('find-references wire shape', () => {
  it('the server response satisfies the dialog\'s mirrored type', () => {
    // The real check happened at compile time above; this keeps the file a runnable
    // test rather than a lint-suppressed orphan, and keeps `_serverFitsDialog` used.
    expect(_serverFitsDialog).toBe(true);
  });
});

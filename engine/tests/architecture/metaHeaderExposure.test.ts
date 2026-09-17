/** Every custom response header the router emits is READABLE by the Electron renderer (#1305).
 *
 *  ## The failure this exists to catch, which shipped once
 *
 *  The Electron editor talks to the backend **cross-origin** (`http://127.0.0.1:<port>`), so a
 *  response header outside the CORS safelist is invisible to `headers.get(...)` unless it is named
 *  in `Access-Control-Expose-Headers`. The failure mode is the worst shape available: the request
 *  succeeds, the status is 200, the body is perfect, no console error appears — and the header
 *  reads `null`. `backendServer.ts`'s own docblock has warned about this since #845.
 *
 *  It happened anyway. `/api/read-meta` grew `X-Meta-Local-Missing`, the route tests asserted the
 *  route emitted it, and a same-origin `fetch` through the Vite dev server read it back fine — so
 *  every check available short of launching the Electron editor was green while the feature was
 *  completely inert there. **The Vite dev path is same-origin and therefore cannot reproduce it**,
 *  which is precisely why a unit test could not have caught it and this structural one can.
 *
 *  ## Why it reads the router rather than listing the headers
 *
 *  A hand-kept list here would be a THIRD copy (the route, the server, this file) and would rot the
 *  first time someone adds a header without reading this comment — which is the exact sequence that
 *  produced the bug. So the expected set is DERIVED from the router's own source: whatever
 *  `editorBackendRouter.ts` can put in a `headers` object is what must be exposed.
 *
 *  ⚠️ Read through the shared scanner, so a header name appearing in PROSE does not satisfy it —
 *  `commentStripperIsShared.test.ts` enforces that repo-wide, and this file is a forbidden-absence
 *  guard, where a comment counting as code would make it fail silently green. */

import { describe, it, expect } from 'vitest';
import path from 'path';
import { readScannedSource } from '@modoki/engine/testing';

const REPO = path.resolve(__dirname, '../../..');
const source = (rel: string): string => readScannedSource(path.join(REPO, rel)).code;

describe('custom response headers are exposed to the cross-origin renderer (#845, #1305)', () => {
  it('every X-* header the router emits appears in Access-Control-Expose-Headers', () => {
    const router = source('engine/plugins/backend/editorBackendRouter.ts');
    const server = source('engine/electron/backendServer.ts');

    // Header keys as the router spells them in a `headers` object literal: `'X-Foo': value`.
    // Case-INSENSITIVE, and compared lowercased below: HTTP header names are, so `'x-foo'` in the
    // router is the same header as `X-Foo` in the expose list — and a case-sensitive scan would
    // simply not SEE a lowercase emitter, which is this guard's silent-green direction.
    const emitted = new Set([...router.matchAll(/['"](x-[a-z0-9-]+)['"]\s*:/gi)].map((m) => m[1].toLowerCase()));
    expect(emitted.size, 'the router should emit at least the CAS baseline header — if this is 0 the regex has rotted, not the code').toBeGreaterThan(0);

    const exposeLine = server.match(/Access-Control-Expose-Headers['"]\s*,\s*['"]([^'"]*)['"]/i);
    expect(exposeLine, 'backendServer must set Access-Control-Expose-Headers').not.toBeNull();
    const exposed = new Set((exposeLine![1]).split(',').map((h) => h.trim().toLowerCase()));

    const unreadable = [...emitted].filter((h) => !exposed.has(h)).sort();
    expect(
      unreadable,
      'these headers are emitted by the router but NOT listed in Access-Control-Expose-Headers, so '
      + '`headers.get(...)` returns null in the Electron editor — silently, on a 200, with no console '
      + 'error. The Vite dev server is same-origin and will read them fine, so this cannot be caught '
      + 'by running the dev editor either. Add each to the list in engine/electron/backendServer.ts.',
    ).toEqual([]);
  });
});

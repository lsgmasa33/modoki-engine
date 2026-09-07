/** Guard: every CLIENT-side reach of `/api/write-file` goes through the ONE write wrapper
 *  (`writeAssetFile`/`postWriteFile`, `editor/backend/editorBackend.ts`) — #835.
 *
 *  WHY. The editor serialises scene/prefab/asset-document JSON client-side and POSTs the
 *  finished string to `/api/write-file`. Before #835, 14 raw call sites (5 of them near-
 *  identical wrapper functions) each spelled out their own `JSON.stringify(x, null, 2)`, and
 *  NONE of them appended the trailing newline the committed corpus (and the server's
 *  `assetJsonBytes`) carries — 537 committed `.scene.json`/`.prefab.json` files lost it this
 *  way. `jsonFileBody` is the client mirror of `assetJsonBytes`; this guard is what stops a
 *  FUTURE writer from being added the same way the first 14 were.
 *
 *  ⚠️ **Scanned against the ROUTE STRING, not the `JSON.stringify(...)` pattern.** The issue's
 *  own grep anchored on `JSON.stringify(x, null, 2)` and missed four real sites
 *  (`AnimationEditor.tsx`, two in `modelImport.ts`, `convertToGLB.ts`) — a call site that
 *  composes its body some other way (a template literal, a helper, string concatenation) is
 *  invisible to that pattern but still reaches the route. Anchoring on `'/api/write-file'`
 *  itself has no such blind spot: nothing can reach the route without writing its name.
 *
 *  ⚠️ **This guard is about the ROUTE, not about JSON vs binary.** Three real sites are
 *  deliberately EXEMPT because they write BASE64 BINARY (a UltraHDR JPEG, an extracted PNG
 *  texture, a converted GLB) and must NEVER pass through `jsonFileBody` — that would append a
 *  spurious trailing byte and corrupt the asset. They still route through `backendFetch`
 *  directly rather than the shared wrapper (unlike every JSON site, which now does) — see each
 *  EXEMPT entry for why collapsing them onto the wrapper was left for a separate change rather
 *  than smuggled into this one.
 *
 *  ⚠️ **`games/**` is out of this guard's SCAN, and that is now a real gap rather than a deferred
 *  decision.** A GAME can reach this route too, through the public barrel, and `games/sling`'s
 *  Level and Wave editors did exactly that with the pre-#835 shape. That was fixed in `bfa91e5d6`:
 *  `jsonFileBody`/`writeAssetFile` are exported from `@modoki/engine/editor` and both sling sites
 *  route through them — so the old justification for not scanning games ("a game could not route
 *  through them even if it wanted to") no longer holds and must not be cited.
 *
 *  The scan still stops at the engine, so a NEW game-side raw write would not be caught here.
 *  Widening it means deciding what a game is allowed to do with `backendFetch` at all — games own
 *  their own editor panels — which is a bigger question than this guard. Stated as a known blind
 *  spot so nobody reads a green run as covering `games/**`. */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';
import { repoFiles, repoRoot } from '../../scripts/repoCorpus.mjs';

/** The one thing every reach of the route has in common, regardless of how the call composed
 *  its body — a template literal, string concat, a helper — none of which the pattern this
 *  guard replaces (`JSON.stringify(x, null, 2)`) could see. */
const ROUTE = '/api/write-file';

/** The engine's own client trees. `games/**`/`demos/**` are excluded — see the docblock above:
 *  a game reaching this route is a REAL, separate population this commit does not touch. */
const ROOTS = ['engine/packages/modoki/src', 'engine/app', 'engine/electron'];

/** The ONE sanctioned definition — excluded STRUCTURALLY, like `repoCorpus.mjs` is excluded from
 *  `corpusProducerIsShared.test.ts`'s own scan, not listed as an "exemption awaiting a fix". */
const SANCTIONED = 'engine/packages/modoki/src/editor/backend/editorBackend.ts';

/** Every OTHER file whose CODE (comment-stripped) still reaches the route directly, with the
 *  reason it is not a JSON call site awaiting migration onto `writeAssetFile`/`jsonFileBody`.
 *  Keep this SHORT and reasoned — an entry is a claim that the write is genuinely binary. */
const EXEMPT: ReadonlyArray<{ file: string; reason: string }> = [
  {
    file: 'engine/packages/modoki/src/editor/panels/assetViews/EnvironmentAssetView.tsx',
    reason: 'Writes a browser-encoded UltraHDR JPEG as base64 (`bytesToBase64(jpeg)`) — binary, '
      + 'never JSON. `jsonFileBody` must never touch this content or it gains a spurious '
      + 'trailing byte and corrupts the asset.',
  },
  {
    file: 'engine/packages/modoki/src/editor/scene/modelImport.ts',
    reason: 'Writes a PNG texture extracted from the imported model, base64-encoded — binary, '
      + 'never JSON. The two JSON writers in this same file (material/mesh docs, via '
      + '`writeAssetFileOrAbort`) DO route through `jsonFileBody`; only this one binary write '
      + 'stays on a raw `backendFetch` call, deliberately (#835 brief: "binary writes keep '
      + 'their current path" — routing it through the shared boolean-returning wrapper would '
      + 'turn a network exception into an import ABORT instead of a per-texture skip, a '
      + 'behaviour change this commit does not make).',
  },
  {
    file: 'engine/packages/modoki/src/editor/scene/convertToGLB.ts',
    reason: 'Writes a converted GLB (OBJ/FBX/DAE → GLB) as base64 — binary, never JSON.',
  },
];

/** ⚠️ Floors are PER ROOT, not one total, and that is the difference between a guard and a
 *  formality. Tracked counts today: `packages/modoki/src` 802, `app` 72, `electron` 23. Against a
 *  single `floor: 800` the two smaller roots could BOTH vanish from the enumeration — a typo in
 *  `ROOTS`, a `under` prefix that stops matching — and 802 still clears it, so the gate stays
 *  green while covering 95 fewer files. A total floor can only see the biggest root. */
const ROOT_FLOORS: Record<string, number> = {
  'engine/packages/modoki/src': 700,
  'engine/app': 50,
  'engine/electron': 15,
};

function clientSources() {
  const all: ReturnType<typeof repoFiles> = [];
  for (const root of ROOTS) {
    const floor = ROOT_FLOORS[root];
    if (floor === undefined) throw new Error(`clientJsonWriteSeam: ROOTS gained ${root} with no floor in ROOT_FLOORS — add one, or the new root is enumerated with nothing checking it did not come back empty.`);
    all.push(...repoFiles({ under: root, match: /\.tsx?$/, floor }));
  }
  return all;
}

describe('every client-side reach of /api/write-file goes through the one wrapper (#835)', () => {
  it('no file outside the sanctioned wrapper (or an EXEMPT binary writer) reaches the route directly', () => {
    const exempt = new Map(EXEMPT.map((e) => [e.file, e.reason]));
    const offenders: string[] = [];
    for (const { rel, abs } of clientSources()) {
      if (rel === SANCTIONED || exempt.has(rel)) continue;
      const { code } = readScannedSource(abs);
      if (code.includes(ROUTE)) offenders.push(rel);
    }
    expect(
      offenders,
      `these files reach ${ROUTE} directly instead of routing through writeAssetFile/jsonFileBody `
        + `(editor/backend/editorBackend.ts, #835) — either move the write onto the shared wrapper, `
        + `or add it to EXEMPT in this file with the reason it is genuinely binary:\n`
        + offenders.join('\n'),
    ).toEqual([]);
  });

  /** The exemption ledger must not rot into a place to silence the guard: every entry has to
   *  name a file that still exists and still reaches the route — see `corpusProducerIsShared
   *  .test.ts`'s identical check for why a stale entry is a hole nobody can see. */
  it('every EXEMPT entry still exists and still reaches the route', () => {
    for (const { file, reason } of EXEMPT) {
      const abs = path.join(repoRoot(), file);
      expect(fs.existsSync(abs), `EXEMPT file no longer exists: ${file}`).toBe(true);
      const { code } = readScannedSource(abs);
      expect(code.includes(ROUTE), `${file} no longer reaches ${ROUTE} — drop it from EXEMPT`).toBe(true);
      expect(reason.length, `${file} needs a real reason`).toBeGreaterThan(40);
    }
  });

  /** The SANCTIONED file must itself still define the route — a guard whose "one true definition"
   *  quietly stopped defining anything would pass this whole file vacuously. */
  it('the sanctioned wrapper module still defines the route', () => {
    const abs = path.join(repoRoot(), SANCTIONED);
    const { code } = readScannedSource(abs);
    expect(code.includes(ROUTE)).toBe(true);
  });

  /* ---------------------------------------------------------------------------- Non-vacuity. */

  /** ⚠️ **Test the ACCEPT side too, not just the reject side.** A guard proving it flags a raw
   *  POST never proves it recognises the COMPLIANT shape as compliant — the failure mode this
   *  closes: the detector degrading to "always offending" (which would just make every real
   *  call site an EXEMPT entry, defeating the guard) as easily as "never offending". Synthetic
   *  input, not a count of survivors — the population this fixes shrinks toward zero by design. */
  it('the detector is provably alive: flags a raw POST, accepts the shared wrapper (synthetic input)', () => {
    const offending =
      `const ok = await backendFetch('${ROUTE}', { method: 'POST', body: JSON.stringify({ `
      + `path, content: JSON.stringify(doc, null, 2) }) }).then((r) => r.ok);`;
    expect(offending.includes(ROUTE)).toBe(true);

    // The accept side: routing through the shared wrapper never spells the route out again —
    // that IS what "one definition" means, and it's what every one of the 14 fixed call sites
    // in this commit now looks like.
    const compliant = `const ok = await writeAssetFile(path, jsonFileBody(doc));`;
    expect(compliant.includes(ROUTE)).toBe(false);
  });

  /** And the comment-stripping half specifically: a file that only DISCUSSES the route in prose
   *  (there are over a dozen of these in the real population — `dirtyAssets.ts`,
   *  `contentHash.ts`, `assetOps.ts`'s own doc comment, …) must not be flagged. Proven against
   *  real files by the main test above (none of them are in EXEMPT), and pinned here directly
   *  so a regression in the strip itself — not just in this guard's own logic — is caught. */
  it('a file that only mentions the route in a COMMENT is not flagged', () => {
    const src = `/** Writes go out via ${ROUTE}, handled elsewhere. */\nexport const x = 1;\n`;
    const stripped = readScannedSourceFromString(src);
    expect(stripped.includes(ROUTE)).toBe(false);
  });
});

/** Route a synthetic string through the same comment stripper `readScannedSource` uses, without
 *  needing a real file on disk. Mirrors `readScannedSource`'s `.js`-language path exactly (this
 *  guard only ever scans `.ts`/`.tsx`), so the sentinel test above exercises the real stripper,
 *  not a re-implementation of it. */
function readScannedSourceFromString(src: string): string {
  const tmp = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-write-file-seam-')),
    'probe.ts',
  );
  fs.writeFileSync(tmp, src);
  try {
    return readScannedSource(tmp).code;
  } finally {
    fs.rmSync(tmp, { force: true });
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  }
}

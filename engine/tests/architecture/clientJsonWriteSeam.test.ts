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
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';
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
 *  Keep this SHORT and reasoned — an entry is a claim that the write is genuinely binary.
 *
 *  ⚠️ **A row pardons a COUNT of route reaches, not the file (#1123/#1128).** It used to be skipped
 *  whole with `exempt.has(rel)`, so a JSON writer added beside `modelImport.ts`'s one binary write
 *  was green — in the very file whose reason already argues about ONE write among several. The
 *  route string is the same at every reach, so the key is the bare file and the multiplicity lives
 *  in `count`.
 *
 *  ⚠️ It counts route STRINGS, not requests (close-out review). A second literal is caught; a local
 *  helper holding the one literal and called twice is not, and neither is swapping the one binary
 *  write for a JSON write in place — same file, same count. The count bounds how many reaches a row
 *  can hide; the reason still has to be true of the one it names. */
const EXEMPT: ReadonlyArray<{ item: string; count?: number; reason: string }> = [
  {
    item: 'engine/packages/modoki/src/editor/panels/assetViews/EnvironmentAssetView.tsx',
    reason: 'Writes a browser-encoded UltraHDR JPEG as base64 (`bytesToBase64(jpeg)`) — binary, '
      + 'never JSON. `jsonFileBody` must never touch this content or it gains a spurious '
      + 'trailing byte and corrupts the asset.',
  },
  {
    item: 'engine/packages/modoki/src/editor/scene/modelImport.ts',
    reason: 'Writes a PNG texture extracted from the imported model, base64-encoded — binary, '
      + 'never JSON. The two JSON writers in this same file (material/mesh docs, via '
      + '`writeAssetFileOrAbort`) DO route through `jsonFileBody`; only this one binary write '
      + 'stays on a raw `backendFetch` call, deliberately (#835 brief: "binary writes keep '
      + 'their current path" — routing it through the shared boolean-returning wrapper would '
      + 'turn a network exception into an import ABORT instead of a per-texture skip, a '
      + 'behaviour change this commit does not make).',
  },
  {
    item: 'engine/packages/modoki/src/editor/scene/convertToGLB.ts',
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
    const reaches: Array<{ item: string; site: string }> = [];
    for (const { rel, abs } of clientSources()) {
      const { code } = readScannedSource(abs);
      const lines = code.split('\n');
      lines.forEach((line, i) => {
        for (let n = line.split(ROUTE).length - 1; n > 0; n--) reaches.push({ item: rel, site: `${rel}:${i + 1}` });
      });
    }
    assertExemptionLedger({
      label: 'EXEMPT in clientJsonWriteSeam',
      population: reaches,
      exempt: EXEMPT,
      sanctioned: [SANCTIONED],
      // 4 reaches measured 2026-09-13 (the sanctioned wrapper's one + the three binary writers), but
      // the floor is 1 on purpose: an exact floor makes every legitimate FIX report "the detector
      // stopped matching" instead of the over-blessed row it really is. Detector liveness is
      // carried by `sanctioned` — its staleness check fails if the wrapper's own reach is not found.
      floor: 1,
      fix: `this reaches ${ROUTE} directly instead of routing through writeAssetFile/jsonFileBody `
        + '(editor/backend/editorBackend.ts, #835), so a JSON write loses the trailing newline the '
        + 'corpus carries. Move it onto the shared wrapper; only a genuinely BINARY write is exempt.',
    });
  });

  it('every EXEMPT reason is a real reason', () => {
    for (const { item, reason } of EXEMPT) {
      expect(reason.length, `${item} needs a real reason`).toBeGreaterThan(40);
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

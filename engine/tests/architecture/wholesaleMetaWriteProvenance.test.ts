/** Every wholesale `.meta.json` writer establishes that a read LANDED for the path it is about to
 *  replace — and declares HOW (#890 close-out review).
 *
 *  WHY. `/api/write-meta` replaces the sidecar wholesale, and `writeMetaSidecar` salvages an `id`
 *  only from a CORRUPT file (`salvageIdIfCorrupt`) — so writing a document with no `id` over a
 *  HEALTHY sidecar drops the asset's GUID and the next scan mints a fresh one, dangling every
 *  scene/prefab/material reference to it. That was driven on `main` in #890, on the park route.
 *
 *  ⚠️ **The park route's guard does not reach here, deliberately.** `parkMetaEdit` refuses a
 *  document whose `READ_FOR_PATH` stamp is absent or foreign (#891); `writeMetaConditional` does
 *  NOT, because the explicit-action writers legitimately build a document no read produced —
 *  `ModelAssetView`'s collision-mesh write posts `{ id: modelGuid, generated: … }` for a GENERATED
 *  glb, sets the `id` itself, and would be refused by a stamp check at the endpoint. So provenance
 *  here is each writer's own job, and the point of this rule is that "its own job" stops being a
 *  habit four files share and becomes a declaration that goes red when one drops it.
 *
 *  ⚠️ **The scar this exists for: asking the TAG question instead of the PROVENANCE question.**
 *  `EnvironmentAssetView.apply()` gated on `metaCameFromFailedRead(meta)` for one release. That
 *  predicate requires `doc !== null` — so it answered `false` for the one state where the panel
 *  holds no document at all. A THROWN `/api/read-meta` leaves `meta` at `null` with every control
 *  live, and Apply encoded a gainmap, committed a multi-MB `~ultrahdr.jpg`, then replaced the
 *  sidecar with an id-less document. The other three writers were safe only because each had
 *  independently reached for "did a read land" instead. A guard that is right in three files by
 *  coincidence is what this table converts into one that is checked.
 *
 *  ⚠️ **Its sibling on the other route is `assetEditorRefusesUnreadableDoc.test.ts` (#886/#896),
 *  and neither rule is the whole answer.** That one covers asset DOCUMENTS (the dirty-asset
 *  registry) and asks whether a failed LOAD was classified before anything was substituted for it;
 *  this one covers `.meta.json` sidecars and asks whether the document about to replace a file was
 *  read for that path. Same destruction, two routes, two seams — check which registry a new writer
 *  is on before deciding which rule it owes.
 *
 *  Same idiom, and the same both-directions discipline, as `metaReadPreferringPark.test.ts`'s
 *  `baseline`/`fallback`/`readPath` fields: a source scan (editor `.tsx` carries no tests of its
 *  own — `docs/editor.md` § Panels), comment-stripped through the shared scanner so a mechanism
 *  NAMED in prose cannot be mistaken for one that runs. */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { readScannedSource } from '@modoki/engine/testing';

const SRC = path.resolve(__dirname, '../../packages/modoki/src/editor');
const read = (rel: string) => readScannedSource(path.join(SRC, rel)).code;
const EDITOR_PREFIX = 'engine/packages/modoki/src/editor/';

function editorSourceFiles(): string[] {
  return repoFiles({ under: SRC, match: /\.tsx?$/, floor: 150 }).map(({ rel }) => {
    if (!rel.startsWith(EDITOR_PREFIX)) throw new Error(`wholesaleMetaWriteProvenance: ${rel} is not under ${EDITOR_PREFIX}`);
    return rel.slice(EDITOR_PREFIX.length);
  });
}

/** How a writer establishes that a read landed for the path it replaces.
 *
 *  - `'stamp'` — asks `metaReadPathOf(doc) !== path`, the #891 provenance predicate. The strongest
 *    of the four: it covers `null`, a thrown read AND a document read for a different asset, and
 *    it subsumes the failed-read tag (that fallback is unstamped too).
 *  - `'loadedRef'` — a `metaLoadedRef` boolean set only inside the read's `.then`, so a throw
 *    leaves it `false`. Hand-rolled per file; correct, and the reason `metaReadFallback.ts`'s
 *    docblock warns that a third modal editor copying the shape could forget the line.
 *  - `'early-return'` — no fallback at all: the read's `!ok` branch returns before the write.
 *  - `'fresh-doc'` — writes a document it BUILT, with an explicit `id`, for a path it never read
 *    (a generated asset). Nothing to establish; the identity is in hand by construction.
 *  - `'abort-on-tag'` — consumes the failed-read tag and throws, abandoning the whole operation
 *    rather than refusing one write. The strongest CONSEQUENCE of the five, and the only one for
 *    which refusing the write alone would not be enough. */
type Provenance = 'stamp' | 'loadedRef' | 'early-return' | 'fresh-doc' | 'abort-on-tag';

const WRITERS: Record<string, { provenance: Provenance; why: string }> = {
  'panels/assetViews/EnvironmentAssetView.tsx': {
    provenance: 'stamp',
    why: 'Apply is decided BEFORE the gainmap encode and the ~ultrahdr.jpg write, so a refusal '
      + 'cannot orphan a multi-MB variant. It asks the provenance question rather than the tag one '
      + 'because its `meta` is nullable and a thrown read leaves it null — the #890 hole.',
  },
  'panels/NineSliceEditor.tsx': {
    provenance: 'loadedRef',
    why: 'a modal with its own per-path reset; `metaLoadedRef` is set only from the read\'s `.then`.',
  },
  'panels/SpriteEditor.tsx': {
    provenance: 'loadedRef',
    why: 'same shape as NineSliceEditor — a modal, its own reset, its own loaded flag.',
  },
  'panels/makeTexture2D.ts': {
    provenance: 'early-return',
    why: 'its own comment: "A FAILED READ MUST ABORT — it must never fall back to `{}`". It flushes, '
      + 'reads and writes in one synchronous body, so there is no window to guard.',
  },
  'scene/modelImport.ts': {
    provenance: 'abort-on-tag',
    why: 'the door neither helper covers — it POSTs /api/write-meta with a raw backendFetch at three '
      + 'sites. Its hazard is also the worst shape: it reads the sidecar precisely to PRESERVE the '
      + 'model guid (`existingMeta.id ?? newGuid()`), so a failed read writes a document with a '
      + 'DIFFERENT id rather than none — complete-looking, so the heal pass never flags it. '
      + 'Refusing the write would not be enough either: the import would go on to spawn entities '
      + 'against a model whose guid it just failed to preserve, so it throws ImportWriteAborted.',
  },
  'scene/pendingMeta.ts': {
    provenance: 'stamp',
    why: 'the FLUSH is a wholesale writer too — `flushPendingMeta`/`flushPendingMetaFor` post every '
      + 'parked document through `writeMetaConditional`. Its provenance is the registry invariant: '
      + 'nothing enters `pending` that `parkMetaEdit` has not just checked `metaReadPathOf(doc) === '
      + 'path` on, so every document it flushes was read for the path it replaces. It was excluded '
      + 'from this table for one revision as "a definition, not a writer", which was wrong twice '
      + 'over — it defines neither helper and it writes.',
  },
  'panels/assetViews/ModelAssetView.tsx': {
    provenance: 'fresh-doc',
    why: 'the collision-mesh write targets a GENERATED glb this panel never read, and passes '
      + '`{ id: modelGuid, generated: … }` — the identity comes from the import, not from a read. '
      + 'This is the writer a stamp check at `writeMetaConditional` would wrongly refuse.',
  },
};

/** `true` if `code` (comment-stripped) writes a `.meta.json` WHOLESALE — through either shared
 *  helper, or by POSTing the route itself.
 *
 *  ⚠️ **The route half is not belt-and-braces; without it this rule's central claim was false the
 *  day it landed.** `scene/modelImport.ts` replaces three sidecars with a raw
 *  `backendFetch('/api/write-meta', …)` and names neither helper, so a helper-only detector left
 *  the LARGEST existing door undeclared while the docblock above claimed an undeclared writer was
 *  impossible — and a sixth writer copying that file's shape would have been invisible too. Same
 *  substring idiom, and the same reasoning, as `metaReadPreferringPark.test.ts`'s
 *  `hasRawReadMetaFetch`: the route is always a literal in the code, never assembled.
 *
 *  ⚠️ **Known bound, stated rather than papered over: this is per FILE and by NAME.** It cannot see
 *  a second, unguarded write inside a file that already declares (a declaration vouches for a
 *  file's writes, not for each one), and an aliased import (`writeMetaWholesale as saveMeta`)
 *  escapes the helper half — though not the route half, since the alias still POSTs nothing. Both
 *  need an AST pass to close; the source scan is what `docs/editor.md` § Panels leaves available
 *  here, and a rule with a stated bound beats a rule whose bound is discovered later. */
function callsWholesaleMetaWriter(code: string): boolean {
  return /\b(writeMetaWholesale|writeMetaOrWarn)\s*\(/.test(code) || code.includes('/api/write-meta');
}

const DETECTORS: Record<Provenance, (code: string) => boolean> = {
  stamp: (c) => /\bmetaReadPathOf\s*\(/.test(c),
  loadedRef: (c) => /if\s*\(\s*!\s*metaLoadedRef\.current\s*\)/.test(c),
  'early-return': (c) => /if\s*\([^)]*!\s*\w+\.ok[^)]*\)\s*\{[\s\S]{0,400}?return\s+false/.test(c),
  // ⚠️ A BARE IDENTIFIER after `id:`, never a member expression. `{ id: meta.id, …}` is the exact
  // 19th-site shape `metaReadFallback.ts` documents as dangerous — an `id` read off a document that
  // may be the fallback, posting `id: undefined` once `JSON.stringify` drops it — and a detector
  // that only looked for `{ id:` would let a writer in that shape declare "I built this document".
  'fresh-doc': (c) => /(writeMetaWholesale|writeMetaOrWarn)\s*\([^)]*\{\s*id:\s*[A-Za-z_$][\w$]*\s*[,}]/.test(c),
  'abort-on-tag': (c) => /\bmetaCameFromFailedRead\s*\(/.test(c) && /\bthrow\s+new\s+\w*Abort/.test(c),
};

describe('every wholesale .meta.json writer declares how it knows a read landed (#890)', () => {
  /** ⚠️ Named files, not a count. `repoFiles({… floor: 150})` THROWS below 150, so a
   *  `.toBeGreaterThan(150)` sanity check can only fail in a one-file-wide window and measures
   *  nothing — an idiom inherited from `metaReadPreferringPark.test.ts` and worth not inheriting.
   *  Asserting that the enumeration contains files this rule actually reasons about is a control
   *  that can fail for the reason it exists: a drifted root, a changed glob, a moved panel. */
  it('the scan really enumerates the files this rule reasons about', () => {
    const files = new Set(editorSourceFiles());
    for (const rel of [...Object.keys(WRITERS), 'panels/assetViews/widgets.tsx', 'panels/Inspector.tsx']) {
      expect(files.has(rel), `${rel} is not in the enumerated corpus — the scan root or glob has drifted`).toBe(true);
    }
  });

  /** ⚠️ Both directions. A declared writer that no longer writes is a stale entry (and a stale
   *  declaration is what let #871 through); an UNdeclared writer is a new door onto the route with
   *  nobody asked how it establishes identity — the case this rule exists to make impossible. */
  it('the declared set is exactly the set of files that write wholesale', () => {
    const actual = editorSourceFiles().filter((rel) => callsWholesaleMetaWriter(read(rel))).sort();
    // ⚠️ ONE exclusion, and it is the DEFINITION site: `widgets.tsx` declares
    // `writeMetaWholesale`/`writeMetaOrWarn`, and `function writeMetaWholesale(` matches a
    // name-plus-paren detector exactly as a call does. It is where the tag check lives, not a
    // writer with provenance of its own. `scene/pendingMeta.ts` was excluded here too for one
    // revision, on the same "it's a definition" reasoning — it is not: it defines neither helper,
    // and its flush replaces sidecars. It has a row above now.
    const DEFINITION_SITE = 'panels/assetViews/widgets.tsx';
    expect(
      actual.filter((r) => r !== DEFINITION_SITE),
      'a new wholesale writer must declare its provenance in WRITERS above — including one that '
      + 'POSTs /api/write-meta directly rather than through either helper',
    ).toEqual(Object.keys(WRITERS).sort());
  });

  it('each writer really carries the mechanism it declares', () => {
    const wrong: string[] = [];
    for (const [rel, entry] of Object.entries(WRITERS)) {
      if (!DETECTORS[entry.provenance](read(rel))) {
        wrong.push(`${rel}: declared '${entry.provenance}' but that mechanism is not in the file — `
          + 'a wholesale write with no provenance check replaces the sidecar with a document that '
          + 'may carry no `id`, and the next scan mints a fresh GUID for the asset.');
      }
    }
    expect(wrong, wrong.join('\n')).toEqual([]);
  });

  /** ⚠️ The `why` on `EnvironmentAssetView` claims PLACEMENT — "decided BEFORE the gainmap encode
   *  and the ~ultrahdr.jpg write, so a refusal cannot orphan a multi-MB variant" — and that exact
   *  property was the #880 close-out finding: the first version of that guard checked
   *  `writeMetaWholesale`'s RETURN, i.e. after `encodeUltraHDR` had run and after `/api/write-file`
   *  had committed the JPEG. A rule whose whole purpose is turning prose into checks must not leave
   *  its most load-bearing sentence as prose: moving the guard down would satisfy every other
   *  assertion in this file. Source ORDER is a crude proxy for control flow and it is the honest
   *  one available to a scan — it goes red for the move that actually happened once. */
  it('the environment guard is decided BEFORE anything expensive is spent', () => {
    const code = read('panels/assetViews/EnvironmentAssetView.tsx');
    const guard = code.indexOf('metaReadPathOf(');
    expect(guard, 'the guard must exist at all').toBeGreaterThan(-1);
    for (const spend of ['setImporting(true)', 'flushPendingMetaFor(', 'encodeUltraHDR(', 'writeMetaWholesale(']) {
      const at = code.indexOf(spend);
      expect(at, `${spend} must be present for this ordering check to mean anything`).toBeGreaterThan(-1);
      expect(guard, `the provenance guard must precede ${spend} — a refusal after it orphans work`).toBeLessThan(at);
    }
  });

  /** Every entry says WHY in its own words — the field #871 did not exist to make anyone write. */
  it('every writer states why its mechanism is the right one here', () => {
    const thin = Object.entries(WRITERS).filter(([, e]) => e.why.trim().length < 40).map(([rel]) => rel);
    expect(thin).toEqual([]);
  });

  /** ⚠️ The detectors' own controls. A detector that matched everything would make the rule above
   *  vacuously green; one that matched nothing would make it unsatisfiable. Both directions,
   *  directly — the lesson `metaReadPreferringPark.test.ts` paid for twice. */
  it('the writer detector matches a CALL and not an import mention', () => {
    expect(callsWholesaleMetaWriter('if (!await writeMetaWholesale(path, m)) return;')).toBe(true);
    expect(callsWholesaleMetaWriter('const p = await writeMetaOrWarn(path, nextMeta);')).toBe(true);
    expect(callsWholesaleMetaWriter("import { writeMetaWholesale } from '../x';")).toBe(false);
    expect(callsWholesaleMetaWriter('import {\n  writeMetaOrWarn,\n} from "../x";')).toBe(false);
    // The route half — the door `modelImport` actually uses, and the one a helper-only detector missed.
    expect(callsWholesaleMetaWriter("backendFetch('/api/write-meta', { method: 'POST' })")).toBe(true);
    expect(callsWholesaleMetaWriter('await backendFetch(`/api/write-meta`, init)')).toBe(true);
  });

  it('the provenance detectors reject the shape they are meant to reject', () => {
    // The #890 regression, verbatim: the TAG question standing in for the PROVENANCE question.
    expect(DETECTORS.stamp('if (metaCameFromFailedRead(meta)) { return; }')).toBe(false);
    expect(DETECTORS.stamp('if (metaReadPathOf(meta) !== path) { return; }')).toBe(true);
    expect(DETECTORS.loadedRef('metaLoadedRef.current = ok;')).toBe(false);
    expect(DETECTORS.loadedRef('if (!metaLoadedRef.current) { return; }')).toBe(true);
    expect(DETECTORS['fresh-doc']('writeMetaWholesale(p, { ...meta, x: 1 })')).toBe(false);
    expect(DETECTORS['fresh-doc']('writeMetaWholesale(glbPath, { id: modelGuid, generated: {} })')).toBe(true);
    // ⚠️ The shape `metaReadFallback.ts` documents as dangerous must NOT read as "I built this".
    expect(DETECTORS['fresh-doc']('writeMetaWholesale(p, { id: meta.id, ...meta, x: 1 })')).toBe(false);
    expect(DETECTORS['fresh-doc']('writeMetaWholesale(p, { id: doc?.id, x: 1 })')).toBe(false);
    // 'abort-on-tag' needs BOTH halves — consuming the tag and abandoning the operation.
    expect(DETECTORS['abort-on-tag']('if (metaCameFromFailedRead(m)) throw new ImportWriteAborted(p);')).toBe(true);
    expect(DETECTORS['abort-on-tag']('if (metaCameFromFailedRead(m)) return;')).toBe(false);
    expect(DETECTORS['abort-on-tag']('throw new ImportWriteAborted(p);')).toBe(false);
  });
});

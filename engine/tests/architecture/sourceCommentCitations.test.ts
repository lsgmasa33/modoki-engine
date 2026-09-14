/**
 * Source COMMENTS cite by symbol, never by line number (#1186).
 *
 * The docs half of this rule is `docCitations.test.ts` and the QA half is `qaCaseReferences.test.ts`.
 * All three run the same detectors from `helpers/lineCitations.ts`. A comment that points at a file
 * by line number rots on the same edit that rots a doc citation, and it is worse placed: a docblock
 * is where an agent reads WHY. When #1186 was filed, `engine/app/debug/agentBridge.ts` cited a
 * `SceneManager` line for an id comparison, and that line had become an unrelated docblock.
 *
 * ⚠️ **Comments only, not string literals (owner ruling on #1186).** `commentText` excludes string
 * content by construction, so an error message quoting a file and line is deliberately not read here.
 *
 * ⚠️ **The corpus is DERIVED: every file git knows whose extension the shared scanner can strip.** It
 * is not a list of directories, for the reason `docCitations` gives (#1124): a corpus that names its
 * roots excludes the next one by default. JSON is left out, and that is a known gap rather than a
 * claim it has no comments: of ~2,500 tracked JSON files only six tsconfigs carry comment text (none
 * citing a line, 2026-09-14), while the rest are scene, prefab and asset data this read would parse
 * for nothing.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { repoFiles, repoRoot } from '../../scripts/repoCorpus.mjs';
import { commentText, readScannedSource, scanLanguageOf } from '@modoki/engine/testing';
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';
import { lineCitationsInComments } from '../helpers/lineCitations.js';
import { hasInternalGames } from '../helpers/repoLayout';

const root = repoRoot();

/**
 * Trees whose comment citations are another clone's to rewrite, ledgered per FILE until they are.
 *
 * ⚠️ **Owner ruling on #1186: the guard goes on now, not after these lanes finish.** So a lane's
 * files are counted at FILE grain (`file` with a count) rather than per token, which is coarser than
 * the rest of this ledger on purpose: the tokens are what the other clone is rewriting. The count is
 * exact both ways, so a NEW citation in one of these files fails the gate, and a fix fails it too
 * until the row is lowered in the same commit. Delete a lane's entry here when its last row goes.
 */
const PENDING_LANES: ReadonlyArray<{ prefix: string; issue: string }> = [
  { prefix: 'games/court/', issue: '#1189' },
];

const PENDING: ReadonlyArray<{ file: string; count: number }> = [
  { file: 'games/court/packages/app-services/src/auth.ts', count: 2 },
  { file: 'games/court/packages/app-services/src/cloudSave.ts', count: 4 },
  { file: 'games/court/packages/app-services/src/events.ts', count: 1 },
  { file: 'games/court/runtime/agentTools.ts', count: 1 },
  { file: 'games/court/runtime/cloudSyncWiring.ts', count: 1 },
  { file: 'games/court/runtime/saveSync.ts', count: 2 },
  { file: 'games/court/runtime/systems.ts', count: 24 },
  { file: 'games/court/tests/agentToolsPlacement.test.ts', count: 1 },
  { file: 'games/court/tests/clearDurability.test.ts', count: 1 },
  { file: 'games/court/tests/coinEconomy.test.ts', count: 1 },
  { file: 'games/court/tests/dialogAnchorAndReserve.test.ts', count: 4 },
  { file: 'games/court/tests/hintPanelFitKit.ts', count: 1 },
  { file: 'games/court/tests/narrationRoom.test.ts', count: 4 },
  { file: 'games/court/tests/renderSystemWiring.test.ts', count: 4 },
  { file: 'games/court/tests/sceneChrome.test.ts', count: 1 },
  { file: 'games/court/tests/sharedPredicates.test.ts', count: 2 },
  { file: 'games/court/tests/storeChrome.test.ts', count: 1 },
  { file: 'games/court/tests/storeGrant.test.ts', count: 1 },
  { file: 'games/court/tests/uiFontRoots.test.ts', count: 1 },
];

/**
 * Hits that are NOT line citations, keyed file + token and COUNTED (the `BARE_ALLOWED` shape, owner
 * ruling on #1186). One row per file, so its reason has to cover every token it lists. Each token's
 * count is spent, not matched: one more occurrence of it in that file is an offender. Never loosen
 * `helpers/lineCitations.ts` to make one of these go away, because the docs and QA gates share it.
 */
const NOT_A_CITATION: ReadonlyArray<{ file: string; tokens: Readonly<Record<string, number>>; reason: string }> = [
  // ── The rule's own specs: they must quote every shape they forbid ─────────────────────────────
  {
    file: 'engine/tests/helpers/lineCitations.ts',
    tokens: {
      '#L202': 1, '~L202': 4, '#L120': 1, 'saveSync.ts:1745': 3, 'line 79': 1, 'lines ~91': 1, '#L525': 1,
      'foo.ts:288,310': 1, 'foo.ts:525': 1, 'foo.ts:525-573': 1, 'foo.ts#L525': 1, ':1387': 1, ':285': 1,
      'file.ts:12': 1, 'accounts.md:762-775': 1, 'line 1745': 2, 'foo.ts:12': 1,
      'BridgeActivity.onResume():97': 1, ':170': 1, ':5198': 2, ':45-47': 1,
      'onResume():97': 1, ':11': 2, ':47': 1, ':7': 1, ':74': 1, ':1745': 3, '#foo.sh:12': 1,
    },
    reason: 'SPEC: the shared detectors, whose docblocks quote each shape they catch and the historical '
      + 'citation that shape was found on.',
  },
  {
    file: 'engine/tests/architecture/lineCitationsGuard.test.ts',
    tokens: { ':9-12': 1, ':45-47': 1, '#L120': 1 },
    reason: 'SPEC: the detectors\' positive and false-friend controls, explained in comments beside them.',
  },
  {
    file: 'engine/tests/architecture/docCitations.test.ts',
    tokens: {
      ':8100': 3, 'line 8100': 1, 'videoService.ts:135': 1, "projects.ts:40`'s": 1, 'ok:true`/`changed:1': 1,
      'saveSync.ts:1745': 1, '~L202': 1,
    },
    reason: 'SPEC: the docs half of the rule, quoting the doc citations it once missed and the WDA port its '
      + 'BARE_ALLOWED row pardons.',
  },
  {
    file: 'engine/tests/architecture/qaCaseReferences.test.ts',
    tokens: {
      ':45-47': 1, ':5198': 2, ':1`/`:2': 1, ':11': 1, ':1': 1, ':2': 1, 'engine/tools/modoki-mcp/src/tools/editor.ts:288,310,323,338': 1,
      'saveSync.ts:1745': 2, '~L202': 1, 'line 79': 1, 'line 812': 1, 'line 123': 2, 'file.ts:123': 2,
      'file.ts:1745': 1,
    },
    reason: 'SPEC: the QA half of the rule, quoting its specimens, a port, curve-handle ids, and the '
      + 'qa/knowledge.md citation a shape was added for.',
  },
  {
    file: 'engine/packages/modoki/tests/helpers/exemptionLedger.test.ts',
    tokens: { 'b.ts:1': 1, 'a.ts:2': 1 },
    reason: 'FIXTURE: synthetic `site` strings of the ledger helper\'s own cases, named in comments.',
  },
  {
    file: 'engine/packages/modoki/tests/helpers/exemptionLedger.ts',
    tokens: { 'core/clock.ts:65': 1 },
    reason: 'FIXTURE: an example of the `site` field\'s format, which is a failure-message locator.',
  },
  // ── Quoted history: the number a comment USED to carry, kept to show how it rotted ─────────────
  {
    file: 'engine/packages/modoki/src/runtime/timeline/timelineSystem.ts',
    tokens: { ':152': 1, ':253': 1, ':266': 1 },
    reason: 'HISTORY: records the three line numbers one statement drifted through; the comment cites by heading.',
  },
  {
    file: 'engine/packages/modoki/tests/runtime/Scene2D.test.ts',
    tokens: { ':1543': 1, ':1543`/`:1563': 1, ':1563': 1 },
    reason: 'HISTORY: the first draft\'s numbers, which the very commit that added them shifted; cites by symbol.',
  },
  {
    file: 'engine/plugins/backend/editorBackendRouter.ts',
    tokens: { ':8100': 6, ':1028': 1, ':1028`/`:2372': 1, ':2372': 1 },
    reason: 'PORT and HISTORY: WebDriverAgent\'s :8100 on the phone, and two line numbers quoted to explain '
      + 'why that comment says to grep instead.',
  },
  {
    file: 'engine/tests/architecture/glContextRelease.test.ts',
    tokens: { ':1066': 1, ':587-590': 1, ':595-600': 1, 'WebGLRenderer.js:1074-1097': 1 },
    reason: 'HISTORY: the three.js line numbers that went stale when #956 reverted the pin, quoted as the '
      + 'reason the docblock now cites by symbol.',
  },
  // ── Ports ───────────────────────────────────────────────────────────────────────────────────
  { file: 'engine/plugins/backend/deviceConnection.ts', tokens: { ':8100': 2 }, reason: 'PORT: WebDriverAgent on the phone.' },
  { file: 'engine/plugins/backend/deviceWda.ts', tokens: { ':8100': 3 }, reason: 'PORT: WebDriverAgent on the phone.' },
  { file: 'engine/tests/plugins/deviceConnectWda.test.ts', tokens: { ':8100': 1 }, reason: 'PORT: WebDriverAgent on the phone.' },
  { file: 'engine/tests/plugins/deviceRouter.test.ts', tokens: { ':8100': 1 }, reason: 'PORT: WebDriverAgent on the phone.' },
  { file: 'engine/tests/plugins/wdaLauncher.test.ts', tokens: { ':8100': 1 }, reason: 'PORT: WebDriverAgent on the phone.' },
  { file: 'engine/plugins/healNativeConfig.ts', tokens: { ':9095': 1 }, reason: 'PORT: the GameDebug bridge.' },
  { file: 'engine/tests/architecture/capacitorPlatformDeclarations.test.ts', tokens: { ':9095': 1 }, reason: 'PORT: the GameDebug bridge.' },
  { file: 'engine/tests/architecture/sceneDelegateBridgeVC.test.ts', tokens: { ':9095': 1 }, reason: 'PORT: the GameDebug bridge.' },
  { file: 'engine/tests/architecture/clonePortHardcoding.test.ts', tokens: { ':9223': 1 }, reason: 'PORT: a clone\'s CDP port, quoted.' },
  { file: 'engine/tests/architecture/editorPorts.test.ts', tokens: { ':5179': 1 }, reason: 'PORT: the hub\'s backend port, in a quoted pin shape.' },
  { file: 'engine/tests/plugins/buildLeaseSourceWireShape.test.ts', tokens: { ':5183': 1 }, reason: 'PORT: a clone\'s backend, in a quoted `curl`.' },
  // ── Values that merely have the shape ───────────────────────────────────────────────────────
  { file: 'engine/packages/modoki/tests/runtime/sceneValidation.test.ts', tokens: { 'width:0/height:0': 1 }, reason: 'DATA: field values.' },
  { file: 'engine/tests/e2e/editor-2d-ui-overlay.spec.ts', tokens: { 'retries:0`/`workers:1': 1 }, reason: 'DATA: Playwright config values.' },
  { file: 'engine/tests/assets/scanPublishSafety.test.ts', tokens: { 'line 10': 1 }, reason: 'DATA: a line of a hypothetical fixture, explaining a sort order.' },
  { file: 'scripts/gen-memory-index.mjs', tokens: { 'line 131': 1 }, reason: 'DATA: a median rendered line length, 131 characters.' },
];

const laneOf = (rel: string) => PENDING_LANES.find((l) => rel.startsWith(l.prefix));

/** The wrapper punctuation a comment puts around a citation, so a ledger key is the citation itself. */
const normalize = (hit: string) => hit.replace(/^[`'"*_([{]+/, '').replace(/[`'"*_.,;:)\]}]+$/, '');

function corpus(): Array<{ rel: string; text: string }> {
  return repoFiles({
    floor: 500,
    match: (rel: string) => {
      const language = scanLanguageOf(rel);
      return language !== undefined && language !== 'jsonc';
    },
  }).map(({ rel }: { rel: string }) => ({ rel, text: commentText(readScannedSource(path.join(root, rel))) }));
}

describe('source comments cite by SYMBOL, never by line number (#1186)', () => {
  const files = corpus();

  it('the corpus reaches the source and yields comment text — a vacuous pass is a failure', () => {
    // `commentText` over a `comments: 'include'` read is all blank, exactly like a file with no
    // comments, so "every file had nothing to report" must be ruled out here.
    const withComments = files.filter((f) => /\S/.test(f.text)).map((f) => f.rel);
    expect(withComments.length).toBeGreaterThan(files.length / 2);
    expect(withComments).toContain('engine/tests/helpers/lineCitations.ts');
    expect(files.some((f) => f.rel.endsWith('.swift') || f.rel.endsWith('.java') || f.rel.endsWith('.sh')),
      'the non-JS strippers are part of the corpus').toBe(true);
    if (hasInternalGames()) expect(withComments).toContain('games/court/runtime/systems.ts');
  });

  it('no source comment cites a line', () => {
    const population: Array<{ item: string; site: string }> = [];
    for (const { rel, text } of files) {
      for (const { line, hit } of lineCitationsInComments(text)) {
        const token = normalize(hit);
        population.push({ item: laneOf(rel) ? rel : `${rel}::${token}`, site: `${rel}:${line}  ${token}` });
      }
    }
    // A row for a file this checkout does not carry is dropped ONLY in the public snapshot, which ships
    // a curated subset (no `games/`, no private tooling). In the full tree every row's file must exist:
    // a renamed or deleted file would otherwise leave a dead pardon nothing reports, which re-arms if
    // the path ever comes back (#1186 close-out, proven by adding a row for a missing file).
    const present = new Set(files.map((f) => f.rel));
    const rowFiles = [...NOT_A_CITATION.map((r) => r.file), ...PENDING.map((r) => r.file)];
    if (hasInternalGames()) {
      expect(rowFiles.filter((f) => !present.has(f)), 'a ledger row names a file that no longer exists: delete '
        + 'or repoint the row').toEqual([]);
    }
    assertExemptionLedger({
      label: 'sourceCommentCitations',
      population,
      exempt: [
        ...NOT_A_CITATION.filter((r) => present.has(r.file)).flatMap((r) => Object.entries(r.tokens)
          .map(([token, count]) => ({ item: `${r.file}::${token}`, count, reason: r.reason }))),
        ...PENDING.filter((r) => present.has(r.file))
          .map((r) => ({ item: r.file, count: r.count, reason: `pending ${laneOf(r.file)?.issue}` })),
      ],
      floor: 500,
      scanned: files.length,
      fix: 'Cite the SYMBOL, not the line (#686, #1186): name the function, method, constant or test '
        + 'instead of a line number, which rots silently and no test can check. If the hit is not a line '
        + 'citation at all (a port, a measurement), add a counted NOT_A_CITATION row with a reason. Do '
        + 'NOT loosen helpers/lineCitations.ts, which the docs and QA gates share.',
    });
  });

  it('a PENDING row belongs to a pending lane, and a lane with no rows is deleted', () => {
    expect(PENDING.filter((r) => !laneOf(r.file)).map((r) => r.file),
      'a file-grain row outside a pending lane would pardon every citation in that file').toEqual([]);
    const lanesInUse = new Set(PENDING.map((r) => laneOf(r.file)?.prefix));
    expect(PENDING_LANES.filter((l) => !lanesInUse.has(l.prefix)).map((l) => `${l.prefix} (${l.issue})`),
      'this lane has no pending rows left: delete it, so its files are keyed per token like every other').toEqual([]);
  });
});

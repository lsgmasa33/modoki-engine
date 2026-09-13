/** Guard: editor code does not compare the `playState` shim to `'stopped'` to decide whether authoring
 *  is safe (#1148).
 *
 *  `getPlayState()` is a 3-value compat shim over the 4-value run mode, and it collapses `scrub` and
 *  `preview` into `'stopped'`. So `getPlayState() === 'stopped'` reads a live preview envelope, whose
 *  world is snapshotted and reverts on Exit, as "safe to author". That exact comparison has now
 *  shipped the same defect three times: `/api/scene-mutate` (#1122), then the scene-reload suppressor
 *  and every Undo gate (#1148). The question those sites were asking is `canEdit()`.
 *
 *  So the comparison is banned in editor code, and each remaining use has to be on the list below
 *  WITH the reason it is asking a Play question rather than an authoring one. Adding to the list is
 *  legal. What the guard stops is the comparison arriving without anyone deciding which question it
 *  asks.
 *
 *  NOT covered, deliberately: an alias (`const s = getPlayState(); s === 'stopped'` — the old
 *  suppressor's own shape). Catching it needs data flow, and a name-based rule would false-positive on
 *  every unrelated `state`. Runtime code (`runtime/**`) is out of scope too: it has no authoring gates,
 *  and its `playState` reads decide rendering and teardown. */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { readScannedSource } from '@modoki/engine/testing';
import { repoFiles, repoRoot } from '../../scripts/repoCorpus.mjs';

/** `getPlayState()` or a variable named `playState`, compared either way round with `'stopped'`. */
const COMPARISON = /(?:\bgetPlayState\(\)|\bplayState\b)\s*[!=]==?\s*'stopped'|'stopped'\s*[!=]==?\s*(?:\bgetPlayState\(\)|\bplayState\b)/g;

/** repo-relative path → how many comparisons it may hold, and why each asks a PLAY question. */
const ALLOWED: Record<string, { count: number; why: string }> = {
  'engine/packages/modoki/src/editor/scene/playMode.ts': {
    count: 1,
    why: "stopPlay's no-op check: a scrub/preview is handled by the envelope branch directly above it, so "
      + "what is left is the Play question 'is there a Play to stop?'.",
  },
  'engine/packages/modoki/src/editor/rendering/GameView.tsx': {
    count: 1,
    why: 'The Play/Pause toolbar and its STOPPED/PAUSED/PLAYING label. A preview is not a Play, so it '
      + 'should show STOPPED and offer Play.',
  },
  'games/sling/editor/LevelEditor.tsx': {
    count: 3,
    why: 'Locks level painting while the SIM runs, because arena bounds go stale under an in-flight puck. '
      + 'A scrub/preview does not run the sim, and the level is an asset document that survives Exit.',
  },
};

function scannedFiles() {
  return repoFiles({
    under: ['engine/packages/modoki/src/editor', 'engine/app/editor', 'games', 'demos'],
    match: (rel: string) => /\.tsx?$/.test(rel) && !/\/tests?\//.test(rel) && (!/^(games|demos)\//.test(rel) || /\/editor\//.test(rel)),
    exclude: ['node_modules', 'dist'],
    floor: 150,
  });
}

function comparisons(): Map<string, number[]> {
  const found = new Map<string, number[]>();
  for (const { rel, abs } of scannedFiles()) {
    const code = readScannedSource(abs).code;
    const lines: number[] = [];
    for (const m of code.matchAll(COMPARISON)) lines.push(code.slice(0, m.index).split('\n').length);
    if (lines.length) found.set(rel, lines);
  }
  return found;
}

describe('the playState shim is not an authoring gate (#1148)', () => {
  const found = comparisons();

  it("no editor file compares playState to 'stopped' outside the reasoned list", () => {
    const offenders: string[] = [];
    for (const [rel, lines] of found) {
      const allowed = ALLOWED[rel]?.count ?? 0;
      if (lines.length > allowed) {
        offenders.push(`${rel}:${lines.join(',')} — ${lines.length} comparison(s), ${allowed} allowed`);
      }
    }
    expect(offenders, [
      "getPlayState()/playState compared to 'stopped' reads a scrub/preview envelope as 'stopped'.",
      'For "is authoring safe?" call canEdit() (runtime/core/playState.ts). If this really is a Play',
      'question, add the file to ALLOWED with the reason.',
    ].join(' ')).toEqual([]);
  });

  it('every allowlisted comparison is still there, so the list cannot rot into blanket permission', () => {
    // Shape (G): an entry that matches nothing hides a later, different comparison in the same file,
    // and tells the reader the matcher is looking at something it no longer sees.
    // An entry under a project root this checkout does not ship (the public snapshot carries no
    // `games/`) cannot be checked there, so it is skipped by ROOT, not by file: a deleted file inside
    // a present root still reads as drift.
    const drift = Object.entries(ALLOWED)
      .filter(([rel]) => fs.existsSync(path.join(repoRoot(), rel.split('/')[0])))
      .filter(([rel, { count }]) => (found.get(rel)?.length ?? 0) !== count)
      .map(([rel, { count }]) => `${rel}: expected ${count}, found ${found.get(rel)?.length ?? 0}`);
    expect(drift).toEqual([]);
  });

  it('the matcher catches each shape it claims to — self-test on synthetic source', () => {
    const hits = (src: string) => [...src.matchAll(COMPARISON)].length;
    expect(hits("if (getPlayState() !== 'stopped') return;")).toBe(1);
    expect(hits("const canEdit = playState === 'stopped';")).toBe(1);
    expect(hits("if ('stopped' === getPlayState()) {}")).toBe(1);
    expect(hits("return getPlayState() == 'stopped';")).toBe(1);
    // The accept side: the run-mode read and Play-state questions are not this defect.
    expect(hits("if (getRunMode() === 'stopped') {}")).toBe(0);
    expect(hits("if (getPlayState() === 'playing') {}")).toBe(0);
    expect(hits("const replayState = x; replayState === 'stopped';")).toBe(0);
  });
});

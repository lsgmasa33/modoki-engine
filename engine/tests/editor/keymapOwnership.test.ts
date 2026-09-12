/** Guard: the keymap registry stays the ONE owner of editor keyboard input.
 *
 *  The focus-scope refactor collapsed ~10 ad-hoc window/document keydown listeners into a
 *  single dispatcher. Nothing structurally PREVENTS the next one. Adding a global listener
 *  is the obvious, ergonomic thing to do when you want a panel shortcut — it is exactly how
 *  the original ten accumulated — and it fails silently: the editor works for a human,
 *  `npm run verify` stays green, and the only symptom is that the key fires from the wrong
 *  panel, or fights the dispatcher, or swallows a chord the OS needed.
 *
 *  So this reads SOURCE, like chromeTagging.test.ts. A rendered-DOM test cannot see "a
 *  listener was registered in a module that happens not to be mounted right now".
 *
 *  IF THIS FAILS: you probably want `register({ id, keys, scope, when, run })` from
 *  editor/input/keymap.ts instead. See docs/editor-input.md — especially
 *  the preventDefault contract, which is why a binding must NOT preventDefault when it declines. If you genuinely
 *  need a raw listener, add it to ALLOWED below WITH the reason. */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const EDITOR = path.resolve(__dirname, '../../packages/modoki/src/editor');

/** Raw keyboard listeners that are deliberately NOT keymap bindings. Each needs a reason.
 *
 *  Keyed with `repoFiles()`'s own `rel` — repo-root-relative, git POSIX (#799/#771/#805 Phase
 *  4), e.g. `engine/packages/modoki/src/editor/input/dispatcher.ts` — not the editor-relative
 *  form this used before migrating off a hand-rolled walker. That walker's own `relKey` existed
 *  only to undo a Windows backslash a hand-rolled `path.relative` introduced; `repoFiles()`
 *  never produces one, so there is nothing left to undo.
 *
 *  ⚠️ **Keyed `<file>::<event>` and pardoning one listener each (#1123).** This was
 *  `Record<file, reason>`, and `SceneView.tsx` registers TWO listeners — keydown at :3079 and keyup
 *  at :3080 — under one row. Its reason argues for both ("needs keyup as much as keydown"), which is
 *  exactly why the file key read as adequate; what it also pardoned was every FUTURE listener in a
 *  3,000-line panel, including a keypress for something unrelated. The event name is what tells two
 *  listeners apart, so it is in the key rather than hidden behind a count. */
const ALLOWED = [
  {
    // ⚠️ A counted ROW, not `sanctioned`, even though it is "the one legitimate implementer" — the
    // case `projectPresencePredicate.test.ts` does put in `sanctioned`. Deliberately stricter here:
    // `sanctioned` pardons every occurrence in the file, and "the single window keydown listener"
    // is a claim about the COUNT, so a second listener appearing in the dispatcher is exactly what
    // should be looked at. Where the structural claim is "any number here is correct", sanctioned
    // is right; where it is "there is exactly one", a row with a count says so.
    item: 'engine/packages/modoki/src/editor/input/dispatcher.ts::keydown',
    reason: 'THE dispatcher — the single window keydown listener the whole design funnels through.',
  },
  {
    item: 'engine/packages/modoki/src/editor/panels/SceneView.tsx::keydown',
    reason: 'Shift-snap tracks a MODIFIER LEVEL, whereas the registry dispatches discrete chords. '
      + 'Guarded on focusedPanel + text-editable, and the guard folds into the VALUE (never an early '
      + 'return). This is the PRESS half; the release half is its own row below.',
  },
  {
    item: 'engine/packages/modoki/src/editor/panels/SceneView.tsx::keyup',
    reason: 'The release half of shift-snap. A modifier LEVEL needs keyup as much as keydown, and '
      + 'the registry has no "modifier held" concept — inventing one for a single consumer is the '
      + 'trade this row records. Separate from the keydown row on purpose: migrating one without the '
      + 'other must not stay green.',
  },
] as const;

/** The keyboard events a global listener can register for. */
const EVENTS = ['keydown', 'keyup', 'keypress'] as const;

/** Every keyboard listener registration form we care about, one matcher per event so a match can
 *  SAY which event it is. Global, because the rule counts occurrences rather than answering a
 *  boolean per file. */
const listenerRe = (ev: string): RegExp => new RegExp(
  String.raw`\b(?:window|document)\s*\.\s*addEventListener\s*\(\s*['"\`]${ev}['"\`]`, 'g',
);

/** Every `.ts`/`.tsx` under `EDITOR`, via the shared corpus producer (#799/#771/#805 Phase 4).
 *  Floored well under the 240 measured today. */
function walk(dir: string): { abs: string; rel: string }[] {
  return repoFiles({ under: dir, match: /\.tsx?$/, floor: 150 })
    .map(({ abs, rel }) => ({ abs, rel }));
}

describe('keymap ownership — no raw keyboard listeners in editor/', () => {
  const files = walk(EDITOR);

  it('finds editor sources to scan (guards against a moved directory silently passing)', () => {
    // A path typo would make every assertion below vacuously true.
    expect(files.length).toBeGreaterThan(40);
  });

  it('registers global keyboard listeners ONLY where a row pardons one', () => {
    // ⚠️ `readScannedSource`, not a raw read. This guard read RAW, which was harmless while the rule
    // was a per-file boolean (no editor file discusses the pattern in prose today) and is NOT once
    // rows carry counts: a docblock quoting `window.addEventListener('keydown'` would have inflated
    // the number a row has to match, and the house rule is the shared reader anyway (#419/#812).
    // Measured both ways on 2026-09-12 on work-ai2: raw and stripped agree at 3, so no verdict moves.
    const listeners: Array<{ item: string; site: string }> = [];
    for (const { abs, rel } of files) {
      const code = readScannedSource(abs).code;
      code.split('\n').forEach((line, i) => {
        for (const ev of EVENTS) {
          for (let n = (line.match(listenerRe(ev)) ?? []).length; n > 0; n -= 1) {
            listeners.push({ item: `${rel}::${ev}`, site: `${rel}:${i + 1} (${ev})` });
          }
        }
      });
    }
    assertExemptionLedger({
      label: 'ALLOWED in keymapOwnership',
      population: listeners,
      exempt: ALLOWED,
      // 3 measured 2026-09-12 (dispatcher keydown; SceneView keydown + keyup), floored under it so
      // that MIGRATING one reaches the over-blessed arm rather than reporting a broken matcher. The
      // detector-broke check is the sibling test that floors the scanned file count at 40.
      floor: 2,
      fix: 'Use register({ id, keys, scope, when, run }) from editor/input/keymap.ts so the chord '
        + 'is scoped to the focused panel, conflicts are caught at registration, and the binding '
        + 'is introspectable. A raw listener re-creates the class of bug this refactor removed '
        + '(one key firing in three panels at once).',
    });
  });

  it('every `scope:` literal names a real panel or tier — typos compile silently', () => {
    // `Scope` is `'app-chord' | 'app-key' | 'overlay' | 'text-field' | (string & {})` — the
    // open-ended arm exists so a GAME-registered panel (e.g. 'sling-field') can own chords.
    // The cost is that `scope: 'skin_editor'` type-checks, registers, and then simply never
    // resolves: the dispatcher yields and the shortcut is silently dead. tsc cannot catch it.
    const TIERS = ['app-chord', 'app-key', 'overlay', 'text-field'];
    // The FlexLayout tab component ids (EditorApp.tsx PANELS) — the panel-scope vocabulary.
    const PANELS = [
      'scene', 'game', 'hierarchy', 'inspector', 'console', 'assets',
      'particle-editor', 'animation-editor', 'timeline-editor', 'spriteanim-editor',
      'skin-editor', 'ai',
    ];
    const known = new Set([...TIERS, ...PANELS]);

    const bad: string[] = [];
    for (const { abs: file, rel } of files) {
      const src = fs.readFileSync(file, 'utf8');
      src.split('\n').forEach((line, i) => {
        const m = /scope: '([a-zA-Z0-9_-]+)'/.exec(line);
        if (m && !known.has(m[1])) bad.push(`${rel}:${i + 1} → '${m[1]}'`);
      });
    }
    expect(
      bad,
      `Unknown keymap scope(s):\n  ${bad.join('\n  ')}\n\n`
      + 'A scope must be one of the tiers (app-chord | app-key | overlay | text-field) or a '
      + 'FlexLayout panel id. An unknown scope registers fine and then never resolves — the '
      + 'shortcut is silently dead. If you added a panel, add its id to PANELS here.',
    ).toEqual([]);
  });

  it('keeps the dispatcher as the only window-level keydown route', () => {
    const d = fs.readFileSync(path.join(EDITOR, 'input/dispatcher.ts'), 'utf8');
    expect(d).toMatch(/addEventListener\('keydown', onKeyDown\)/);
    // The A.8 contract: yielding must NOT preventDefault, or every native role dies.
    expect(d).toMatch(/if \(!binding\) return;/);
  });
});

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
import { callsToPath, findNodes, lineOf, parseSource, stringValueOf, ts } from '@modoki/engine/testing/sourceAst';
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
 *  `Record<file, reason>`, and `SceneView.tsx` registers TWO listeners — its Shift-snap `onSnapKey` keydown and keyup
 *  listeners — under one row. Its reason argues for both ("needs keyup as much as keydown"), which is
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

/**
 * Every `window`/`document` `addEventListener(…)` CALL for a keyboard event in one file, as a ledger
 * item `<rel>::<event>` — read from the parse (#1179). The per-line regex this replaces missed
 * `window.addEventListener(\n  'keydown', …)`, the shape a formatter produces for a long handler.
 *
 * ⚠️ An event name that is NOT a string literal is reported as `<rel>::<dynamic>`, and no row pardons
 * one today — writing that row is a reviewed decision like any other. `addEventListener(ev, …)` could
 * be a keyboard listener, and a regex requiring the quote simply never saw it.
 */
function keyboardListeners(code: string, rel: string): Array<{ item: string; site: string }> {
  const sf = parseSource(code, rel);
  return callsToPath(sf, 'window.addEventListener', 'document.addEventListener').flatMap((c) => {
    const ev = stringValueOf(c.arguments[0]);
    const kind = ev === undefined ? '<dynamic>' : (EVENTS as readonly string[]).includes(ev) ? ev : undefined;
    return kind ? [{ item: `${rel}::${kind}`, site: `${rel}:${lineOf(c)} (${kind})` }] : [];
  });
}

/** Every `.ts`/`.tsx` under `EDITOR`, via the shared corpus producer (#799/#771/#805 Phase 4).
 *  Floored well under the 240 measured today. */
function walk(dir: string): { abs: string; rel: string }[] {
  return repoFiles({ under: dir, match: /\.tsx?$/, floor: 150 })
    .map(({ abs, rel }) => ({ abs, rel }));
}

/** Every `scope: '<literal>'` property in one file's comment-stripped code, from the parse (#1179).
 *  The per-line `exec` this replaces read the RAW file (a comment could red it), took only the first
 *  match on a line, and missed `scope:\n  'x'`. A non-literal scope is not a typo this can judge. */
function scopeLiterals(code: string, rel: string): Array<{ line: number; scope: string }> {
  const sf = parseSource(code, rel);
  return findNodes(sf, (n): n is ts.PropertyAssignment => ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === 'scope')
    .flatMap((p) => {
      const scope = stringValueOf(p.initializer);
      return scope === undefined ? [] : [{ line: lineOf(p), scope }];
    });
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
    const listeners = files.flatMap(({ abs, rel }) => keyboardListeners(readScannedSource(abs).code, rel));
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

  it('the listener detector sees a WRAPPED call, two on one line, and a non-literal event (#1179)', () => {
    const src = [
      'window.addEventListener(',
      "  'keydown',",
      '  onKey,',
      ');',
      "document.addEventListener('keyup', a); window.addEventListener('keypress', b); window.addEventListener('resize', c);",
      'globalThis.window.addEventListener(ev, d); el.addEventListener("keydown", e);',
    ].join('\n');
    expect(keyboardListeners(src, 'p.tsx').map((l) => l.site)).toEqual([
      'p.tsx:1 (keydown)', 'p.tsx:5 (keyup)', 'p.tsx:5 (keypress)', 'p.tsx:6 (<dynamic>)',
    ]);
  });

  it('the scope detector sees a wrapped `scope:` and two on one line, and skips a non-literal (#1179)', () => {
    const src = "register({ id: 'a',\n  scope:\n    'scenee' });\nconst ok = [{ scope: 'scene' }, { scope: 'hierarchyy' }];\nregister({ scope: dyn });";
    expect(scopeLiterals(src, 'p.tsx').map((s) => `${s.line}:${s.scope}`)).toEqual(['2:scenee', '4:scene', '4:hierarchyy']);
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

    const all = files.flatMap(({ abs, rel }) => scopeLiterals(readScannedSource(abs).code, rel).map((s) => ({ ...s, rel })));
    // 21 measured 2026-09-14 (the raw per-line scan saw 22 — the extra was a docblock quoting
    // `scope: 'scene'`). Floored under it: a detector that finds nothing would pass the check below.
    expect(all.length).toBeGreaterThanOrEqual(15);
    const bad = all.filter((s) => !known.has(s.scope)).map((s) => `${s.rel}:${s.line} → '${s.scope}'`);
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

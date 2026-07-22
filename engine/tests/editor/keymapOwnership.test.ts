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

const EDITOR = path.resolve(__dirname, '../../packages/modoki/src/editor');

/** Editor-relative path with FORWARD slashes, always.
 *
 *  `path.relative` yields `input\dispatcher.ts` on Windows, so a raw lookup against ALLOWED
 *  (whose keys are written `input/dispatcher.ts`) misses every time and reports the two
 *  deliberately-allowlisted files as violations. The guard then fails on Windows and only on
 *  Windows — the listeners it names are the ones the allowlist exists to permit. */
const relKey = (file: string): string => path.relative(EDITOR, file).split(path.sep).join('/');

/** Raw keyboard listeners that are deliberately NOT keymap bindings. Each needs a reason. */
const ALLOWED: Record<string, string> = {
  'input/dispatcher.ts':
    'THE dispatcher — the single window keydown listener the whole design funnels through.',
  'panels/SceneView.tsx':
    'Shift-snap tracks a MODIFIER LEVEL and needs keyup as much as keydown, whereas the '
    + 'registry dispatches discrete chords on keydown. Forcing it in would mean inventing a '
    + '"modifier held" concept for one consumer. It is guarded on focusedPanel + text-editable, '
    + 'and the guard folds into the VALUE (never an early return) so a release always clears.',
};

/** Every keyboard listener registration form we care about. */
const PATTERNS = [
  /\b(?:window|document)\s*\.\s*addEventListener\s*\(\s*['"`]keydown['"`]/,
  /\b(?:window|document)\s*\.\s*addEventListener\s*\(\s*['"`]keyup['"`]/,
  /\b(?:window|document)\s*\.\s*addEventListener\s*\(\s*['"`]keypress['"`]/,
];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('keymap ownership — no raw keyboard listeners in editor/', () => {
  const files = walk(EDITOR);

  it('finds editor sources to scan (guards against a moved directory silently passing)', () => {
    // A path typo would make every assertion below vacuously true.
    expect(files.length).toBeGreaterThan(40);
  });

  it('registers global keyboard listeners ONLY in the allowlisted files', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relKey(file);
      if (ALLOWED[rel]) continue;
      const src = fs.readFileSync(file, 'utf8');
      for (const re of PATTERNS) {
        if (re.test(src)) {
          const line = src.split('\n').findIndex((l) => re.test(l)) + 1;
          offenders.push(`${rel}:${line}`);
          break;
        }
      }
    }
    expect(
      offenders,
      `Raw keyboard listener(s) outside the keymap registry:\n  ${offenders.join('\n  ')}\n\n`
      + 'Use register({ id, keys, scope, when, run }) from editor/input/keymap.ts so the chord '
      + 'is scoped to the focused panel, conflicts are caught at registration, and the binding '
      + 'is introspectable. A raw listener re-creates the class of bug this refactor removed '
      + '(one key firing in three panels at once).\n'
      + 'If a raw listener is genuinely required, add it to ALLOWED in this file WITH a reason.',
    ).toEqual([]);
  });

  it('keeps the allowlist honest — every entry still exists and still needs one', () => {
    // An allowlist entry that no longer has a listener is stale permission: it would let a
    // future raw listener into that file unchallenged.
    for (const [rel, why] of Object.entries(ALLOWED)) {
      const p = path.join(EDITOR, rel);
      expect(fs.existsSync(p), `allowlisted file is gone: ${rel} — drop the entry`).toBe(true);
      const src = fs.readFileSync(p, 'utf8');
      expect(
        PATTERNS.some((re) => re.test(src)),
        `${rel} is allowlisted but no longer registers a raw keyboard listener — remove it `
        + `from ALLOWED so the file is guarded again. (Reason on file: ${why})`,
      ).toBe(true);
    }
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
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      src.split('\n').forEach((line, i) => {
        const m = /scope: '([a-zA-Z0-9_-]+)'/.exec(line);
        if (m && !known.has(m[1])) bad.push(`${relKey(file)}:${i + 1} → '${m[1]}'`);
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

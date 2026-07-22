// @vitest-environment jsdom
/** The agent-facing "is the user typing?" probe must agree with the editor's own predicate.
 *
 *  THREE copies of this question exist, across two processes, and they are NOT all the same
 *  question — which is the whole reason this file exists:
 *
 *    focusScope.isTextEditable()      (editor renderer)  — can this element receive typed text?
 *    ACTIVE_ELEMENT_PROBE.typable     (main → renderer)  — same question, asked over the bridge
 *    keyboardSource.editing()         (runtime, ships in games) — will the GAME ignore keys?
 *
 *  `typable` and `isTextEditable` must match exactly. `editing()` is deliberately BLUNTER and
 *  must NOT be forced to match — a readOnly input still stops the game's sampler.
 *
 *  WHY A TEST AND NOT A COMMENT: focusScope.ts already carried a comment saying these were
 *  "kept in the same shape", and they had silently drifted anyway. Measured 2026-07-22 against
 *  the live editor: modoki_type_text reported {ok:true, typed:3} into the Inspector's readOnly
 *  name field, whose value was provably unchanged, and modoki_press_key warned that `f` would
 *  be swallowed on a press that actually framed the selection. A comment cannot fail; this can. */

import { describe, it, expect } from 'vitest';
import { ACTIVE_ELEMENT_PROBE } from '../../electron/rendererOps';
// Relative, not '@modoki/engine/editor': focusScope is an internal module of the editor
// package and is not on its exports map. Reaching for the real implementation is the point —
// re-declaring the predicate here would test a copy and prove nothing.
import { isTextEditable } from '../../packages/modoki/src/editor/input/focusScope';

/** Evaluate the probe string the main process injects, against this jsdom document. */
function runProbe(): { typable: boolean; gameSwallows: boolean; descriptor: string | null } {
  // eslint-disable-next-line no-eval
  return (0, eval)(ACTIVE_ELEMENT_PROBE);
}

function focus(el: HTMLElement): HTMLElement {
  document.body.appendChild(el);
  el.focus();
  return el;
}

function input(attrs: Partial<HTMLInputElement> & { type?: string } = {}): HTMLInputElement {
  const el = document.createElement('input');
  Object.assign(el, attrs);
  return el;
}

const CASES: { name: string; make: () => HTMLElement; typable: boolean; gameSwallows: boolean }[] = [
  { name: 'text input', make: () => input({ type: 'text' }), typable: true, gameSwallows: true },
  { name: 'input with no type (defaults to text)', make: () => document.createElement('input'), typable: true, gameSwallows: true },
  { name: 'number input', make: () => input({ type: 'number' }), typable: true, gameSwallows: true },
  { name: 'search input', make: () => input({ type: 'search' }), typable: true, gameSwallows: true },
  { name: 'textarea', make: () => document.createElement('textarea'), typable: true, gameSwallows: true },

  // The measured bug: all of these hold focus and all reject characters.
  { name: 'readOnly text input', make: () => input({ type: 'text', readOnly: true }), typable: false, gameSwallows: true },
  { name: 'readOnly textarea', make: () => { const t = document.createElement('textarea'); t.readOnly = true; return t; }, typable: false, gameSwallows: true },
  // A disabled control REFUSES focus (jsdom agrees with the browser here), so activeElement
  // stays on <body> and both answers are false. That is the evidence that the `disabled` branch
  // in either predicate is unreachable defence, not a live path — kept because it costs nothing
  // and makes the two implementations textually identical.
  { name: 'disabled text input', make: () => input({ type: 'text', disabled: true }), typable: false, gameSwallows: false },
  { name: 'checkbox', make: () => input({ type: 'checkbox' }), typable: false, gameSwallows: true },
  { name: 'radio', make: () => input({ type: 'radio' }), typable: false, gameSwallows: true },
  { name: 'range', make: () => input({ type: 'range' }), typable: false, gameSwallows: true },
  { name: 'color', make: () => input({ type: 'color' }), typable: false, gameSwallows: true },

  { name: 'button element', make: () => document.createElement('button'), typable: false, gameSwallows: false },
  { name: 'plain div', make: () => { const d = document.createElement('div'); d.tabIndex = 0; return d; }, typable: false, gameSwallows: false },
];

describe('ACTIVE_ELEMENT_PROBE', () => {
  it.each(CASES)('$name → typable=$typable gameSwallows=$gameSwallows', ({ make, typable, gameSwallows }) => {
    document.body.innerHTML = '';
    focus(make());
    const r = runProbe();
    expect(r.typable).toBe(typable);
    expect(r.gameSwallows).toBe(gameSwallows);
  });

  it('agrees with the editor\'s isTextEditable on EVERY case — the invariant that drifted', () => {
    // This is the assertion that would have caught the shipped bug.
    const mismatches: string[] = [];
    for (const c of CASES) {
      document.body.innerHTML = '';
      const el = focus(c.make());
      const probe = runProbe().typable;
      const editor = isTextEditable(el);
      if (probe !== editor) mismatches.push(`${c.name}: probe.typable=${probe} but isTextEditable=${editor}`);
    }
    expect(
      mismatches,
      `The agent-facing probe and the editor's own predicate disagree:\n  ${mismatches.join('\n  ')}\n\n`
      + 'These answer the SAME question ("can this element receive typed text?") on two sides of '
      + 'the process bridge. When they drift, modoki_type_text reports success typing into a '
      + 'field that rejected every character. Update ACTIVE_ELEMENT_PROBE in rendererOps.ts to '
      + 'match focusScope.isTextEditable().',
    ).toEqual([]);
  });

  it('does NOT force gameSwallows to match — the game predicate is deliberately blunter', () => {
    // A readOnly input cannot be typed into, but it DOES stop the running game's sampler
    // (keyboardSource.editing() tests tagName only, and ships inside every game). Collapsing
    // these two into one predicate is what caused the misleading press_key warning.
    document.body.innerHTML = '';
    const el = focus(input({ type: 'text', readOnly: true }));
    const r = runProbe();
    expect(isTextEditable(el)).toBe(false); // editor: shortcuts may fire
    expect(r.typable).toBe(false);          // typing: would be a no-op
    expect(r.gameSwallows).toBe(true);      // game: sampler still ignores the key
  });

  it('reports no focus as neither typable nor game-swallowing', () => {
    document.body.innerHTML = '';
    (document.activeElement as HTMLElement | null)?.blur();
    const r = runProbe();
    expect(r.typable).toBe(false);
    expect(r.gameSwallows).toBe(false);
    expect(r.descriptor).toBeNull(); // body → null, not 'body'
  });

  it('describes the focused element for the caller', () => {
    document.body.innerHTML = '';
    const el = input({ type: 'text' });
    el.id = 'console-filter';
    focus(el);
    expect(runProbe().descriptor).toBe('input#console-filter');
  });
});

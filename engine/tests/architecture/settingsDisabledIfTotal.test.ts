/** Guard: Project Settings' `disabledIf` is implemented ONCE, as a wrapper — never
 *  enumerated per field type.
 *
 *  `ProjectSettingsField.disabledIf` promises, generically, that a control greys out while
 *  some other field holds a given value. `Field` renders twelve different control types
 *  through a `switch`. The first implementation (1b8b5a489) threaded a `disabled` prop into
 *  the `switch` and reached three of those cases — `checkbox`, `number`, `select`. On the
 *  other nine, `disabledIf` was a SILENT no-op: the control claimed to be inert, looked
 *  entirely normal, and happily wrote a value the heal would then ignore. Nothing errored,
 *  and `text` — the type a `disabledIf` is most likely to be put on next — was one of them.
 *
 *  That is the failure CLAUDE.md names as "a PARTIALLY wired authoring surface is worse than
 *  none", and this very file had already solved it once, ten lines further down, for the
 *  whole-form `inert` case: a `<fieldset disabled>` disables every descendant control
 *  natively, including the sub-editors that never took a disabled prop — and including a
 *  field type nobody has written yet. The per-field wrapper now uses the same primitive.
 *
 *  The rule this asserts: `FieldControl` (the `switch`) must not know about `disabled` at
 *  all, and `Field` (the wrapper) must hand it to a `<fieldset>`. A future contributor who
 *  "fixes" a missing greyed-out state by adding `disabled={disabled}` to their own `case`
 *  re-creates the stale list, and fails here.
 *
 *  WHAT THIS CANNOT PROVE, stated so the guard is not mistaken for more than it is: that the
 *  fieldset actually renders inert in a browser. That is a DOM behaviour, and per CLAUDE.md
 *  § Panels a jsdom mount of a panel would only assert the mock. This is a structural guard
 *  on where the mechanism lives; the rendered behaviour was verified live in the editor. */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripComments, assertScanIsSane, assertEveryCodeTokenSurvives } from '@modoki/engine/testing';
import { findNodes, flatText, lineOf, namedFunctions, parseSource, ts } from '@modoki/engine/testing/sourceAst';

const dialogPath = path.resolve(
  __dirname,
  '../../packages/modoki/src/editor/panels/ProjectSettingsDialog.tsx',
);

// Comment stripping is the shared scanner (@modoki/engine/testing, #419) — this file's own prose
// explains the very hazard being guarded, so an unstripped scan would match its own documentation.

/** Every mention of `disabled` inside `FieldControl` — its parameters and its body, found as the
 *  function NODE — except an attribute written bare (`<input disabled>`): that is `readonly-text`
 *  disabled UNCONDITIONALLY by its own nature, not a `disabledIf` participant, with no value to thread.
 *
 *  ⚠️ **The function's own extent and every mention in it (#1179).** The scan this replaces took the
 *  text from `function FieldControl` to the next line starting `function|const|export|class` — so an
 *  indented declaration, or a JSX line starting `const`, ended the body early — and matched
 *  `disabled` followed by `=`, `:` or `{` per line: `function FieldControl({ field, disabled })`, a
 *  `disabled && …` read and a `disabled={\n  x\n}` split by the formatter all passed. Its bare-attribute
 *  exemption tested for `disabled style`, which the pattern could never match, so it exempted nothing. */
function disabledInFieldControl(code: string, label: string): string[] {
  const sf = parseSource(code, label);
  const fn = namedFunctions(sf).find((f) => f.name === 'FieldControl');
  expect(
    fn,
    'ProjectSettingsDialog no longer declares `FieldControl` — if the switch was renamed, ' +
      'retarget this guard rather than deleting it; the stale-enumeration hazard is unchanged.',
  ).toBeDefined();
  const whole = fn!.body.parent;
  return findNodes(whole, (n): n is ts.Identifier => ts.isIdentifier(n) && n.text === 'disabled')
    .filter((id) => !(ts.isJsxAttribute(id.parent) && id.parent.name === id && id.parent.initializer === undefined))
    .map((id) => `line ${lineOf(id)}: ${flatText(ts.isJsxAttribute(id.parent) ? id.parent : id.parent.parent ?? id.parent)}`);
}

/** Every `<fieldset>` whose `disabled` attribute carries a value. */
function disablingFieldsets(code: string, label: string): number {
  return findNodes(parseSource(code, label), (n): n is ts.JsxOpeningElement | ts.JsxSelfClosingElement =>
    (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && ts.isIdentifier(n.tagName) && n.tagName.text === 'fieldset'
    && n.attributes.properties.some((a) => ts.isJsxAttribute(a) && ts.isIdentifier(a.name) && a.name.text === 'disabled' && !!a.initializer)).length;
}

describe('the FieldControl reader reads the function node, not a text extent (#1179)', () => {
  const read = (src: string) => disabledInFieldControl(stripComments(src), 'Dialog.tsx');
  const TAIL = '\n  const helper = 1;\nfunction After() { return <input disabled={x} />; }';

  it.each([
    ['a destructured `disabled` parameter', 'function FieldControl({ field, disabled }: P) {\n  return <input />;\n}'],
    ['a `disabled && …` read', 'function FieldControl(p: P) {\n  const d = p.disabled && p.field;\n  return <input />;\n}'],
    ['a formatter-split `disabled={…}`', 'function FieldControl(p: P) {\n  return <input\n    disabled={\n      p.off\n    }\n  />;\n}'],
    ['a `disabled` BELOW an indented declaration that ended the old text extent', 'function FieldControl(p: P) {\nconst inner = 1;\n  return <input disabled={p.off} />;\n}'],
  ])('flags %s', (_why, src) => {
    expect(read(src + TAIL)).toHaveLength(1);
  });

  it('a bare `disabled` attribute is the unconditional readonly field, and a later function is not FieldControl', () => {
    expect(read('function FieldControl(p: P) {\n  return <input type="text" disabled style={s} />;\n}' + TAIL)).toEqual([]);
  });

  it('counts a <fieldset> whose disabled attribute carries a value, however it is wrapped', () => {
    expect(disablingFieldsets('const a = <fieldset\n  data-x={a > b}\n  disabled={off}\n/>;\nconst b = <fieldset disabled>{c}</fieldset>;', 'D.tsx')).toBe(1);
  });
});

describe('Project Settings disabledIf is total, not enumerated', () => {
  const raw = fs.readFileSync(dialogPath, 'utf8');
  const code = stripComments(raw);

  it('the comment scan is sane and did not eat code', () => {
    assertScanIsSane(raw, code, 'ProjectSettingsDialog.tsx');
    assertEveryCodeTokenSurvives(raw, code, 'ProjectSettingsDialog.tsx');
  });

  it('disables via a <fieldset>, the one primitive that reaches every field type', () => {
    // Two fieldsets are expected: the per-field wrapper, and the whole-form `inert` one.
    expect(
      disablingFieldsets(code, 'ProjectSettingsDialog.tsx'),
      'expected both the per-field `disabledIf` wrapper and the whole-form `inert` wrapper ' +
        'to disable through <fieldset disabled>',
    ).toBeGreaterThanOrEqual(2);
  });

  it('FieldControl never takes or forwards a `disabled` prop', () => {
    const offenders = disabledInFieldControl(code, 'ProjectSettingsDialog.tsx');

    expect(
      offenders.join('\n'),
      'a `disabled` inside the FieldControl switch re-creates the per-type enumeration that ' +
        'silently covered only 3 of 12 field types. Disabling belongs in the <fieldset> ' +
        'wrapper in `Field`, which reaches every type including ones not written yet.',
    ).toBe('');
  });
});

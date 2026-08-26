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

const dialogPath = path.resolve(
  __dirname,
  '../../packages/modoki/src/editor/panels/ProjectSettingsDialog.tsx',
);

/** Strip block + line comments: this file's prose explains the very hazard being guarded,
 *  so an unstripped scan would match its own documentation and pass (or fail) vacuously. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** The body of `function FieldControl(...)` — from its declaration to the declaration that
 *  follows it at column 0. Deliberately textual: the point is to catch a `disabled` written
 *  into a `case`, which no type-level check can see. */
function fieldControlBody(code: string): string {
  const start = code.indexOf('function FieldControl');
  expect(
    start,
    'ProjectSettingsDialog no longer declares `FieldControl` — if the switch was renamed, ' +
      'retarget this guard rather than deleting it; the stale-enumeration hazard is unchanged.',
  ).toBeGreaterThan(-1);
  const rest = code.slice(start + 1);
  const end = rest.search(/^(?:function|const|export|class) /m);
  return end === -1 ? rest : rest.slice(0, end);
}

describe('Project Settings disabledIf is total, not enumerated', () => {
  const code = stripComments(fs.readFileSync(dialogPath, 'utf8'));

  it('disables via a <fieldset>, the one primitive that reaches every field type', () => {
    // Two fieldsets are expected: the per-field wrapper, and the whole-form `inert` one.
    const fieldsets = code.match(/<fieldset\b[^>]*disabled=/g) ?? [];
    expect(
      fieldsets.length,
      'expected both the per-field `disabledIf` wrapper and the whole-form `inert` wrapper ' +
        'to disable through <fieldset disabled>',
    ).toBeGreaterThanOrEqual(2);
  });

  it('FieldControl never takes or forwards a `disabled` prop', () => {
    const body = fieldControlBody(code);
    const offenders = body
      .split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => /\bdisabled\s*[=:{]/.test(line))
      // `readonly-text` is disabled UNCONDITIONALLY by its own nature — it is not a
      // `disabledIf` participant and has no dynamic value to thread.
      .filter(({ line }) => !/type="text" disabled style/.test(line));

    expect(
      offenders.map((o) => `  line +${o.n}: ${o.line}`).join('\n'),
      'a `disabled` inside the FieldControl switch re-creates the per-type enumeration that ' +
        'silently covered only 3 of 12 field types. Disabling belongs in the <fieldset> ' +
        'wrapper in `Field`, which reaches every type including ones not written yet.',
    ).toBe('');
  });
});

/** The Apply dialog's decisions (#1693, owner ruling C; #1736) — `panels/applyDialogModel.ts`, pure data. The engine
 *  computes each key's targets and default (`applyTargetOptions`) and, for the checked keys at their chosen targets, a dry
 *  run of the Apply (`previewApply`); these are the rules the dialog applies to them. Each case names the mutation that
 *  turns it red. */

import { describe, it, expect } from 'vitest';
import {
  initialTargets, setTarget, setAllTargets, chosenOption, hasChoice, filesWritten, toApplyTargets, rowView, applyBlocked,
  previewRequestKey, staysOpen,
} from '../../packages/modoki/src/editor/panels/applyDialogModel';
import type { KeyTargets } from '../../packages/modoki/src/editor/scene/prefabApplyOptions';
import type { KeyEffect } from '../../packages/modoki/src/editor/scene/prefabApplyEffects';

const HINGE = 'hinge-guid';
const DOOR = 'door-guid';
const opt = (target: string, name: string) => ({ target, name });
/** A field of a component Door's row ADDED to Hinge's member: both targets, Door the default (ruling (a)). */
const rowAdded: KeyTargets = { options: [opt(DOOR, 'Door'), opt(HINGE, 'Hinge')], defaultTarget: DOOR, frameTarget: HINGE };
/** A field Hinge's own template has: both targets, Hinge the default. */
const own: KeyTargets = { options: [opt(DOOR, 'Door'), opt(HINGE, 'Hinge')], defaultTarget: HINGE, frameTarget: HINGE };
/** A move only Hinge can take. */
const onlyHinge: KeyTargets = { options: [opt(HINGE, 'Hinge')], defaultTarget: HINGE, frameTarget: HINGE };
const options = new Map<string, KeyTargets>([['a.Rotate3D.speed', rowAdded], ['a.Transform.x', own], ['~moved.b', onlyHinge]]);

const effect = (key: string, e: KeyEffect['effect'], extra: Partial<KeyEffect> = {}): KeyEffect =>
  ({ key, target: HINGE, targetName: 'Hinge', asOverride: false, effect: e, alsoReverts: [], ...extra });

describe('applyDialogModel', () => {
  it('owner ruling (a): each row starts at the engine\'s default — a row-added component\'s field at Door, the rest at Hinge', () => {
    // Mutation: `initialTargets` takes each key's FIRST option — the Transform row starts at Door.
    // Mutation: `initialTargets` takes the LAST option — the row-added field starts at Hinge (every Hinge gains Rotate3D).
    expect(initialTargets(options)).toEqual({ 'a.Rotate3D.speed': DOOR, 'a.Transform.x': HINGE, '~moved.b': HINGE });
  });

  it('a target a key does not offer is ignored, one key at a time and for "Apply all to …"', () => {
    // Mutation: drop the offered-target check in `setTarget` — the move is set to Door, which cannot express it.
    const start = initialTargets(options);
    expect(setTarget(start, options, '~moved.b', DOOR)).toBe(start);
    expect(setAllTargets(start, options, options.keys(), DOOR)).toEqual({ 'a.Rotate3D.speed': DOOR, 'a.Transform.x': DOOR, '~moved.b': HINGE });
  });

  it('#1733: the footer names each FILE the plan writes, once per prefab — not a display name with ".prefab.json" after it', () => {
    // Mutation: de-duplicate by `file` (or by name) instead of by `source` — two different prefabs that share a file
    // name ("Door.prefab.json" in two folders) are listed once, and the footer undercounts the files written.
    //   And: print `name` — "Wooden Door", a file that does not exist.
    const files = [
      { source: 'g1', name: 'Wooden Door', file: 'Door.prefab.json' },
      { source: 'g2', name: 'Wooden Door', file: 'Door.prefab.json' },
      { source: 'g1', name: 'Wooden Door', file: 'Door.prefab.json' },
      { source: 'g3', name: 'Hinge', file: 'Hinge.prefab.json' },
    ];
    expect(filesWritten({ files })).toEqual(['Door.prefab.json', 'Door.prefab.json', 'Hinge.prefab.json']);
    expect(filesWritten(null)).toEqual([]);
  });

  it('a row reads its PLAN effect: the sentence, a conflict in red, U13\'s revert, and the node note', () => {
    // Mutation: tone every row 'ok' — a conflicting row is not marked, and the user cannot see which two collide.
    const preview = { effects: [
      effect('a.Transform.x', { op: 'setField', member: 'A', trait: 'Transform', field: 'x', to: 5 },
        { alsoReverts: [{ source: DOOR, name: 'Door', keys: ['k'], what: ['its override of Transform.x on A'] }], note: 'n' }),
      effect('b.Transform.x', { op: 'conflict', slot: 'A · Transform.x', value: 9, with: [{ key: 'c.Transform.x', value: 5, who: 'A' }],
        wanted: { op: 'setField', member: 'A', trait: 'Transform', field: 'x', to: 9 } }),
    ] };
    expect(rowView(preview, 'a.Transform.x')).toEqual({
      label: 'A · Transform.x → 5 in Prefab \'Hinge\'', tone: 'ok',
      reverts: ['also reverts Prefab \'Door\': its override of Transform.x on A — Prefab \'Door\' is written too'], note: 'n',
    });
    expect(rowView(preview, 'b.Transform.x')?.tone).toBe('conflict');
    expect(rowView(preview, 'zzz')).toBeNull();
  });

  it('Apply waits for a preview of THIS selection, and a conflict or a refusal blocks it', () => {
    // Mutation: answer null when `preview.request` differs from the current selection — the button enables on a
    // preview of the PREVIOUS selection, and Apply commits what nobody was shown.
    const choice = initialTargets(options);
    const now = previewRequestKey(7, choice, ['a.Transform.x']);
    const was = previewRequestKey(7, choice, ['a.Transform.x', '~moved.b']);
    const ok = { effects: [], conflicts: [], request: now };
    expect(applyBlocked(ok, now)).toBeNull();
    expect(applyBlocked({ ...ok, request: was }, now)).toMatch(/^Working out/);
    expect(applyBlocked(null, now)).toMatch(/^Working out/);
    expect(applyBlocked({ ...ok, conflicts: [{ slot: 's', targetName: 'Hinge', keys: [] }] }, now)).toMatch(/^Cannot apply: 1 conflict /);
    expect(applyBlocked({ ...ok, refused: 'no' }, now)).toBe('Cannot apply: no');
    // Order-free; a target change is a different request, and so is ANOTHER instance with the same keys.
    // Mutation: leave `root` out of `previewRequestKey` — reopened on a second instance of the prefab, the first one's
    // preview counts as current.
    expect(previewRequestKey(7, choice, ['~moved.b', 'a.Transform.x'])).toBe(was);
    expect(previewRequestKey(7, setTarget(choice, options, 'a.Transform.x', DOOR), ['a.Transform.x'])).not.toBe(now);
    expect(previewRequestKey(8, choice, ['a.Transform.x'])).not.toBe(now);
  });

  it('the dialog stays open only for a REFUSAL carrying its plan, never for an Apply that passed every key over', () => {
    // Mutation: drop `!!result.refused` — an Apply whose keys were all skipped (effects: notApplied, no refusal) keeps the
    // dialog open, and every click toasts and does nothing.
    const effects = [effect('a.Transform.x', { op: 'notApplied', reason: 'r' })];
    expect(staysOpen({ applied: false, refused: 'changes write one field…', effects })).toBe(true);
    expect(staysOpen({ applied: false, effects })).toBe(false);
    expect(staysOpen({ applied: false, refused: 'the live world is not authored' })).toBe(false);
    expect(staysOpen({ applied: true, effects })).toBe(false);
  });

  it('only a key with two or more targets gets a picker; the chosen option is the one set', () => {
    // Mutation: `hasChoice` answers `>= 1` — a single-target move shows a picker with one entry.
    expect([hasChoice(options, 'a.Transform.x'), hasChoice(options, '~moved.b')]).toEqual([true, false]);
    expect(chosenOption(setTarget(initialTargets(options), options, 'a.Transform.x', DOOR), options, 'a.Transform.x')?.name).toBe('Door');
  });

  it('the request carries the CHECKED keys\' targets only', () => {
    // Mutation: `toApplyTargets` walks every chosen key — an unchecked row's target is sent.
    expect(toApplyTargets(initialTargets(options), ['a.Rotate3D.speed'])).toEqual({ perKey: { 'a.Rotate3D.speed': DOOR } });
  });
});

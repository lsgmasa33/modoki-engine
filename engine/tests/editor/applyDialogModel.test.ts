/** The Apply dialog's target decisions (#1693, owner ruling C) — `panels/applyDialogModel.ts`, pure data. The engine
 *  computes each key's targets and default (`applyTargetOptions`); these are the rules the dialog applies to them.
 *  Each case names the mutation that turns it red. */

import { describe, it, expect } from 'vitest';
import {
  initialTargets, setTarget, setAllTargets, chosenOption, hasChoice, filesWritten, toApplyTargets,
} from '../../packages/modoki/src/editor/panels/applyDialogModel';
import type { KeyTargets } from '../../packages/modoki/src/editor/scene/prefabApplyOptions';

const HINGE = 'hinge-guid';
const DOOR = 'door-guid';
const opt = (target: string, name: string, alsoReverts: { prefab: string; name: string; what: string }[] = []) =>
  ({ target, name, label: `apply to ${name}`, alsoReverts });
/** A field of a component Door's row ADDED to Hinge's member: both targets, Door the default (ruling (a)). */
const rowAdded: KeyTargets = { options: [opt(DOOR, 'Door'), opt(HINGE, 'Hinge', [{ prefab: DOOR, name: 'Door', what: 'its override of Rotate3D' }])], defaultTarget: DOOR, frameTarget: HINGE };
/** A field Hinge's own template has: both targets, Hinge the default. */
const own: KeyTargets = { options: [opt(DOOR, 'Door'), opt(HINGE, 'Hinge')], defaultTarget: HINGE, frameTarget: HINGE };
/** A move only Hinge can take. */
const onlyHinge: KeyTargets = { options: [opt(HINGE, 'Hinge')], defaultTarget: HINGE, frameTarget: HINGE };
const options = new Map<string, KeyTargets>([['a.Rotate3D.speed', rowAdded], ['a.Transform.x', own], ['~moved.b', onlyHinge]]);

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

  it('the footer names every file the CHECKED rows write: each target, and the prefab U13 reverts an override in', () => {
    // Mutation: leave `alsoReverts` out of `filesWritten` — "Hinge" alone, though Door's row is written too.
    const hinge = setTarget(initialTargets(options), options, 'a.Rotate3D.speed', HINGE);
    expect(filesWritten(hinge, options, ['a.Rotate3D.speed'])).toEqual(['Hinge', 'Door']);
    expect(filesWritten(hinge, options, ['a.Transform.x', '~moved.b'])).toEqual(['Hinge']);
    expect(filesWritten(hinge, options, [])).toEqual([]);
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

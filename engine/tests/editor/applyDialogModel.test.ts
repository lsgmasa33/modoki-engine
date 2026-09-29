/** The Apply dialog's decisions (#1693, owner ruling C; #1736) — `panels/applyDialogModel.ts`, pure data. The engine
 *  computes each key's targets and default (`applyTargetOptions`) and, for the checked keys at their chosen targets, a dry
 *  run of the Apply (`previewApply`); these are the rules the dialog applies to them. Each case names the mutation that
 *  turns it red. */

import { describe, it, expect } from 'vitest';
import {
  initialTargets, setTarget, setAllTargets, chosenOption, hasChoice, filesWritten, toApplyTargets, rowView, applyBlocked,
  applyPress, queuedPress, shownPlan, previewRequestKey, staysOpen,
  previewWorldKey, subscribePreviewWorld, groupToggle, groupState, retargetChecks,
} from '../../packages/modoki/src/editor/panels/applyDialogModel';
import { pushAction, clearHistory, undo } from '../../packages/modoki/src/editor/undo/undoManager';
import { setRunMode } from '../../packages/modoki/src/runtime/core/playState';
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

  // A press while the plan is worked out is KEPT, not dropped (the button was disabled then, and the first press after
  // every checkbox change did nothing — 3 of 3 live tries), and it applies only a plan that says what the rows showed
  // (#1736; close-out review: a kept press once committed a target change and the re-read after a refusal unseen).
  // Mutations: make applyPress answer 'blocked' for a stale preview, or 'wait' for none, or drop its per-key check (either
  // half) — the press cases fail; drop the selection check —
  // a press made on one selection applies another; drop the shownPlan comparison — the changed cases apply; put the
  // world back out of previewRequestKey — a preview planned before an edit reads as current.
  it('a kept press waits for the plan and applies it only if it says what the rows showed', () => {
    const at = (key: string, name: string) => effect(key, { op: 'setField', member: 'A', trait: 'Transform', field: 'x', to: 2 }, { target: name, targetName: name });
    const choice = initialTargets(new Map([['a.Transform.x', rowAdded]]));
    const sel = previewRequestKey(7, choice, ['a.Transform.x']);
    const req = previewRequestKey(7, choice, ['a.Transform.x'], 'v1');
    const was = previewRequestKey(7, choice, ['a.Transform.x', 'a.Transform.y'], 'v1');
    // The world is part of the request: a preview planned before an edit is stale, not current.
    expect(previewRequestKey(7, choice, ['a.Transform.x'], 'v2')).not.toBe(req);
    const shownDoor = { effects: [at('a.Transform.x', 'Door')], conflicts: [], request: was };
    const landed = (name: string) => ({ effects: [at('a.Transform.x', name)], conflicts: [], request: req });
    // No plan shown yet (the open, the re-read after a refused Apply) → nothing a press could agree to: blocked.
    const x = ['a.Transform.x'];
    const atDoor = { 'a.Transform.x': 'Door' };
    expect([applyPress(landed('Door'), req, x, atDoor), applyPress(shownDoor, req, x, atDoor), applyPress(null, req, x, atDoor)]).toEqual(['apply', 'wait', 'blocked']);
    expect([applyPress({ ...landed('Door'), conflicts: [{ slot: 's', targetName: 'Hinge', keys: [] }] }, req, x, atDoor), applyPress({ ...landed('Door'), refused: 'no' }, req, x, atDoor)]).toEqual(['blocked', 'blocked']);
    // Rows that show no plan for a checked key wait for one (close-out re-review: kept, the press was always refused as
    // "changed"): a key just checked has no row in the stale plan, and a retargeted key's row names the old target.
    expect(applyPress(shownDoor, req, [...x, 'a.Transform.y'], atDoor)).toBe('blocked');
    expect(applyPress(shownDoor, req, x, { 'a.Transform.x': 'Hinge' })).toBe('blocked');
    expect(applyPress({ ...shownDoor, effects: [] }, req, x, atDoor)).toBe('blocked');
    // An uncheck: the rows showed Door for x, and the landed plan says Door → apply.
    const kept = { selection: sel, keys: ['a.Transform.x'], shown: shownPlan(shownDoor, ['a.Transform.x']) };
    expect(queuedPress(null, landed('Door'), req, sel)).toBeNull();
    expect(queuedPress(kept, shownDoor, req, sel)).toBe('wait');
    expect(queuedPress(kept, landed('Door'), req, sel)).toBe('apply');
    // The plan landed saying something the rows did not (a target changed, a cross-key effect, an edit) → not applied.
    expect(queuedPress(kept, landed('Hinge'), req, sel)).toBe('changed');
    // A press recorded over rows that showed no effect (applyPress no longer keeps one; this is the backstop) → not applied.
    expect(queuedPress({ ...kept, shown: shownPlan(null, ['a.Transform.x']) }, landed('Door'), req, sel)).toBe('changed');
    // An edit while it waits does not drop it: it waits for the new plan and is held to the same test.
    expect(queuedPress(kept, landed('Door'), previewRequestKey(7, choice, ['a.Transform.x'], 'v2'), sel)).toBe('wait');
    // The selection changed after the press, or the plan came back blocked → dropped.
    expect(queuedPress({ ...kept, selection: previewRequestKey(7, choice, ['a.Transform.x', 'a.Transform.y']) }, landed('Door'), req, sel)).toBe('drop');
    expect(queuedPress(kept, { ...landed('Door'), refused: 'no' }, req, sel)).toBe('drop');
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

  it('#1831: checking a group leaves the root\'s default overrides, unless they are all it holds; unchecking clears them', () => {
    const defaults = new Set(['r.Transform.x', 'r.Transform.rx']);
    const tf = ['r.Transform.x', 'r.Transform.sx', 'r.Transform.rx'];
    // Mutation: check every key of the group — the root's Transform checkbox checks x, which Apply All leaves.
    expect([...groupToggle(new Set(), tf, defaults, 'on')]).toEqual(['r.Transform.sx']);
    // Mutation: check only the rest — a component holding only default overrides gets a checkbox that does nothing.
    expect([...groupToggle(new Set(), ['r.Transform.x', 'r.Transform.rx'], defaults, 'on')]).toEqual(['r.Transform.x', 'r.Transform.rx']);
    // Mutation: uncheck only the rest — "leave this component out" leaves a checked x in, to be applied (review #5).
    expect([...groupToggle(new Set(['r.Transform.x', 'r.Transform.sx', 'a.T.y']), tf, defaults, 'off')]).toEqual(['a.T.y']);
  });

  it('#1831: a group reads over what checking it checks, and "mixed" (never "off") while a default override in it is checked', () => {
    const defaults = new Set(['r.Transform.x']);
    const tf = ['r.Transform.x', 'r.Transform.sx'];
    expect(groupState(new Set(['r.Transform.sx']), tf, defaults)).toBe('on'); // as it starts
    // Mutation: `return 'off'` when none of the rest is on — the x the user checked hides under an "off" box (review #5).
    expect(groupState(new Set(['r.Transform.x']), tf, defaults)).toBe('mixed');
    expect(groupState(new Set(), tf, defaults)).toBe('off');
    expect(groupState(new Set(['r.Transform.x']), ['r.Transform.x'], defaults)).toBe('on');
  });

  it('#1831: a target change checks a default override it turns ordinary, unchecks one it turns back, and keeps every other check', () => {
    const OWN = 'p-guid'; const OUTER = 'o-guid';
    const none = (): undefined => undefined;
    const d = ['r.Transform.x'];
    // Mutation: ignore the target (`isDefaultOverrideAt` true for any) — sending the nested root's placement to the
    // OUTER prefab leaves it unchecked, though Unity: it "is not a default override if applying to A" (review #2).
    expect([...retargetChecks(new Set(['m.T.y']), d, { 'r.Transform.x': OWN }, { 'r.Transform.x': OUTER }, OWN, none)]).toEqual(['m.T.y', 'r.Transform.x']);
    expect([...retargetChecks(new Set(['r.Transform.x']), d, { 'r.Transform.x': OUTER }, { 'r.Transform.x': OWN }, OWN, none)]).toEqual([]);
    // Mutation: re-set every default override from the new target — "Apply all to" its own prefab unchecks an x the user
    // checked on purpose (second review #3).
    expect([...retargetChecks(new Set(['r.Transform.x']), d, { 'r.Transform.x': OWN }, { 'r.Transform.x': OWN }, OWN, none)]).toEqual(['r.Transform.x']);
    // A path spelling of the own prefab is the own prefab.
    expect([...retargetChecks(new Set(), d, { 'r.Transform.x': OUTER }, { 'r.Transform.x': '/p.prefab.json' }, OWN, (g) => (g === OWN ? '/p.prefab.json' : undefined))]).toEqual([]);
  });

  it('the request carries the CHECKED keys\' targets only', () => {
    // Mutation: `toApplyTargets` walks every chosen key — an unchecked row's target is sent.
    expect(toApplyTargets(initialTargets(options), ['a.Rotate3D.speed'])).toEqual({ perKey: { 'a.Rotate3D.speed': DOOR } });
  });
});

// ── #1773: the preview re-plans when the world moves ─────────────────────────────────────────────────────────────
describe('previewWorldKey / subscribePreviewWorld (#1773)', () => {
  // The dialog keys its preview effect on this, so a refusal it shows is re-asked once the world changes.
  it('moves on an edit, an undo and a run-mode change, and NOT on a selection', async () => {
    // Mutations: key on `getUndoVersion` instead of the edit version — a selection moves it; drop the run mode from the
    // key — entering Play leaves it where it was.
    setRunMode('stopped');
    clearHistory();
    const k0 = previewWorldKey();
    pushAction({ label: 'select', _isSelection: true, undo: () => {}, redo: () => {} });
    expect(previewWorldKey()).toBe(k0);
    pushAction({ label: 'edit', undo: () => {}, redo: () => {} });
    const k1 = previewWorldKey();
    expect(k1).not.toBe(k0);
    await undo(); // the edit, on top
    expect(previewWorldKey()).not.toBe(k1);
    const k2 = previewWorldKey();
    setRunMode('playing');
    expect(previewWorldKey()).not.toBe(k2);
    setRunMode('stopped');
    clearHistory();
  });

  // Mutation: drop either subscription from `subscribePreviewWorld` — its count stays short.
  it('notifies on a push and on a run-mode change, and stops after the unsubscribe', () => {
    setRunMode('stopped');
    let n = 0;
    const off = subscribePreviewWorld(() => { n++; });
    pushAction({ label: 'edit', undo: () => {}, redo: () => {} });
    const afterPush = n;
    expect(afterPush).toBeGreaterThan(0);
    setRunMode('playing');
    expect(n).toBeGreaterThan(afterPush);
    off();
    const settled = n;
    setRunMode('stopped');
    pushAction({ label: 'edit 2', undo: () => {}, redo: () => {} });
    expect(n).toBe(settled);
    clearHistory();
  });
});

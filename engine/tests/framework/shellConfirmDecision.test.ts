/** #553 close-out sweep — the SHELL half of "promotion decoupled from the version being
 *  promoted".
 *
 *  `App.tsx`'s boot effect calls `checkAppOtaUpdate()` and then, on the "fully booted" signal,
 *  confirmed the shell unconditionally. For a ROUTINE (non-mandatory) update those two happen
 *  in the SAME launch: the check stages vNew and `activate()`s it, so `pending` names a version
 *  that is not the one rendering, and the confirm credited vNew with vOld's successful boot.
 *  vNew then reached `active` after ONE boot of itself instead of the two `requiredConfirms`
 *  demands. A MANDATORY update was never affected — the gate returns early and the signal
 *  never fires.
 *
 *  The decision lives in a plain `.ts` module so it can be tested without mounting App.tsx
 *  (CLAUDE.md § Editor: a panel's DECISIONS belong beside it in `.ts`). */
import { describe, it, expect } from 'vitest';
import { decideShellConfirm } from '../../app/ota';

const S = (o: unknown) => JSON.stringify(o);

describe('decideShellConfirm', () => {
  it('⚠️ REFUSES to confirm a pending version the boot hook has not served yet — the defect', () => {
    // Exactly the routine-update launch: activate() has just written pending and cleared
    // bootAttempts, and the frame that rendered belongs to the version being REPLACED.
    const d = decideShellConfirm(S({ active: { shell: 'v20' }, pending: { shell: 'v21' }, bootAttempts: {} }), 'shell');
    expect(d.confirm).toBe(false);
    expect(d).toHaveProperty('reason', expect.stringContaining('v21'));
  });

  it('confirms and NAMES the version once the boot hook has served it', () => {
    // bootAttempts >= 1 means the native hook served `pending` before the WebView loaded, so
    // this launch's rendered frame really is evidence about v21.
    const d = decideShellConfirm(S({ active: { shell: 'v20' }, pending: { shell: 'v21' }, bootAttempts: { shell: 1 } }), 'shell');
    expect(d).toEqual({ confirm: true, version: 'v21' });
  });

  it('confirms unversioned when nothing is pending — the ordinary launch, a documented no-op', () => {
    expect(decideShellConfirm(S({ active: { shell: 'v20' }, pending: {} }), 'shell')).toEqual({ confirm: true });
  });

  it('is per-bundle: another bundle mid-update never blocks the shell', () => {
    const state = S({ active: { shell: 'v20' }, pending: { 'ota-subgame-test': 'v2' }, bootAttempts: {} });
    expect(decideShellConfirm(state, 'shell')).toEqual({ confirm: true });
  });

  it('honours a non-default bundleName rather than assuming "shell"', () => {
    const state = S({ pending: { mygame: 'v9' }, bootAttempts: { mygame: 2 } });
    expect(decideShellConfirm(state, 'mygame')).toEqual({ confirm: true, version: 'v9' });
  });

  it.each([
    ['absent state', 'null'],
    ['empty string', ''],
    ['unparseable JSON', '{ this is not valid JSON'],
  ])('falls through to an unversioned confirm on %s rather than throwing on the boot path', (_l, json) => {
    // OtaCore already contracts that corrupt state behaves exactly like "no state"; this must
    // not become a second, divergent opinion about it — and it must never throw, because the
    // caller is the app's own boot effect.
    expect(decideShellConfirm(json, 'shell')).toEqual({ confirm: true });
  });
});

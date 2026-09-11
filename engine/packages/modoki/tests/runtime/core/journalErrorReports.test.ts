// @vitest-environment jsdom
/**
 * #1056 — `journalError` files a Crashlytics report in EVERY build, including one whose journal is off.
 *
 * The journal is enabled only in the editor and debug builds (`engine/app/main.tsx`), so a failure a
 * game caught and reported only through `journalError` used to reach no one from a store build. Court
 * had 28 such sites. The owner chose to fix it once, in the engine (Option A).
 *
 * Each test re-imports through `vi.resetModules()`, because the limiter, the journal switch and the
 * service registry are all module state.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

let recorded: string[];
let logged: string[];

async function load() {
  vi.resetModules();
  const globalErrors = await import('../../../src/runtime/core/globalErrors');
  const appServices = await import('../../../src/runtime/core/appServices');
  const journal = await import('../../../src/runtime/core/journal');
  const gameJournal = await import('../../../src/runtime/core/gameJournal');
  globalErrors.__resetGlobalErrorsForTest();
  const errors: string[] = [];
  const logs: string[] = [];
  recorded = errors;
  logged = logs;
  appServices.registerAppServices({
    crashlytics: { recordError: (m) => { errors.push(m); }, log: (m) => { logs.push(m); } },
  });
  journal.clearJournal();
  journal.setJournalEnabled(true);
  return { ...journal, ...gameJournal };
}

// `sessionStorage` carries the limiter's session budgets across `vi.resetModules()`. There is no
// `localStorage` in this lane's jsdom, and none is needed: a registered service means nothing queues,
// so nothing is stashed.
beforeEach(() => {
  sessionStorage.clear();
});

describe('journalError reports to Crashlytics (#1056)', () => {
  it('reports with the journal DISABLED, which is what a store build runs', async () => {
    const j = await load();
    j.setJournalEnabled(false);

    j.journalError('game.save.durability-unconfirmed', { keys: ['progress'], attempts: 2 });

    expect(recorded).toEqual(['[journalError] game.save.durability-unconfirmed {"keys":["progress"],"attempts":2}']);
    expect(j.journalEvents(), 'the journal itself stayed off').toHaveLength(0);
  });

  it('still journals at level error, and files exactly one report', async () => {
    const j = await load();

    j.journalError('game.load-failed', 'levels.json 404 — giving up');

    expect(j.journalEvents().map((e) => [e.type, e.level])).toEqual([['game.load-failed', 'error']]);
    expect(recorded).toEqual(['[journalError] game.load-failed levels.json 404 — giving up']);
  });

  it('journalWarn, journalState and journalDecision stay journal-only', async () => {
    const j = await load();

    j.journalWarn('game.account.wipe-heal-deferred', { at: 1 });
    j.journalState('game.phase', { to: 'play' });
    j.journalDecision('game.spawn', { roll: 3 });

    expect(j.journalEvents()).toHaveLength(3);
    expect(recorded).toEqual([]);
    expect(logged).toEqual([]);
  });

  it('an Error in the payload keeps its message, where JSON.stringify alone would send {}', async () => {
    const j = await load();

    j.journalError('game.store.buy-threw', { productId: 'coins-100', error: new Error('quota exceeded') });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toContain('"productId":"coins-100"');
    expect(recorded[0]).toContain('Error: quota exceeded');
    expect(recorded[0]).not.toContain('"error":{}');
  });

  it('reports with no payload, and with a payload that cannot be serialized', async () => {
    const j = await load();
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    j.journalError('game.no-payload');
    j.journalError('game.circular', circular);

    expect(recorded).toEqual(['[journalError] game.no-payload', '[journalError] game.circular [object Object]']);
  });
});

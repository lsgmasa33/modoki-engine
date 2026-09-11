/**
 * Every caller of `busNode` NORMALISES its bus first (#993 close-out § 2d).
 *
 * ⚠️ This file exists because its own citation was a FABRICATION. `busNode`'s docblock said
 * *"`audioBusVocabulary.test.ts` now asserts every caller of this function normalises, so the claim
 * cannot rot again silently"* — and no such file had ever existed on any branch. That is worse than
 * an ordinary stale comment, because the sentence it propped up is **"do not add a guard of your
 * own"**: the next author adding a caller reads "a test proves this", skips the guard, and ships the
 * `connect(Object)` crash the section documents, with nothing red anywhere.
 *
 * The claim was also FALSE once already, in the commit before this one: the docblock said "the
 * playback path", singular, while `attachMediaElementToBus` was passing `VideoPlayer.bus` straight
 * through. So the totality claim has now rotted once and been faked once. It gets a check.
 *
 * ⚠️ A SOURCE SCAN, deliberately. What is being asserted is a property of the CALL SITES — "no
 * caller passes an unnormalised bus" — and a behavioural test can only ever cover the callers it
 * happens to know about, which is exactly how the third one was missed. `invalidatorsAreReachable`
 * and `retractedClaims` take the same shape for the same reason: the population is what matters.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readScannedSource } from '../helpers/sourceScanner';

const SRC = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/runtime/audio/audioService.ts',
);

/** `busNode(` uses that are CALLS, not the declaration.
 *
 *  ⚠️ Reads through `readScannedSource`, per #812 — a guard matching RAW text lets a COMMENT
 *  hide an offender or satisfy an assertion, both silently. The first version of this file hand-
 *  rolled a "skip lines starting with //" filter, which is the naive half of what the shared
 *  reader does, and `commentStripperIsShared.test.ts` failed it on exactly that. */
function busNodeCallSites(code: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  code.split('\n').forEach((raw, i) => {
    const text = raw.trim();
    if (!text.includes('busNode(')) return;
    if (/^(export\s+)?function\s+busNode\s*\(/.test(text)) return; // the declaration
    out.push({ line: i + 1, text });
  });
  return out;
}

/** A bus argument is SAFE only when it is normalised AT THE CALL, or is a code literal.
 *
 *  ⚠️ The first version of this regex also allowed a bare `bus` identifier — meant as room for
 *  `setBusVolume`, which refuses before it calls. It let EVERY site pass a bare `bus`, so
 *  un-normalising the video caller kept this suite green: the guard permitted exactly the defect it
 *  was written for. The bare-identifier case is now ONE named line, below, not a general shape. */
const SAFE_ARG = /busNode\(\s*g\s*,\s*(resolveBus\(|'(?:master|music|sfx|ui)')/;

/** The single call site allowed to pass a bare `bus`, because it has already RETURNED on an
 *  unknown one. Matched exactly, so an edit to that line re-opens the question rather than
 *  inheriting the exemption. The refusal it depends on is asserted separately below. */
const REFUSES_BEFORE_CALLING = 'if (g) busNode(g, bus).gain.value = volume;';

describe('busNode callers normalise (#993)', () => {
  const source = readScannedSource(SRC).code;
  const sites = busNodeCallSites(source);

  it('the scan finds call sites at all — a vacuous pass is a failure', () => {
    // Without this, renaming `busNode` makes every rule below pass over an empty list.
    expect(sites.length).toBeGreaterThanOrEqual(3);
  });

  it.each([0, 1, 2])('call site #%i passes a normalised or literal bus', (i) => {
    const site = sites[i];
    expect(site, `expected at least ${i + 1} busNode call sites`).toBeDefined();
    expect(
      SAFE_ARG.test(site.text) || site.text === REFUSES_BEFORE_CALLING,
      `audioService.ts:${site.line} passes an unnormalised bus into busNode:\n  ${site.text}\n\n`
      + 'Wrap it in resolveBus(), or refuse the unknown bus before the call as setBusVolume does. '
      + '`AudioSource.bus` and `VideoPlayer.bus` are both declared as a union by a CAST on a '
      + 'default, so the value reaching here is an unchecked string from scene JSON (#993).',
    ).toBe(true);
  });

  it('every call site is covered by the rules above — a fourth caller is not silently allowed', () => {
    // The it.each above pins three. If a fourth appears, this is what goes red.
    expect(
      sites.length,
      `busNode gained a caller (${sites.length} now). Add it to the it.each range above after `
      + 'checking it normalises — do not just widen the number.',
    ).toBe(3);
  });

  it('the one caller that does NOT wrap is the one that refuses first', () => {
    // `setBusVolume` passes `bus` bare, which is only safe because it returns early on an unknown
    // bus. Asserting the refusal is what stops that call site being "the exception" by habit.
    expect(source).toMatch(/if \(!hasDocKey\(busVolumes, bus\)\)[\s\S]{0,200}?return;/);
  });
});

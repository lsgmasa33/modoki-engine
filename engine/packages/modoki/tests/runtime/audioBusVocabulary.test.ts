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
    // `return false` since #1074 — the caller mirroring the volume into the mixer store reads it.
    expect(source).toMatch(/if \(!hasDocKey\(busVolumes, bus\)\)[\s\S]{0,200}?return false;/);
  });
});

// ── audioSystem.ts — every `@audio` journal emission that reports a bus RESOLVES it (#1069) ──────

const SYSTEM_SRC = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/runtime/audio/audioSystem.ts',
);

/** The full text of every `journalAudio(` CALL, paren-balanced — `startOrSwap`'s payload spans three
 *  lines with `bus:` on the middle one, so a line-based scan (as `busNodeCallSites` is) would read
 *  that call as carrying no bus at all and wave it through. */
function journalAudioCalls(code: string): string[] {
  const out: string[] = [];
  const re = /\bjournalAudio\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    if (/function\s+$/.test(code.slice(Math.max(0, m.index - 16), m.index))) continue; // the declaration
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < code.length && depth > 0; i++) {
      if (code[i] === '(') depth++;
      else if (code[i] === ')') depth--;
    }
    out.push(code.slice(m.index, i).replace(/\s+/g, ' '));
  }
  return out;
}

/** The one emission allowed to report `bus` by SHORTHAND: `playOneShot`'s `stolen`, whose `bus` is the
 *  local declared as `resolveBus(spec.bus)` — asserted below. Matched exactly, like
 *  `REFUSES_BEFORE_CALLING`, so an edit to it re-opens the question instead of inheriting this. */
const SHORTHAND_OK = "journalAudio(world, 'stolen', undefined, { clip: victim.clip, bus, reason: 'voice-cap' })";

describe('audioSystem journals the RESOLVED bus on every emission (#1069)', () => {
  // The behavioural half — one case per path, each proven by reverting its call site — is in
  // vocabWiringReaches.test.ts and audioCueRetry.test.ts. This is the POPULATION half: a fifth
  // emission path written with a raw bus has no behavioural test yet, and this is what reds on it.
  const source = readScannedSource(SYSTEM_SRC).code;
  const withBus = journalAudioCalls(source).filter((c) => /[{,]\s*bus\s*[:,}]/.test(c));

  it('the scan finds bus-carrying emissions at all — a vacuous pass is a failure', () => {
    expect(withBus.length).toBeGreaterThanOrEqual(5);
  });

  it('every emission that reports a bus passes it through resolveBus()', () => {
    const offenders = withBus.filter((c) => c !== SHORTHAND_OK && !/\bbus: resolveBus\(/.test(c));
    expect(
      offenders,
      'An `@audio` journal event reports a bus that did not go through resolveBus(). The graph plays '
      + 'an unrecognised bus on sfx, so a raw field makes the journal disagree with what was heard — '
      + 'and the journal is what QA and agents assert on (#993 § 2d, #1069).',
    ).toEqual([]);
  });

  it("the shorthand exception's `bus` is the resolved local", () => {
    expect(withBus).toContain(SHORTHAND_OK);
    expect(source).toMatch(/const bus = resolveBus\(spec\.bus\);/);
  });

  it('every emission is covered — a sixth is not silently allowed', () => {
    expect(
      withBus.length,
      `audioSystem.ts gained a bus-carrying journalAudio call (${withBus.length} now). Give it a `
      + 'behavioural case in vocabWiringReaches.test.ts, then update this number.',
    ).toBe(5);
  });
});

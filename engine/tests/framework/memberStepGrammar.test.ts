/** The ONE member-step grammar and the ONE anchor/step classifier (#1468 Phase 1).
 *
 *  Before this landed, eleven sites coerced a step back to a number by hand and six spelled the
 *  stored-root predicate inline. The duplication is what made `localId`'s spelling load-bearing in
 *  eleven places at once, and it is what a later localId → node-guid switch (#1468 § 3.5) would
 *  have had to edit eleven times instead of once.
 *
 *  ⚠️ **These are pure and synchronous — no timers, so `docs/falsifiable-tests.md` § shape (I)
 *  does not apply here.** The setup cannot "fail green" by never forming, because there is no
 *  interleaving to form. The falsifiability that DOES matter for this pair is the architecture
 *  guard (`memberStepGrammarIsShared.test.ts`): these tests prove the shared body is right, that
 *  one proves nothing else re-implements it.
 */

import { describe, it, expect } from 'vitest';
import {
  parseStep, formatStep, parseSteps, memberPathSteps,
  entityStep, isStoredRoot, isOwnedRoot, isDerivedMember,
  addedKeyStep, memberStepId, deriveMemberGuid, newGuid,
} from '../../packages/modoki/src/runtime/core/assetRefRules';
import { deriveMemberChain } from '../../packages/modoki/src/runtime/loaders/memberPaths';
import { memberPathKey, parseMemberToken, memberToken } from '../../packages/modoki/src/runtime/core/templateRefs';

describe('parseStep — the one step grammar', () => {
  it('reads a localId step as a number', () => {
    expect(parseStep('3')).toBe(3);
    expect(parseStep('0')).toBe(0);
    expect(parseStep('1030')).toBe(1030); // alien-animal's real ceiling (#1468 § 3.4)
  });

  it("reads a template-keyed added node's '+key' step as the string, sigil included", () => {
    expect(parseStep('+abc')).toBe('+abc');
    const key = newGuid();
    expect(parseStep(addedKeyStep(key))).toBe(`+${key}`);
  });

  it('rejects text that is NEITHER shape, rather than coercing it', () => {
    expect(parseStep('')).toBeNull();
    expect(parseStep('+')).toBeNull();      // the sigil alone is not a key
    expect(parseStep('-1')).toBeNull();
    expect(parseStep('1a')).toBeNull();
    expect(parseStep('NaN')).toBeNull();
  });

  it("keeps '+1' a STRING — the collision the sigil exists to prevent", () => {
    // ⚠️ `Number('+1')` is 1, not NaN. Had the grammar coerced first, a template key of "1" would
    // have parsed as localId 1 and named a different node. A template key is guid-shaped, so this
    // is a floor rather than a live case — but it is the floor the whole `+` design rests on.
    expect(parseStep('+1')).toBe('+1');
    expect(parseStep('+1')).not.toBe(1);
  });

  it('is the grammar a guid-shaped step would extend — it does NOT accept one today', () => {
    // The hedge #1468 § 3.5 buys: a later localId → node-guid switch adds a shape HERE and nowhere
    // else. This asserts the starting point honestly — a bare guid step is rejected today.
    expect(parseStep(newGuid())).toBeNull();
  });
});

describe('formatStep / memberPathKey — the inverse', () => {
  it('formats both shapes as the text a key and a token carry', () => {
    expect(formatStep(7)).toBe('7');
    expect(formatStep('+abc')).toBe('+abc');
  });

  it('re-joins a key byte-for-byte — the equivalence the two memberHome derive sites rest on', () => {
    // `stampDerivedMemberGuids` and `promoteOwnedRoots` used to hand `key.split('.')` (raw strings)
    // straight to `deriveMemberGuid`, which re-joins them. Phase 1 parses first, so the migration is
    // seed-identical ONLY while parsing and re-joining is the identity on keys `memberPathKey` emits.
    // ⚠️ It is NOT the identity on arbitrary text — `memberPathSteps('007').join('.')` is `'7'` — so
    // this is a claim about the producer, not about the grammar.
    for (const path of [[1], [1, 2, 3], ['+abc'], [1, '+abc', 2], [0], [1030], ['+abc', 5]] as (number | string)[][]) {
      const key = memberPathKey(path);
      expect(memberPathSteps(key).join('.'), `re-join diverged for ${key}`).toBe(key);
    }
  });

  it('round-trips every path through memberPathKey', () => {
    for (const path of [[1], [1, 2, 3], ['+a'], [1, '+a', 2], [0], []] as (number | string)[][]) {
      expect(memberPathSteps(memberPathKey(path))).toEqual(path);
    }
  });
});

describe('memberPathSteps vs parseSteps — the empty-key split is deliberate', () => {
  it("memberPathSteps('') is the frame ROOT: no steps", () => {
    expect(memberPathSteps('')).toEqual([]);
  });

  it("parseSteps('') is a single 0 step — the seed deriveMemberChain has always used", () => {
    // ⚠️ `deriveGuid`'s output is PERSISTED and FROZEN (`assetRefRules.ts`). An empty SEGMENT of a
    // multi-segment key has always seeded `deriveMemberGuid` with '0', so collapsing the two spellings
    // into one would have silently re-pointed every guid derived through such a segment.
    expect(parseSteps('')).toEqual([0]);
    expect(deriveMemberGuid('anchor', parseSteps(''))).toBe(deriveMemberGuid('anchor', [0]));
    expect(deriveMemberGuid('anchor', parseSteps(''))).not.toBe(deriveMemberGuid('anchor', []));
  });

  it('splits a mixed path into both shapes', () => {
    expect(memberPathSteps('1.+a.2')).toEqual([1, '+a', 2]);
  });

  it('reads an unparseable part LENIENTLY, as a step that names nothing', () => {
    // NaN is a legal MemberStep that equals no member, so a corrupt key reaches the caller's existing
    // "names nothing" path instead of throwing. Tightening this belongs with R2 (#1468 § 3.3).
    const [step] = memberPathSteps('zzz');
    expect(typeof step).toBe('number');
    expect(Number.isNaN(step)).toBe(true);
  });
});

describe('deriveMemberChain reads each SEGMENT unguarded — the frozen-guid seam', () => {
  it('seeds an empty segment with [0], not with nothing', () => {
    // ⚠️ This is the one place in #1468 Phase 1 where a ONE-TOKEN edit silently re-points
    // persisted guids: `parseSteps(seg)` → `memberPathSteps(seg)`. Before this assertion existed,
    // that mutation left the ENTIRE suite green — measured 28,823 tests across 950 files — so the
    // choice was pinned by a comment and nothing else. Found by the Phase 1 close-out review.
    const anchor = 'anchor-guid';
    const unguarded = deriveMemberGuid(deriveMemberGuid(deriveMemberGuid(anchor, [1]), [0]), [2]);
    const guarded = deriveMemberGuid(deriveMemberGuid(deriveMemberGuid(anchor, [1]), []), [2]);
    expect(deriveMemberChain(anchor, '1||2')).toBe(unguarded);
    expect(deriveMemberChain(anchor, '1||2')).not.toBe(guarded);
  });

  it('is unchanged for a key with no empty segment', () => {
    const anchor = 'anchor-guid';
    expect(deriveMemberChain(anchor, '1.2|3')).toBe(deriveMemberGuid(deriveMemberGuid(anchor, [1, 2]), [3]));
  });
});

describe('parseMemberToken shares the grammar', () => {
  it('accepts exactly what parseStep accepts', () => {
    expect(parseMemberToken(memberToken(0, [1, '+a', 2]))).toEqual({ up: 0, path: [1, '+a', 2] });
    expect(parseMemberToken('@member:')).toEqual({ up: 0, path: [] });
    expect(parseMemberToken('@member:^.1')).toEqual({ up: 1, path: [1] });
  });

  it('REJECTS what parseStep rejects — a token comes from a file, so it is the strict reader', () => {
    expect(parseMemberToken('@member:-1')).toBeNull();
    expect(parseMemberToken('@member:1a')).toBeNull();
    expect(parseMemberToken('@member:+')).toBeNull();
    expect(parseMemberToken(`@member:${newGuid()}`)).toBeNull();
  });
});

describe('the anchor/step classifier', () => {
  const SELF = 42;

  it('isStoredRoot: rootInstanceId is itself AND it did not expand from a row', () => {
    expect(isStoredRoot({ rootInstanceId: SELF, parentLocalId: 0 }, SELF)).toBe(true);
    expect(isStoredRoot({ rootInstanceId: SELF }, SELF)).toBe(true);
    expect(isStoredRoot({ rootInstanceId: SELF, parentLocalId: 3 }, SELF)).toBe(false); // owned
    expect(isStoredRoot({ rootInstanceId: 7 }, SELF)).toBe(false);                      // a member
    expect(isStoredRoot(null, SELF)).toBe(false);
    expect(isStoredRoot(undefined, SELF)).toBe(false);
  });

  it('isOwnedRoot is the complement of isStoredRoot AMONG ROOTS, not its negation', () => {
    expect(isOwnedRoot({ rootInstanceId: SELF, parentLocalId: 3 }, SELF)).toBe(true);
    expect(isOwnedRoot({ rootInstanceId: SELF, parentLocalId: 0 }, SELF)).toBe(false);
    // A plain member is NEITHER — which is why one is not spelled as `!`the other.
    expect(isOwnedRoot({ rootInstanceId: 7 }, SELF)).toBe(false);
    expect(isStoredRoot({ rootInstanceId: 7 }, SELF)).toBe(false);
  });

  it('isDerivedMember: a member, or an OWNED root — but never a keyed node', () => {
    expect(isDerivedMember({ rootInstanceId: 7 }, SELF, '')).toBe(true);                     // member
    expect(isDerivedMember({ rootInstanceId: SELF, parentLocalId: 3 }, SELF, '')).toBe(true); // owned root
    expect(isDerivedMember({ rootInstanceId: SELF, parentLocalId: 0 }, SELF, '')).toBe(false); // stored root
    expect(isDerivedMember(null, SELF, '')).toBe(false);
    // ⚠️ A keyed node derives by its KEY, not through its instance (#1387) — so it is not one of these.
    expect(isDerivedMember({ rootInstanceId: 7 }, SELF, 'k')).toBe(false);
  });

  it('entityStep picks the key over the localId, and agrees with both producers', () => {
    expect(entityStep({ localId: 5 }, '')).toBe(memberStepId({ localId: 5 }));
    expect(entityStep({ localId: 5 }, 'k')).toBe(addedKeyStep('k'));
    // A nested-instance root steps by parentLocalId, not its (shared) inner localId.
    expect(entityStep({ localId: 1, parentLocalId: 9 }, '')).toBe(9);
    expect(entityStep(null, '')).toBe(0);
  });
});

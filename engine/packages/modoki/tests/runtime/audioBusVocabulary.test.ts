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
import { callsTo, calleeName, declarationOf, enclosingFunction, findNodes, lineOf, parseSource, ts, unwrapValue } from '../helpers/sourceAst';

const SRC = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/runtime/audio/audioService.ts',
);

/** ⚠️ **Every verdict below is read from the parse, per call (#1179).** The first version judged a
 *  call by its LINE (`SAFE_ARG` over the trimmed text, so a second `busNode(` on that line was judged
 *  by the first's argument), let its one bare-`bus` exception be an exact line of text, and proved
 *  that exception's refusal with a whole-file regex any other function's `hasDocKey` satisfied. The
 *  `journalAudio` half below used a hand-balanced paren scan — a private tokenizer — and a
 *  whole-file `const bus = resolveBus(…)` regex to vouch for a shorthand `{ bus }` in a different
 *  function. Reads go through `readScannedSource` per #812 either way: a guard matching RAW text lets
 *  a COMMENT hide an offender or satisfy an assertion. */

const isCallTo = (e: ts.Expression | undefined, name: string): boolean => {
  const u = e && unwrapValue(e);
  return !!u && ts.isCallExpression(u) && calleeName(u) === name;
};

/** The literal buses a code path may name directly. */
const BUS_LITERALS = new Set(['master', 'music', 'sfx', 'ui']);

/**
 * True when `arg` is a PARAMETER of the function the call runs in, and that function's body refuses
 * it before the call: a statement earlier in the same body is `if (!hasDocKey(busVolumes, <that
 * parameter>)) { … return …; }`. Resolved by symbol, so a same-named `bus` refused somewhere else
 * does not count.
 *
 * ⚠️ The first version of the bare-identifier rule allowed ANY bare `bus`, meant as room for
 * `setBusVolume`. It let EVERY site pass a bare `bus`, so un-normalising the video caller kept this
 * suite green: the guard permitted exactly the defect it was written for. Hence "refused first", not
 * "is an identifier".
 */
function refusedBeforeCall(call: ts.CallExpression, arg: ts.Expression): boolean {
  const u = unwrapValue(arg);
  if (!ts.isIdentifier(u)) return false;
  const param = declarationOf(u);
  if (!param || !ts.isParameter(param) || !ts.isFunctionDeclaration(param.parent) || !param.parent.body) return false;
  const body = param.parent.body;
  let stmt: ts.Node = call;
  while (stmt.parent && stmt.parent !== body) stmt = stmt.parent;
  if (stmt.parent !== body) return false; // the call is not in this function's own body
  const at = body.statements.indexOf(stmt as ts.Statement);
  return body.statements.slice(0, at).some((s) => {
    if (!ts.isIfStatement(s)) return false;
    const test = unwrapValue(s.expression);
    if (!ts.isPrefixUnaryExpression(test) || test.operator !== ts.SyntaxKind.ExclamationToken) return false;
    const check = unwrapValue(test.operand);
    if (!ts.isCallExpression(check) || calleeName(check) !== 'hasDocKey' || check.arguments.length !== 2) return false;
    // The TABLE matters as much as the key: `hasDocKey(someOtherTable, bus)` refuses nothing about
    // buses (#1179 P1 review — the first cut never read this argument).
    // By SYMBOL: the module-level `busVolumes`, not any local spelled alike.
    const table = unwrapValue(check.arguments[0]!);
    const tableDecl = ts.isIdentifier(table) ? declarationOf(table) : undefined;
    if (!tableDecl || !ts.isVariableDeclaration(tableDecl) || !ts.isIdentifier(tableDecl.name)
      || tableDecl.name.text !== 'busVolumes' || !ts.isSourceFile(enclosingFunction(tableDecl))) return false;
    const refused = unwrapValue(check.arguments[1]!);
    if (!ts.isIdentifier(refused) || declarationOf(refused) !== param) return false;
    const then = s.thenStatement;
    return ts.isReturnStatement(then) || (ts.isBlock(then) && then.statements.some(ts.isReturnStatement));
  });
}

/** Every `busNode(…)` CALL with how its bus argument is made safe, or `'unsafe'`. The declaration
 *  is not a call and is not listed. */
function busNodeCallSites(code: string, label: string): Array<{ line: number; text: string; verdict: 'resolved' | 'literal' | 'refused-first' | 'unsafe' }> {
  const sf = parseSource(code, label);
  return callsTo(sf, 'busNode').map((c) => {
    const bus = c.arguments[1];
    const lit = bus && unwrapValue(bus);
    const verdict = isCallTo(bus, 'resolveBus') ? 'resolved'
      : lit && ts.isStringLiteralLike(lit) && BUS_LITERALS.has(lit.text) ? 'literal'
        : bus && refusedBeforeCall(c, bus) ? 'refused-first' : 'unsafe';
    return { line: lineOf(c), text: c.getText(sf).replace(/\s+/g, ' '), verdict };
  });
}

describe('busNode callers normalise (#993)', () => {
  const sites = busNodeCallSites(readScannedSource(SRC).code, 'audioService.ts');

  it('the scan finds call sites at all — a vacuous pass is a failure', () => {
    // Without this, renaming `busNode` makes every rule below pass over an empty list.
    expect(sites.length).toBeGreaterThanOrEqual(3);
  });

  it('every call site passes a normalised or literal bus, or refuses an unknown one first', () => {
    expect(
      sites.filter((s) => s.verdict === 'unsafe').map((s) => `audioService.ts:${s.line} ${s.text}`),
      'busNode is passed an unnormalised bus. Wrap it in resolveBus(), or refuse the unknown bus before '
      + 'the call as setBusVolume does. `AudioSource.bus` and `VideoPlayer.bus` are both declared as a '
      + 'union by a CAST on a default, so the value reaching here is an unchecked string from scene JSON (#993).',
    ).toEqual([]);
  });

  it('every call site is accounted for — a fourth caller is not silently allowed', () => {
    expect(
      sites.map((s) => s.verdict),
      `busNode gained or lost a caller (${sites.length} now). Check it normalises, then update this list `
      + '— do not just widen it.',
    ).toEqual(['resolved', 'refused-first', 'resolved']);
  });

  it('the detector judges each call by ITS OWN argument and refusal (#1179)', () => {
    const src = [
      "const busVolumes = {}; busNode(g, resolveBus(a)); busNode(g, bus); busNode(g, 'sfx'); busNode(g, 'nope');",
      'function setBusVolume(bus: string) {',
      '  if (!hasDocKey(busVolumes, bus)) { return false; }',
      '  busNode(',
      '    g,',
      '    bus,',
      '  );',
      '}',
      'function other(bus: string) { busNode(g, bus); }',
      'function late(bus: string) { busNode(g, bus); if (!hasDocKey(busVolumes, bus)) return false; }',
      'function shadow(bus: string) { if (!hasDocKey(busVolumes, bus)) return false; { const bus = raw; busNode(g, bus); } }',
      'function wrongTable(bus: string) { if (!hasDocKey(otherTable, bus)) return false; busNode(g, bus); }',
      'function shadowTable(bus: string) { const busVolumes = otherTable; if (!hasDocKey(busVolumes, bus)) return false; busNode(g, bus); }',
    ].join('\n');
    expect(busNodeCallSites(src, 'a.ts').map((s) => `${s.line}:${s.verdict}`)).toEqual([
      '1:resolved', '1:unsafe', '1:literal', '1:unsafe', '4:refused-first', '9:unsafe', '10:unsafe', '11:unsafe', '12:unsafe', '13:unsafe',
    ]);
  });
});

// ── audioSystem.ts — every `@audio` journal emission that reports a bus RESOLVES it (#1069) ──────

const SYSTEM_SRC = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/runtime/audio/audioSystem.ts',
);

/**
 * Every `bus` field inside a `journalAudio(…)` CALL's arguments — a nested literal or a spread's
 * literal included — and whether its value is resolved: `bus: resolveBus(…)`, or a `{ bus }`
 * shorthand whose OWN binding (by symbol) was initialised from `resolveBus(…)`. A function inside the
 * arguments is not this call's payload and is not walked.
 */
function journalAudioBusFields(code: string, label: string): Array<{ line: number; text: string; resolved: boolean }> {
  const sf = parseSource(code, label);
  return callsTo(sf, 'journalAudio').flatMap((c) => c.arguments.flatMap((arg) =>
    findNodes(arg, (n): n is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
      (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) && ts.isIdentifier(n.name) && n.name.text === 'bus'
      && !ts.isFunctionLike(findAncestorWithin(n, arg)))
      .map((p) => {
        let resolved: boolean;
        if (ts.isPropertyAssignment(p)) resolved = isCallTo(p.initializer, 'resolveBus');
        else {
          // A `const` only: `let bus = resolveBus(x); bus = raw;` keeps the initialiser and loses the
          // value (#1179 P1 review).
          const decl = declarationOf(p.name);
          resolved = !!decl && ts.isVariableDeclaration(decl) && ts.isVariableDeclarationList(decl.parent)
            && (decl.parent.flags & ts.NodeFlags.Const) !== 0 && isCallTo(decl.initializer, 'resolveBus');
        }
        return { line: lineOf(c), text: p.getText(sf), resolved };
      })));
}

/** The nearest function-like ancestor of `n` strictly inside `root`, or `root` itself when none. */
function findAncestorWithin(n: ts.Node, root: ts.Node): ts.Node {
  for (let cur = n.parent; cur && cur !== root; cur = cur.parent) if (ts.isFunctionLike(cur)) return cur;
  return root;
}

describe('audioSystem journals the RESOLVED bus on every emission (#1069)', () => {
  // The behavioural half — one case per path, each proven by reverting its call site — is in
  // vocabWiringReaches.test.ts and audioCueRetry.test.ts. This is the POPULATION half: a fifth
  // emission path written with a raw bus has no behavioural test yet, and this is what reds on it.
  const fields = journalAudioBusFields(readScannedSource(SYSTEM_SRC).code, 'audioSystem.ts');

  it('the scan finds bus-carrying emissions at all — a vacuous pass is a failure', () => {
    expect(fields.length).toBeGreaterThanOrEqual(5);
  });

  it('every emission that reports a bus passes it through resolveBus()', () => {
    expect(
      fields.filter((f) => !f.resolved).map((f) => `audioSystem.ts:${f.line} ${f.text}`),
      'An `@audio` journal event reports a bus that did not go through resolveBus(). The graph plays '
      + 'an unrecognised bus on sfx, so a raw field makes the journal disagree with what was heard — '
      + 'and the journal is what QA and agents assert on (#993 § 2d, #1069).',
    ).toEqual([]);
  });

  it('every emission is covered — a sixth is not silently allowed', () => {
    expect(
      fields.length,
      `audioSystem.ts gained a bus-carrying journalAudio call (${fields.length} now). Give it a `
      + 'behavioural case in vocabWiringReaches.test.ts, then update this number.',
    ).toBe(5);
  });

  it('the detector reads a wrapped payload, and a shorthand is vouched for only by ITS OWN binding (#1179)', () => {
    const src = [
      'function start(spec: S) {',
      '  journalAudio(world, "start", e, {',
      '    clip: spec.clip,',
      '    bus: resolveBus(spec.bus),',
      '  });',
      '}',
      'function steal(spec: S) { const bus = resolveBus(spec.bus); journalAudio(world, "stolen", undefined, { bus }); }',
      'function raw(spec: S) { const bus = spec.bus; journalAudio(world, "x", undefined, { ...(r ? { bus } : {}) }); }',
      'function paren(spec: S) { journalAudio(world, ")", undefined, { bus: spec.bus }); }',
      'function cb(spec: S) { journalAudio(world, "x", undefined, {}, () => ({ bus: spec.bus })); }',
      'function reassigned(spec: S) { let bus = resolveBus(spec.bus); bus = spec.bus; journalAudio(world, "x", undefined, { bus }); }',
    ].join('\n');
    expect(journalAudioBusFields(src, 'a.ts').map((f) => `${f.line}:${f.resolved}`)).toEqual(['2:true', '7:true', '8:false', '9:false', '11:false']);
  });
});

/** F15 (docs/enact.md) — the load-bearing rule from `screenPick.ts`'s header: a pick
 *  provider must call the SAME code path its surface's own pointer handler runs, never a second,
 *  independently-written raycast that merely happens to agree today. That rule can't be checked
 *  by driving SceneView (it needs a live WebGPU/Pixi viewport, which is not available headlessly
 *  — see the report), so this is a SOURCE-level assertion instead: it reads the file and confirms
 *  the exact identifier registered via `registerPickProvider` is the exact identifier the pointer
 *  handler calls, for both the 3D viewport and the 2D chrome overlay. A vacuous version of this
 *  test (merely "the string registerPickProvider appears") would pass even if someone rewired the
 *  registration to a second, drifted implementation — so it pins the IDENTIFIER match, not just
 *  presence. Still not a substitute for a live pick-vs-select-outcome check; see the plan's own
 *  test list for what remains a live-editor verification. */
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readScannedSource } from '../helpers/sourceScanner';
import { callsTo, calleeName, declarationOf, enclosingNamedFunction, functionBodyOf, functionsNamed, isBlock, parseSource, printedText, siteText, stringValueOf, ts } from '../helpers/sourceAst';

const here = dirname(fileURLToPath(import.meta.url));
const sceneView = parseSource(readScannedSource(join(here, '../../src/editor/panels/SceneView.tsx')).code, 'SceneView.tsx');

/** The named functions `n` sits in, outermost first — `ThreeJSViewport > install` — or `<module>`. */
function namedPath(n: ts.Node): string {
  const out: string[] = [];
  for (let f = enclosingNamedFunction(n); f; f = enclosingNamedFunction(f.node)) out.unshift(f.name);
  return out.join(' > ') || '<module>';
}

interface PickWiring {
  provider: string;
  /** The #80 priority argument as written, or `undefined` for the implicit default. */
  priority: string | undefined;
  registeredIn: string;
  /** Every call in the file to the SAME function the registration hands over — resolved by the file's
   *  own scopes, not by name, so the 2D picker's callers are not the 3D picker's — as
   *  `<where>(<args>)`. */
  calledFrom: string[];
}

/**
 * Every `registerPickProvider(<fn>, 'scene-view'[, priority])` call in `sf`, with where it is registered
 * and who else calls the very function it registers.
 *
 * ⚠️ **The provider must be a BARE name of a function** (`function f`, or `const f = (…) => …`) — NOT an inline arrow (which would
 * defeat this test: it could no longer prove the registered function IS the one the pointer handler
 * calls), and not a wrapper. Anything else fails here, by its site.
 *
 * From the parser (#1195). The file used to be read raw and cut by text: the 3D handler was the 800
 * characters after `function onPointerDown(event: PointerEvent)`, and the 2D and UI scopes ran from
 * `function <name>(` to the next `'\nfunction '`. So a call left behind in a COMMENT passed, a call
 * past character 800 failed, and both 2D and 3D pickers — which share one name — were told apart only
 * by which slice a regex happened to run over.
 */
function pickWiring(sf: ts.SourceFile): PickWiring[] {
  return callsTo(sf, 'registerPickProvider').filter((reg) => stringValueOf(reg.arguments[1]) === 'scene-view').map((reg) => {
    const arg = reg.arguments[0];
    const id = arg && ts.isIdentifier(arg) ? arg : undefined;
    const decl = id && declarationOf(id);
    const fn = decl && (ts.isVariableDeclaration(decl) ? decl.initializer : decl);
    expect(functionBodyOf(fn), `${siteText(reg)}: the provider is not a bare name of a function`)
      .toBeDefined();
    return {
      provider: id!.text,
      priority: reg.arguments[2] && printedText(reg.arguments[2]),
      registeredIn: namedPath(reg),
      calledFrom: callsTo(sf, id!.text)
        .filter((c) => ts.isIdentifier(c.expression) && declarationOf(c.expression) === decl)
        .map((c) => `${namedPath(c)}(${c.arguments.map(printedText).join(', ')})`),
    };
  });
}

/** #1576 — where, in a pick function's top-level statements, the reach gate sits:
 *  `if (!pressReachesCanvas(renderer.domElement, …)) return null;`, exactly — a condition that is
 *  anything more than that negated call (`false && !…`) is not the gate. `answeredBefore` is true
 *  when a statement ahead of it could already answer: anything other than a `const`, or an `if`
 *  whose only outcome is `return null`. -1 when there is no gate at all. */
function reachGate(fn: ts.Node): { at: number; answeredBefore: boolean } {
  const body = functionBodyOf(fn);
  if (!body || !isBlock(body)) return { at: -1, answeredBefore: false };
  const returnsNull = (st: ts.Statement): boolean => {
    const inner = ts.isBlock(st) && st.statements.length === 1 ? st.statements[0] : st;
    return ts.isReturnStatement(inner) && inner.expression?.kind === ts.SyntaxKind.NullKeyword;
  };
  // The gate must ask about THIS press: exactly (renderer.domElement, <x param>, <y param>) — an
  // extra argument (an injected `elementAt`) or constant coordinates make it answer for some other
  // point, and each was green under the first version of this reader (close-out §2d review).
  const params = ts.isFunctionLike(fn) ? (fn as ts.SignatureDeclaration).parameters.map((p) => p.name.getText()) : [];
  const isGate = (st: ts.Statement): boolean => {
    if (!ts.isIfStatement(st) || st.elseStatement || !returnsNull(st.thenStatement)) return false;
    const c = st.expression;
    if (!ts.isPrefixUnaryExpression(c) || c.operator !== ts.SyntaxKind.ExclamationToken) return false;
    const call = c.operand;
    return ts.isCallExpression(call) && calleeName(call) === 'pressReachesCanvas' && call.arguments.length === 3
      && printedText(call.arguments[0]) === 'renderer.domElement'
      && printedText(call.arguments[1]) === params[0] && printedText(call.arguments[2]) === params[1];
  };
  const at = body.statements.findIndex(isGate);
  // A `const pressReachesCanvas = () => true` ahead of the gate is a variable statement like any
  // other, so a name the gate calls must not be (re)declared there.
  const shadows = (st: ts.Statement) => ts.isVariableStatement(st)
    && st.declarationList.declarations.some((d) => d.name.getText() === 'pressReachesCanvas');
  const answeredBefore = body.statements.slice(0, Math.max(at, 0)).some((st) => shadows(st)
    || (!ts.isVariableStatement(st) && !(ts.isIfStatement(st) && !st.elseStatement && returnsNull(st.thenStatement))));
  return { at, answeredBefore };
}

describe('SceneView pick providers share the pointer handler\'s own code path', () => {
  // Read inside each test, so a registration it refuses fails the test that names it, not the file's collection.
  const wiring = (): PickWiring[] => pickWiring(sceneView);

  it('registers a BARE named function as the provider (not a second, inline implementation)', () => {
    // If this fails because a call site switched to an inline `(x, y) => { ... }` arrow, that IS
    // the regression this test exists to catch — a fresh raycast beside the real one, not the SAME
    // one, is exactly the false-guarantee `screenPick.ts` warns against. (`pickWiring` refuses it.)
    expect(wiring().map((w) => w.registeredIn)).toEqual(['installScene2DInteraction', 'UIEditorOverlay', 'ThreeJSViewport > install']);
  });

  it('the 3D-viewport registration and its onPointerDown call the SAME function', () => {
    // The 3D onPointerDown (selection raycast) must call it — not recompute entries itself.
    expect(wiring()).toContainEqual({
      provider: 'pickEntityAtViewportPoint', priority: undefined, registeredIn: 'ThreeJSViewport > install',
      calledFrom: ['ThreeJSViewport > install > onPointerDown(event.clientX, event.clientY)'],
    });
  });

  it('the 2D chrome overlay\'s registration and its onPointerDown call the SAME function', () => {
    // Resolved by scope: there is an UNRELATED `onPointerDown(e: PointerEvent)` earlier in the file
    // (a panel-pan handler, in `SceneView`) with no picking in it at all, and the 3D picker shares
    // this one's name. Priority 10 (#80) — the 2D overlay must win over the 3D viewport when both answer.
    expect(wiring()).toContainEqual({
      provider: 'pickEntityAtViewportPoint', priority: '10', registeredIn: 'installScene2DInteraction',
      calledFrom: ['installScene2DInteraction > onPointerDown(e.clientX, e.clientY)'],
    });
  });

  it('#1576 — the 3D pick withholds a press another canvas takes, before anything can answer', () => {
    // The Canvas2D pick overlay absorbs a press it misses; the 3D viewport never sees it, so its
    // pick must not predict one — and a real press on the 3D canvas always passes (pickReach.ts).
    // Pinned in SOURCE because the function lives in a mount effect no headless test can drive:
    // weakening it (`false && !…`) left every behavioural test green (close-out review).
    const threeD = functionsNamed(sceneView, 'pickEntityAtViewportPoint').find((f) => namedPath(f) === 'ThreeJSViewport > install');
    expect(reachGate(threeD!)).toEqual({ at: expect.any(Number), answeredBefore: false });
    expect(reachGate(threeD!).at).toBeGreaterThanOrEqual(0);
  });

  it('the reach-gate reader accepts only the real gate, ahead of every answer', () => {
    const gateOf = (body: string) => reachGate(functionsNamed(parseSource(`function pick(x, y) { ${body} }`, 'probe.tsx'), 'pick')[0]);
    const gate = 'if (!pressReachesCanvas(renderer.domElement, x, y)) return null;';
    expect(gateOf(`const r = 1; if (x < 0) return null; ${gate} return 7;`)).toEqual({ at: 2, answeredBefore: false });
    expect(gateOf(`if (false && !pressReachesCanvas(renderer.domElement, x, y)) return null; return 7;`).at).toBe(-1);
    expect(gateOf(`if (!pressReachesCanvas(other, x, y)) return null; return 7;`).at).toBe(-1);
    expect(gateOf(`if (!pressReachesCanvas(renderer.domElement, x, y)) return 3; return 7;`).at).toBe(-1);
    expect(gateOf(`if (hit) return 5; ${gate} return 7;`)).toEqual({ at: 1, answeredBefore: true });
    expect(gateOf('return 7;').at).toBe(-1);
    // Sabotage the first reader let through: an injected hit-test, fixed coordinates, a shadow.
    expect(gateOf('if (!pressReachesCanvas(renderer.domElement, x, y, () => null)) return null; return 7;').at).toBe(-1);
    expect(gateOf('if (!pressReachesCanvas(renderer.domElement, -1, -1)) return null; return 7;').at).toBe(-1);
    expect(gateOf(`const pressReachesCanvas = () => true; ${gate} return 7;`).answeredBefore).toBe(true);
  });

  it('there is exactly ONE definition of `pickEntityAtViewportPoint` per scope (2D and 3D) — no drifted duplicate', () => {
    // One inside installScene2DInteraction (2D), one inside the ThreeJSViewport setup (3D). A THIRD —
    // in any form, a `const` arrow or a method included — would mean somebody pasted a divergent copy.
    expect(functionsNamed(sceneView, 'pickEntityAtViewportPoint').map(namedPath)).toEqual(['installScene2DInteraction', 'ThreeJSViewport > install']);
  });

  // #337 — the "ui" preview mode's paint-order arbiter (`resolvePreviewPickAt`, `uiPreviewPick.ts`)
  // is a THIRD picture of the same rule: it must be both the registered pick provider (so
  // `modoki_tap` prediction agrees with a real click) AND the function driving the capture-phase
  // pointerdown handler that redirects a real click — otherwise the two could disagree and #337
  // would just move from real clicks to synthetic taps instead of being fixed.
  it('the "ui" preview arbiter is registered at a higher priority than the 2D overlay', () => {
    expect(wiring().filter((w) => w.provider === 'resolvePreviewPickAt').map((w) => w.priority)).toEqual(['20']);
  });

  it('the "ui" preview arbiter\'s pointerdown handler calls the SAME function as its registration', () => {
    expect(wiring()).toContainEqual({
      provider: 'resolvePreviewPickAt', priority: '20', registeredIn: 'UIEditorOverlay',
      calledFrom: ['UIEditorOverlay > onPointerDownCapture(e.clientX, e.clientY)'],
    });
  });

  it('resolves the provider by scope, and refuses one it cannot name (#1195)', () => {
    const probe = (src: string) => pickWiring(parseSource(src, 'probe.tsx'));
    // Two same-named pickers: each registration is credited only with ITS function's callers, and a
    // commented-out call is no call.
    expect(probe([
      'function a() { function pick(x, y) {} function onDown(e) { pick(e.x, e.y); } registerPickProvider(pick, \'scene-view\', 10); }',
      'function b() { function pick(x, y) {} function onDown(e) { /* pick(e.x, e.y); */ } registerPickProvider(pick, \'scene-view\'); }',
    ].join('\n'))).toEqual([
      { provider: 'pick', priority: '10', registeredIn: 'a', calledFrom: ['a > onDown(e.x, e.y)'] },
      { provider: 'pick', priority: undefined, registeredIn: 'b', calledFrom: [] },
    ]);
    // Another surface is not this one.
    expect(probe('function pick() {}\nregisterPickProvider(pick, \'game-view\');')).toEqual([]);
    // An inline implementation, and a wrapped one — but a name bound to an arrow is a named function.
    expect(() => probe('registerPickProvider((x, y) => null, \'scene-view\');')).toThrow(/not a bare name/);
    expect(() => probe('function pick() {}\nregisterPickProvider(withLog(pick), \'scene-view\');')).toThrow(/not a bare name/);
    expect(() => probe('function pick() {}\nregisterPickProvider(pick.bind(null), \'scene-view\');')).toThrow(/not a bare name/);
    expect(probe('const pick = (x, y) => null;\nregisterPickProvider(pick, \'scene-view\');').map((w) => w.provider)).toEqual(['pick']);
    expect(() => probe('const pick = withLog((x, y) => null);\nregisterPickProvider(pick, \'scene-view\');')).toThrow(/not a bare name/);
  });
});

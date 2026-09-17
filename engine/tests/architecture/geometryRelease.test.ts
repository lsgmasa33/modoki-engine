/** Guard: a Pixi `Geometry` is torn down in exactly ONE place — `releaseGeometry` in
 *  `Scene2D.tsx`.
 *
 *  WHY. PixiJS 8.19.0's `Geometry.destroy()` calls `removeAllListeners()` BEFORE it calls
 *  `unload()`, tearing off the `"unload"` listener before it can fire. `gl.deleteVertexArray` is
 *  reachable ONLY through that listener — `GCManagedHash`'s `item.once("unload", this.remove,
 *  this)` registration, owned by `GlGeometrySystem`, is what reaches
 *  `GlGeometrySystem.onGeometryUnload`, the only `gl.deleteVertexArray` call site — so a bare
 *  `geo.destroy()`, even `destroy(true)`, permanently orphans a WebGL VAO. `destroy(true)`
 *  alone does not help: `buffers.forEach` still runs before `unload()` inside the same call.
 *  `Buffer`, `TextureSource`, `GraphicsContext` and `ViewContainer` all order `unload()` before
 *  `destroy()` correctly — `Geometry` is the one Pixi class that inverts it. The fix is
 *  `geo.unload()` BEFORE `geo.destroy(true)`, which is exactly what `releaseGeometry` does.
 *
 *  A new geometry-teardown site that calls `.destroy(` directly reintroduces the leak
 *  silently — nothing throws, the VAO just never frees — so this needs a static guard, not a
 *  runtime one.
 *
 *  THE RULE. No `.destroy(` call on a Pixi Geometry anywhere in `engine/packages/modoki/src/**`
 *  or `engine/app/**`, except inside `releaseGeometry`'s own body in Scene2D.tsx. Route the
 *  teardown through `releaseGeometry(geo)` instead. A `.destroy(` call's receiver is a Geometry
 *  when (see `geometryDestroys`):
 *  (1) its NAME looks like one (matches `/geometry|geo$/i`) — the identifier, or the last member
 *      of a chain (`mesh.geometry.destroy()`);
 *  (2) it is an identifier that RESOLVES to a `const/let/var X = <chain>.geometry` declaration —
 *      however many statements apart, and by the language's own scoping, so a same-named
 *      parameter or a local in another function is a different binding (#1241: this used to be a
 *      brace-counting scope simulator, which a `}` inside a string closed early);
 *  (3) it is the direct, un-assigned result of a geometry-returning builder (`buildMaterialQuad`,
 *      `buildTextGeometryByPage`).
 *
 *  ⚠️ WHAT THIS DOES NOT CATCH — stated plainly because a guard whose comment overclaims is worse
 *  than one that states its edge; the next reader trusts the comment. It resolves one binding by
 *  name, with no type information, so it MISSES:
 *   - a geometry reached through an array/collection element (`meshes.map(m => m.geometry)` then
 *     `.forEach(g => g.destroy())` — the destroyed value was never bound by a `const/let/var …
 *     = X.geometry` declaration);
 *   - a geometry stored on `this` under a name that does not look like one (`this.quad =
 *     buildMaterialQuad(...); this.quad.destroy(true)` — rule (2) follows local bindings only);
 *   - a geometry bound by assignment rather than declaration (`let g; g = m.geometry`);
 *   - a destroy reached through a wrapper helper (`function freeGeo(g2) { g2.destroy(true) }` —
 *     the call site that matters is the CALLER of `freeGeo`, invisible from here).
 *  Do not extend this guard to chase those without a design discussion — they need real type
 *  information, not another rule. */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';
import {
  accessPath, calleeName, callsTo, declarationOf, findNodes, functionsNamed, lineOf, parseSource,
  unwrapValue, ts,
} from '@modoki/engine/testing/sourceAst';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const roots = [
  path.resolve(__dirname, '../../packages/modoki/src'),
  path.resolve(__dirname, '../../app'),
];

const HELPER_FILE = path.resolve(__dirname, '../../packages/modoki/src/runtime/rendering/Scene2D.tsx');
const HELPER_NAME = 'releaseGeometry';
// Name-based: catches `geo.destroy()`, `myGeometry.destroy()`, `mesh.geometry.destroy()` (the
// receiver's last name is "geometry"). Deliberately NOT a bare `^g$` — this codebase names plenty
// of unrelated `Graphics` locals `g` (e.g. `colliderOverlays`), and a Graphics.destroy() is a
// legitimate bare call (ViewContainer orders unload-before-destroy correctly; it's Geometry alone
// that inverts it). A short-named local actually holding a Geometry (the original bug used
// `const g = m.geometry`) is caught by rule (2) instead.
const GEOMETRY_NAME = /geometry|geo$/i;
const GEOMETRY_BUILDERS = new Set(['buildMaterialQuad', 'buildTextGeometryByPage']);

/** Every `.ts`/`.tsx` under `roots`, via the shared corpus producer (#799/#771/#805 Phase 4).
 *  Floored well under the 855 measured today. */
function sourceFiles() {
  return repoFiles({ under: roots, match: /\.tsx?$/, floor: 600 });
}

/** Every `x.destroy(…)` / `x?.destroy(…)` call in `root`, with its receiver's value (wrappers peeled). */
function destroyCalls(root: ts.Node): Array<{ call: ts.CallExpression; receiver: ts.Expression }> {
  return callsTo(root, 'destroy').flatMap((call) => {
    const callee = unwrapValue(call.expression);
    return ts.isPropertyAccessExpression(callee) ? [{ call, receiver: unwrapValue(callee.expression) }] : [];
  });
}

/** The name `receiver` is known by for rule (1): an identifier, or a chain's last member. */
function receiverName(receiver: ts.Expression): string | undefined {
  if (ts.isIdentifier(receiver)) return receiver.text;
  if (ts.isPropertyAccessExpression(receiver) && ts.isIdentifier(receiver.name)) return receiver.name.text;
  return undefined;
}

/** A `const/let/var X = <chain>.geometry` declaration — rule (2)'s binding. */
function isGeometryBinding(d: ts.Node | undefined): d is ts.VariableDeclaration {
  return !!d && ts.isVariableDeclaration(d) && !!d.initializer && readsGeometry(d.initializer);
}

/** An expression whose value is a `.geometry` read: the read itself, either side of `??`/`||`/`&&`,
 *  a `? :` arm, or its `.clone()` (still a Geometry). The regex this replaced matched any initializer
 *  that STARTED with `<chain>.geometry`, so these all counted (#1241 close-out review). */
function readsGeometry(e: ts.Expression): boolean {
  const u = unwrapValue(e);
  if (/(^|\.)geometry$/.test(accessPath(u) ?? '')) return true;
  if (ts.isBinaryExpression(u)) {
    const op = u.operatorToken.kind;
    if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) return readsGeometry(u.left) || readsGeometry(u.right);
    // `a && b` is `a` only when `a` is falsy, and a geometry never is — so only the right side is the value.
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return readsGeometry(u.right);
  }
  if (ts.isConditionalExpression(u)) return readsGeometry(u.whenTrue) || readsGeometry(u.whenFalse);
  return ts.isCallExpression(u) && calleeName(u) === 'clone' && ts.isPropertyAccessExpression(u.expression)
    && readsGeometry(u.expression.expression);
}

/**
 * Every `.destroy(` call in `sf` whose receiver is a Pixi Geometry by one of the three rules in the
 * file docblock, in source order.
 *
 * Rule (2) resolves the receiver through the file's own scopes (`declarationOf`), which is what keeps
 * two same-named locals in two scopes — one a Geometry, one a `Graphics`, or a parameter shadowing a
 * geometry local — from vouching for each other. The checker is built only for a file that declares a
 * geometry binding under the receiver's name at all, which is a handful of the ~850.
 */
function geometryDestroys(sf: ts.SourceFile): ts.CallExpression[] {
  const calls = destroyCalls(sf);
  if (calls.length === 0) return [];
  const boundNames = new Set(findNodes(sf, isGeometryBinding)
    .flatMap((d) => (ts.isIdentifier(d.name) ? [d.name.text] : [])));
  return calls.filter(({ receiver }) => {
    const name = receiverName(receiver);
    if (name !== undefined && GEOMETRY_NAME.test(name)) return true;
    if (ts.isIdentifier(receiver) && boundNames.has(receiver.text) && isGeometryBinding(declarationOf(receiver))) return true;
    return ts.isCallExpression(receiver) && GEOMETRY_BUILDERS.has(calleeName(receiver) ?? '');
  }).map(({ call }) => call);
}

/** `geometryDestroys` over a snippet, as 1-based lines — the fixtures' view of the real classifier. */
function geometryDestroyLines(code: string): number[] {
  return geometryDestroys(parseSource(code, 'fixture.ts')).map(lineOf);
}

/** `releaseGeometry`'s one declaration in `sf` — the one place allowed to call `.destroy(` on a
 *  Geometry directly. */
function releaseGeometryIn(sf: ts.SourceFile): ts.FunctionLikeDeclaration & { body: ts.ConciseBody } {
  const decls = functionsNamed(sf, HELPER_NAME);
  if (decls.length !== 1) {
    throw new Error(`${HELPER_NAME} is declared ${decls.length} times in ${path.relative(process.cwd(), HELPER_FILE)} — `
      + 'did it move or get renamed? Update this guard alongside it.');
  }
  return decls[0]!;
}

function parsed(abs: string, rel: string): ts.SourceFile {
  return parseSource(readScannedSource(abs).code, rel);
}

describe('a Pixi Geometry is destroyed only through releaseGeometry (unload-before-destroy)', () => {
  it('no other .destroy( call touches a geometry-shaped identifier', () => {
    const offenders: string[] = [];
    for (const { abs, rel } of sourceFiles()) {
      const sf = parsed(abs, rel);
      const helper = abs === HELPER_FILE ? releaseGeometryIn(sf) : undefined;
      for (const call of geometryDestroys(sf)) {
        if (helper && ts.findAncestor(call, (n) => n === helper)) continue;
        offenders.push(`${rel}:${lineOf(call)}  ${call.getText(sf).replace(/\s+/g, ' ')}`);
      }
    }
    expect(
      offenders,
      'A bare `.destroy(` on a Pixi Geometry orphans its WebGL VAO — PixiJS 8.19.0 Geometry.destroy()\n'
      + 'tears off the "unload" listener before calling unload(), and gl.deleteVertexArray\n'
      + '(GlGeometrySystem.onGeometryUnload, the only call site) is reachable ONLY through that\n'
      + 'listener, via the item.once("unload", …) registration GCManagedHash owns.\n'
      + 'Route this through releaseGeometry(geo) in Scene2D.tsx instead — it calls unload() before\n'
      + 'destroy(true), which is the only correct order.\n\nOffending call sites:\n' + offenders.join('\n'),
    ).toEqual([]);
  });

  it(`${HELPER_NAME} itself still calls unload() before destroy(true)`, () => {
    const helper = releaseGeometryIn(parsed(HELPER_FILE, path.relative(process.cwd(), HELPER_FILE)));
    const unloads = callsTo(helper.body, 'unload').filter((c) => c.arguments.length === 0);
    const destroys = destroyCalls(helper.body).map(({ call }) => call);
    expect(unloads.length, `${HELPER_NAME} no longer calls unload()`).toBeGreaterThan(0);
    expect(destroys.some((c) => c.arguments.length === 1 && c.arguments[0]!.kind === ts.SyntaxKind.TrueKeyword),
      `${HELPER_NAME} no longer calls destroy(true)`).toBe(true);
    // Ordered against ANY destroy, not only destroy(true): a bare destroy() ahead of unload() orphans
    // the VAO just the same (#1181 close-out re-review, by mutation).
    expect(unloads[0]!.getStart(), `${HELPER_NAME} must call unload() BEFORE destroy() — Pixi orphans the VAO otherwise`)
      .toBeLessThan(destroys[0]!.getStart());
  });
});

// Unit cover for the classifier itself, against synthetic snippets rather than the real tree — a
// positive control (still catches the split-declaration shape the guard exists for) paired with the
// false positive a parameter/outer-local name collision used to produce.
describe('geometryDestroys — a receiver named like a geometry', () => {
  it('flags an identifier or a chain whose last member looks like a geometry', () => {
    expect(geometryDestroyLines('geo.destroy();\nmesh.geometry?.destroy(true);\nthis.quadGeometry.destroy();')).toEqual([1, 2, 3]);
  });

  it('does NOT flag a short or unrelated name with no geometry binding', () => {
    expect(geometryDestroyLines('g.destroy();\nmesh.geometry.buffer.destroy();\ngeoms[0].destroy();')).toEqual([]);
  });
});

describe('geometryDestroys — binding resolution', () => {
  it('still flags a captured-then-destroyed geometry split across statements (regression control)', () => {
    expect(geometryDestroyLines('const g = m.geometry; doOtherCleanup(); g.destroy();')).toEqual([1]);
  });

  it('does NOT flag an arrow parameter that merely shares a name with an outer geometry local', () => {
    // The exact false-positive shape found in review: `g` here is the OUTER geometry local, but
    // `overlays.forEach`'s own `g` is a Graphics-per-overlay parameter — an unrelated binding that
    // shadows the outer one for the whole span of its (brace-less) arrow body.
    expect(geometryDestroyLines('const g = m.geometry; releaseGeometry(g); overlays.forEach((g) => g.destroy());')).toEqual([]);
  });

  it('does NOT flag a same-named parameter shadowing a braced arrow body either', () => {
    expect(geometryDestroyLines('const g = m.geometry; releaseGeometry(g); overlays.forEach((g) => { g.destroy(); });')).toEqual([]);
  });

  it('still flags the outer geometry AFTER a shadowing arrow closes', () => {
    // Line 2: the shadowed call inside the arrow must NOT be flagged; the outer `g.destroy()`
    // after the arrow closes still refers to the geometry and MUST be.
    expect(geometryDestroyLines('const g = m.geometry; overlays.forEach((g) => { g.destroy(); });\ng.destroy();')).toEqual([2]);
  });

  it('does NOT flag a same-named local in ANOTHER function', () => {
    expect(geometryDestroyLines('function a() { const g = m.geometry; releaseGeometry(g); }\nfunction b() { const g = makeGraphics(); g.destroy(); }')).toEqual([]);
  });

  it('flags through a `?.`, a cast and a chain that ends in `.geometry`', () => {
    expect(geometryDestroyLines('const q = (mesh?.geometry as Geometry);\nq?.destroy();')).toEqual([2]);
    // A fallback, a guard and a clone of a geometry are still a geometry.
    expect(geometryDestroyLines('const a = mesh.geometry ?? fallback; a.destroy();\nconst b = m.geometry || null; b?.destroy();\nconst c = m.geometry.clone(); c.destroy();')).toEqual([1, 2, 3]);
    expect(geometryDestroyLines('const d = ready && m.geometry; d.destroy();\nconst e = flag ? m.geometry : other; e.destroy();')).toEqual([1, 2]);
    // The LEFT side of `&&` is never the value.
    expect(geometryDestroyLines('const idx = m.geometry && m.geometry.indexBuffer; idx.destroy();')).toEqual([]);
    // A binding of something READ off a geometry is not a geometry.
    expect(geometryDestroyLines('const a = mesh.geometry.attributes; a.destroy();')).toEqual([]);
  });

  it('keeps a scope when a string holds a closing brace (#1241 — the brace-counting simulator closed it early)', () => {
    // The old frame stack popped at the `'}'`, looked `g` up in the file scope, found nothing and
    // passed this. Observed red against the old reader before the migration.
    expect(geometryDestroyLines("function a() {\n  const g = m.geometry;\n  log('}');\n  g.destroy();\n}")).toEqual([4]);
  });
});

// The builder rule had no cover of its own, and a clean tree holds no instance of the shape — so a
// matcher that stopped matching would green the sweep above indistinguishably (#1105). No real-corpus
// control exists to pair with it: the helper's own `g.destroy(true)` is NOT matched (a `g` parameter
// is neither geometry-named nor a `.geometry` binding), so nothing is exempted today.
describe('geometryDestroys — a builder result destroyed inline', () => {
  it('flags a builder result destroyed inline, including through ?. and nested parens', () => {
    expect(geometryDestroyLines('buildMaterialQuad(1, 1, 0, 0).destroy(true);')).toEqual([1]);
    expect(geometryDestroyLines('x();\nbuildTextGeometryByPage(page, f(a, b))?.destroy();')).toEqual([2]);
  });

  it('flags one whose arguments hold a paren inside a string (#1241 — the paren count ended there)', () => {
    expect(geometryDestroyLines("buildMaterialQuad(1, ')').destroy(true);")).toEqual([1]);
  });

  it('does NOT flag a builder result that is kept, or released through the helper', () => {
    expect(geometryDestroyLines('const q = buildMaterialQuad(1, 1, 0, 0); releaseGeometry(q);')).toEqual([]);
    // A later `.destroy(` on a DIFFERENT receiver is not chained — only a call on the builder's
    // own result is.
    expect(geometryDestroyLines('const q = buildMaterialQuad(1, 1, 0, 0); q.destroy();')).toEqual([]);
    expect(geometryDestroyLines('mesh.geometry = buildMaterialQuad(w, h, 0, 0);')).toEqual([]);
    expect(geometryDestroyLines('buildMaterialQuad(1, 1, 0, 0).other().destroy();')).toEqual([]);
  });
});

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
 *  teardown through `releaseGeometry(geo)` instead. A Geometry is recognised three ways:
 *  (1) the callee identifier LOOKS like one (matches `/geometry|geo$/i`); (2) it was declared
 *  as `const/let/var X = <expr>.geometry` in the SAME lexical block as the `.destroy(` call, or
 *  an ancestor block of it — a declaration and its later `.destroy(` can be statements apart
 *  (e.g. captured then released after other cleanup runs), so this is NOT limited to one line,
 *  but it IS scoped per block, not per file: two unrelated locals named `g` in two different
 *  methods (one a Geometry, one a `Graphics`) must not cross-contaminate each other — including a
 *  function/arrow PARAMETER of the same name, which shadows an outer geometry local exactly like
 *  real JS scoping (registered on the frame its own body opens, braced or not); (3) it's the
 *  direct, un-assigned result of a geometry-returning builder (`buildMaterialQuad`,
 *  `buildTextGeometryByPage`) chained straight into `.destroy(`.
 *
 *  ⚠️ WHAT THIS DOES NOT CATCH — stated plainly because a guard whose comment overclaims is worse
 *  than one that states its edge; the next reader trusts the comment. It is a per-identifier,
 *  per-block heuristic, not a type checker, so it MISSES:
 *   - a geometry reached through an array/collection element (`meshes.map(m => m.geometry)` then
 *     `.forEach(g => g.destroy())` — the destroyed value was never bound by a `const/let/var …
 *     = X.geometry` declaration this scanner recognises);
 *   - a geometry stored on `this` (`this.quad = buildMaterialQuad(...); this.quad.destroy(true)` —
 *     no local identifier to track at all);
 *   - a destroy reached through a wrapper helper (`function freeGeo(g2) { g2.destroy(true) }` —
 *     the call site that matters is the CALLER of `freeGeo`, invisible from here).
 *  Do not extend this guard to chase those without a design discussion — they need either real
 *  type information or a bigger rewrite, not another regex. */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripComments, assertScanIsSane } from '@modoki/engine/testing';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const roots = [
  path.resolve(__dirname, '../../packages/modoki/src'),
  path.resolve(__dirname, '../../app'),
];

const HELPER_FILE = path.resolve(__dirname, '../../packages/modoki/src/runtime/rendering/Scene2D.tsx');
const HELPER_NAME = 'releaseGeometry';
// Name-based: catches `geo.destroy()`, `myGeometry.destroy()`, `mesh.geometry.destroy()` (the
// captured identifier is the property name, "geometry"). Deliberately NOT a bare `^g$` — this
// codebase names plenty of unrelated `Graphics` locals `g` (e.g. `colliderOverlays`), and a
// Graphics.destroy() is a legitimate bare call (ViewContainer orders unload-before-destroy
// correctly; it's Geometry alone that inverts it). A short-named local actually holding a
// Geometry (the original bug used `const g = m.geometry`) is caught below by scoped data flow.
const GEOMETRY_NAME = /geometry|geo$/i;
// Data-flow: any identifier declared as `const/let/var X = <expr>.geometry` is a Geometry
// regardless of what it's named — this is what catches a reintroduced
// `const quad = mesh.geometry; … mesh.destroy(); … quad.destroy();` split across statements,
// not just the single-line `const g = m.geometry; … g.destroy()` shape the original bug in
// Scene2D's `layoutHash` rebuild had. Applied with BLOCK scope (see findScopedGeometryDestroys below), not a
// single line or the whole file — a file-wide identifier set conflates an unrelated `g` (e.g. a
// `Graphics` local in `destroyColliderOverlay`) with a geometry declared under the same short
// name in a different method of the same file.
const GEOMETRY_DECL = /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*[A-Za-z_$][\w.]*?\.geometry\b/g;
// `?.` is optional between the identifier and `.destroy(` — `geo?.destroy()` is the exact shape
// this guard exists to catch (it was the bug before this fix).
const DESTROY_CALL = /\b([A-Za-z_$][A-Za-z0-9_$]*)\??\.destroy\s*\(/g;
// Builder-chain case: a geometry-returning builder's result destroyed inline, with no
// identifier for the two checks above to see at all — e.g.
// `buildMaterialQuad(1,1,0,0).destroy(true)`. Matched by bracket-depth walking from the
// builder's own `(` to its matching `)`, below, then checking what immediately follows.
const GEOMETRY_BUILDERS = ['buildMaterialQuad', 'buildTextGeometryByPage'];
const BUILDER_CALL = new RegExp(`\\b(?:${GEOMETRY_BUILDERS.join('|')})\\s*\\(`, 'g');
const CHAINED_DESTROY = /^\s*\??\.destroy\s*\(/;

// Function/arrow PARAMETERS are not `const/let/var` declarations, so `GEOMETRY_DECL` never saw
// them — an inner parameter of the SAME NAME as an outer geometry local used to resolve straight
// up to that outer decl instead of shadowing it: `const g = m.geometry; releaseGeometry(g);
// overlays.forEach((g) => g.destroy())` flagged the arrow's own, unrelated `g` (a false positive —
// the arrow's `g` is never a Geometry). Matched for BOTH a braced body (`(g) => { … }`,
// `function(g) { … }`, whose real `{` already opens a Frame below — the parameter is registered on
// that SAME frame) and a concise arrow body with no braces (`(g) => g.destroy()`, which has no `{`
// to hang a Frame off at all — a SYNTHETIC frame is opened right after `=>` and closed at the first
// depth-0 statement/argument boundary that follows, i.e. the natural end of a single expression).
const ARROW_PARAMS = /\(([^()]*)\)\s*=>\s*(\{)?/g;
const FUNCTION_PARAMS = /\bfunction\b(?:\s+[A-Za-z_$][\w$]*)?\s*\(([^()]*)\)\s*(\{)?/g;

/** Split a parameter list on TOP-LEVEL commas only — a destructured param (`{a, b}`) must not be
 *  split into two. */
function splitTopLevelParams(paramStr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of paramStr) {
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/** Plain identifier parameter names from a parameter-list string — skips destructuring patterns
 *  (the name-based `GEOMETRY_NAME` check still catches a plain `geo`/`geometry` param on its own)
 *  and strips a leading `...` (rest) or a trailing `= default`. */
function paramIdentifiers(paramStr: string): string[] {
  return splitTopLevelParams(paramStr)
    .map((p) => p.trim())
    .filter((p) => p && p[0] !== '{' && p[0] !== '[')
    .map((p) => p.replace(/^\.\.\./, '').split('=')[0].trim())
    .filter((p) => /^[A-Za-z_$][\w$]*$/.test(p));
}

/** Where a concise (brace-less) arrow body ends: the first depth-0 `,`/`;`, or the first closing
 *  bracket hit AT depth 0 — which belongs to whatever CONTAINS the arrow (e.g. the `)` that closes
 *  `.forEach(...)`), not to the body itself. Balanced brackets/parens/braces nested inside the body
 *  (a call, an object literal) are walked over, not stopped on. */
function conciseArrowBodyEnd(code: string, start: number): number {
  let depth = 0;
  for (let i = start; i < code.length; i++) {
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return i;
      depth--;
    } else if (depth === 0 && (c === ',' || c === ';')) return i;
  }
  return code.length;
}

interface ParamScope { frameIndex: number; synthetic: boolean; closeIndex: number; params: string[] }

/** Every function/arrow parameter list in `code`, with where its body's scope frame starts (and,
 *  for a brace-less arrow body, where the synthetic frame ends). Skips a param list with no plain
 *  identifiers to register (nothing to shadow). */
function findParamScopes(code: string): ParamScope[] {
  const scopes: ParamScope[] = [];
  for (const re of [ARROW_PARAMS, FUNCTION_PARAMS]) {
    re.lastIndex = 0;
    for (let m = re.exec(code); m; m = re.exec(code)) {
      const params = paramIdentifiers(m[1]);
      if (params.length === 0) continue;
      const bodyStart = m.index + m[0].length;
      if (m[2] === '{') {
        scopes.push({ frameIndex: bodyStart - 1, synthetic: false, closeIndex: -1, params }); // the `{` itself — a real open/close event already brackets it
      } else {
        scopes.push({ frameIndex: bodyStart, synthetic: true, closeIndex: conciseArrowBodyEnd(code, bodyStart), params });
      }
    }
  }
  return scopes;
}

/** Every `.ts`/`.tsx` under `roots`, via the shared corpus producer (#799/#771/#805 Phase 4).
 *  Floored well under the 855 measured today. */
function sourceFiles() {
  return repoFiles({ under: roots, match: /\.tsx?$/, floor: 600 });
}

/** The line range of `releaseGeometry`'s own body — the one place allowed to call `.destroy(`
 *  on a Geometry directly. Found by brace-counting on the STRIPPED source from the `function`
 *  keyword to the matching close. */
function helperLineRange(strippedSrc: string): [number, number] {
  const startIdx = strippedSrc.indexOf(`function ${HELPER_NAME}(`);
  if (startIdx < 0) {
    throw new Error(`${HELPER_NAME} not found in ${path.relative(process.cwd(), HELPER_FILE)} — `
      + 'did it move or get renamed? Update this guard alongside it.');
  }
  const bodyStart = strippedSrc.indexOf('{', startIdx);
  let depth = 0;
  let i = bodyStart;
  for (; i < strippedSrc.length; i++) {
    if (strippedSrc[i] === '{') depth++;
    else if (strippedSrc[i] === '}') { depth--; if (depth === 0) break; }
  }
  const startLine = strippedSrc.slice(0, bodyStart).split('\n').length;
  const endLine = strippedSrc.slice(0, i).split('\n').length;
  return [startLine, endLine];
}

function findAllMatches(re: RegExp, code: string): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(code); m; m = re.exec(code)) out.push(m);
  return out;
}

// `idents` maps a name to WHETHER its nearest binding is a geometry — `true` for a
// `const/let/var X = <expr>.geometry` decl, `false` for a function/arrow PARAMETER of the same
// name, which is a real binding (so it stops the search) but never a geometry.
type Frame = { parent: Frame | null; idents: Map<string, boolean> };

/** Every `.destroy(` call in `code` that targets a Pixi Geometry, as 1-based line numbers —
 *  either its callee name LOOKS like one, or it's an identifier declared
 *  `const/let/var X = <expr>.geometry` in the SAME lexical block as the call, or an ANCESTOR
 *  block of it (a real caller may capture-then-release several statements apart). Scope is
 *  walked with a brace-depth stack over the whole file: each `{`/`}` (real, or a SYNTHETIC pair
 *  for a brace-less arrow body — see `findParamScopes`) opens/closes a Frame, each declaration
 *  registers its identifier on the CURRENT (innermost) frame, and each `.destroy(` call looks the
 *  identifier up through its own frame and every ancestor, stopping at the NEAREST binding —
 *  exactly JS lexical scoping, which is what keeps two same-named locals in two different scopes
 *  (one a Geometry, one not — including a parameter shadowing an outer geometry local) from
 *  cross-contaminating. Braces are counted on the STRIPPED source (comments already removed)
 *  without string-literal awareness, matching `helperLineRange`'s existing approximation above —
 *  a `{`/`}` inside a string could misattribute scope, an accepted trade-off for a static guard
 *  over real source. */
function findScopedGeometryDestroys(code: string): number[] {
  const declMatches = findAllMatches(GEOMETRY_DECL, code);
  const destroyMatches = findAllMatches(DESTROY_CALL, code);
  const paramScopes = findParamScopes(code);

  type Event =
    | { index: number; kind: 'open' }
    | { index: number; kind: 'close' }
    | { index: number; kind: 'decl'; ident: string; geometry: boolean }
    | { index: number; kind: 'destroy'; ident: string; looksGeometry: boolean };

  const events: Event[] = [];
  for (let i = 0; i < code.length; i++) {
    if (code[i] === '{') events.push({ index: i, kind: 'open' });
    else if (code[i] === '}') events.push({ index: i, kind: 'close' });
  }
  for (const d of declMatches) events.push({ index: d.index, kind: 'decl', ident: d[1], geometry: true });
  for (const scope of paramScopes) {
    // A braced body's `{`/`}` were already pushed by the char scan above — only a brace-less
    // (synthetic) scope needs its OWN open/close pair. Either way the param decls land at
    // `frameIndex`, pushed AFTER the matching open so the stable sort keeps them inside the frame
    // the open just created, not the enclosing one.
    if (scope.synthetic) {
      events.push({ index: scope.frameIndex, kind: 'open' });
      events.push({ index: scope.closeIndex, kind: 'close' });
    }
    for (const p of scope.params) events.push({ index: scope.frameIndex, kind: 'decl', ident: p, geometry: false });
  }
  for (const m of destroyMatches) {
    events.push({ index: m.index, kind: 'destroy', ident: m[1], looksGeometry: GEOMETRY_NAME.test(m[1]) });
  }
  events.sort((a, b) => a.index - b.index);

  const root: Frame = { parent: null, idents: new Map() };
  let top = root;
  const offenderLines: number[] = [];

  for (const ev of events) {
    if (ev.kind === 'open') {
      top = { parent: top, idents: new Map() };
    } else if (ev.kind === 'close') {
      if (top.parent) top = top.parent;
    } else if (ev.kind === 'decl') {
      top.idents.set(ev.ident, ev.geometry);
    } else {
      let declaredAsGeometry = false;
      for (let f: Frame | null = top; f; f = f.parent) {
        if (f.idents.has(ev.ident)) { declaredAsGeometry = f.idents.get(ev.ident) === true; break; }
      }
      if (ev.looksGeometry || declaredAsGeometry) {
        offenderLines.push(code.slice(0, ev.index).split('\n').length);
      }
    }
  }
  return offenderLines;
}

/** 1-based line numbers where a geometry-returning builder's result is destroyed inline —
 *  `buildMaterialQuad(...).destroy(` / `buildTextGeometryByPage(...)?.destroy(` — with no
 *  intervening identifier assignment for `findScopedGeometryDestroys` to see. */
function findChainedBuilderDestroys(code: string): number[] {
  const lines: number[] = [];
  for (let m = BUILDER_CALL.exec(code); m; m = BUILDER_CALL.exec(code)) {
    const openParen = m.index + m[0].length - 1;
    let depth = 0;
    let i = openParen;
    for (; i < code.length; i++) {
      if (code[i] === '(') depth++;
      else if (code[i] === ')') { depth--; if (depth === 0) break; }
    }
    if (depth !== 0) continue; // unbalanced parens — malformed/unparseable, skip rather than false-positive
    if (CHAINED_DESTROY.test(code.slice(i + 1))) lines.push(code.slice(0, i + 1).split('\n').length);
  }
  return lines;
}

describe('a Pixi Geometry is destroyed only through releaseGeometry (unload-before-destroy)', () => {
  it('no other .destroy( call touches a geometry-shaped identifier', () => {
    const offenders: string[] = [];
    for (const { abs, rel } of sourceFiles()) {
      const raw = fs.readFileSync(abs, 'utf8');
      const code = stripComments(raw);
      assertScanIsSane(raw, code, rel);
      const isHelperFile = abs === HELPER_FILE;
      const [helperStart, helperEnd] = isHelperFile ? helperLineRange(code) : [-1, -1];
      const inHelper = (lineNo: number) => isHelperFile && lineNo >= helperStart && lineNo <= helperEnd;
      const codeLines = code.split('\n');

      const offenderLines = [
        ...findScopedGeometryDestroys(code),
        ...findChainedBuilderDestroys(code),
      ];
      for (const lineNo of offenderLines) {
        if (inHelper(lineNo)) continue;
        offenders.push(`${rel}:${lineNo}  ${codeLines[lineNo - 1].trim()}`);
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
    const raw = fs.readFileSync(HELPER_FILE, 'utf8');
    const code = stripComments(raw);
    assertScanIsSane(raw, code, path.relative(process.cwd(), HELPER_FILE));
    const [start, end] = helperLineRange(code);
    const body = code.split('\n').slice(start - 1, end).join('\n');
    expect(/\.unload\s*\(\s*\)/.test(body), `${HELPER_NAME} no longer calls unload()`).toBe(true);
    expect(/\.destroy\s*\(\s*true\s*\)/.test(body), `${HELPER_NAME} no longer calls destroy(true)`).toBe(true);
    expect(
      body.indexOf('.unload(') < body.indexOf('.destroy('),
      `${HELPER_NAME} must call unload() BEFORE destroy() — Pixi orphans the VAO otherwise`,
    ).toBe(true);
  });
});

// Unit cover for `findScopedGeometryDestroys` itself, against synthetic snippets rather than the
// real tree — a positive control (still catches the split-declaration shape the guard exists for)
// paired with the false positive a parameter/outer-local name collision used to produce.
describe('findScopedGeometryDestroys — parameter shadowing', () => {
  it('still flags a captured-then-destroyed geometry split across statements (regression control)', () => {
    const code = stripComments('const g = m.geometry; doOtherCleanup(); g.destroy();');
    expect(findScopedGeometryDestroys(code)).toEqual([1]);
  });

  it('does NOT flag an arrow parameter that merely shares a name with an outer geometry local', () => {
    // The exact false-positive shape found in review: `g` here is the OUTER geometry local, but
    // `overlays.forEach`'s own `g` is a Graphics-per-overlay parameter — an unrelated binding that
    // shadows the outer one for the whole span of its (brace-less) arrow body.
    const code = stripComments(
      'const g = m.geometry; releaseGeometry(g); overlays.forEach((g) => g.destroy());',
    );
    expect(findScopedGeometryDestroys(code)).toEqual([]);
  });

  it('does NOT flag a same-named parameter shadowing a braced arrow body either', () => {
    const code = stripComments(
      'const g = m.geometry; releaseGeometry(g); overlays.forEach((g) => { g.destroy(); });',
    );
    expect(findScopedGeometryDestroys(code)).toEqual([]);
  });

  it('still flags the outer geometry AFTER a shadowing arrow closes', () => {
    const code = stripComments(
      'const g = m.geometry; overlays.forEach((g) => { g.destroy(); }); g.destroy();',
    );
    // Line 1: the shadowed call inside the arrow must NOT be flagged; the outer `g.destroy()`
    // after the arrow closes still refers to the geometry and MUST be.
    expect(findScopedGeometryDestroys(code)).toEqual([1]);
  });
});

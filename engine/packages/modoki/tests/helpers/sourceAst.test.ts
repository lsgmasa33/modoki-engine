/** `sourceAst` — the node-not-window helpers every migrated guard stands on (#1144). The guards'
 *  own suites pin what each one classifies; this pins the walks they share, including the
 *  vacuous-pass direction (a stump parse) that no guard suite can see from the outside. */
import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import {
  accessPath, blockInnerText, boundIdentifier, calledNames, callOf, callsTo, callsToPath, calleeName, declarationOf,
  enclosingFunction, enclosingNamedFunction, findNodes, flatText, functionBodyOf, functionsNamed, guardProves, guardsOf, importBindings, importsIn, isBlock, lineOf, namedFunctions, objectLiteralKeys, parseSource,
  precedingStatements, printedText, propertyValue, readsOf, referencesToPath, scriptKindFor, siteText, statementOf, stringValueOf, ts as reexportedTs, typeMembers, typesNamed, unwrapValue, valueCarrier, variablesNamed,
} from './sourceAst';

const firstCall = (sf: ts.SourceFile, name: string): ts.CallExpression => callsTo(sf, name)[0]!;

describe('parseSource', () => {
  it('THROWS on source that does not parse — a stump would report no occurrences and pass', () => {
    expect(() => parseSource('const x = ;\nfoo(', 'broken.ts')).toThrow(/broken\.ts:1: did not parse/);
  });

  it('picks the parser mode from the extension: JSX parses in .tsx, and is a diagnostic in .ts', () => {
    const jsx = 'const el = <div className="a">{x}</div>;';
    expect(() => parseSource(jsx, 'panel.tsx')).not.toThrow();
    expect(() => parseSource(jsx, 'panel.ts')).toThrow(/did not parse/);
    expect([scriptKindFor('a.mjs'), scriptKindFor('a.cjs'), scriptKindFor('a.js'), scriptKindFor('a.jsx')])
      .toEqual([ts.ScriptKind.JS, ts.ScriptKind.JS, ts.ScriptKind.JS, ts.ScriptKind.JSX]);
  });
});

describe('callsTo / calleeName', () => {
  it('matches the LAST segment of the callee, and only real calls — not a string or a comment naming one', () => {
    const sf = parseSource("f(1); a.b.f(2); a?.f(3); g(); const s = 'f(4)'; h[k](5);", 's.ts');
    expect(callsTo(sf, 'f').map((c) => c.arguments[0]!.getText(sf))).toEqual(['1', '2', '3']);
    expect(calleeName(findNodes(sf, ts.isCallExpression).at(-1)!)).toBeUndefined();
  });

  it('a nested call is its own node: the outer call\'s extent contains it, the inner\'s does not contain the outer', () => {
    const sf = parseSource('outer(inner(1), 2);', 's.ts');
    const [outer, inner] = [firstCall(sf, 'outer'), firstCall(sf, 'inner')];
    expect(inner.getText(sf)).toBe('inner(1)');
    expect(outer.getText(sf)).toBe('outer(inner(1), 2)');
  });
});

describe('accessPath / referencesToPath / callsToPath — a dotted name however it is formatted (#1179)', () => {
  const exprAt = (code: string): ts.Expression => {
    const sf = parseSource(`use(${code});`, 's.ts');
    return callsTo(sf, 'use')[0]!.arguments[0]!;
  };

  it('accessPath spells a chain through wrappers, newlines, ?. and literal keys; refuses an unnamed link', () => {
    expect([
      'performance\n  .now', '(mesh.material as Material)', 'a?.b!', "o['k']", 'process.argv[1]', 'import.meta.url', 'this.x',
    ].map((c) => accessPath(exprAt(c)))).toEqual([
      'performance.now', 'mesh.material', 'a.b', 'o.k', 'process.argv[1]', 'import.meta.url', 'this.x',
    ]);
    expect(['f().x', 'o[k].y', '"s".length'].map((c) => accessPath(exprAt(c)))).toEqual([undefined, undefined, undefined]);
  });

  it('a WRAPPED call is one read — the per-line `\\btok\\s*\\(` form this replaces saw none of these', () => {
    const sf = parseSource([
      'const a = performance',
      '  .now();',
      'const b = Math.random',
      '  ();',
      'const c = (globalThis.Date as DateConstructor)',
      '  .now();',
      'const d = (performance.now as () => number)();',
      'const e = Math.random!();',
    ].join('\n'), 's.ts');
    expect(callsToPath(sf, 'performance.now', 'Math.random', 'Date.now').map(lineOf)).toEqual([1, 3, 5, 7, 8]);
  });

  it('two reads on ONE line are two, and a neighbour on that line does not stand in for either', () => {
    const sf = parseSource('const t = [Math.random(), Math.random(), Math.floor(1)];', 's.ts');
    expect(callsToPath(sf, 'Math.random')).toHaveLength(2);
  });

  it('the suffix rule is a SEGMENT boundary: globalThis.performance.now and f().now are reads, myperformance.now is not', () => {
    const sf = parseSource('globalThis.performance.now(); myperformance.now(); getApp().getPath("x"); a.getPathname();', 's.ts');
    expect(callsToPath(sf, 'performance.now').map((c) => c.getText(sf))).toEqual(['globalThis.performance.now()']);
    expect(callsToPath(sf, 'getPath').map((c) => c.getText(sf))).toEqual(['getApp().getPath("x")']);
  });

  it('an UNCALLED read counts — handed on as a default, bound, or destructured — and callOf tells them apart', () => {
    const sf = parseSource([
      'function applyOps(mint: () => string = newGuid) { return mint(); }',
      'const now = performance.now.bind(performance);',
      'const { random } = Math;',
      'const { now: n2 } = performance;',
    ].join('\n'), 's.ts');
    const refs = referencesToPath(sf, 'newGuid', 'performance.now', 'Math.random');
    expect(refs.map((r) => r.getText(sf))).toEqual(['newGuid', 'performance.now', 'random', 'now: n2']);
    expect(refs.map((r) => callOf(r))).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('a name position is not a read: a declaration, an import, a member name, a type', () => {
    const sf = parseSource([
      "import { newGuid, newGuid as g2 } from './rules';",
      'export function newGuid2(): string { return newGuid(); }',
      'function newGuid3() {}',
      'const o = { newGuid: 1 }; o.newGuidX; type T = typeof newGuid;',
      'export { newGuid };',
      'const { newGuid: g3 } = rules;',
    ].join('\n'), 's.ts');
    // Line 6 IS a read — of `rules.newGuid`, returned once as its binding element, never again as
    // the `newGuid` key inside it.
    expect(referencesToPath(sf, 'newGuid').map((r) => `${lineOf(r)}:${r.getText(sf)}`)).toEqual(['2:newGuid', '6:newGuid: g3']);
  });

  it('the positions a generic name rule gets wrong: a shorthand and an instantiation ARE reads; a qualified type, a label, a rest element are not (#1179 review)', () => {
    const sf = parseSource([
      'makeOps({ newGuid });',
      'const m = newGuid<string>;',
      'type T = typeof rules.newGuid;',
      'newGuid: for (;;) { break newGuid; }',
      'const { ...newGuid2 } = rules; const { ...now } = performance;',
      'class C implements newGuid<string> {}',
      'const u = import.meta.url;',
      'class D extends newGuid {} interface I extends newGuid {}',
    ].join('\n'), 's.ts');
    expect(referencesToPath(sf, 'newGuid', 'performance.now', 'import.meta.url').map((r) => `${lineOf(r)}:${r.getText(sf)}`))
      .toEqual(['1:newGuid', '2:newGuid', '7:import.meta.url', '8:newGuid']);
  });

  it('enclosingNamedFunction names declarations, methods and bound arrows, climbing past anonymous callbacks', () => {
    const sf = parseSource([
      'function decl() { on(() => { a(); }); }',
      'const bound = () => b();',
      'const o = { key: function () { c(); } };',
      'class K { constructor() { d(); } method() { e(); } field = () => f(); }',
      'g();',
    ].join('\n'), 's.ts');
    expect(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n) => enclosingNamedFunction(firstCall(sf, n))?.name))
      .toEqual(['decl', 'bound', 'key', 'constructor', 'method', 'field', undefined]);
  });

  it('only the outermost link of a matching chain counts; a longer NON-matching chain still reads it', () => {
    const sf = parseSource('a.b.c(); a.b.d();', 's.ts');
    expect(referencesToPath(sf, 'a.b', 'a.b.c').map((r) => r.getText(sf))).toEqual(['a.b.c', 'a.b']);
    expect(referencesToPath(sf, 'a.b').map((r) => r.getText(sf))).toEqual(['a.b', 'a.b']);
  });

  it('statementOf climbs to the statement a node sits in; flatText names it the same however it wraps', () => {
    const sf = parseSource([
      'const cacheDir = path.join(',
      '  app.getPath(',
      "    'userData',",
      '  ),',
      "  'vite-cache',",
      ');',
      "function f() { if (x) { return a ?? app.getPath('userData'); } }",
      "switch (k) { case 1: use(app.getPath('userData')); }",
      "const g = () => app.getPath('userData');",
      "class A { dir = app.getPath('userData'); other = 1; }",
    ].join('\n'), 's.ts');
    expect(callsToPath(sf, 'getPath').map((c) => flatText(statementOf(c)))).toEqual([
      "const cacheDir = path.join( app.getPath( 'userData', ), 'vite-cache', );",
      "return a ?? app.getPath('userData');",
      "use(app.getPath('userData'));",
      "const g = () => app.getPath('userData');",
      "dir = app.getPath('userData');",
    ]);
  });

  it('re-exports `ts`, so a project test can walk without its own typescript import', () => {
    expect(reexportedTs).toBe(ts);
  });
});

describe('value wrappers', () => {
  it('unwrapValue peels (x as T)! down to x; valueCarrier climbs back up to the outermost', () => {
    // Inside an async function: a top-level `await (…)` in a file with no import/export is a CALL
    // to a function named `await`, and the walk would be right to stop there.
    const sf = parseSource('async function f() { const v = await ((read() as string)!); }', 's.ts');
    const call = firstCall(sf, 'read');
    const carrier = valueCarrier(call);
    expect(carrier.getText(sf)).toBe('await ((read() as string)!)');
    expect(unwrapValue(carrier)).toBe(call);
  });

  it('boundIdentifier sees through the wrappers to `const v =`, and is undefined for anything else', () => {
    const sf = parseSource('const v = (read() as string);\nuse(read());\nconst { a } = read();', 's.ts');
    expect(callsTo(sf, 'read').map((c) => boundIdentifier(c)?.text)).toEqual(['v', undefined, undefined]);
  });
});

describe('enclosingFunction / declarationOf / readsOf', () => {
  it('enclosingFunction is the nearest function, or the file for top-level code', () => {
    const sf = parseSource('top();\nfunction f() { if (x) { inner(); } const g = () => nested(); }', 's.ts');
    expect(ts.isSourceFile(enclosingFunction(firstCall(sf, 'top')))).toBe(true);
    expect((enclosingFunction(firstCall(sf, 'inner')) as ts.FunctionDeclaration).name!.text).toBe('f');
    expect(ts.isArrowFunction(enclosingFunction(firstCall(sf, 'nested')))).toBe(true);
  });

  it('resolves by SYMBOL: a sibling function\'s same-named parameter or const is not a read (#1144 close-out)', () => {
    const sf = parseSource([
      'const raw = read();',
      'expect(raw).toMatch(/x/);',
      'function parse(raw: string) { return JSON.parse(raw); }',
      "it('b', () => { const raw = other(); JSON.parse(raw); });",
      'f({ raw });',
    ].join('\n'), 's.ts');
    const raw = boundIdentifier(firstCall(sf, 'read'))!;
    // The top-level binding's reads: the expect, and the shorthand `{ raw }` — never the parameter's
    // or the inner const's, however they are spelled.
    expect(readsOf(raw).map((r) => ts.SyntaxKind[r.parent.kind])).toEqual(['CallExpression', 'ShorthandPropertyAssignment']);
    expect(readsOf(raw)[0]!.parent.getText(sf)).toBe('expect(raw)');
  });

  it('`export { raw }` and `export { raw as alias }` are reads of the local binding (#1179 known gap 2)', () => {
    const sf = parseSource("const raw = read();\nconst other = 1;\nexport { raw };\nexport { raw as alias, other };\nexport { raw as fromElsewhere } from './x';", 's.ts');
    const raw = boundIdentifier(firstCall(sf, 'read'))!;
    // Two local exports read it; the `from './x'` clause names a DIFFERENT module's binding.
    expect(readsOf(raw).map((r) => r.parent.getText(sf))).toEqual(['raw', 'raw as alias']);
  });

  it('THROWS when the checker would not take the file — resolution must not silently find nothing', () => {
    const sf = parseSource('const raw = read();\nuse(raw);', 'notes.txt');
    expect(() => readsOf(boundIdentifier(firstCall(sf, 'read'))!)).toThrow(/checker did not take this file/);
  });

  it('excludes what is not a use: its own name, a property name, an object key', () => {
    const sf = parseSource('const raw = 1;\nJSON.parse(raw); o.raw; ({ raw: 2 });', 's.ts');
    const raw = findNodes(sf, ts.isVariableDeclaration)[0]!.name as ts.Identifier;
    expect(readsOf(raw).map((r) => r.parent.getText(sf))).toEqual(['JSON.parse(raw)']);
  });

  it('declarationOf follows a name to the declaration in scope, not the first one spelled alike', () => {
    const sf = parseSource("function a() { const RE = 'x'; }\nfunction b(s: string) { const RE = /(\\d+)$/; RE.exec(s); }", 's.ts');
    const use = findNodes(firstCall(sf, 'exec'), ts.isIdentifier).find((i) => i.text === 'RE')!;
    expect((declarationOf(use) as ts.VariableDeclaration).initializer!.getText(sf)).toBe('/(\\d+)$/');
  });
});

describe('function bodies and literals — the shapes a hand-written brace or quote scanner used to guess', () => {
  it('functionBodyOf: a block or a concise expression for an inline function; undefined for a reference', () => {
    const sf = parseSource('reg(a, () => { x(); }); reg(b, (w) => y(w)); reg(c, onC); reg(d, function () { z(); });', 's.ts');
    const bodies = callsTo(sf, 'reg').map((c) => functionBodyOf(c.arguments[1]));
    expect(bodies.map((b) => (b === undefined ? 'none' : isBlock(b) ? 'block' : 'concise'))).toEqual(['block', 'concise', 'none', 'block']);
    expect(blockInnerText(bodies[0] as ts.Block)).toBe(' x(); ');
  });

  it('blockInnerText is exact even with braces and quotes inside strings, templates and regexes', () => {
    const sf = parseSource("function f() { const a = '}'; const b = `{${'}'}`; const r = /['}]/; }\nfunction g() { tail(); }", 's.ts');
    const [f] = namedFunctions(sf);
    expect(blockInnerText(f!.body as ts.Block)).not.toContain('tail');
    expect(blockInnerText(f!.body as ts.Block).trim().endsWith("/['}]/;")).toBe(true);
  });

  it('namedFunctions: declarations and function-valued consts, concise arrows included; not other consts', () => {
    const sf = parseSource('function a() {}\nconst b = () => 1;\nconst c = function () {};\nconst d = 3;\nlet e = async (x: number) => { await x; };', 's.ts');
    expect(namedFunctions(sf).map((f) => f.name)).toEqual(['a', 'b', 'c', 'e']);
  });

  it('calledNames lists every call inside, nested ones included', () => {
    const sf = parseSource('function a() { b(); o.c(() => d()); }', 's.ts');
    expect(calledNames(namedFunctions(sf)[0]!.body)).toEqual(['b', 'c', 'd']);
  });

  it('stringValueOf and objectLiteralKeys read a literal, and refuse anything else', () => {
    const sf = parseSource("p(w, 'A B', { text, textColor: c, ...base, nested: { inner: 1 } }); p(w, `T${x}`, patch); p(w, `plain`, {});", 's.ts');
    const [a, b, c] = callsTo(sf, 'p');
    expect([stringValueOf(a!.arguments[1]), stringValueOf(b!.arguments[1]), stringValueOf(c!.arguments[1])]).toEqual(['A B', undefined, 'plain']);
    expect(objectLiteralKeys(a!.arguments[2])).toEqual(['text', 'textColor', '...', 'nested']);
    // Quoted and computed-literal keys are NAMES, not their source text (#1144 close-out).
    const q = parseSource("o({ 'text': 1, \"t2\": 2, ['t3']: 3, [k]: 4, 5: 5 });", 'q.ts');
    expect(objectLiteralKeys(callsTo(q, 'o')[0]!.arguments[0])).toEqual(['text', 't2', 't3', '[k]', '5']);
    expect(objectLiteralKeys(b!.arguments[2])).toBeUndefined();
    expect(lineOf(c!)).toBe(1);
  });
});

describe('declarations by NAME — the units a bracket count, a column-0 slice or a fixed-indent closer used to cut (#1195)', () => {
  it('propertyValue reads a key\'s value however it is written, and is not moved by a bracket inside a string', () => {
    const sf = parseSource([
      "o({ a: ')}', b, 'c-d': [1, { e: 2 }], ['f']: g(), m() { return 1; }, get h() { return 2; }, a: 'last' });",
      'o(notALiteral);',
    ].join('\n'), 's.ts');
    const [lit, ref] = callsTo(sf, 'o').map((c) => c.arguments[0]);
    expect(printedText(propertyValue(lit, 'a')!)).toBe("'last'"); // the object ends up holding the LAST one
    expect(propertyValue(lit, 'b')!.getText(sf)).toBe('b'); // a shorthand's value is its name
    expect(printedText(propertyValue(lit, 'c-d')!)).toBe('[1, { e: 2 }]');
    expect(printedText(propertyValue(lit, 'f')!)).toBe('g()');
    expect(ts.isMethodDeclaration(propertyValue(lit, 'm')!)).toBe(true);
    expect(ts.isGetAccessorDeclaration(propertyValue(lit, 'h')!)).toBe(true);
    expect(propertyValue(lit, 'e')).toBeUndefined(); // a nested literal's key is not this literal's
    expect(propertyValue(ref, 'a')).toBeUndefined();
    expect(propertyValue(undefined, 'a')).toBeUndefined();
  });

  it('variablesNamed binds the exact name in every scope, and not a longer name or a destructure', () => {
    const sf = parseSource([
      "const MODULES = [{ key: '];' }];",
      'const MODULES_BY_KEY = new Map();',
      'const { MODULES: alias } = x;',
      'function f() { let MODULES = 1; }',
    ].join('\n'), 's.ts');
    const found = variablesNamed(sf, 'MODULES');
    expect(found.map((d) => lineOf(d))).toEqual([1, 4]);
    expect(found.filter((d) => enclosingFunction(d) === sf).map((d) => printedText(d.initializer!))).toEqual(["[{ key: '];' }]"]);
  });

  it('typesNamed + typeMembers read an interface\'s OWN members — not a nested literal\'s, and a method counts', () => {
    const sf = parseSource([
      'export interface A {',
      '  a: number;',
      '  b?: { inner: string;',
      '}; // a column-0 brace INSIDE the interface ended the old slice',
      "  'c-d': 1 | 2;",
      '  run<T>(x: T): void;',
      '  [k: string]: unknown;',
      '}',
      'interface A { merged: true }',
      'type L = ({ z: 1 });',
      'type U = { y: 1 } | null;',
      'interface Base { hash?: string }',
      'interface Child extends Base { own: 1 }',
    ].join('\n'), 's.ts');
    const decls = typesNamed(sf, 'A');
    expect(decls).toHaveLength(2);
    const rows = typeMembers(decls[0])!;
    expect(rows.map((m) => `${m.kind}:${m.name}${m.optional ? '?' : ''}`)).toEqual(['property:a', 'property:b?', 'property:c-d', 'method:run', 'index:[index]']);
    expect(printedText(rows[0]!.type!)).toBe('number');
    expect(typeMembers(rows[1]!.type)!.map((m) => m.name)).toEqual(['inner']);
    expect(typeMembers(decls[1])!.map((m) => m.name)).toEqual(['merged']);
    expect(typeMembers(typesNamed(sf, 'L')[0])!.map((m) => m.name)).toEqual(['z']);
    // A union has no single written member list: refused, not read as "no members".
    expect(typeMembers(typesNamed(sf, 'U')[0])).toBeUndefined();
    // Nor does an interface that extends another: a field moved into its base must not read as gone.
    expect(typeMembers(typesNamed(sf, 'Child')[0])).toBeUndefined();
  });

  it('functionsNamed finds every function known by the name — methods and bound arrows too — and only ones with a body', () => {
    const sf = parseSource([
      'export function a() { one(); }',
      "export function b() { const s = '\\nfunction '; }",
      'const c = (x: number) => x;',
      'const o = { a() { two(); }, d: function () {}, e: 1 };',
      'class K { a = () => three(); get g() { return 1; } constructor() {} }',
      'interface I { a(): void }',
      'declare function a(): void;',
    ].join('\n'), 's.ts');
    expect(functionsNamed(sf, 'a').map((f) => calledNames(f.body))).toEqual([['one'], ['two'], ['three']]);
    expect(functionsNamed(sf, 'c').map((f) => f.parameters.map((p) => p.name.getText(sf)))).toEqual([['x']]);
    expect(['b', 'd', 'e', 'g', 'constructor'].map((n) => functionsNamed(sf, n).length)).toEqual([1, 1, 0, 1, 1]);
    // `b`'s body is its own: a string spelling the old `'\nfunction '` closer does not end it early.
    expect(blockInnerText(functionsNamed(sf, 'b')[0]!.body as ts.Block)).toContain("'\\nfunction '");
  });
});

describe('guardsOf / precedingStatements / printedText — the condition an occurrence runs under is its OWN (#1179)', () => {
  const guards = (src: string, name: string) =>
    guardsOf(firstCall(parseSource(src, 's.ts'), name)).map((g) => `${g.holds ? '' : 'NOT '}${printedText(g.test)}`);

  it('reads the branch the call sits in: then, else, both arms of a ternary, && and ||', () => {
    expect(guards('if (a) { t(); } else { e(); }', 't')).toEqual(['a']);
    expect(guards('if (a) { t(); } else { e(); }', 'e')).toEqual(['NOT a']);
    expect(guards('const v = a ? t() : e();', 'e')).toEqual(['NOT a']);
    expect(guards('a && t(); b || e();', 't')).toEqual(['a']);
    expect(guards('a && t(); b || e();', 'e')).toEqual(['NOT b']);
    expect(guards('if (a) { if (b) { t(); } }', 't')).toEqual(['b', 'a']);
    // Only the RIGHT operand is guarded: `t()` on the left runs whatever `b` is.
    expect(guards('t() && b; t2() || b;', 't')).toEqual([]);
  });

  it('an EARLY EXIT above the call is a guard; an `if` whose block the call merely FOLLOWS is not', () => {
    expect(guards('function f() { if (!a) return; t(); }', 't')).toEqual(['NOT !a']);
    expect(guards('function f() { if (!a) { warn(); return x; } t(); }', 't')).toEqual(['NOT !a']);
    expect(guards('for (;;) { if (a) continue; t(); }', 't')).toEqual(['NOT a']);
    expect(guards('switch (k) { case 1: if (!a) break; t(); }', 't')).toEqual(['NOT !a']);
    // A nested `if` exits only when BOTH of its branches do.
    expect(guards('function f() { if (a) { if (b) return; else throw e; } t(); }', 't')).toEqual(['NOT a']);
    expect(guards('function f() { if (a) { if (b) return; } t(); }', 't')).toEqual([]);
    // The "nearest `if (` line above" shape: `t()` is after the block, and runs whatever `a` is.
    expect(guards('if (a) {\n  x();\n}\nt();', 't')).toEqual([]);
    expect(guards('function f() { if (a) { warn(); } t(); }', 't')).toEqual([]);
    expect(guards('function f() { if (a) return; else y(); t(); }', 't')).toEqual([]);
    expect(guards('function f() { t(); if (!a) return; }', 't')).toEqual([]);
    // The condition itself is not guarded by itself.
    expect(guards('if (t()) { x(); }', 't')).toEqual([]);
  });

  it('guardProves reads !, && and || with the polarity the guard imposes, and nothing it cannot decide', () => {
    const proves = (src: string) => guardsOf(firstCall(parseSource(src, 's.ts'), 't')).some((g) =>
      guardProves(g, (e) => ts.isIdentifier(e) && e.text === 'F'));
    expect(['if (F) t();', 'if (!F) return; t();', 'if ((F as boolean) && x) t();', 'if (!F || x) return; t();', 'if (!(!F)) t();']
      .map(proves)).toEqual([true, true, true, true, true]);
    expect(['if (!F) t();', 'if (F) return; t();', 'if (F || x) t();', 'if (!F || x) t();', 'if (!F && x) return; t();', 'if (F && x) return; t();',
      'if (F === true) t();', 'const g = F; if (g) t();']
      .map(proves)).toEqual([false, false, false, false, false, false, false, false]);
  });

  it('guardProves with `value: false` proves the atom FALSE — the mirror, not the negation of the answer', () => {
    const provesFalse = (src: string) => guardsOf(firstCall(parseSource(src, 's.ts'), 't')).some((g) =>
      guardProves(g, (e) => ts.isIdentifier(e) && e.text === 'F', false));
    expect(['if (!F) t();', 'if (F) return; t();', 'if (F || x) return; t();', 'if (!F && x) t();', 'if (!(F)) t();']
      .map(provesFalse)).toEqual([true, true, true, true, true]);
    // Unproven either way is not proven false: `x` alone, `F && x` failing, a closure's own exit.
    expect(['if (x) t();', 'if (F && x) return; t();', 'if (F) t();', 'if (!F) return; t();', 'if (F ? a : b) t();',
      'function f() { const g = () => { if (F) return; }; t(); }']
      .map(provesFalse)).toEqual([false, false, false, false, false, false]);
  });

  it('climbs through a closure to the gate dominating where it is created', () => {
    expect(guards('async function f() { if (!a) { return; } const g = async () => { await t(); }; }', 't')).toEqual(['NOT !a']);
    // A hoisted DECLARATION escapes the early exits of its own list — code above them can call it…
    expect(guards('function f() { queue(load); if (!a) return; function load() { if (b) { t(); } } }', 't')).toEqual(['b']);
    // …but not the branches enclosing that list.
    expect(guards('if (other) {\n  function go() {\n    if (gate) {\n      t();\n    }\n  }\n  go();\n}', 't')).toEqual(['gate', 'other']);
  });

  it('precedingStatements: earlier siblings of each enclosing list, up to the function — not inside earlier branches', () => {
    const sf = parseSource('before();\nfunction f() { p(); if (c) { q(); } try { r(); d(); } finally {} }\nouter();', 's.ts');
    const texts = precedingStatements(firstCall(sf, 'd')).map((s) => flatText(s));
    expect(texts).toEqual(['r();', 'if (c) { q(); }', 'p();']);
  });

  it('printedText spells equal code equally across a formatter wrap, and keeps parentheses the source wrote', () => {
    const [a, b] = parseSource('if (!p &&\n  (\n    x ||   y)) {}\nif (!p && (x || y)) {}', 's.ts').statements as unknown as ts.IfStatement[];
    expect(printedText(a!.expression)).toBe('!p && (x || y)');
    expect(printedText(a!.expression)).toBe(printedText(b!.expression));
    expect(flatText(a!.expression)).not.toBe(flatText(b!.expression));
  });
});

describe('importsIn — every module edge, read from the declaration (#1179)', () => {
  const edges = (code: string, label = 'x.ts') => importsIn(parseSource(code, label))
    .map(({ spec, kind, typeOnly, bindings }) => ({ spec, kind, typeOnly, bindings: bindings.map((b) => (b.imported === b.local ? b.local : `${b.imported} as ${b.local}`)) }));

  it('reads static imports, however wrapped, with every binding by its exported and local name', () => {
    expect(edges(`import D, {
      a,
      b as c,
    } from './m';
    import * as ns from "three/webgpu";
    import 'side-effect';
    import type { T } from './types';
    import { type U } from './u';
    import legacy = require('legacy');
    import type LegacyT = require('legacy-types');`)).toEqual([
      { spec: './m', kind: 'import', typeOnly: false, bindings: ['default as D', 'a', 'b as c'] },
      { spec: 'three/webgpu', kind: 'import', typeOnly: false, bindings: ['* as ns'] },
      { spec: 'side-effect', kind: 'import', typeOnly: false, bindings: [] },
      { spec: './types', kind: 'import', typeOnly: true, bindings: ['T'] },
      // Every specifier type-marked is still NOT erased under verbatimModuleSyntax: `import {} from './u'` runs.
      { spec: './u', kind: 'import', typeOnly: false, bindings: ['U'] },
      { spec: 'legacy', kind: 'import', typeOnly: false, bindings: ['* as legacy'] },
      { spec: 'legacy-types', kind: 'import', typeOnly: true, bindings: ['* as LegacyT'] },
    ]);
  });

  it('reads re-exports — the edge a column-0 `import` reader never saw', () => {
    expect(edges(`export * from './all';
    export * as grouped from './grouped';
    export { x, y as z } from './named';
    export type { T } from './types';
    export { local };
    const local = 1;`)).toEqual([
      { spec: './all', kind: 'reexport', typeOnly: false, bindings: [] },
      { spec: './grouped', kind: 'reexport', typeOnly: false, bindings: ['* as grouped'] },
      { spec: './named', kind: 'reexport', typeOnly: false, bindings: ['x', 'y as z'] },
      { spec: './types', kind: 'reexport', typeOnly: true, bindings: ['T'] },
    ]);
  });

  it('reads literal dynamic imports anywhere, and nothing that only looks like one', () => {
    expect(edges(`async function f(name: string) {
      const a = await import(
        './wrapped');
      const b = await import(\`./template\`);
      const c = await import(name);
      const s = "import('./in-a-string')";
      type T = typeof import('./type-query');
      return [a, b, c, s];
    }`)).toEqual([
      { spec: './wrapped', kind: 'dynamic', typeOnly: false, bindings: [] },
      { spec: './template', kind: 'dynamic', typeOnly: false, bindings: [] },
    ]);
  });

  it('marks each binding erased or not — the statement\'s `type`, or the binding\'s own (#1193)', () => {
    const rows = importsIn(parseSource(`import { a, type b } from './m';
    import type { c } from './t';
    export { d, type e } from './r';
    export type * as f from './s';`, 'x.ts')).flatMap((e) => e.bindings.map((b) => `${b.local}:${b.typeOnly}`));
    expect(rows).toEqual(['a:false', 'b:true', 'c:true', 'd:false', 'e:true', 'f:true']);
  });

  it('reads type-position imports only when asked, as erased `importType` edges (#1193)', () => {
    const code = `type A = import('./a').T;
    const f = (x: typeof import('../../escape')) => x;
    const s = "import('./in-a-string').T";
    const b = await import('./b');`;
    expect(edges(code).map((e) => e.spec)).toEqual(['./b']);
    expect(importsIn(parseSource(code, 'x.ts'), { typePositions: true }).map(({ spec, kind, typeOnly }) => ({ spec, kind, typeOnly })))
      .toEqual([
        { spec: './a', kind: 'importType', typeOnly: true },
        { spec: '../../escape', kind: 'importType', typeOnly: true },
        { spec: './b', kind: 'dynamic', typeOnly: false },
      ]);
  });
});

describe('importBindings — "F imports N from M", however the import is spelt (#1193)', () => {
  const names = (code: string, spec: string | RegExp) => importBindings(parseSource(code, 'x.ts'), spec)
    .map((b) => (b.imported === b.local ? b.local : `${b.imported} as ${b.local}`) + (b.typeOnly ? ' (type)' : ''));

  it('reads every spelling a hand-written `import\\s*\\{[^}]*N[^}]*\\}\\s*from` regex split on', () => {
    expect(names(`import {
      first,
      N as renamed,
    } from "./spriteAtlas";
    import D, { type T } from './spriteAtlas';
    import * as ns from './spriteAtlas';
    import legacy = require('./spriteAtlas');`, './spriteAtlas')).toEqual([
      'first', 'N as renamed', 'default as D', 'T (type)', '* as ns', '* as legacy',
    ]);
  });

  it('matches the specifier exactly, or by RegExp — and a global RegExp is not stateful across edges', () => {
    const code = "import { a } from '../loaders/spriteAtlas';\nimport { b } from './spriteAtlas';\nimport { c } from './spriteAtlasX';";
    expect(names(code, './spriteAtlas')).toEqual(['b']);
    expect(names(code, /(^|\/)spriteAtlas$/g)).toEqual(['a', 'b']);
  });

  it('is not fooled by a re-export, a side-effect import, a comment or a string', () => {
    expect(names(`export { N } from './m';
    import './m';
    // import { N } from './m';
    const s = "import { N } from './m'";
    const t = \`
    import { N } from './m'\`;`, './m')).toEqual([]);
  });
});

describe('siteText — the unit a ledger key names a site by (#1179 P5)', () => {
  const sites = (lines: string[]): string[] => {
    const sf = parseSource(lines.join('\n'), 's.ts');
    return findNodes(sf, (n): n is ts.Identifier => ts.isIdentifier(n) && n.text === 'T').map(siteText);
  };

  it('is the statement, flattened, for a site in a simple statement or a block body', () => {
    expect(sites([
      'T.clear();',
      'const x = f(',
      '  T,',
      ');',
      'function g() { if (a) { T.set(1, 2); } }',
    ])).toEqual(['T.clear();', 'const x = f( T, );', 'T.set(1, 2);']);
  });

  it('is the innermost OBJECT-LITERAL member, not a whole export', () => {
    expect(sites([
      'export const __testing = {',
      '  a: 1,',
      '  T,',
      '  b: () => T.size,',
      '  c: { d: [T] },',
      '  e() { return T; },',
      '  f: 2,',
      '};',
    ])).toEqual(['T', 'b: () => T.size', 'd: [T]', 'return T;']);
  });

  it('is only the HEAD of a compound statement for a site in its head', () => {
    expect(sites([
      'for (const [cell, c] of T) {',
      '  use(cell, c);',
      '}',
      'for (const c of T.values()) min = Math.min(min, c.size);',
      'if (ready(T)) { go(); } else { stop(); }',
      'while (T.size > 0) drain();',
      'for (let i = 0; i < T.length; i++) {}',
      'for (const k in T) {}',
      'switch (T.kind) { case 1: break; }',
      'outer: for (const x of T) {}',
    ])).toEqual([
      'for (const [cell, c] of T)',
      'for (const c of T.values())',
      'if (ready(T))',
      'while (T.size > 0)',
      'for (let i = 0; i < T.length; i++)',
      'for (const k in T)',
      'switch (T.kind)',
      'for (const x of T)',
    ]);
  });

  it('narrows into a body that is not a block, and down an else-if chain', () => {
    expect(sites([
      'for (const c of cells) min = Math.min(min, T.get(c));',
      'if (a) x = 1; else if (T.has(b)) y = 2; else z = T;',
      'while (go) if (T) { stop(); }',
      'do T.pop(); while (more);',
    ])).toEqual([
      'min = Math.min(min, T.get(c));',
      'if (T.has(b))',
      'z = T;',
      'if (T)',
      'do T.pop(); while (more);',
    ]);
  });
});

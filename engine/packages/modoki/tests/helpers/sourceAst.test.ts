/** `sourceAst` — the node-not-window helpers every migrated guard stands on (#1144). The guards'
 *  own suites pin what each one classifies; this pins the walks they share, including the
 *  vacuous-pass direction (a stump parse) that no guard suite can see from the outside. */
import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import {
  blockInnerText, boundIdentifier, calledNames, callsTo, calleeName, declarationOf, enclosingFunction, findNodes,
  functionBodyOf, isBlock, lineOf, namedFunctions, objectLiteralKeys, parseSource, readsOf, scriptKindFor,
  stringValueOf, unwrapValue, valueCarrier,
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

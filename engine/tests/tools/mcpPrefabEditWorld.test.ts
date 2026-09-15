/** The MCP half of #1254: the scene-edit tools reach the prefab-edit world, and a path refusal names its real cause.
 *
 *  `modoki_prefab edit-open` tells the agent to edit the template with the scene tools. Both of the tools that take a
 *  scene `path` resolved an omitted one through `activeScenePath`, which read only `scenePathRef` — absent by design in
 *  prefab-edit mode — and answered NOT_FOUND. The editor now reports `prefabEditWorld`, and the default falls back to it.
 *  Driven through the real handlers against a stub backend (`mcpSurface`), so only the code path can make these pass. */

import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';
import { declarationOf, findNodes, functionsNamed, parseSource, ts, unwrapValue } from '@modoki/engine/testing/sourceAst';
import { loadSurface, realRequests, type Surface } from './mcpSurface';

const ENGINE = join(__dirname, '..', '..');

const WORLD = '/__prefab-edit__/b134802e-0000-4000-8000-000000000001';
let surface: Surface | undefined;
afterEach(() => { surface?.restore(); surface = undefined; });

/** A backend whose editor-state is `state`; scene-mutate answers ok. */
function backend(state: Record<string, unknown>) {
  return loadSurface((req) => {
    if (req.path.startsWith('/api/editor-state')) return { body: { ok: true, playState: 'stopped', ...state } };
    if (req.path === '/api/scene-mutate') return { body: { ok: true, changed: 1, errors: [], warnings: [], saved: false } };
    return undefined;
  });
}
const mutatePaths = (s: Surface) => realRequests(s).filter((r) => r.path === '/api/scene-mutate').map((r) => (r.body as { path?: string }).path);

describe('the active-scene default reaches the prefab-edit world (#1254)', () => {
  it('modoki_mutate_scene with `path` omitted targets prefabEditWorld when there is no scenePathRef', async () => {
    const s = (surface = backend({ scenePath: null, prefabEditWorld: WORLD }));
    const r = await s.call('modoki_mutate_scene', { ops: [{ op: 'setTrait', entity: { name: 'Face' }, trait: 'Transform', fields: { x: 1 } }] });
    expect(r.isError, s.text(r)).toBeFalsy();
    expect(mutatePaths(s)).toEqual([WORLD]);
  });

  it('modoki_set_transform with `path` omitted targets it too — the same helper', async () => {
    const s = (surface = backend({ scenePath: null, prefabEditWorld: WORLD }));
    const r = await s.call('modoki_set_transform', { entity: { name: 'Face' }, space: 'local', position: [1, 2, 3] });
    expect(r.isError, s.text(r)).toBeFalsy();
    expect(mutatePaths(s)).toEqual([WORLD]);
  });

  it('a real scene still wins — scenePathRef first', async () => {
    const s = (surface = backend({ scenePathRef: '/assets/scenes/main.scene.json', prefabEditWorld: WORLD }));
    await s.call('modoki_mutate_scene', { ops: [{ op: 'removeEntity', entity: { name: 'X' } }] });
    expect(mutatePaths(s)).toEqual(['/assets/scenes/main.scene.json']);
  });

  it('neither reported is still NOT_FOUND, and nothing is posted', async () => {
    const s = (surface = backend({ scenePath: null }));
    const r = await s.call('modoki_mutate_scene', { ops: [{ op: 'removeEntity', entity: { name: 'X' } }] });
    expect(r.isError).toBe(true);
    expect(s.text(r)).toContain('NOT_FOUND');
    expect(mutatePaths(s)).toEqual([]);
  });
});

describe('a 403 the ROUTE explains is not the wrong-editor refusal (#1254)', () => {
  it("route-authored options replace the C6 fallback — a rejected path does not send the agent to modoki_identity", async () => {
    const s = (surface = loadSurface((req) => req.path === '/api/scene-mutate'
      ? { status: 403, body: { error: 'path outside allowed directories', options: ['pass an asset-root URL of THIS project'] } }
      : undefined));
    const r = await s.call('modoki_mutate_scene', { path: '/@fs/x.json', ops: [{ op: 'removeEntity', entity: { name: 'X' } }] });
    const text = s.text(r);
    expect(text).toContain('asset-root URL');
    expect(text).not.toContain('modoki_identity');
  });
});

describe('`prefabEditWorld` is ONE wire field across three independently built processes (#1254 review)', () => {
  // The renderer produces it, the backend route compares against it, the MCP reads it — each spelled by hand, and
  // the stub-backend tests above supply it themselves, so deleting or renaming the PRODUCER leaves every one of them
  // green while the feature is dead. Read each side from its source.
  const read = (rel: string) => parseSource(readScannedSource(join(ENGINE, rel)).code, rel);
  const readsOf = (root: ts.Node) => findNodes(root, ts.isPropertyAccessExpression).filter((p) => p.name.text === 'prefabEditWorld');

  it('the renderer reports it from the SESSION-matched world, in the object readEditorState RETURNS', () => {
    const fn = functionsNamed(read('app/editor/agentEditorOps.ts'), 'readEditorState');
    expect(fn.length).toBe(1);
    const body = fn[0]!.body!;
    const ret = ts.isBlock(body) ? body.statements.find(ts.isReturnStatement) : undefined;
    const obj = ret?.expression && unwrapValue(ret.expression);
    expect(obj && ts.isObjectLiteralExpression(obj), 'readEditorState returns an object literal').toBe(true);
    // By ANCESTRY, not by name anywhere in the body (review of the guard): a `false ? {…} : {}` spread, or the field nested
    // under a sub-object, both kept a name-only check green while editor-state never emitted it. The shape pinned here is
    // `...(<w> ? { prefabEditWorld: <w> } : {})` directly in the returned literal, with <w> = prefabSessionWorldPath(…).
    const reported = (obj as ts.ObjectLiteralExpression).properties.filter(ts.isSpreadAssignment).flatMap((sp) => {
      const c = unwrapValue(sp.expression);
      if (!ts.isConditionalExpression(c) || !ts.isIdentifier(c.condition)) return [];
      const whenTrue = unwrapValue(c.whenTrue);
      if (!ts.isObjectLiteralExpression(whenTrue)) return [];
      const cond = declarationOf(c.condition);
      return whenTrue.properties.filter((pr): pr is ts.PropertyAssignment => ts.isPropertyAssignment(pr) && ts.isIdentifier(pr.name)
        && pr.name.text === 'prefabEditWorld' && ts.isIdentifier(pr.initializer) && !!cond && declarationOf(pr.initializer) === cond)
        .map(() => cond!);
    });
    expect(reported.length, 'one `...(w ? { prefabEditWorld: w } : {})` in the returned object').toBe(1);
    // …from prefabSessionWorldPath, not the world alone: an orphaned prefab world cannot be saved by any route.
    const init = ts.isVariableDeclaration(reported[0]!) ? reported[0]!.initializer : undefined;
    expect(init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) ? init.expression.text : undefined).toBe('prefabSessionWorldPath');
  });

  it('the backend route matches the handle against it IN canGoLive, and the MCP default falls back to it', () => {
    const router = read('plugins/backend/editorBackendRouter.ts');
    const canGoLive = findNodes(router, ts.isVariableDeclaration).filter((d) => ts.isIdentifier(d.name) && d.name.text === 'canGoLive');
    expect(canGoLive.length, 'one canGoLive').toBe(1);
    expect(readsOf(canGoLive[0]!.initializer!).some((p) => ts.isBinaryExpression(p.parent) && p.parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
      && ts.isIdentifier(p.parent.right) && p.parent.right.text === 'scenePath'), 'canGoLive compares st.prefabEditWorld === scenePath').toBe(true);
    const helper = functionsNamed(read('tools/modoki-mcp/src/tools/scene.ts'), 'activeScenePath');
    expect(helper.length).toBe(1);
    // As the right side of `scenePathRef ?? prefabEditWorld` — a read in a log line would not be the fallback.
    expect(readsOf(helper[0]!.body!).some((p) => ts.isBinaryExpression(p.parent) && p.parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      && p.parent.right === p && ts.isPropertyAccessExpression(p.parent.left) && p.parent.left.name.text === 'scenePathRef'),
    'activeScenePath resolves scenePathRef ?? prefabEditWorld').toBe(true);
  });
});

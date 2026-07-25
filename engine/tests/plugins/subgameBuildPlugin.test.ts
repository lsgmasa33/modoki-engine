/** subgameBuildPlugin (OTA Phase 4, engine/plugins/subgameBuild.ts) had ZERO test
 *  coverage — it was only ever exercised end-to-end via a real device build. This tests
 *  its Vite hooks directly: which shared-registry ids get externalized vs. bundled, that
 *  `sharedDeps` in the emitted subgame.json is scoped to what the sub-game ACTUALLY
 *  imports (not the full SUBGAME_SHARED_KEYS list — see the plugin's own header on why
 *  over-declaring would force the shell to eager-load renderers a sub-game never uses),
 *  and that a project with no game.ts fails loudly instead of silently. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { subgameBuildPlugin, SUBGAME_ENTRY_VIRTUAL_ID, subgameOutDir } from '../../plugins/subgameBuild';

function makeProject(withGameTs: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-subgame-build-test-'));
  if (withGameTs) fs.writeFileSync(path.join(dir, 'game.ts'), 'export const game = { id: "x" };\n');
  return dir;
}

describe('subgameBuildPlugin', () => {
  let projectRoot: string;
  afterEach(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

  it('externalizes a SUBGAME_SHARED_KEYS id and records it as used', () => {
    projectRoot = makeProject(true);
    const plugin = subgameBuildPlugin({ projectRoot, engineApi: 3 });
    const resolveId = plugin.resolveId as (id: string) => unknown;

    const result = resolveId('three');
    expect(result).toEqual({ id: 'three', external: true });
  });

  it('does NOT externalize an id outside the shared set (bundled normally)', () => {
    projectRoot = makeProject(true);
    const plugin = subgameBuildPlugin({ projectRoot, engineApi: 3 });
    const resolveId = plugin.resolveId as (id: string) => unknown;
    expect(resolveId('lodash')).toBeNull();
  });

  it('resolves the virtual entry id to its internal \\0-prefixed form', () => {
    projectRoot = makeProject(true);
    const plugin = subgameBuildPlugin({ projectRoot, engineApi: 3 });
    const resolveId = plugin.resolveId as (id: string) => unknown;
    const resolved = resolveId(SUBGAME_ENTRY_VIRTUAL_ID);
    expect(resolved).toBe('\0' + SUBGAME_ENTRY_VIRTUAL_ID);
  });

  it('load() throws a clear error when the project has no game.ts/game.tsx', () => {
    projectRoot = makeProject(false);
    const plugin = subgameBuildPlugin({ projectRoot, engineApi: 3 });
    const resolveId = plugin.resolveId as (id: string) => string;
    const load = plugin.load as (id: string) => string;
    const entryId = resolveId(SUBGAME_ENTRY_VIRTUAL_ID);
    expect(() => load(entryId)).toThrow(/no game\.ts\/game\.tsx found/);
  });

  it('load() emits a globalThis assignment (not a bare export, which Rolldown drops from an IIFE)', () => {
    projectRoot = makeProject(true);
    const plugin = subgameBuildPlugin({ projectRoot, engineApi: 3 });
    const resolveId = plugin.resolveId as (id: string) => string;
    const load = plugin.load as (id: string) => string;
    const src = load(resolveId(SUBGAME_ENTRY_VIRTUAL_ID));
    expect(src).toContain('globalThis.__MODOKI_SUBGAME__');
    expect(src).toContain('engineApi: 3');
    expect(src).not.toMatch(/^export const/m);
  });

  it('generateBundle() emits subgame.json scoped to ONLY the ids actually imported, sorted', () => {
    projectRoot = makeProject(true);
    const plugin = subgameBuildPlugin({ projectRoot, engineApi: 5 });
    const resolveId = plugin.resolveId as (id: string) => unknown;
    resolveId('zustand');
    resolveId('three');
    resolveId('lodash'); // not a shared key — must not appear in sharedDeps

    const emitted: { fileName: string; source: string }[] = [];
    const ctx = { emitFile: (asset: { fileName: string; source: string }) => emitted.push(asset) };
    (plugin.generateBundle as (this: typeof ctx) => void).call(ctx);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].fileName).toBe('subgame.json');
    const manifest = JSON.parse(emitted[0].source);
    expect(manifest).toEqual({ schema: 1, engineApi: 5, sharedDeps: ['three', 'zustand'], entry: 'subgame.js' });
  });

  it('generateBundle() emits an empty sharedDeps array when nothing shared was imported', () => {
    projectRoot = makeProject(true);
    const plugin = subgameBuildPlugin({ projectRoot, engineApi: 1 });
    const emitted: { fileName: string; source: string }[] = [];
    const ctx = { emitFile: (asset: { fileName: string; source: string }) => emitted.push(asset) };
    (plugin.generateBundle as (this: typeof ctx) => void).call(ctx);
    expect(JSON.parse(emitted[0].source).sharedDeps).toEqual([]);
  });
});

describe('subgameOutDir', () => {
  it('is a sibling of dist/ and ads/, never colliding with either', () => {
    const out = subgameOutDir('/repo/games/foo');
    expect(out).toBe(path.join('/repo/games/foo', 'subgame-dist'));
    expect(out).not.toContain(`${path.sep}dist`);
    expect(out).not.toContain(`${path.sep}ads`);
  });
});

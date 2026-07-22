/**
 * handleHotUpdate contract — the rule that decides whether a file change reaches the
 * running editor.
 *
 * WHY THIS FILE EXISTS. Editing `games/<id>/runtime/*.ts` used to have NO effect on a
 * running dev editor: Vite recompiled it, but the update propagated up the static
 * `virtual:modoki-games` chain to `/app/App.tsx`, which is a Fast Refresh boundary and
 * self-accepts — while the editor's ACTUAL game came from a separate `@vite-ignore`
 * dynamic import whose URL never changes. Net effect: the editor silently served a stale
 * build, which cost a real session re-diagnosing an already-fixed sling bug. Now such a
 * change emits `modoki:game-code-changed` and the renderer reloads.
 *
 * The three behaviours pinned here, and why each matters:
 *   1. ASSET-root files stay suppressed (`[]`). This is load-bearing and predates the
 *      feature — without it a scene Cmd+S full-reloads the whole editor.
 *   2. GAME CODE emits the reload signal. Regression guard for the bug above.
 *   3. Everything else delegates to Vite (`undefined`).
 *
 * NON-VACUITY. `findAssetRoots` always contributes the engine's own `/modoki/assets`
 * root, so `assetRoots` is never empty; a fixture that silently failed to register would
 * still let the "game code" assertions pass for the WRONG reason. The first test therefore
 * asserts a KNOWN in-fixture asset path is suppressed, so a broken fixture fails loudly
 * instead of quietly making the rest of the file meaningless.
 *
 * Style follows engine/tests/plugins/healNativeConfig.test.ts: a real mkdtemp fixture
 * driven through the real `configResolved`, with the env var saved/restored so a dev box
 * that exports MODOKI_PROJECT cannot redirect the test at a real game.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assetScannerPlugin, isGameCodeFile } from '../../plugins/vite-asset-scanner';

/** Vite hands handleHotUpdate a POSIX-normalized path even on Windows. */
const posix = (p: string) => p.split(path.sep).join('/');

type WsMessage = { type: string; event?: string; data?: unknown };
interface Hooked {
  configResolved: (c: { root: string }) => void;
  configureServer: (s: unknown) => void;
  handleHotUpdate: (ctx: { file: string }) => unknown[] | undefined;
}

let projectRoot: string;
let savedProject: string | undefined;
let sent: WsMessage[];

/** Build the plugin and drive the REAL configResolved + configureServer, so the test
 *  covers MODOKI_PROJECT → findAssetRoots/findGamesEntry → the hook, not just a string
 *  compare against a hand-injected roots array. */
function armedPlugin(): Hooked {
  const p = assetScannerPlugin() as unknown as Hooked;
  p.configResolved({ root: path.join(projectRoot, 'engine') });
  sent = [];
  p.configureServer({
    // Only `send` is asserted on; `on` exists because configureServer subscribes to the
    // agent-bridge channels (modoki:schema / modoki:response) on the same socket.
    ws: { send: (m: WsMessage) => { sent.push(m); }, on: () => {} },
    watcher: { add: () => {}, on: () => {} },
    middlewares: { use: () => {} },
    httpServer: null,
  });
  return p;
}

beforeEach(() => {
  // realpathSync: macOS /var → /private/var, which would defeat the prefix test.
  projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-hmr-')));
  // A flat one-game project: <root>/game.ts is the entry, <root>/runtime/assets the
  // asset root (findAssetRoots). Note assets live INSIDE runtime/ — that adjacency is
  // the whole trap this rule has to get right.
  fs.mkdirSync(path.join(projectRoot, 'runtime/assets/scenes'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'runtime/field'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'runtime/assets/scenes/main.json'), '{"entities":[]}');
  fs.writeFileSync(path.join(projectRoot, 'game.ts'), 'export const game = {};');
  fs.writeFileSync(path.join(projectRoot, 'runtime/systems.ts'), 'export function s(){}');
  fs.writeFileSync(path.join(projectRoot, 'runtime/field/rebuildField.ts'), 'export function r(){}');
  fs.writeFileSync(path.join(projectRoot, 'tests/game.test.ts'), 'export {}');
  fs.writeFileSync(path.join(projectRoot, 'project.config.json'), '{"name":"hmr-fixture"}');

  savedProject = process.env.MODOKI_PROJECT;
  process.env.MODOKI_PROJECT = projectRoot;
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
  if (savedProject === undefined) delete process.env.MODOKI_PROJECT;
  else process.env.MODOKI_PROJECT = savedProject;
});

const reloadSignals = () => sent.filter((m) => m.event === 'modoki:game-code-changed');

/** Assert the FULL wire shape, not just the event name. Vite's client dispatches
 *  `hot.on(...)` handlers only for `type: 'custom'`, and the renderer reads `data.file` —
 *  so a message with the right event but the wrong type reaches nobody, and game code goes
 *  stale again with every test still green. (Proven by mutation: sending
 *  `{type:'full-reload', event:'modoki:game-code-changed'}` passed the event-only check.) */
function expectReloadSignal(file: string): void {
  expect(sent).toContainEqual({
    type: 'custom',
    event: 'modoki:game-code-changed',
    data: { file },
  });
}

describe('assetScannerPlugin.handleHotUpdate', () => {
  it('NON-VACUITY GUARD: the fixture really registered an asset root', () => {
    // If this fails, every other assertion below is meaningless — assetRoots is never
    // empty (the engine's own root is always added), so a broken fixture would otherwise
    // let the game-code cases pass by accident.
    const p = armedPlugin();
    const scene = posix(path.join(projectRoot, 'runtime/assets/scenes/main.json'));
    expect(p.handleHotUpdate({ file: scene })).toEqual([]);
  });

  it('suppresses HMR for scene JSON under an asset root, and sends NO reload', () => {
    const p = armedPlugin();
    const scene = posix(path.join(projectRoot, 'runtime/assets/scenes/main.json'));
    expect(p.handleHotUpdate({ file: scene })).toEqual([]);
    // The regression that matters: a Cmd+S must not reload the editor.
    expect(reloadSignals()).toHaveLength(0);
  });

  it('signals a reload for game code — the entry and nested runtime modules', () => {
    const p = armedPlugin();
    for (const rel of ['game.ts', 'runtime/systems.ts', 'runtime/field/rebuildField.ts']) {
      sent = [];
      const file = posix(path.join(projectRoot, rel));
      expect(p.handleHotUpdate({ file })).toEqual([]);
      expect(reloadSignals(), `expected a reload signal for ${rel}`).toHaveLength(1);
      expectReloadSignal(file); // the WIRE SHAPE the renderer actually consumes
    }
  });

  it('suppresses a .ts under an asset root at the PLUGIN level, not just in the predicate', () => {
    // Pins the "ORDER IS LOAD-BEARING" claim in handleHotUpdate: the asset-root branch runs
    // FIRST. Previously only covered for .json, which the game-code rule would have ignored
    // anyway — so it could not have caught a reordering.
    fs.writeFileSync(path.join(projectRoot, 'runtime/assets/generated.ts'), 'export {}');
    const p = armedPlugin();
    const file = posix(path.join(projectRoot, 'runtime/assets/generated.ts'));
    expect(p.handleHotUpdate({ file })).toEqual([]);
    expect(reloadSignals()).toHaveLength(0);
  });

  it('ignores the game\'s own unit tests and its non-code files', () => {
    const p = armedPlugin();
    for (const rel of ['tests/game.test.ts', 'project.config.json']) {
      sent = [];
      p.handleHotUpdate({ file: posix(path.join(projectRoot, rel)) });
      expect(reloadSignals(), `${rel} should not reload the editor`).toHaveLength(0);
    }
  });

  it('MONOREPO MODE: no project game entry ⇒ the rule is inert, engine edits Fast Refresh', () => {
    // THE REGRESSION THIS EXISTS FOR. With MODOKI_PROJECT unset, configResolved sets
    // projectRoot to the REPO root. If gameCodeRoot were anchored there instead of on the
    // game entry, every engine/** edit would match isGameCodeFile and force-reload the
    // editor — destroying Fast Refresh for all editor development.
    //
    // Without this case the suite is VACUOUS on exactly that point: findGamesEntry only
    // probes <projectRoot>/game.{ts,tsx}, so wherever an entry EXISTS
    // `path.dirname(entry.path) === projectRoot` by construction — the other fixture can
    // never tell the two expressions apart. (Verified: patching the plugin to
    // `gameCodeRoot = projectRoot` left all other tests green.)
    delete process.env.MODOKI_PROJECT;
    fs.mkdirSync(path.join(projectRoot, 'engine/app'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'games/foo'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'engine/app/App.tsx'), 'export default function A(){}');
    fs.writeFileSync(path.join(projectRoot, 'games/foo/game.ts'), 'export const game = {};');
    fs.rmSync(path.join(projectRoot, 'game.ts')); // no <repoRoot>/game.ts ⇒ no entry

    const p = armedPlugin(); // config.root = <root>/engine ⇒ projectRoot = <root>

    expect(p.handleHotUpdate({ file: posix(path.join(projectRoot, 'engine/app/App.tsx')) }))
      .toBeUndefined();
    expect(reloadSignals(), 'an engine edit must never force-reload the editor').toHaveLength(0);

    // And with no project open the rule is inert even for a game file under the repo.
    expect(p.handleHotUpdate({ file: posix(path.join(projectRoot, 'games/foo/game.ts')) }))
      .toBeUndefined();
    expect(reloadSignals()).toHaveLength(0);
  });

  it('delegates unrelated files to Vite', () => {
    const p = armedPlugin();
    const outside = posix(path.join(projectRoot, '..', 'somewhere-else', 'x.ts'));
    expect(p.handleHotUpdate({ file: outside })).toBeUndefined();
    expect(reloadSignals()).toHaveLength(0);
  });
});

describe('isGameCodeFile', () => {
  const ROOT = '/repo/games/sling';
  const ASSETS = [{ absDir: '/repo/games/sling/runtime/assets' }];

  it('matches .ts/.tsx under the game root', () => {
    expect(isGameCodeFile('/repo/games/sling/game.ts', ROOT, ASSETS)).toBe(true);
    expect(isGameCodeFile('/repo/games/sling/runtime/systems.ts', ROOT, ASSETS)).toBe(true);
    expect(isGameCodeFile('/repo/games/sling/runtime/ui/Hud.tsx', ROOT, ASSETS)).toBe(true);
  });

  it('never matches under an asset root, even for a .ts', () => {
    // Belt-and-braces: the caller already returns early for asset-root files, but this
    // rule must be independently safe — the asset dir is nested INSIDE runtime/.
    expect(isGameCodeFile('/repo/games/sling/runtime/assets/scenes/a.json', ROOT, ASSETS)).toBe(false);
    expect(isGameCodeFile('/repo/games/sling/runtime/assets/gen.ts', ROOT, ASSETS)).toBe(false);
  });

  it('is inert with no game root (monorepo mode at the repo root)', () => {
    // Guards the worst regression this rule could cause: anchoring on projectRoot instead
    // of the game entry would force-reload the editor on every engine/** edit.
    expect(isGameCodeFile('/repo/engine/app/App.tsx', null, ASSETS)).toBe(false);
  });

  it('does not match a prefix-sharing sibling directory', () => {
    expect(isGameCodeFile('/repo/games/sling-evil/game.ts', ROOT, ASSETS)).toBe(false);
  });

  it('is separator-agnostic (Windows: POSIX ctx.file vs backslash roots)', () => {
    // The exact shape of the original Windows bug, where a raw startsWith never matched
    // and every scene save full-reloaded the editor.
    expect(isGameCodeFile(
      'C:/repo/games/sling/runtime/systems.ts',
      'C:\\repo\\games\\sling',
      [{ absDir: 'C:\\repo\\games\\sling\\runtime\\assets' }],
    )).toBe(true);
  });

  it('skips non-code and test files', () => {
    expect(isGameCodeFile('/repo/games/sling/project.config.json', ROOT, ASSETS)).toBe(false);
    expect(isGameCodeFile('/repo/games/sling/tests/sling.test.ts', ROOT, ASSETS)).toBe(false);
    expect(isGameCodeFile('/repo/games/sling/test/helper.ts', ROOT, ASSETS)).toBe(false);
    expect(isGameCodeFile('/repo/games/sling/runtime/tests/util.ts', ROOT, ASSETS)).toBe(false);
  });

  it('matches the tests/ exclusion RELATIVE to the game root, not the absolute path', () => {
    // A project that merely LIVES under an ancestor named test/ or tests/ must still get
    // game-code reload. Matching the absolute path silently disabled the whole rule for
    // every file in such a project.
    const under = '/Users/x/tests/mygame';
    const assets = [{ absDir: '/Users/x/tests/mygame/runtime/assets' }];
    expect(isGameCodeFile('/Users/x/tests/mygame/runtime/systems.ts', under, assets)).toBe(true);
    expect(isGameCodeFile('/Users/x/tests/mygame/game.ts', under, assets)).toBe(true);
    // …while the game's OWN tests/ dir is still excluded.
    expect(isGameCodeFile('/Users/x/tests/mygame/tests/a.test.ts', under, assets)).toBe(false);
  });
});

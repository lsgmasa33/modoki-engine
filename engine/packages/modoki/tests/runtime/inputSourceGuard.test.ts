/** Input-source guard (Part A6 of the input-and-ui-focus plan).
 *
 *  Console/controller readiness rests on ONE convention: game/UI logic reads input
 *  from the canonical `Input` ECS resource, never from `window`/`document`/
 *  `navigator.getGamepads` directly. Input *sources* (keyboard/pointer/gamepad) are
 *  the only sanctioned place that touches the DOM/gamepad APIs, and they live under
 *  `runtime/input/`. This test fails the build if any other file in the engine
 *  runtime tree or a game's own runtime tree reads raw DOM/gamepad input — so the
 *  "input through traits" discipline can't silently erode as more games are authored
 *  (the compounding stops by construction, sibling to the determinism guard).
 *
 *  The allowlist is EXPLICIT and reviewed — each entry is a deliberate, documented
 *  exception (dev-only tooling, not gameplay input), not a silent pass. */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(HERE, '../../../../..');
const ENGINE_RUNTIME = join(HERE, '../../src/runtime');
const GAMES = join(REPO_ROOT, 'games');

/** Raw DOM/gamepad input reads that belong ONLY in `runtime/input/` sources. Applies
 *  to the whole engine runtime tree + every game runtime. */
const FORBIDDEN = /navigator\.getGamepads|\bgetGamepads\s*\(|addEventListener\(\s*['"]key(down|up|press)['"]|['"]gamepadconnected['"]/;

/** Raw pointer/mouse/touch listeners — forbidden in GAME runtimes only (games must
 *  route tap/drag through the pointer source → `Input` resource). NOT applied to the
 *  engine runtime tree, where dev-only debug tooling (`debug/useDraggable`,
 *  `FloatingWidget`) legitimately drags widgets with pointer events. A game that
 *  needs pointer input reads the Input accessors (`pointerPressed`/`pointerDrag`/…). */
const FORBIDDEN_POINTER = /addEventListener\(\s*['"](pointer|mouse|touch)/;

/** Repo-relative files permitted to read raw input, each for a documented reason.
 *  Keep this SMALL — a new gameplay/UI entry almost certainly means input should be
 *  routed through the Input resource instead. */
const ALLOW = new Set<string>([
  // Dev-only debug menu toggled by Ctrl/Cmd+Shift+D — editor tooling, not gameplay
  // input feeding traits, so it stays a direct window listener.
  'games/3d-test/runtime/ui/DebugMenu.tsx',
  // Engine in-game debug menu, toggled by F12 / 3-finger tap — a debug-overlay UI
  // gesture (build-flag-gated, tree-shaken out when off), not gameplay input feeding
  // traits, so it stays a direct window listener. See docs/debug-menu-plan.md.
  'engine/packages/modoki/src/runtime/debug/DebugMenu.tsx',
]);

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** All .ts/.tsx (non-test) files under `dir`, skipping any path segment `skip`. */
function tsFiles(dir: string, skip?: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (skip && name === skip) continue;
      out.push(...tsFiles(full, skip));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/** Engine runtime (minus the sanctioned `input/` sources). */
function engineFiles(): string[] {
  return tsFiles(ENGINE_RUNTIME, 'input');
}

/** Every game's runtime tree (minus any local `input/` folder). */
function gameFiles(): string[] {
  const files: string[] = [];
  if (existsSync(GAMES)) {
    for (const game of readdirSync(GAMES)) {
      files.push(...tsFiles(join(GAMES, game, 'runtime'), 'input'));
    }
  }
  return files;
}

describe('input source guard (Part A6)', () => {
  it('no raw DOM/gamepad input reads outside runtime/input/ sources', () => {
    const offenders = [...engineFiles(), ...gameFiles()]
      .filter((f) => FORBIDDEN.test(stripComments(readFileSync(f, 'utf8'))))
      .map((f) => relative(REPO_ROOT, f).replace(/\\/g, '/'))
      .filter((rel) => !ALLOW.has(rel));
    expect(
      offenders,
      `read input from the Input ECS resource instead, or (if genuinely a source) put it under runtime/input/. Reviewed exceptions go in ALLOW:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('no raw pointer/mouse/touch listeners in game runtimes (use the Input pointer source)', () => {
    const offenders = gameFiles()
      .filter((f) => FORBIDDEN_POINTER.test(stripComments(readFileSync(f, 'utf8'))))
      .map((f) => relative(REPO_ROOT, f).replace(/\\/g, '/'))
      .filter((rel) => !ALLOW.has(rel));
    expect(
      offenders,
      `read tap/drag from the Input resource (pointerPressed/pointerDown/pointerDrag/…) instead of adding raw pointer listeners:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('the allowlist stays small (review pressure)', () => {
    expect(ALLOW.size).toBeLessThanOrEqual(3);
  });
});

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
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments, assertScanIsSane } from '../helpers/sourceScanner';
import { assertExemptionLedger } from '../helpers/exemptionLedger';
import { repoFiles } from '../../../../scripts/repoCorpus.mjs';

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

/** Raw input reads (the `FORBIDDEN` ban) permitted in a file, each for a documented reason.
 *  Keep this SMALL — a new gameplay/UI entry almost certainly means input should be
 *  routed through the Input resource instead.
 *
 *  ⚠️ **Per OCCURRENCE and per BAN (#1123/#1128).** This was one `Set<file>` consulted by BOTH
 *  guards below, so a row reasoned about a keyboard toggle also pardoned any raw POINTER listener
 *  added to the same file, and either file could gain a second, gameplay-feeding key listener under
 *  a reason about a debug menu. Rows now key `file::token`, carry a count, and apply to
 *  `FORBIDDEN` only; `FORBIDDEN_POINTER` has no pardons at all. */
const ALLOW: ReadonlyArray<{ item: string; count?: number; reason: string }> = [
  {
    item: "games/3d-test/runtime/ui/DebugMenu.tsx::addEventListener('keydown'",
    reason: 'Dev-only debug menu toggled by Ctrl/Cmd+Shift+D — editor tooling, not gameplay input '
      + 'feeding traits, so it stays a direct window listener.',
  },
  {
    item: "engine/packages/modoki/src/runtime/debug/DebugMenu.tsx::addEventListener('keydown'",
    reason: 'Engine in-game debug menu, toggled by F12 / 3-finger tap — a debug-overlay UI gesture '
      + '(build-flag-gated, tree-shaken out when off), not gameplay input feeding traits, so it '
      + 'stays a direct window listener. See docs/debug-menu.md.',
  },
];

/** The FILE a row names — for the snapshot filter and the "reached" pin below. */
const rowFile = (item: string): string => item.slice(0, item.indexOf('::'));

/** Every match of `re` in `f.code`, one entry per occurrence. The token is the match with its
 *  whitespace dropped and quotes spelled `'`, so a re-spelling cannot dodge a row.
 *
 *  ⚠️ **Matched over the WHOLE file, never line by line.** Both bans rely on `\s*` after the `(`,
 *  which must cross a newline: a formatter wraps `addEventListener(\n  'keydown',` routinely. The
 *  first per-occurrence version split on `\n` first and went green on exactly that shape, where the
 *  old whole-file `.test()` had been red (close-out review of #1128). The line is derived from the
 *  match offset instead. */
function occurrences(files: { rel: string; code: string }[], re: RegExp): Array<{ item: string; site: string }> {
  const all = new RegExp(re.source, 'g');
  const out: Array<{ item: string; site: string }> = [];
  for (const f of files) {
    for (const m of f.code.matchAll(all)) {
      const token = m[0].replace(/\s+/g, '').replace(/"/g, "'");
      const line = f.code.slice(0, m.index).split('\n').length;
      out.push({ item: `${f.rel}::${token}`, site: `${f.rel}:${line} — ${token}` });
    }
  }
  return out;
}

// Comment stripping is the shared scanner (#419) — see sourceScanner.ts.

/** Read + strip a set of absolute file paths once, keeping raw alongside stripped so the
 *  sanity check and the guards can both use it without re-reading/re-scanning. */
function scanAll(files: string[]): { abs: string; rel: string; raw: string; code: string }[] {
  return files.map((f) => {
    const raw = readFileSync(f, 'utf8');
    return { abs: f, rel: relative(REPO_ROOT, f).replace(/\\/g, '/'), raw, code: stripComments(raw) };
  });
}

/** All .ts/.tsx (non-test) files under `dir`, skipping any path segment `skip`. */
function tsFiles(dir: string, skip?: string): string[] {
  if (!existsSync(dir)) return [];
  return repoFiles({
    under: dir,
    match: (rel) => /\.tsx?$/.test(rel) && !/\.test\.tsx?$/.test(rel),
    ...(skip ? { exclude: [skip] } : {}),
    floor: 0,
  }).map(({ abs }) => abs);
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
  const engine = scanAll(engineFiles());
  const games = scanAll(gameFiles());

  // Length/line parity is true by construction for the scanner (sourceScanner.ts) — this pins
  // against a regression to a regex stripper. The forward oracle lives in sourceScanner.test.ts.
  it('the comment strip is length- and line-exact (a regex stripper would not be)', () => {
    for (const f of [...engine, ...games]) assertScanIsSane(f.raw, f.code, f.rel);
  });

  it('no raw DOM/gamepad input reads outside runtime/input/ sources', () => {
    assertExemptionLedger({
      label: 'ALLOW in inputSourceGuard',
      population: occurrences([...engine, ...games], FORBIDDEN),
      // A checkout with no `games/` (the public OSS snapshot) reaches no games file, so a games row
      // there is not over-blessed — it names a root this checkout does not have.
      exempt: ALLOW.filter((r) => (rowFile(r.item).startsWith('games/') ? games.length > 0 : true)),
      // The engine DebugMenu's own listener is always present, snapshot included; liveness beyond
      // that is the engine-scan pin below.
      floor: 1,
      fix: 'read input from the Input ECS resource instead, or (if genuinely a source) put it under '
        + 'runtime/input/. A reviewed exception goes in ALLOW, per occurrence, with its reason.',
    });
  });

  it('no raw pointer/mouse/touch listeners in game runtimes (use the Input pointer source)', () => {
    // No ledger: nothing is pardoned from this ban, and a pardon for it must be written as its OWN
    // row set — never borrowed from `ALLOW`, which is how a keyboard reason used to cover it.
    const offenders = occurrences(games, FORBIDDEN_POINTER).map((o) => o.site);
    expect(
      offenders,
      `read tap/drag from the Input resource (pointerPressed/pointerDown/pointerDrag/…) instead of adding raw pointer listeners:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('the pointer detector is alive — it flags a raw listener and ignores the Input accessors (synthetic)', () => {
    // The ban above has no population on a clean tree, so its detector could stop matching with
    // nothing going red. Pin both sides on synthetic input instead of a count of survivors.
    const raw = [{ rel: 'games/x/runtime/a.ts', code: "el.addEventListener( \"pointerdown\", f);\nel.addEventListener('touchmove', g);" }];
    expect(occurrences(raw, FORBIDDEN_POINTER).map((o) => o.item)).toEqual([
      "games/x/runtime/a.ts::addEventListener('pointer",
      "games/x/runtime/a.ts::addEventListener('touch",
    ]);
    expect(occurrences([{ rel: 'games/x/runtime/b.ts', code: 'if (pointerPressed(world)) jump();' }], FORBIDDEN_POINTER)).toEqual([]);
  });

  it('both detectors see a listener a formatter WRAPPED across lines (synthetic)', () => {
    // The shape a per-line match cannot see — see `occurrences`. Same token as the one-line spelling,
    // so a wrapped call spends (or fails) the same row rather than dodging it.
    const wrapped = "window.addEventListener(\n  'keydown',\n  onKey,\n);\nel.addEventListener(\n  \"pointerup\", f);";
    const f = [{ rel: 'games/x/runtime/c.ts', code: wrapped }];
    expect(occurrences(f, FORBIDDEN).map((o) => o.site)).toEqual(["games/x/runtime/c.ts:1 — addEventListener('keydown'"]);
    expect(occurrences(f, FORBIDDEN_POINTER).map((o) => o.site)).toEqual(["games/x/runtime/c.ts:5 — addEventListener('pointer"]);
  });

  // ── (#866) Non-vacuity pins ────────────────────────────────────────────────────────────────
  // Both guards above collect offenders and expect an EMPTY list, which is the shape that goes
  // GREEN when the scan breaks rather than red. This file is one of #866's sites: it discards
  // git's own `rel` (it maps the rows down to `abs` — see `engineFiles()` above) and rebuilds
  // it with `relative(REPO_ROOT, …)`
  // against a root derived from `import.meta.url`. Those two derivations coincide on macOS, so a
  // Mac gate cannot see it — but drive-letter case, a `subst`ed or symlinked checkout, or an 8.3
  // short path make them disagree, and then every `rel` is wrong, `ALLOW` matches nothing, and
  // both guards pass having checked nothing at all. Only these two pins can tell that apart.
  it('the scan is not vacuous — it reaches the engine runtime', () => {
    expect(
      engine.length,
      'the engine runtime scan reached almost nothing — the enumeration is broken, not the repo clean',
    ).toBeGreaterThan(100);
  });

  it('every ALLOW key names a file the scan actually reached — the allowlist is load-bearing', () => {
    const scanned = new Set([...engine, ...games].map((f) => f.rel));
    // A checkout with no `games/` (the public OSS snapshot) legitimately reaches no games file, so
    // only the keys whose root was actually scanned are required to match.
    const required = ALLOW.map((r) => rowFile(r.item)).filter((k) => (k.startsWith('games/') ? games.length > 0 : true));
    const unmatched = required.filter((k) => !scanned.has(k));
    expect(
      unmatched,
      'These ALLOW entries match no scanned file. Either the path is stale, or the `rel` derivation '
      + 'broke (#866) — in which case both guards above are now passing vacuously:\n'
      + `${unmatched.join('\n')}`,
    ).toEqual([]);
  });

  it('the allowlist stays small (review pressure)', () => {
    expect(ALLOW.reduce((n, r) => n + (r.count ?? 1), 0)).toBeLessThanOrEqual(2);
  });
});

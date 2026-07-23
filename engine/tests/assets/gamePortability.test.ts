import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverProjects } from '../../scripts/projectRoots.mjs';

/**
 * PORTABILITY GUARD — a game project must be SELF-CONTAINED (#29): it's opened
 * STANDALONE (often copied out of the repo), so no file under games/<id>/ may
 * import via a relative path that escapes its OWN folder — into the engine tree or
 * a sibling game. Such a path only resolves while the game sits inside the repo;
 * copied out, Vite fails with e.g. "failed to resolve ../../../../engine/app/...".
 * Games reach the engine via the `@modoki/engine` package specifier (the editor
 * resolves it regardless of the game's on-disk location), never a relative path.
 *
 * Concrete regression this guards: `useGameStore` was imported from
 * `../../../../engine/app/store/gameStore` (moved to `@modoki/engine/runtime`).
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
// Every project under BOTH roots — games/ (internal) and demos/ (publishable).
// A demo is copied out of the repo even more often than a game is, so the
// self-containment guard matters at least as much there.
const projects = discoverProjects(repoRoot);

// KNOWN, TRACKED cross-game coupling still to resolve: chess reuses llm-test's
// on-device-LLM service (LLMService / initLLMSession). Until that's extracted to a
// shared home, allow EXACTLY these — any NEW escape still fails the guard. Keyed by
// `<repo-rel file> :: <import specifier>`.
const KNOWN_ESCAPES = new Set([
  'games/chess/runtime/ChessManager.ts :: ../../llm-test/runtime/services/initLLMSession',
  'games/chess/runtime/ChessManager.ts :: ../../llm-test/runtime/services/LLMService',
  'games/chess/runtime/ai/ChessAI.ts :: ../../../llm-test/runtime/services/LLMService',
]);

const skip = (p: string) => /node_modules|[/\\]dist[/\\]|[/\\]\.cache[/\\]/.test(p);
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (skip(p)) continue;
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Every relative import (static or dynamic) in a game file that resolves OUTSIDE
 *  that game's own folder, as `<repo-rel file> :: <specifier>`. */
function escapingImports(): string[] {
  const out: string[] = [];
  const importRe = /(?:from|import\()\s*['"](\.[^'"]+)['"]/g;
  for (const proj of projects) {
    const gameRoot = proj.dir;
    for (const file of walk(gameRoot)) {
      const src = fs.readFileSync(file, 'utf8');
      let m: RegExpExecArray | null;
      while ((m = importRe.exec(src)) !== null) {
        const resolved = path.resolve(path.dirname(file), m[1]);
        if (!resolved.startsWith(gameRoot + path.sep)) {
          // Forward-slash the repo-relative file so the key matches the canonical
          // KNOWN_ESCAPES entries on Windows too (path.relative yields backslashes there).
          out.push(`${path.relative(repoRoot, file).replace(/\\/g, '/')} :: ${m[1]}`);
        }
      }
    }
  }
  return out;
}

// Skip when NO project root exists (the OSS public repo ships engine-only — nothing to
// check portability of). docs/engine-oss-publishing.md.
describe.skipIf(projects.length === 0)('game project portability (self-contained — no relative escapes)', () => {
  it('no game imports outside its own folder except the known tracked coupling', () => {
    const unexpected = escapingImports().filter((e) => !KNOWN_ESCAPES.has(e));
    expect(
      unexpected,
      `Games must reach the engine via '@modoki/engine', not a relative path that escapes the game folder:\n${unexpected.join('\n')}`,
    ).toEqual([]);
  });

  it('the allowlist has no stale entries (prune when a coupling is fixed)', () => {
    const escapes = new Set(escapingImports());
    const stale = [...KNOWN_ESCAPES].filter((e) => !escapes.has(e));
    expect(stale, `KNOWN_ESCAPES lists escapes that no longer exist — remove them:\n${stale.join('\n')}`).toEqual([]);
  });

  // Native projects must be self-contained too: the iOS pbxproj once referenced
  // GameDebugPlugin.swift by a repo-relative path (../../../../engine/packages/…),
  // which broke a standalone build ("GameDebug plugin is not implemented on ios").
  // Native code a game compiles must come from the game's OWN node_modules, never
  // the repo. (Android already does this via capacitor.settings.gradle.)
  it('no committed iOS pbxproj references the repo engine via a path (use node_modules)', () => {
    const offenders: string[] = [];
    for (const proj of projects) {
      const iosDir = path.join(proj.dir, 'ios');
      if (!fs.existsSync(iosDir)) continue;
      for (const file of walk(iosDir).filter((f) => f.endsWith('.pbxproj'))) {
        const src = fs.readFileSync(file, 'utf8');
        // A `path = "…"` entry that reaches the repo's engine/packages tree.
        const m = src.match(/path = "[^"]*engine\/packages\/[^"]*"/g);
        if (m) offenders.push(`${path.relative(repoRoot, file)}: ${m.join(', ')}`);
      }
    }
    expect(
      offenders,
      `iOS pbxproj must reference plugin sources via the game's node_modules, not the repo:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});

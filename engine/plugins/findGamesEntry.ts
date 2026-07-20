/** Locate a project's game-code entry point (one project = one game, #29): a flat
 *  project exposes `game.{ts,tsx}` at its root exporting a single
 *  `game: GameDefinition`. The engine synthesizes the ALL_GAMES/GAMES shape from
 *  it. Import-free so both the Vite plugin (virtual module) and the Electron
 *  backend router can share it. */

import fs from 'fs';
import path from 'path';

export type GamesEntryKind = 'single';

export interface GamesEntry {
  /** Absolute path to the entry module (no extension guessing needed by callers). */
  path: string;
  kind: GamesEntryKind;
}

function firstExisting(base: string): string | null {
  if (fs.existsSync(base + '.ts')) return base + '.ts';
  if (fs.existsSync(base + '.tsx')) return base + '.tsx';
  return null;
}

export function findGamesEntry(projectRoot: string): GamesEntry | null {
  const single = firstExisting(path.join(projectRoot, 'game'));
  if (single) return { path: single, kind: 'single' };
  return null;
}

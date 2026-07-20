/**
 * "New Project" scaffolder. Copies the engine's starter template
 * (`engine/templates/starter`) into a destination folder, substituting the
 * project tokens and minting fresh scene GUIDs, so the result is a complete,
 * runnable flat project the editor can open immediately (hello-world scene).
 *
 * Pure Node (no Electron import) so it's unit-testable and reusable by the CLI
 * scaffold script. The caller passes `templateDir` explicitly — main.ts resolves
 * it under REPO_ROOT (which is app.asar.unpacked when packaged), keeping this
 * module independent of packaging.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface ScaffoldOptions {
  /** Human-readable project name (drives id/appId/title). */
  name: string;
  /** Absolute path to the template folder (engine/templates/starter). */
  templateDir: string;
}

export interface ScaffoldResult {
  targetDir: string;
  gameId: string;
  appId: string;
  name: string;
}

/** Token → replacement, substituted in every copied text file. */
const TOKEN = { id: '__GAME_ID__', name: '__GAME_NAME__', appId: '__APP_ID__' } as const;
/** Extensions whose contents get token substitution (others copy verbatim). */
const TEXT_EXT = new Set(['.ts', '.tsx', '.json', '.md', '.txt']);

/** "My Cool Game" → "my-cool-game" (a valid game id / folder slug). */
export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'game';
}

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
  return out;
}

/**
 * Scaffold a new project at `targetDir` from the starter template. Refuses if
 * `targetDir` exists and is non-empty. Returns the resolved identity.
 */
export function scaffoldProject(targetDir: string, opts: ScaffoldOptions): ScaffoldResult {
  const dest = path.resolve(targetDir);
  if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0) {
    throw new Error(`Refusing to scaffold: ${dest} exists and is not empty.`);
  }
  if (!fs.existsSync(opts.templateDir)) {
    throw new Error(`Template not found: ${opts.templateDir}`);
  }

  const name = opts.name.trim() || path.basename(dest);
  const gameId = slugify(name);
  const appId = `com.example.${gameId.replace(/-/g, '')}`;

  // Copy the whole template, then rewrite tokens + scene GUIDs in place.
  fs.cpSync(opts.templateDir, dest, { recursive: true });

  for (const file of walkFiles(dest)) {
    if (!TEXT_EXT.has(path.extname(file))) continue;
    let text = fs.readFileSync(file, 'utf8');
    text = text.split(TOKEN.id).join(gameId).split(TOKEN.name).join(name).split(TOKEN.appId).join(appId);
    fs.writeFileSync(file, text);
  }

  // Fresh GUIDs for the starting scene so two projects from the template don't
  // share entity identity. parentId references a parent's guid (a string), so a
  // global old→new string remap over the file text keeps the hierarchy intact.
  const scenePath = path.join(dest, 'runtime', 'assets', 'scenes', 'main.json');
  if (fs.existsSync(scenePath)) {
    let sceneText = fs.readFileSync(scenePath, 'utf8');
    const scene = JSON.parse(sceneText) as {
      id?: string;
      entities?: { traits?: { EntityAttributes?: { guid?: string } } }[];
    };
    const olds = new Set<string>();
    if (typeof scene.id === 'string') olds.add(scene.id);
    for (const e of scene.entities ?? []) {
      const g = e.traits?.EntityAttributes?.guid;
      if (typeof g === 'string' && g) olds.add(g);
    }
    for (const oldGuid of olds) sceneText = sceneText.split(oldGuid).join(randomUUID());
    fs.writeFileSync(scenePath, sceneText);
  }

  return { targetDir: dest, gameId, appId, name };
}

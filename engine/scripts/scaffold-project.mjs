#!/usr/bin/env node
/**
 * Modoki project scaffold (CLI). Creates a new flat game project by copying the
 * engine's starter template (`engine/templates/starter`) and substituting the
 * project tokens — the SAME template + token contract the editor's
 * File → New Project uses (engine/electron/newProject.ts). Produces a complete,
 * runnable hello-world project:
 *
 *   <dir>/
 *     game.ts · project.config.json · package.json · CLAUDE.md · README.md
 *     runtime/config.ts · runtime/setup.ts
 *     runtime/assets/scenes/main.json   — hello-world scene (camera + lights + title)
 *     runtime/assets/{models,textures,materials,prefabs}/.gitkeep
 *
 * Usage:  node engine/scripts/scaffold-project.mjs <target-dir> [project-name]
 * Then open the folder in the Modoki editor (File → Open Project).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = path.resolve(__dirname, '..', 'templates', 'starter');

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error('Usage: node engine/scripts/scaffold-project.mjs <target-dir> [project-name]');
  process.exit(1);
}
const targetDir = path.resolve(args[0]);
const name = (args[1] || path.basename(targetDir)).trim();
const gameId = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'game';
const appId = `com.example.${gameId.replace(/-/g, '')}`;

if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0) {
  console.error(`Refusing to scaffold: ${targetDir} exists and is not empty.`);
  process.exit(1);
}
if (!fs.existsSync(TEMPLATE_DIR)) {
  console.error(`Template not found: ${TEMPLATE_DIR}`);
  process.exit(1);
}

const TEXT_EXT = new Set(['.ts', '.tsx', '.json', '.md', '.txt']);
const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};

fs.cpSync(TEMPLATE_DIR, targetDir, { recursive: true });

for (const file of walk(targetDir)) {
  if (!TEXT_EXT.has(path.extname(file))) continue;
  let text = fs.readFileSync(file, 'utf8');
  text = text.split('__GAME_ID__').join(gameId).split('__GAME_NAME__').join(name).split('__APP_ID__').join(appId);
  fs.writeFileSync(file, text);
}

// Mint fresh scene GUIDs (parentId references a parent's guid string → global
// old→new text remap keeps the hierarchy intact).
const scenePath = path.join(targetDir, 'runtime', 'assets', 'scenes', 'main.json');
if (fs.existsSync(scenePath)) {
  let sceneText = fs.readFileSync(scenePath, 'utf8');
  const scene = JSON.parse(sceneText);
  const olds = new Set();
  if (typeof scene.id === 'string') olds.add(scene.id);
  for (const e of scene.entities ?? []) {
    const g = e?.traits?.EntityAttributes?.guid;
    if (typeof g === 'string' && g) olds.add(g);
  }
  for (const oldGuid of olds) sceneText = sceneText.split(oldGuid).join(randomUUID());
  fs.writeFileSync(scenePath, sceneText);
}

console.log(`✓ Scaffolded "${name}" at ${targetDir}`);
console.log('  open it in the Modoki editor (File → Open Project), then author with Claude.');

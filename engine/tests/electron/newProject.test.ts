/** newProject.scaffoldProject — copies the starter template into a destination,
 *  substitutes the project tokens, and mints fresh scene GUIDs. Pure Node (no
 *  Electron), so it runs headless against the REAL engine/templates/starter. */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaffoldProject, slugify } from '../../electron/newProject';

const TEMPLATE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../templates/starter');
const tmps: string[] = [];
function freshTmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-newproj-'));
  // mkdtemp makes the dir; scaffold wants an empty dir → use a child path.
  const target = path.join(d, 'proj');
  tmps.push(d);
  return target;
}
afterEach(() => { for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe('scaffoldProject', () => {
  it('copies the template and substitutes tokens', () => {
    const target = freshTmp();
    const res = scaffoldProject(target, { name: 'My Cool Game', templateDir: TEMPLATE_DIR });

    expect(res.gameId).toBe('my-cool-game');
    expect(res.appId).toBe('com.example.mycoolgame');
    expect(res.name).toBe('My Cool Game');

    for (const f of ['game.ts', 'project.config.json', 'package.json', 'runtime/config.ts', 'runtime/setup.ts', 'runtime/assets/scenes/main.json']) {
      expect(fs.existsSync(path.join(target, f)), f).toBe(true);
    }

    const cfg = JSON.parse(fs.readFileSync(path.join(target, 'project.config.json'), 'utf8'));
    expect(cfg.app.appId).toBe('com.example.mycoolgame');
    expect(cfg.app.appName).toBe('My Cool Game');
    // Fresh projects default to a LOCAL web build (webDeployMode 'none' → build to dist/ +
    // reveal, no GCS bucket needed) so Build → Web works out of the box. The global default is
    // 'gcs' (existing games rely on it to deploy), so the LOCAL default lives in the template.
    expect(cfg.build.webDeployMode).toBe('none');

    expect(fs.readFileSync(path.join(target, 'game.ts'), 'utf8')).toContain("id: 'my-cool-game'");
    expect(JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).name).toBe('@modoki-game/my-cool-game');

    // No placeholder tokens survive anywhere.
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out); else out.push(p);
      }
      return out;
    };
    for (const f of walk(target)) {
      if (!/\.(ts|json|md)$/.test(f)) continue;
      expect(fs.readFileSync(f, 'utf8'), f).not.toMatch(/__GAME_ID__|__GAME_NAME__|__APP_ID__/);
    }
  });

  it('mints fresh, unique scene GUIDs while preserving the parent hierarchy', () => {
    const target = freshTmp();
    scaffoldProject(target, { name: 'Alpha', templateDir: TEMPLATE_DIR });

    const scenePath = path.join(target, 'runtime', 'assets', 'scenes', 'main.json');
    const scene = JSON.parse(fs.readFileSync(scenePath, 'utf8'));
    const template = JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, 'runtime/assets/scenes/main.json'), 'utf8'));

    expect(scene.version).toBe(9);
    expect(scene.id).not.toBe(template.id);

    const guids = scene.entities.map((e: { traits: { EntityAttributes: { guid: string } } }) => e.traits.EntityAttributes.guid);
    expect(new Set(guids).size).toBe(guids.length); // all unique
    // None reused from the template.
    const templateGuids = new Set(template.entities.map((e: { traits: { EntityAttributes: { guid: string } } }) => e.traits.EntityAttributes.guid));
    for (const g of guids) expect(templateGuids.has(g)).toBe(false);

    // parentId references survive the remap: Title parents under HUD.
    const find = (name: string) => scene.entities.find((e: { name: string }) => e.name === name).traits.EntityAttributes;
    expect(find('Title').parentId).toBe(find('HUD').guid);
    expect(find('HUD').parentId).toBe(''); // root unchanged
  });

  it('refuses a non-empty destination', () => {
    const target = freshTmp();
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'existing.txt'), 'hi');
    expect(() => scaffoldProject(target, { name: 'X', templateDir: TEMPLATE_DIR })).toThrow(/not empty/);
  });

  it('slugify produces valid ids', () => {
    expect(slugify('My Cool Game')).toBe('my-cool-game');
    expect(slugify('  Spaces & Symbols!! ')).toBe('spaces-symbols');
    expect(slugify('')).toBe('game');
  });
});

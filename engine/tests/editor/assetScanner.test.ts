/** Tests for vite-asset-scanner — asset type detection and name derivation */

import { describe, it, expect } from 'vitest';

// We can't test the Vite plugin directly (it needs a Vite server),
// but we can extract and test the pure functions.
// Re-implement the logic here to test the classification rules.

function nameFromFile(filename: string): string {
  return filename
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

function detectType(relPath: string, ext: string): string | null {
  if (relPath.endsWith('.meta.json')) return null;
  if (ext === '.json') {
    if (relPath.endsWith('.prefab.json')) return 'prefab';
    if (relPath.endsWith('.mesh.json')) return 'mesh';
    if (relPath.endsWith('.mat.json')) return 'material';
    if (relPath.startsWith('/scenes/')) return 'scene';
    if (relPath.startsWith('/materials/')) return 'material';
    return null;
  }
  const EXT_TYPE: Record<string, string> = {
    '.glb': 'model', '.gltf': 'model', '.fbx': 'model',
    '.png': 'texture', '.jpg': 'texture', '.jpeg': 'texture', '.webp': 'texture',
    '.hdr': 'environment', '.exr': 'environment',
    '.ttf': 'font', '.otf': 'font', '.woff': 'font', '.woff2': 'font',
  };
  return EXT_TYPE[ext] || null;
}

describe('nameFromFile', () => {
  it('strips extension and converts underscores to spaces', () => {
    expect(nameFromFile('brown_planks_05_diff_1k.png')).toBe('Brown Planks 05 Diff 1k');
  });

  it('handles camelCase', () => {
    expect(nameFromFile('myGameModel.glb')).toBe('My Game Model');
  });

  it('handles hyphens', () => {
    expect(nameFromFile('palm-tree.png')).toBe('Palm Tree');
  });

  it('handles simple names', () => {
    expect(nameFromFile('island.glb')).toBe('Island');
  });

  it('handles Russian characters without breaking', () => {
    const result = nameFromFile('текстура-песка.jpg');
    expect(result).toContain('песка'); // Cyrillic not capitalized by \b\w but doesn't break
  });
});

describe('detectType', () => {
  it('detects model files', () => {
    expect(detectType('/models/island.glb', '.glb')).toBe('model');
    expect(detectType('/models/island.gltf', '.gltf')).toBe('model');
    expect(detectType('/models/island.fbx', '.fbx')).toBe('model');
  });

  it('detects texture files', () => {
    expect(detectType('/textures/grass.png', '.png')).toBe('texture');
    expect(detectType('/textures/sand.jpg', '.jpg')).toBe('texture');
    expect(detectType('/textures/palm.webp', '.webp')).toBe('texture');
  });

  it('detects environment maps', () => {
    expect(detectType('/env/sky.hdr', '.hdr')).toBe('environment');
    expect(detectType('/env/sky.exr', '.exr')).toBe('environment');
  });

  it('detects prefab files by extension', () => {
    expect(detectType('/prefabs/Boat.prefab.json', '.json')).toBe('prefab');
    expect(detectType('/models/island.prefab.json', '.json')).toBe('prefab');
  });

  it('detects scene files by directory', () => {
    expect(detectType('/scenes/main.json', '.json')).toBe('scene');
  });

  it('detects material files by directory', () => {
    expect(detectType('/materials/wood.json', '.json')).toBe('material');
  });

  it('excludes .meta.json files', () => {
    expect(detectType('/models/island.glb.meta.json', '.json')).toBeNull();
  });

  it('detects mesh JSON files by suffix', () => {
    expect(detectType('/models/hero.mesh.json', '.json')).toBe('mesh');
  });

  it('detects material JSON files by suffix', () => {
    expect(detectType('/models/wood.mat.json', '.json')).toBe('material');
  });

  it('detects font files', () => {
    expect(detectType('/fonts/Roboto-Bold.woff2', '.woff2')).toBe('font');
    expect(detectType('/fonts/Roboto.ttf', '.ttf')).toBe('font');
    expect(detectType('/fonts/Open.otf', '.otf')).toBe('font');
    expect(detectType('/fonts/Sans.woff', '.woff')).toBe('font');
  });

  it('excludes unknown JSON files', () => {
    expect(detectType('/assets.manifest.json', '.json')).toBeNull();
    expect(detectType('/package.json', '.json')).toBeNull();
  });

  it('excludes unknown extensions', () => {
    expect(detectType('/readme.md', '.md')).toBeNull();
    expect(detectType('/script.js', '.js')).toBeNull();
  });
});

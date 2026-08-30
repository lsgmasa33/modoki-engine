/** #423 item 1 — the default `.atlas.json` document (`{ members: [], pageSize: 1024, padding:
 *  2, extrude: 1 }`) used to be written out FOUR times: the "Create Atlas" button, the Atlas
 *  inspector's initial doc, its per-field read fallbacks, and the build-time reimport handler's
 *  read-side defaults. `defaultAtlasSource()` (spriteAtlas.ts) is now the one definition; this
 *  file pins all four sites to it.
 *
 *  Per the #417/#411 class of bug, a runtime value comparison alone cannot tell "reads the
 *  factory" from "has its own literal that happens to agree today" — so every site also gets a
 *  source-level assertion that it actually references `defaultAtlasSource`. */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { registerBuiltinCreatableAssets } from '../../src/editor/panels/builtinCreatableAssets';
import { getCreatableAssets } from '../../src/editor/panels/creatableAssets';
import { defaultAtlasSource } from '../../src/runtime/loaders/spriteAtlas';

const src = (rel: string) => fs.readFileSync(path.join(__dirname, '../../src', rel), 'utf8');

describe('atlas default-document parity (#423)', () => {
  it('the Assets panel "Create Atlas" body matches { id, ...defaultAtlasSource() }', () => {
    registerBuiltinCreatableAssets();
    const def = getCreatableAssets().find((d) => d.id === 'atlas');
    expect(def).toBeTruthy();
    expect(def!.body).toBeTruthy();
    const body = def!.body!('test-guid', 'New Atlas');
    expect(body).toEqual({ id: 'test-guid', ...defaultAtlasSource() });
  });

  it('builtinCreatableAssets.ts sources its atlas body from defaultAtlasSource, not its own literal', () => {
    const s = src('editor/panels/builtinCreatableAssets.ts');
    expect(s).toMatch(/import\s*\{\s*defaultAtlasSource\s*\}\s*from\s*'\.\.\/\.\.\/runtime\/loaders\/spriteAtlas'/);
    // The atlas `body:` line must call the factory, not repeat pageSize/padding/extrude literals.
    // Edit `defaultAtlasSource()` in spriteAtlas.ts, not this file, to change the default values.
    expect(s).toMatch(/body:\s*\(guid\)\s*=>\s*\(\{\s*id:\s*guid,\s*\.\.\.defaultAtlasSource\(\)\s*\}\)/);
  });

  it('AtlasAssetView.tsx sources DEFAULT_DOC + its coalescing fallbacks from defaultAtlasSource', () => {
    const s = src('editor/panels/assetViews/AtlasAssetView.tsx');
    expect(s).toMatch(/import\s*\{\s*defaultAtlasSource\s*\}\s*from\s*'\.\.\/\.\.\/\.\.\/runtime\/loaders\/spriteAtlas'/);
    expect(s).toMatch(/const DEFAULT_DOC: AtlasSourceDoc = defaultAtlasSource\(\)/);
    // Edit `defaultAtlasSource()` in spriteAtlas.ts, not this file, to change the per-field
    // fetch-handler fallbacks (pageSize/padding/extrude) — they must read DEFAULT_DOC, not
    // repeat 1024/2/1.
    expect(s).not.toMatch(/pageSize:\s*typeof d\.pageSize === 'number' \? d\.pageSize : 1024/);
    expect(s).not.toMatch(/padding:\s*typeof d\.padding === 'number' \? d\.padding : 2/);
    expect(s).not.toMatch(/extrude:\s*typeof d\.extrude === 'number' \? d\.extrude : 1/);
    // Positive side of the guard above: the fallback must actually READ DEFAULT_DOC, not just
    // avoid the old literal — a fallback disagreeing with the factory (e.g. `: 512`) would still
    // pass the not.toMatch checks alone.
    expect(s).toMatch(/pageSize:.*DEFAULT_DOC\.pageSize/);
    expect(s).toMatch(/padding:.*DEFAULT_DOC\.padding/);
    expect(s).toMatch(/extrude:.*DEFAULT_DOC\.extrude/);
  });

  it('reimport-atlas.ts\'s readAtlasSource sources its fallback values from defaultAtlasSource', () => {
    const s = fs.readFileSync(path.join(__dirname, '../../../../plugins/reimport-atlas.ts'), 'utf8');
    expect(s).toMatch(/import\s*\{[^}]*defaultAtlasSource[^}]*\}\s*from\s*'\.\.\/packages\/modoki\/src\/runtime\/loaders\/spriteAtlas'/);
    expect(s).toMatch(/const defaults = defaultAtlasSource\(\)/);
    // The range guards (`> 0`, `>= 0`) and the `raw.texture` preservation are readAtlasSource's
    // own logic and must stay — only the fallback VALUE moves to the factory.
    expect(s).toMatch(/raw\.pageSize > 0 \? raw\.pageSize : defaults\.pageSize/);
    expect(s).toMatch(/raw\.padding >= 0 \? raw\.padding : defaults\.padding/);
    expect(s).toMatch(/raw\.extrude >= 0 \? raw\.extrude : defaults\.extrude/);
    expect(s).toMatch(/raw\.texture \? \{ texture: raw\.texture \} : \{\}/);
    // `version` is a fifth field that used to be its own inlined `1` — must read the factory too.
    expect(s).toMatch(/version:\s*defaults\.version/);
    expect(s).not.toMatch(/version:\s*1,/);
  });

  it('defaultAtlasSource() fields — the single source every consumer above must reflect', () => {
    // If this changes, the four call sites above pick it up automatically (they call the
    // factory); this assertion just documents today's values for a human reading the diff.
    expect(defaultAtlasSource()).toEqual({ version: 1, members: [], pageSize: 1024, padding: 2, extrude: 1 });
  });
});

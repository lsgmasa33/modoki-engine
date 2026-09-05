/** Guard: `getTextDirtyVersion` stays called WITH a font GUID at both layout-hash call sites
 *  (#696).
 *
 *  `getTextDirtyVersion(fontId)` exists so a dynamic font's glyph generation only invalidates
 *  laid-out text that uses THAT font — omit the argument and it degrades to the un-attributed
 *  global counter, and a single new glyph anywhere rebuilds every Text2D/Text3D mesh in the
 *  scene (the exact per-frame full-rebuild cost #696 was written to remove). `textDirty.test.ts`
 *  pins the counter's OWN behaviour (attributed vs global), but nothing there notices if a call
 *  site stops passing `t.font` — reverting either site to the no-arg form leaves that test green
 *  while the attribution silently stops mattering. Deliberately a source grep, in the style of
 *  `videoTextureTeardownReachable.test.ts` (a wiring/reachability question a unit test on the
 *  callee cannot see) and `reapScoping.test.ts` (comment-safe scanning via the shared scanner). */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments, assertScanIsSane } from '@modoki/engine/testing';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const renderingDir = path.resolve(repoRoot, 'packages/modoki/src/runtime/rendering');

const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFiles(p));
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

// The two layout-hash sites that must attribute their dirty check to the entity's OWN font.
const attributedSites: [label: string, rel: string][] = [
  ['Scene2D.tsx (2D text layout hash)', 'packages/modoki/src/runtime/rendering/Scene2D.tsx'],
  ['scene3DSync.ts (3D text layout hash)', 'packages/modoki/src/runtime/rendering/scene3DSync.ts'],
];

describe('getTextDirtyVersion stays attributed by font at both layout-hash sites (#696)', () => {
  it.each(attributedSites)('%s calls getTextDirtyVersion(t.font), not the no-arg form', (_label, rel) => {
    const raw = read(rel);
    const src = stripComments(raw);
    assertScanIsSane(raw, src, rel);

    expect(src, `${rel}: expected a getTextDirtyVersion(t.font) call in the layout hash`)
      .toMatch(/getTextDirtyVersion\(\s*t\.font\s*\)/);
    // A no-arg call anywhere in the file (there should be exactly zero — the file has no other
    // legitimate caller) would silently fall back to the un-attributed global counter.
    expect(src, `${rel}: found a no-argument getTextDirtyVersion() call — this reverts #696's ` +
      'per-font attribution and makes one new glyph anywhere rebuild every Text2D/Text3D mesh')
      .not.toMatch(/getTextDirtyVersion\(\s*\)/);
  });

  it('no other file under runtime/rendering calls getTextDirtyVersion() with no argument', () => {
    for (const file of tsFiles(renderingDir)) {
      const rel = path.relative(repoRoot, file);
      if (rel.endsWith('text/textDirty.ts')) continue; // the definition site, not a call
      const raw = fs.readFileSync(file, 'utf8');
      const src = stripComments(raw);
      assertScanIsSane(raw, src, rel);
      expect(src, `${rel}: found a no-argument getTextDirtyVersion() call — pass the font GUID ` +
        '(#696) so an unrelated font\'s glyph generation does not force a rebuild here')
        .not.toMatch(/getTextDirtyVersion\(\s*\)/);
    }
  });
});

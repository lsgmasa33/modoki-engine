/** #417 item 2 — `defaultRig2DFile()`'s docstring claims it is the ONE definition behind
 *  the Skin Editor's "+ New Rig2D", the Assets panel's "Create 2D Rig", and the MCP
 *  `create-asset {type:'rig2d'}` route. That claim was false: both editor buttons inlined
 *  their own byte-identical literal, so no behavioural test could tell "shared" from
 *  "duplicated". This file pins the two editor call sites to the shared factory. */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { registerBuiltinCreatableAssets } from '../../src/editor/panels/builtinCreatableAssets';
import { getCreatableAssets } from '../../src/editor/panels/creatableAssets';
import { defaultRig2DFile } from '../../src/runtime/skinning/rig2dTypes';

describe('rig2d create-flow parity (#417)', () => {
  it('the Assets panel "Create 2D Rig" body matches { id, ...defaultRig2DFile() }', () => {
    registerBuiltinCreatableAssets();
    const def = getCreatableAssets().find((d) => d.id === 'rig2d');
    expect(def).toBeTruthy();
    expect(def!.body).toBeTruthy();
    const body = def!.body!('test-guid', 'New Rig');
    expect(body).toEqual({ id: 'test-guid', ...defaultRig2DFile() });
  });

  // Source-level guard, not a behavioural one: `newRig` lives inside a .tsx component
  // (SkinEditor's "+ New Rig2D" button) so it is not directly callable from a test, and
  // two copies that happen to agree today are behaviourally indistinguishable — this is
  // the #411/#417 class of bug. So assert the SOURCE no longer inlines the rig-document
  // literal that used to sit in `newRig`.
  //
  // This is deliberately a negative assertion only ("does NOT contain the old literal"),
  // with no positive "it calls defaultRig2DFile()" counterpart — a comment could satisfy
  // a text-based positive check without the code actually doing it. A false FAILURE here
  // (the literal shape reappearing inside a comment, say) is the safe direction: loud, not
  // silent.
  it('SkinEditor.newRig no longer inlines its own rig-document literal', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../src/editor/panels/SkinEditor.tsx'),
      'utf8',
    );
    expect(src).not.toMatch(/bones:\s*\[\s*\{\s*name:\s*'root'/);
  });

  // #423 item 2 — the LOAD-FAILURE fallback (not `newRig`) is a SEPARATE, deliberate divergence
  // from the peer editors (ParticleEditor/AnimationEditor/TimelineEditor all route load-failure
  // through their factory). The owner decided: keep this one EMPTY on purpose, so a future
  // "consistency" sweep does not silently swap it for `defaultRig2DFile()`. Positive assertion
  // (not just "does not contain the old literal") so a change to `defaultRig2DFile()`'s shape
  // cannot alter this fallback without the assertion moving too.
  it('SkinEditor load-failure fallback stays the deliberate empty-bones shape, and logs via console.error', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../src/editor/panels/SkinEditor.tsx'),
      'utf8',
    );
    expect(src).toMatch(
      /console\.error\('\[SkinEditor\] load failed', e\);[\s\S]{0,800}?const fb: Rig2DFile = \{ bones: \[\], mesh: \{ verts: \[\], uvs: \[\], tris: \[\] \}, skinIndices: \[\], skinWeights: \[\] \};/,
    );
    // It must NOT route through the shared factory — that would silently undo the owner's call.
    // (Narrow to the actual fallback ASSIGNMENT, not the explanatory comment above it, which
    // names `defaultRig2DFile()` on purpose to say why it is NOT used.)
    expect(src).not.toMatch(/const fb: Rig2DFile = defaultRig2DFile\(\)/);
  });
});

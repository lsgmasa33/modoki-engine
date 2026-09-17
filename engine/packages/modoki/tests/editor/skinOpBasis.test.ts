/** An async Skin editor op commits only onto the exact document it was computed from (skinOpBasis.ts).
 *  The wiring into SkinEditor.tsx is pinned by engine/tests/e2e/editor-skin-op-retarget.spec.ts. */
import { describe, it, expect } from 'vitest';
import { captureSkinOpBasis, isSkinOpBasisCurrent, rigDisplayName, skinOpStaleMessage, SKIN_OP_STALE_NOTICE } from '../../src/editor/panels/skinOpBasis';

const defA = { bones: ['a'] };
const at = (path: string | null, def: object | null) => ({ editingSkinAsset: path ? { path } : null, editingSkinDef: def });

describe('skinOpBasis', () => {
  it('captures nothing when no rig is open or its document has not loaded', () => {
    expect(captureSkinOpBasis(at(null, defA))).toBeNull();
    expect(captureSkinOpBasis(at('/a.rig2d.json', null))).toBeNull();
  });

  it('is current while the same document is open (the accept side)', () => {
    const basis = captureSkinOpBasis(at('/a.rig2d.json', defA))!;
    expect(isSkinOpBasisCurrent(basis, at('/a.rig2d.json', defA))).toBe(true);
  });

  it('is stale once another rig is open, even one whose document is the same object', () => {
    const basis = captureSkinOpBasis(at('/a.rig2d.json', defA))!;
    expect(isSkinOpBasisCurrent(basis, at('/b.rig2d.json', defA))).toBe(false);
  });

  it('is stale once the same rig was edited — a structurally equal copy is still a newer document', () => {
    const basis = captureSkinOpBasis(at('/a.rig2d.json', defA))!;
    expect(isSkinOpBasisCurrent(basis, at('/a.rig2d.json', { ...defA }))).toBe(false);
  });

  it('is stale while the next rig is still loading', () => {
    const basis = captureSkinOpBasis(at('/a.rig2d.json', defA))!;
    expect(isSkinOpBasisCurrent(basis, at('/b.rig2d.json', null))).toBe(false);
  });
});

describe('skinOpStaleMessage', () => {
  it('names the rig the op was FOR, as the panel header spells it', () => {
    expect(skinOpStaleMessage('tessellate 4×8', '/games/skin-test/assets/rigs/bar.rig2d.json'))
      .toBe(`tessellate 4×8 on bar: ${SKIN_OP_STALE_NOTICE}; run it again`);
    expect(rigDisplayName('/a/b/Hero.RIG2D.JSON')).toBe('Hero');
  });

  it('tells a sprite assign to drop again — it has no button to re-press', () => {
    // BOTH of assignSpriteToPart's basis-carrying commits: the full one and the trim-killed-every-cell one.
    for (const label of ['sprite + mesh', 'sprite']) {
      expect(skinOpStaleMessage(label, '/r/bar.rig2d.json')).toMatch(/drop the sprite on the part again$/);
    }
    expect(skinOpStaleMessage('auto-rig', '/r/bar.rig2d.json')).toMatch(/run it again$/);
  });
});

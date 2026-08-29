/** #351 — engine-added material properties must survive EVERY clone route.
 *
 *  The defect: `lineColor` / `nprColorPreserve` stored into `_`-prefixed backing fields, which
 *  `Material.copy()` does not know about and `cloneDerived` skips as private. A mesh that was both
 *  tinted and light-masked therefore rendered at `nprColorPreserve: 0` — full NPR greyscale fill,
 *  ignoring the authored `Tint.amount` — while the tint COLOUR survived (`.color` is a field
 *  `Material.copy()` does know), so it looked like an NPR bug rather than a Tint one.
 *
 *  ⚠️ These use REAL `THREE.Material`s and the REAL prototype accessors on purpose. The existing
 *  `tintSync.test.ts` drives a hand-rolled fake whose `nprColorPreserve` is a plain own property —
 *  which is the one shape that CANNOT reproduce this bug, because a plain own property is exactly
 *  what the real material does not have. A fake that models behaviour nothing has is why the
 *  defect survived a green suite.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import { ensureLineColorOnMaterials } from '../../src/runtime/rendering/npr/NPRPostProcess';
import { cloneDerived } from '../../src/runtime/rendering/derivedMaterials';
import {
  MATERIAL_EXTRAS_KEY, readMaterialExtras, materialExtrasAreJsonSafe,
} from '../../src/runtime/rendering/materialExtras';

type Extras = THREE.MeshStandardMaterial & { nprColorPreserve: number; lineColor: THREE.Color };
const mat = () => new THREE.MeshStandardMaterial() as unknown as Extras;

// The prototype patch is process-lifetime and idempotent (F8) — install it once for the file.
beforeAll(() => ensureLineColorOnMaterials());

describe('nprColorPreserve survives the clone routes (#351)', () => {
  it('THE BUG: tint clone -> light-mask variant keeps the amount', () => {
    // `scene3DSync.tintedMaterial` does exactly this pair of writes on its clone.
    const base = mat();
    const tinted = cloneDerived(base, base) as Extras;
    tinted.color.setHex(0xff0000);
    tinted.nprColorPreserve = 0.7;

    // `applyLightMask` recovers the tint clone via `baseOf` (a tint clone answers with ITSELF, so
    // the variant keeps the tint) and `getMaskedMaterial` clones it — this call is that route.
    const variant = cloneDerived(tinted, tinted) as Extras;

    expect(variant.nprColorPreserve).toBe(0.7); // was 0 — the whole defect
    expect(variant.color.getHex()).toBe(0xff0000); // the half that always worked
  });

  it('survives a BARE .clone() too (Material.copy carries userData)', () => {
    const m = mat();
    m.nprColorPreserve = 0.4;
    expect((m.clone() as unknown as Extras).nprColorPreserve).toBe(0.4);
  });

  it('survives a chain of clones without decaying', () => {
    const base = mat();
    base.nprColorPreserve = 0.25;
    let cur = base;
    for (let i = 0; i < 4; i++) cur = cloneDerived(cur, cur) as Extras;
    expect(cur.nprColorPreserve).toBe(0.25);
  });

  it('defaults to 0 on a material that never set one', () => {
    expect(mat().nprColorPreserve).toBe(0);
    expect(readMaterialExtras(mat())).toBeUndefined(); // and allocates nothing
  });

  it('0 is a real value, not "unset" — it must survive a clone as 0', () => {
    // Guards the `?? 0` default: a falsy-vs-absent mixup here is invisible, because the WRONG
    // answer and the default happen to agree until someone reads the userData directly.
    const m = mat();
    m.nprColorPreserve = 0;
    expect(readMaterialExtras(cloneDerived(m, m))?.nprColorPreserve).toBe(0);
  });

  it('a clone OWNS its extras — retuning it cannot reach back into the base', () => {
    const base = mat();
    base.nprColorPreserve = 0.5;
    const clone = cloneDerived(base, base) as Extras;
    clone.nprColorPreserve = 0.9;
    expect(base.nprColorPreserve).toBe(0.5);
    expect(clone.nprColorPreserve).toBe(0.9);
  });
});

describe('lineColor survives the clone routes, still as a THREE.Color (#351)', () => {
  it('carries through cloneDerived AND a bare clone, as a usable Color', () => {
    const m = mat();
    m.lineColor = new THREE.Color(0x00ff00);
    for (const c of [cloneDerived(m, m) as Extras, m.clone() as unknown as Extras]) {
      expect(c.lineColor).toBeInstanceOf(THREE.Color);
      expect(c.lineColor.getHex()).toBe(0x00ff00);
    }
  });

  it('an unset lineColor still returns the shared frozen default', () => {
    const a = mat(), b = mat();
    expect(a.lineColor.getHex()).toBe(0x000000);
    expect(a.lineColor).toBe(b.lineColor); // shared instance — no per-access allocation (F8)
  });

  it('the materialised Color is memoised, and the memo follows a reassignment', () => {
    const m = mat();
    m.lineColor = new THREE.Color(0x123456);
    const first = m.lineColor;
    expect(m.lineColor).toBe(first); // stable across reads — not a fresh object per get
    m.lineColor = new THREE.Color(0x654321);
    expect(m.lineColor.getHex()).toBe(0x654321);
    expect(m.lineColor).not.toBe(first);
  });

  it('stores a SNAPSHOT, so mutating the caller\'s Color afterwards does not retune the material', () => {
    // A behaviour change from the old by-reference storage, and the safer direction: aliasing is
    // what made the frozen shared default a footgun. The one production writer
    // (`meshTemplateCache`) builds a fresh Color from the material JSON's hex and drops it.
    const m = mat();
    const c = new THREE.Color(0x111111);
    m.lineColor = c;
    c.setHex(0x222222);
    expect(m.lineColor.getHex()).toBe(0x111111);
  });
});

describe('the accessors must be installed BEFORE anything writes them (#351 review)', () => {
  // ⚠️ These cannot live in the suites above: `beforeAll` installs the patch, so every case there
  // runs in the SAFE order by construction — which is exactly why the review found this by reading
  // and not by testing. The patch is process-lifetime and irreversible (F8), so a genuine
  // "write before patch" cannot be re-staged here; instead we drive the SHAPE that window produces
  // and assert the guard that now prevents it.

  it('a plain own data property is NOT in the namespace — the shape the pre-patch window creates', () => {
    // What `mat.nprColorPreserve = 0.8` does when the setter does not exist yet: it shadows the
    // (absent) accessor with a data property, so nothing reaches userData and the next
    // Material.copy() drops it. This is the #351 defect, unfixed, and it is why load-time writers
    // must call ensureLineColorOnMaterials() first.
    const m = new THREE.MeshStandardMaterial();
    Object.defineProperty(m, 'nprColorPreserve', { value: 0.8, writable: true, configurable: true, enumerable: true });
    expect(readMaterialExtras(m)).toBeUndefined();
    expect((m.clone() as unknown as Extras).nprColorPreserve).toBe(0); // lost, exactly as in #351
  });

  it('meshTemplateCache installs the accessors before writing either property', async () => {
    // A source guard, deliberately: the real ordering lives in an async material-load path that a
    // unit test cannot stage without a renderer, and the failure is SILENT (a value that reads
    // back fine locally and vanishes on the next clone). Comments are stripped first — otherwise
    // this passes on the explanatory comment beside the call rather than on the call.
    const src = (await import('node:fs')).readFileSync(
      new URL('../../src/runtime/loaders/meshTemplateCache.ts', import.meta.url), 'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const install = src.indexOf('ensureLineColorOnMaterials()');
    const writeLine = src.indexOf('.lineColor = new THREE.Color(');
    const writePreserve = src.indexOf('.nprColorPreserve = data.nprColorPreserve');
    expect(install, 'meshTemplateCache must call ensureLineColorOnMaterials()').toBeGreaterThan(-1);
    expect(writeLine, 'the lineColor write moved — re-check the ordering').toBeGreaterThan(-1);
    expect(writePreserve, 'the nprColorPreserve write moved — re-check the ordering').toBeGreaterThan(-1);
    expect(install, 'ensureLineColorOnMaterials() must come BEFORE the lineColor write').toBeLessThan(writeLine);
    expect(install, 'ensureLineColorOnMaterials() must come BEFORE the nprColorPreserve write').toBeLessThan(writePreserve);
  });
});

describe('the JSON-safe-primitives contract (#351)', () => {
  it('what we store round-trips through JSON unchanged — the bare-clone path', () => {
    const m = mat();
    m.nprColorPreserve = 0.33;
    m.lineColor = new THREE.Color(0xabcdef);
    const extras = readMaterialExtras(m)!;
    expect(materialExtrasAreJsonSafe(extras)).toBe(true);
    // This is literally what `Material.copy()` does to userData.
    expect(JSON.parse(JSON.stringify(extras))).toEqual(extras);
  });

  it('rejects a class instance — the trap that makes this contract necessary', () => {
    // Storing the Color itself would pass every cloneDerived test and then fail on a bare clone,
    // where JSON strips the prototype and `.getHex()` throws. Pin the rule so a future extra
    // cannot quietly reintroduce it.
    expect(materialExtrasAreJsonSafe({ lineColor: new THREE.Color(0xff0000) })).toBe(false);
    const stripped = JSON.parse(JSON.stringify({ c: new THREE.Color(0xff0000) })).c;
    expect(stripped).not.toBeInstanceOf(THREE.Color);
  });

  it('lives under ONE namespaced userData key, so cloneDerived carries it by whitelist', () => {
    const m = mat();
    m.nprColorPreserve = 0.1;
    expect(Object.keys(m.userData)).toEqual([MATERIAL_EXTRAS_KEY]);
  });

  it('carrying the extras does NOT resurrect the rest of userData that cloneDerived suppresses', () => {
    // The suppression is load-bearing (#325): `userData.__lightMaskBase` holds a whole material,
    // and letting it through Material.copy's JSON round-trip serialises a material graph. The
    // whitelist must stay a whitelist.
    const m = mat();
    m.nprColorPreserve = 0.6;
    m.userData.__lightMaskBase = mat();
    m.userData.somethingElse = { deep: 'value' };
    const clone = cloneDerived(m, m) as Extras;
    expect(clone.nprColorPreserve).toBe(0.6);
    expect(clone.userData.somethingElse).toBeUndefined();
    expect(clone.userData.__lightMaskBase).toBeUndefined();
  });
});

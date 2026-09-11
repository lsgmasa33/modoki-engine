/**
 * #993 — a CODE-DECLARED vocabulary table indexed by a DOCUMENT-supplied string.
 *
 * The family's one mechanism: a literal object inherits `Object.prototype`, so a key like
 * `constructor` or `toString` returns an inherited FUNCTION — and every guard people write beside
 * such a read is defeated by it (`key in TABLE` is true, `?? d` and `|| d` never fire, `if (!v)`
 * passes). The fix is `hasDocKey` AT THE READ; the mechanism and the severity ranking live in
 * `docs/format-versioning.md` § 4b-ter.
 *
 * ⚠️ **Every block asserts the ACCEPT side too.** A table that answers `undefined` for everything
 * passes every reject case in this file while breaking all texture wrapping and every particle
 * emitter — which is the outcome the coverage baseline for #993 was measured against (none of the
 * sites known when #993 was first written up had a failing test, and one had a passing test that
 * could not fail either way). The site count lives in § 4b-ter only; do not restate it here.
 *
 * ⚠️ **`__proto__` is NOT the reachable half.** These are all READS. Only `__proto__` goes through
 * a setter, so a suite naming only it stays green against the entire family. `PROTO_KEYS` below is
 * the same full list `docKeys.test.ts` uses, deliberately.
 *
 * Sites NOT covered here, each with its reason:
 *  - `gpuComputeBackend`'s `SHAPE`/`COLL` — see `gpuVocabTableProtoKeys.test.ts`, which pays for
 *    the TSL/WebGPU fakes.
 *  - `gpuComputeBackend`'s `COLLIDER` — now routed through `resolveColliderShape`, covered in
 *    `vocabWarnings.test.ts` § particle CollisionConfig.shape.
 *  - `app/debug/bridge.ts` and `app/debug/agentBridge.ts` — the app suite, not this package.
 *  - `games/scroll-demo` and `games/3d-test` — their own `tests/` directories.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as THREE from 'three';
import { createWorld } from 'koota';

import { collectResourceRefsFromEntities } from '../../src/runtime/loaders/loadSceneFile';
import { refFieldWarnings } from '../../src/runtime/loaders/sceneValidation';
import { createPrimitiveMesh, isPrimitive, PRIMITIVE_NAMES } from '../../src/runtime/loaders/primitives';
import { getAssetSchema } from '../../src/runtime/assets/assetSchemas';
import { emit, clearJournal, journalEvents, setJournalEnabled, setJournalTick } from '../../src/runtime/core/journal';
import { coerceParamValue } from '../../src/runtime/core/shaderSchema';
import { uiTextAnimation, type UITextAnimParams } from '../../src/runtime/ui/uiTextAnimation';
import { parseFontFilename, WEIGHT_MAP } from '../../src/runtime/loaders/fontNaming';
import { loadTexture3D, disposeAllSharedTextures } from '../../src/runtime/loaders/textureResolver';
import { setAudioRecordMode, clearAudioLog, getAudioLog, setBusVolume, resolveBus } from '../../src/runtime/audio/audioService';
import { buildEntityCreateSpecs, LIGHT_KINDS } from '../../src/runtime/scene/entityCreateSpecs';
import { buildUiCreateSpecs, UI_PRESET_NAMES } from '../../src/runtime/ui/uiAuthoring';
import { applyAnchorStyle } from '../../src/runtime/ui/anchorCss';
import { resolveCollisionMode } from '../../src/runtime/particles/colliders';
import { COLLISION_MODES } from '../../src/runtime/particles/types';
import { registerAsset, clearManifest } from '../../src/runtime/loaders/assetManifest';
import { DEFAULT_TEXTURE_SETTINGS } from '../../src/runtime/loaders/textureSettings';

/** The full set. Only `__proto__` goes through a setter; the other seven are what reaches a READ. */
const PROTO_KEYS = [
  '__proto__', 'constructor', 'toString', 'valueOf',
  'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString',
] as const;

// ── loaders/loadSceneFile.ts — REF_FIELDS_BY_TRAIT, on the load path for EVERY scene ──────────

describe('collectResourceRefsFromEntities — a trait NAMED like a prototype key (#993)', () => {
  // Before the fix: `REF_FIELDS_BY_TRAIT['constructor']` is the inherited function, and
  // `registryFields?.includes(field)` is a TypeError. Not a wrong value — a crash, on the path
  // every scene and prefab load takes.
  it.each(PROTO_KEYS)('does not throw for a trait named %s', (name) => {
    expect(() => collectResourceRefsFromEntities([{ traits: { [name]: { some: 'value' } } }]))
      .not.toThrow();
  });

  it('ACCEPT: a real registry trait still has its ref field SKIPPED by the sweep', () => {
    // UIElement.fontFamily is registry-owned, so the generic sweep must not re-derive it as an
    // SDF font ref — the whole reason this read exists (#231). A fix that made the lookup always
    // miss would silently re-break that, and every reject case above would still pass.
    //
    // ⚠️ Assert on the ref TYPE, not its path. `collectResourceRefsFromEntities` reports the
    // GUID in `path`, never the resolved file path, so `not.toContain('…/f.ttf')` was true under
    // BOTH hypotheses — it was the one accept-side block in this file that survived a
    // guard-rejects-everything mutation. The real signal is the EXTRA `font` entry the broken
    // sweep emits beside the legitimate `font-family` one: that is the #231 regression, a real
    // SDF atlas fetch + GPU upload on every scene load.
    const guid = '33333333-3333-4333-8333-333333333333';
    clearManifest();
    registerAsset(guid, '/games/g/assets/fonts/f.ttf', 'font');
    const swept = collectResourceRefsFromEntities([{ traits: { UIElement: { fontFamily: guid } } }]);
    expect(swept.map((r) => r.type)).toEqual(['font-family']);
    clearManifest();
  });
});

// ── loaders/sceneValidation.ts — REF_FIELDS_BY_TRAIT again, `for (… of fn)` ───────────────────

describe('refFieldWarnings — a trait NAMED like a prototype key (#993)', () => {
  it.each(PROTO_KEYS)('does not throw for a trait named %s', (name) => {
    expect(() => refFieldWarnings({ [name]: { sprite: 'not-a-guid' } }, 'Entity "x"')).not.toThrow();
  });

  it('ACCEPT: a real trait with a bad ref STILL warns — the table must keep answering', () => {
    const out = refFieldWarnings({ Renderable2D: { sprite: 'not-a-guid' } }, 'Entity "x"');
    expect(out.length).toBeGreaterThan(0);
    expect(out.join(' ')).toContain('sprite');
  });
});

// ── loaders/primitives.ts — two functions over one table, disagreeing three lines apart ───────

describe('createPrimitiveMesh — asks isPrimitive rather than re-checking (#993)', () => {
  it.each(PROTO_KEYS)('returns null for mesh name %s', (name) => {
    expect(createPrimitiveMesh(name, 1, 0xffffff)).toBeNull();
  });

  it('the two functions AGREE on every input — the defect was that they did not', () => {
    for (const name of [...PROTO_KEYS, ...PRIMITIVE_NAMES, 'nope']) {
      expect(createPrimitiveMesh(name, 1, 0xffffff) !== null).toBe(isPrimitive(name));
    }
  });

  it('ACCEPT: every real primitive still builds a mesh with real geometry', () => {
    expect(PRIMITIVE_NAMES.length).toBeGreaterThan(0);
    for (const name of PRIMITIVE_NAMES) {
      const mesh = createPrimitiveMesh(name, 1, 0xffffff);
      expect(mesh, name).toBeInstanceOf(THREE.Mesh);
      expect(mesh!.geometry.getAttribute('position').count).toBeGreaterThan(0);
    }
  });
});

// ── assets/assetSchemas.ts — the looked-up value is INVOKED ───────────────────────────────────

describe('getAssetSchema — the table holds THUNKS, so a prototype key is CALLED (#993)', () => {
  it.each(PROTO_KEYS)('returns null for asset type %s', (type) => {
    // Before the fix: `SCHEMAS['constructor']?.()` invokes `Object()`, whose truthy `{}` defeats
    // `?? null` — so the caller got an object and read `undefined` off `.fields`.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(getAssetSchema(type as any)).toBeNull();
  });

  it('ACCEPT: a real asset type still returns a schema with fields', () => {
    const schema = getAssetSchema('material');
    expect(schema).not.toBeNull();
    expect(schema!.type).toBe('material');
    expect(Object.keys(schema!.fields).length).toBeGreaterThan(0);
  });
});

// ── core/journal.ts — an agent-supplied level filter that returned ZERO events ────────────────

describe('journalEvents level filter — an unknown level filters NOTHING (#993)', () => {
  beforeEach(() => { setJournalEnabled(true); setJournalTick(0); });

  const seed = () => {
    const world = createWorld();
    clearJournal(world);
    emit('a', {}, world, 'info');
    emit('b', {}, world, 'warn');
    emit('c', {}, world, 'error');
    return world;
  };

  it.each(PROTO_KEYS)('level %s returns every event rather than none', (level) => {
    const world = seed();
    // Before the fix: `LEVEL_RANK['toString']` is a function, every `>=` against it is false, and
    // the journal answered with an EMPTY array — which an agent reads as "nothing happened".
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(journalEvents({ level: level as any }, world).length).toBe(3);
  });

  it('ACCEPT: a real level still filters to that severity AND ABOVE', () => {
    const world = seed();
    expect(journalEvents({ level: 'warn' }, world).map((e) => e.type)).toEqual(['b', 'c']);
    expect(journalEvents({ level: 'error' }, world).map((e) => e.type)).toEqual(['c']);
    expect(journalEvents({ level: 'info' }, world).length).toBe(3);
  });
});

// ── core/shaderSchema.ts — VEC_COMPONENTS, a uniform shipping a function ─────────────────────

describe('coerceParamValue — an unknown param type has ZERO components (#993)', () => {
  it.each(PROTO_KEYS)('type %s coerces to an empty vector, not a 1-element array holding a function', (type) => {
    // Before the fix: `n` is the inherited function, both `length === n` tests are false, and
    // `new Array(fn)` builds `[fn]` — a uniform carrying `Object.prototype.toString`.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = coerceParamValue({ name: 'u', type: type as any } as any, undefined);
    expect(out).toEqual([]);
  });

  it('ACCEPT: a real vector type still keeps its component count', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(coerceParamValue({ name: 'u', type: 'vec3' } as any, undefined)).toEqual([0, 0, 0]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(coerceParamValue({ name: 'u', type: 'vec3' } as any, [1, 2, 3])).toEqual([1, 2, 3]);
  });
});

// ── ui/uiTextAnimation.ts — EFFECTS ──────────────────────────────────────────────────────────

describe('uiTextAnimation — an unknown effect returns null (#993)', () => {
  const params = (effect: string): UITextAnimParams =>
    ({ effect, speed: 1, amplitude: 0.2, frequency: 1, loop: false });

  it.each(PROTO_KEYS)('effect %s returns null rather than `animation: undefined`', (effect) => {
    // Before the fix: the inherited function is truthy, so `if (!m) return null` passed it through
    // and its absent `.perChar` sent it down the CSS branch.
    expect(uiTextAnimation(params(effect))).toBeNull();
  });

  it('ACCEPT: a real effect still produces a style', () => {
    const style = uiTextAnimation(params('fade'));
    expect(style).not.toBeNull();
    expect(typeof style!.animation).toBe('string');
  });
});

// ── loaders/fontNaming.ts — WEIGHT_MAP, and the ONE name lowercasing does not kill ────────────

describe('parseFontFilename — a prototype-named weight suffix (#993)', () => {
  it('`constructor` is the one of the eight that survives .toLowerCase()', () => {
    // Which is why "we lowercase it first" is not a guard. The other seven are killed by the
    // case fold and would pass with or without the fix — this is the case that discriminates.
    const info = parseFontFilename('/games/g/assets/fonts/MyFont-constructor.ttf');
    // Before the fix `match` was the inherited function — truthy — so the "known variant" branch
    // ran with `match.weight` undefined. The honest answer is the OTHER branch: not a variant, so
    // the whole filename is the family (then camelCase-spaced, as every family name is).
    expect(info.weight).toBe('400');
    expect(info.style).toBe('normal');
    expect(info.family).toBe('My Font constructor');
  });

  it.each(PROTO_KEYS)('suffix %s yields a real weight string, never undefined', (name) => {
    const info = parseFontFilename(`/games/g/assets/fonts/MyFont-${name}.ttf`);
    expect(typeof info.weight).toBe('string');
    expect(info.weight).toMatch(/^\d{3}$/);
  });

  it('ACCEPT: every real WEIGHT_MAP suffix still strips and maps', () => {
    for (const [suffix, want] of Object.entries(WEIGHT_MAP)) {
      const info = parseFontFilename(`/games/g/assets/fonts/MyFont-${suffix}.ttf`);
      expect(info.family, suffix).toBe('My Font');
      expect(info.weight, suffix).toBe(want.weight);
    }
  });
});

// ── loaders/textureResolver.ts — WRAP, and the #73 behaviour that must SURVIVE the fix ────────

describe('applyTextureSettings WRAP — a prototype-named wrapS (#993)', () => {
  const GUID = '44444444-4444-4444-8444-444444444444';
  let loadAsyncSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearManifest();
    loadAsyncSpy = vi.spyOn(THREE.Loader.prototype, 'loadAsync').mockImplementation(async () => new THREE.Texture() as never);
  });
  afterEach(() => { disposeAllSharedTextures(); loadAsyncSpy.mockRestore(); });

  it.each(PROTO_KEYS)('wrapS %s leaves wrapS unset AND warns', async (wrap) => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerAsset(GUID, `/games/g/assets/tex/${String(wrap).replace(/\W/g, '')}.png`, 'texture', {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...DEFAULT_TEXTURE_SETTINGS, format: 'png', wrapS: wrap as any,
    });
    const tex = await loadTexture3D(GUID);
    // ⚠️ `undefined`, NOT three's ClampToEdgeWrapping — #73 established they differ, so "fixed"
    // here must not mean "falls back to the three.js default".
    expect(tex.wrapS).toBeUndefined();
    // ⚠️ And the WARNING is the actual #993 defect: `'toString' in WRAP` was true, so it never
    // fired. A fix that lands on undefined silently is only half the repair.
    const warns = spy.mock.calls.filter((c) => String(c[0]).includes('wrapS'));
    expect(warns.length).toBe(1);
    expect(String(warns[0][0])).toContain(String(wrap));
    spy.mockRestore();
  });

  it('ACCEPT: every real wrap value still reaches its three.js constant, with no warning', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const want = { repeat: THREE.RepeatWrapping, clamp: THREE.ClampToEdgeWrapping, mirror: THREE.MirroredRepeatWrapping } as const;
    for (const [value, expected] of Object.entries(want)) {
      const guid = `4444444${Object.keys(want).indexOf(value)}-4444-4444-8444-444444444444`;
      registerAsset(guid, `/games/g/assets/tex/${value}.png`, 'texture', {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...DEFAULT_TEXTURE_SETTINGS, format: 'png', wrapS: value as any, wrapT: value as any,
      });
      const tex = await loadTexture3D(guid);
      expect(tex.wrapS, value).toBe(expected);
      expect(tex.wrapT, value).toBe(expected);
    }
    expect(spy.mock.calls.filter((c) => String(c[0]).includes('wrap')).length).toBe(0);
    spy.mockRestore();
  });
});

// ── audio/audioService.ts — AudioSource.bus, a scene-JSON trait FIELD ─────────────────────────

describe('setBusVolume — an unrecognised bus is refused, not written (#993)', () => {
  // Record mode is the headless seam: `setBusVolume` logs the op and returns before touching any
  // AudioContext. A refused op must leave the log EMPTY — it is not a thing that happened.
  beforeEach(() => { setAudioRecordMode(true); clearAudioLog(); });
  afterEach(() => { setAudioRecordMode(false); clearAudioLog(); });

  it.each(PROTO_KEYS)('bus %s is refused', (bus) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setBusVolume(bus as any, 0.25);
    expect(getAudioLog()).toEqual([]);
  });

  it('an ordinary unknown bus is refused too', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setBusVolume('sxf' as any, 0.25);
    expect(getAudioLog()).toEqual([]);
  });

  it('ACCEPT: every real bus still sets, and is logged', () => {
    for (const bus of ['master', 'music', 'sfx', 'ui'] as const) setBusVolume(bus, 0.5);
    expect(getAudioLog().map((e) => (e as { bus?: string }).bus)).toEqual(['master', 'music', 'sfx', 'ui']);
  });
});

describe('resolveBus — AudioSource.bus on the PLAYBACK path (#993)', () => {
  // A different decision from setBusVolume's refusal above, on purpose: a typo'd bus should still
  // make a sound. Before the fix this reached `busNode` raw and `tail.connect(Object)` threw,
  // killing that entity's audio outright.
  it.each(PROTO_KEYS)('bus %s falls back to sfx', (bus) => {
    expect(resolveBus(bus)).toBe('sfx');
  });

  it('an absent bus is sfx, and an ordinary typo is too', () => {
    expect(resolveBus(undefined)).toBe('sfx');
    expect(resolveBus('msuic')).toBe('sfx');
  });

  it('ACCEPT: every real bus resolves to itself', () => {
    for (const bus of ['master', 'music', 'sfx', 'ui'] as const) expect(resolveBus(bus)).toBe(bus);
  });
});

// ── scene/entityCreateSpecs.ts + ui/uiAuthoring.ts — the create-entity agent payload ──────────

describe('buildEntityCreateSpecs / buildUiCreateSpecs — an unknown vocabulary REFUSES (#993)', () => {
  it.each(PROTO_KEYS)('light kind %s throws instead of spawning a lightless Light', (light) => {
    // Before the fix the `Light` trait's `data` was the inherited FUNCTION and the op still
    // answered `{ok: true}` — a success report for an entity with no light fields at all.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => buildEntityCreateSpecs({ kind: 'light', light } as any, 0)).toThrow(/unknown light kind/);
  });

  it.each(PROTO_KEYS)('UI preset %s throws instead of spawning a fieldless UIElement', (preset) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => buildUiCreateSpecs(preset as any, 0)).toThrow(/unknown UI preset/);
  });

  it('ACCEPT: every real light kind and UI preset still builds its defaults', () => {
    expect(LIGHT_KINDS.length).toBeGreaterThan(0);
    for (const kind of LIGHT_KINDS) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const built = buildEntityCreateSpecs({ kind: 'light', light: kind } as any, 0);
      const light = built.specs.find((sp) => sp.name === 'Light');
      expect(light?.data, kind).toBeTruthy();
      expect(Object.keys(light!.data as object).length, kind).toBeGreaterThan(0);
    }
    expect(UI_PRESET_NAMES.length).toBeGreaterThan(0);
    for (const preset of UI_PRESET_NAMES) {
      const el = buildUiCreateSpecs(preset, 0).specs.find((sp) => sp.name === 'UIElement');
      expect(Object.keys(el!.data as object).length, preset).toBeGreaterThan(0);
    }
  });
});

// ── ui/anchorCss.ts — AnchorData.*Unit, declared `string` ────────────────────────────────────

describe('applyAnchorStyle viewport-unit vars — an unrecognised length unit (#993)', () => {
  // ⚠️ TWO anchors, because the unit is read in TWO places and one probe reaches only one of
  // them. `top-left` sets `style.top = 0`, and 0 is FALSY, so `fmtAdd` takes its `bare(v, unit)`
  // branch; `center` sets `style.top = '50%'`, a truthy base, so it takes `term(v, unit)`.
  // Probing only `top-left` left the `term` read uncovered — measured: reverting `term` alone to
  // the truthiness guard kept this block green.
  const topFor = (topUnit: string, anchor: 'top-left' | 'center'): unknown => {
    const style: Record<string, unknown> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    applyAnchorStyle(style as any, { anchor, top: 12, left: 0, topUnit, leftUnit: 'px' } as any);
    return style.top;
  };

  it.each(PROTO_KEYS)('unit %s falls back to px at BOTH reads, not a var() holding a function', (unit) => {
    // Before the fix: `calc(12 * var(function Object() { [native code] }, 1constructor))`, which
    // the browser DROPS — so the element sat unoffset rather than falling back to px.
    expect(topFor(unit, 'top-left')).toBe(12);                    // bare()
    expect(topFor(unit, 'center')).toBe('calc(50% + 12px)');      // term()
    for (const anchor of ['top-left', 'center'] as const) {
      expect(String(topFor(unit, anchor))).not.toContain('native code');
      expect(String(topFor(unit, anchor))).not.toContain('var(');
    }
  });

  it('ACCEPT: each viewport unit still resolves through its own CSS var, at both reads', () => {
    for (const [unit, v] of [['vw', '--ui-vw'], ['vh', '--ui-vh'], ['vmin', '--ui-vmin'], ['vmax', '--ui-vmax']] as const) {
      expect(String(topFor(unit, 'top-left')), unit).toContain(v);
      expect(String(topFor(unit, 'center')), unit).toContain(v);
    }
    expect(String(topFor('%', 'top-left'))).toBe('12%');
    expect(String(topFor('%', 'center'))).toBe('calc(50% + 12%)');
  });
});

// ── particles/colliders.ts — collision.MODE, the twin of the shape normaliser ────────────────

describe('resolveCollisionMode — the two backends must agree about a typo (#993 review)', () => {
  it.each(PROTO_KEYS)('mode %s resolves to none', (mode) => {
    expect(resolveCollisionMode(mode)).toBe('none');
  });

  it("an ordinary typo resolves to none — the GPU's existing answer, now the CPU's too", () => {
    // The divergence this closes: the GPU mapped 'bounse' to COLL.none and its kernel's
    // `collMode > 0` made collision inert, while the CPU asked only `mode !== 'none'` and then
    // fell through every `=== 'kill'` branch — so the same .particle.json BOUNCED on CPU.
    expect(resolveCollisionMode('bounse')).toBe('none');
    expect(resolveCollisionMode(undefined)).toBe('none');
  });

  it('ACCEPT: every real mode resolves to itself', () => {
    expect(COLLISION_MODES.length).toBe(3);
    for (const mode of COLLISION_MODES) expect(resolveCollisionMode(mode)).toBe(mode);
  });
});

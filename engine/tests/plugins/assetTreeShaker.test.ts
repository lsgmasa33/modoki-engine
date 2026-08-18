/** Asset tree-shaker tests — exercise the pure walker against synthetic
 *  fixture trees. Each test builds a small asset root under tmpdir, runs
 *  computeKeptAssets, and asserts which virtual paths are kept/dropped. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { computeKeptAssets, virtualToAbs } from '../../plugins/asset-tree-shaker';
import { detectType, resolveAssetPath, type AssetRoot } from '../../plugins/vite-asset-scanner';
import { JSON_ASSET_SUFFIX_TYPE, ID_BEARING_TYPES, classifyJsonAssetSuffix } from '../../plugins/assetTypes';
import { REF_FIELDS_BY_TRAIT } from '../../packages/modoki/src/runtime/loaders/sceneValidation';
import { MATERIAL_TEXTURE_SLOTS } from '../../packages/modoki/src/runtime/assets/materialTextureSlots';

// ── Fixture helpers ──────────────────────────────────

interface Fixture {
  projectRoot: string;
  roots: AssetRoot[];
  /** Write a file under an asset root. Path is virtual (e.g. "/games/test/assets/foo.glb"). */
  writeVirtual(virtualPath: string, content: string | Buffer): void;
  /** Write a JSON file. Converts to string. */
  writeJson(virtualPath: string, data: unknown): void;
  /** Write the keep-list at project root. */
  writeKeepList(entries: string[]): void;
  cleanup(): void;
}

function createFixture(): Fixture {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shaker-'));
  // Single game root: /games/test/assets → <tmp>/games/test/runtime/assets
  const gameAssetsAbs = path.join(projectRoot, 'games/test/runtime/assets');
  fs.mkdirSync(gameAssetsAbs, { recursive: true });
  const modokiAssetsAbs = path.join(projectRoot, 'packages/modoki/src/runtime/assets');
  fs.mkdirSync(modokiAssetsAbs, { recursive: true });

  const roots: AssetRoot[] = [
    { urlPrefix: '/modoki/assets', absDir: modokiAssetsAbs },
    { urlPrefix: '/games/test/assets', absDir: gameAssetsAbs },
  ];

  const virtualToAbs = (virtualPath: string): string => {
    for (const root of roots) {
      if (virtualPath.startsWith(root.urlPrefix + '/')) {
        return path.join(root.absDir, virtualPath.substring(root.urlPrefix.length + 1));
      }
    }
    throw new Error(`virtual path not under any root: ${virtualPath}`);
  };

  return {
    projectRoot,
    roots,
    writeVirtual(virtualPath, content) {
      const abs = virtualToAbs(virtualPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    },
    writeJson(virtualPath, data) {
      const abs = virtualToAbs(virtualPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, JSON.stringify(data));
    },
    writeKeepList(entries) {
      fs.writeFileSync(
        path.join(projectRoot, 'asset-keep.json'),
        JSON.stringify({ keep: entries }),
      );
    },
    cleanup() {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    },
  };
}

// ── Tests ────────────────────────────────────────────

/** virtualToAbs duplicates resolveAssetPath's (vite-asset-scanner) containment logic.
 *  That one had a bare-`startsWith` traversal guard, was fixed, and pinned by
 *  viteAssetScanner.test.ts's "sibling dir that shares the root prefix (regression)".
 *  This copy kept the vulnerable form until it was found in a Windows path audit —
 *  mirror the same cases here so the two implementations can't drift apart again. */
describe('asset-tree-shaker virtualToAbs (path-traversal guard)', () => {
  const roots: AssetRoot[] = [{ urlPrefix: '/assets', absDir: path.resolve('/project/assets') }];

  it('resolves a legitimate in-root path', () => {
    expect(virtualToAbs('/assets/models/a.glb', roots))
      .toBe(path.resolve('/project/assets', 'models/a.glb'));
  });

  it('rejects an upward traversal', () => {
    expect(virtualToAbs('/assets/../../etc/passwd', roots)).toBeNull();
  });

  it('rejects a sibling dir that merely shares the root prefix (regression)', () => {
    // `<root>-evil` / `assets-extra` share the textual prefix of `<root>`, so the old
    // `abs.startsWith(root.absDir)` check accepted them. They resolve OUTSIDE the root.
    expect(virtualToAbs('/assets/../assets-evil/secret', roots)).toBeNull();
    expect(virtualToAbs('/assets/sub/../../assets-extra/x', roots)).toBeNull();
  });

  it('still allows a nested .. that normalizes back inside the root', () => {
    expect(virtualToAbs('/assets/a/b/../c.png', roots))
      .toBe(path.resolve('/project/assets', 'a/c.png'));
  });

  /** THE ACTUAL ANTI-RECURRENCE GUARD. The bug above wasn't "someone wrote a weak check" —
   *  it was that the SAME containment logic exists twice (virtualToAbs here,
   *  resolveAssetPath in vite-asset-scanner), one copy got hardened, and the other silently
   *  kept the vulnerable form for however long. Per-function tests can't catch that: both
   *  copies passed their own suites. Assert the two agree on the same inputs, so hardening
   *  or weakening either one alone fails here. Delete this only by deduplicating them.
   *
   *  SCOPE: plain (already-decoded) paths only — the twins legitimately differ on
   *  percent-encoding and that is NOT drift to "fix". resolveAssetPath serves HTTP
   *  requests, so it decodeURIComponent()s first; virtualToAbs consumes authored refs out
   *  of scene JSON, which are not URL-encoded. Measured consequence, recorded so nobody
   *  "aligns" them by accident:
   *    '/assets/%2e%2e/evil.png'  → scanner null (decodes to '..', rejects)
   *                               → shaker  <root>/%2e%2e/evil.png (literal dir name)
   *  The shaker's answer stays INSIDE the root, so this is not an escape — but note the
   *  mirror case: a ref containing '%20' would have the shaker look for a literal
   *  'nor%20mal.png' while the scanner resolves 'nor mal.png'. Asset names with spaces do
   *  exist here (e.g. '2D Animation.json'), so if encoded refs ever reach the shaker, that
   *  asymmetry — not the traversal guard — is the thing to look at. */
  it('agrees with resolveAssetPath on every containment case (twin-drift guard)', () => {
    const cases = [
      '/assets/models/a.glb',          // plain in-root
      '/assets/a/b/../c.png',          // .. that normalizes back inside
      '/assets/../../etc/passwd',      // upward escape
      '/assets/../assets-evil/secret', // prefix-sharing sibling
      '/assets/sub/../../assets-extra/x',
      '/assets/',                      // degenerate
      '/unrelated/x.png',              // no matching root
    ];
    for (const c of cases) {
      const shaker = virtualToAbs(c, roots);
      const scanner = resolveAssetPath(c, roots);
      // Compare null-ness (the security-relevant decision) AND the resolved path.
      expect({ case: c, abs: shaker }).toEqual({ case: c, abs: scanner });
    }
  });
});

describe('asset-tree-shaker', () => {
  let fx: Fixture;

  beforeEach(() => { fx = createFixture(); });
  afterEach(() => { fx.cleanup(); });

  it('keeps scene files and follows resources[] entries', () => {
    fx.writeVirtual('/games/test/assets/models/island.glb', 'fake-glb');
    fx.writeJson('/games/test/assets/scenes/main.json', {
      version: 6,
      resources: [
        { type: 'model', path: '/games/test/assets/models/island.glb' },
      ],
      entities: [],
    });
    fx.writeVirtual('/games/test/assets/models/unused.glb', 'fake-glb-2');

    const result = computeKeptAssets(fx.projectRoot, fx.roots);

    expect(result.kept).toContain('/games/test/assets/scenes/main.json');
    expect(result.kept).toContain('/games/test/assets/models/island.glb');
    expect(result.kept).not.toContain('/games/test/assets/models/unused.glb');
    expect(result.stats.scenes).toBe(1);
  });

  it('walks scene → prefab → mesh → material → texture transitively', () => {
    fx.writeVirtual('/games/test/assets/tex/diffuse.png', 'fake-png');
    fx.writeJson('/games/test/assets/mats/stone.mat.json', {
      texture: '/games/test/assets/tex/diffuse.png',
    });
    fx.writeJson('/games/test/assets/meshes/rock.mesh.json', {
      material: '/games/test/assets/mats/stone.mat.json',
      model: '/games/test/assets/models/rock.glb',
    });
    fx.writeVirtual('/games/test/assets/models/rock.glb', 'fake-glb');
    fx.writeJson('/games/test/assets/models/rock.prefab.json', {
      entities: [
        {
          traits: {
            Renderable3D: {
              mesh: '/games/test/assets/meshes/rock.mesh.json',
            },
          },
        },
      ],
    });
    fx.writeJson('/games/test/assets/scenes/main.json', {
      version: 6,
      resources: [
        { type: 'prefab', path: '/games/test/assets/models/rock.prefab.json' },
      ],
      entities: [],
    });

    const result = computeKeptAssets(fx.projectRoot, fx.roots);

    expect(result.kept).toContain('/games/test/assets/models/rock.prefab.json');
    expect(result.kept).toContain('/games/test/assets/meshes/rock.mesh.json');
    expect(result.kept).toContain('/games/test/assets/mats/stone.mat.json');
    expect(result.kept).toContain('/games/test/assets/models/rock.glb');
    expect(result.kept).toContain('/games/test/assets/tex/diffuse.png');
  });

  it('keeps the AUX PBR texture maps a material references (normal/roughness/metalness/etc.)', () => {
    // Regression: the shaker probed Three.js `…Map` field names but the engine's
    // .mat.json format names them `…Texture` (mirrors meshTemplateCache.ts's
    // `loadInto(data.<slot>)`). Only `texture` (base color) matched, so every
    // normal/roughness/metalness map was shaken out of web builds — the material
    // loaded its base color but lost all PBR detail at runtime.
    for (const f of ['diffuse', 'normal', 'rough', 'metal', 'emissive', 'ao'])
      fx.writeVirtual(`/games/test/assets/tex/${f}.png`, 'fake-png');
    fx.writeJson('/games/test/assets/mats/pbr.mat.json', {
      texture: '/games/test/assets/tex/diffuse.png',
      normalTexture: '/games/test/assets/tex/normal.png',
      roughnessTexture: '/games/test/assets/tex/rough.png',
      metalnessTexture: '/games/test/assets/tex/metal.png',
      emissiveTexture: '/games/test/assets/tex/emissive.png',
      aoTexture: '/games/test/assets/tex/ao.png',
    });
    fx.writeJson('/games/test/assets/meshes/pbr.mesh.json', {
      material: '/games/test/assets/mats/pbr.mat.json',
    });
    fx.writeJson('/games/test/assets/scenes/main.json', {
      version: 6,
      resources: [{ type: 'mesh', path: '/games/test/assets/meshes/pbr.mesh.json' }],
      entities: [],
    });

    const result = computeKeptAssets(fx.projectRoot, fx.roots);

    for (const f of ['diffuse', 'normal', 'rough', 'metal', 'emissive', 'ao'])
      expect(result.kept).toContain(`/games/test/assets/tex/${f}.png`);
  });

  it('DRIFT GUARD: keeps a texture referenced through EVERY material slot in MATERIAL_TEXTURE_SLOTS', () => {
    // MAP_FIELDS (the shaker's material probe) is derived from MATERIAL_TEXTURE_SLOTS,
    // so adding a slot to that single list keeps its texture in prod. If the derivation
    // ever regresses, this fails naming the dropped slot.
    const matData: Record<string, string> = {};
    for (const slot of MATERIAL_TEXTURE_SLOTS) {
      fx.writeVirtual(`/games/test/assets/tex/${slot}.png`, 'fake-png');
      matData[slot] = `/games/test/assets/tex/${slot}.png`;
    }
    fx.writeJson('/games/test/assets/mats/all.mat.json', matData);
    fx.writeJson('/games/test/assets/meshes/all.mesh.json', { material: '/games/test/assets/mats/all.mat.json' });
    fx.writeJson('/games/test/assets/scenes/main.json', {
      version: 6, resources: [{ type: 'mesh', path: '/games/test/assets/meshes/all.mesh.json' }], entities: [],
    });

    const result = computeKeptAssets(fx.projectRoot, fx.roots);

    const dropped = MATERIAL_TEXTURE_SLOTS.filter((s) => !result.kept.has(`/games/test/assets/tex/${s}.png`));
    expect(dropped, `material slots shaken out of the build: ${dropped.join(', ')}`).toEqual([]);
  });

  it('DRIFT GUARD: every loadInto(data.<slot>) in the material loader is in MATERIAL_TEXTURE_SLOTS', () => {
    // The historical bug was the reverse of the test above: the loader read a slot the
    // shaker did not probe. Now both derive from MATERIAL_TEXTURE_SLOTS — assert the
    // loader source references no slot outside that list, so a new loadInto() forces a
    // matching list entry (which the shaker then probes).
    // Resolve from cwd, which is the engine root (engine config) or the repo root.
    const loaderPath = [
      'packages/modoki/src/runtime/loaders/meshTemplateCache.ts',
      'engine/packages/modoki/src/runtime/loaders/meshTemplateCache.ts',
    ].map((p) => path.resolve(process.cwd(), p)).find((p) => fs.existsSync(p));
    expect(loaderPath, 'could not locate meshTemplateCache.ts').toBeTruthy();
    const loaderSrc = fs.readFileSync(loaderPath!, 'utf-8');
    const slotsInLoader = [...loaderSrc.matchAll(/loadInto\(data\.(\w+)/g)].map((m) => m[1]);
    expect(slotsInLoader.length).toBeGreaterThan(0); // guard against a regex that matches nothing
    const known = new Set<string>(MATERIAL_TEXTURE_SLOTS);
    const stray = slotsInLoader.filter((s) => !known.has(s));
    expect(stray, `loadInto slots missing from MATERIAL_TEXTURE_SLOTS: ${stray.join(', ')}`).toEqual([]);
  });

  it('keeps a .particle.json via a ParticleEmitter guid ref and walks its texture', () => {
    const effectGuid = '35a8b17c-3215-4b46-9cc1-3490a328951f';
    const texGuid = '2b002434-2834-47a4-a32f-b530e978ee40';
    fx.writeVirtual('/games/test/assets/tex/spark.png', 'fake-png');
    fx.writeJson('/games/test/assets/tex/spark.png.meta.json', { version: 2, id: texGuid });
    fx.writeJson('/games/test/assets/particles/warp.particle.json', {
      version: 1, id: effectGuid, name: 'Warp', render: { texture: texGuid },
    });
    fx.writeJson('/games/test/assets/particles/unused.particle.json', {
      version: 1, id: 'd32d07b6-c68f-4491-834e-1218a3497d63', name: 'Unused',
    });
    fx.writeJson('/games/test/assets/scenes/main.json', {
      version: 8,
      resources: [],
      entities: [
        { traits: { ParticleEmitter: { effect: effectGuid } } },
      ],
    });

    const result = computeKeptAssets(fx.projectRoot, fx.roots);

    expect(result.kept).toContain('/games/test/assets/particles/warp.particle.json');
    expect(result.kept).toContain('/games/test/assets/tex/spark.png');
    expect(result.kept).not.toContain('/games/test/assets/particles/unused.particle.json');
  });

  it('keeps a library .animset.json via AnimationLibrary and follows its source GLB (P6)', () => {
    const setGuid = '5865c09c-647d-4a82-8c30-857aa72127a7';
    const rigGuid = '40bec7d0-2ee7-44b8-9961-2c861433a927';   // the model's own rig
    const clipsGuid = 'aaaaaaaa-1111-4222-8333-444444444444'; // a SEPARATE clip-source GLB
    fx.writeVirtual('/games/test/assets/models/rig.glb', 'rig');
    fx.writeJson('/games/test/assets/models/rig.glb.meta.json', { version: 2, id: rigGuid });
    fx.writeVirtual('/games/test/assets/models/clips.glb', 'clips');
    fx.writeJson('/games/test/assets/models/clips.glb.meta.json', { version: 2, id: clipsGuid });
    fx.writeJson('/games/test/assets/anim/locomotion.animset.json', {
      id: setGuid, source: clipsGuid, clips: [{ name: 'Walk' }],
    });
    fx.writeVirtual('/games/test/assets/models/unused.glb', 'unused');
    fx.writeJson('/games/test/assets/scenes/main.json', {
      version: 8, resources: [], entities: [
        { traits: { SkinnedModel: { model: rigGuid }, AnimationLibrary: { animSets: [setGuid] } } },
      ],
    });

    const result = computeKeptAssets(fx.projectRoot, fx.roots);

    expect(result.kept).toContain('/games/test/assets/anim/locomotion.animset.json');
    expect(result.kept).toContain('/games/test/assets/models/rig.glb');
    // clips.glb is referenced by NOTHING but the animset's `source` — proves the follow.
    expect(result.kept).toContain('/games/test/assets/models/clips.glb');
    expect(result.kept).not.toContain('/games/test/assets/models/unused.glb');
  });

  it('keeps a .anim.json keyframe clip referenced by an Animator trait', () => {
    const clipGuid = 'cedfaa3d-35f6-4e17-9459-ee3957dad7b4';
    fx.writeJson('/games/test/assets/animations/spin.anim.json', {
      id: clipGuid, duration: 2, tracks: [],
    });
    fx.writeJson('/games/test/assets/animations/unused.anim.json', {
      id: 'ffffffff-0000-4111-8222-333333333333', duration: 1, tracks: [],
    });
    fx.writeJson('/games/test/assets/scenes/main.json', {
      version: 8, resources: [], entities: [
        // New shape: the clip GUID lives inside the JSON-string `clips` bank; `clip` is a NAME.
        { traits: { Animator: { clips: JSON.stringify([{ name: 'spin', clip: clipGuid }]), clip: 'spin', playing: true } } },
      ],
    });

    const result = computeKeptAssets(fx.projectRoot, fx.roots);

    // Without Animator.clips parsing this clip is shaken out and getAnimationClip 404s
    // on the deployed build — keyframe animation silently dies in prod.
    expect(result.kept).toContain('/games/test/assets/animations/spin.anim.json');
    expect(result.kept).not.toContain('/games/test/assets/animations/unused.anim.json');
  });

  // ── Video retention ──────────────────────────────────
  //
  // This class of bug has bitten repeatedly: a kind the SCANNER ships but the SHAKER
  // classifies 'other' is silently dropped from the prod build while working fine in
  // dev (the `.anim.json` failure recorded in assetTypeClassifier.ts). Video is
  // registered in the shared BINARY_EXT_TYPE table, which is *supposed* to make both
  // sides agree — these tests prove it rather than trusting the derivation.

  it('keeps a video referenced by a GUID on an arbitrary trait field', () => {
    const videoGuid = '11111111-2222-4333-8444-555555555555';
    fx.writeVirtual('/games/test/assets/video/intro.mp4', 'fake-mp4');
    fx.writeJson('/games/test/assets/video/intro.mp4.meta.json', { version: 2, id: videoGuid });
    fx.writeVirtual('/games/test/assets/video/unused.mp4', 'unused-mp4');
    fx.writeJson('/games/test/assets/video/unused.mp4.meta.json', {
      version: 2, id: '99999999-8888-4777-8666-555555555555',
    });
    fx.writeJson('/games/test/assets/scenes/main.json', {
      version: 6,
      entities: [
        // A trait the shaker has never heard of, carrying a video GUID — the generic
        // trait-field walk is what must catch this, since there is no VideoPlayer
        // entry in any ref registry.
        { id: 'e1', name: 'Screen', traits: { VideoPlayer: { clip: videoGuid, loop: true } } },
      ],
    });

    const result = computeKeptAssets(fx.projectRoot, fx.roots);

    expect(result.kept).toContain('/games/test/assets/video/intro.mp4');
    // The unreferenced one must still be dropped — otherwise "kept" proves nothing.
    expect(result.kept).not.toContain('/games/test/assets/video/unused.mp4');
  });

  it('classifies every accepted video container as shippable, not "other"', () => {
    // A container the table lists but the shaker misclassifies would be dropped from
    // prod while shipping in dev — the exact silent-divergence failure.
    const exts = ['.mp4', '.mov', '.m4v', '.webm', '.mkv'];
    const guids = exts.map((_, i) => `aaaaaaaa-bbbb-4ccc-8ddd-00000000000${i}`);
    exts.forEach((ext, i) => {
      fx.writeVirtual(`/games/test/assets/video/clip${i}${ext}`, 'bytes');
      fx.writeJson(`/games/test/assets/video/clip${i}${ext}.meta.json`, { version: 2, id: guids[i] });
    });
    fx.writeJson('/games/test/assets/scenes/main.json', {
      version: 6,
      entities: guids.map((g, i) => ({
        id: `e${i}`, name: `S${i}`, traits: { VideoPlayer: { clip: g } },
      })),
    });

    const result = computeKeptAssets(fx.projectRoot, fx.roots);

    exts.forEach((ext, i) => {
      expect(result.kept).toContain(`/games/test/assets/video/clip${i}${ext}`);
    });
  });

  it('keeps a .timeline.json via Director and follows its audio-cue GUIDs', () => {
    const tlGuid = '11111111-2222-4333-8444-555555555555';
    const sfxGuid = '66666666-7777-4888-8999-aaaaaaaaaaaa';
    fx.writeVirtual('/games/test/assets/audio/hit.mp3', 'sfx');
    fx.writeJson('/games/test/assets/audio/hit.mp3.meta.json', { version: 2, id: sfxGuid });
    fx.writeVirtual('/games/test/assets/audio/unused.mp3', 'unused');
    fx.writeJson('/games/test/assets/timelines/cutscene.timeline.json', {
      id: tlGuid, duration: 3, tracks: [
        { id: 'a', name: 'Audio', target: '', type: 'audio', cues: [{ t: 1.5, clip: sfxGuid }] },
      ],
    });
    fx.writeJson('/games/test/assets/scenes/main.json', {
      version: 9, resources: [], entities: [
        { traits: { Director: { timeline: tlGuid, playing: true } } },
      ],
    });

    const result = computeKeptAssets(fx.projectRoot, fx.roots);

    expect(result.kept).toContain('/games/test/assets/timelines/cutscene.timeline.json');
    // hit.mp3 is referenced by NOTHING but the timeline's audio cue — proves the follow.
    expect(result.kept).toContain('/games/test/assets/audio/hit.mp3');
    expect(result.kept).not.toContain('/games/test/assets/audio/unused.mp3');
  });

  it('keeps a CONTROL-track prefab referenced ONLY through a .timeline.json', () => {
    const tlGuid = '11111111-2222-4333-8444-666666666666';
    const prefabGuid = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
    fx.writeJson('/games/test/assets/prefabs/spark.prefab.json', {
      id: prefabGuid, version: 1, name: 'Spark', rootLocalId: 1,
      entities: [{ localId: 1, traits: { EntityAttributes: { name: 'Spark' } } }],
    });
    fx.writeJson('/games/test/assets/prefabs/unused.prefab.json', {
      id: '99999999-0000-4111-8222-cccccccccccc', version: 1, name: 'Unused', rootLocalId: 1,
      entities: [{ localId: 1, traits: { EntityAttributes: { name: 'Unused' } } }],
    });
    fx.writeJson('/games/test/assets/timelines/fx.timeline.json', {
      id: tlGuid, duration: 3, tracks: [
        { id: 'c', name: 'FX', target: '', type: 'control', clips: [{ start: 1, prefab: prefabGuid }] },
      ],
    });
    fx.writeJson('/games/test/assets/scenes/main.json', {
      version: 9, resources: [], entities: [
        { traits: { Director: { timeline: tlGuid, playing: true } } },
      ],
    });

    const result = computeKeptAssets(fx.projectRoot, fx.roots);

    expect(result.kept).toContain('/games/test/assets/timelines/fx.timeline.json');
    // spark.prefab.json is reachable ONLY via the control clip's prefab GUID — proves the follow.
    expect(result.kept).toContain('/games/test/assets/prefabs/spark.prefab.json');
    expect(result.kept).not.toContain('/games/test/assets/prefabs/unused.prefab.json');
  });

  it('keeps a VIDEO-track clip referenced ONLY through a .timeline.json', () => {
    // A cutscene's clip has no other owner in the scene: the Director points at the timeline,
    // and the clip GUID lives inside it. Without the follow it ships as a 404 that only shows
    // up in a real production build — the failure mode this whole family of tests exists for.
    const tlGuid = '11111111-2222-4333-8444-777777777777';
    const vidGuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    fx.writeVirtual('/games/test/assets/video/intro.mp4', 'fake-mp4');
    fx.writeJson('/games/test/assets/video/intro.mp4.meta.json', { version: 2, id: vidGuid });
    fx.writeVirtual('/games/test/assets/video/unused.mp4', 'unused-mp4');
    fx.writeJson('/games/test/assets/video/unused.mp4.meta.json', {
      version: 2, id: 'dddddddd-eeee-4fff-8000-111111111111',
    });
    fx.writeJson('/games/test/assets/timelines/intro.timeline.json', {
      id: tlGuid, duration: 6, tracks: [
        { id: 'v', name: 'Screen', target: '', type: 'video', clips: [{ start: 0, duration: 5, clip: vidGuid }] },
      ],
    });
    fx.writeJson('/games/test/assets/scenes/main.json', {
      version: 9, resources: [], entities: [
        { traits: { Director: { timeline: tlGuid, playing: true } } },
      ],
    });

    const result = computeKeptAssets(fx.projectRoot, fx.roots);

    expect(result.kept).toContain('/games/test/assets/timelines/intro.timeline.json');
    expect(result.kept).toContain('/games/test/assets/video/intro.mp4');
    expect(result.kept).not.toContain('/games/test/assets/video/unused.mp4');
  });

  it('drops every video clip when the video module is excluded — and says which', () => {
    // This is what the `build.modules.video` toggle is actually FOR. Video's JS is engine code
    // the runtime barrel keeps alive regardless (measured: a flag-gated dynamic import shed
    // 3 KB of ~25 KB), so the megabytes are the clips — and a playable's 5 MB cap is the whole
    // reason the module defaults off there.
    const vidGuid = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001';
    const texGuid = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000002';
    fx.writeVirtual('/games/test/assets/video/intro.mp4', 'fake-mp4');
    fx.writeJson('/games/test/assets/video/intro.mp4.meta.json', { version: 2, id: vidGuid });
    fx.writeVirtual('/games/test/assets/textures/hero.png', 'png');
    fx.writeJson('/games/test/assets/textures/hero.png.meta.json', { version: 2, id: texGuid });
    fx.writeJson('/games/test/assets/scenes/main.json', {
      version: 9, resources: [], entities: [
        { traits: { VideoPlayer: { clip: vidGuid }, Renderable2D: { sprite: texGuid } } },
      ],
    });

    const kept = computeKeptAssets(fx.projectRoot, fx.roots);
    expect(kept.kept).toContain('/games/test/assets/video/intro.mp4');

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stripped = computeKeptAssets(fx.projectRoot, fx.roots, { excludeVideo: true });
    expect(stripped.kept).not.toContain('/games/test/assets/video/intro.mp4');
    // Only video goes — an excluded module must not take the rest of the scene with it.
    expect(stripped.kept).toContain('/games/test/assets/textures/hero.png');
    // Never silent: a build that quietly ships a game minus its cutscenes looks fine until
    // someone plays it.
    expect(log).toHaveBeenCalledWith(expect.stringContaining('/games/test/assets/video/intro.mp4'));
    log.mockRestore();
  });

  // ── Generic GUID sweep (2026-07-26) — game-defined traits with no REF_FIELDS_BY_TRAIT
  //    entry. Sling's `FieldSource` (level/wave/enemyPrefab, all asset guids) is a GAME trait
  //    that can't register into the engine's registry without violating the game-portability
  //    rule, so its refs were invisible to the tree-shaker until the sweep below was added. ──

  it('keeps an asset referenced by an UNREGISTERED trait — the sling FieldSource bug, generically', () => {
    const levelGuid = 'c0ffee00-0000-4000-8000-000000000001';
    fx.writeJson('/games/test/assets/levels/0001.level.json', { id: levelGuid, cols: 1, rows: 1 });
    fx.writeJson('/games/test/assets/scenes/main.json', {
      version: 6, resources: [],
      // FieldSource is NOT in REF_FIELDS_BY_TRAIT — a plain game trait.
      entities: [{ traits: { FieldSource: { level: levelGuid, wave: '', enemyPrefab: '' } } }],
    });

    const result = computeKeptAssets(fx.projectRoot, fx.roots);

    expect(result.kept).toContain('/games/test/assets/levels/0001.level.json');
  });

  it('follows an unregistered-trait ref TRANSITIVELY (prefab -> mesh -> material -> texture)', () => {
    const prefabGuid = 'c0ffee00-0000-4000-8000-000000000002';
    fx.writeVirtual('/games/test/assets/tex/enemy.png', 'fake-png');
    fx.writeJson('/games/test/assets/mats/enemy.mat.json', { texture: '/games/test/assets/tex/enemy.png' });
    fx.writeJson('/games/test/assets/meshes/enemy.mesh.json', { material: '/games/test/assets/mats/enemy.mat.json' });
    fx.writeJson('/games/test/assets/prefabs/enemy.prefab.json', {
      id: prefabGuid,
      entities: [{ traits: { Renderable3D: { mesh: '/games/test/assets/meshes/enemy.mesh.json' } } }],
    });
    fx.writeJson('/games/test/assets/scenes/main.json', {
      version: 6, resources: [],
      entities: [{ traits: { FieldSource: { level: '', wave: '', enemyPrefab: prefabGuid } } }],
    });

    const result = computeKeptAssets(fx.projectRoot, fx.roots);

    expect(result.kept).toContain('/games/test/assets/prefabs/enemy.prefab.json');
    expect(result.kept).toContain('/games/test/assets/meshes/enemy.mesh.json');
    expect(result.kept).toContain('/games/test/assets/mats/enemy.mat.json');
    expect(result.kept).toContain('/games/test/assets/tex/enemy.png');
  });

  it('does NOT keep or warn on a well-formed guid that is NOT an asset (an entity reference)', () => {
    // The sweep must stay silent on a miss: an entity-ref field is ALSO a guid-shaped string,
    // and it is never in the asset index. If the sweep routed misses through pushRef's warning
    // path, every ordinary entity reference would flood the build log with false
    // "unresolved GUID ref" noise. Regression pin for that trap.
    const entityRefGuid = 'deadbeef-0000-4000-8000-000000000099'; // not backed by any asset file
    fx.writeJson('/games/test/assets/scenes/main.json', {
      version: 6, resources: [],
      entities: [{ traits: { SomeGameTrait: { targetEntity: entityRefGuid } } }],
    });

    const result = computeKeptAssets(fx.projectRoot, fx.roots);

    expect([...result.kept].some((p) => p.includes(entityRefGuid))).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  // ── Drift guards: keep the tree-shaker's knowledge in lock-step with the two
  //    registries it derives from, so a new asset type / ref field can't ship in
  //    dev but get shaken out of prod (the Animator.clip class of bug). ──

  it('DRIFT GUARD: keeps an asset referenced through EVERY field in REF_FIELDS_BY_TRAIT', () => {
    // One unique GUID+asset file per (trait, field). If someone adds a ref field
    // to the registry but the shaker's generic walk stops covering it, the matching
    // asset is dropped and this fails — naming the exact trait/field that regressed.
    let n = 0;
    const guidFor = () => `aaaaaaaa-0000-4000-8000-${String(++n).padStart(12, '0')}`;
    const expectedPaths: string[] = [];
    const entities: Array<{ traits: Record<string, Record<string, string>> }> = [];

    for (const [traitName, fields] of Object.entries(REF_FIELDS_BY_TRAIT)) {
      const traitData: Record<string, string> = {};
      for (const field of fields) {
        const guid = guidFor();
        const p = `/games/test/assets/gen/${traitName}.${field}.prefab.json`;
        fx.writeJson(p, { id: guid });
        traitData[field] = guid;
        expectedPaths.push(p);
      }
      entities.push({ traits: { [traitName]: traitData } });
    }
    fx.writeJson('/games/test/assets/scenes/main.json', { version: 8, resources: [], entities });

    const result = computeKeptAssets(fx.projectRoot, fx.roots);

    const missing = expectedPaths.filter((p) => !result.kept.has(p));
    expect(missing, `ref fields NOT walked by the tree-shaker: ${missing.join(', ')}`).toEqual([]);
  });

  it('DRIFT GUARD: the scanner (detectType) and the shared classifier agree on every JSON asset suffix', () => {
    // detectType (scanner) and classify (tree-shaker) both route JSON asset kinds
    // through classifyJsonAssetSuffix. Assert the scanner honors it for every entry,
    // and that each kind is registered as id-bearing (so buildGuidIndex reads its id).
    for (const [suffix, type] of JSON_ASSET_SUFFIX_TYPE) {
      expect(classifyJsonAssetSuffix(`foo${suffix}`)).toBe(type);
      expect(detectType(`/games/test/assets/foo${suffix}`, '.json')).toBe(type);
      expect(ID_BEARING_TYPES.has(type), `${type} must be id-bearing`).toBe(true);
    }
  });

  it('keeps a file shader manifest + its backend sidecars via a material guid ref', () => {
    const shaderGuid = '7a3e9c1d-2b4f-4a6c-8d1e-5f9a0b2c3d4e';
    fx.writeJson('/games/test/assets/shaders/holo.shader.json', { id: shaderGuid, name: 'Holo', params: {} });
    fx.writeVirtual('/games/test/assets/shaders/holo.wgsl', 'fn surface() -> vec4<f32> { return vec4<f32>(1.0); }');
    fx.writeVirtual('/games/test/assets/shaders/holo.glsl', 'vec4 surface() { return vec4(1.0); }');
    fx.writeVirtual('/games/test/assets/shaders/unused.wgsl', 'orphan');
    fx.writeJson('/games/test/assets/mats/holo.mat.json', { type: 'custom', shader: shaderGuid });
    fx.writeJson('/games/test/assets/scenes/main.json', {
      version: 6,
      resources: [{ type: 'material', path: '/games/test/assets/mats/holo.mat.json' }],
      entities: [],
    });

    const result = computeKeptAssets(fx.projectRoot, fx.roots);

    expect(result.kept).toContain('/games/test/assets/mats/holo.mat.json');
    expect(result.kept).toContain('/games/test/assets/shaders/holo.shader.json');
    expect(result.kept).toContain('/games/test/assets/shaders/holo.wgsl');
    expect(result.kept).toContain('/games/test/assets/shaders/holo.glsl');
    expect(result.kept).not.toContain('/games/test/assets/shaders/unused.wgsl');
  });

  it('keeps a texture referenced via a custom-shader param (params.diffuse)', () => {
    const texGuid = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
    fx.writeVirtual('/games/test/assets/tex/ship.png', 'fake-png');
    fx.writeJson('/games/test/assets/tex/ship.png.meta.json', { version: 2, id: texGuid });
    fx.writeJson('/games/test/assets/mats/halo.mat.json', {
      type: 'custom', shader: 'game/code-shader',
      params: { diffuse: texGuid, mode: 'additive', rimPower: 3 },
    });
    fx.writeJson('/games/test/assets/scenes/main.json', {
      version: 6,
      resources: [{ type: 'material', path: '/games/test/assets/mats/halo.mat.json' }],
      entities: [],
    });

    const result = computeKeptAssets(fx.projectRoot, fx.roots);

    expect(result.kept).toContain('/games/test/assets/tex/ship.png');
  });

  it("keeps a 2D shader's texture-param default (extra sampler) so it ships in prod", () => {
    // A space:'2d' shader binds `texture` params' `default` GUIDs as extra samplers at
    // runtime (Scene2D). processShader must follow them or the sampler texture is shaken out.
    const texGuid = '11112222-3333-4444-8555-666677778888';
    fx.writeVirtual('/games/test/assets/tex/noise.png', 'fake-png');
    fx.writeJson('/games/test/assets/tex/noise.png.meta.json', { version: 2, id: texGuid });
    fx.writeJson('/games/test/assets/shaders/reveal.shader.json', {
      id: '99990000-1111-4222-8333-444455556666', name: 'Reveal', space: '2d',
      params: { uNoise: { type: 'texture', default: texGuid }, uMix: { type: 'float', default: 0 } },
    });
    fx.writeVirtual('/games/test/assets/shaders/reveal.wgsl', 'outColor = vec4<f32>(1.0);');
    fx.writeJson('/games/test/assets/scenes/main.json', {
      version: 6, resources: [],
      entities: [{ traits: { Renderable2D: { material: '/games/test/assets/shaders/reveal.shader.json' } } }],
    });

    const result = computeKeptAssets(fx.projectRoot, fx.roots);

    expect(result.kept).toContain('/games/test/assets/shaders/reveal.shader.json');
    expect(result.kept).toContain('/games/test/assets/tex/noise.png'); // followed the texture-param default
  });

  it("keeps a texture bound via a MaterialInstance kind:'texture' override ref", () => {
    const texGuid = 'aaaabbbb-cccc-4ddd-8eee-ffff00001111';
    fx.writeVirtual('/games/test/assets/tex/metal.png', 'fake-png');
    fx.writeJson('/games/test/assets/tex/metal.png.meta.json', { version: 2, id: texGuid });
    fx.writeJson('/games/test/assets/scenes/main.json', {
      version: 6, resources: [],
      entities: [{
        traits: {
          MaterialInstance: { overrides: [{ target: 'uReveal', kind: 'texture', ref: texGuid }] },
        },
      }],
    });

    const result = computeKeptAssets(fx.projectRoot, fx.roots);

    expect(result.kept).toContain('/games/test/assets/tex/metal.png'); // per-instance override ref followed
  });

  it('collects Environment.hdrPath from entity traits', () => {
    fx.writeVirtual('/games/test/assets/env/sunset.hdr', 'fake-hdr');
    fx.writeJson('/games/test/assets/scenes/main.json', {
      version: 6,
      resources: [],
      entities: [
        {
          id: 1,
          traits: {
            Environment: { hdrPath: '/games/test/assets/env/sunset.hdr' },
          },
        },
      ],
    });

    const result = computeKeptAssets(fx.projectRoot, fx.roots);

    expect(result.kept).toContain('/games/test/assets/env/sunset.hdr');
  });

  it('collects PrefabInstance.source and walks recursively', () => {
    fx.writeJson('/games/test/assets/prefabs/inner.prefab.json', {
      entities: [
        {
          traits: {
            ModelSource: { glbPath: '/games/test/assets/models/inner.glb' },
          },
        },
      ],
    });
    fx.writeVirtual('/games/test/assets/models/inner.glb', 'fake');
    fx.writeJson('/games/test/assets/scenes/main.json', {
      version: 6,
      entities: [
        {
          id: 1,
          traits: {
            PrefabInstance: { source: '/games/test/assets/prefabs/inner.prefab.json' },
          },
        },
      ],
    });

    const result = computeKeptAssets(fx.projectRoot, fx.roots);

    expect(result.kept).toContain('/games/test/assets/prefabs/inner.prefab.json');
    expect(result.kept).toContain('/games/test/assets/models/inner.glb');
  });

  it('keeps a SkinnedModel GLB referenced through a prefab (rigged path)', () => {
    // Real-world shape: an animated creature is a prefab instance whose member
    // carries SkinnedModel.model (the rigged GLB). Regression for the alien-animal
    // device bug — the GLB was tree-shaken out and 404'd ("Unknown asset guid").
    fx.writeJson('/games/test/assets/prefabs/creature.prefab.json', {
      entities: [
        {
          traits: {
            SkinnedModel: { model: '/games/test/assets/models/creature.glb' },
          },
        },
      ],
    });
    fx.writeVirtual('/games/test/assets/models/creature.glb', 'fake');
    fx.writeJson('/games/test/assets/scenes/main.json', {
      version: 6,
      entities: [
        { id: 1, traits: { PrefabInstance: { source: '/games/test/assets/prefabs/creature.prefab.json' } } },
      ],
    });

    const result = computeKeptAssets(fx.projectRoot, fx.roots);

    expect(result.kept).toContain('/games/test/assets/models/creature.glb');
  });

  it('resolves fontFamily to matching files by parsed family name', () => {
    // Write a handful of font files across two families.
    fx.writeVirtual('/modoki/assets/fonts/Roboto/Roboto-Regular.ttf', 'fake');
    fx.writeVirtual('/modoki/assets/fonts/Roboto/Roboto-Bold.ttf', 'fake');
    fx.writeVirtual('/modoki/assets/fonts/Roboto/Roboto-Italic.ttf', 'fake');
    fx.writeVirtual('/modoki/assets/fonts/Lato/Lato-Regular.ttf', 'fake');
    fx.writeVirtual('/modoki/assets/fonts/Lato/Lato-Bold.ttf', 'fake');

    fx.writeJson('/games/test/assets/scenes/main.json', {
      version: 6,
      entities: [
        {
          id: 1,
          traits: {
            UIElement: { fontFamily: 'Roboto' },
          },
        },
      ],
    });

    const result = computeKeptAssets(fx.projectRoot, fx.roots);

    expect(result.kept).toContain('/modoki/assets/fonts/Roboto/Roboto-Regular.ttf');
    expect(result.kept).toContain('/modoki/assets/fonts/Roboto/Roboto-Bold.ttf');
    expect(result.kept).toContain('/modoki/assets/fonts/Roboto/Roboto-Italic.ttf');
    expect(result.kept).not.toContain('/modoki/assets/fonts/Lato/Lato-Regular.ttf');
    expect(result.kept).not.toContain('/modoki/assets/fonts/Lato/Lato-Bold.ttf');
  });

  it('drops all fonts when no scene sets fontFamily', () => {
    fx.writeVirtual('/modoki/assets/fonts/Roboto/Roboto-Regular.ttf', 'fake');
    fx.writeVirtual('/modoki/assets/fonts/Lato/Lato-Regular.ttf', 'fake');
    fx.writeJson('/games/test/assets/scenes/empty.json', {
      version: 6,
      entities: [],
    });

    const result = computeKeptAssets(fx.projectRoot, fx.roots);

    expect(result.kept).not.toContain('/modoki/assets/fonts/Roboto/Roboto-Regular.ttf');
    expect(result.kept).not.toContain('/modoki/assets/fonts/Lato/Lato-Regular.ttf');
    expect(result.stats.keptByType.font ?? 0).toBe(0);
  });

  it('keeps assets listed in asset-keep.json even when unreferenced', () => {
    fx.writeVirtual('/games/test/assets/extras/loose.png', 'fake');
    fx.writeJson('/games/test/assets/scenes/empty.json', {
      version: 6,
      entities: [],
    });
    fx.writeKeepList(['/games/test/assets/extras/loose.png']);

    const result = computeKeptAssets(fx.projectRoot, fx.roots);

    expect(result.kept).toContain('/games/test/assets/extras/loose.png');
  });

  it('keeps an ENGINE asset listed by a keep-list entry under /modoki/assets', () => {
    // The path Court's production build actually takes since #52: it renders its board labels
    // with the engine's built-in MSDF font (DEFAULT_FONT_GUID) instead of a copy in its own
    // assets, and nothing in a scene references it — so the ONLY thing keeping that font in the
    // build is a keep-list entry pointing OUT of the project, into the engine asset root.
    //
    // Every other keep-list test above lists a `/games/test/assets/...` path, and the two engine
    // font tests reach `/modoki/assets` by CSS FAMILY, which is a different resolver. So nothing
    // covered an engine-root path arriving through the keep list. If `loadKeepList`'s
    // virtualToAbs stopped resolving against the engine root, it would not fail quietly: a
    // keep entry that resolves to nothing is treated as STALE and THROWS. That is a broken
    // build for every game using a built-in asset, and this is what would catch it.
    fx.writeVirtual('/modoki/assets/fonts/Arimo/Arimo-VariableFont_wght.ttf', 'fake');
    fx.writeVirtual('/modoki/assets/fonts/Nunito/Nunito-VariableFont_wght.ttf', 'fake');
    fx.writeJson('/games/test/assets/scenes/main.json', { version: 6, entities: [] });
    fx.writeKeepList(['/modoki/assets/fonts/Arimo/Arimo-VariableFont_wght.ttf']);

    const result = computeKeptAssets(fx.projectRoot, fx.roots);

    expect(result.kept).toContain('/modoki/assets/fonts/Arimo/Arimo-VariableFont_wght.ttf');
    // The blessed font is kept BY NAME, not by "engine assets are exempt" — an unlisted engine
    // font next to it still drops. This is the measurement behind keeping 5 bundled families:
    // they cost a game nothing, so the answer to "ship only one?" is no.
    expect(result.kept).not.toContain('/modoki/assets/fonts/Nunito/Nunito-VariableFont_wght.ttf');
  });

  it('walks keep-list entries transitively (a listed prefab keeps its mesh/material/texture)', () => {
    // A code-spawned prefab (e.g. sling's field kit, instantiated only by rebuildField):
    // nothing in the scene graph references it, so ONLY the keep-list can reach it — and
    // it must pull its whole dependency subtree, else the build ships a prefab whose
    // meshes/materials/textures got dropped (the field-grass regression).
    fx.writeVirtual('/games/test/assets/tex/grass.png', 'fake-png');
    fx.writeJson('/games/test/assets/mats/grass.mat.json', { texture: '/games/test/assets/tex/grass.png' });
    fx.writeJson('/games/test/assets/meshes/blade.mesh.json', {
      material: '/games/test/assets/mats/grass.mat.json',
      model: '/games/test/assets/models/blade.glb',
    });
    fx.writeVirtual('/games/test/assets/models/blade.glb', 'fake-glb');
    fx.writeJson('/games/test/assets/prefabs/kit.prefab.json', {
      entities: [{ traits: { Renderable3D: { mesh: '/games/test/assets/meshes/blade.mesh.json' } } }],
    });
    // The scene does NOT reference the prefab — only the keep-list does.
    fx.writeJson('/games/test/assets/scenes/main.json', { version: 6, entities: [] });
    fx.writeKeepList(['/games/test/assets/prefabs/kit.prefab.json']);

    const result = computeKeptAssets(fx.projectRoot, fx.roots);

    // The prefab AND its whole transitive subtree survive via the keep-list alone.
    expect(result.kept).toContain('/games/test/assets/prefabs/kit.prefab.json');
    expect(result.kept).toContain('/games/test/assets/meshes/blade.mesh.json');
    expect(result.kept).toContain('/games/test/assets/mats/grass.mat.json');
    expect(result.kept).toContain('/games/test/assets/tex/grass.png');
    expect(result.kept).toContain('/games/test/assets/models/blade.glb');
  });

  it('expands a filename glob in asset-keep.json (GENERATED content: court levels)', () => {
    // Court's .court.json levels are minted by tools/generate.ts and fetched by PATH from
    // game code, so neither the scene graph nor the generic trait sweep can reach them.
    // A literal keep-list would go stale on the next generate run with nothing catching it,
    // so the glob is what makes generated content safe to add.
    fx.writeJson('/games/test/assets/levels/a.court.json', { id: 'a' });
    fx.writeJson('/games/test/assets/levels/b.court.json', { id: 'b' });
    fx.writeJson('/games/test/assets/levels/index.json', { levels: [] });
    fx.writeVirtual('/games/test/assets/levels/notes.txt', 'not a level');
    fx.writeJson('/games/test/assets/scenes/empty.json', { version: 6, entities: [] });
    fx.writeKeepList(['/games/test/assets/levels/*.court.json']);

    const result = computeKeptAssets(fx.projectRoot, fx.roots);

    expect(result.kept).toContain('/games/test/assets/levels/a.court.json');
    expect(result.kept).toContain('/games/test/assets/levels/b.court.json');
    // The glob is not a directory wildcard — siblings it doesn't match stay dropped.
    expect(result.kept).not.toContain('/games/test/assets/levels/index.json');
    expect(result.kept).not.toContain('/games/test/assets/levels/notes.txt');
  });

  it('fails loudly when an asset-keep.json glob matches nothing', () => {
    // A stale pattern must fail the build just as loudly as a stale literal path —
    // otherwise a renamed/moved directory silently ships a game with no content.
    fx.writeJson('/games/test/assets/scenes/empty.json', { version: 6, entities: [] });
    fx.writeKeepList(['/games/test/assets/levels/*.court.json']);

    expect(() => computeKeptAssets(fx.projectRoot, fx.roots)).toThrow(/do not exist/i);
  });

  it('fails loudly when asset-keep.json references a missing file', () => {
    fx.writeJson('/games/test/assets/scenes/empty.json', {
      version: 6,
      entities: [],
    });
    fx.writeKeepList(['/games/test/assets/does/not/exist.png']);

    expect(() => computeKeptAssets(fx.projectRoot, fx.roots)).toThrow(/do not exist/i);
  });

  it('warns when a scene references a missing file and keeps building', () => {
    fx.writeJson('/games/test/assets/scenes/main.json', {
      version: 6,
      resources: [
        { type: 'model', path: '/games/test/assets/models/ghost.glb' },
      ],
      entities: [],
    });

    const result = computeKeptAssets(fx.projectRoot, fx.roots);

    expect(result.warnings.some(w => /missing file.*ghost\.glb/i.test(w))).toBe(true);
    // Scene itself still kept; ghost reference pruned from the final set.
    expect(result.kept).toContain('/games/test/assets/scenes/main.json');
    expect(result.kept).not.toContain('/games/test/assets/models/ghost.glb');
  });

  it('reports orphan files that exist on disk but are unreferenced', () => {
    fx.writeVirtual('/games/test/assets/extras/unused.glb', 'fake');
    fx.writeJson('/games/test/assets/scenes/main.json', {
      version: 6,
      entities: [],
    });

    const result = computeKeptAssets(fx.projectRoot, fx.roots);

    expect(result.orphans).toContain('/games/test/assets/extras/unused.glb');
    expect(result.stats.droppedBytes).toBeGreaterThan(0);
  });

  it('never reports a SIDECAR as an orphan — neither .meta.json nor .meta.local.json', () => {
    // The gitignored machine-local half used to classify as 'unknown-json' and so got its
    // own row in "Clean Up Unused Assets": every freshly imported texture showed as TWO
    // orphans, and the second could not be bundled away with its parent.
    fx.writeVirtual('/games/test/assets/tex/probe.png', 'fake');
    fx.writeJson('/games/test/assets/tex/probe.png.meta.json', { version: 2, id: '11111111-1111-4111-8111-111111111111' });
    fx.writeJson('/games/test/assets/tex/probe.png.meta.local.json', { textureCache: { bytes: 123 } });
    fx.writeJson('/games/test/assets/scenes/main.json', { version: 6, entities: [] });

    const result = computeKeptAssets(fx.projectRoot, fx.roots);

    expect(result.orphans).toContain('/games/test/assets/tex/probe.png');
    expect(result.orphans.filter((o) => o.includes('.meta'))).toEqual([]);
  });

  it('keeps the HDR referenced via Environment trait in a real-world-ish scene', () => {
    // Mirrors the tropical-island.json shape: scene has Environment entity + ModelSource entity.
    fx.writeVirtual('/games/test/assets/models/island.glb', 'fake');
    fx.writeVirtual('/games/test/assets/models/env.hdr', 'fake');
    fx.writeJson('/games/test/assets/models/island.prefab.json', { entities: [] });
    fx.writeJson('/games/test/assets/scenes/island.json', {
      version: 6,
      resources: [
        { type: 'model', path: '/games/test/assets/models/island.glb' },
        { type: 'prefab', path: '/games/test/assets/models/island.prefab.json' },
      ],
      entities: [
        {
          id: 1,
          traits: {
            ModelSource: {
              glbPath: '/games/test/assets/models/island.glb',
              postprocessor: 'island',
            },
          },
        },
        {
          id: 2,
          traits: {
            Environment: { hdrPath: '/games/test/assets/models/env.hdr' },
          },
        },
      ],
    });

    const result = computeKeptAssets(fx.projectRoot, fx.roots);

    expect(result.kept).toContain('/games/test/assets/models/island.glb');
    expect(result.kept).toContain('/games/test/assets/models/env.hdr');
    expect(result.kept).toContain('/games/test/assets/models/island.prefab.json');
  });

  it('ignores symbolic sprite names that are not file paths', () => {
    fx.writeJson('/games/test/assets/scenes/main.json', {
      version: 6,
      entities: [
        {
          id: 1,
          traits: {
            Renderable2D: { sprite: 'square' },
          },
        },
      ],
    });

    const result = computeKeptAssets(fx.projectRoot, fx.roots);

    // 'square' is not a virtual path — should not end up in keep set
    for (const p of result.kept) {
      expect(p).not.toBe('square');
    }
  });

  it('resolves GUID refs through the manifest across the full graph', () => {
    const TEX = '11111111-1111-4111-8111-111111111111';
    const MAT = '22222222-2222-4222-8222-222222222222';
    const MESH = '33333333-3333-4333-8333-333333333333';
    const MODEL = '44444444-4444-4444-8444-444444444444';
    const PREFAB = '55555555-5555-4555-8555-555555555555';
    const HDR = '66666666-6666-4666-8666-666666666666';

    // Texture (binary — id lives in sidecar)
    fx.writeVirtual('/games/test/assets/tex/diffuse.png', 'fake-png');
    fx.writeJson('/games/test/assets/tex/diffuse.png.meta.json', { id: TEX, version: 2 });
    // Material (JSON id) → references texture by GUID
    fx.writeJson('/games/test/assets/mats/stone.mat.json', { id: MAT, version: 1, texture: TEX });
    // Model (binary)
    fx.writeVirtual('/games/test/assets/models/rock.glb', 'fake-glb');
    fx.writeJson('/games/test/assets/models/rock.glb.meta.json', { id: MODEL, version: 2 });
    // Mesh (JSON id) → references model + material by GUID
    fx.writeJson('/games/test/assets/meshes/rock.mesh.json', { id: MESH, model: MODEL, material: MAT, mesh: 'rock' });
    // HDR (binary)
    fx.writeVirtual('/games/test/assets/env/sky.hdr', 'fake-hdr');
    fx.writeJson('/games/test/assets/env/sky.hdr.meta.json', { id: HDR, version: 2 });
    // Prefab (JSON id) → references mesh by GUID via Renderable3D
    fx.writeJson('/games/test/assets/prefabs/rock.prefab.json', {
      id: PREFAB, version: 1, rootLocalId: 1,
      entities: [{ localId: 1, traits: { Renderable3D: { mesh: MESH } } }],
    });
    // Scene → references prefab + hdr by GUID (both resources[] and entity traits)
    fx.writeJson('/games/test/assets/scenes/main.json', {
      version: 8,
      resources: [
        { type: 'prefab', path: PREFAB },
        { type: 'environment', path: HDR },
      ],
      entities: [
        { id: 1, traits: { PrefabInstance: { source: PREFAB } } },
        { id: 2, traits: { Environment: { hdrPath: HDR } } },
      ],
    });

    const result = computeKeptAssets(fx.projectRoot, fx.roots);

    expect(result.kept).toContain('/games/test/assets/prefabs/rock.prefab.json');
    expect(result.kept).toContain('/games/test/assets/meshes/rock.mesh.json');
    expect(result.kept).toContain('/games/test/assets/mats/stone.mat.json');
    expect(result.kept).toContain('/games/test/assets/models/rock.glb');
    expect(result.kept).toContain('/games/test/assets/tex/diffuse.png');
    expect(result.kept).toContain('/games/test/assets/env/sky.hdr');
    expect(result.warnings.filter(w => /unresolved GUID/i.test(w))).toEqual([]);
  });

  it('keeps a texture referenced only via a sliced-sprite GUID (Renderable2D.sprite)', () => {
    const TEX = '11111111-1111-4111-8111-111111111111';
    const SPRITE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    // Texture (binary) whose meta carries a sprites[] block — the sprite GUID has
    // NO file of its own; it lives only inside the texture's sidecar.
    fx.writeVirtual('/games/test/assets/tex/sheet.png', 'fake-png');
    fx.writeJson('/games/test/assets/tex/sheet.png.meta.json', {
      id: TEX, version: 2,
      spriteSheet: { width: 64, height: 32 },
      sprites: [{ guid: SPRITE, name: 'coin', rect: { x: 0, y: 0, w: 32, h: 32 }, pivot: { x: 0.5, y: 0.5 } }],
    });
    // Scene references ONLY the sprite GUID (not the texture directly).
    fx.writeJson('/games/test/assets/scenes/main.json', {
      version: 9,
      entities: [{ id: 1, traits: { Renderable2D: { sprite: SPRITE } } }],
    });

    const result = computeKeptAssets(fx.projectRoot, fx.roots);

    // The parent texture must survive even though nothing references it directly.
    expect(result.kept).toContain('/games/test/assets/tex/sheet.png');
    expect(result.warnings.filter(w => /unresolved GUID/i.test(w))).toEqual([]);
  });

  it('keeps a sprite-sheet reachable ONLY through a .spriteanim frame (SpriteAnimator.clipSet)', () => {
    const TEX = '22222222-1111-4111-8111-222222222222';
    const F0 = 'bbbbbbbb-0000-4ccc-8ddd-eeeeeeeeeeee';
    const F1 = 'bbbbbbbb-1111-4ccc-8ddd-eeeeeeeeeeee';
    const SET = 'cccccccc-2222-4333-8444-555555555555';
    // A sheet whose slices are used ONLY as animation frames — no Renderable2D.sprite
    // points into it, so only following the .spriteanim frames can keep it.
    fx.writeVirtual('/games/test/assets/tex/hero.png', 'fake-png');
    fx.writeJson('/games/test/assets/tex/hero.png.meta.json', {
      id: TEX, version: 2,
      spriteSheet: { width: 64, height: 32 },
      sprites: [
        { guid: F0, name: 'a', rect: { x: 0, y: 0, w: 32, h: 32 }, pivot: { x: 0.5, y: 0.5 } },
        { guid: F1, name: 'b', rect: { x: 32, y: 0, w: 32, h: 32 }, pivot: { x: 0.5, y: 0.5 } },
      ],
    });
    fx.writeJson('/games/test/assets/anims/hero.spriteanim.json', {
      id: SET, clips: { walk: { frames: [F0, F1], fps: 10, mode: 'loop', cycles: 0 } },
    });
    // Scene references ONLY the clip set (Renderable2D.sprite is a placeholder square).
    fx.writeJson('/games/test/assets/scenes/main.json', {
      version: 9,
      entities: [{ id: 1, traits: { Renderable2D: { sprite: 'square' }, SpriteAnimator: { clipSet: SET, clip: 'walk' } } }],
    });

    const result = computeKeptAssets(fx.projectRoot, fx.roots);

    expect(result.kept).toContain('/games/test/assets/anims/hero.spriteanim.json');
    // The sheet survives ONLY because the spriteanim processor follows its frames.
    expect(result.kept).toContain('/games/test/assets/tex/hero.png');
    expect(result.warnings.filter((w) => /unresolved GUID/i.test(w))).toEqual([]);
  });

  it('keeps a body-part texture reachable ONLY through a .rig2d part (SkinnedSprite2D.rig)', () => {
    const BODY = '33333333-1111-4111-8111-333333333333';
    const HAND = '44444444-1111-4111-8111-444444444444';
    const RIG = '55555555-2222-4333-8444-666666666666';
    // Two body-part textures whose GUIDs appear ONLY inside a rig's parts[].sprite —
    // no Renderable2D.sprite points at them, so only following the rig can keep them.
    fx.writeVirtual('/games/test/assets/tex/body.png', 'fake-png');
    fx.writeJson('/games/test/assets/tex/body.png.meta.json', { id: BODY, version: 2 });
    fx.writeVirtual('/games/test/assets/tex/hand.png', 'fake-png');
    fx.writeJson('/games/test/assets/tex/hand.png.meta.json', { id: HAND, version: 2 });
    // The rig references the part textures; parts[].mesh is inline geometry, not a ref.
    fx.writeJson('/games/test/assets/rigs/hero.rig2d.json', {
      id: RIG,
      bones: [{ name: 'root', parent: -1, x: 0, y: 0, rot: 0 }],
      parts: [
        { name: 'body', sprite: BODY, order: 0, mesh: { verts: [], uvs: [], tris: [] } },
        { name: 'hand', sprite: HAND, order: 1, mesh: { verts: [], uvs: [], tris: [] } },
      ],
    });
    // Scene references ONLY the rig (via SkinnedSprite2D.rig).
    fx.writeJson('/games/test/assets/scenes/main.json', {
      version: 9,
      entities: [{ id: 1, traits: { SkinnedSprite2D: { rig: RIG } } }],
    });

    const result = computeKeptAssets(fx.projectRoot, fx.roots);

    expect(result.kept).toContain('/games/test/assets/rigs/hero.rig2d.json');
    // Both part textures survive ONLY because the rig2d processor follows parts[].sprite.
    expect(result.kept).toContain('/games/test/assets/tex/body.png');
    expect(result.kept).toContain('/games/test/assets/tex/hand.png');
    expect(result.warnings.filter((w) => /unresolved GUID/i.test(w))).toEqual([]);
  });

  it('keeps a texture reachable ONLY through a v1 rig top-level sprite', () => {
    const TEX = '66666666-1111-4111-8111-666666666666';
    const RIG = '77777777-2222-4333-8444-777777777777';
    // v1 rig schema: a single top-level `sprite` + top-level mesh (bar.rig2d shape),
    // NOT a parts[] list. The sprite ref must still be followed.
    fx.writeVirtual('/games/test/assets/tex/bar.png', 'fake-png');
    fx.writeJson('/games/test/assets/tex/bar.png.meta.json', { id: TEX, version: 2 });
    fx.writeJson('/games/test/assets/rigs/bar.rig2d.json', {
      id: RIG, version: 1,
      sprite: TEX,
      bones: [{ name: 'root', parent: -1, x: 0, y: 0, rot: 0 }],
      mesh: { verts: [], uvs: [], tris: [] },
    });
    fx.writeJson('/games/test/assets/scenes/main.json', {
      version: 9,
      entities: [{ id: 1, traits: { SkinnedSprite2D: { rig: RIG } } }],
    });

    const result = computeKeptAssets(fx.projectRoot, fx.roots);

    expect(result.kept).toContain('/games/test/assets/tex/bar.png');
    expect(result.warnings.filter((w) => /unresolved GUID/i.test(w))).toEqual([]);
  });

  it('follows asset refs inside a prefab-instance override (Animator.clips)', () => {
    const CLIP = '88888888-1111-4aaa-8bbb-888888888888';
    const PREFAB = '99999999-2222-4ccc-8ddd-999999999999';
    // A clip referenced ONLY by an instance override, never by the base prefab —
    // must survive because extractEntityRefs walks entry.overrides trait-bags.
    fx.writeJson('/games/test/assets/anims/wave.anim.json', { id: CLIP, version: 1, tracks: [] });
    fx.writeJson('/games/test/assets/rigs/hero.prefab.json', {
      id: PREFAB, version: 1, rootLocalId: 1,
      entities: [{ localId: 1, name: 'Hero', traits: { EntityAttributes: { name: 'Hero' } } }],
    });
    fx.writeJson('/games/test/assets/scenes/main.json', {
      version: 9,
      entities: [{
        id: 2, name: 'Hero', prefab: PREFAB,
        traits: { PrefabInstance: { source: PREFAB, localId: 1 } },
        overrides: { '1': { Animator: { clips: JSON.stringify([{ name: 'wave', clip: CLIP }]), clip: 'wave', playing: true } } },
      }],
    });

    const result = computeKeptAssets(fx.projectRoot, fx.roots);

    expect(result.kept).toContain('/games/test/assets/anims/wave.anim.json');
    expect(result.warnings.filter((w) => /unresolved GUID/i.test(w))).toEqual([]);
  });

  it('warns on an unresolved GUID ref and keeps building', () => {
    fx.writeJson('/games/test/assets/scenes/main.json', {
      version: 8,
      resources: [{ type: 'model', path: '99999999-9999-4999-8999-999999999999' }],
      entities: [],
    });

    const result = computeKeptAssets(fx.projectRoot, fx.roots);

    expect(result.warnings.some(w => /unresolved GUID/i.test(w))).toBe(true);
    expect(result.kept).toContain('/games/test/assets/scenes/main.json');
  });
});

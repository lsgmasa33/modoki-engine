/** The engine ships ONE blessed MSDF text font — Arimo, `DEFAULT_FONT_GUID` — so a game can render
 *  `Text2D` without copying a font into its own assets (Court shipped a byte-identical 500 KB
 *  duplicate until #52).
 *
 *  It is the only font in the engine with a `.meta.json`, and that is deliberate: GUID healing
 *  SKIPS fonts (see the `type === 'font'` continue in vite-asset-scanner), because fonts are
 *  normally referenced by CSS family name and minting sidecars for every bundled family would be
 *  churn. The flip side is that nothing MAINTAINS this sidecar either — so the two ways it can rot
 *  are both silent, and both are asserted here:
 *    · the GUID drifting from the const games import (a dangling ref → no text at all in a build)
 *    · the `font` block going missing (the manifest emits no font block → the runtime treats it as
 *      a plain CSS font, and `fontAtlasLoader` finds no atlas to load) */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { readFontAxes } from '../../plugins/font-instance';
import { DEFAULT_FONT_GUID } from '../../packages/modoki/src/runtime/assets/builtinAssets';

const ASSET_DIR = path.resolve(__dirname, '../../packages/modoki/src/runtime/assets');
const FONT = path.join(ASSET_DIR, 'fonts/Arimo/Arimo-VariableFont_wght.ttf');
const META = `${FONT}.meta.json`;

describe('the engine default font', () => {
  it('the .ttf the sidecar describes is actually there', () => {
    expect(fs.existsSync(FONT), `${FONT} is missing — DEFAULT_FONT_GUID resolves to nothing`).toBe(true);
  });

  it('sidecar GUID matches the runtime DEFAULT_FONT_GUID const (no drift)', () => {
    const meta = JSON.parse(fs.readFileSync(META, 'utf8'));
    expect(meta.id).toBe(DEFAULT_FONT_GUID);
    expect(meta.version).toBe(2);
  });

  it('carries the `font` import block that makes it BAKE rather than ship as a CSS font', () => {
    const meta = JSON.parse(fs.readFileSync(META, 'utf8'));
    expect(meta.font, 'no `font` block — the build would ship the raw .ttf and no MTSDF atlas').toBeTruthy();
    expect(meta.font.mode).toBe('baked');
    expect(meta.font.fieldType).toBe('mtsdf');
  });

  /**
   * ⚠️ **This replaces "Arimo is the ONLY font with a sidecar"** (owner, 2026-08-09: *"we decided to
   * include other fonts in the engine"*). Every bundled family is guid-bearing now, so a game can
   * author `Text2D.font` in a scene or prefab instead of being stuck with the one blessed default.
   *
   * **The retired rule's reasoning is still half-true, so read it before relaxing this further.** It
   * said minting sidecars for every family "would be churn" — and it would have been, because GUID
   * healing SKIPS fonts (the `type === 'font'` continue in vite-asset-scanner), so nothing maintains
   * these. A sidecar the editor mints on demand gets a RANDOM id, which differs per clone and churns
   * the tree. What makes that safe is not scarcity, it is **being committed**: an id that is in git
   * cannot drift. So the invariant worth guarding is no longer "how many" but "every one is present,
   * committed, well-formed and unique" — which is what this asserts.
   *
   * ⚠️ Two of these ids are NOT in the `beef0000-…` sentinel series (Geologica, Nunito-Italic). They
   * were minted by the editor before this decision and **authored refs already point at them**, so
   * renumbering would silently break a prefab. An id's job is to be stable, not to be tidy.
   */
  it('every bundled font is guid-bearing, well-formed and unique', () => {
    const dir = path.join(ASSET_DIR, 'fonts');
    const ttfs: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ttf')) ttfs.push(p);
      }
    };
    walk(dir);
    expect(ttfs.length, 'no bundled fonts found — the asset dir moved?').toBeGreaterThan(0);

    const ids = new Map<string, string>();
    for (const ttf of ttfs) {
      const meta = `${ttf}.meta.json`;
      const rel = path.relative(dir, ttf);
      // A font with no sidecar cannot be referenced by GUID, so it silently is not selectable in
      // the Inspector — the exact dead end this decision existed to remove.
      expect(fs.existsSync(meta), `${rel} has no sidecar — it cannot be assigned to Text2D.font`).toBe(true);
      const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
      expect(m.version, `${rel}`).toBe(2);
      // The block must EXIST and name a real mode. Without one the manifest emits no font block,
      // the runtime treats the file as a plain CSS font, and `fontAtlasLoader` finds no atlas —
      // i.e. no text at all, and only in a real build.
      //
      // ⚠️ **Both modes are legitimate; do not narrow this back to 'baked'.** `baked` ships a
      // prebuilt atlas (the default font's route); `dynamic` rasterizes at runtime, which is what
      // a large/CJK charset needs and what the owner chose for Geologica (2026-08-09). Both now
      // honour a VARIABLE font's axes via `variationAxes` — see the note below.
      expect(['baked', 'dynamic'], `${rel} has mode '${m.font?.mode}' — Text2D would render nothing`)
        .toContain(m.font?.mode);
      expect(m.font?.fieldType, `${rel}`).toBe('mtsdf');
      const clash = ids.get(m.id);
      expect(clash, `${rel} shares its GUID with ${clash} — one of them would resolve to the other`).toBeUndefined();
      ids.set(m.id, rel);
    }
    // The default must still be Arimo's, or every code-spawned Text2D changes face at once.
    expect(ids.get(DEFAULT_FONT_GUID)).toBe(path.relative(dir, FONT));
  });

  /**
   * **Every bundled family is a VARIABLE font, and its DEFAULT instance is frequently not
   * Regular** — the fact behind a bug that cost a full misdiagnosis (owner, 2026-08-09:
   * *"bake doesn't work with weight etc."*). Measured from the `fvar` tables:
   * Arimo 400..700 (default 400) · MerriweatherSans 300..800 (400) · Roboto 100..900 (400)
   * · **Geologica 100..900 (default 100, Thin)** · **Nunito 200..1000 (default 200,
   * ExtraLight)**. Unpinned, those last two render at their lightest weight and nothing on
   * the entity can change it.
   *
   * That is also why it LOOKED like a baked-vs-dynamic difference: Geologica and
   * Nunito-Italic were exactly the two fonts set to `dynamic`, so the mode flip was
   * confounded with a Thin-100 typeface. Both paths rasterize the default instance; the
   * mode was never the cause.
   *
   * ⚠️ Do not "fix" a weight by reaching for `msdf-atlas-gen -varfont` — it is a SILENT
   * NO-OP in our build (accepted, exit 0, byte-identical atlas). Axes are applied before
   * the bake by `engine/plugins/font-instance.ts`, which both the baked and dynamic paths
   * consume. See docs/plans/font-variation-axes-plan.md §8.
   *
   * **`Text2D.weight` is NOT that axis and is not a bug.** It is an SDF edge shift
   * (`edge = 0.5 - weight`, `mtsdfShader.ts`) — fake bolding by dilating the glyph outline.
   * It is genuinely useful at small sizes, where it is why a minified Arimo does not read
   * mushy; it just is not the typeface's own weight.
   */
  it('every family whose default instance is not Regular authors wght 400', () => {
    const dir = path.join(ASSET_DIR, 'fonts');
    const sidecars: Array<{ rel: string; src: string; meta: Record<string, unknown> }> = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.meta.json')) {
          sidecars.push({ rel: path.relative(dir, p), src: p.replace(/\.meta\.json$/, ''), meta: JSON.parse(fs.readFileSync(p, 'utf8')) });
        }
      }
    };
    walk(dir);
    expect(sidecars.length).toBeGreaterThan(0);

    for (const { rel, src, meta } of sidecars) {
      if (!fs.existsSync(src)) continue;
      const wght = readFontAxes(new Uint8Array(fs.readFileSync(src))).find((a) => a.tag === 'wght');
      if (!wght) continue; // static font — nothing to pin
      const authored = ((meta.font ?? {}) as { variationAxes?: Record<string, number> }).variationAxes;
      // A family whose own default IS Regular needs no axis: leaving it unauthored keeps
      // the sidecar honest about what it is asking for. One whose default is lighter
      // (Geologica 100, Nunito 200) MUST author 400, or it renders Thin/ExtraLight and
      // nothing on the entity can change that.
      if (wght.def === 400) continue;
      expect(
        authored?.wght,
        `${rel} defaults to wght ${wght.def} (range ${wght.min}..${wght.max}) — without an authored ` +
        `variationAxes.wght it can only ever render that weight`,
      ).toBe(400);
    }
  });

  it('no sidecar authors an axis its font does not have', () => {
    const dir = path.join(ASSET_DIR, 'fonts');
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.meta.json')) {
          const src = p.replace(/\.meta\.json$/, '');
          if (!fs.existsSync(src)) continue;
          const axes = ((JSON.parse(fs.readFileSync(p, 'utf8')).font ?? {}) as { variationAxes?: Record<string, number> }).variationAxes ?? {};
          const have = readFontAxes(new Uint8Array(fs.readFileSync(src)));
          for (const [tag, v] of Object.entries(axes)) {
            const a = have.find((x) => x.tag === tag);
            if (!a) out.push(`${path.relative(dir, p)}: axis "${tag}" absent (has ${have.map((x) => x.tag).join(', ') || 'none'})`);
            else if (v < a.min || v > a.max) out.push(`${path.relative(dir, p)}: ${tag}=${v} outside ${a.min}..${a.max}`);
          }
        }
      }
    };
    walk(dir);
    // The bake THROWS on an absent axis rather than silently producing the default, so
    // this would surface as a failed import — but a red test naming the file beats
    // discovering it when a font stops converting.
    expect(out).toEqual([]);
  });
});

/** Guard: the load-bearing `data-ui-id` tags still exist (Enact Phase 2).
 *
 *  Tagging rots. A refactor renames a button, drops the attribute, and NOTHING fails —
 *  the editor still works for a human, `npm run verify` stays green, and the only symptom
 *  is that months later an agent's `tap_handle` returns "no live handle with id X" and it
 *  falls back to guessing pixels. This test is the tripwire.
 *
 *  It reads SOURCE, not a rendered DOM, on purpose: rendering every panel would need the
 *  whole editor store, and the failure we're guarding against (someone deleted the
 *  attribute) is visible in the text. A tag that exists in source but never renders is a
 *  different bug, and Electron verification is what catches that one.
 *
 *  These ids are a CONTRACT with the agent tooling. Renaming one is allowed — update this
 *  list and CLAUDE.md in the same commit. Deleting one silently is not. */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ED = path.resolve(__dirname, '../../packages/modoki/src/editor');
const read = (rel: string) => fs.readFileSync(path.join(ED, rel), 'utf8');

/** Static ids appear verbatim; dynamic ones are template literals, so we match the
 *  literal prefix up to the first interpolation. */
const REQUIRED: Array<{ file: string; ids: string[]; why: string }> = [
  {
    file: 'components/ContextMenu.tsx',
    ids: ['`contextmenu.item.${item.label}`'],
    why: 'every context-menu row in the editor — Delete, Duplicate, Copy/Paste Component. Without it no menu is clickable by an agent.',
  },
  {
    // Full template literals: a bare '.menu' fragment would match half the file and pass
    // even if the tag were deleted. `${title}` is the trait name, in scope at both sites.
    file: 'panels/assetViews/widgets.tsx',
    ids: ['`inspector.section.${title}.menu`', '`inspector.section.${title}.header`'],
    why: 'the per-trait ⋮ kebab and its section header — the surface that motivated Enact Phase 2.',
  },
  {
    file: 'panels/Inspector.tsx',
    ids: ['inspector.header.delete', 'inspector.header.active', 'inspector.header.name'],
    why: 'the Inspector header controls.',
  },
  {
    // Was inline in Inspector.tsx as a native <select> (`inspector.addComponent.select`);
    // now a searchable popup in its own file — trigger + search field + one row per trait.
    file: 'panels/AddComponentPicker.tsx',
    ids: ['inspector.addComponent.trigger', 'inspector.addComponent.search', '`inspector.addComponent.item.${t.name}`', 'inspector.addComponent.pasteAsNew'],
    why: 'the Add Component entry point — open the picker, filter it, add a trait, paste-as-new.',
  },
  {
    file: 'panels/SceneView.tsx',
    ids: [
      'sceneView.toolbar.gizmo.', 'sceneView.toolbar.gizmo.space', 'sceneView.toolbar.collider-points',
      'sceneView.toolbar.viewOptions3d', 'sceneView.toolbar.viewOptionsUi',
      'sceneView.toolbar.fx-preview', 'sceneView.toolbar.grid', 'sceneView.toolbar.colliders',
      'sceneView.toolbar.focus', 'sceneView.toolbar.colliders2d', 'sceneView.toolbar.layer.',
    ],
    why: 'the viewport toolbar — gizmo mode/space, collider point editing, the "View" dropdown (FX/Grid/Colliders in 3D, FX/Focus/Colliders in 2D), and the 3D/2D/UI layer toggles (#373).',
  },
  {
    // spriteEditor.cancel/.save predate this change and are only 2 dot-segments — LEGACY_2SEG
    // below exempts them from the namespacing check rather than leaving them unguarded, because
    // this file's own findReferences.footer.close entry argues a modal's EXIT is load-bearing:
    // while the modal is open every other handle reports occluded, so an untagged Close/Cancel
    // traps an agent inside it. This modal opens via `useOverlay(true, 'sprite-editor')` and is
    // exactly that shape — and three QA cases already address these two ids by selector.
    file: 'panels/SpriteEditor.tsx',
    ids: ['spriteEditor.cancel', 'spriteEditor.save', '`spriteEditor.slice.${s.guid}`'],
    why: 'each row in the Sprites list — the only tap-based route to select a slice (#373).',
  },
  {
    file: 'panels/SceneViewGizmo.tsx',
    ids: ['`sceneview.gizmo.axis.${a.name}`', 'sceneview.gizmo.projection'],
    why: 'the orientation gizmo — snap the camera to an axis view and toggle perspective/orthographic.',
  },
  {
    file: 'panels/Hierarchy.tsx',
    ids: ['hierarchy.toolbar.create', 'hierarchy.toolbar.search', 'hierarchy.toolbar.typeFilter'],
    why: 'creating an entity and filtering the tree.',
  },
  {
    file: 'panels/Assets.tsx',
    ids: ['assets.toolbar.search', 'assets.toolbar.viewToggle', 'assets.toolbar.newFolder', 'assets.toolbar.refresh', 'assets.toolbar.reimportAll'],
    why: 'the Assets toolbar — folder view is a prerequisite for asset drag-and-drop.',
  },
  {
    file: 'panels/Console.tsx',
    ids: ['console.toolbar.filter', 'console.toolbar.clear', 'console.toolbar.level.log', 'console.toolbar.level.warn', 'console.toolbar.level.error'],
    why: 'driving the Console filter, which get_console_logs can read but not operate.',
  },
  {
    file: 'panels/ModuleTogglesEditor.tsx',
    ids: ['`module-toggles.row.${m.key}`', '`module-toggles.${m.key}.${o.slug}`'],
    why: 'the Project Settings → Engine Modules tri-state rows. All three segments of a row '
      + 'once shared one `title={m.key}`, so the only way to aim at "Off" was a DOM index — '
      + 'which reorders silently. The `o.slug` half is what keeps the id stable under a reorder.',
  },
  {
    file: 'panels/ApplyPrefabDialog.tsx',
    ids: ['prefab.dialog.confirm', 'prefab.dialog.cancel'],
    why: 'the modal EXIT. Inspector tags open this dialog; without these an agent enters a modal it cannot leave.',
  },
  {
    // Same rule, second instance, found by sweeping every full-screen overlay for a tagged
    // exit (#287): this was the ONLY one with no data-ui-id at all. It is also the only one
    // with no Escape handling, so the Close button is the single way out.
    file: 'panels/FindReferencesDialog.tsx',
    ids: ['findReferences.footer.close'],
    why: 'the modal EXIT of a fixed/inset-0/z-9999 overlay. While it is open every other handle '
      + 'reports occluded and Enact refuses the aim, so an untagged Close means a trapped agent.',
  },
  {
    // Three Inspector call sites construct the same-shaped id independently: the generic
    // `hint.type:'number'` branch (NumberField), the bounded UI-anchor size branch
    // (BufferedNumberInput), and the `hint.type:'boolean'` checkbox branch all key off
    // `meta.name` (the trait); VecField's per-axis BufferedNumberInput keys off its own
    // `traitName` prop instead, since VecField has no `meta` in scope. Without a stable id
    // here a QA case has to aim by the stale `value`/`checked` DOM attribute, which stops
    // matching the moment the field changes (bug y9WMNPkT0DivkxZKJDWU — QA-INSP-0010 aimed a
    // `NumberField` selector at a value that could never render, because the case assumed the
    // OTHER widget backed the field). The boolean branch had NO id at all until the checkbox
    // was tagged to match — see `qa/cases/video/loop-flip-applies-live.md`, which drives
    // `VideoPlayer.loop`'s checkbox by this exact id.
    file: 'panels/Inspector.tsx',
    ids: ['`inspector.field.${meta.name}.${key}`', '`inspector.field.${traitName}.${f.key}`'],
    why: 'per-field ids for every Inspector NUMBER input (NumberField and BufferedNumberInput alike) AND every BOOLEAN checkbox — same template, both branches — so a case can aim by stable id instead of a value-dependent CSS selector.',
  },
  {
    // The two asset editors the 2026-08-20 QA batch drives. Both carried ZERO tags while
    // every case against them fell back to `modoki_eval` + a text match — fragile against
    // any copy change, and unable to tell two same-labelled controls apart (#287).
    file: 'panels/SkinEditor.tsx',
    ids: [
      'skin.mode.parts', 'skin.mode.rig', 'skin.mode.weights',
      'skin.boneTool.select', 'skin.boneTool.add', 'skin.boneTool.delete',
      'skin.weightTool.paint', 'skin.weightTool.pose',
      'skin.paint.radius', 'skin.paint.strength',
      '`skin.parts.row.${i}.remove`',
      // The GATE for the row rename field: `skin.parts.row.${i}.name` renders only while
      // editingPart === i, and this double-click span is the only thing that sets it. Third
      // instance of that pattern in #287 (SubSection, FindReferencesDialog, this).
      '`skin.parts.row.${i}.rename`',
      // #704 — the ten numeric fields. Before these, a case authoring a bone pose or a
      // tessellation density had to match a label <span> and take its nextElementSibling.
      'skin.inspector.bone.x', 'skin.inspector.bone.y', 'skin.inspector.bone.rot',
      'skin.part.center.x', 'skin.part.center.y', 'skin.part.rotation',
      'skin.part.size.w', 'skin.part.size.h',
      'skin.part.tessellate.cols', 'skin.part.tessellate.rows',
    ],
    why: 'the Skin Editor mode/tool switches, the paint brush, and the ten numeric fields (#704) — '
      + 'the controls a weight-painting case has to drive before it can assert anything about the rig.',
  },
  {
    file: 'panels/ParticleEditor.tsx',
    ids: [
      'particle.transport.play', 'particle.transport.restart', 'particle.transport.scrub', 'particle.header.name',
      // #704 — the row-repeater fields. `useFieldId` cannot mint these (a repeated row has no
      // Section context), so unlike the panel's other ~60 fields they are tagged BY HAND and
      // nothing else would notice them going missing.
      '`particle.bursts.row.${i}.time`', '`particle.bursts.row.${i}.count`',
      '`particle.forces.row.${i}.x`', '`particle.forces.row.${i}.y`',
      '`particle.forces.row.${i}.z`', '`particle.forces.row.${i}.strength`',
      '`particle.subEmitters.row.${i}.count`', '`particle.subEmitters.row.${i}.probability`',
      '`particle.subEmitters.row.${i}.inheritVelocity`',
    ],
    why: 'the Particle Editor transport. Its buttons render as bare glyphs (⏸ ⟲ ↶ ▦), so before '
      + 'this there was no text for a fallback case to match on either. Plus the nine row-repeater '
      + 'fields (#704), which the fieldIds context cannot reach.',
  },
  {
    // The Advanced disclosure in TextureAssetView is defaultOpen={false} and hides SEVEN
    // tagged controls. Untagging this toggle fails no OTHER assertion here — the seven ids
    // stay present in source — it just makes them permanently unreachable, which is the
    // failure this file exists to prevent, one level up.
    file: 'panels/assetViews/widgets.tsx',
    ids: ['`inspector.subsection.${subSectionSlug(title)}`'],
    why: 'the collapse toggle that GATES the tagged asset-import settings. A tag behind a door '
      + 'an agent cannot open is not a tag (measured: 4 live handles against 11 in source).',
  },
  {
    // Two buttons in the AI panel both read "Connect" and both mount together (AIPanel.tsx
    // renders DeviceConnectSection), so whenever Claude Code and the device are both
    // disconnected, a text search or a blind aim for "Connect" there is ambiguous (#287).
    file: 'panels/AIPanel.tsx',
    ids: ['ai.connect.claudeCode'],
    why: 'the Connect-Claude-Code button — distinguishable from the device Connect beside it.',
  },
  {
    file: 'panels/DeviceConnectSection.tsx',
    ids: ['ai.device.connect', 'ai.device.useAdb', 'ai.device.ip'],
    why: 'the device Connect button and its two inputs — the OTHER "Connect" in the same panel.',
  },
  {
    // #724 — the 15 BufferedNumberInput + 10 BufferedTextInput sites the coverage check below
    // found untagged (26 sites, ~36 controls counting shared helpers). Listed per file.
    file: 'panels/AnimatorClipsSection.tsx',
    ids: ['`animator.clip.${i}.name`', '`animator.clip.${i}.speed`', '`animator.clip.${i}.fadeDuration`'],
    why: 'the Animator clip-bank row editor (name/speed/fade) — #724.',
  },
  {
    file: 'panels/MaterialOverridesField.tsx',
    ids: [
      '`material.override.${i}.target`', '`material.override.${i}.value`',
      '`material.override.${i}.speed`', '`material.override.${i}.wrap`',
      '`material.override.${i}.key`', '`material.override.${i}.scale`',
      '`material.override.${i}.default`',
    ],
    why: 'the material-override row editor — target/value/time-source/store-source fields, threaded through the NumRow helper — #724.',
  },
  {
    file: 'panels/NineSliceEditor.tsx',
    ids: ['nineSlice.border.edgeScale'],
    why: 'the 9-slice editor\'s edge-scale field — #724.',
  },
  {
    file: 'panels/SpriteAnimEditor.tsx',
    ids: ['spriteAnim.clip.fps', 'spriteAnim.clip.cycles'],
    why: 'the active clip\'s fps/cycles fields — #724.',
  },
  {
    file: 'panels/SpriteEditor.tsx',
    ids: [
      'spriteEditor.grid.cols', 'spriteEditor.grid.rows', 'spriteEditor.grid.cellW', 'spriteEditor.grid.cellH',
      'spriteEditor.grid.offsetX', 'spriteEditor.grid.offsetY', 'spriteEditor.grid.paddingX', 'spriteEditor.grid.paddingY',
      'spriteEditor.auto.threshold',
      'spriteEditor.selected.x', 'spriteEditor.selected.y', 'spriteEditor.selected.w', 'spriteEditor.selected.h',
      'spriteEditor.selected.pivotX', 'spriteEditor.selected.pivotY',
    ],
    why: 'the 15 numeric controls behind the local `Num` helper (grid slice, auto-alpha threshold, selected-sprite rect/pivot) — #724.',
  },
  {
    file: 'panels/assetViews/MaterialAssetView.tsx',
    ids: ['`assetView.material.param.${name}.${i}`'],
    why: 'the per-component vecN shader-param fields — #724.',
  },
  {
    file: 'panels/assetViews/ModelAssetView.tsx',
    ids: ['assetView.model.rig.uastcRdoLambda'],
    why: 'the rigged-model UASTC RDO lambda field — #724.',
  },
  {
    file: 'panels/assetViews/TextureAssetView.tsx',
    ids: ['assetView.texture.webpQuality', 'assetView.texture.uastcRdoLambda', '`assetView.texture.nineSlice.${edge}`', 'assetView.texture.nineSlice.scale'],
    why: 'texture import\'s WebP quality / UASTC RDO lambda, and the 9-slice border+scale fields — #724.',
  },
  {
    file: 'panels/assetViews/VideoAssetView.tsx',
    ids: ['inspector.video.keyframeIntervalSec'],
    why: 'the video import keyframe-interval field — #724.',
  },
  {
    file: 'panels/assetViews/ShaderAssetView.tsx',
    ids: ['`shaderAsset.param.${key}.label`'],
    why: 'the per-param display-label field in the shader schema editor — #724.',
  },
  {
    file: 'panels/UIActionBindingsField.tsx',
    ids: ['`uiActions.binding.${i}.value`', '`uiActions.binding.${i}.param.${k}`', '`uiActions.binding.${i}.payload`'],
    why: 'the binding row\'s value/param/freeform-payload fields — #724.',
  },
  {
    file: 'panels/Inspector.tsx',
    ids: ['`audio.clip.${i}.key`', '`inspector.field.${meta.name}.${key}`'],
    why: 'the audio clip-bank row key field, and the generic string-field renderer\'s BufferedTextInput branch (same id template as the number/boolean branches) — #724.',
  },
];

describe('data-ui-id tagging has not rotted', () => {
  for (const { file, ids, why } of REQUIRED) {
    it(`${file} still tags: ${why}`, () => {
      const src = read(file);
      for (const id of ids) expect(src, `missing data-ui-id fragment "${id}"`).toContain(id);
    });
  }

  it('the Particle Editor field-id namespace is still wired', () => {
    // The per-FIELD ids have no literal to grep for — they come from a Section context, so a
    // `toContain` on a template fragment would prove nothing about the ~58 ids it generates.
    // What IS checkable here is the WIRING: the panel provides the context and the widgets
    // consume it. Deleting either silently un-tags every property field in the panel at once.
    // The ids themselves are covered properly (rendered, and asserted collision-free) by
    // packages/modoki/tests/editor/particleFieldIds.test.tsx.
    const mod = read('panels/particle/fieldIds.ts');
    for (const decl of ['export const SectionIdContext', 'export function particleFieldSlug', 'export function useFieldId']) {
      expect(mod, `fieldIds.ts no longer has "${decl}"`).toContain(decl);
    }
    const panel = read('panels/ParticleEditor.tsx');
    expect(panel, 'Section no longer provides the id namespace').toContain('<SectionIdContext.Provider value={particleFieldSlug(title)}>');
    expect(panel, 'the shared field widgets no longer consume it').toContain('useFieldId(label)');
  });

  it('every shared Particle field widget still RENDERS the id it computes', () => {
    // Calling useFieldId is not the same as emitting the attribute, and the difference is
    // invisible: a widget that keeps the call and drops `data-ui-id` un-tags its whole field
    // class while every other assertion here stays green (verified by mutation — dropping the
    // attribute from `Check` passed both this suite and particleFieldIds.test.tsx before this
    // check existed). So assert the OUTPUT per widget, not just the wiring once.
    const panel = read('panels/ParticleEditor.tsx');
    for (const widget of ['Num', 'MinMax', 'Vec3Row', 'Check', 'Enum', 'Color']) {
      const start = panel.indexOf(`function ${widget}({`);
      expect(start, `widget ${widget} is gone — rename it here too`).toBeGreaterThan(-1);
      // Body = up to the next top-level `function` declaration.
      const next = panel.indexOf('\nfunction ', start + 1);
      const body = panel.slice(start, next === -1 ? undefined : next);
      // Either it emits the attribute itself, or it hands the id to NumInput (which does).
      expect(body.includes('data-ui-id=') || body.includes('uiId={uiId'), `${widget} computes a ui id but never renders one`).toBe(true);
    }
    // ...and NumInput, the leaf every numeric field bottoms out in, must emit it.
    const ni = panel.slice(panel.indexOf('function NumInput({'));
    expect(ni.slice(0, ni.indexOf('\nfunction ')), 'NumInput no longer renders data-ui-id').toContain('data-ui-id={uiId}');
  });

  it('the shared tree components still forward a caller-owned uiId', () => {
    // TreeSearchInput/TypeFilterMenu render in BOTH Hierarchy and Assets. A hardcoded id
    // would collide (both panels are always mounted), so the id must stay a prop.
    const src = read('panels/treeChrome.tsx');
    expect(src).toContain('data-ui-id={uiId}');
    expect(src.match(/uiId\?: string/g)?.length).toBe(2);
  });

  it('ContextMenu keeps BOTH attributes — data-menu-item predates the handle provider', () => {
    const src = read('components/ContextMenu.tsx');
    expect(src).toContain('data-menu-item={item.label}');
    expect(src).toContain('data-ui-id={`contextmenu.item.${item.label}`}');
  });

  it('a disabled context-menu row reports itself inert (it is a div, not a <button>)', () => {
    // `meta.disabled` is how an agent learns "Paste Component Values" is greyed out.
    // A <div> has no `disabled` property, so the escape-hatch attribute is load-bearing.
    expect(read('components/ContextMenu.tsx')).toContain("data-ui-disabled={item.disabled ? 'true' : undefined}");
  });

  // Ids that predate the <panel>.<region>.<name> convention (2 dot-segments) — exempted from the
  // check below rather than left out of REQUIRED entirely, since dropping them from REQUIRED
  // would leave them unguarded. Renaming them is real churn: `qa/cases/**` and `qa/knowledge.md`
  // already address both by selector.
  const LEGACY_2SEG = new Set(['spriteEditor.cancel', 'spriteEditor.save']);

  it('every tagged id is dot-namespaced as <panel>.<region>.<name>', () => {
    // Coherence: an agent should be able to guess `assets.toolbar.*` from `hierarchy.toolbar.*`.
    const statics = REQUIRED.flatMap((r) => r.ids).filter((id) => !id.startsWith('`') && !LEGACY_2SEG.has(id));
    expect(statics.length).toBeGreaterThan(15); // this check is worthless if the list is empty
    for (const id of statics) {
      expect(id.split('.').length, `"${id}" should have at least 3 dot segments`).toBeGreaterThanOrEqual(3);
    }
  });

  // --- #724: invert the guard for BufferedNumberInput/BufferedTextInput -------------------
  //
  // Everything above is an ALLOW-LIST: it fires when a known id is removed/renamed, but it can
  // NEVER fail because a new control was added untagged — that gap is exactly how #704 closed
  // two panels and left 26 BufferedNumberInput/BufferedTextInput sites unaddressable (#724).
  // This section is the other half: a COVERAGE check, scoped narrowly to these two widgets
  // (not "every input in the app") because they are the two that already know how to render
  // data-ui-id/-label/-kind (fields.tsx) — nothing else has an established wiring to check yet.
  //
  // ⚠️ This is NOT a frozen-baseline/count guard (see "a-frozen-baseline-is-a-merge-hazard" —
  // this repo has been bitten by exactly that shape before: a guard that freezes a MEASUREMENT
  // of the code goes red the moment an unrelated branch adds a widget, with both branches green
  // alone). It asserts an INVARIANT instead — "every element of these two tags passes a
  // `dataUiId` prop" — which is true or false about a single element in isolation, so two
  // branches that each add a (correctly tagged) control stay green independently and still merge
  // green. Passing the PROP is what's checked (a static, syntactic fact about the JSX), not that
  // the id is a non-empty literal at runtime — that mirrors `BufferedNumberInput` itself.
  //
  // ⚠️ HONEST SCOPE (found by mutation, close-out 2026-09-05): this regex scan below sees ONLY a
  // literal `<BufferedNumberInput`/`<BufferedTextInput` JSX tag. It is BLIND to any helper that
  // wraps one and re-exposes its own prop — a mutation adding an untagged `<Num label="Zzz" v={1}
  // on={() => {}} />` to `SpriteEditor.tsx` (`Num` wraps `BufferedNumberInput`) passed this suite
  // at 38/38 green, because the scan never sees inside `Num`'s own JSX from the call site. So the
  // scan covers exactly the direct-element case; it does NOT cover the shared-helper surface.
  // That other half is now covered a DIFFERENT way: `AssetRefField`/`NumRow`/`Num`/
  // `FieldValueWidget` all had `dataUiId?: string` — optional, caller's choice — and now have
  // `dataUiId: string` — REQUIRED. The type checker enforces every call site of those four passes
  // one; `npm run typecheck` fails otherwise, and no regex can be out-parsed the way this scan
  // was.
  //
  // ⚠️ This is NOT hypothetical residual risk — there IS a fifth, and it is already untagged
  // today (found by a second adversarial review, close-out 2026-09-05, filed as #772):
  // `NumberField` (`packages/modoki/src/editor/panels/assetViews/widgets.tsx:64`) has
  // `dataUiId?: string`, already RENDERS `data-ui-id={dataUiId}` (plus a derived
  // `${dataUiId}.slider`), and buffers its value via `useBufferedValue` directly rather than
  // `<BufferedNumberInput>` — so both the regex scan above (wrong element name) and the
  // required-prop fix above (wrong helper list) miss it. 26 of its 27 call sites pass no id (17
  // in `MaterialAssetView.tsx`, 4 in `MaterialBatchView.tsx`, 3 in `ShaderAssetView.tsx`, 2 in
  // `AnimSetAssetView.tsx`); only `Inspector.tsx:1082` is tagged. Tagging those 26 sites and
  // making `NumberField.dataUiId` required is #772's own bounded, separately-claimable fix — not
  // done here. Any future "a sixth wrapper" finding belongs in a note like this one, not silently
  // folded into "residual risk is hypothetical."
  //
  // `DATA_UI_ID_EXEMPT` is the escape hatch, and it is deliberately near-empty: #724 tagged all
  // 26 sites this test found untagged (36 controls, counting shared helpers), leaving exactly ONE
  // entry — a control that is addressable through its WRAPPER, so tagging the input too would give
  // one logical field two ids. That is the only reason that earns an entry. "It's awkward to
  // thread an id through this helper" does not: thread the caller-owned id instead, the way
  // `AssetRefField`/`NumRow`/`Num`/`FieldValueWidget` already do (and, now, must). Keyed by snippet
  // prefix rather than by line number on purpose, so an exemption cannot silently widen to a whole
  // file or go stale the moment the file shifts by a line.
  const SCAN_ROOTS = [
    path.resolve(__dirname, '../../packages/modoki/src/editor'),
    path.resolve(__dirname, '../../app'),
  ];

  function listTsxFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...listTsxFiles(p));
      else if (entry.name.endsWith('.tsx')) out.push(p);
    }
    return out;
  }

  /** Find every `<BufferedNumberInput …>`/`<BufferedTextInput …>` JSX element in `src` and
   *  report whether it carries a `dataUiId=` prop. Scans char-by-char from the opening tag to
   *  its closing `>`, tracking `{}` depth so a `>` inside a JS expression (a generic, a
   *  comparison, a nested arrow function) doesn't end the element early. */
  function findBufferedInputs(src: string): Array<{ line: number; hasId: boolean; snippet: string }> {
    const results: Array<{ line: number; hasId: boolean; snippet: string }> = [];
    const re = /<(BufferedNumberInput|BufferedTextInput)\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const start = m.index;
      let depth = 0, end = -1;
      for (let i = start; i < src.length; i++) {
        const c = src[i];
        if (c === '{') depth++;
        else if (c === '}') depth--;
        else if (c === '>' && depth === 0) { end = i; break; }
      }
      if (end === -1) continue; // malformed — the other assertions in this file will catch it
      const chunk = src.slice(start, end + 1);
      results.push({
        line: src.slice(0, start).split('\n').length,
        hasId: /\bdataUiId=/.test(chunk),
        snippet: chunk.replace(/\s+/g, ' ').slice(0, 100),
      });
    }
    return results;
  }

  const DATA_UI_ID_EXEMPT: Record<string, string[]> = {
    // The entity-name header field: BufferedTextInput now forwards data-ui-id (#724), but this
    // ONE instance is deliberately left un-passed because the surrounding <span> wrapper already
    // carries `data-ui-id="inspector.header.name"` (asserted above, and load-bearing for
    // `qa/cases/**`) — passing a SECOND id on the input inside it would tag the same logical
    // field twice under two different ids. See the comment at the call site.
    'packages/modoki/src/editor/panels/Inspector.tsx': ['<BufferedTextInput // Bind the RAW stored name'],
  };

  it('every BufferedNumberInput/BufferedTextInput passes a dataUiId prop (#724)', () => {
    const missing: string[] = [];
    let scanned = 0;
    for (const root of SCAN_ROOTS) {
      for (const file of listTsxFiles(root)) {
        const rel = path.relative(path.resolve(__dirname, '../..'), file);
        const src = fs.readFileSync(file, 'utf8');
        const exempt = DATA_UI_ID_EXEMPT[rel] ?? [];
        for (const hit of findBufferedInputs(src)) {
          scanned++;
          if (hit.hasId) continue;
          if (exempt.some((prefix) => hit.snippet.startsWith(prefix.replace(/\s+/g, ' ')))) continue;
          missing.push(`${rel}:${hit.line}  ${hit.snippet}`);
        }
      }
    }
    // This check is worthless if the scan found nothing to check.
    expect(scanned).toBeGreaterThan(30);
    expect(missing, `untagged BufferedNumberInput/BufferedTextInput — add dataUiId or an entry in DATA_UI_ID_EXEMPT with a reason:\n${missing.join('\n')}`).toEqual([]);
  });

  // The other half of #724's coverage — the shared-helper surface the scan above cannot see
  // (see the ⚠️ HONEST SCOPE note). This does not re-run tsc (that's `npm run typecheck`'s job);
  // it guards against the SOURCE regressing `dataUiId: string` back to `dataUiId?: string` on one
  // of the four known wrappers, which would silently reopen the gap the type checker now closes.
  //
  // Structural, not a frozen text needle (close-out 2026-09-05: the prior version matched exact
  // strings like `'dataUiId: string; dataUiLabel?: string }'`, which goes red on a pure reformat
  // or the instant a sibling prop is added after `dataUiId` while it stays required — and its
  // `not.toMatch(/dataUiId\?:\s*string/)` was FILE-WIDE, so an unrelated, legitimately-optional
  // `dataUiId` on some OTHER component in the same file would fail it too). This instead extracts
  // ONLY the named component's own parameter list (from `function <Name>(` to its matching `)` —
  // paren-depth tracked, so a default-value arrow function inside it can't end the scan early)
  // and checks the `dataUiId` prop declaration within THAT block alone.
  function extractFunctionParams(src: string, name: string): string | null {
    const m = new RegExp(`\\bfunction\\s+${name}\\s*\\(`).exec(src);
    if (!m) return null;
    const start = m.index + m[0].length - 1; // the '(' itself
    let depth = 0;
    for (let i = start; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') { depth--; if (depth === 0) return src.slice(start, i + 1); }
    }
    return null;
  }

  it('AssetRefField/NumRow/Num/FieldValueWidget keep dataUiId REQUIRED, not optional', () => {
    const HELPERS: { file: string; component: string }[] = [
      { file: 'packages/modoki/src/editor/panels/AssetRefField.tsx', component: 'AssetRefField' },
      { file: 'packages/modoki/src/editor/panels/MaterialOverridesField.tsx', component: 'NumRow' },
      { file: 'packages/modoki/src/editor/panels/SpriteEditor.tsx', component: 'Num' },
      { file: 'packages/modoki/src/editor/panels/inspectorFields.tsx', component: 'FieldValueWidget' },
    ];
    for (const { file, component } of HELPERS) {
      const src = fs.readFileSync(path.resolve(__dirname, '../..', file), 'utf8');
      const params = extractFunctionParams(src, component);
      expect(params, `${file}: could not find "function ${component}(" — has it been renamed or refactored?`).not.toBeNull();
      const m = /\bdataUiId\s*(\??)\s*:/.exec(params!);
      expect(m, `${file}: ${component}'s prop type has no "dataUiId:" annotation — has it been removed?`).not.toBeNull();
      expect(m![1], `${file}: ${component}'s dataUiId prop reverted to optional ("dataUiId?:") — must stay REQUIRED`).toBe('');
    }
  });
});

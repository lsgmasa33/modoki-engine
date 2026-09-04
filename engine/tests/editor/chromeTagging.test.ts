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
});

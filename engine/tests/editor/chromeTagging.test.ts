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
      'sceneView.toolbar.focus', 'sceneView.toolbar.colliders2d',
    ],
    why: 'the viewport toolbar — gizmo mode/space, collider point editing, and the "View" dropdown (FX/Grid/Colliders in 3D, FX/Focus/Colliders in 2D).',
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
    file: 'panels/ApplyPrefabDialog.tsx',
    ids: ['prefab.dialog.confirm', 'prefab.dialog.cancel'],
    why: 'the modal EXIT. Inspector tags open this dialog; without these an agent enters a modal it cannot leave.',
  },
];

describe('data-ui-id tagging has not rotted', () => {
  for (const { file, ids, why } of REQUIRED) {
    it(`${file} still tags: ${why}`, () => {
      const src = read(file);
      for (const id of ids) expect(src, `missing data-ui-id fragment "${id}"`).toContain(id);
    });
  }

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

  it('every tagged id is dot-namespaced as <panel>.<region>.<name>', () => {
    // Coherence: an agent should be able to guess `assets.toolbar.*` from `hierarchy.toolbar.*`.
    const statics = REQUIRED.flatMap((r) => r.ids).filter((id) => !id.startsWith('`'));
    expect(statics.length).toBeGreaterThan(15); // this check is worthless if the list is empty
    for (const id of statics) {
      expect(id.split('.').length, `"${id}" should have at least 3 dot segments`).toBeGreaterThanOrEqual(3);
    }
  });
});

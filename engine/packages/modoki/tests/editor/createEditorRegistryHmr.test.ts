/** createEditor's host registries must survive a module RE-EVALUATION.
 *
 *  The bug (measured live 2026-08-18, games/3d-test, backend 5183): appending a newline to
 *  `editor/panels/SceneListEditor.tsx` — no semantic change — made File → Project Settings
 *  stop rendering. The menu item fired, `projectSettingsOpen` flipped true, and NOTHING
 *  appeared, with no console error. SceneListEditor exports a non-component, so Fast Refresh
 *  invalidates it and the update propagates up through createEditor.tsx, which gets
 *  re-evaluated — resetting the module-level registries to empty. `ProjectSettingsDialog`
 *  renders `null` when `getProjectSettings()` is null, so the failure is silent by
 *  construction, and the Game panel falls back to its stub the same way.
 *
 *  createEditor()'s self-accept reload guard does NOT catch this: the update boundary is the
 *  downstream panel, not this module. So the registries live in a globalThis slot instead,
 *  which survives re-evaluation whatever the boundary turns out to be.
 *
 *  `vi.resetModules()` + re-import is exactly that shape — a second module instance over a
 *  globalThis that persists. A `let` at module scope fails these; the durable slot passes. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

type CreateEditorModule = typeof import('../../src/editor/createEditor');

const MODULE = '../../src/editor/createEditor';

/** Re-import the module as a genuinely fresh instance, the way an HMR re-evaluation does. */
async function reimport(): Promise<CreateEditorModule> {
  vi.resetModules();
  return import(MODULE);
}

describe('createEditor host registries survive a module re-evaluation (HMR)', () => {
  beforeEach(() => {
    // Each test starts from a clean slot so ordering never carries state between them.
    delete (globalThis as unknown as Record<string, unknown>).__modokiEditorRegistries;
  });

  it('keeps extra menus written by the FIRST instance readable from the second', async () => {
    const first = await reimport();
    first.setExtraMenus({ Build: [{ label: 'iOS Device' }] });
    expect(first.getExtraMenus()?.Build?.[0]?.label).toBe('iOS Device');

    const second = await reimport();
    expect(second.getExtraMenus()?.Build?.[0]?.label).toBe('iOS Device');
  });

  it('does not rewind the extra-menus version counter', async () => {
    const first = await reimport();
    first.setExtraMenus({ Build: [] });
    first.setExtraMenus({ Build: [{ label: 'Android Device' }] });
    const version = first.getExtraMenusVersion();
    expect(version).toBeGreaterThan(0);

    const second = await reimport();
    expect(second.getExtraMenusVersion()).toBe(version);
    // A rewound counter would make the NEXT bump land on a version the menu bar has already
    // rendered, so the update would be dropped as "unchanged" rather than re-rendered.
    second.setExtraMenus({ Build: [] });
    expect(second.getExtraMenusVersion()).toBe(version + 1);
  });

  it('still notifies a subscriber registered before the re-evaluation', async () => {
    const first = await reimport();
    const notified = vi.fn();
    first.subscribeExtraMenus(notified);

    const second = await reimport();
    second.setExtraMenus({ Build: [{ label: 'Web' }] });

    // The mounted menu bar subscribed through the OLD instance; a fresh, empty listener Set
    // would leave it subscribed to nothing and silently stale.
    expect(notified).toHaveBeenCalledTimes(1);
  });

  it('unsubscribing through the first instance still works after the re-evaluation', async () => {
    const first = await reimport();
    const notified = vi.fn();
    const unsubscribe = first.subscribeExtraMenus(notified);
    unsubscribe();

    const second = await reimport();
    second.setExtraMenus({ Build: [] });
    expect(notified).not.toHaveBeenCalled();
  });

  it('carries the Project Settings schema across — the reported failure', async () => {
    const first = await reimport();
    // createEditor() itself is not callable headlessly (it boots a renderer), so write the
    // slot the way createEditor() does and assert the READ side, which is what the dialog uses.
    const schema = { tabs: [{ title: 'General', groups: [] }], load: async () => ({}), save: async () => true as const };
    (globalThis as unknown as Record<string, { projectSettings: unknown }>)
      .__modokiEditorRegistries.projectSettings = schema;
    expect(first.getProjectSettings()).toBe(schema);

    const second = await reimport();
    // ProjectSettingsDialog returns null on a null schema — this identity IS the dialog rendering.
    expect(second.getProjectSettings()).toBe(schema);
  });

  it('carries the custom panels and the Game View component across', async () => {
    const reg = (globalThis as unknown as Record<string, Record<string, unknown>>);
    const first = await reimport();
    const gameView = () => null;
    const panels = [{ id: 'p', name: 'P', component: gameView }];
    reg.__modokiEditorRegistries.gameView = gameView;
    reg.__modokiEditorRegistries.customPanels = panels;
    expect(first.getGameViewComponent()).toBe(gameView);

    const second = await reimport();
    expect(second.getGameViewComponent()).toBe(gameView);
    expect(second.getCustomPanels()).toBe(panels);
  });
});

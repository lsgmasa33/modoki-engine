/** The three new agent routes from the #373 handle-provider-gate sweep:
 *  `select-sprite-slice`, `open-skin-editor`, `set-skin-mode`. Also pins two bugs the
 *  close-out review caught while adding them:
 *
 *  - `requireAssetPath`'s type check called `getAssetType(path)`, but that lookup is
 *    GUID-keyed — a path is never a key in that map, so the mismatch branch could never
 *    throw and every open-*-editor op would silently open on ANY registered asset
 *    regardless of type. Fixed to `getAssetEntry(path)?.type`; the first two cases here are
 *    the regression test that catches the old (broken) behaviour reappearing.
 *  - `set-skin-mode` used to silently no-op on an unrecognised mode (`if (valid) set(...)`,
 *    no `else`), so a typo returned `ok:true` with nothing changed. */

import { describe, it, expect, beforeEach } from 'vitest';
import { registerAsset } from '@modoki/engine/runtime';
import { useEditorStore } from '@modoki/engine/editor';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';

registerAllTraits();
registerEditorAgentOps();

const TEXTURE_GUID = '00000010-0000-4000-8000-000000000010';
const TEXTURE_PATH = '/assets/textures/hero.png';
const RIG_GUID = '00000011-0000-4000-8000-000000000011';
const RIG_PATH = '/assets/characters/hero.rig2d.json';

registerAsset(TEXTURE_GUID, TEXTURE_PATH, 'texture');
registerAsset(RIG_GUID, RIG_PATH, 'rig2d');

type OpReply = { ok: boolean; error?: string; [k: string]: unknown };

beforeEach(() => {
  useEditorStore.setState({
    spriteEditorSelection: null,
    editingSkinAsset: null,
    skinMode: 'rig',
  });
});

describe('open-skin-editor', () => {
  it('opens the panel and reports it via editor state', async () => {
    await runAgentOp('open-skin-editor', { path: RIG_PATH });
    expect(useEditorStore.getState().editingSkinAsset?.path).toBe(RIG_PATH);
    const state = await runAgentOp('editor-state', {}) as { editingSkinAsset?: { path: string } };
    expect(state.editingSkinAsset?.path).toBe(RIG_PATH);
  });

  // Regression for the dead `requireAssetPath` guard (#373 close-out): opening the Skin
  // editor on a TEXTURE used to succeed silently — the type mismatch check could never fire.
  // `requireAssetPath` THROWS on a mismatch (like its `open-particle-editor`/`open-sprite-editor`
  // siblings), so calling the op directly (bypassing the HTTP relay that turns a throw into a
  // structured `ok:false`) surfaces it as a rejected promise.
  it('REFUSES a path that is not a rig2d asset, leaving no skin editor open', async () => {
    await expect(runAgentOp('open-skin-editor', { path: TEXTURE_PATH }))
      .rejects.toThrow(/texture.*rig2d|rig2d.*texture/);
    expect(useEditorStore.getState().editingSkinAsset).toBeNull();
  });

  it('REFUSES a path with no manifest entry at all', async () => {
    await expect(runAgentOp('open-skin-editor', { path: '/assets/characters/nope.rig2d.json' }))
      .rejects.toThrow();
    expect(useEditorStore.getState().editingSkinAsset).toBeNull();
  });
});

describe('set-skin-mode', () => {
  it('switches between all three modes', async () => {
    for (const mode of ['parts', 'weights', 'rig'] as const) {
      const r = await runAgentOp('set-skin-mode', { mode }) as OpReply;
      expect(r.ok).toBe(true);
      expect(useEditorStore.getState().skinMode).toBe(mode);
    }
  });

  // Regression: this used to be `if (valid) set(mode)` with no `else` — an unrecognised mode
  // returned ok:true with the mode left untouched, which is indistinguishable from success.
  it('REFUSES an unrecognised mode and leaves the current one untouched', async () => {
    useEditorStore.getState().setSkinMode('weights');
    const r = await runAgentOp('set-skin-mode', { mode: 'pose' }) as OpReply;
    expect(r.ok).toBe(false);
    expect(r.error).toContain("got \"pose\"");
    // The ride-along fields the refusal promises so a caller need not spend a second call.
    expect(r.skinMode).toBe('weights');
    expect(r.options).toEqual(['parts', 'rig', 'weights']);
    expect(useEditorStore.getState().skinMode).toBe('weights');
  });

  it('REFUSES a missing mode rather than defaulting to one', async () => {
    useEditorStore.getState().setSkinMode('weights');
    const r = await runAgentOp('set-skin-mode', {}) as OpReply;
    expect(r.ok).toBe(false);
    expect(useEditorStore.getState().skinMode).toBe('weights');
  });
});

describe('select-sprite-slice', () => {
  it('sets the selection and reports it back, including via editor-state', async () => {
    await runAgentOp('select-sprite-slice', { guid: 'slice-1' });
    expect(useEditorStore.getState().spriteEditorSelection).toBe('slice-1');
    const state = await runAgentOp('editor-state', {}) as { spriteEditorSelection: string | null };
    expect(state.spriteEditorSelection).toBe('slice-1');
  });

  it('deselects when guid is omitted or null', async () => {
    useEditorStore.getState().setSpriteEditorSelection('slice-1');
    await runAgentOp('select-sprite-slice', {});
    expect(useEditorStore.getState().spriteEditorSelection).toBeNull();
  });
});

describe('open-sprite-editor resets the prior selection', () => {
  // Regression for the close-out review's join-an-open-session finding: SpriteEditor's own
  // mount effect resets `spriteEditorSelection`, but calling this op on a path that is
  // ALREADY open re-triggers no mount at all — so without the op resetting it directly, an
  // agent joining a session a human already had open would read the human's selection back
  // as if this call had made it.
  it('clears spriteEditorSelection even though nothing here re-mounts the modal', async () => {
    useEditorStore.getState().setSpriteEditorSelection('a-human-selected-this');
    await runAgentOp('open-sprite-editor', { path: TEXTURE_PATH });
    expect(useEditorStore.getState().spriteEditorSelection).toBeNull();
  });

  it('REFUSES a rig2d path — the sprite editor only opens textures', async () => {
    await expect(runAgentOp('open-sprite-editor', { path: RIG_PATH }))
      .rejects.toThrow(/rig2d.*texture|texture.*rig2d/);
  });
});

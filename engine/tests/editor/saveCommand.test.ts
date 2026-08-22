/** `toastForSave` — what Cmd+S TELLS the human, for every outcome it now has (#259).
 *
 *  Two failure classes meet here, and they point in opposite directions:
 *   - C7, the old one: never claim a save that did not land. A green "Scene saved" fired
 *     unconditionally, without awaiting, told people their work was safe when nothing had been
 *     written.
 *   - Its mirror, new with this change: never report a bare failure over work that DID land. A
 *     save can now half-succeed — the asset docs written, the scene refused because the editor is
 *     scrubbing — and "Save FAILED" over three saved files is the same lie the other way round.
 *
 *  Both entry points (the keymap chord and the native File menu) render this one function, which
 *  is the other half of the point: they had already drifted once.
 */

import { describe, it, expect } from 'vitest';
import { toastForSave, sceneNeedsWriting, type SaveOutcome } from '@modoki/engine/editor';

const noAssets = { saved: [], failed: [] };
const scene = (o: Partial<SaveOutcome> & { scene: SaveOutcome['scene'] }): SaveOutcome =>
  ({ assets: noAssets, target: 'scene', ...o });

describe('toastForSave — the scene half', () => {
  it('a clean scene save is a success', () => {
    const t = toastForSave(scene({ scene: { saved: true, path: '/s.json', reason: 'ok' } }));
    expect(t.kind).toBe('success');
    expect(t.text).toBe('Scene saved');
  });

  it('a refused save is a warning that says nothing was written', () => {
    const t = toastForSave(scene({ scene: { saved: false, path: '/s.json', reason: 'write-failed' } }));
    expect(t.kind).toBe('warn');
    expect(t.text).toMatch(/nothing written/i);
  });

  it('a cancelled Save-As is INFO, not a failure — the user chose it', () => {
    const t = toastForSave(scene({ scene: { saved: false, path: null, reason: 'cancelled' } }));
    expect(t.kind).toBe('info');
  });

  it('names the panel that owns the mode, not a hardcoded "Timeline"', () => {
    // A hardcoded "timeline" sent Animation Editor users hunting for a control in the wrong window.
    const anim = toastForSave(scene({
      scene: { saved: false, path: '/s.json', reason: 'playing' },
      mode: { runMode: 'scrub', owner: 'animation' },
    }));
    expect(anim.text).toContain('Animation');
    expect(anim.text).toContain('scrub');

    const tl = toastForSave(scene({
      scene: { saved: false, path: '/s.json', reason: 'playing' },
      mode: { runMode: 'preview', owner: 'timeline' },
    }));
    expect(tl.text).toContain('Timeline');
  });

  it('distinguishes Play from a preview envelope — different exits', () => {
    const playing = toastForSave(scene({
      scene: { saved: false, path: '/s.json', reason: 'playing' },
      mode: { runMode: 'playing', owner: null },
    }));
    expect(playing.text).toMatch(/stop the game/i);
    expect(playing.text).not.toMatch(/Exit Preview/i);
  });
});

describe('toastForSave — the half-succeeded save this change introduces', () => {
  it('reports the assets that were written even when the SCENE was refused', () => {
    const t = toastForSave(scene({
      assets: { saved: ['/a.particle.json', '/b.anim.json'], failed: [] },
      scene: { saved: false, path: '/s.json', reason: 'playing' },
      mode: { runMode: 'scrub', owner: 'animation' },
    }));
    expect(t.text).toContain('2 assets saved');
    expect(t.text).toMatch(/SCENE was not saved/i);
    // …and still tells them how to save the scene, or the message is only half useful.
    expect(t.text).toContain('Exit Preview');
  });

  it('adds the asset count to a successful scene save', () => {
    const t = toastForSave(scene({
      assets: { saved: ['/a.particle.json'], failed: [] },
      scene: { saved: true, path: '/s.json', reason: 'ok' },
    }));
    expect(t.text).toBe('Scene saved · 1 asset saved');
    expect(t.kind).toBe('success');
  });

  it('a FAILED asset write downgrades an otherwise-green save and names the file', () => {
    // The write stays parked and hasUnsavedChanges() stays true; a green toast over that is how
    // an edit ends up existing only in memory while everyone believes it shipped.
    const t = toastForSave(scene({
      assets: { saved: [], failed: [{ path: '/a.particle.json', error: 'disk full' }] },
      scene: { saved: true, path: '/s.json', reason: 'ok' },
    }));
    expect(t.kind).toBe('warn');
    expect(t.text).toContain('/a.particle.json');
    expect(t.text).toMatch(/FAILED/);
  });
});

describe('toastForSave — the prefab half', () => {
  it('reports a prefab save, and its failure, without swallowing the asset half', () => {
    const ok = toastForSave({ assets: { saved: ['/a.rig2d.json'], failed: [] }, target: 'prefab', prefabSaved: true });
    expect(ok.kind).toBe('success');
    expect(ok.text).toContain('Prefab saved');
    expect(ok.text).toContain('1 asset saved');

    const bad = toastForSave({ assets: noAssets, target: 'prefab', prefabSaved: false });
    expect(bad.kind).toBe('warn');
    expect(bad.text).toMatch(/nothing written/i);
  });

  it('tells a REFUSED prefab save apart from a failed one, and says how to unblock it', () => {
    // Refused (run-mode) and failed (root not found) both come back as `prefabSaved:false`, and
    // they need opposite advice: "exit preview" vs "look at the console". Reporting the refusal as
    // a failure sends the human debugging a prefab that is fine.
    const refused = toastForSave({
      assets: { saved: ['/a.particle.json'], failed: [] },
      target: 'prefab', prefabSaved: false, prefabRefused: true,
      mode: { runMode: 'scrub', owner: 'animation' },
    });
    expect(refused.kind).toBe('warn');
    expect(refused.text).toContain('1 asset saved');
    expect(refused.text).toMatch(/PREFAB was not saved/);
    expect(refused.text).toContain('Exit Preview');
    expect(refused.text).toContain('Animation');
    expect(refused.text).not.toMatch(/FAILED/);
  });
});

describe('toastForSave — a failed asset write is never styled as benign', () => {
  it('downgrades even a CANCELLED save, whose own outcome is innocuous', () => {
    // The sentence said FAILED while the toast rendered 'info'. Colour is what gets read, so the
    // one word that mattered arrived in the styling that says "nothing to see here".
    const t = toastForSave(scene({
      assets: { saved: [], failed: [{ path: '/a.particle.json', error: 'disk full' }] },
      scene: { saved: false, path: null, reason: 'cancelled' },
    }));
    expect(t.kind).toBe('warn');
    expect(t.text).toContain('/a.particle.json');
  });

  it('a clean cancel is still INFO — the downgrade must be caused by the failure, not by the branch', () => {
    const t = toastForSave(scene({ scene: { saved: false, path: null, reason: 'cancelled' } }));
    expect(t.kind).toBe('info');
  });
});


/** Cmd+S inside a preview envelope: exit → save → resume (owner's call, 2026-08-19). Interrupting
 *  the preview is only worth it when the scene actually has something to write — otherwise every
 *  save while animating would reload the world and rewrite the scene file for no content. */
describe('sceneNeedsWriting — whether a save is worth interrupting a preview for', () => {
  it('is false while only ASSET docs are dirty (authoring a clip touches no scene)', () => {
    expect(sceneNeedsWriting({ sceneDirty: false, dirtyScenes: [] })).toBe(false);
  });

  it('is true when the live world has unsaved scene edits', () => {
    expect(sceneNeedsWriting({ sceneDirty: true, dirtyScenes: [] })).toBe(true);
  });

  it('counts a dirty BASE scene — skipping the scene half would strand it', () => {
    // saveAll writes dirty bases after the primary; treating "the primary is clean" as "nothing to
    // write" would leave a base edit in memory only, which is the failure the #259 flush had.
    expect(sceneNeedsWriting({ sceneDirty: false, dirtyScenes: ['/assets/scenes/base.json'] })).toBe(true);
  });
});

describe('toastForSave — the assets-only save (preview held, scene clean)', () => {
  it('reports just the assets, with no warning about a scene nobody asked to save', () => {
    const t = toastForSave({ assets: { saved: ['/a.anim.json'], failed: [] }, target: 'assets' });
    expect(t.kind).toBe('success');
    expect(t.text).toBe('1 asset saved');
    expect(t.text).not.toMatch(/SCENE/i);
  });

  it('says so when there was nothing to save at all', () => {
    const t = toastForSave({ assets: { saved: [], failed: [] }, target: 'assets' });
    expect(t.kind).toBe('info');
    expect(t.text).toMatch(/nothing to save/i);
  });

  it('still surfaces a FAILED asset write on this path', () => {
    const t = toastForSave({ assets: { saved: [], failed: [{ path: '/a.anim.json', error: 'disk full' }] }, target: 'assets' });
    expect(t.kind).toBe('warn');
    expect(t.text).toContain('/a.anim.json');
  });
});


/** A save must never destroy work to make itself possible. Exiting a preview restores the snapshot
 *  taken when it began, so if the scene was edited INSIDE the envelope, cycling it for the save
 *  would revert those edits and then write the pre-edit world — reporting success. Measured while
 *  building the cycle: a set_transform made during a scrub was silently reverted that way. */
describe('toastForSave — a preview that holds authored scene edits', () => {
  it('names the edits, not "exit preview" — that advice would revert them', () => {
    const t = toastForSave(scene({
      assets: { saved: ['/a.anim.json'], failed: [] },
      scene: { saved: false, path: '/s.json', reason: 'playing' },
      mode: { runMode: 'scrub', owner: 'animation' },
      previewHoldsEdits: true,
    }));
    expect(t.kind).toBe('warn');
    expect(t.text).toMatch(/CHANGED while previewing/);
    expect(t.text).toMatch(/reverts those changes/);
    expect(t.text).not.toMatch(/⏹/);          // not the plain "press Exit Preview" advice
    expect(t.text).toContain('1 asset saved'); // the clip still saved, and still says so
  });

  it('falls back to the plain exit advice when the envelope holds no scene edits', () => {
    const t = toastForSave(scene({
      scene: { saved: false, path: '/s.json', reason: 'playing' },
      mode: { runMode: 'scrub', owner: 'animation' },
    }));
    expect(t.text).toContain('⏹ Exit Preview');
    expect(t.text).not.toMatch(/CHANGED while previewing/);
  });
});

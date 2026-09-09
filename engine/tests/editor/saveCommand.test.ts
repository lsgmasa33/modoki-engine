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
import {
  toastForSave, sceneNeedsWriting, type SaveOutcome, type UnsavedCauses,
} from '@modoki/engine/editor';

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
  /** A complete causes object with nothing dirty. Every case below starts here and turns ONE term
   *  on, so each says what it means.
   *
   *  ⚠️ Spelled in full on purpose (#972 P3). These cases used to pass `{ sceneDirty, dirtyScenes }`
   *  and nothing else — legal, because the parameter was typed as exactly that pair, and a
   *  structural subtype of the real causes object is assignable to it. That is what let the
   *  function read two of five causes while looking correct, and it is why a parked base-scene ref
   *  could not make a save happen. The parameter is the whole `UnsavedCauses` now, so a cause added
   *  to the table makes THIS object fail to compile until the suite decides what it means here. */
  const clean = (): UnsavedCauses => ({
    sceneDirty: false, dirtyAssetPaths: [], dirtyScenes: [], pendingBaseScenes: [], pendingImportSettings: [],
  });

  it('is false while only ASSET docs are dirty (authoring a clip touches no scene)', () => {
    expect(sceneNeedsWriting({ ...clean(), dirtyAssetPaths: ['/a.particle.json'] })).toBe(false);
  });

  it('is true when the live world has unsaved scene edits', () => {
    expect(sceneNeedsWriting({ ...clean(), sceneDirty: true })).toBe(true);
  });

  it('counts a dirty BASE scene — skipping the scene half would strand it', () => {
    // saveAll writes dirty bases after the primary; treating "the primary is clean" as "nothing to
    // write" would leave a base edit in memory only, which is the failure the #259 flush had.
    expect(sceneNeedsWriting({ ...clean(), dirtyScenes: ['/assets/scenes/base.json'] })).toBe(true);
  });

  it('is FALSE for parked work that writes no scene — those have their own flush', () => {
    // The other half of #972 P3, and the reason this is a derivation rather than a longer hand
    // list: a pending base-scene ref or import-setting edit must NOT cycle the preview, because
    // exiting and re-entering buys a flicker and a scene rewrite for work the scene write does not
    // carry. `runSaveAll.test.ts` covers the consequence — the fast path flushes them instead.
    expect(sceneNeedsWriting({ ...clean(), pendingBaseScenes: ['/scenes/child.scene.json'] })).toBe(false);
    expect(sceneNeedsWriting({ ...clean(), pendingImportSettings: ['/assets/tex.png'] })).toBe(false);
  });
});

describe('toastForSave — the assets-only save (preview held, scene clean)', () => {
  it('NAMES base-scene refs it wrote — "Nothing to save" was a lie the human acts on (#972)', () => {
    // The exact scenario P12 exists for: a timeline preview is live and the only unsaved work is a
    // parked base-scene ref, so the fast path runs, writes it, and reports `target:'assets'`.
    // `toastForSave` counted `assets.saved` alone, so the human was told "Nothing to save" about a
    // write that had just landed. The failure suffix already named base-scene FAILURES; their
    // successes were the one outcome nothing reported.
    const t = toastForSave({
      assets: { saved: [], failed: [] },
      baseScenes: { saved: ['/scenes/child.scene.json'], failed: [] },
      target: 'assets',
    });
    expect(t.text).toContain('1 base-scene ref saved');
    expect(t.text, 'the write landed — this must not read as a no-op').not.toContain('Nothing to save');
    expect(t.kind).toBe('success');
  });

  it('names import-settings edits it wrote, with their own noun', () => {
    // Same hole, same fix: "asset" names an ASSET_SCHEMA_TYPES document, and a human told
    // "1 asset saved" for a `.meta.json` sidecar looks in the Assets panel instead of the Inspector.
    const t = toastForSave({
      assets: { saved: [], failed: [] },
      importSettings: { saved: ['/assets/tex.png'], failed: [] },
      target: 'assets',
    });
    expect(t.text).toContain('1 import-setting edit saved');
    expect(t.text).not.toContain('Nothing to save');
  });

  it('still says "Nothing to save" when nothing of ANY kind was written', () => {
    // The negative half — otherwise the fix above could be "always claim something saved".
    const t = toastForSave({ assets: { saved: [], failed: [] }, target: 'assets' });
    expect(t.text).toContain('Nothing to save');
    expect(t.kind).toBe('info');
  });

  it('a CANCELLED scene save still names a base-scene ref that DID land', () => {
    // The sixth `n ?` gate, missed in the first pass and found by re-reading the emitted branches
    // rather than trusting the grep that had just reported five. A cancelled Save-As over a
    // successful base-scene write said "Save cancelled — nothing written" — the same class of lie
    // as the assets branch, in the branch where the human is most likely to believe it.
    const t = toastForSave({
      assets: { saved: [], failed: [] },
      baseScenes: { saved: ['/scenes/child.scene.json'], failed: [] },
      target: 'scene',
      scene: { saved: false, path: null, reason: 'cancelled' },
    });
    expect(t.text).toContain('1 base-scene ref saved');
    // ⚠️ The assertion is on the WHOLE-MESSAGE form, not the phrase. The message correctly ends
    // "…the scene save was cancelled, nothing written for it" — "it" is the scene, and that is
    // true. What must not appear is the bare `Save cancelled — nothing written`, which is the
    // branch taken when nothing landed at all. (My first version of this test asserted the phrase
    // and failed on a correct message.)
    expect(t.text).not.toContain('Save cancelled — nothing written');
  });

  it('names every kind together when a save wrote all three', () => {
    const t = toastForSave({
      assets: { saved: ['/a.anim.json'], failed: [] },
      baseScenes: { saved: ['/scenes/child.scene.json'], failed: [] },
      importSettings: { saved: ['/assets/tex.png'], failed: [] },
      target: 'assets',
    });
    expect(t.text).toContain('1 asset saved');
    expect(t.text).toContain('1 base-scene ref saved');
    expect(t.text).toContain('1 import-setting edit saved');
  });

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

describe('a refused base-scene ref is reported, and named as itself (#831)', () => {
  // The Scene inspector's `baseScene` edit parks and `saveAll` flushes it LAST, through
  // /api/scene-mutate — a route with its own run-mode and unsaved-work refusals. When it turns the
  // write down the entry is re-parked, so the edit is still pending and nothing else would have
  // told the human. Same rule as a failed asset write: report the pending work that stayed pending.
  it('names the path and turns the toast WARN, even over a scene that saved fine', () => {
    const t = toastForSave(scene({
      scene: { saved: true, path: '/s.scene.json', reason: 'ok' },
      baseScenes: { saved: [], failed: [{ path: '/assets/scenes/level-2.scene.json', error: 'the editor has unsaved live changes' }] },
    }));
    expect(t.kind, 'a save that left work unsaved is a warning, whatever else went right').toBe('warn');
    expect(t.text).toContain('base-scene ref(s) FAILED');
    expect(t.text).toContain('/assets/scenes/level-2.scene.json');
  });

  it('calls it a base-scene ref, NOT an asset write', () => {
    // Different noun on purpose: a one-field scene mutation is not an asset document, and a human
    // sent to the asset panel to retry it looks in the wrong place. `discard_asset_edits` does not
    // reach these either, so the wrong noun points at the wrong remedy too.
    const t = toastForSave(scene({
      scene: { saved: true, path: '/s.scene.json', reason: 'ok' },
      baseScenes: { saved: [], failed: [{ path: '/l.scene.json', error: 'nope' }] },
    }));
    expect(t.text).not.toContain('asset write(s) FAILED');
  });

  it('reports BOTH kinds when both failed, in one sentence', () => {
    const t = toastForSave(scene({
      scene: { saved: true, path: '/s.scene.json', reason: 'ok' },
      assets: { saved: [], failed: [{ path: '/a.mat.json', error: 'disk full' }] },
      baseScenes: { saved: [], failed: [{ path: '/l.scene.json', error: 'nope' }] },
    }));
    expect(t.text).toContain('asset write(s) FAILED');
    expect(t.text).toContain('base-scene ref(s) FAILED');
  });

  it('says nothing when the base-scene flush had nothing to do', () => {
    // The silence matters as much as the report: a save with no pending refs must not mention them.
    const t = toastForSave(scene({ scene: { saved: true, path: '/s.scene.json', reason: 'ok' } }));
    expect(t.text).not.toContain('base-scene');
    expect(t.kind).not.toBe('warn');
  });
});

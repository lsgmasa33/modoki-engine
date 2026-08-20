/** `adoptParkedDoc` — opening a panel ON a parked write must not claim the write is saved.
 *
 *  Two p0 bugs shared this one line. The panels called `markSaved(<the parked doc>)` here, which
 *  names an UNSAVED document as the on-disk baseline; `useParkedAssetDoc`'s reconciliation branch
 *  then fires on the next run and discards the pending write. The end state is the worst
 *  available — panel shows the edit, disk holds the old doc, registry empty, badge `Saved ✓` —
 *  so Cmd+S writes nothing and the edit dies at the next reload with no error.
 *
 *    EhE6JQkHRYttDGeGmtPK — an AGENT parks a clip edit, the human re-opens the clip.
 *    1MCF9DFktot8hXsgBuWp — a human parks a panel edit, then RENAMES the asset (the repoint
 *                           changes the panel's path, which re-runs the same load effect).
 *
 *  Filed separately, different triggers, one cause. The rename is not special.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearDirtyAssets, markAssetDirty, peekDirtyAsset, getDirtyAssetPaths,
} from '@modoki/engine/editor';
// Imported from source, not the barrel: this pair is panel-internal and deliberately not part
// of the public editor surface (which carries its own baseline guard).
import { adoptParkedDoc, pendingAssetDoc } from '../../packages/modoki/src/editor/panels/pendingAssetDoc';

const PATH = '/assets/fx/spark.particle.json';

beforeEach(() => clearDirtyAssets());

describe('adoptParkedDoc', () => {
  it('keeps an AGENT park as agent-origin after the panel normalizes it', () => {
    // Relabelling to 'panel' is not cosmetic: a panel-origin flush sends replace:true and deletes
    // the top-level fields the drop-key guard exists to refuse.
    const agentDoc = { looping: true, n: 1 };
    markAssetDirty(PATH, 'particle', agentDoc, 'agent');

    const normalized = { ...agentDoc };            // the panel's own copy — a NEW object
    adoptParkedDoc(PATH, 'particle', normalized);

    expect(peekDirtyAsset(PATH)).toEqual({ type: 'particle', data: normalized, origin: 'agent' });
  });

  it('keeps a PANEL park as panel-origin', () => {
    const doc = { looping: false };
    markAssetDirty(PATH, 'particle', doc, 'panel');
    const normalized = { ...doc };
    adoptParkedDoc(PATH, 'particle', normalized);
    expect(peekDirtyAsset(PATH)?.origin).toBe('panel');
  });

  it('leaves the write PENDING — the whole point', () => {
    markAssetDirty(PATH, 'particle', { n: 1 }, 'agent');
    adoptParkedDoc(PATH, 'particle', { n: 1 });
    expect(getDirtyAssetPaths()).toEqual([PATH]);
  });

  it('registry entry stays readable as the pending doc for the panel', () => {
    const agentDoc = { n: 7 };
    markAssetDirty(PATH, 'particle', agentDoc, 'agent');
    const normalized = { ...agentDoc };
    adoptParkedDoc(PATH, 'particle', normalized);
    // The identity the hook keys on is now the panel's object, so its "already parked by whoever
    // put this exact object there" branch matches instead of falling through and re-parking.
    expect(pendingAssetDoc(PATH, 'particle')).toBe(normalized);
  });

  it('defaults to panel origin when nothing was parked (a caller mistake, not a crash)', () => {
    adoptParkedDoc(PATH, 'particle', { n: 1 });
    expect(peekDirtyAsset(PATH)?.origin).toBe('panel');
  });
});

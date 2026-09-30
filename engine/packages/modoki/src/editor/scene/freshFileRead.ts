/** "This editor operation read file X fresh from disk" — the ONE entry point every such reader calls (#1902, generalised
 *  from #1899's scene-load observer). What it read IS the outside change the #1879 hold lists for that file, so the hold
 *  must drop it: left listed, `pendingOutsideChanges` named a file the editor already shows, the next focus gain or
 *  refresh applied it a second time, and for an asset document the release then DISCARDED a park the user had made on
 *  the very bytes it was "applying" (`dropParkedWriteFor`).
 *
 *  Readers: a scene load (`serialize.ts`), prefab edit-open (`prefabEdit.ts`), the re-import after a parked prefab is
 *  discarded (`agentEditorOps.ts`, which calls the bridge directly), and the asset editors' open/Retry
 *  (`panels/assetDocLoad.ts` `readAssetDocFresh`). A read of a PARKED document is not a disk read and takes no ticket:
 *  its held change stands, and the park's conflict handling owns it.
 *
 *  The hold lives in `app/debug/agentBridge.ts`, which this package cannot import, so the app installs the observer
 *  (`agentEditorOps.ts`); with none installed (tests, a device build) a ticket does nothing. */

import { endOutsideChangeHold } from './dirtyAssets';

export interface FreshFileReadObserver {
  /** Before the read: the `heldSeq`s of the changes to `path` held right now — only those can be in the bytes read. */
  begins(path: string): readonly number[];
  /** After the read was applied: drop the covered changes. Returns what it dropped (the path as the hold spelled it),
   *  whose `heldOutside` notes the ticket then ends (a void return ends none). */
  loaded(path: string, covered: readonly number[]): readonly { path: string; seq: number }[] | void;
}

let _observer: FreshFileReadObserver | null = null;
export function setFreshFileReadObserver(observer: FreshFileReadObserver | null): void {
  _observer = observer;
}

export interface FreshFileRead {
  /** A held outside change of the file predates this read, so the read includes it. */
  readonly coversHeldChange: boolean;
  /** The read landed and the editor now shows it: its covered changes are applied. Call once, only on success — a read
   *  that failed or was discarded applied nothing, and its change stays held. Idempotent. */
  landed(): void;
}

/** Take a ticket BEFORE reading `path` (an asset-root URL, any spelling the bridge normalises). */
export function beginFreshFileRead(path: string): FreshFileRead {
  const observer = _observer;
  const covered = observer?.begins(path) ?? [];
  let done = false;
  return {
    coversHeldChange: covered.length > 0,
    landed: () => {
      if (done || !observer || covered.length === 0) return;
      done = true;
      const dropped = observer.loaded(path, covered);
      // A park made on the bytes this read showed is an ordinary edit, not one made over an outside change (#1902 c).
      for (const d of dropped ?? []) endOutsideChangeHold(d.path, d.seq);
    },
  };
}

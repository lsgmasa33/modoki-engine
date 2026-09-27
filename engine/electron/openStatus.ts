/** Where the project opens stand, for the agent's `/api/open-project` (#1587): the newest open not
 *  yet settled, and the root the last settled open actually opened.
 *
 *  ⚠️ `requestedRoot` (main.ts) cannot answer "is this project open already?". It is set when an open
 *  is QUEUED and never rolled back, so after a TIMEOUT or a failed open a repeat call compared equal
 *  and answered `ok, alreadyOpen` about a project still installing, or one that failed to open
 *  (#1587 close-out review). A failed open leaves `state.root` at a project the window never loaded,
 *  which is why a failure clears `opened` rather than leaving the previous root in it. */
export function createOpenStatus(initialRoot: string | null = null) {
  let inFlight: string | null = null;
  let opened: string | null = initialRoot;
  /** A generation, not a root comparison: A → B → A queues two opens of A, and the first one settling
   *  (superseded) must not clear the flag the second one still owns. */
  let generation = 0;

  return {
    /** An open was requested. Returns the handle its settle must pass back. */
    begin(root: string): number {
      inFlight = root;
      return ++generation;
    },
    /** That open settled. `result` is its outcome kind, or `'threw'`. Only the NEWEST open's settle
     *  counts: an open settles at its MOUNT, up to minutes after its reload, so an older one can settle
     *  after a newer one failed — and must not resurrect `opened` over that failure (#1587 review 3). */
    settle(gen: number, root: string, result: 'opened' | 'failed' | 'superseded' | 'threw'): void {
      if (gen !== generation) return;
      if (result === 'opened') opened = root;
      else if (result === 'failed' || result === 'threw') opened = null;
      inFlight = null;
    },
    /** The launch picked its project (it does not go through `begin`). */
    launched(root: string): void {
      opened = root;
    },
    status(): { inFlight: string | null; opened: string | null } {
      return { inFlight, opened };
    },
  };
}

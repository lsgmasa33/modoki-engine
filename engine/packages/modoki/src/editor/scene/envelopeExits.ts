/** The exits an agent is offered when an edit is refused inside a scrub/preview envelope.
 *
 *  ONE copy, read by both refusals that need it: `/api/scene-mutate`'s envelope 409 (#1122, in the
 *  backend router) and the live-world agent ops — create / duplicate / delete / reparent / prefab
 *  instantiate — which replied ok and were then silently reverted on Exit until #1552. Pure and
 *  import-free on purpose: the router runs in Node and cannot load the editor's module graph.
 *
 *  §5: name REAL exits only. `modoki_exit_pose_envelope` is a real exit for an ANIMATION-owned
 *  envelope and a guaranteed refusal for a timeline-owned one (it will not end another panel's
 *  session), so which one is listed depends on the owner.
 *
 *  ⚠️ `options` holds only things the agent can DO. The reason NOT to reach for the pose op goes in
 *  `hint` instead: an entry that names a tool in order to warn against it is still an entry with a
 *  tool name in it, and an agent scanning the list for something to call will call it.
 *  ⚠️ THREE arms, and the generic one is not padding. A previous draft collapsed it into the
 *  timeline arm, which then answered "Stop also ends a TIMELINE preview" to a renderer reporting no
 *  `modeOwner` at all (the field is omit-when-null) or a future third panel — the same "nobody
 *  remembers the next one" failure the router's mode allowlist exists to prevent. */
export function envelopeExitOptions(owner: string | null | undefined): { options: string[]; hint?: string } {
  if (owner === 'animation') {
    return {
      options: [
        'modoki_exit_pose_envelope — closes the ANIMATION preview, restores the authored world and returns the run-mode to stopped; then retry this call',
      ],
    };
  }
  if (owner === 'timeline') {
    return {
      options: [
        // ⚠️ A timeline envelope DOES have an agent exit, and an earlier draft denied it, sending
        // the agent to find a human over a one-call fix. `stopPlay()` ends a scrub/preview holding a
        // preview session; the `stop` agent op is unguarded.
        // ⚠️ …but it is DESTRUCTIVE, and saying so is the difference between an exit and a trap: it
        // restores the snapshot taken when the envelope opened (a full scene reload), so anything
        // the human did inside it is discarded. The old text asked the HUMAN to press ⏹; handing an
        // unattended agent the same button without the caution is not an improvement.
        "modoki_play_control {action:'stop'} — ends the Timeline preview session and returns the run-mode to stopped, then retry. ⚠️ DESTRUCTIVE: it restores the snapshot taken when the envelope opened, discarding anything the human authored inside it. Prefer asking them if they are at the screen",
        // ⚠️ NOT "a plain drag-scrub holds no session" — that was true before Phase 3. And no longer
        // "retry stop, the session had not finished seating": since #1569, Stop in the snapshot gap
        // cancels the begin, so a single stop ends the envelope and a retry has nothing left to do.
        'if the run-mode is STILL not stopped after that, escalate to the human’s ⏹ Exit Preview',
      ],
      hint: 'Do not reach for modoki_exit_pose_envelope here — it deliberately refuses a timeline-owned envelope, because ending that session would revert its world mid-run. Use modoki_play_control stop instead, minding the caution above.',
    };
  }
  return {
    options: [
      'exit the scrub/preview envelope — ⏹ Exit Preview in whichever panel is driving it — then retry',
    ],
  };
}

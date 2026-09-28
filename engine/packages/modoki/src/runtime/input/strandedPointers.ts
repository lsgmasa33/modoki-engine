/** Stranded pointers — the one rule every source that tracks pointers by id uses to let go of a
 *  pointer whose `pointerup`/`pointercancel` never arrived (#1706).
 *
 *  Such a source holds a pointer until its up or cancel comes, and when the platform never sends
 *  one nothing else ends it: `pointerSource` then swallows every later press, `gestureSource` reads
 *  every later touch as a second finger, and `touchControlSource` keeps a d-pad action held.
 *
 *  The proof that it is gone is the next REAL press being PRIMARY. Pointer Events define the primary
 *  pointer as the first of its type to go down while no other of that type is active, so a primary
 *  press means the browser holds no other pointer of that type. Anything a source still lists of
 *  that type is a strand.
 *
 *  OBSERVED on the owner's iPhone Air (iOS 26.6), Slime Shooter, 2026-09-28: a drag lost its release
 *  and the game took no drag after it. The three drags that followed each arrived `isPrimary: true`,
 *  alone in `TouchEvent.touches`. On the same phone a real second finger during a held drag arrives
 *  `isPrimary: false`, with both fingers listed, so this rule never lets a second finger take over a
 *  gesture — the primary-touch rule holds. And iOS keeps that per pointer, as the spec does: after the
 *  first finger lifts, the second stays non-primary to its own `pointerup`, though it is then the only
 *  touch (3 of 3). That rules out primary-by-position-in-the-event's-list, which WebKit's open-source
 *  GTK/WPE dispatch uses and the review suspected of iOS.
 *
 *  Only a real press (`isTrusted`) proves it. A synthetic event (the device debug bridge) carries
 *  whatever `isPrimary` its sender chose, which is a claim, not the browser's knowledge. */
export function provesEarlierPointersLifted(e: PointerEvent): boolean {
  return e.isTrusted && e.isPrimary === true;
}

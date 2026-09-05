/** pressOrigin — a DOM `click` only counts on a node when the PRESS that produced it also
 *  started there, not just the release.
 *
 *  ## The defect (#664)
 *
 *  A DOM `click` fires on the nearest common ancestor of the `pointerdown` and `pointerup`
 *  targets, not on the element either one actually landed on. wordweave's dictionary is
 *  `DictionaryModal` (scrim, bound to `wordweave.dictionaryClose`) > `DictionaryPanel` (a no-op
 *  `stopPropagation`-only binding) > `DictionaryPager` (a horizontally-scrolling pager). A
 *  horizontal paging swipe that starts on the pager and releases past the panel's edge — because
 *  the panel doesn't fill the viewport, or the swipe simply outruns it — has the browser resolve
 *  the resulting `click`'s target to `DictionaryModal`, the common ancestor. The panel's swallow
 *  handler is a descendant of that target, so it never runs, and the modal closes under a swipe
 *  that was never meant to dismiss anything.
 *
 *  ⚠️ **Per-control `stopPropagation` cannot fix this.** `UINode.tsx` already uses that technique
 *  on the `range` and text-input branches (see the comments near their `onClick={(e) =>
 *  e.stopPropagation()}` lines — the shipped Court bug where a settings slider dismissed its
 *  dialog mid-drag). That works only because a slider drag's `click` target stays ON the slider:
 *  the press and the release are both still inside it, so its own handler is the one that fires
 *  and stops the bubble. Here the release LEAVES the panel entirely, so the click's target
 *  becomes an ANCESTOR of the panel — no descendant handler is ever invoked, and there is nothing
 *  to call `stopPropagation` from.
 *
 *  ## The rule
 *
 *  A node's click bindings fire only when BOTH the press and the release that produced the click
 *  began on that same node — specifically, when each one's nearest interactive ancestor-or-self
 *  (`closest('[data-press-origin]')`) IS the node handling the click. A swipe that starts on
 *  the pager and ends on the scrim fails this on the scrim (its press did not start there) and
 *  the pager never gets a `click` in the first place (the browser's ancestor resolution already
 *  routed it to the scrim) — either way, `DictionaryModal`'s close binding does not fire.
 *
 *  ## Why this tracks at `document` level instead of per-control
 *
 *  The gate needs to see the PRESS, which may land on a node several layers below the one
 *  deciding whether to honour the click (the scrim, here) — a per-element listener on the scrim
 *  would never observe a `pointerdown` that happened on the pager. Capture-phase listeners on the
 *  document see every press and release regardless of which element they start on, which is
 *  exactly the vantage point `closest()` needs.
 *
 *  ## Why the pair is CONSUMED on read
 *
 *  `pressBelongsTo` clears the recorded pair as soon as it answers. A click with no preceding
 *  `pointerdown`/`pointerup` pair is a programmatic or assistive-technology activation (there is
 *  no swipe to distrust), so it must FAIL OPEN — see below. If a stale pair from an earlier
 *  gesture were left sitting after being consulted, it could wrongly suppress or wrongly permit a
 *  LATER programmatic click that has nothing to do with it. Consuming on read means every verdict
 *  is judged against its own pointer pair, never a leftover from the gesture before it.
 *
 *  ⚠️ **Fail-open is deliberate.** When either the press or the release was never recorded (no
 *  pointer events at all, or a click synthesized without them), `pressBelongsTo` returns `true` —
 *  the click is honoured. Suppressing an activation that arrived by keyboard, switch control, or
 *  `element.click()` would break real controls for no reason: `focusManager.ts`'s activation path
 *  calls `applyBindings` DIRECTLY rather than going through a DOM click, so keyboard/controller
 *  activation never reaches this gate at all — it is unaffected either way, and the fail-open
 *  here exists only for the DOM-click paths this module can actually see (mouse, touch, pen, and
 *  a bare `.click()` call).
 *
 *  ## ⚠️ LIMIT: this protects a panel only where the panel is ALREADY interactive
 *
 *  The gate asks whether the press's nearest `[data-press-origin]` ancestor is the node
 *  handling the click, and `UINode.tsx` stamps that marker only on nodes it considers
 *  interactive — ones carrying a click binding, OR ones authoring `UIElement.swallowClicks`
 *  (#728, the first-class way to opt a panel in without a no-op binding's side effects: the click
 *  cue and the input lock). So a panel with neither is transparent to `closest()`, the press
 *  resolves straight past it to the dismissing scrim, and the gate passes. Authoring a swallow —
 *  either way — is what OPTS a panel in.
 *
 *  ⚠️ **Which panels are covered is a PROPERTY, not a roster — do not enumerate them here.** The
 *  covered set is "every UI node carrying a click binding or `swallowClicks`", and a grep for
 *  `swallowClicks` across the scenes answers it for any given moment. An earlier version of this
 *  comment named the covered and uncovered panels individually; #728's migration invalidated it
 *  the same day, and a list that reads authoritative while being wrong is worse than no list.
 *  Court's bodies were the known uncovered group and are covered as of 2026-09-05 (#729);
 *  wordweave's `HelpPanel` (#741) and `ResultPanel` (#753) are not. That is where the question was
 *  last ASKED — it is not a roster in either direction, and the grep is what answers it.
 *
 *  The general fix would be to stamp the marker on any `overflow: 'scroll'` node too, on the
 *  grounds that a scrolling box owns gestures that begin in it. Deliberately NOT done here, as a
 *  standing non-goal rather than a pending ticket: it would also stop a tap on empty space inside
 *  a scrollable list from dismissing its modal, which is a feel change across a shipping game
 *  rather than a bug fix.
 *
 *  ## Why `pointercancel` counts as a release
 *
 *  `domGestureTracking.ts`'s header documents (from a jsdom probe in #579's close-out) that once
 *  a box starts scrolling natively under touch, the browser reclaims the touch as a pan and fires
 *  `pointercancel` while the finger is still down — no `pointerup` ever follows on that pointer.
 *  Treating a cancel as "no release recorded" would fail OPEN on exactly the touch-scroll case
 *  this fix exists for (the pager scrolling out from under the finger), silently undoing the
 *  fix. So `pointercancel` is recorded exactly like `pointerup`.
 *
 *  ## The rule for a handler that swallows a click
 *
 *  ANY runtime handler that stops a click's propagation must either consult the gate
 *  (`pressBelongsTo`, which consumes the pair as a side effect of answering) or, if it doesn't
 *  consult the gate at all, call `clearPressOrigin()` itself. React's synthetic
 *  `stopPropagation()` also stops the NATIVE event at the React root, so `onClickSweep`'s
 *  document-level bubble listener never runs for it — a handler that stops propagation without
 *  doing either leaves the pair sitting there for a LATER, unrelated click to misread.
 */

/** Marks an element as a valid press/release origin for the `pressBelongsTo` gate.
 *
 *  ⚠️ **Deliberately NOT in the `data-ui-*` namespace.** That prefix is the EDITOR CHROME
 *  handle convention (`data-ui-id`/`-label`/`-kind`, resolved by `chromeHandles.ts` and
 *  addressed by agent tooling and the QA cases). This attribute is a RUNTIME marker on the
 *  shipped game's own DOM, and both live in the editor's one document at once — sharing the
 *  prefix would put a runtime concern in the middle of a namespace every chrome grep walks. Stamped on
 *  every element `UINode.tsx` treats as interactive (an `isInteractive` click target, or a
 *  control that always swallows its own press: text input, range, toggle). */
export const UI_PRESS_ORIGIN_ATTR = 'data-press-origin';

const INTERACTIVE_SEL = `[${UI_PRESS_ORIGIN_ATTR}]`;

let downTarget: EventTarget | null = null;
let upTarget: EventTarget | null = null;

// A second, non-primary pointer (a resting finger landing or lifting while a button is held —
// the everyday case is a two-finger release) must not overwrite the primary pointer's recorded
// pair. Before this guard: pointerdown(button) → pointerdown(other) → pointerup(button) left
// `upTarget` from the FIRST pointerup already consumed and downTarget overwritten by `other`, so
// `pressBelongsTo(button)` compared the button's down against nothing recorded for it and
// returned false — a real tap FAILS CLOSED (the click was already `stopPropagation`'d, so the
// binding never runs). Ignoring non-primary pointers here means only the primary pointer's own
// press/release pair is ever tracked, so a second pointer touching down or lifting elsewhere is
// invisible to this module.
function onPointerDown(e: PointerEvent) {
  if (!e.isPrimary) return;
  downTarget = e.target;
  upTarget = null;
}

function onPointerUp(e: PointerEvent) {
  if (!e.isPrimary) return;
  upTarget = e.target;
}

// Same handler as pointerup — see the module doc's "Why pointercancel counts as a release".
const onPointerCancel = onPointerUp;

/** Clears the recorded press/release pair without consulting it. Any runtime handler that
 *  swallows a click via `e.stopPropagation()` WITHOUT calling `pressBelongsTo` must call this —
 *  otherwise the pair survives (React's synthetic `stopPropagation` also stops the native event
 *  at the React root, so `onClickSweep` below never runs either) and can be misread by a LATER,
 *  unrelated click with no pointer events of its own, which must fail open (see the module doc's
 *  "Fail-open is deliberate") but cannot tell that this stale pair isn't its own. `UINode.tsx`'s
 *  text-input, range and toggle branches call this from their swallowing `onClick` handlers. */
export function clearPressOrigin() {
  downTarget = null;
  upTarget = null;
}

/** Clears the pair after a click that reached NO consuming caller — a click on a non-interactive
 *  area, or one that bubbled past every interactive node untouched. Without this the pair would
 *  survive until the next `pointerdown` and could be read by a later synthesized click that has
 *  nothing to do with it, which is exactly what consuming-on-read exists to prevent.
 *
 *  BUBBLE phase, on the document, deliberately: React attaches its own listeners to the renderer
 *  root (below `document`), so this runs AFTER the node handler has had its chance to consume.
 *  ⚠️ A node that calls `e.stopPropagation()` stops the NATIVE event too, so this sweep never
 *  runs for it — such a node MUST consume the pair itself, either by calling `pressBelongsTo`
 *  (which consumes as a side effect of answering) or, if it doesn't consult the gate at all, by
 *  calling `clearPressOrigin()` directly. `UINode.tsx`'s text-input/range/toggle branches are the
 *  latter case. */
function onClickSweep() {
  downTarget = null;
  upTarget = null;
}

/** Refcounted PER DOCUMENT — the listeners this module installs are registered on a specific
 *  `Document`, so a single module-global count would be wrong two ways: a second, DIFFERENT
 *  document's first install would see a nonzero count and skip registering its own listeners
 *  (silently unarmed while `installCount` claims it's live), and disposing one document's install
 *  while another's is still held could decrement a shared count to a value that never reaches
 *  zero for either, leaving the first document's listeners registered forever.
 *
 *  Defensive rather than a live case today: only one runtime `UIRenderer` is ever mounted, and
 *  the editor's authoring-preview `UIRenderer` is gated out of this entirely (it passes
 *  `onSelectEntity`, which `UIRenderer.tsx` checks to skip installing this tracker) — so two
 *  mounted `UIRenderer`s never actually share a document today. This guards against a remount or
 *  a future second surface, not an existing scenario. */
const installCounts = new WeakMap<Document, number>();

/** Registers capture-phase, passive pointer listeners on `doc` so a press/release pair is
 *  recorded regardless of which element it starts or ends on. Returns a disposer; call it when
 *  the owning component unmounts. */
export function installPressOriginTracking(doc: Document): () => void {
  const count = installCounts.get(doc) ?? 0;
  if (count === 0) {
    doc.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });
    doc.addEventListener('pointerup', onPointerUp, { capture: true, passive: true });
    doc.addEventListener('pointercancel', onPointerCancel, { capture: true, passive: true });
    doc.addEventListener('click', onClickSweep, { passive: true });
  }
  installCounts.set(doc, count + 1);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const remaining = (installCounts.get(doc) ?? 1) - 1;
    installCounts.set(doc, remaining);
    if (remaining === 0) {
      doc.removeEventListener('pointerdown', onPointerDown, { capture: true });
      doc.removeEventListener('pointerup', onPointerUp, { capture: true });
      doc.removeEventListener('pointercancel', onPointerCancel, { capture: true });
      doc.removeEventListener('click', onClickSweep);
    }
  };
}

/** Consumes the recorded press/release pair and reports whether BOTH began on `el` — each one's
 *  nearest interactive ancestor-or-self is `el` itself. Fails OPEN (`true`) when either target
 *  was never recorded — see the module doc's "Fail-open is deliberate". */
export function pressBelongsTo(el: Element): boolean {
  const down = downTarget;
  const up = upTarget;
  downTarget = null;
  upTarget = null;
  if (down == null || up == null) return true;
  if (!(down instanceof Element) || !(up instanceof Element)) return true;
  return down.closest(INTERACTIVE_SEL) === el && up.closest(INTERACTIVE_SEL) === el;
}

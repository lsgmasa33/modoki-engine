/** safeArea — the measured safe-area insets, in logical px, for GAME CODE.
 *
 *  The UI layer clears the notch and home indicator declaratively (`UIAnchor.safeArea`,
 *  see anchorCss), and for most chrome that is the whole story. This exists for the case
 *  it cannot cover: a game whose own LAYOUT ARITHMETIC has to account for the inset —
 *  a bottom band reserved for an ad, a board fitted into what is left, a value derived
 *  from where a bar ends up. Court reserves 9.1% of the screen for a banner and derives
 *  the button row's position and the narration band's height from it; if the ad must
 *  render above the home indicator, that reserve grows by the inset and three numbers
 *  move with it. No CSS expression can hand a game those pixels.
 *
 *  ⚠️ **MEASURED, not computed** — and it has to be, because there are two sources of
 *  truth and only the browser knows which is live. On device the inset comes from
 *  `env(safe-area-inset-*)`; in an editor device preview it comes from the `--ui-sa-*`
 *  vars the preview publishes (`editor/scene/devicePresets.ts`), because `env()` is 0 on
 *  a desktop browser. A probe element inside the UI root resolves whichever applies
 *  through the normal cascade, so this returns the simulated inset in the editor and the
 *  real one on the phone, with no branch and no way for the two to disagree.
 *
 *  The probes must live INSIDE the UI root for that to work: `--ui-sa-*` is set on the
 *  preview container, so a probe on `document.body` would sit outside the cascade and
 *  read a confident, wrong 0 in every editor preview.
 *
 *  Returns zeros before the UI layer has mounted (a headless test, a game with no UI, a
 *  system running before first paint). Zero is the honest answer there — it is what a
 *  device with no notch reports — and it degrades to the pre-safe-area behaviour rather
 *  than to something arbitrary.
 *
 *  ── How the value stays fresh: a PUSH signal, not a poll (#612) ──────────────────────
 *
 *  ⚠️ **The probes are SIZED BY the inset, and that is the whole mechanism.** An inset
 *  changing fires no event of its own, and for four issues (#273 → #579 → #592 → #600)
 *  this file's answer was to re-measure on a throttle from inside the read — a poll,
 *  carrying a staleness throttle, a deferred measurement, an arming signal, a spend bound,
 *  a root-identity check, and a gesture gate living in `games/court/` because the forced
 *  layout it caused had to be kept out of a touch scroll. All of that is gone. When an
 *  element's HEIGHT is `env(safe-area-inset-top)`, an inset change resizes that element,
 *  and a `ResizeObserver` on it fires — so there IS a push signal, and the value is
 *  written from the observer callback off layout the browser has already settled, with nothing
 *  to bound. (The callback is not literally DOM-free: it makes a `getClientRects` call per entry
 *  and reads the root's `clientWidth`/`clientHeight`. See `onProbeResize` for what each is for,
 *  and for the one case where those reads can still cost a reflow.)
 *
 *  ⚠️ **Sizing the probe is load-bearing — the OBVIOUS implementation silently never
 *  fires.** `ResizeObserver` reports the CONTENT box by default. The probe this file used
 *  until #612 was deliberately `width:0; height:0` with the inset in its PADDING (that
 *  shape kept it out of flow and clamped negatives to 0 for free), so its content box was
 *  0×0 before and after, forever. Measured on the device this whole mechanism exists for
 *  (Galaxy A23 / Android 13, Court, real WebView, driving the bars via `SystemBars`):
 *  across three real inset transitions the SIZED probes fired every time with the correct
 *  values (top 28→32, bottom 0→48, and back), while the padding-shaped probe fired exactly
 *  once — its initial observation — and never on a change. Anyone re-shaping these probes
 *  must either keep them sized, or observe `{box:'border-box'}` and read `borderBoxSize`,
 *  NEVER `contentRect`. Bolting an observer onto the old shape would pass review, ship,
 *  and fail on device with no error.
 *
 *  ⚠️ **`env(...)` carries an explicit `0px` fallback and the size is wrapped in `max(0px,
 *  …)`. Both are guards, not decoration, and this is where a sized probe is MORE dangerous
 *  than the padding one it replaces.** `padding` clamps a negative to 0 and cannot be
 *  `auto`; `height` can be both. Measured in Chromium and WebKit: an `env()` the engine
 *  does not know makes the whole declaration invalid, so height falls back to `auto` and
 *  the probe reports ITS OWN CONTENT HEIGHT as the inset — a confident, wrong, non-zero
 *  number (18px in the probe used to measure it). `max()` does not save that; the `0px`
 *  fallback inside `env()` does, and was measured to give 0 in both engines. `overflow:
 *  hidden` and the probes never being given content are the second belt.
 *
 *  ⚠️ Note this deliberately differs from `anchorCss.ts`'s `var(--ui-sa-<edge>,
 *  env(safe-area-inset-<edge>))`, which has no inner fallback and does not need one: there
 *  the expression sits inside `max(<padding>, …)` on a `padding` property, where an invalid
 *  value drops the declaration and yields no padding — safe. Do not "align" the two.
 *
 *  The observer writes module state only — never the DOM, never React state — so it cannot
 *  produce the "ResizeObserver loop completed with undelivered notifications" warning that
 *  `UIRenderer`'s own observer has to rAF-defer around. */

export interface SafeAreaInsets {
  /** Logical px. */
  top: number;
  right: number;
  bottom: number;
  left: number;
  /** The same inset as a PERCENTAGE of the UI root's box — the space `%` lengths and anchor
   *  offsets resolve in.
   *
   *  ⚠️ **Use these, not `px / yourOwnMeasurement * 100`.** That division is a trap and it caught
   *  the first version of Court's banner lift: a game measuring its own host with
   *  `getBoundingClientRect` gets a POST-transform rect, and the editor's device preview renders at
   *  logical size under a `transform: scale()`. The px inset is in PRE-transform space, so mixing
   *  the two produced a 6.09% lift where 3.73% was correct — right on the phone, wrong in the
   *  editor, which is the worst way for it to be wrong. These are measured against the root's
   *  layout box in the same pass, so both numbers are always in one space. */
  topPct: number;
  rightPct: number;
  bottomPct: number;
  leftPct: number;
}

const ZERO: SafeAreaInsets = {
  top: 0, right: 0, bottom: 0, left: 0,
  topPct: 0, rightPct: 0, bottomPct: 0, leftPct: 0,
};

let insets: SafeAreaInsets = { ...ZERO };
/** The UI root the probes live in, remembered so a read can tell a live root from a detached one. */
let root: HTMLElement | null = null;

/** The two probes. Two, not four, because one element carries two edges: its WIDTH is one
 *  horizontal inset and its HEIGHT one vertical inset, and `contentRect` delivers both in a
 *  single observation. `probeTL` is top+left, `probeBR` is bottom+right.
 *
 *  ⚠️ **ONE root is probed at a time, module-globally — and in the EDITOR that root alternates.**
 *  Both viewports mount a `UIRenderer` (SceneView's preview frame and GameView), each with its own
 *  observer calling `measureSafeAreaInsets` with a DIFFERENT element, so every alternating resize
 *  tears the probes off one root and rebuilds them on the other. That is correct and was true of
 *  the old design too (`root` has always been last-registration-wins), and it is harmless because
 *  both viewports publish the same `safeAreaCssVars(gameViewSafeArea)` — but it means "the UI root
 *  has two probe children" holds for only ONE root at a time, and which one is not deterministic.
 *  A test asserting probe presence on a specific root in the editor would flake. */
let probeTL: HTMLElement | null = null;
let probeBR: HTMLElement | null = null;
let ro: ResizeObserver | null = null;

/** The last measured raw edges and root box, kept separately from `insets` because the two are
 *  refreshed by different signals and the percentages are derived from both.
 *
 *  ⚠️ **The root box is read via `clientWidth`/`clientHeight`, never from a `contentRect`.** The
 *  percentages have always been measured against those two properties (the PADDING box), and
 *  `contentRect` is the CONTENT box — swapping them would be a silent semantic change on any root
 *  that ever gains padding. Reading the same two properties the old code read keeps the
 *  percentages bit-for-bit what they were.
 *
 *  Both the registration path and the observer refresh this — see `onProbeResize` for why the
 *  observer cannot simply trust the registration's value (a rotation moves the root and the insets
 *  together, and the observer wins the race by a frame). */
let rawTop = 0, rawRight = 0, rawBottom = 0, rawLeft = 0;
let rootW = 0, rootH = 0;

if (import.meta.hot) {
  import.meta.hot.dispose(() => { resetSafeAreaInsets(); });
}

/** Read the current insets.
 *
 *  A plain field read plus one `isConnected` flag check — no throttle, no measurement, no
 *  computed style, no layout, and therefore nothing a per-frame caller has to be careful about.
 *  (Court makes six of these per frame.) That is the #612 change: this used to force a
 *  synchronous layout on a 250ms throttle from inside the read, which is why Court wrapped it in
 *  a touch-gesture gate (`boardSafeAreaInsets()`, deleted with the poll) and why #606 existed at
 *  all. Freshness now comes from the observer in `measureSafeAreaInsets`, which fires when the
 *  inset actually moves.
 *
 *  On device the observations landed ~105-108ms after the `SystemBars` call that moved the bars. ⚠️ Do
 *  not read that as an observer latency, and do not compare it against the old 250ms throttle:
 *  it is wall-clock from a JS call through a native round-trip and the bar's own animation, so
 *  most of it is the bars moving, not the notification arriving. What the measurement actually
 *  establishes is that the observation ARRIVES, unprompted, on the transition that matters —
 *  which is the property the poll existed to provide and the only one being claimed here. */
export function getSafeAreaInsets(): SafeAreaInsets {
  // ⚠️ A DETACHED root is released here rather than measured. `UIRenderer`'s callback ref returns
  // early on unmount (it has other teardown to skip), so it never hands this module a null — the
  // reference simply goes stale, still pointing at a removed node. Reachable two ways: in the
  // editor both viewports mount a UIRenderer, so closing the one that registered last detaches
  // this root while the other is still on screen; in a shipped game the tree empties for a beat
  // across a scene swap. Keeping the LAST GOOD value is the right answer either way — a device's
  // insets do not change because some UI unmounted — and dropping the reference is what stops the
  // whole removed subtree being retained by this module (found in review, #592 follow-up).
  //
  // `isConnected` is a cheap DOM flag read, not a forced layout, so this costs nothing per frame.
  if (root && !root.isConnected) releaseRoot();
  return insets;
}

/** Measure the insets from `el`'s cascade, and observe them from here on. Called by UIRenderer;
 *  not part of the game-facing surface.
 *
 *  This is the registration entry point — a real mount, a resize, or a scene swap's fresh root.
 *  It does three things: tears down any previous root's probes, installs fresh ones under `el`,
 *  and takes ONE synchronous measurement so the value is correct before the first observation
 *  arrives. The synchronous read is a forced layout, and the only one left in this module — paid
 *  once per registration (bounded by mounts and resizes) instead of on a 250ms poll for the life
 *  of the session. */
export function measureSafeAreaInsets(el: HTMLElement | null): void {
  // ⚠️ **A DETACHED `el` must be refused here, not measured** — this is the write path, and it is
  // the one the old code guarded with its `if (root !== target) return` identity check inside the
  // deferred refresh. That check went with the poll; this replaces it, and without it the
  // invariant `getSafeAreaInsets` asserts ("a detached root is released rather than measured") is
  // true only of the read.
  //
  // ⚠️ **This is DEFENCE IN DEPTH, not a live path — and the distinction is worth stating so the
  // next reader does not delete it as dead code.** The hazard was real: `UIRenderer`'s observer
  // rAF-defers its `update()`, so a container unmounting in the frame it mounted (a scene swap's
  // empty-tree beat, an editor panel closing mid-resize) landed here with a removed node —
  // `getComputedStyle` on a detached probe answers empty strings, so every inset is rewritten to
  // 0 (#273's exact symptom), and in the editor's two-viewport case the LATE call re-points `root`
  // at the dead node and tears the probes off the still-live viewport. `UIRenderer` now CANCELS
  // that frame (`frameRef`), which closes the only production path anyone has found into here.
  // This stays because it is the write path's half of an invariant the read path already asserts,
  // and because it costs one flag read to keep the guarantee independent of a cancel in another
  // file that a refactor could quietly drop.
  if (el && !el.isConnected) return;
  if (el !== root) releaseRoot();
  root = el;
  if (!el || typeof document === 'undefined' || typeof getComputedStyle !== 'function') {
    rawTop = rawRight = rawBottom = rawLeft = 0;
    rootW = rootH = 0;
    insets = { ...ZERO };
    return;
  }
  if (!probeTL) {
    probeTL = makeProbe('top', 'left');
    probeBR = makeProbe('bottom', 'right');
    el.appendChild(probeTL);
    el.appendChild(probeBR);
    // Feature-detected, matching this file's siblings (`scrollAnchor.ts`, `UINode.tsx`): jsdom
    // implements no ResizeObserver, so under test the synchronous path below is the whole
    // mechanism. That is not a degraded mode to paper over — a test that means to exercise the
    // PUSH path has to install a fake, and one that does not gets the same measurement the old
    // code gave it.
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(onProbeResize);
      ro.observe(probeTL);
      ro.observe(probeBR);
    }
  } else if (probeTL.parentElement !== el) {
    // The probes are PERSISTENT now (the old code created and removed one per measurement), and
    // they live in a container React owns. Nothing today removes them — `UIRenderer` unmounts the
    // whole container rather than clearing it, which comes back through this function as a NEW
    // root — but a detached probe answers empty computed styles, so if that ever changes the
    // symptom would be every inset silently reading 0. Re-attaching is one flag read and removes
    // the failure mode entirely.
    el.appendChild(probeTL);
    el.appendChild(probeBR!);
  }
  applyMeasurement(el);
}

/** One probe: a zero-content box whose WIDTH is `hEdge`'s inset and HEIGHT is `vEdge`'s.
 *
 *  `position: fixed` + no content keeps it out of flow entirely, so it cannot affect the layout
 *  it is measuring.
 *
 *  `visibility: hidden`, never `display: none`: a display-none element is not rendered, so it has
 *  no box, and `ResizeObserver` reports 0x0 for it (measured) — indistinguishable from a real
 *  zero inset by size alone. Note that is about the BOX, not the computed style: under
 *  `display:none` `getComputedStyle().height` still answers the correct length (also measured),
 *  which is exactly why `onProbeResize` discriminates on `getClientRects()` and on neither of
 *  those. */
function makeProbe(vEdge: 'top' | 'bottom', hEdge: 'left' | 'right'): HTMLElement {
  const probe = document.createElement('div');
  const len = (edge: string) => `max(0px, var(--ui-sa-${edge}, env(safe-area-inset-${edge}, 0px)))`;
  probe.style.cssText = 'box-sizing:content-box;position:fixed;top:0;left:0;visibility:hidden;'
    + 'pointer-events:none;overflow:hidden;'
    + `width:${len(hEdge)};height:${len(vEdge)};`;
  probe.setAttribute('data-modoki-safe-area-probe', `${vEdge}-${hEdge}`);
  // `visibility:hidden` already keeps these out of the accessibility tree and out of
  // `elementFromPoint`, so nothing in the repo can currently see them (swept: every DOM→entity
  // mapper here is keyed on `data-entity-id`/`data-ui-id`, and hit testing skips hidden subtrees).
  // This makes that guarantee explicit rather than emergent, so a future broad locator — a
  // Playwright `getByRole`, a `:scope > *` — cannot start matching two nodes that are not UI.
  probe.setAttribute('aria-hidden', 'true');
  return probe;
}

/** The observer callback — the push path. Reads `contentRect` off the entries the browser has
 *  already computed, so it forces no layout at all.
 *
 *  ⚠️ **An observation from a probe that is not being RENDERED reports 0×0, and writing that
 *  through would rewrite every inset to a confident zero with no device change** — the same
 *  failure the detached-root branch in `getSafeAreaInsets` exists to stop, arriving by the other
 *  door. Measured in Chromium and WebKit, and the obvious guards do not work: `display:none` on
 *  an ancestor fires 0×0 while `isConnected` stays **true** and `getComputedStyle().height` still
 *  reports the correct `68px`, so neither can discriminate. (Detaching the root outright fires
 *  nothing at all in either engine, so only the hidden case reaches here.)
 *
 *  `getClientRects().length` is the discriminator, and it is the right one specifically because
 *  of what it does NOT reject: a genuine zero-inset device (a phone with no notch — the common
 *  case) still has one rect, and so does a root that has no box yet, which `UIRenderer` measures
 *  for on purpose ("a container can be measurable for insets before it has a non-zero box"). Only
 *  a non-rendered subtree reports none. Called from inside a `ResizeObserver` callback, layout is
 *  already settled, so this is a read rather than a forced reflow. */
function onProbeResize(entries: ResizeObserverEntry[]): void {
  let rendered = false;
  for (const entry of entries) {
    if (entry.target.getClientRects().length === 0) continue;
    rendered = true;
    if (entry.target === probeTL) { rawTop = entry.contentRect.height; rawLeft = entry.contentRect.width; }
    else if (entry.target === probeBR) { rawBottom = entry.contentRect.height; rawRight = entry.contentRect.width; }
  }
  // ⚠️ **Bail on an all-rejected batch — do NOT fall through to the root read below.** Skipping the
  // raw edges is only half the guard: a `display:none` ancestor takes the root's box away too, so
  // reading it here would put 0 into the percentage denominators and `recompose` would rewrite all
  // four *Pct fields to a confident zero while the px insets correctly survived. That is worse than
  // the bug it would be half-fixing, because **the percentages are the only fields Court reads** —
  // all six of its call sites take `*Pct` — and `syncMenuIconBar` is change-gated, so a transient
  // zero does not merely read wrong, it moves the icon bar and moves it back.
  //
  // Found in review of THIS guard's own follow-up fix: the root read was added below to stop a
  // stale denominator and landed outside the protection three lines above it.
  if (!rendered) return;
  // ⚠️ **Re-read the root box HERE rather than trusting the one cached at registration.** A
  // rotation moves the root AND the insets, and this observer is delivered FIRST — it is
  // constructed inside `UIRenderer`'s `update()`, before `UIRenderer` constructs its own — while
  // `UIRenderer` rAF-defers the registration that would refresh the cache. Measured: root
  // 384×832 → 832×384 with a bottom inset of 48 arriving first yields `bottomPct` 5.77 where
  // 12.5 is correct — 2.17x wrong. It self-corrects a frame later, but Court reads these
  // percentages every frame at six sites, so the banner, board and narration band all pop for
  // that frame.
  //
  // `clientWidth`/`clientHeight` inside a `ResizeObserver` callback normally read layout the
  // browser has just settled, so this is usually a read rather than a forced reflow — and it
  // happens once per real inset change, not per frame. ⚠️ Not a guarantee, though, and the
  // caveat is this module's to own: an observer delivered EARLIER in the same cycle can dirty
  // layout first. `Scene3D`'s observer synchronously sets `renderer.domElement.style.width` /
  // `height`, and while this module's observer is constructed in a callback ref (layout phase) —
  // so it wins on first mount — `releaseRoot()` + a fresh `new ResizeObserver` on every UI-tree
  // empty→refill cycle moves it permanently AFTER `Scene3D`'s. In that ordering this read does
  // force a reflow. Once per real inset change is a price worth paying for a correct
  // denominator; a per-frame read here would not be.
  //
  // ⚠️ **Adopt each axis only when it is greater than zero — the same rule `applyMeasurement` uses,
  // and the `!rendered` bail above is NOT a substitute for it.** That guard rejects a probe in a
  // non-rendered subtree, which covers the editor's `display: none` case; it says nothing about a
  // root that is RENDERED and merely has a zero box on one axis. Under the `Free` preset GameView's
  // UI root is `position: absolute; inset: 0` over a `flex: 1` area, so it can be squeezed flat
  // while still rendering (a flexlayout tabset's min is 1px, not 0, but a 1px tabset holding a 32px
  // toolbar still leaves the area at 0); a scene swap's empty->refill beat is the same shape. Under
  // a FIXED device preset the root is a `deviceW x deviceH` box and does not collapse at all. So
  // this is a real geometry but a narrow one, and unlike the registration door it has not been
  // driven live — treat it as consistency plus defence in depth, not a fix for an observed symptom.
  //
  // The asymmetry is the argument: exactly two sites MEASURE this denominator (here and
  // `applyMeasurement`), and a reader who finds one guarded and one not will reasonably conclude the
  // difference is meaningful. It is not. ⚠️ Two further sites write it — the `!el` branch of
  // `measureSafeAreaInsets` and `resetSafeAreaInsets`, both zeroing it on teardown. Those are the
  // escape hatch that stops a retained denominator outliving the module's state, and a later
  // "apply the `> 0` rule consistently" sweep must NOT touch them. Worth noting this door is the worse of the two if it ever does open — the registration
  // path is re-run by the next mount or resize, while nothing here re-reads the box until a
  // registration happens.
  if (root) {
    const rw = root.clientWidth || 0;
    const rh = root.clientHeight || 0;
    if (rw > 0) rootW = rw;
    if (rh > 0) rootH = rh;
  }
  recompose();
}

/** The synchronous measurement, used by registration (and, where there is no ResizeObserver, by
 *  everything).
 *
 *  Measures the probes rather than reading the `--ui-sa-*` custom properties directly, for two
 *  reasons: a custom property resolves to the literal token (`"68px"` or, on device, nothing at
 *  all — the var is unset and only the `env()` fallback applies), and only laying it out as a real
 *  length makes the browser resolve the fallback chain. */
function applyMeasurement(el: HTMLElement): void {
  const csTL = getComputedStyle(probeTL!);
  const csBR = getComputedStyle(probeBR!);
  rawTop = edge(csTL.height, csTL, '--ui-sa-top');
  rawLeft = edge(csTL.width, csTL, '--ui-sa-left');
  rawBottom = edge(csBR.height, csBR, '--ui-sa-bottom');
  rawRight = edge(csBR.width, csBR, '--ui-sa-right');
  // `clientWidth`/`clientHeight` are the LAYOUT box — pre-transform, so this is the logical
  // device size in an editor device preview and the viewport on hardware. Same space as the px
  // insets above, which is the whole point (see the doc on the *Pct fields). `getBoundingClientRect`
  // would be POST-transform and is the trap that doc describes — measured under `scale(0.5)`:
  // computed height 68px, bounding rect 34.
  // ⚠️ **A root with NO LAYOUT BOX must never become the denominator, and REGISTRATION is the one
  // path with no rendered-ness discriminator at all.** `getSafeAreaInsets` screens on `isConnected`
  // and `onProbeResize` on `getClientRects()`; this path screens on neither, because it does not
  // need to in order to read the raw insets — and that is exactly what makes it dangerous.
  //
  // How it is reached: the editor mounts a `UIRenderer` per viewport, and `flexlayout-react`
  // maximises a panel by setting `display: none` on every OTHER tabset container, and on the tabs
  // of every non-maximised tabset (read in `flexlayout-react@0.8.19`'s `dist/index.js`: the two
  // writes are both guarded on `getMaximizedTabset(...) !== undefined && !isMaximized()`. Cited by
  // behaviour, not by line — a bundled dist renumbers on every bump). A `display: none` subtree is
  // CONNECTED but NOT RENDERED, so:
  //   - `isConnected` is true, so the refusal in `measureSafeAreaInsets` passes it through;
  //   - `getComputedStyle(probe).height` still answers the correct length under `display: none`
  //     (measured, and the reason `onProbeResize` discriminates on `getClientRects` instead — see
  //     `makeProbe`), so `rawTop`/`rawBottom`/… above are measured PERFECTLY;
  //   - but `clientWidth`/`clientHeight` on a non-rendered element are 0.
  // So the raw insets survive and only the denominator is gone. `recompose`'s `total > 0 ? … : 0`
  // then rewrites all four `*Pct` to a confident zero, and the percentages are the ONLY fields
  // `patchAnchorPct` and every one of Court's six call sites read.
  //
  // Measured 2026-09-04: wordweave's ad banner silently lost its home-indicator lift the moment the
  // Game panel was maximised — `AdBannerSlot.UIAnchor.bottom` written as 0 while `--ui-sa-bottom`
  // was 34px and `HUD Root`'s own CSS padding still read it correctly. The CSS arm is immune
  // because it is a `var()` with no arithmetic; only the JS arm divides. The fix restored the lift —
  // `AdBannerSlot` bottom moved 966.75 -> 931.39. ⚠️ Those are DEVICE px, read off the scaled
  // preview, so the 35.36 delta is post-transform and must NOT be equated with the 34px logical
  // inset (the trap the `*Pct` doc above exists to warn about). What it establishes is that the
  // lift came back, not its exact magnitude.
  //
  // Keeping the last good box is this module's own rule for a root it cannot measure ("a device's
  // insets do not change because some UI unmounted"). Per-axis, because a root can legitimately
  // lose one dimension and keep the other.
  //
  // ⚠️ **The retained box is NOT necessarily this root's** — `rootW`/`rootH` are module state and
  // survive `releaseRoot()`, so a second root registering with no box divides ITS raw insets by the
  // PREVIOUS root's dimensions. That is deliberate and it is the case that actually fires: the
  // editor's two viewports alternate registration, so the poisoned call CAN be a root change —
  // whether it is depends on which viewport registered last, which this file's `probeTL` doc already
  // says is not deterministic. "Sometimes reintroduces the confident zero" is disqualifying on its
  // own, so clearing the box on a root change is out either way. It is sound here because
  // both viewports publish the same `safeAreaCssVars(gameViewSafeArea)` and are normally sized
  // alike — and because a foreign-but-plausible denominator degrades far better than a zero, which
  // does not read wrong so much as MOVE things (Court's `syncMenuIconBar` is change-gated, so it
  // moves the bar and moves it back). The two can diverge for a frame under the `Free` preset;
  // accept that rather than trade it for a guaranteed-wrong 0.
  const w = el.clientWidth || 0;
  const h = el.clientHeight || 0;
  if (w > 0) rootW = w;
  if (h > 0) rootH = h;
  recompose();
}

/** One edge: the simulated var if one is set, else the resolved length, else 0.
 *
 *  **The var is checked FIRST, and the order is load-bearing.** Both sources give the same answer
 *  wherever both exist — the length IS `max(0px, var(--ui-sa-*, env(...)))`, so a set var resolves
 *  through it — and the length alone would look sufficient. It is not, because jsdom does no
 *  layout: measured, `cs.height` there is the raw token
 *  `"max(0px, var(--ui-sa-top, env(safe-area-inset-top, 0px)))"`, never a px value. Without the
 *  var branch every editor-simulated inset would read 0 under test while the live path was fine.
 *
 *  ⚠️ The hazard MOVED with the probe shape and the note here used to describe the old one. The
 *  padding probe's failure was jsdom reporting a perfectly PARSEABLE `"0"`, which a length-first
 *  order would have consumed silently; a sized probe's token `parseFloat`s to `NaN` instead, so
 *  the fallback that actually catches it now is this function's own trailing `else 0` — a
 *  louder, less treacherous failure, but a different one. Do not reason about this ordering from
 *  the old note.
 *
 *  The length branch is the LIVE one on device: a shipped build sets no var, so the lookup misses
 *  and `env(safe-area-inset-*)` resolves through the size — measured on a Galaxy A23 at top 32 /
 *  bottom 48 with the system bars SHOWN, and top 28 / bottom 0 with them hidden (28 being the
 *  physical cutout, which the status bar covers and exceeds). Neither branch is dead code. */
function edge(length: string, cs: CSSStyleDeclaration, varName: string): number {
  const simulated = parseFloat(cs.getPropertyValue(varName));
  if (Number.isFinite(simulated)) return Math.max(0, simulated);
  const resolved = parseFloat(length);
  return Number.isFinite(resolved) ? Math.max(0, resolved) : 0;
}

/** Rebuild the public value from the raw edges and the last known root box. */
function recompose(): void {
  const pct = (v: number, total: number) => (total > 0 ? (v / total) * 100 : 0);
  insets = {
    top: rawTop, right: rawRight, bottom: rawBottom, left: rawLeft,
    topPct: pct(rawTop, rootH),
    rightPct: pct(rawRight, rootW),
    bottomPct: pct(rawBottom, rootH),
    leftPct: pct(rawLeft, rootW),
  };
}

/** Drop the observer and the probes, leaving `insets` alone — a detached or replaced root does
 *  not mean the device's insets changed.
 *
 *  ⚠️ **Reachable only from a READ or an explicit reset, so an unmount alone does not release.**
 *  `UIRenderer`'s callback ref returns early on unmount without calling in here, so a game whose
 *  UI goes away and whose last `getSafeAreaInsets()` predates that unmount retains `root`, both
 *  probe nodes and a LIVE `ResizeObserver` on a detached subtree until something reads again or a
 *  new root registers. The old design retained the `root` reference the same way but no nodes and
 *  no observer, so this is a small step backwards, taken knowingly: every consumer that exists
 *  reads every frame (Court, at six sites), the retained set is two divs, and the alternative is
 *  a release entry point on the module's surface that `UIRenderer` must remember to call — a
 *  second thing to keep in sync for a leak nothing has hit. Revisit if a consumer appears that
 *  reads only occasionally. */
function releaseRoot(): void {
  ro?.disconnect();
  ro = null;
  probeTL?.remove();
  probeBR?.remove();
  probeTL = null;
  probeBR = null;
  root = null;
}

/** Reset to zeros — for teardown, and for tests that must not inherit another test's
 *  measurement (the cache is module state, and test files share a module registry). */
export function resetSafeAreaInsets(): void {
  releaseRoot();
  insets = { ...ZERO };
  rawTop = rawRight = rawBottom = rawLeft = 0;
  rootW = rootH = 0;
}

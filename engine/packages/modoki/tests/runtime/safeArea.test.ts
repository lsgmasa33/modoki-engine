/** getSafeAreaInsets — the measured safe-area insets game LAYOUT ARITHMETIC reads (#273).
 *
 *  The load-bearing property is WHERE it measures: inside the UI root's cascade, so an
 *  editor device preview's simulated `--ui-sa-*` reaches it. A probe on document.body
 *  would read a confident, wrong 0 in every preview — that is the bug this file exists to
 *  make impossible, and the reason the happy-path test alone would not be enough.
 *
 *  ⚠️ **jsdom does not substitute `var()` into a property, does no layout, and implements no
 *  `ResizeObserver`** — so these tests exercise the module's var-reading branch and a FAKE
 *  observer, never the live path a real browser resolves. That is a real limit, not a
 *  formality: the two things that actually decide whether this design works (does an inset
 *  change resize a probe, and does an observer on it fire) are both invisible here. They are
 *  covered by MEASUREMENT instead, and that measurement is the evidence of record:
 *
 *   - **Galaxy A23 5G / Android 13, Court in its real WebView, real `env()`** — the device and
 *     the case #273 was found on. Driving the system bars via the `SystemBars` plugin:
 *     `show()` moved top 28→32 and bottom 0→48, `hide()` moved them back, and a
 *     background→resume did it again. The observer on the SIZED probes fired within ~105ms
 *     every time with the correct values; `window.innerWidth/innerHeight` never changed and
 *     ZERO `resize` events fired, which is the `setDecorFitsSystemWindows(false)` case in one
 *     line — the window keeps its size and only the insets move.
 *   - **The old padding-shaped probe, observed alongside it, fired exactly ONCE across that
 *     whole session** — its initial observation — and never on a change. See the shape guard
 *     below; that is the trap this design is one edit away from at all times.
 *   - Chromium and Apple WebKit headless, both the `--ui-sa-*` path and (via CDP
 *     `Emulation.setSafeAreaInsetsOverride`) the real `env()` path: same result in both.
 *
 *  What these tests can and do pin is everything around it — inheritance from an ancestor (the
 *  property the whole design turns on), the zero defaults, the probe SHAPE that makes the push
 *  signal possible at all, the guards against a probe reporting a confident wrong zero, and the
 *  probes' lifecycle in the DOM. */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getSafeAreaInsets, measureSafeAreaInsets, resetSafeAreaInsets } from '../../src/runtime/ui/safeArea';

let root: HTMLElement;

/** Every probe this module has appended, in creation order, across the current test. */
const probesIn = (el: HTMLElement): HTMLElement[] =>
  [...el.querySelectorAll<HTMLElement>('[data-modoki-safe-area-probe]')];

// ── A controllable ResizeObserver ────────────────────────────────────────────────────────────
//
// jsdom implements none, so without this the push path — the entire point of the module — is
// exercised by nothing and every test here would still read green. The fake records what the
// module observes and lets a test deliver an observation by hand.
//
// `getClientRects` is stubbed per-target because jsdom does no layout and answers an EMPTY list
// for every element, rendered or not. The module uses that list length to tell a real inset of
// zero (one rect) from a probe whose subtree is `display:none` (no rects) — see `deliver`.
interface FakeEntry { target: Element; contentRect: { width: number; height: number } }
let observed: Element[] = [];
let fakeInstances: FakeRO[] = [];
class FakeRO {
  cb: (entries: FakeEntry[]) => void;
  targets: Element[] = [];
  disconnected = false;
  constructor(cb: (entries: FakeEntry[]) => void) { this.cb = cb; fakeInstances.push(this); }
  observe(t: Element) { this.targets.push(t); observed.push(t); }
  unobserve(t: Element) { this.targets = this.targets.filter((x) => x !== t); }
  disconnect() { this.disconnected = true; this.targets = []; }
}

/** Deliver an observation for `target`, as the browser would after an inset changed.
 *
 *  `rendered` is the discriminator the module actually reads: a rendered element (even a 0×0 one
 *  — a phone with no notch) has one client rect, a `display:none` subtree has none. Defaults to
 *  rendered, so a test has to OPT IN to the hidden case rather than fall into it. */
const deliver = (target: Element, size: { width: number; height: number }, rendered = true): void => {
  (target as unknown as { getClientRects: () => { length: number } }).getClientRects =
    () => ({ length: rendered ? 1 : 0 });
  for (const ro of fakeInstances) {
    if (!ro.disconnected && ro.targets.includes(target)) {
      ro.cb([{ target, contentRect: { width: size.width, height: size.height } }]);
    }
  }
};

beforeEach(() => {
  observed = [];
  fakeInstances = [];
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeRO;
  resetSafeAreaInsets();
  root = document.createElement('div');
  document.body.appendChild(root);
});
afterEach(() => {
  root.remove();
  resetSafeAreaInsets();
  delete (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver;
});

describe('getSafeAreaInsets', () => {
  it('is zeros before anything has measured — a game with no UI layer, or a headless test', () => {
    expect(getSafeAreaInsets()).toMatchObject({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  it('reads the --ui-sa-* vars set on the UI root (the editor device-preview path)', () => {
    root.style.setProperty('--ui-sa-top', '68px');
    root.style.setProperty('--ui-sa-bottom', '34px');
    root.style.setProperty('--ui-sa-left', '7px');
    root.style.setProperty('--ui-sa-right', '13px');
    measureSafeAreaInsets(root);
    // The measured iPhone Air quartet, with asymmetric sides so a swapped edge fails.
    expect(getSafeAreaInsets()).toMatchObject({ top: 68, right: 13, bottom: 34, left: 7 });
  });

  it('inherits vars set on an ANCESTOR — the editor sets them on the preview frame, not the UI root', () => {
    const frame = document.createElement('div');
    frame.style.setProperty('--ui-sa-top', '44px');
    document.body.appendChild(frame);
    const inner = document.createElement('div');
    frame.appendChild(inner);
    measureSafeAreaInsets(inner);
    expect(getSafeAreaInsets().top).toBe(44);
    frame.remove();
  });

  it('falls back to zero when the var is unset and env() resolves to nothing (desktop / jsdom)', () => {
    measureSafeAreaInsets(root);
    expect(getSafeAreaInsets()).toMatchObject({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  // The percentages are the field games should actually use, and they exist because the px
  // alone invite a wrong denominator: a game dividing by its own `getBoundingClientRect`
  // height mixes a PRE-transform inset with a POST-transform box, which is exactly how
  // Court's banner lifted 6.09% where 3.73% was right — correct on the phone, wrong in the
  // editor preview. These are measured against the root's layout box in the same pass.
  it('reports each inset as a percentage of the ROOT box, measured in the same pass', () => {
    Object.defineProperty(root, 'clientHeight', { value: 912, configurable: true });
    Object.defineProperty(root, 'clientWidth', { value: 420, configurable: true });
    root.style.setProperty('--ui-sa-top', '68px');
    root.style.setProperty('--ui-sa-bottom', '34px');
    root.style.setProperty('--ui-sa-left', '21px');
    measureSafeAreaInsets(root);
    const i = getSafeAreaInsets();
    expect(i.topPct).toBeCloseTo((68 / 912) * 100, 9);
    expect(i.bottomPct).toBeCloseTo((34 / 912) * 100, 9);
    expect(i.leftPct).toBeCloseTo((21 / 420) * 100, 9);   // horizontal is a share of WIDTH
  });

  it('percentages are zero rather than Infinity when the root has no box yet', () => {
    root.style.setProperty('--ui-sa-top', '68px');
    measureSafeAreaInsets(root);
    expect(getSafeAreaInsets().top).toBe(68);
    expect(getSafeAreaInsets().topPct).toBe(0);
  });

  it('a null root yields zeros rather than throwing — the UI layer may not be mounted', () => {
    root.style.setProperty('--ui-sa-top', '68px');
    measureSafeAreaInsets(root);
    expect(getSafeAreaInsets().top).toBe(68);
    measureSafeAreaInsets(null);
    expect(getSafeAreaInsets()).toMatchObject({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  /**
   * The teardown half of the retained denominator. `rootW`/`rootH` deliberately SURVIVE a root
   * change (see the two-root test below — that retention is what stops a collapsed panel producing
   * a confident zero), so the only thing stopping a stale box outliving the module's whole state is
   * the explicit reset in the `!el` branch and in `resetSafeAreaInsets`.
   *
   * ⚠️ Pinned because a mutant deleting that reset survived the entire suite: the neighbouring null
   * test registers a root that never had a box, so the denominator is 0 with or without it. Only a
   * REAL box, torn down, then a fresh boxless root can tell the two apart. A later "apply the `> 0`
   * rule everywhere" sweep would otherwise remove this silently and green.
   */
  it('tearing down with a null root CLEARS the retained denominator — it does not outlive the module', () => {
    Object.defineProperty(root, 'clientHeight', { value: 874, configurable: true });
    root.style.setProperty('--ui-sa-top', '68px');
    measureSafeAreaInsets(root);
    expect(getSafeAreaInsets().topPct).toBeCloseTo((68 / 874) * 100, 9);

    measureSafeAreaInsets(null);

    // A fresh root that never had a box must read "cannot compute" (0), NOT the old root's 874.
    const later = document.createElement('div');
    later.style.setProperty('--ui-sa-top', '44px');
    document.body.appendChild(later);
    measureSafeAreaInsets(later);
    expect(getSafeAreaInsets().top, 'the px inset still measures').toBe(44);
    expect(getSafeAreaInsets().topPct, 'but against no denominator, not against the torn-down one')
      .toBe(0);
    later.remove();
  });

  it('re-measures rather than caching a stale value when the preset changes', () => {
    root.style.setProperty('--ui-sa-top', '68px');
    measureSafeAreaInsets(root);
    expect(getSafeAreaInsets().top).toBe(68);
    root.style.setProperty('--ui-sa-top', '0px');   // e.g. switching to a device with no notch
    measureSafeAreaInsets(root);
    expect(getSafeAreaInsets().top).toBe(0);
  });

  // ── The probe SHAPE — the one thing that makes the push signal exist ────────────────────────

  /**
   * ⚠️ **This is the most important test in the file, and it guards a trap that fails SILENTLY.**
   *
   * `ResizeObserver` reports the CONTENT box by default. Until #612 this module's probe was
   * deliberately `width:0; height:0` with the inset in its PADDING — a shape that kept it out of
   * flow and clamped negatives to 0 for free, and whose content box is 0×0 before and after an
   * inset change, forever. Bolting an observer onto that shape is the OBVIOUS implementation, it
   * never fires, and nothing errors: measured on a Galaxy A23 across three real inset transitions,
   * the padding-shaped probe's observer fired exactly once (its initial observation) while the
   * sized probes fired every time.
   *
   * So the inset must be the probe's SIZE. A future edit that "tidies" it back into padding — or
   * into any property that does not change the content box — would pass every other test here,
   * pass review, ship, and reproduce #273 on device with the value simply never updating.
   *
   * (The legitimate alternative is `observe(el, {box:'border-box'})` reading `borderBoxSize`,
   * never `contentRect`. If anyone takes that route this test should be rewritten to match it,
   * not deleted.)
   */
  it('sizes the probes BY the inset — an inset in padding would never fire a ResizeObserver', () => {
    measureSafeAreaInsets(root);
    const probes = probesIn(root);
    expect(probes, 'two probes: one carries top+left, the other bottom+right').toHaveLength(2);
    for (const p of probes) {
      const css = p.getAttribute('style') ?? '';
      expect(css, 'the inset must drive WIDTH').toMatch(/width:\s*max\(0px,\s*var\(--ui-sa-(left|right)/);
      expect(css, 'the inset must drive HEIGHT').toMatch(/height:\s*max\(0px,\s*var\(--ui-sa-(top|bottom)/);
      expect(css, 'an inset in padding is invisible to a content-box observer').not.toMatch(/padding[^;]*--ui-sa-/);
      expect(css, 'content-box, so contentRect is the inset even under a global border-box reset')
        .toMatch(/box-sizing:\s*content-box/);
      // These are permanent children of a container other systems walk. Every DOM→entity mapper
      // here is keyed on `data-entity-id`/`data-ui-id` and hit testing skips hidden subtrees, so
      // nothing can currently see them — these three keep it that way explicitly.
      expect(css, 'never a hit-test target').toMatch(/pointer-events:\s*none/);
      expect(css, 'out of flow, so it cannot perturb the layout it measures').toMatch(/position:\s*fixed/);
      expect(p.getAttribute('aria-hidden'), 'never surfaced to a11y or a role-based locator').toBe('true');
    }
    // All four edges are covered exactly once between the two probes.
    const all = probes.map((p) => p.getAttribute('style')).join(';');
    for (const edge of ['top', 'right', 'bottom', 'left']) {
      expect(all.match(new RegExp(`--ui-sa-${edge}\\b`, 'g')) ?? [], `--ui-sa-${edge} appears once`).toHaveLength(1);
    }
  });

  /**
   * The two degradation guards, both measured in Chromium AND WebKit.
   *
   * A sized probe is more dangerous than the padding one it replaced in exactly one way: `padding`
   * clamps a negative to 0 and can never be `auto`, but `height` can be both.
   *
   *  - `env(<name>, 0px)` — an `env()` name the engine does not know makes the whole declaration
   *    INVALID, so height falls back to `auto` and the probe reports its own content height as the
   *    inset. Measured at 18px in both engines with a probe that had text in it. `max()` does not
   *    save this; the inner `0px` fallback does, and was measured to give 0 in both.
   *  - `max(0px, …)` — a `--ui-sa-*` var carrying a negative would otherwise make the declaration
   *    invalid the same way.
   *
   * Deliberately NOT aligned with `anchorCss.ts`'s `var(--ui-sa-<edge>, env(safe-area-inset-<edge>))`,
   * which needs no inner fallback: there the expression sits inside `max(<padding>, …)` on a
   * `padding` property, where an invalid value merely drops the declaration and yields no padding.
   */
  it('guards the probe size against resolving to `auto` — the confident-wrong-value failure', () => {
    measureSafeAreaInsets(root);
    for (const p of probesIn(root)) {
      const css = p.getAttribute('style') ?? '';
      expect(css, 'every env() carries an explicit 0px fallback').not.toMatch(/env\(safe-area-inset-[a-z]+\)/);
      expect((css.match(/env\(safe-area-inset-[a-z]+,\s*0px\)/g) ?? []),
        'both edges on this probe fall back to 0px').toHaveLength(2);
      expect(css, 'no content can make an `auto` box non-zero').toMatch(/overflow:\s*hidden/);
      expect(p.textContent, 'a probe with content could report that content as an inset').toBe('');
    }
  });

  // ── The push path ───────────────────────────────────────────────────────────────────────────

  it('observes both probes, so an inset change has something to fire', () => {
    measureSafeAreaInsets(root);
    expect(observed).toHaveLength(2);
    expect(new Set(observed)).toEqual(new Set(probesIn(root)));
  });

  /**
   * The #273 property, now delivered by push rather than by polling: the value updates with NO
   * re-registration, no resize, and nothing calling into this module at all. On device this is
   * the Android bar-hide — measured at bottom 0→48 with zero `resize` events.
   */
  it('updates from an observation alone — no re-registration, no read-triggered re-measure', () => {
    Object.defineProperty(root, 'clientHeight', { value: 800, configurable: true });
    Object.defineProperty(root, 'clientWidth', { value: 400, configurable: true });
    measureSafeAreaInsets(root);
    expect(getSafeAreaInsets().bottom).toBe(0);

    const [, br] = probesIn(root);              // the bottom+right probe
    deliver(br, { width: 0, height: 48 });      // the nav bar appears, as measured on the A23

    expect(getSafeAreaInsets().bottom, 'the observation alone must update the value').toBe(48);
    expect(getSafeAreaInsets().bottomPct, 'and the percentage recomputes with it')
      .toBeCloseTo((48 / 800) * 100, 9);
  });

  it('an observation for one probe leaves the other edge alone', () => {
    root.style.setProperty('--ui-sa-top', '68px');
    measureSafeAreaInsets(root);
    const [, br] = probesIn(root);
    deliver(br, { width: 0, height: 34 });
    expect(getSafeAreaInsets()).toMatchObject({ top: 68, bottom: 34 });
  });

  /**
   * ⚠️ **A rotation moves the root box AND the insets, and the observation arrives FIRST** — so a
   * percentage computed against the box cached at registration is wrong for a frame.
   *
   * `safeArea.ts` constructs its observer inside `UIRenderer`'s `update()`, before `UIRenderer`
   * constructs its own, so it is delivered first in the same cycle; and `UIRenderer` rAF-defers
   * the re-registration that would refresh the cached box. Numbers here are the measured ones:
   * 384x832 → 832x384 with a bottom inset of 48 gives 5.769% against the stale height where 12.5%
   * is correct — 2.17x wrong. It self-corrects a frame later, but Court reads these percentages
   * every frame at six sites, so the banner, board and narration band all pop for that frame.
   */
  it('recomputes percentages against the CURRENT root box, not the one cached at registration', () => {
    Object.defineProperty(root, 'clientWidth', { value: 384, configurable: true });
    Object.defineProperty(root, 'clientHeight', { value: 832, configurable: true });
    measureSafeAreaInsets(root);

    // The rotation lands: the root box flips, but nothing has re-registered yet.
    Object.defineProperty(root, 'clientWidth', { value: 832, configurable: true });
    Object.defineProperty(root, 'clientHeight', { value: 384, configurable: true });

    const [, br] = probesIn(root);
    deliver(br, { width: 0, height: 48 });

    expect(getSafeAreaInsets().bottomPct, 'against the CURRENT height (384), not the cached 832')
      .toBeCloseTo(12.5, 9);
  });

  /**
   * Each probe writes its OWN two edges, and every value here is distinct so any transposition
   * fails — height↔width (a probe's vertical inset read as its horizontal one) as well as
   * probe↔probe (top written as bottom).
   *
   * ⚠️ Added because mutation testing found the gap: swapping the edges the top+left probe writes
   * passed the entire rest of this suite, because no other push test delivers an observation to
   * that probe at all. A test that only ever exercises one of two symmetric branches cannot see a
   * defect in the other, and reads exactly as green as one that can.
   */
  it('each probe writes its own two edges — no transposition', () => {
    Object.defineProperty(root, 'clientHeight', { value: 1000, configurable: true });
    Object.defineProperty(root, 'clientWidth', { value: 500, configurable: true });
    measureSafeAreaInsets(root);
    const [tl, br] = probesIn(root);

    deliver(tl, { width: 7, height: 68 });      // left 7, top 68
    deliver(br, { width: 13, height: 34 });     // right 13, bottom 34

    expect(getSafeAreaInsets()).toMatchObject({ top: 68, left: 7, bottom: 34, right: 13 });
    const i = getSafeAreaInsets();
    expect(i.topPct, 'vertical insets are a share of HEIGHT').toBeCloseTo(6.8, 9);
    expect(i.leftPct, 'horizontal insets are a share of WIDTH').toBeCloseTo(1.4, 9);
  });

  /**
   * ⚠️ A probe whose subtree is `display:none` fires a 0×0 observation, and neither obvious guard
   * catches it: `isConnected` stays TRUE and `getComputedStyle().height` still reports the correct
   * value — both measured, in Chromium and WebKit. Writing those zeros through would rewrite every
   * inset with no device change, which is the same confident-zero failure the detached-root branch
   * exists to stop, arriving by the other door.
   *
   * The discriminator is `getClientRects().length`, and it is the right one because of what it does
   * NOT reject: a real zero-inset device (a phone with no notch — the COMMON case) still has one
   * rect, and so does a root with no box yet, which `UIRenderer` measures for on purpose.
   */
  it('ignores a 0x0 observation from a probe that is not being rendered', () => {
    Object.defineProperty(root, 'clientHeight', { value: 800, configurable: true });
    root.style.setProperty('--ui-sa-bottom', '34px');
    measureSafeAreaInsets(root);
    expect(getSafeAreaInsets().bottom).toBe(34);
    expect(getSafeAreaInsets().bottomPct).toBeCloseTo((34 / 800) * 100, 9);

    const [, br] = probesIn(root);
    // `display:none` on an ancestor takes the ROOT's box away as well as the probes' — modelling
    // only the probes would make this test pass against the defect below.
    Object.defineProperty(root, 'clientHeight', { value: 0, configurable: true });
    deliver(br, { width: 0, height: 0 }, /* rendered */ false);

    expect(getSafeAreaInsets().bottom, 'a hidden probe must not zero a live inset').toBe(34);
    // ⚠️ And the PERCENTAGE too — the half a first version of this guard missed. Skipping the raw
    // edges is only half of it: the root read that keeps the denominator fresh sat OUTSIDE the
    // same guard, so a hidden subtree put 0 into it and every *Pct collapsed while the px insets
    // correctly survived. Court reads ONLY the percentages, so that was the worse half to lose.
    expect(getSafeAreaInsets().bottomPct, 'nor the percentage — the only field Court reads')
      .toBeCloseTo((34 / 800) * 100, 9);

    // ...and the SAME zeros from a RENDERED probe are a real device change, and must land. Without
    // this half the guard could be "ignore every zero", which would break every notchless phone.
    Object.defineProperty(root, 'clientHeight', { value: 800, configurable: true });
    deliver(br, { width: 0, height: 0 }, /* rendered */ true);
    expect(getSafeAreaInsets().bottom, 'a real zero inset must still be honoured').toBe(0);
    expect(getSafeAreaInsets().bottomPct).toBe(0);
  });

  /**
   * The THIRD door into the same confident-zero failure, and the one neither guard above covers:
   * the REGISTRATION path with a root that is connected and rendered but has NO LAYOUT BOX.
   *
   * `getSafeAreaInsets` discriminates on `isConnected`; `onProbeResize` discriminates on
   * `getClientRects()`. Registration screens on NEITHER — it does not have to in order to read the
   * raw insets, and that is what makes it the unguarded door.
   *
   * Found live, not by a test: the editor mounts a `UIRenderer` per viewport, and `flexlayout-react`
   * maximises a panel by setting `display: none` on every other tabset container, and on the tabs
   * of every non-maximised tabset (read in 0.8.19's `dist/index.js`; both writes are guarded on
   * `getMaximizedTabset(...) !== undefined && !isMaximized()`). Such a subtree is connected but NOT
   * rendered, so
   * `isConnected` passes it through, `getComputedStyle(probe).height` still answers the correct
   * length (measured — the very reason `onProbeResize` uses `getClientRects` instead), and only
   * `clientWidth`/`clientHeight` are gone. `recompose`'s `total > 0 ? … : 0` then rewrites all four
   * `*Pct` to zero, and the percentages are the ONLY fields `patchAnchorPct` and Court's six call
   * sites read. Wordweave's ad banner silently lost its home-indicator lift the moment the Game
   * panel was maximised — written as `bottom: 0` while `--ui-sa-bottom` was still `34px` and the
   * CSS padding arm (a `var()`, no arithmetic) stayed correct on both roots.
   *
   * ⚠️ Asserts BOTH axes on purpose. Every assertion here was a bottom edge once, which depends
   * only on `rootH` — so deleting the width half of the guard left this test green, and the
   * per-axis design the fix's comment argues for was pinned by nothing.
   */
  it('a collapsed root does not become the denominator — registering a 0x0 root keeps the last '
    + 'good percentages', () => {
    Object.defineProperty(root, 'clientHeight', { value: 874, configurable: true });
    Object.defineProperty(root, 'clientWidth', { value: 402, configurable: true });
    root.style.setProperty('--ui-sa-bottom', '34px');
    root.style.setProperty('--ui-sa-left', '21px');
    measureSafeAreaInsets(root);
    expect(getSafeAreaInsets().bottomPct).toBeCloseTo((34 / 874) * 100, 9);
    expect(getSafeAreaInsets().leftPct).toBeCloseTo((21 / 402) * 100, 9);

    // The second viewport's panel is `display: none`d. Same node, still connected, computed styles
    // still resolving — it has simply lost its box, and it re-registers on the resize.
    Object.defineProperty(root, 'clientHeight', { value: 0, configurable: true });
    Object.defineProperty(root, 'clientWidth', { value: 0, configurable: true });
    measureSafeAreaInsets(root);

    expect(getSafeAreaInsets().bottom, 'the px inset is measured correctly either way').toBe(34);
    expect(getSafeAreaInsets().bottomPct,
      'and the PERCENTAGE must survive — a root with no box is "cannot compute", not "zero inset"')
      .toBeCloseTo((34 / 874) * 100, 9);
    expect(getSafeAreaInsets().leftPct, 'the WIDTH axis is guarded too, not just the height')
      .toBeCloseTo((21 / 402) * 100, 9);

    // The other half: a root that regains a REAL box must be adopted, or this guard would freeze
    // the denominator forever and every rotation/resize would read against a stale one.
    Object.defineProperty(root, 'clientHeight', { value: 500, configurable: true });
    Object.defineProperty(root, 'clientWidth', { value: 300, configurable: true });
    measureSafeAreaInsets(root);
    expect(getSafeAreaInsets().bottomPct, 'a real box must still replace the denominator')
      .toBeCloseTo((34 / 500) * 100, 9);
    expect(getSafeAreaInsets().leftPct, 'on both axes').toBeCloseTo((21 / 300) * 100, 9);
  });

  /**
   * The FOURTH door, three lines from the third: the OBSERVER's re-read of the root box.
   *
   * That read exists to keep the denominator fresh through a rotation (the observation is delivered
   * a frame before `UIRenderer` re-registers), and it sits behind the `rendered` bail — which is
   * not the same guard. `rendered` rejects a probe in a NON-RENDERED subtree, which is what covers
   * the editor's `display: none` case; it says nothing about a root that IS rendered and merely has
   * a zero box. That geometry is narrow but real: under the `Free` preset GameView's UI root is
   * `position: absolute; inset: 0` over a `flex: 1` area and can be squeezed flat while still
   * rendering (a flexlayout tabset's min is 1px, not 0 — but a 1px tabset holding a 32px toolbar
   * still leaves the area at 0). Under a fixed device preset the root is a `deviceW x deviceH` box
   * and cannot collapse. A scene swap's empty->refill beat is the same shape.
   *
   * ⚠️ Unlike the registration door this one has NOT been driven live — it is pinned for
   * consistency (there are exactly two writers of the denominator, and a reader who finds one
   * guarded and one not will assume the difference is meaningful) rather than as the fix for an
   * observed symptom. It would be the worse of the two if it did open: the registration path is
   * re-run by the next mount or resize, while nothing here re-reads the box until a registration.
   */
  it('a rendered observation against a collapsed root keeps the last good denominator', () => {
    Object.defineProperty(root, 'clientHeight', { value: 874, configurable: true });
    Object.defineProperty(root, 'clientWidth', { value: 402, configurable: true });
    root.style.setProperty('--ui-sa-bottom', '34px');
    root.style.setProperty('--ui-sa-right', '13px');
    measureSafeAreaInsets(root);
    expect(getSafeAreaInsets().bottomPct).toBeCloseTo((34 / 874) * 100, 9);

    const [, br] = probesIn(root);
    // The root keeps rendering and loses its BOX — not the `display:none` case, which the
    // `!rendered` bail already covers. (`position: fixed` would not save a probe from that: a
    // `display:none` ANCESTOR takes the whole subtree out of the box tree whatever the descendant's
    // positioning, which is why this module discriminates on `getClientRects` at all.) Then the
    // inset changes, and that observation is rendered and must be honoured.
    Object.defineProperty(root, 'clientHeight', { value: 0, configurable: true });
    Object.defineProperty(root, 'clientWidth', { value: 0, configurable: true });
    deliver(br, { width: 13, height: 21 }, /* rendered */ true);

    expect(getSafeAreaInsets().bottom, 'the new px inset must land — this is a real change').toBe(21);
    expect(getSafeAreaInsets().bottomPct, 'against the last good height, not against zero')
      .toBeCloseTo((21 / 874) * 100, 9);
    // ⚠️ Both axes, for the reason spelled out on the registration test: asserting only a bottom
    // edge exercises `rootH` alone, and a mutant deleting the WIDTH half of this guard survived the
    // whole suite until this line existed.
    expect(getSafeAreaInsets().rightPct, 'the WIDTH axis of THIS guard too, not just the height')
      .toBeCloseTo((13 / 402) * 100, 9);

    // And a rendered observation against a REAL box must still refresh the denominator, or the
    // rotation case this root read exists for would be broken by its own guard.
    Object.defineProperty(root, 'clientHeight', { value: 402, configurable: true });
    Object.defineProperty(root, 'clientWidth', { value: 874, configurable: true });
    deliver(br, { width: 13, height: 21 }, /* rendered */ true);
    expect(getSafeAreaInsets().bottomPct, 'a rotation must still move the denominator')
      .toBeCloseTo((21 / 402) * 100, 9);
    expect(getSafeAreaInsets().rightPct, 'on both axes').toBeCloseTo((13 / 874) * 100, 9);
  });

  /**
   * The seam the two tests above do not reach: `el !== root`, i.e. a DIFFERENT element registering.
   * The editor's two viewports alternate, so the poisoned registration CAN be a root change
   * (`releaseRoot()`, fresh probes, fresh observer) rather than a re-register of the same node —
   * which it is depends on which viewport registered last, and this file's `probeTL` doc already
   * says that is not deterministic. Half the time is enough: the branch has to be right.
   *
   * ⚠️ It pins a deliberate TRADE-OFF, not a clean invariant. `rootW`/`rootH` are module state and
   * survive `releaseRoot()`, so root B with no box divides ITS insets by root A's dimensions — a
   * foreign denominator. Clearing the box on a root change would put the confident zero straight
   * back for the case the fix exists for whenever the alternation lands that way, and a plausible
   * number degrades far better than a zero, which does not merely read wrong but MOVES things (Court's `syncMenuIconBar` is
   * change-gated, so a transient zero moves the bar and moves it back). The editor's two roots
   * publish the same `safeAreaCssVars` and are normally sized alike, so the divergence window is a
   * frame under the `Free` preset. If this ever needs to be exact, the answer is a per-root box —
   * not clearing.
   */
  it('a SECOND root with no box divides by the first root\'s — deliberate, and better than zero', () => {
    Object.defineProperty(root, 'clientHeight', { value: 874, configurable: true });
    Object.defineProperty(root, 'clientWidth', { value: 402, configurable: true });
    root.style.setProperty('--ui-sa-bottom', '34px');
    measureSafeAreaInsets(root);
    expect(getSafeAreaInsets().bottomPct).toBeCloseTo((34 / 874) * 100, 9);

    // The other viewport's root — a different element, its own inset, and no box.
    const other = document.createElement('div');
    other.style.setProperty('--ui-sa-bottom', '20px');
    Object.defineProperty(other, 'clientHeight', { value: 0, configurable: true });
    Object.defineProperty(other, 'clientWidth', { value: 0, configurable: true });
    document.body.appendChild(other);
    measureSafeAreaInsets(other);

    expect(getSafeAreaInsets().bottom, 'the new root\'s own px inset is measured').toBe(20);
    expect(getSafeAreaInsets().bottomPct, 'against the retained box — NOT a confident zero')
      .toBeCloseTo((20 / 874) * 100, 9);
    other.remove();
  });

  // ── Probe lifecycle ─────────────────────────────────────────────────────────────────────────

  /**
   * The probes are PERSISTENT — the old design created and removed one per measurement, which is
   * why the previous suite asserted the DOM was left untouched. That is no longer the contract:
   * an observer needs something to observe. What must still hold is that they never accumulate.
   */
  it('appends exactly two probes, and re-registering the same root does not add more', () => {
    measureSafeAreaInsets(root);
    expect(probesIn(root)).toHaveLength(2);
    measureSafeAreaInsets(root);
    measureSafeAreaInsets(root);
    expect(probesIn(root), 'a resize re-registers; it must not leak a probe each time').toHaveLength(2);
  });

  it('moves its probes to a new root rather than leaving them on the old one', () => {
    measureSafeAreaInsets(root);
    const fresh = document.createElement('div');
    document.body.appendChild(fresh);
    measureSafeAreaInsets(fresh);
    expect(probesIn(root), 'the old root must be left clean').toHaveLength(0);
    expect(probesIn(fresh)).toHaveLength(2);
    fresh.remove();
  });

  it('resetSafeAreaInsets removes the probes and disconnects the observer', () => {
    measureSafeAreaInsets(root);
    expect(probesIn(root)).toHaveLength(2);
    resetSafeAreaInsets();
    expect(probesIn(root), 'a torn-down session leaves nothing in the DOM').toHaveLength(0);
    expect(fakeInstances.every((ro) => ro.disconnected), 'and nothing still observing').toBe(true);
  });

  /**
   * A stale observation must not be able to write through after teardown — the same class of bug
   * as #579 follow-up's uncancelled rAF, one mechanism later. `disconnect()` is what stops it, and
   * this proves the module actually calls it rather than merely dropping its reference.
   */
  it('an observation arriving after teardown cannot write to the fresh session', () => {
    root.style.setProperty('--ui-sa-bottom', '34px');
    measureSafeAreaInsets(root);
    const [, staleBr] = probesIn(root);
    resetSafeAreaInsets();

    deliver(staleBr, { width: 0, height: 999 });
    expect(getSafeAreaInsets().bottom, 'a disconnected observer must be silent').toBe(0);
  });

  // ── Degrading without a ResizeObserver ──────────────────────────────────────────────────────

  /**
   * `scrollAnchor.ts` and `UINode.tsx` both feature-detect `ResizeObserver` for the same reason.
   * Without one there is no push signal, and registration is the whole mechanism — which is
   * exactly what a headless/jsdom consumer gets. It must still produce a correct value rather
   * than throwing on construction.
   */
  it('still measures on registration where there is no ResizeObserver at all', () => {
    delete (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver;
    root.style.setProperty('--ui-sa-top', '68px');
    expect(() => measureSafeAreaInsets(root)).not.toThrow();
    expect(getSafeAreaInsets().top).toBe(68);
    expect(probesIn(root), 'the probes still exist — only the observation is missing').toHaveLength(2);
  });

  // ── Detached roots ──────────────────────────────────────────────────────────────────────────

  /**
   * A DETACHED root must never be measured (#273 close-out).
   *
   * `UIRenderer`'s callback ref returns early on unmount, so this module is never handed a null —
   * its reference just goes stale. `getComputedStyle` on a removed node answers empty strings and
   * `clientHeight` 0, so measuring it would rewrite every inset to ZERO and the layout would jump
   * with no device change. Reachable in the editor (two viewports mount a UIRenderer; closing the
   * one that registered last detaches this root while the other is still on screen) and in a
   * shipped game (the UI tree empties for a beat across a scene swap).
   */
  /**
   * ⚠️ This targets `measureSafeAreaInsets`, the WRITE path, and that is the whole point of it.
   *
   * An earlier version of this test only read through `getSafeAreaInsets()` — which, once the poll
   * was gone, has no measurement path at all, so it passed with the detached-root guard deleted
   * outright and proved nothing. The real hazard lives on the other side: `UIRenderer`'s observer
   * rAF-defers its `update()`, so a container unmounting in the same frame it mounted could land a
   * registration here with a removed node. (`UIRenderer` now cancels that frame too, so this guard
   * is defence in depth — see its own comment for why it stays.) In a browser `getComputedStyle`
   * on a detached probe answers empty strings, so that call rewrites all four insets to 0 —
   * #273's exact symptom — and in the editor's two-viewport case it also steals the LIVE
   * viewport's probes.
   *
   * ⚠️ **Do not "align" this with that browser symptom by asserting `top === 0`.** jsdom DOES
   * resolve an inherited custom property on a detached node, so the failure this test observes
   * when the guard is removed is "999 lands" rather than "everything zeroes". It catches the
   * mutation either way, and its second assertion — that the live root keeps its probes — is
   * environment-independent. Asserting the browser's symptom here would assert jsdom's absence
   * of layout instead.
   */
  it('refuses to register a DETACHED root — the late-rAF registration must not land', () => {
    root.style.setProperty('--ui-sa-top', '68px');
    measureSafeAreaInsets(root);
    expect(getSafeAreaInsets().top).toBe(68);

    const live = document.createElement('div');
    live.style.setProperty('--ui-sa-top', '44px');
    document.body.appendChild(live);
    measureSafeAreaInsets(live);                 // a newer viewport takes over
    expect(getSafeAreaInsets().top).toBe(44);

    root.remove();                               // the old viewport's container goes away...
    root.style.setProperty('--ui-sa-top', '999px');
    measureSafeAreaInsets(root);                 // ...and its queued frame fires anyway

    expect(getSafeAreaInsets().top, 'a detached registration must not overwrite the live value').toBe(44);
    expect(probesIn(live), 'and must not steal the live root\'s probes').toHaveLength(2);
    live.remove();
  });

  it('does NOT re-measure a detached root on read — the value must stop tracking it', () => {
    root.style.setProperty('--ui-sa-top', '68px');
    measureSafeAreaInsets(root);
    expect(getSafeAreaInsets().top).toBe(68);

    root.remove();                              // the viewport that registered it goes away
    // Change what the detached node WOULD report. If anything still measures it, the cached value
    // follows; if it correctly skips, the value stands.
    root.style.setProperty('--ui-sa-top', '999px');
    expect(getSafeAreaInsets().top, 'a detached root must not be re-measured').toBe(68);
  });

  it('releases a detached root, so its whole subtree is not retained', () => {
    measureSafeAreaInsets(root);
    root.remove();

    let isConnectedChecked = false;
    Object.defineProperty(root, 'isConnected', {
      configurable: true,
      get() { isConnectedChecked = true; return false; },
    });
    getSafeAreaInsets();
    expect(isConnectedChecked, 'the read checks whether its root is still attached').toBe(true);
    expect(fakeInstances.every((ro) => ro.disconnected), 'and stops observing probes it dropped').toBe(true);
  });

  it('picks up a NEW root after the old one detached', () => {
    root.style.setProperty('--ui-sa-top', '68px');
    measureSafeAreaInsets(root);
    root.remove();
    expect(getSafeAreaInsets().top).toBe(68);   // stale ref dropped here

    const fresh = document.createElement('div');
    fresh.style.setProperty('--ui-sa-top', '44px');
    document.body.appendChild(fresh);
    measureSafeAreaInsets(fresh);
    expect(getSafeAreaInsets().top).toBe(44);
    fresh.remove();
  });
});

/** UI (DOM) text animation — the whole-element CSS realization of the shared
 *  {@link TextAnimation} trait for the React/DOM UI layer. The 2D/3D layers animate
 *  per-glyph geometry; DOM text can't (it's a single styled string), so the same
 *  effect vocabulary maps to a CSS `@keyframes animation` on the text, run by the
 *  browser compositor (no per-frame ECS/React work).
 *
 *  Effects are realized as whole-element motion/colour (the block moves/tints as one;
 *  true per-character DOM animation would need span-splitting — a later tier):
 *    fade → fade-in (loop ⇒ pulse)   wave → gentle float   bounce → bounce
 *    jitter → shake   rainbow → colour cycle   typewriter → left-to-right clip wipe
 *
 *  Amplitude (em) drives translate distance via a `--ui-amp` custom
 *  property so the keyframes stay static (injected once). `frequency` is unused here
 *  (no per-glyph phase). Pure except {@link ensureUITextAnimStyles} (DOM injection).
 */

export interface UITextAnimParams {
  effect: string;
  speed: number;
  amplitude: number;
  frequency: number;
  loop: boolean;
  /** Typewriter: fade each glyph in (default) vs pop it instantly. Undefined = true. */
  fadeIn?: boolean;
}

interface EffectDef {
  kf: string;
  timing: string;
  periodic: boolean; // always loops (wave/bounce/jitter/rainbow); else one-shot (fade)
  amp: boolean;      // uses the --ui-amp translate distance
  gradient?: boolean; // rainbow: a background-clip:text gradient (animating a `color`
                      // keyframe on inherited text doesn't take reliably)
  perChar?: boolean;  // typewriter: reveal one GLYPH at a time (per-character span split),
                      // not a whole-element clip — see uiTextAnimation()/UINode AnimatedText.
}

const EFFECTS: Record<string, EffectDef> = {
  fade: { kf: 'mdk-ui-fade', timing: 'ease-out', periodic: false, amp: false },
  typewriter: { kf: 'mdk-ui-type-in', timing: 'linear', periodic: false, amp: false, perChar: true },
  wave: { kf: 'mdk-ui-float', timing: 'ease-in-out', periodic: true, amp: true },
  bounce: { kf: 'mdk-ui-bounce', timing: 'cubic-bezier(.28,.84,.42,1)', periodic: true, amp: true },
  jitter: { kf: 'mdk-ui-shake', timing: 'linear', periodic: true, amp: true },
  rainbow: { kf: 'mdk-ui-rainbow', timing: 'linear', periodic: true, amp: false, gradient: true },
};

/** Extra span styles a rainbow effect needs (a horizontally-scrolling gradient clipped
 *  to the text). Keeps the effect self-contained; other effects add nothing. */
const RAINBOW_STYLE: Record<string, string> = {
  // ⚠️ `width: fit-content` is what makes the effect an effect (#657). The gradient's
  // positioning area is the SPAN'S BOX, not the glyphs — and the span is `display: block`
  // (#646), so it fills its container and short text sees only a slice of the spectrum.
  // Measured on "SCORE" in a 600px host at 42px: ink/box was 0.249 — roughly red→orange, a
  // quarter of the rainbow — in the ordinary flex case, and #646 made the two non-flex
  // contexts (`-webkit-box` under maxLines, and AutoFitText's span) match it at 0.249 where
  // they had been 1.000. `fit-content` restores 1.000 in ALL THREE and keeps the line clamp
  // working. Rainbow text is overwhelmingly short labels, scores and counters, so the short
  // case is the reachable one, not an edge.
  //
  // The trade the owner accepted: a fit-content block HUGS its text instead of filling the box.
  // ⚠️ An earlier version of this comment said centring was "now the parent's job
  // (`justifyContent`/`textAlign`)". Half wrong, and measured: `justifyContent` on a flex parent
  // does still centre it, but `textAlign` does NOT — a shrink-wrapped block has no inline content
  // left to align. That is what `shrinkWrapAlign` below exists to carry across.
  width: 'fit-content',
  backgroundImage: 'linear-gradient(90deg,#ff4d4d,#ffdb4d,#4dff65,#4dffff,#4d65ff,#ff4dff,#ff4d4d)',
  backgroundSize: '200% auto',
  backgroundClip: 'text',
  WebkitBackgroundClip: 'text',
  color: 'transparent',
  WebkitTextFillColor: 'transparent',
};

export interface UITextAnimStyle {
  /** The CSS `animation` shorthand for the text element. Empty for per-char effects
   *  (typewriter), which build a per-glyph animation in the renderer instead. */
  animation: string;
  /** translate distance in **em** for `--ui-amp` (0 for non-motion effects).
   *
   *  ⚠️ Was `ampPx`, computed as `amplitude * fontSize` (#245). That resolution step assumed
   *  `UIElement.fontSize` was pixels — true until `fontSizeUnit` existed, and silently wrong
   *  after, since the number could then be vmin. `em` resolves against the element's own computed
   *  font size, so it is the SAME value for a px-authored font and correct for every other unit;
   *  the multiplication was always just an em→px conversion done by hand. */
  amp: number;
  /** Extra span CSS the effect needs (rainbow's clipped gradient); absent otherwise. */
  style?: Record<string, string>;
  /** Per-character reveal (typewriter): the renderer splits the text into one span
   *  per glyph and staggers each by `staggerSec`, so whole glyphs pop in sequence
   *  (a width clip can't — it slices mid-glyph on a proportional font). `loop` types
   *  → holds → erases → repeats; otherwise it types once and holds. `fadeIn` fades
   *  each glyph in vs pops it instantly. Absent for whole-element effects. */
  perChar?: { staggerSec: number; loop: boolean; fadeIn: boolean };
}

/** Map an effect + params → the CSS animation for a DOM text element, or null for
 *  `none`/unknown. The amplitude comes back in **em** and is resolved by the renderer against
 *  the element's own computed font size, so this takes no `fontSize` (#245). Pure. */
/** Carry the element's `textAlign` onto a SHRINK-WRAPPED span (#657 follow-up).
 *
 *  ⚠️ MEASURED, after the plain `width: fit-content` fix regressed centring. `text-align` centres
 *  INLINE content inside a box; once the span is `display: block` + `fit-content` the box is only
 *  as wide as its glyphs, so there is nothing left for `text-align` to centre and the box itself
 *  sits flush at the start of the line — a centred "SCORE" jumped to the left edge. Auto margins
 *  are what position a shrink-to-fit BLOCK, so they are the mechanism that has to carry the
 *  authored alignment across.
 *
 *  `UIElement.textAlign` is typed `'left' | 'center' | 'right'`, so there is no `start`/`end` arm
 *  to write and no RTL question to answer — adding one would be a branch no caller can reach.
 *
 *  Left needs no margin (the default position is already correct), and a flex parent that
 *  centres via `justifyContent` is unaffected either way — an auto inline margin centres a flex
 *  item too, so the two agree rather than fight. Verified on all four combinations. */
export function shrinkWrapAlign(textAlign?: string): Record<string, string> {
  if (textAlign === 'center') return { marginInline: 'auto' };
  if (textAlign === 'right') return { marginLeft: 'auto' };
  return {};
}

/** RAINBOW_STYLE + the alignment, CACHED PER ALIGNMENT so the object is referentially stable.
 *
 *  ⚠️ Not a micro-optimisation. `AnimatedText` is `React.memo`'d and its docblock calls that
 *  load-bearing: `extra` used to be the module-level `RAINBOW_STYLE`, so the shallow compare
 *  bailed out on every per-frame re-render. Spreading a fresh object per call defeated that for
 *  the one effect that carries extra style. There are three possible alignments, so a tiny map
 *  restores stability without giving up the alignment carry-through. */
const RAINBOW_BY_ALIGN = new Map<string, Record<string, string>>();
function rainbowStyleFor(textAlign?: string): Record<string, string> {
  const key = textAlign ?? '';
  let v = RAINBOW_BY_ALIGN.get(key);
  if (!v) {
    v = { ...RAINBOW_STYLE, ...shrinkWrapAlign(textAlign) };
    RAINBOW_BY_ALIGN.set(key, v);
  }
  return v;
}

export function uiTextAnimation(params: UITextAnimParams, textAlign?: string): UITextAnimStyle | null {
  const m = EFFECTS[params.effect];
  if (!m) return null;
  if (m.perChar) {
    // ~11 glyphs/sec at speed 1. The renderer turns this into a per-glyph delay.
    const staggerSec = 0.09 / Math.max(0.1, params.speed);
    return { animation: '', amp: 0, perChar: { staggerSec, loop: params.loop, fadeIn: params.fadeIn !== false } };
  }
  const dur = (1 / Math.max(0.1, params.speed)).toFixed(3);
  const iter = m.periodic ? 'infinite' : (params.loop ? 'infinite' : '1');
  // A looping one-shot (fade) ping-pongs (pulse); a non-looping one-shot holds its end.
  const direction = !m.periodic && params.loop ? 'alternate' : 'normal';
  const fill = !m.periodic && !params.loop ? 'forwards' : 'none';
  return {
    animation: `${m.kf} ${dur}s ${m.timing} 0s ${iter} ${direction} ${fill}`,
    amp: m.amp ? params.amplitude : 0,
    ...(m.gradient ? { style: rainbowStyleFor(textAlign) } : {}),
  };
}

/** The keyframes (static; motion distance via the `--ui-amp` custom property). */
const KEYFRAMES = `
@keyframes mdk-ui-fade { from { opacity: 0 } to { opacity: 1 } }
/* Typewriter per-glyph reveal. -in: a glyph pops (its span is opacity 0 until its
   staggered delay elapses, then holds). -cycle: pop → hold → erase → repeat (loop). */
@keyframes mdk-ui-type-in { from { opacity: 0 } to { opacity: 1 } }
@keyframes mdk-ui-type-cycle { 0% { opacity: 0 } 3% { opacity: 1 } 64% { opacity: 1 } 71% { opacity: 0 } 100% { opacity: 0 } }
/* Hard-pop loop (fadeIn off): per-keyframe steps() make the glyph appear/vanish instantly. */
@keyframes mdk-ui-type-cycle-hard { 0% { opacity: 0; animation-timing-function: steps(1,jump-end) } 3% { opacity: 1 } 64% { opacity: 1; animation-timing-function: steps(1,jump-end) } 71% { opacity: 0 } 100% { opacity: 0 } }
@keyframes mdk-ui-float { 0%,100% { transform: translateY(0) } 50% { transform: translateY(calc(-1 * var(--ui-amp, 6px))) } }
@keyframes mdk-ui-bounce { 0%,25%,55%,100% { transform: translateY(0) } 40% { transform: translateY(calc(-1 * var(--ui-amp, 8px))) } 70% { transform: translateY(calc(-0.4 * var(--ui-amp, 8px))) } }
@keyframes mdk-ui-shake { 0%,100% { transform: translate(0,0) } 25% { transform: translate(calc(-1 * var(--ui-amp, 3px)), var(--ui-amp, 3px)) } 50% { transform: translate(var(--ui-amp, 3px), calc(-1 * var(--ui-amp, 3px))) } 75% { transform: translate(calc(-1 * var(--ui-amp, 3px)), calc(-1 * var(--ui-amp, 3px))) } }
@keyframes mdk-ui-rainbow { from { background-position: 0% center } to { background-position: 200% center } }
`;

let _injected = false;
/** Inject the keyframe rules once into the document head (idempotent, SSR-safe). */
export function ensureUITextAnimStyles(): void {
  if (_injected || typeof document === 'undefined') return;
  _injected = true;
  const el = document.createElement('style');
  el.setAttribute('data-mdk-ui-text-anim', '');
  el.textContent = KEYFRAMES;
  document.head.appendChild(el);
}

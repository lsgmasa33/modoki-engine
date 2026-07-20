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
 *  Amplitude (em, ×fontSize → px) drives translate distance via a `--ui-amp` custom
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
  /** translate distance in px for `--ui-amp` (0 for non-motion effects). */
  ampPx: number;
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
 *  `none`/unknown. `fontSize` scales the em amplitude to px. Pure. */
export function uiTextAnimation(params: UITextAnimParams, fontSize: number): UITextAnimStyle | null {
  const m = EFFECTS[params.effect];
  if (!m) return null;
  if (m.perChar) {
    // ~11 glyphs/sec at speed 1. The renderer turns this into a per-glyph delay.
    const staggerSec = 0.09 / Math.max(0.1, params.speed);
    return { animation: '', ampPx: 0, perChar: { staggerSec, loop: params.loop, fadeIn: params.fadeIn !== false } };
  }
  const dur = (1 / Math.max(0.1, params.speed)).toFixed(3);
  const iter = m.periodic ? 'infinite' : (params.loop ? 'infinite' : '1');
  // A looping one-shot (fade) ping-pongs (pulse); a non-looping one-shot holds its end.
  const direction = !m.periodic && params.loop ? 'alternate' : 'normal';
  const fill = !m.periodic && !params.loop ? 'forwards' : 'none';
  return {
    animation: `${m.kf} ${dur}s ${m.timing} 0s ${iter} ${direction} ${fill}`,
    ampPx: m.amp ? params.amplitude * fontSize : 0,
    ...(m.gradient ? { style: RAINBOW_STYLE } : {}),
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

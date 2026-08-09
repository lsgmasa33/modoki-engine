/**
 * Haptic patterns — the vocabulary layer.
 *
 * A pattern is a short list of PRESET steps with authored gaps. That is the whole expressive
 * range, and it is deliberate: measurement showed fixed presets sequenced from JS hold their
 * timing to within −21..+8ms on both Android tiers, which removed the case for a native
 * custom-waveform engine (`docs/haptics.md` § "Why presets").
 *
 * **The engine ships a DEFAULT SET; a game may add to it or override it** (owner, 2026-08-09).
 * Two tiers, and the split follows the single-source-of-truth rule:
 *
 *  - **Engine defaults are code constants**, because they are *vocabulary*, not game data — the
 *    same reason a fixed dt or a sentinel is a constant. They are also the fallback every game
 *    gets for free with zero authoring.
 *  - **A game registers its OWN names in its `setup.ts`** (`registerHapticPatterns`), beside where
 *    it already registers systems, traits and projections. Game-specific vocabulary belongs with
 *    the game, and this keeps it hot-reloadable with the rest of the game's code.
 *
 * ⚠️ **A pattern is NOT an asset and must not become one.** It has no file, no GUID and nothing
 * for the build to resolve, so #53's "a GUID in code is a ref the build cannot see" does not apply.
 * An asset kind here would be ceremony around three numbers.
 */

/** The preset vocabulary, named by FEELING rather than by platform. Each maps to one
 *  `@capacitor/haptics` call; nothing here can express amplitude or sharpness directly, because
 *  no platform in range exposes both (see docs/haptics.md § "What the tiers can render"). */
export type HapticPreset =
  | 'impact.light'
  | 'impact.medium'
  | 'impact.heavy'
  | 'select'
  | 'success'
  | 'warning'
  | 'error';

/** One beat: wait `delayMs` after the PREVIOUS step, then fire `preset`. The first step of a
 *  pattern conventionally has `delayMs: 0`; a non-zero value there just delays the whole thing. */
export interface HapticStep {
  preset: HapticPreset;
  delayMs: number;
}

export type HapticPattern = readonly HapticStep[];

const step = (preset: HapticPreset, delayMs = 0): HapticStep => ({ preset, delayMs });

/**
 * The default set every game gets without authoring anything.
 *
 * Seven single-beat entries that are just the presets by name, plus TWO composed feelings that
 * Court proved are worth having and that generalise: a refusal reads as a refusal only because it
 * is two beats, and a celebration needs a rise. Both gaps are the ones measured on hardware, so
 * they are known-good rather than guessed.
 */
export const ENGINE_HAPTIC_PATTERNS: Readonly<Record<string, HapticPattern>> = Object.freeze({
  'impact.light': [step('impact.light')],
  'impact.medium': [step('impact.medium')],
  'impact.heavy': [step('impact.heavy')],
  select: [step('select')],
  success: [step('success')],
  warning: [step('warning')],
  error: [step('error')],

  /** "No." Two beats, because a single heavy impact reads as a heavier LANDING rather than a
   *  refusal — the gap is what carries the meaning, and on a phone with no amplitude control
   *  (e.g. the Galaxy A23) the gap is the ONLY thing that still carries it. */
  refuse: [step('impact.heavy'), step('impact.heavy', 90)],

  /** A rise. Presets can only step, never ramp, so three beats is as close to a swell as this
   *  vocabulary gets — and it measured as reading like one. */
  celebrate: [step('impact.light'), step('impact.medium', 80), step('success', 110)],
});

/** Game-registered patterns, layered OVER the engine defaults. */
let gamePatterns: Record<string, HapticPattern> = {};

/**
 * Register a game's own named patterns — call from the game's `setup.ts`.
 *
 * Names collide with the engine defaults deliberately: registering `refuse` REPLACES the default
 * rather than erroring, so a game can retune a stock feeling without inventing a new name for it.
 * Prefer a game-scoped prefix (`court.illegal`) for genuinely new moments, so a later engine
 * default cannot silently shadow one.
 */
export function registerHapticPatterns(patterns: Record<string, HapticPattern>): void {
  gamePatterns = { ...gamePatterns, ...patterns };
}

/** Drop every game-registered pattern. Called on teardown so a test (or a project swap in the
 *  editor) cannot leak one game's vocabulary into the next. */
export function clearHapticPatterns(): void {
  gamePatterns = {};
}

/**
 * Resolve a name to its pattern: game table first, then the engine defaults. Returns undefined
 * for an unknown name — the caller decides whether that is a warning or silence.
 *
 * ⚠️ **OWN properties only.** A plain object inherits from `Object.prototype`, so a bare
 * `map[name]` lookup answers `'constructor'` with the `Object` function and `'toString'` with a
 * method — neither of which is a pattern. `playHaptic` then reached `pattern.forEach` on a
 * function and threw `TypeError: pattern.forEach is not a function`, straight through the
 * module's "never throws into game code" contract. Reachable from AUTHORED data, not just a
 * typo: a scene binding `haptics.play` with `{ pattern: "constructor" }` is enough.
 */
export function resolveHapticPattern(name: string): HapticPattern | undefined {
  if (Object.hasOwn(gamePatterns, name)) return gamePatterns[name];
  if (Object.hasOwn(ENGINE_HAPTIC_PATTERNS, name)) return ENGINE_HAPTIC_PATTERNS[name];
  return undefined;
}

/** Every name currently resolvable, engine + game. Used by the debug surface so a human can see
 *  what a game actually registered rather than guessing from source. */
export function hapticPatternNames(): string[] {
  return [...new Set([...Object.keys(ENGINE_HAPTIC_PATTERNS), ...Object.keys(gamePatterns)])].sort();
}

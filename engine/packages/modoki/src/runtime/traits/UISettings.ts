import { trait } from 'koota';

/** The trait's own defaults, re-exported so `bindings.ts` can fall back to them when no scene
 *  entity carries `UISettings` — rather than duplicating the numbers as constants that would
 *  silently drift from the authored default. */
export const UI_SETTINGS_DEFAULT_INPUT_LOCK_MIN_MS = 300;
export const UI_SETTINGS_DEFAULT_INPUT_LOCK_MAX_MS = 10000;

/**
 * UI resource — the singleton knobs for the global input lock (`applyBindings`'
 * double-tap guard, #466).
 *
 * Authored in the scene, not hardcoded, for the same reason `HapticSettings` and
 * `AudioSettings` are: the right value is only knowable after feeling it on device, and the
 * owner must be able to retune it in the Inspector without an engine change.
 */
export const UISettings = trait({
  /**
   * Minimum time, in ms, a UI input stays locked after a discrete activation (click, submit,
   * a toggle's change). The real gate is the action's own promise settling — this is only the
   * FLOOR that stops a double tap when the action is synchronous and settles instantly, so a
   * second tap a frame later cannot slip through before the lock has even been observed.
   *
   * `0` disables the floor entirely (the lock still releases once every collected promise has
   * settled) — the escape hatch for a rapid-fire button that must accept back-to-back taps.
   */
  inputLockMinMs: UI_SETTINGS_DEFAULT_INPUT_LOCK_MIN_MS,
  /**
   * Safety valve, in ms. If the lock has been held longer than this, it is force-released (with
   * a console warning naming the action(s) still pending) on the next acquire attempt. A hung
   * async handler must never brick the UI permanently.
   */
  inputLockMaxMs: UI_SETTINGS_DEFAULT_INPUT_LOCK_MAX_MS,
  /**
   * The scene-wide DEFAULT DOM font for every UI root (#803). A `UIElement` mounted as a UI
   * ROOT entity is a SIBLING of every other root inside one shared container div, not a
   * descendant of some single "top" element — so a font authored on `UIElement.fontFamily`
   * only ever reaches ITS OWN root's descendants, and a scene with several roots (Court has
   * ten: HUD + one per modal) needs the same typeface authored nine more times or it silently
   * falls back to the browser default on every root that didn't get it. This field is read
   * once for the whole scene and applied to the ONE container every UI root lives inside, so
   * CSS inheritance carries it to all of them.
   *
   * A font-ASSET GUID, resolved through the manifest exactly like every other ref (so the
   * validator, `diagnose` and the build's tree-shaker can see it) — same contract as
   * `UIElement.fontFamily`. Empty ⇒ no scene-wide default is applied.
   */
  fontFamily: '',
  /**
   * A plain CSS family name (system-ui, Helvetica, or a stack) — for a typeface no asset can
   * express. Used only when `fontFamily` above is empty or unresolvable. Same role as
   * `UIElement.systemFont`, one level up the cascade.
   *
   * Precedence matches `UIElement`'s, exactly: the asset GUID wins over `systemFont` when both
   * are set, and either one only ever supplies the DEFAULT — a per-element
   * `UIElement.fontFamily`/`systemFont` still overrides it by ordinary CSS cascade (the
   * descendant's own `font-family` wins over the inherited container value).
   */
  systemFont: '',
});

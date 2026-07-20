/** Decode + resolve an `Animator.clips` bank — a JSON-string
 *  `[{ name, clip, speed?, loop?, fadeDuration? }, …]` (name → `.anim.json` clip GUID +
 *  optional per-clip playback overrides). A JSON-string SCALAR (like `AudioSource.clips` /
 *  `Collider2D.points`) keeps the list boundary-safe (opaque to serialize/undo/prefab), so
 *  this is the ONE place that decodes it — shared by the play loop (`animationSystem` +
 *  `scene3DSync.applyBoneAnimators`), the resource collector (`collectResourceRefsFromEntities`),
 *  and the build tree-shaker (`probeTraitRefs`). Guarded: any malformed / non-array /
 *  bad-entry input → `[]` (never throws). Entries missing a string `name`/`clip` are dropped.
 *
 *  NOT to be confused with `AudioSource.clips` (audio.clipBank — `[{key,ref}]`) or the
 *  `.spriteanim.json` / `.animset.json` clip SETS (separate assets); this bank lives inline
 *  on the keyframe `Animator` trait and its `clip` refs are `.anim.json` GUIDs. */

export interface AnimatorClip {
  /** Selector name used as the active pointer (idle/walk/jump). */
  name: string;
  /** GUID of the `.anim.json` clip this entry plays. */
  clip: string;
  /** Per-clip playback-rate override (falls back to the trait `speed`). */
  speed?: number;
  /** Per-clip loop override (falls back to the trait `loop`). */
  loop?: boolean;
  /** Per-clip crossfade seconds into this clip (Phase 2; falls back to trait `fadeDuration`). */
  fadeDuration?: number;
}

export function parseAnimClipBank(src: unknown): AnimatorClip[] {
  if (typeof src !== 'string' || src === '') return [];
  let raw: unknown;
  try { raw = JSON.parse(src); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  const out: AnimatorClip[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const { name, clip, speed, loop, fadeDuration } = e as Record<string, unknown>;
    if (typeof name !== 'string' || typeof clip !== 'string') continue;
    const entry: AnimatorClip = { name, clip };
    if (typeof speed === 'number') entry.speed = speed;
    if (typeof loop === 'boolean') entry.loop = loop;
    if (typeof fadeDuration === 'number') entry.fadeDuration = fadeDuration;
    out.push(entry);
  }
  return out;
}

/** Serialize a bank back to its JSON-string form (inverse of `parseAnimClipBank`).
 *  `'[]'` for an empty bank (the trait default — keeps a clip-less animator readable). */
export function stringifyAnimClipBank(entries: AnimatorClip[]): string {
  return entries.length ? JSON.stringify(entries) : '[]';
}

/** The subset of an Animator instance the resolvers below read. */
export interface AnimatorClipSource {
  clips?: unknown;   // JSON-string bank
  clip?: string;     // active clip NAME ('' = first entry)
}

/** The active clip resolved from the bank, with per-clip overrides carried through. */
export interface ResolvedAnimatorClip {
  name: string;
  ref: string;                 // `.anim.json` GUID to load
  speed?: number;
  loop?: boolean;
  fadeDuration?: number;
}

/** Resolve a specific clip by `name` (empty `name` → first entry, stable order), carrying its
 *  per-clip overrides. Returns null when the bank is empty or the name isn't present. Used for
 *  both the active clip and the crossfade's outgoing (`fadeFrom`) clip. */
export function resolveClipByName(anim: AnimatorClipSource, name: string): ResolvedAnimatorClip | null {
  const bank = parseAnimClipBank(anim.clips);
  if (bank.length === 0) return null;
  const entry = name ? bank.find((c) => c.name === name) : bank[0];
  if (!entry) return null;
  return { name: entry.name, ref: entry.clip, speed: entry.speed, loop: entry.loop, fadeDuration: entry.fadeDuration };
}

/** Resolve which clip an Animator should play right now: the entry whose `name` matches the
 *  active `clip` (empty → first entry). Returns null when the bank is empty or the active name
 *  isn't present — the caller then leaves the entity unposed. */
export function resolveActiveClip(anim: AnimatorClipSource): ResolvedAnimatorClip | null {
  return resolveClipByName(anim, anim.clip ?? '');
}

/** Does this animator's bank have a clip by `name`? Parity with `spriteAnimHasClip` — used
 *  by the switch API to only activate a clip that actually exists. */
export function animatorHasClip(anim: AnimatorClipSource, name: string): boolean {
  if (!name) return false;
  return parseAnimClipBank(anim.clips).some((c) => c.name === name);
}

/** Shared Web Audio `AudioContext` for the whole audio subsystem.
 *
 *  Lazily created on first use in a browser. Returns `null` in headless/SSR
 *  (node / jsdom / happy-dom, none of which implement Web Audio) so the entire
 *  audio stack — buffer cache, service, system — degrades to a deterministic
 *  no-op. This is what keeps `stepSimulation` silent and the verification harness
 *  clean: no context ⇒ no playback ⇒ nothing wall-clock-dependent runs.
 *
 *  We deliberately use the Web Audio API directly rather than Three's audio
 *  wrappers (`THREE.Audio`/`PositionalAudio`): our source graph needs explicit
 *  per-bus gain routing and ECS-driven (not Object3D-driven) listener/panner
 *  positions, both of which are more direct with raw nodes. A side benefit is the
 *  audio subsystem carries ZERO Three dependency, so a pure-2D game that drops 3D
 *  rendering drops nothing here. */

type AudioCtor = typeof AudioContext;

let ctx: AudioContext | null = null;
let attempted = false;

function audioCtor(): AudioCtor | undefined {
  if (typeof AudioContext !== 'undefined') return AudioContext;
  const w = globalThis as unknown as { webkitAudioContext?: AudioCtor };
  return w.webkitAudioContext;
}

/** True when the runtime environment can play audio at all (a browser/WebView). */
export function hasAudioSupport(): boolean {
  return audioCtor() !== undefined;
}

/** The shared context, or `null` in headless/unsupported environments. Created
 *  lazily; only attempted once (a failure is cached so we don't spam construction). */
export function getAudioContext(): AudioContext | null {
  if (ctx) return ctx;
  if (attempted) return null;
  attempted = true;
  const Ctor = audioCtor();
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch {
    ctx = null;
  }
  return ctx;
}

/** Close + drop the shared context (app teardown / error-boundary recovery).
 *  Browsers cap total live contexts, so HMR reloads can otherwise accumulate them. */
export function disposeAudioContext(): void {
  if (ctx) {
    ctx.close().catch(() => { /* ignore */ });
    ctx = null;
  }
  attempted = false;
}

/** Host platform + form factor — the ONE place the engine asks "is this a handheld?".
 *
 *  L0 core on purpose. Two unrelated L2 subsystems need the answer and cannot reach each
 *  other: `rendering/deviceCaps.ts` boots the quality tier from it, and `input/` + `ui/`
 *  decide whether an on-screen touch control is mounted at all (`traits/TouchControl.ts`).
 *  A second copy of this test in either of them is exactly the shadowed-constant failure
 *  the single-source-of-truth rule exists to prevent — the two would drift, and the drift
 *  would show up as "the d-pad is missing on the device that renders at the low tier".
 *
 *  Pure reads of the host, no world, no wall-clock, no RNG. Every branch that is not a
 *  POSITIVE desktop answer falls through to `'mobile'`. */

/** Read the Capacitor global rather than importing `@capacitor/core`.
 *
 *  Deliberate, and it matches the debug menu's `DeviceTab`: this module ships inside every
 *  game, and the published demos are **web-only**. A hard import would make a native plugin a
 *  build-time requirement for a web page that can never use it. Reading the global degrades to
 *  `'web'` with nothing installed. */
export function readPlatform(): string {
  const cap = (globalThis as unknown as { Capacitor?: { getPlatform?: () => string } }).Capacitor;
  try { return cap?.getPlatform?.() ?? 'web'; } catch { return 'web'; }
}

/** Desktop-class host? See `DeviceCaps.formFactor` for why this is not `platform`.
 *
 *  Ordered by how much each signal actually knows:
 *  1. A native iOS/Android build is a handheld, full stop.
 *  2. `userAgentData.mobile` is the browser TELLING us (Chromium, incl. Electron) — believed in
 *     both directions because it is an answer, not an inference.
 *  3. Otherwise (Safari, Firefox — no `userAgentData`): a fine pointer AND no touch points. A
 *     touchscreen laptop fails this and is called mobile. That is the cheap side of the error
 *     for both consumers — the renderer boots low and calibration promotes it; the d-pad
 *     appears on a machine that can also take a real tap — which is why the test is written to
 *     be strict rather than clever. */
export function readFormFactor(platform: string = readPlatform()): 'mobile' | 'desktop' {
  if (platform === 'ios' || platform === 'android') return 'mobile';
  try {
    const uaData = (navigator as unknown as { userAgentData?: { mobile?: boolean } }).userAgentData;
    if (typeof uaData?.mobile === 'boolean') return uaData.mobile ? 'mobile' : 'desktop';
    const finePointer = globalThis.matchMedia?.('(pointer: fine)').matches === true;
    const noTouch = (navigator.maxTouchPoints ?? 0) === 0;
    return finePointer && noTouch ? 'desktop' : 'mobile';
  } catch {
    return 'mobile'; // cannot tell → the safe side
  }
}

/** Should a touch-only affordance (an on-screen d-pad, a virtual button) be mounted?
 *
 *  ⚠️ Deliberately NOT read from `Input.lastInputDevice`. The question is asked at MOUNT
 *  time — before the player has touched anything, when `lastDevice` is still `'none'` — so a
 *  device-driven answer would hide the very control that lets them produce the first input.
 *  This is a property of the HOST, not of what has been pressed.
 *
 *  Read live rather than cached: the editor's device-preset previews and a desktop browser's
 *  device-emulation mode both change the answer within one session. */
export function isTouchDevice(): boolean {
  return readFormFactor() === 'mobile';
}

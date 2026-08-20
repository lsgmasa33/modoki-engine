/** Faults section of the Device tab — the deliberate NATIVE crash probes (#278).
 *
 *  Native-only by construction: the implementation lives in `capacitor-game-debug` and is
 *  installed over the `faultProvider` seam by the app shell (app/debug/nativeFaults.ts). In the
 *  editor and on the web nothing provides it, and this says so rather than offering buttons that
 *  would resolve cheerfully and do nothing.
 *
 *  Every button here KILLS OR FREEZES the app on purpose, so each is a TWO-TAP arm — never a
 *  `confirm()`, which is a native modal that blocks the whole renderer and would freeze the very
 *  thing the probe is about to measure. */

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { faultProvider, FAULT_LABELS, type FaultKind } from '../../core/faultProvider';

/** How long a probe stays armed before disarming itself. Long enough to mean it, short enough that
 *  a stray first tap does not leave a live "kill the app" button lying around. Mirrors Court's
 *  destructive-button convention. */
const ARM_MS = 4000;

export function FaultsSection() {
  const [armed, setArmed] = useState<FaultKind | null>(null);
  const [fired, setFired] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);

  // `isProvided()` before `get()`: reading an unprovided slot warns once about a missing wiring,
  // which is exactly wrong here — "no provider" is the NORMAL editor/web state, not a bug.
  const provider = faultProvider.isProvided() ? faultProvider.get() : null;
  const kinds = provider ? provider.supported() : [];

  function arm(kind: FaultKind) {
    if (timer.current !== null) window.clearTimeout(timer.current);
    setArmed(kind);
    timer.current = window.setTimeout(() => setArmed(null), ARM_MS);
  }

  function fire(kind: FaultKind) {
    if (timer.current !== null) window.clearTimeout(timer.current);
    setArmed(null);
    // An `anr` block needs an input event to become a reportable ANR, and `crash`/`uncaught` never
    // come back at all — so the note is set BEFORE the call, while there is still a frame to
    // render it in.
    setFired(kind === 'anr'
      // TWO steps, and skipping the second is why an ANR can be raised and never reported. The tap
      // is what raises it (an ANR is an input timeout, not idle blocking); "Close app" is what makes
      // the system KILL the process, which is the only thing that leaves the ApplicationExitInfo
      // record Crashlytics collects. Measured both ways on an S22: a block that ends on its own
      // raises a system-confirmed ANR and files no report at all.
      ? 'Blocking the main thread — TAP THE SCREEN now to raise the ANR, then choose “Close app” in the system dialog. Waiting it out raises an ANR that is never reported.'
      : 'Fault sent. The app should die; the report uploads on the NEXT launch.');
    void provider?.trigger(kind).catch((e: unknown) => {
      // A refusal is the interesting case: the native half rejects when build.debugBuild is off,
      // and that message names the setting to turn on.
      setFired(`Refused: ${e instanceof Error ? e.message : String(e)}`);
    });
  }

  return (
    <div style={sectionStyle}>
      <div style={titleStyle}>Faults</div>
      {!provider ? (
        <div style={mutedStyle}>
          Native-only — no fault provider in this build. Run a native debug build (Project
          Settings → Developer → “Debug build”) to raise real crashes.
        </div>
      ) : kinds.length === 0 ? (
        <div style={mutedStyle}>No fault kinds are supported on this platform.</div>
      ) : (
        <>
          <div style={mutedStyle}>
            Proves the crash pipeline against shapes JS cannot reach. Each one kills or freezes the
            app on purpose.
          </div>
          <div style={colStyle}>
            {kinds.map((kind) => (
              <button
                key={kind}
                style={{ ...btnStyle, ...(armed === kind ? armedStyle : {}) }}
                onClick={() => (armed === kind ? fire(kind) : arm(kind))}
                title={FAULT_LABELS[kind].detail}
              >
                {armed === kind ? `Tap again to raise: ${FAULT_LABELS[kind].label}` : FAULT_LABELS[kind].label}
              </button>
            ))}
          </div>
          {fired && <div style={firedStyle}>{fired}</div>}
        </>
      )}
    </div>
  );
}

const sectionStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8, padding: '6px 8px', background: '#2a1620', border: '1px solid #6b2f3a', borderRadius: 4 };
const titleStyle: CSSProperties = { color: '#ff9f9f', fontSize: 12, fontWeight: 600 };
const colStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 2 };
const btnStyle: CSSProperties = { background: 'transparent', border: '1px solid #6b2f3a', color: '#ffb4b4', cursor: 'pointer', fontSize: 12, padding: '7px 10px', borderRadius: 6, textAlign: 'left' };
/** Armed = FILLED, not merely relabelled: the two states must be distinguishable at a glance.
 *
 *  ⚠️ The whole `border` shorthand, NOT `borderColor`. React warns on mixing a shorthand with a
 *  longhand for the same value across a rerender, and that warning goes through `console.error` —
 *  which `globalErrors.ts` reports to Crashlytics as a non-fatal ISSUE. Measured on an S22: every
 *  arm filed one. A debug control that manufactures crash-report noise is worse than no control. */
const armedStyle: CSSProperties = { background: 'rgba(224,102,95,0.22)', border: '1px solid #e0665f', color: '#ffd9d7' };
const mutedStyle: CSSProperties = { fontSize: 11, color: '#a08a90', fontStyle: 'italic', lineHeight: 1.4 };
const firedStyle: CSSProperties = { fontSize: 11, color: '#ffd9d7', marginTop: 4, lineHeight: 1.4 };

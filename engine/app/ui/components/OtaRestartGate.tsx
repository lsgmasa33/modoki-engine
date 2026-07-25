/** OtaRestartGate — the terminal "update ready" screen for a mandatory OTA release
 *  (docs/ota-updates.md, Phase 3b). Renders in place of the game once
 *  `checkAppOtaUpdate()` has resolved `false` for this launch — deliberately a
 *  dead end, not a mid-session hot-swap: only a manual app restart re-derives what
 *  to serve from state.json via the native boot hook. Interactive (unlike
 *  LoadingOverlay) only in the sense that it covers the whole screen; there is
 *  nothing to tap — an app cannot restart itself on iOS. */

interface Props {
  version: string;
}

export default function OtaRestartGate({ version }: Props) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: '#0a0a1a',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#e6e6ff',
        fontFamily: 'system-ui, sans-serif',
        textAlign: 'center',
        padding: 24,
        zIndex: 1100, // above LoadingOverlay (1000) — this screen wins if both are mounted
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 320 }}>
        <div style={{ fontSize: 18, fontWeight: 600 }}>Update ready</div>
        <div style={{ fontSize: 14, opacity: 0.85, lineHeight: 1.5 }}>
          Please close and reopen the app to continue.
        </div>
        <div style={{ fontSize: 11, opacity: 0.5, marginTop: 8 }}>{version}</div>
      </div>
    </div>
  );
}

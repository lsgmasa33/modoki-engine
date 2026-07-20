// AI-panel section: Percept capture preferences. Currently one toggle — auto-open the
// Tier-2 @contact journal watch when the GameView enters Play, so a physics trace is
// captured from the first frame without an agent having to call journal action:start.
// The flag is per-project (server-side, <project>/.modoki/ai-settings.json); enterPlay
// reads it and calls setVerboseCapture('@contact', true). @contact stays lean-by-default
// otherwise (it's watch-gated to keep the journal from being dominated by contacts).

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchAiSettings, saveAiSettings } from './aiSettingsModel';

export default function AiCaptureSection(): React.ReactElement {
  const [onLaunch, setOnLaunch] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    // The mounted ref is the real guard — fetchAiSettings resolves to {} on failure rather than
    // rejecting, so it always returns; no AbortController needed to prevent a post-unmount setState.
    void fetchAiSettings().then((s) => {
      if (mounted.current) setOnLaunch(!!s.captureContactOnLaunch);
    });
    return () => { mounted.current = false; };
  }, []);

  const toggle = useCallback((next: boolean) => {
    setOnLaunch(next); // optimistic
    void saveAiSettings({ captureContactOnLaunch: next });
  }, []);

  return (
    <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid #2a2a3a' }}>
      <div style={{ color: '#888', marginBottom: 6, fontSize: 12 }}>Percept capture</div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12, color: '#cdd' }}>
        <input type="checkbox" checked={onLaunch} onChange={(e) => toggle(e.target.checked)} />
        Capture @contact events on Play
      </label>
      <div style={{ color: '#666', marginTop: 4, fontSize: 11 }}>
        Opens the @contact journal watch when the GameView starts Play. Off by default — @contact is
        high-frequency, so it’s watch-gated to keep the journal lean.
      </div>
    </div>
  );
}

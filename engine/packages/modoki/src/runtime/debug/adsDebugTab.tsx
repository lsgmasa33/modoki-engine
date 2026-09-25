/** The Ads debug tab — show any ad kind NOW, switch each kind on or off, and open the ad SDK's mediation
 *  debugger (#1474 Weaveling, promoted for Court in #1501, the debugger button #1500).
 *
 *  Presentation only: the decisions are `../core/adDebug.ts` (tests: `tests/runtime/core/adDebug.test.ts`),
 *  and each game's `ads.ts` routes its calls through the instance this tab is built over. Polled, like the
 *  other debug tabs: readiness moves as the SDK loads.
 *
 *  ⚠️ Its own subpath (`@modoki/engine/runtime/debug/adsTab`), NOT the `runtime/debug` index: importing
 *  that index registers every built-in tab and installs console capture, and Court imports its debug tabs
 *  statically. This module has no side effects. A game registers the tab inside its own
 *  `isDebugMenuEnabled()` block, like every game-registered debug surface (docs/debug-menu.md). */

import { useEffect, useState, type ComponentType, type CSSProperties } from 'react';
import type { AdDebug, BannerMode } from '../core/adDebug';
import type { FullscreenKind } from '../core/adLifecycle';
import { scrollRootStyle } from './tabLayout';

const POLL_MS = 250;
const HIGHLIGHT = '#4f7fd0';

const mono: CSSProperties = { fontSize: '0.8rem', fontFamily: 'ui-monospace, monospace' };
const line: CSSProperties = { display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' };
const button: CSSProperties = { padding: '0.4rem 0.7rem', borderRadius: 4, cursor: 'pointer', fontSize: '0.8rem' };
const picked = (on: boolean): CSSProperties => (on ? { ...button, outline: `2px solid ${HIGHLIGHT}` } : button);

const BANNER_MODES: readonly BannerMode[] = ['auto', 'on', 'off'];
const FULLSCREEN: readonly FullscreenKind[] = ['interstitial', 'rewarded'];

/** Build the tab over one game's `AdDebug` instance. */
export function createAdsDebugTab(debug: AdDebug): ComponentType {
  function AdsDebugTab() {
    const [status, setStatus] = useState(() => debug.status());
    const [last, setLast] = useState('');
    useEffect(() => {
      const id = window.setInterval(() => setStatus(debug.status()), POLL_MS);
      return () => window.clearInterval(id);
    }, []);
    const refresh = () => setStatus(debug.status());
    const show = (kind: FullscreenKind) => {
      setLast(`${kind}: showing…`);
      void debug.showNow(kind).then((shown) => {
        setLast(`${kind}: ${shown ? 'presented' : 'refused — none loaded, or another ad is up'}`);
        refresh();
      });
    };
    const openMediation = () => {
      setLast('mediation debugger: opening…');
      void debug.openMediationDebugger().then((r) => setLast(r.message));
    };
    const o = status.override;

    return (
      <div style={scrollRootStyle(12)}>
        <div style={mono}>
          SDK {status.initialized ? 'initialized' : 'NOT initialized'}
          {status.fullscreenShowing ? ' · fullscreen ad UP' : ''}
        </div>

        <div style={line}>
          <span style={{ ...mono, minWidth: '6rem' }}>Banner</span>
          {BANNER_MODES.map((m) => (
            <button key={m} type="button" style={picked(o.banner === m)}
              onClick={() => { debug.setOverride({ banner: m }); refresh(); }}>
              {m === 'auto' ? `Auto (game: ${status.gameWantsBanner ? 'on' : 'off'})` : m === 'on' ? 'Force on' : 'Force off'}
            </button>
          ))}
        </div>

        {FULLSCREEN.map((kind) => {
          const loaded = kind === 'interstitial' ? status.interstitialLoaded : status.rewardedLoaded;
          return (
            <div key={kind} style={line}>
              <span style={{ ...mono, minWidth: '6rem' }}>{kind === 'interstitial' ? 'Interstitial' : 'Rewarded'}</span>
              <span style={mono}>{loaded ? 'loaded' : 'not loaded'}</span>
              <button type="button" style={button} disabled={!loaded || status.fullscreenShowing} onClick={() => show(kind)}>
                Show now
              </button>
              <label style={{ ...mono, display: 'flex', gap: '0.35rem', alignItems: 'center', cursor: 'pointer' }}>
                <input type="checkbox" checked={o[kind]}
                  onChange={(e) => { debug.setOverride({ [kind]: e.target.checked }); refresh(); }} />
                game may show
              </label>
            </div>
          );
        })}

        {debug.hasMediationDebugger && (
          <div style={line}>
            <span style={{ ...mono, minWidth: '6rem' }}>Mediation</span>
            <button type="button" style={button} onClick={openMediation}>Open mediation debugger</button>
          </div>
        )}

        {last && <div style={mono}>{last}</div>}
        <div style={{ ...mono, opacity: 0.7 }}>
          Show now bypasses pacing and the checkbox. A rewarded video pays through the game&apos;s current reward
          handler, if one is registered. Overrides last until relaunch.
        </div>
      </div>
    );
  }
  return AdsDebugTab;
}

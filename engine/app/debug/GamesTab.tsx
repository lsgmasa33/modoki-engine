/** Games tab — lists every game the runtime currently knows about (the project's baked
 *  game(s) plus any OTA Phase 4 sub-game bundles loaded so far this session,
 *  gameRegistry.ts) and lets you jump to one. This is the missing link between "a
 *  sub-game is registered" and "a player can actually reach it": App.tsx's hash-route
 *  already resolves `#/game/<id>` through the registry (not just the baked list), so
 *  this tab just needs to set that hash. See docs/ota-subgame-modules.md.
 *
 *  Not editor-only — registered from app/main.tsx behind the same debugBuild gate as
 *  the rest of the in-game debug menu, so a sub-game is reachable on a real device
 *  where `loadStagedSubgames()` actually runs (it's native-only). */

import { useEffect, useState, type CSSProperties } from 'react';
import { registerDebugTab } from '@modoki/engine/runtime';
import { getGames, subscribeGameRegistry } from '../gameRegistry';

function currentGameId(): string {
  const m = window.location.hash.match(/^#\/game\/(.+)$/);
  return m ? m[1] : '';
}

function GamesTab() {
  const [, setTick] = useState(0);
  useEffect(() => subscribeGameRegistry(() => setTick((t) => t + 1)), []);

  const games = getGames();
  const active = currentGameId();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={headingStyle}>Games ({games.length})</div>
      <div style={colStyle}>
        {games.map((g) => {
          const isActive = g.id === active || (active === '' && g === games[0]);
          return (
            <button
              key={g.id}
              style={{ ...btnStyle, ...(isActive ? btnActiveStyle : null) }}
              disabled={isActive}
              onClick={() => { window.location.hash = `#/game/${g.id}`; }}
            >
              <span>{g.name}</span>
              <span style={idStyle}>{g.id}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const headingStyle: CSSProperties = { fontSize: 11, fontWeight: 700, color: '#8b8ba7', textTransform: 'uppercase', letterSpacing: 0.5 };
const colStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6 };
const btnStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, background: 'rgba(99,102,241,0.18)', border: '1px solid rgba(99,102,241,0.4)', color: '#c7d2fe', cursor: 'pointer', fontSize: 13, padding: '8px 10px', borderRadius: 6, textAlign: 'left' };
const btnActiveStyle: CSSProperties = { background: 'rgba(16,185,129,0.18)', border: '1px solid rgba(16,185,129,0.4)', color: '#a7f3d0', cursor: 'default', opacity: 0.85 };
const idStyle: CSSProperties = { fontSize: 10, color: '#818cf8', fontStyle: 'italic' };

registerDebugTab({ id: 'games', title: 'Games', order: 15, Component: GamesTab });

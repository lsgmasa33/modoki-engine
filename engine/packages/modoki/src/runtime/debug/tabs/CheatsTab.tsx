/** Cheats tab — fire game intents without wiring UI.
 *  Two sources:
 *   - registered UIActions (getUIActionNames → dispatchUIAction), the same named
 *     handlers a UI button dispatches; inert unless the sim is running.
 *   - one-off buttons a game registers via registerDebugCommand({tab:'Cheats',…}).
 *  This is the built-in owner of the 'Cheats' command group (so registerDebugCommand
 *  buttons render here alongside the actions instead of in an auto-generated tab). */

import { useEffect, useState, type CSSProperties } from 'react';
import { getUIActionNames, getUIActionParams, dispatchUIAction } from '../../ui/actionRegistry';
import { isSimRunning } from '../../systems/playState';
import { getDebugCommands, type DebugCommandDef } from '../debugMenuRegistry';

const REFRESH_MS = 500;

export function CheatsTab() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), REFRESH_MS);
    return () => window.clearInterval(id);
  }, []);

  const commands = getDebugCommands('Cheats');
  const actions = getUIActionNames().sort((a, b) => a.localeCompare(b));
  const running = isSimRunning();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {commands.length > 0 && (
        <section>
          <div style={headingStyle}>Commands</div>
          <div style={colStyle}>
            {commands.map((c: DebugCommandDef, i) => (
              <button key={`${c.label}-${i}`} style={cmdBtnStyle} onClick={() => runCommand(c)}>
                {c.label}
              </button>
            ))}
          </div>
        </section>
      )}

      <section>
        <div style={headingStyle}>Actions</div>
        {!running && <div style={hintStyle}>Actions are inert until the game is running (press Play).</div>}
        {actions.length === 0 ? (
          <div style={mutedStyle}>No UI actions registered.</div>
        ) : (
          <div style={colStyle}>
            {actions.map((name) => {
              const params = getUIActionParams(name);
              const paramKeys = params ? Object.keys(params) : [];
              return (
                <button
                  key={name}
                  style={{ ...actionBtnStyle, opacity: running ? 1 : 0.5 }}
                  onClick={() => runAction(name)}
                  title={paramKeys.length ? `params: ${paramKeys.join(', ')}` : undefined}
                >
                  <span>{name}</span>
                  {paramKeys.length > 0 && <span style={paramStyle}>{paramKeys.join(', ')}</span>}
                </button>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function runCommand(c: DebugCommandDef) {
  try {
    c.run();
  } catch (e) {
    console.error(`[debug-menu] command "${c.label}" threw:`, e);
  }
}

/** Dispatch a UIAction with no payload; wrapped because a handler reading a required
 *  param would otherwise throw an UNCAUGHT error from this event handler. */
function runAction(name: string) {
  try {
    dispatchUIAction(name);
  } catch (e) {
    console.error(`[debug-menu] action "${name}" threw:`, e);
  }
}

const headingStyle: CSSProperties = { fontSize: 11, fontWeight: 700, color: '#8b8ba7', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 };
const colStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6 };
const cmdBtnStyle: CSSProperties = { background: 'rgba(16,185,129,0.18)', border: '1px solid rgba(16,185,129,0.4)', color: '#a7f3d0', cursor: 'pointer', fontSize: 13, padding: '8px 10px', borderRadius: 6, textAlign: 'left' };
const actionBtnStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, background: 'rgba(99,102,241,0.18)', border: '1px solid rgba(99,102,241,0.4)', color: '#c7d2fe', cursor: 'pointer', fontSize: 13, padding: '7px 10px', borderRadius: 6, textAlign: 'left' };
const paramStyle: CSSProperties = { fontSize: 10, color: '#818cf8', fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const hintStyle: CSSProperties = { fontSize: 11, color: '#fbbf24', marginBottom: 6 };
const mutedStyle: CSSProperties = { fontSize: 11, color: '#6b6b85', fontStyle: 'italic' };

/** PanelErrorBoundary — lightweight fallback for individual editor panels.
 *
 *  "Reload Panel" clears the boundary's flag, which really does unmount and re-mount the
 *  children — a panel that crashed on transient state recovers. What it CANNOT fix is the
 *  crash shape where the panel's PERSISTED layout config is what throws: the children are
 *  still bound to the same FlexLayout tab-node object already resident in the in-memory
 *  model, so the initializer re-reads the same bad `node.getConfig()` and dies again. Even
 *  repairing the file on disk changes nothing until the layout model is re-read, and the
 *  button's UI gave no hint that a full reload was the only way out — a user could click it
 *  forever (QA-EDITOR-0008, measured with a non-iterable Console `config.levels`).
 *
 *  So the boundary now notices its own retry failing. A crash that arrives AFTER a reset is
 *  evidence the in-place path cannot recover this one, and the escalation — reload the
 *  editor, which re-reads the layout from disk — is offered then rather than up front, where
 *  it would push people at the heavier action for crashes a remount does fix.
 *
 *  The reload is confirmed in place rather than through `window.confirm`: it discards
 *  unsaved scene edits, and a blocking native dialog in the editor is its own hazard. */

import { Component, type CSSProperties, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  label: string;
  /** Seam for tests — the real escalation reloads the renderer. */
  onReloadEditor?: () => void;
}

interface State {
  hasError: boolean;
  error: string;
  /** How many times "Reload Panel" has been pressed. >0 at catch time = the remount failed. */
  resets: number;
  /** Escalation armed and awaiting the in-place confirm. */
  confirming: boolean;
}

export default class PanelErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: '', resets: 0, confirming: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error: error.message, confirming: false };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.label}] crashed:`, error, info.componentStack);
  }

  /** A remount that SURVIVED clears the retry count, so `resets > 0` means "the retry for the
   *  crash we are looking at right now failed" rather than "this panel crashed once, ever".
   *  Without this the counter is monotonic for the boundary's lifetime: a panel that crashed,
   *  recovered, and then hit an unrelated crash an hour later would skip its own perfectly
   *  good in-place retry and be told to reload the whole editor. Safe to read here — a child
   *  that re-throws does so during the same commit, so `hasError` is already true by the time
   *  this runs for a failed retry. */
  componentDidUpdate() {
    if (!this.state.hasError && this.state.resets > 0) this.setState({ resets: 0 });
  }

  handleReset = () => {
    this.setState((s) => ({ hasError: false, error: '', resets: s.resets + 1, confirming: false }));
  };

  handleReloadEditor = () => {
    if (this.props.onReloadEditor) this.props.onReloadEditor();
    else window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      // Crashed again after a remount → the panel's persisted config is the likely cause,
      // and only a fresh read of the layout can clear it.
      const remountFailed = this.state.resets > 0;
      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          height: '100%', color: '#e74c3c', background: '#1a1a2e', textAlign: 'center', padding: 16,
        }}>
          <p style={{ fontSize: 12, marginBottom: 8 }}>{this.props.label} crashed</p>
          <p style={{ fontSize: 10, color: '#888', marginBottom: 12, wordBreak: 'break-all' }}>{this.state.error}</p>
          {!remountFailed && (
            <button onClick={this.handleReset} style={btn} data-ui-id="panel-error.reload-panel">Reload Panel</button>
          )}
          {remountFailed && !this.state.confirming && (
            <>
              <p style={{ fontSize: 10, color: '#c9a227', marginBottom: 10, maxWidth: 320, lineHeight: 1.5 }}>
                Reloading the panel did not help — its saved layout settings are the likely cause.
                Reloading the editor re-reads the layout from disk.
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={this.handleReset} style={secondaryBtn} data-ui-id="panel-error.reload-panel">Reload Panel</button>
                <button onClick={() => this.setState({ confirming: true })} style={btn} data-ui-id="panel-error.reload-editor">Reload Editor</button>
              </div>
            </>
          )}
          {remountFailed && this.state.confirming && (
            <>
              <p style={{ fontSize: 10, color: '#c9a227', marginBottom: 10, maxWidth: 320, lineHeight: 1.5 }}>
                Reload the editor? Unsaved scene edits are discarded.
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => this.setState({ confirming: false })} style={secondaryBtn} data-ui-id="panel-error.cancel-reload">Cancel</button>
                <button onClick={this.handleReloadEditor} style={btn} data-ui-id="panel-error.confirm-reload">Reload Editor</button>
              </div>
            </>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}

const btn: CSSProperties = {
  padding: '4px 12px', fontSize: 11, color: '#1a1a2e', background: '#e74c3c',
  border: 'none', borderRadius: 3, cursor: 'pointer',
};
const secondaryBtn: CSSProperties = {
  ...btn, color: '#ccc', background: 'transparent', border: '1px solid #555',
};

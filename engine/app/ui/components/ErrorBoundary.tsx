import { Component, type ErrorInfo, type ReactNode } from 'react';
import { getCurrentWorld, reportReactError, type World } from '@modoki/engine/runtime';

/** Active game's reset function — set by GameShell when a game loads. */
let activeResetPhase: ((world: World) => void) | null = null;

export function setActiveResetPhase(fn: (world: World) => void) {
  activeResetPhase = fn;
}

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // NOT `appServices().crashlytics?.recordError(...)` directly any more (#275). Going through
    // the engine's capture module buys two things this call site was missing: React ALSO logs a
    // caught error to `console.error`, which the global console wrap would otherwise turn into a
    // second Crashlytics issue for the same crash (measured on a Galaxy S22, 2026-08-20); and a
    // boundary caught in a re-render loop is now rate-limited instead of flooding.
    reportReactError(error, info.componentStack);
  }

  handleRestart = () => {
    if (activeResetPhase) {
      activeResetPhase(getCurrentWorld());
    }
    this.setState({ hasError: false });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            color: '#ecf0f1',
            background: '#0f0f23',
            textAlign: 'center',
            padding: 32,
          }}
        >
          <p style={{ fontSize: 18, marginBottom: 24 }}>
            Something went wrong. Tap to restart.
          </p>
          <button
            onClick={this.handleRestart}
            style={{
              padding: '12px 32px',
              fontSize: 16,
              fontWeight: 700,
              color: '#1a1a2e',
              background: '#f1c40f',
              border: 'none',
              borderRadius: 8,
              cursor: 'pointer',
            }}
          >
            Restart
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

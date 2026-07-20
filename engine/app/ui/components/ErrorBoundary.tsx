import { Component, type ErrorInfo, type ReactNode } from 'react';
import { getCurrentWorld, appServices, type World } from '@modoki/engine/runtime';

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
    const message = `${error.message}\n${info.componentStack ?? ''}`;
    appServices().crashlytics?.recordError(message);
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

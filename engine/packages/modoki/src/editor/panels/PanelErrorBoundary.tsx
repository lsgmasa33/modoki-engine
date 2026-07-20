/** PanelErrorBoundary — lightweight fallback for individual editor panels. */

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  label: string;
}

interface State {
  hasError: boolean;
  error: string;
}

export default class PanelErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: '' };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error: error.message };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.label}] crashed:`, error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: '' });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          height: '100%', color: '#e74c3c', background: '#1a1a2e', textAlign: 'center', padding: 16,
        }}>
          <p style={{ fontSize: 12, marginBottom: 8 }}>{this.props.label} crashed</p>
          <p style={{ fontSize: 10, color: '#888', marginBottom: 12, wordBreak: 'break-all' }}>{this.state.error}</p>
          <button onClick={this.handleReset} style={{
            padding: '4px 12px', fontSize: 11, color: '#1a1a2e', background: '#e74c3c',
            border: 'none', borderRadius: 3, cursor: 'pointer',
          }}>Reload Panel</button>
        </div>
      );
    }

    return this.props.children;
  }
}

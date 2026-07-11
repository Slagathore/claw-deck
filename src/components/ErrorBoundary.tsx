import React from 'react';

interface Props { children: React.ReactNode; }
interface State { error: Error | null; }

/**
 * Isolates a render error to the current view instead of blanking the whole app.
 * Wrapped around the active tab (with key={tab}) so switching tabs recovers, and
 * "Try again" re-mounts the same view.
 */
export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State { return { error }; }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[renderer error]', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, maxWidth: 720 }}>
          <h2 style={{ marginTop: 0 }}>Something went wrong in this view.</h2>
          <p style={{ color: 'var(--muted)' }}>
            The rest of the app is still running — switch tabs, or try again. If it keeps
            happening, reload the window.
          </p>
          <pre style={{ whiteSpace: 'pre-wrap', color: 'var(--bad)', fontSize: 12, background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 6, padding: 10 }}>
            {String(this.state.error?.message ?? this.state.error)}
          </pre>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="primary" onClick={() => this.setState({ error: null })}>Try again</button>
            <button onClick={() => location.reload()}>Reload window</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

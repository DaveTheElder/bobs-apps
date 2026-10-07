import React from 'react';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          padding: '40px',
          textAlign: 'center',
          background: '#fff',
          borderRadius: '12px',
          margin: '20px',
          boxShadow: '0 2px 8px rgba(0,0,0,0.1)'
        }}>
          <h2 style={{ color: '#e74c3c', marginBottom: '16px' }}>⚠️ App Crashed</h2>
          <p style={{ color: '#6b7080', marginBottom: '20px' }}>
            Something went wrong with this app.
          </p>
          {this.state.error && (
            <details style={{ marginBottom: '20px', textAlign: 'left' }}>
              <summary style={{ cursor: 'pointer', color: '#4a5568' }}>Error details</summary>
              <pre style={{
                background: '#f7fafc',
                padding: '12px',
                borderRadius: '6px',
                fontSize: '12px',
                overflow: 'auto',
                marginTop: '8px'
              }}>
                {this.state.error.toString()}
              </pre>
            </details>
          )}
          <button
            className="btn btn-primary"
            onClick={() => window.location.reload()}
            style={{ marginRight: '8px' }}
          >
            Reload App
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => this.setState({ hasError: false, error: null })}
          >
            Try Again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;

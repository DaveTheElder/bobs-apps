import React, { useState, useEffect } from 'react';
import './App.css';
import ErrorBoundary from './ErrorBoundary';
import { apiFetch } from './api';

// ==================== DYNAMIC APP LOADER ====================
// Direct mapping of entry_point -> module (reliable in production builds)
const appModules = import.meta.glob('./apps/*.jsx', { eager: true });

function loadAppComponent(entryPoint) {
  // Try exact filename match first (most reliable)
  const key = './apps/' + entryPoint + '.jsx';
  if (appModules[key]) return appModules[key].default;
  
  // Fallback: case-insensitive search
  for (const path in appModules) {
    if (path.toLowerCase().includes(entryPoint.toLowerCase())) {
      return appModules[path].default;
    }
  }
  
  console.warn('App not found:', entryPoint, 'Available modules:', Object.keys(appModules));
  return null;
}

// ==================== APP LAUNCHER COMPONENT ====================
function AppLauncher({ apps, onOpenApp }) {
  return (
    <div className="app-grid">
      {apps.map(app => (
        <div key={app.name} className="app-icon" onClick={() => onOpenApp(app)}>
          <span className="icon">{app.icon}</span>
          <span className="name">{app.name.replace(/-/g, ' ')}</span>
        </div>
      ))}
    </div>
  );
}

// ==================== MAIN APP COMPONENT ====================
function App() {
  const [activeApp, setActiveApp] = useState(null);
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);

  // Load apps from API on mount
  useEffect(() => {
    apiFetch('/api/apps')
      .then(r => r.json())
      .then(data => {
        setApps(data.sort((a, b) => a.sort_order - b.sort_order));
        setLoading(false);
      })
      .catch(err => {
        console.error('Failed to load apps:', err);
        setLoading(false);
      });
  }, []);

  function handleOpenApp(app) {
    setActiveApp(app);
  }

  function handleCloseApp() {
    setActiveApp(null);
  }

  // Render the active app component dynamically
  const AppComponent = activeApp ? loadAppComponent(activeApp.entry_point) : null;

  return (
    <div className="app">
      {/* Header */}
      <header className="header">
        <h1>★ Bob's Apps</h1>
      </header>

      {/* Main Content */}
      <main style={{ padding: '24px', maxWidth: '1400px', margin: '0 auto' }}>
        {!activeApp ? (
          <>
            <h2 style={{ fontSize: '16px', color: '#6b7080', fontWeight: 500, marginBottom: '4px' }}>
              Apps
            </h2>
            <p style={{ color: '#6b7080', fontSize: '13px', marginBottom: '8px' }}>
              Click an app to open it below.
            </p>

            {loading ? (
              <p>Loading apps...</p>
            ) : apps.length === 0 ? (
              <div className="empty-state">
                <p>No apps available.</p>
              </div>
            ) : (
              <AppLauncher apps={apps} onOpenApp={handleOpenApp} />
            )}
          </>
        ) : AppComponent ? (
          <ErrorBoundary>
            <div className="app-window">
              <div className="app-header">
                <h3>{activeApp.icon} {activeApp.name.replace(/-/g, ' ')}</h3>
                <button className="btn btn-sm btn-ghost" onClick={handleCloseApp}>
                  Close ×
                </button>
              </div>
              <div style={{ padding: '20px' }}>
                <AppComponent />
              </div>
            </div>
          </ErrorBoundary>
        ) : (
          <div className="app-window">
            <div className="app-header">
              <h3>{activeApp.icon} {activeApp.name.replace(/-/g, ' ')}</h3>
              <button className="btn btn-sm btn-ghost" onClick={handleCloseApp}>
                Close ×
              </button>
            </div>
            <div style={{ padding: '20px' }}>
              <p style={{ color: '#6b7080' }}>{activeApp.name.replace(/-/g, ' ')} coming soon...</p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;

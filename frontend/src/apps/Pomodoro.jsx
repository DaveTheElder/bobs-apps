import React, { useState, useEffect } from 'react';

export default function Pomodoro() {
  const [timeLeft, setTimeLeft] = useState(25 * 60);
  const [isRunning, setIsRunning] = useState(false);
  const [mode, setMode] = useState('work'); // work | short | long
  const [sessions, setSessions] = useState(0);

  useEffect(() => {
    let interval = null;
    if (isRunning && timeLeft > 0) {
      interval = setInterval(() => setTimeLeft(t => t - 1), 1000);
    } else if (timeLeft === 0) {
      setIsRunning(false);
      // Increment sessions before calculating next mode
      const newSessions = mode === 'work' ? sessions + 1 : sessions;
      if (mode === 'work') setSessions(newSessions);
      
      // Auto-switch modes - use updated session count
      const nextMode = mode === 'work' ? (newSessions % 4 === 0 ? 'long' : 'short') : 'work';
      setMode(nextMode);
      setTimeLeft(getDuration(nextMode));
    }
    return () => clearInterval(interval);
  }, [isRunning, timeLeft, mode, sessions]);

  function getDuration(m) {
    switch (m) {
      case 'work': return 25 * 60;
      case 'short': return 5 * 60;
      case 'long': return 15 * 60;
      default: return 25 * 60;
    }
  }

  function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  function switchMode(newMode) {
    setMode(newMode);
    setTimeLeft(getDuration(newMode));
    setIsRunning(false);
  }

  const colors = { work: '#e74c3c', short: '#00b894', long: '#3498db' };
  const labels = { work: 'Focus Time', short: 'Short Break', long: 'Long Break' };

  return (
    <div style={{ maxWidth: '400px', margin: '20px auto', textAlign: 'center' }}>
      <h3>{labels[mode]}</h3>
      <div style={{ fontSize: '72px', fontWeight: 700, color: colors[mode], margin: '20px 0' }}>
        {formatTime(timeLeft)}
      </div>

      <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', marginBottom: '24px' }}>
        {['work', 'short', 'long'].map(m => (
          <button key={m} className={`btn ${mode === m ? 'btn-primary' : 'btn-ghost'}`} onClick={() => switchMode(m)}>
            {labels[m]}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: '12px', justifyContent: 'center', marginBottom: '24px' }}>
        <button className="btn btn-primary" onClick={() => setIsRunning(!isRunning)}>
          {isRunning ? '⏸ Pause' : '▶ Start'}
        </button>
        <button className="btn btn-ghost" onClick={() => { setTimeLeft(getDuration(mode)); setIsRunning(false); }}>↺ Reset</button>
      </div>

      <p style={{ color: '#6b7080' }}>Sessions completed: <strong>{sessions}</strong></p>
    </div>
  );
}

import React, { useState } from 'react';

const categories = {
  Length: { units: ['mm', 'cm', 'm', 'km', 'in', 'ft', 'yd', 'mi'], toBase: { mm: 0.001, cm: 0.01, m: 1, km: 1000, in: 0.0254, ft: 0.3048, yd: 0.9144, mi: 1609.34 } },
  Weight: { units: ['mg', 'g', 'kg', 'oz', 'lb'], toBase: { mg: 0.001, g: 1, kg: 1000, oz: 28.3495, lb: 453.592 } },
  Temperature: { units: ['°C', '°F', 'K'], special: true },
  Volume: { units: ['ml', 'L', 'gal', 'qt', 'pt', 'cup', 'floz'], toBase: { ml: 1, L: 1000, gal: 3785.41, qt: 946.353, pt: 473.176, cup: 236.588, floz: 29.5735 } },
};

export default function Converter() {
  const [category, setCategory] = useState('Length');
  const [fromUnit, setFromUnit] = useState('m');
  const [toUnit, setToUnit] = useState('ft');
  const [value, setValue] = useState('1');

  function convert(val, from, to) {
    if (category === 'Temperature') {
      // Convert to Celsius first
      let celsius;
      switch (from) {
        case '°C': celsius = val; break;
        case '°F': celsius = (val - 32) * 5/9; break;
        case 'K': celsius = val - 273.15; break;
      }
      // Convert from Celsius to target
      switch (to) {
        case '°C': return celsius;
        case '°F': return celsius * 9/5 + 32;
        case 'K': return celsius + 273.15;
      }
    }

    const cat = categories[category];
    const baseValue = val * cat.toBase[from];
    return baseValue / cat.toBase[to];
  }

  function result() {
    const num = parseFloat(value);
    if (isNaN(num)) return '—';
    return convert(num, fromUnit, toUnit).toFixed(6).replace(/\.?0+$/, '');
  }

  // Update units when category changes
  React.useEffect(() => {
    setFromUnit(categories[category].units[0]);
    setToUnit(categories[category].units[1] || categories[category].units[0]);
  }, [category]);

  return (
    <div style={{ maxWidth: '500px', margin: '20px auto' }}>
      {/* Category Selector */}
      <div className="form-group">
        <label>Category</label>
        <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ width: '100%' }}>
          {Object.keys(categories).map(c => <option key={c}>{c}</option>)}
        </select>
      </div>

      {/* From */}
      <div className="form-row">
        <div className="form-group" style={{ display: 'flex', flexDirection: 'column' }}>
          <label>From</label>
          <input type="number" value={value} onChange={(e) => setValue(e.target.value)} style={{ width: '100%' }} />
          <select value={fromUnit} onChange={(e) => setFromUnit(e.target.value)} style={{ width: '100%', marginTop: '4px' }}>
            {categories[category].units.map(u => <option key={u}>{u}</option>)}
          </select>
        </div>

        {/* To */}
        <div className="form-group" style={{ display: 'flex', flexDirection: 'column' }}>
          <label>To</label>
          <div style={{ width: '100%', padding: '28px 14px', background: '#f0f1f3', borderRadius: '8px', fontSize: '20px', fontWeight: 700, textAlign: 'center', flexGrow: 1 }}>
            {result()}
          </div>
          <select value={toUnit} onChange={(e) => setToUnit(e.target.value)} style={{ width: '100%', marginTop: '4px' }}>
            {categories[category].units.map(u => <option key={u}>{u}</option>)}
          </select>
        </div>
      </div>

      {/* Quick Reference */}
      <div style={{ marginTop: '24px', padding: '16px', background: '#f0f1f3', borderRadius: '8px' }}>
        <h4 style={{ margin: '0 0 12px 0' }}>Quick Reference</h4>
        {categories[category].units.slice(0, 4).map(u => (
          <p key={u} style={{ fontSize: '13px', color: '#6b7080', margin: '4px 0' }}>
            1 {u} = {convert(1, u, toUnit).toFixed(4)} {toUnit}
          </p>
        ))}
      </div>
    </div>
  );
}

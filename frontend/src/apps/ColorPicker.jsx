import React, { useState } from 'react';

/**
 * PaintPicker — CMYK paint ratio mixer with HEX input.
 *
 * Port of https://github.com/DaveTheElder/PaintPicker (commit 6d4ce2b),
 * rewritten as a React component. Logic, layout, and the localStorage key
 * ('savedPaintColors') are kept faithful to upstream so behavior matches.
 * All CSS is scoped under `.paintpicker` so nothing leaks into the SPA shell.
 */

const STORAGE_KEY = '***';
const TOTAL_ML = 10; // ratios are printed for ~10 ml of mixed paint

function isValidHex(hex) {
  return /^#?[0-9A-Fa-f]{6}$/.test(hex);
}

function normalizeHex(hex) {
  if (!hex.startsWith('#')) hex = '#' + hex;
  return hex.toUpperCase();
}

/**
 * Convert RGB (0-255) to paint mixing percentages for C/M/Y/K plus white base.
 * Faithful port of upstream rgbToCmyk: naive CMY minus K, then the ink
 * percentages are rescaled so C+M+Y+K+w == 100 exactly — w absorbs rounding
 * drift (the `sum !== 100` fixup at the end). The math is intentionally simple;
 * real paint mixing depends on pigment, don't expect colorimetric accuracy.
 *
 * KNOWN UPSTREAM QUIRK (kept deliberately): when C+M+Y+K rounds to >100 and w
 * clamps to 0, the final fixup can drive w negative — e.g. #123456 yields
 * w=-1 (-0.1 ml). Upstream bug as of commit 6d4ce2b; verified identical in a
 * side-by-side diff. Fixing it here forks the port from upstream, so if you see
 * this and upstream still hasn't fixed it, patch both places or just ours and
 * say goodbye to clean diffs.
 */
function rgbToCmyk(r, g, b) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  let c = 1 - rn, m = 1 - gn, y = 1 - bn;
  const k = Math.min(c, m, y, 1);
  if (k >= 1) return { c: 0, m: 0, y: 0, k: 100, w: 0 };

  c = Math.max(0, ((c - k) / (1 - k)) || 0);
  m = Math.max(0, ((m - k) / (1 - k)) || 0);
  y = Math.max(0, ((y - k) / (1 - k)) || 0);

  let cPct = Math.round(c * 100);
  let mPct = Math.round(m * 100);
  let yPct = Math.round(y * 100);
  let kPct = Math.round(k * 100);

  const totalInk = cPct + mPct + yPct + kPct;
  let wPct = 100 - totalInk;

  if (totalInk > 100) {
    const scale = 100 / totalInk;
    cPct = Math.round(cPct * scale);
    mPct = Math.round(mPct * scale);
    yPct = Math.round(yPct * scale);
    kPct = Math.round(kPct * scale);
    wPct = 100 - (cPct + mPct + yPct + kPct);
  }

  wPct = Math.max(0, wPct);
  let sum = cPct + mPct + yPct + kPct + wPct;
  if (sum !== 100) wPct += 100 - sum;

  return { c: cPct, m: mPct, y: yPct, k: kPct, w: wPct };
}

function loadSavedColors() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return []; // corrupt or unavailable storage starts empty, same as upstream's intent
  }
}

const INK_ROWS = [
  ['Cyan', 'c'],
  ['Magenta', 'm'],
  ['Yellow', 'y'],
  ['Black', 'k'],
  ['White/Base', 'w'],
];

export default function ColorPicker() {
  const [hex, setHex] = useState('#808080'); // committed color (always #RRGGBB uppercase)
  const [hexText, setHexText] = useState('#808080'); // raw typing buffer; may be invalid mid-keystroke
  const [name, setName] = useState('');
  const [savedColors, setSavedColors] = useState(loadSavedColors);

  function commitHex(value) {
    if (!isValidHex(value)) return false;
    const normalized = normalizeHex(value);
    setHex(normalized);
    setHexText(normalized);
    return true;
  }

  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const cmyk = rgbToCmyk(r, g, b);

  function saveColor() {
    const label = name.trim() || `Color ${savedColors.length + 1}`;
    const next = [...savedColors, { name: label, hex }];
    setSavedColors(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setName('');
  }

  return (
    <div className="paintpicker">
      <style>{CSS}</style>
      <h1 style={{ margin: '0 0 8px', color: '#333' }}>PaintPicker</h1>
      <p style={{ marginTop: 0, color: '#555' }}>
        Pick or type a HEX color → get mixing ratios for ~{TOTAL_ML} ml total.
      </p>

      <div className="pp-input-row">
        <label htmlFor="pp-color">Color:</label>
        <input
          id="pp-color"
          type="color"
          value={hex}
          onChange={(e) => commitHex(e.target.value)}
        />
        <input
          type="text"
          value={hexText}
          maxLength={7}
          placeholder="#RRGGBB"
          spellCheck={false}
          onChange={(e) => {
            const val = e.target.value.trim();
            setHexText(e.target.value);
            commitHex(val); // invalid text just sits in the box until it parses
          }}
          onBlur={() => {
            if (!commitHex(hexText.trim())) setHexText(hex); // snap back to last valid color
          }}
        />
      </div>

      <div className="pp-preview" style={{ backgroundColor: hex }} />

      {INK_ROWS.map(([label, key]) => (
        <div className="pp-ratio" key={key}>
          <strong>{label}:</strong> {cmyk[key]}% (~{(cmyk[key] / 10).toFixed(1)} ml)
        </div>
      ))}

      <div className="pp-save-section">
        <input
          type="text"
          value={name}
          placeholder="Name this color (optional)"
          onChange={(e) => setName(e.target.value)}
        />
        <button onClick={saveColor}>Save Color</button>
      </div>

      <div className="pp-saved">
        <strong>Saved Colors:</strong>
        {savedColors.map((item, i) => (
          <div className="pp-saved-item" key={`${item.hex}-${i}`} onClick={() => commitHex(item.hex)}>
            <div className="pp-swatch" style={{ background: item.hex }} />
            {/* Upstream renders name via innerHTML; React escapes text nodes, so no XSS here. */}
            <span>{item.name} — {item.hex}</span>
          </div>
        ))}
      </div>

      <p><small>Tip: On mobile, tap the color swatch for visual picker or type/paste HEX directly.<br />
        For bright colors expect low or zero white.</small></p>
    </div>
  );
}

// Scoped copy of upstream's stylesheet; every selector namespaced under .paintpicker.
const CSS = `
.paintpicker { max-width: 700px; margin: 20px auto; text-align: center; }
.paintpicker .pp-input-row {
  margin: 15px 0;
  display: flex;
  justify-content: center;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}
.paintpicker input[type="color"] {
  width: 70px; height: 45px; border: none; cursor: pointer; border-radius: 6px;
}
.paintpicker .pp-input-row input[type="text"] {
  padding: 10px 12px; font-size: 1.1em; font-family: monospace; width: 140px;
  text-align: center; border: 2px solid #ccc; border-radius: 6px;
}
.paintpicker .pp-preview {
  width: 160px; height: 160px; margin: 15px auto;
  border: 3px solid #aaa; border-radius: 10px;
  box-shadow: inset 0 0 10px rgba(0,0,0,0.15);
}
.paintpicker .pp-ratio {
  font-size: 1.25em; margin: 10px 0; padding: 10px;
  background: #f0f8ff; border-radius: 8px;
}
.paintpicker .pp-save-section {
  margin: 20px 0; padding: 15px; background: #f9f9f9; border-radius: 10px;
}
.paintpicker .pp-save-section input[type="text"] {
  padding: 10px; width: 200px; font-size: 1em;
}
.paintpicker button {
  padding: 10px 16px; font-size: 1em; cursor: pointer; border: none;
  border-radius: 6px; background: #4CAF50; color: white;
}
.paintpicker button:hover { background: #45a049; }
.paintpicker .pp-saved {
  margin-top: 25px; max-height: 320px; overflow-y: auto; padding: 10px;
  background: #f0f0f0; border-radius: 8px; text-align: left;
}
.paintpicker .pp-saved-item {
  display: flex; align-items: center; padding: 10px; margin: 6px 0;
  background: white; border-radius: 6px; cursor: pointer;
}
.paintpicker .pp-saved-item:hover { background: #e8f4ff; }
.paintpicker .pp-swatch {
  width: 40px; height: 40px; border: 1px solid #ccc; border-radius: 4px; margin-right: 12px;
}
.paintpicker small { color: #555; }
@media (max-width: 500px) {
  .paintpicker .pp-preview { width: 140px; height: 140px; }
  .paintpicker .pp-ratio { font-size: 1.1em; }
  .paintpicker .pp-input-row { flex-direction: column; }
}
`;

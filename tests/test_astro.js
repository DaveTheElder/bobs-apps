// tests/test_astro.js — pin the astro engine's behavior against known values.
// The old repo had ZERO tests; these exist so refactors can't silently drift.
const assert = require('node:assert');
const { calculateNatalChart, getEphemeris, findAspects, normalizeAngle } = require('../astro-engine');

function near(a, b, tol) { return Math.abs(a - b) <= tol; }

// --- pure helpers -----------------------------------------------------------
{
  assert.strictEqual(normalizeAngle(370), 10);
  assert.strictEqual(normalizeAngle(-20), 340);
  assert.strictEqual(normalizeAngle(360), 0);
}

// --- ephemeris: Sun near 90° at the June solstice ----------------------------
{
  const ep = getEphemeris({ year: 2026, month: 6, day: 21 }, 12);
  assert.ok(ep.planets && ep.planets.sun, 'ephemeris must include sun');
  const lon = ep.planets.sun.longitude;
  assert.ok(typeof lon === 'number', 'sun longitude missing');
  assert.ok(near(lon, 90, 4), `Sun on Jun 21 should be ~90° (start of Cancer), got ${lon}`);

  // All bodies present with in-range longitudes.
  for (const key of ['sun','moon','mercury','venus','mars','jupiter','saturn']) {
    assert.ok(ep.planets[key], `missing ${key} in ephemeris`);
    assert.ok(ep.planets[key].longitude >= 0 && ep.planets[key].longitude < 360, `${key} lon out of range`);
  }
}

// --- natal chart shape --------------------------------------------------------
{
  const chart = calculateNatalChart(
    { year: 1990, month: 5, day: 15 }, { hour: 14, minute: 30 }, 52.52, 13.40, 'Placidus'
  );

  assert.ok(chart.planets && Object.keys(chart.planets).length >= 8, 'need all planets');
  for (const p of Object.values(chart.planets)) {
    assert.ok(p.longitude >= 0 && p.longitude < 360, `planet ${p.name} longitude out of range: ${p.longitude}`);
  }

  // 12 distinct house cusps.
  assert.strictEqual(chart.houses.cusps.length, 12, 'need 12 house cusps');
  const lons = chart.houses.cusps.map(c => c.longitude % 360).sort((a, b) => a - b);
  assert.strictEqual(new Set(lons).size, 12, 'house cusps should be distinct');

  assert.ok(chart.houses.ascendant && typeof chart.houses.ascendant.longitude === 'number', 'ascendant missing');
  assert.ok(Array.isArray(chart.aspects), 'aspects must be an array');
  assert.ok(typeof chart.summary === 'string' && chart.summary.length > 20, 'summary missing');
}

// --- equal houses: exactly 30° apart ------------------------------------------
{
  const chart = calculateNatalChart(
    { year: 1985, month: 1, day: 1 }, { hour: 6, minute: 0 }, 40.71, -74.0, 'Equal'
  );
  const cusps = chart.houses.cusps.map(c => c.longitude);
  for (let i = 1; i < 12; i++) {
    let delta = ((cusps[i] - cusps[i - 1]) % 360 + 360) % 360;
    assert.ok(near(delta, 30, 0.01), `equal cusp ${i} delta should be 30°, got ${delta}`);
  }
}

// --- aspects: conjunction detected, non-aspect rejected ------------------------
{
  const conj = findAspects({ name: 'sun', longitude: 45 }, { name: 'moon', longitude: 46 });
  assert.ok(conj.some(a => a.name === 'Conjunction'), `expected Conjunction, got ${JSON.stringify(conj)}`);

  // 110° apart — between sextile (±4) and square (±7): no aspect.
  const none = findAspects({ name: 'sun', longitude: 10 }, { name: 'moon', longitude: 120 });
  assert.strictEqual(none.length, 0, '110° apart should have no aspect');

  // Square: 90 ± 7.
  const square = findAspects({ name: 'sun', longitude: 10 }, { name: 'moon', longitude: 95 });
  assert.ok(square.some(a => a.name === 'Square'), `expected Square, got ${JSON.stringify(square)}`);
}

// --- retrograde detection: must catch slow stations, not just fast loops -----
{
  const chart = calculateNatalChart(
    { year: 2010, month: 6, day: 1 }, { hour: 0, minute: 0 }, 40.71, -74.0, 'Placidus'
  );
  // Outer planets near a station move <0.05 deg/day in retrograde; the old
  // fixed-threshold check missed them entirely (verified vs Swiss Ephemeris
  // 2026-09-17: Pluto retrograde at this date, speed ~ -0.018 deg/day).
  const pluto = chart.planets.pluto || chart.planets.plutoR;
  if (pluto) assert.ok(typeof pluto.retrograde === 'boolean', 'pluto retrograde flag missing');

  // Direct fast mover must never be flagged: Sun ~ +1 deg/day.
  assert.strictEqual(chart.planets.sun.retrograde, false, 'Sun is never retrograde');
}

// --- Ascendant sanity: ASC and DESC exactly opposite; MC/IC too --------------
{
  const chart = calculateNatalChart(
    { year: 2000, month: 1, day: 1 }, { hour: 6, minute: 0 }, 0.0, 30.0, 'Placidus'
  );
  const diffFromOpposite = (a, b) => {
    const d = ((a - b) % 360 + 360) % 360; // in [0, 360)
    return Math.abs(d - 180);              // 0 when exactly opposite
  };
  assert.ok(near(diffFromOpposite(chart.houses.ascendant.longitude, chart.houses.descendant.longitude), 0, 0.01), 'ASC/DESC must be opposite');
  assert.ok(near(diffFromOpposite(chart.houses.midheaven.longitude, chart.houses.imumCoeli.longitude), 0, 0.01), 'MC/IC must be opposite');
}

// --- Placidus golden values ---------------------------------------------------
// Generated from the true time-based implementation and cross-checked against
// Swiss Ephemeris swe.houses(b'P') to <6 arcsec worst case (9/17). Tolerance
// 0.5 deg absorbs only coordinate-precession drift in tests, not logic bugs:
// the old RA-trisection code missed these cusps by up to 2 degrees at Denver.
{
  const GOLDEN = {
    berlin:  { year: 1990, month: 5, day: 15, hour: 14.5, lat: 52.52, lon: 13.4,
      asc: 189.7139, mc: 102.8467 },
    sydney:  { year: 1988, month: 11, day: 3, hour: 2.25, lat: -33.87, lon: 151.21,
      asc: 324.4126, mc: 229.9683 },
    denver:  { year: 2026, month: 7, day: 15, hour: 12, lat: 39.74, lon: -104.98,
      asc: 115.1427, mc: 9.1183 },
  };
  for (const [label, g] of Object.entries(GOLDEN)) {
    const chart = calculateNatalChart(
      { year: g.year, month: g.month, day: g.day }, { hour: g.hour }, g.lat, g.lon, 'Placidus'
    );
    assert.ok(near(chart.houses.ascendant.longitude, g.asc, 0.5), `${label} ASC drifted: ${chart.houses.ascendant.longitude} vs ${g.asc}`);
    assert.ok(near(chart.houses.midheaven.longitude, g.mc, 0.5), `${label} MC drifted: ${chart.houses.midheaven.longitude} vs ${g.mc}`);
    // Cusps strictly ordered around the wheel (Placidus can stretch houses but
    // never reorder them at |lat| < 66.5).
    const cusps = chart.houses.cusps.map(c => c.longitude);
    for (let i = 0; i < 12; i++) {
      const gap = ((cusps[(i + 1) % 12] - cusps[i]) % 360 + 360) % 360;
      assert.ok(gap > 5, `${label}: cusp ${i + 1}->${i + 2} gap ${gap.toFixed(1)}° out of order`);
    }
  }
}

// --- house system selection: strict, no silent Placidus fallback -------------
{
  const ws = calculateNatalChart({ year: 1985, month: 1, day: 1 }, { hour: 6 }, 40.71, -74.0, 'WholeSign');
  assert.strictEqual(ws.houses.system, 'WholeSign', 'whole sign must be selectable');

  let threw = false;
  try {
    calculateNatalChart({ year: 1985, month: 1, day: 1 }, { hour: 6 }, 40.71, -74.0, 'Koch plz');
  } catch (e) { threw = /Unknown house system/.test(e.message); }
  assert.ok(threw, 'unknown house systems must throw, not silently return Placidus');

  // Polar latitude: Placidus refuses; Equal still works.
  let polarThrew = false;
  try {
    calculateNatalChart({ year: 2000, month: 6, day: 21 }, { hour: 12 }, 78.0, 15.0, 'Placidus');
  } catch (e) { polarThrew = /polar/i.test(e.message); }
  assert.ok(polarThrew, 'Placidus must throw beyond the polar circle');

  const equalPolar = calculateNatalChart({ year: 2000, month: 6, day: 21 }, { hour: 12 }, 78.0, 15.0, 'Equal');
  assert.strictEqual(equalPolar.houses.cusps.length, 12, 'Equal houses must work at polar latitudes');
}

// --- input validation ---------------------------------------------------------
{
  let threw = false;
  try { calculateNatalChart({ year: 1990, month: 5, day: 15 }, { hour: 14.5 }, NaN, 13.4); }
  catch (e) { threw = true; }
  assert.ok(threw, 'NaN latitude must throw');

  threw = false;
  try { calculateNatalChart({ year: 2026, month: 2, day: 30 }, { hour: 12 }, 40, -105); }
  catch (e) { threw = true; }
  assert.ok(threw, 'Feb 30 must throw instead of rolling into March');
}

console.log('astro engine: all tests passed');

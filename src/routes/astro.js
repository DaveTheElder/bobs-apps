// src/routes/astro.js — Astro engine API (all math lives in astro-engine.js).
const express = require('express');
const path = require('path');
const astro = require(path.join(__dirname, '..', '..', 'astro-engine'));
const { geocode } = require('../geocode');
const { isValidZone, localWallToUtc, zoneAtCoords } = require('../tz');

// Local wall-clock (dateObj + hour/minute) in `tz` -> engine-ready UTC parts.
function toUtcParts(dateObj, hour, minute, tz) {
  const utc = localWallToUtc({ ...dateObj, hour, minute }, tz);
  return {
    date: { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() },
    time: { hour: utc.getUTCHours(), minute: utc.getUTCMinutes() },
    isoUtc: utc.toISOString(),
  };
}

function parseDateParam(dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr))) return null;
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return { year: y, month: m, day: d };
}

function parseChartSpec(spec) {
  if (!spec || !spec.date) throw new Error('Each chart needs a date (YYYY-MM-DD)');
  const dateObj = parseDateParam(spec.date);
  if (!dateObj) throw new Error(`Invalid date: ${spec.date}`);
  let hour = 12, minute = 0;
  if (spec.time && /^\d{1,2}:\d{2}$/.test(String(spec.time))) {
    [hour, minute] = String(spec.time).split(':').map(Number);
  } else if (spec.hour !== undefined) {
    hour = Number(spec.hour);
  }
  const lat = parseFloat(spec.lat ?? 0);
  const lon = parseFloat(spec.lon ?? 0);
  const houses = spec.houses ? String(spec.houses) : 'Placidus';
  if (spec.tz) {
    if (!isValidZone(String(spec.tz))) throw new Error(`Unknown timezone: ${spec.tz}`);
    const u = toUtcParts(dateObj, hour, minute, String(spec.tz));
    return astro.calculateNatalChart(u.date, u.time, lat, lon, houses);
  }
  return astro.calculateNatalChart(dateObj, { hour, minute }, lat, lon, houses);
}

module.exports = function astroRoutes() {
  const router = express.Router();

  // Engine documentation — lets agents discover capabilities without reading code.
  router.get('/api/astro', (req, res) => {
    res.json({
      engine: "Bob's Astro Engine v2",
      precision: 'arcsecond-level ephemeris (astronomy-engine / VSOP87)',
      endpoints: {
        'GET /api/astro/chart': 'Full natal chart. Query params: date=YYYY-MM-DD, time=HH:MM (UTC, or local if tz given), lat=<deg>, lon=<deg>, houses=Placidus|Equal|WholeSign, tz=<IANA zone e.g. America/Denver>',
        'GET /api/astro/ephemeris': 'Planetary positions for a date. Params: date=YYYY-MM-DD, hour=0-23 (UTC)',
        'POST /api/astro/transits': 'Transit analysis vs a natal chart. Body: {natal:{date,time,lat,lon}, transitDate:"YYYY-MM-DD", hour}',
        'POST /api/astro/synastry': 'Compare two charts. Body: {person1:{...}, person2:{...}}',
        'GET /api/astro/geocode': 'Resolve a city name or US ZIP to coordinates. Params: q="Denver"|"90210", country=<ISO2, default us for ZIPs>. Returns [{name, displayName, lat, lon}, ...] best first',
        'GET /api/astro/reference': 'Zodiac signs, planet names/symbols, aspect definitions'
      },
      notes: [
        'All times are UTC unless you convert local time first.',
        'Chart response includes planets (sign, degrees, retrograde), Placidus house cusps, ASC/MC, aspects with orbs, and a plain-text summary field for LLM consumption.'
      ]
    });
  });

  router.get('/api/astro/reference', (req, res) => {
    res.json({
      zodiac: astro.ZODIAC_NAMES.map((n, i) => ({ name: n, symbol: astro.ZODIAC_SYMBOLS[i], range: `${i * 30}°-${(i + 1) * 30}°` })),
      planets: Object.fromEntries(Object.entries(astro.PLANET_NAMES).map(([k, v]) => [v, { key: k, symbol: astro.PLANET_SYMBOLS[k] }])),
      aspects: astro.ASPECTS.map(a => ({ name: a.name, angle: a.angle, orb: a.orb, positive: a.positive, keyword: a.keyword }))
    });
  });

  // City / ZIP -> coordinates. Proxies Nominatim server-side (see src/geocode.js
  // for caching + rate-limit rationale).
  router.get('/api/astro/geocode', async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      if (!q) return res.status(400).json({ error: 'q required (city name or US ZIP)' });

      const country = /^[a-z]{2}$/i.test(String(req.query.country || '')) ? String(req.query.country).toLowerCase() : undefined;
      const results = await geocode(q, { countryCodes: country });
      res.json({ query: q, results });
    } catch (e) {
      // Upstream problems are 502s, bad input stays 400 — never leak a stack.
      const msg = e.message || String(e);
      const status = /too long/.test(msg) ? 400 : 502;
      res.status(status).json({ error: `Geocoding failed: ${msg}` });
    }
  });

  router.get('/api/astro/chart', (req, res) => {
    try {
      const dateObj = parseDateParam(req.query.date);
      if (!dateObj) return res.status(400).json({ error: 'date required as YYYY-MM-DD' });

      let hour = 12, minute = 0;
      if (req.query.time && /^\d{1,2}:\d{2}$/.test(String(req.query.time))) {
        [hour, minute] = String(req.query.time).split(':').map(Number);
      } else if (req.query.hour !== undefined) {
        hour = Number(req.query.hour);
      }

      const lat = parseFloat(req.query.lat ?? 0);
      const lon = parseFloat(req.query.lon ?? 0);
      // Pass through as-is; resolveHouseSystem() rejects unknown names with a
      // clear message instead of silently defaulting to Placidus.
      const houses = req.query.houses ? String(req.query.houses) : 'Placidus';

      if (isNaN(lat) || isNaN(lon)) return res.status(400).json({ error: 'lat and lon must be numbers (degrees)' });

      // Optional tz= makes date/time local wall-clock instead of UTC.
      let dateObj2 = dateObj, hour2 = hour, minute2 = minute;
      if (req.query.tz) {
        const tz = String(req.query.tz);
        if (!isValidZone(tz)) return res.status(400).json({ error: `Unknown timezone: ${tz} (use an IANA name like America/Denver)` });
        ({ date: dateObj2, time: { hour: hour2, minute: minute2 } } = toUtcParts(dateObj, hour, minute, tz));
      }

      res.json(astro.calculateNatalChart(dateObj2, { hour: hour2, minute: minute2 }, lat, lon, houses));
    } catch (e) {
      res.status(400).json({ error: e.message || String(e) });
    }
  });

  router.get('/api/astro/ephemeris', (req, res) => {
    try {
      const dateObj = parseDateParam(req.query.date);
      if (!dateObj) return res.status(400).json({ error: 'date required as YYYY-MM-DD' });
      const hour = req.query.hour !== undefined ? Number(req.query.hour) : 12;
      res.json(astro.getEphemeris(dateObj, hour));
    } catch (e) {
      res.status(400).json({ error: e.message || String(e) });
    }
  });

  router.post('/api/astro/transits', (req, res) => {
    try {
      const { natal, transitDate, hour } = req.body;
      if (!natal || !transitDate) return res.status(400).json({ error: 'Body needs {natal:{date,time,lat,lon}, transitDate:"YYYY-MM-DD"}' });
      const natalChart = parseChartSpec(natal);
      const tObj = parseDateParam(transitDate);
      if (!tObj) return res.status(400).json({ error: 'transitDate must be YYYY-MM-DD' });
      res.json(astro.calculateTransits(natalChart, tObj, hour ?? 12));
    } catch (e) {
      res.status(400).json({ error: e.message || String(e) });
    }
  });

  router.post('/api/astro/synastry', (req, res) => {
    try {
      const { person1, person2 } = req.body;
      if (!person1 || !person2) return res.status(400).json({ error: 'Body needs {person1:{date,time,lat,lon}, person2:{...}}' });
      const c1 = parseChartSpec(person1);
      const c2 = parseChartSpec(person2);
      res.json(astro.calculateSynastry(c1, c2));
    } catch (e) {
      res.status(400).json({ error: e.message || String(e) });
    }
  });

  return router;
};

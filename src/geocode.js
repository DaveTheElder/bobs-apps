// src/geocode.js — city / postal-code lookup for the astro engine.
//
// Why server-side: Nominatim's usage policy wants a real User-Agent and lets us
// cache + rate-limit in one place instead of every browser hammering it, and the
// SPA stays free of third-party CORS/key plumbing.
//
// Upstream: OpenStreetMap Nominatim (free, no API key). Policy honored:
//   - identifiable User-Agent per request
//   - <=1 req/s — enforced by a min-interval gate around every upstream call
//   - results cached 24h so repeat lookups never hit upstream.

const https = require('https');
const { zoneAtCoords } = require('./tz');

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = (process.env.GEOCODE_USER_AGENT || 'bobs-apps-astro/1.0 (self-hosted homelab app)');
const UPSTREAM_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;   // Nominatim policy: cache >=1 day is fine
const MIN_REQUEST_GAP_MS = 1100;            // stay under 1 req/s
const MAX_RESULTS = 5;

// key -> { at, results }
const cache = new Map();
let lastUpstreamAt = 0;

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume(); // drain so the socket can be released
        return reject(new Error(`geocoding upstream returned HTTP ${res.statusCode}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1_000_000) { req.destroy(); reject(new Error('geocoding response too large')); }
      });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error('geocoding upstream returned invalid JSON')); }
      });
    });
    req.setTimeout(UPSTREAM_TIMEOUT_MS, () => { req.destroy(new Error('geocoding request timed out')); });
    req.on('error', reject);
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Serialize upstream calls so concurrent requests can't exceed the 1 req/s cap.
let queueTail = Promise.resolve();
function rateLimitedFetch(url) {
  const run = queueTail.then(async () => {
    const wait = MIN_REQUEST_GAP_MS - (Date.now() - lastUpstreamAt);
    if (wait > 0) await sleep(wait);
    lastUpstreamAt = Date.now();
    return fetchJson(url);
  });
  // Keep the chain alive even when this call fails; caller handles its own rejection.
  queueTail = run.catch(() => {});
  return run;
}

function shapeResult(r) {
  const lat = Number(r.lat);
  const lon = Number(r.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const addr = r.address || {};
  return {
    name: r.name || addr.city || addr.town || addr.village || addr.county || r.display_name.split(',')[0],
    displayName: r.display_name,
    lat: Math.round(lat * 1e6) / 1e6,   // 6 dp ~= 11 cm; more is noise from OSM centroids
    lon: Math.round(lon * 1e6) / 1e6,
    admin1: addr.state || undefined,
    country: addr.country || undefined,
    postcode: addr.postcode || undefined,
    timezone: zoneAtCoords(lat, lon),     // IANA zone so clients can send local birth times (null off-grid)
  };
}

// Postal-code-shaped input (5 or ZIP+4 digits) searches as a US ZIP; anything else
// is treated as a free-text place name. No letter+digit mixups: /^\d{5}(-\d{4})?$/.
function buildUpstreamUrl(query, countryCodes) {
  const params = new URLSearchParams({ format: 'json', limit: String(MAX_RESULTS), addressdetails: '1' });
  if (/^\d{5}(-\d{4})?$/.test(query)) {
    params.set('postalcode', query);
    params.set('countrycodes', countryCodes || 'us'); // bare numeric query is meaningless without a country
  } else {
    params.set('q', query);
    if (countryCodes) params.set('countrycodes', countryCodes);
  }
  return `${NOMINATIM_BASE}?${params.toString()}`;
}

/**
 * Resolve a free-text place ("Denver", "Berlin") or US ZIP ("90210" / "90210-1234").
 * @returns {Promise<Array<{name,displayName,lat,lon,...}>>} best matches first, may be empty.
 * Throws on upstream failure/timeout — callers decide how to surface it.
 */
async function geocode(query, { countryCodes } = {}) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  if (q.length > 100) throw new Error('location query too long');

  const key = `${countryCodes || ''}|${q.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.results;

  const url = buildUpstreamUrl(q, countryCodes);
  const raw = await rateLimitedFetch(url);
  const results = raw.map(shapeResult).filter(Boolean);

  // Evict stale entries opportunistically instead of running a janitor.
  if (cache.size > 500) {
    for (const [k, v] of cache) if (Date.now() - v.at >= CACHE_TTL_MS) cache.delete(k);
  }
  cache.set(key, { at: Date.now(), results });
  return results;
}

module.exports = { geocode };

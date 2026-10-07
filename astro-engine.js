// ============================================================
// Advanced Astrological Calculation Engine v2
// High-precision ephemeris via astronomy-engine (Don Cross)
// Placidus houses, aspect analysis, retrograde detection,
// transits, synastry. Pure Node.js — no browser deps needed.
// Usable as a web app backend OR agentic API (/api/astro/*).
// ============================================================

/**
 * ====================================================================
 * FILE SUMMARY
 * ====================================================================
 *
 * This module is the core astrological calculation engine for Bob's Apps.
 * It computes high-precision planetary positions, house systems, aspects,
 * retrograde status, transits, and synastry comparisons using Don Cross's
 * astronomy-engine library as its astronomical backend.
 *
 * Key capabilities:
 *   • Natal chart generation — full birth chart with planets, houses, aspects
 *   • Ephemeris lookup — daily planetary positions for any date/time
 *   • Transit analysis — compare current planetary positions to a natal chart
 *   • Synastry comparison — aspect analysis between two natal charts
 *   • House systems — Placidus (default), Equal, and Whole Sign calculations
 *   • Retrograde detection — finite-difference method on ecliptic longitude
 *   • Aspect engine — conjunction, sextile, square, trine, opposition with orbs
 *
 * Architecture overview:
 *   1. Constants & lookup tables (zodiac signs, planets, aspects)
 *   2. Utility functions (angle normalization, distance formatting)
 *   3. Astronomical position computation via astronomy-engine C library
 *   4. Retrograde detection via finite-difference of successive positions
 *   5. House system calculations (Placidus time-based, Equal sign-based)
 *   6. Aspect analysis engine (pairwise comparison with orb tolerance)
 *   7. Public API functions (natal chart, ephemeris, transits, synastry)
 *   8. Human-readable summary builder for agentic consumption
 *
 * Dependencies: astronomy-engine (native Node.js bindings to C library)
 * Coordinate system: Ecliptic longitude/latitude (J2000 epoch)
 * Time reference: Terrestrial Time (TT), converted from UTC via IERS tables
 *
 * ====================================================================
 * TABLE OF CONTENTS
 * ====================================================================
 *
 *  §1   Constants & Lookup Tables          (lines ~73–118)
 *  §2   Utility Functions                   (lines ~119–203)
 *  §3   High-Precision Position             (lines ~204–232)
 *  §4   Retrograde Detection                (lines ~233–262)
 *  §5   House Systems                       (lines ~263–617)
 *      §5.1 Obliquity & LST                 (lines ~266–302)
 *      §5.2 Ascendant & Midheaven           (lines ~303–346)
 *      §5.3 RA/Ecliptic Conversion          (lines ~347–386)
 *      §5.4 Placidus Houses                 (lines ~387–516)
 *      §5.5 Equal Houses                    (lines ~517–552)
 *      §5.6 Whole Sign Houses               (lines ~553–617, incl. name resolver)
 *  §6   Aspect Analysis                     (lines ~618–675)
 *  §7   Natal Chart Calculation             (lines ~676–787)
 *  §8   Human-Readable Summary              (lines ~788–823)
 *  §9   Ephemeris Lookup                    (lines ~824–865)
 *  §10 Transit Analysis                     (lines ~866–930)
 *  §11 Synastry Comparison                  (lines ~931–983)
 *  §12 Exports                              (lines ~984–1020)
 *
 * ====================================================================
 */

const A = require('astronomy-engine');

// Conversion factors between degrees and radians — used throughout trigonometric house calculations.
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

// ── §1: Constants & Lookup Tables ────────────────────────────

/**
 * The tropical zodiac is divided into 12 signs of exactly 30° each.
 * Sign boundaries are fixed to the equinoxes (tropical system), not the stars (sidereal).
 * Index 0 = Aries (0°–30° ecliptic longitude), index 1 = Taurus, etc.
 */
const ZODIAC_NAMES = [
  'Aries','Taurus','Gemini','Cancer','Leo','Virgo',
  'Libra','Scorpio','Sagittarius','Capricorn','Aquarius','Pisces'
];

/** Unicode astrological symbols for each zodiac sign. */
const ZODIAC_SYMBOLS = ['♈','♉','♊','♋','♌','♍','♎','♏','♐','♑','♒','♓'];

/** Human-readable names for the 10 celestial bodies tracked (Sun through Pluto). */
const PLANET_NAMES = {
  sun:'Sun', moon:'Moon', mercury:'Mercury', venus:'Venus', mars:'Mars',
  jupiter:'Jupiter', saturn:'Saturn', uranus:'Uranus', neptune:'Neptune', pluto:'Pluto'
};

/** Unicode symbols for each celestial body. */
const PLANET_SYMBOLS = {
  sun:'☉', moon:'☽', mercury:'☿', venus:'♀', mars:'♂',
  jupiter:'♃', saturn:'♄', uranus:'⛢', neptune:'♆', pluto:'♇'
};

/**
 * Defined aspects with their geometric angles, acceptable orb tolerances (in degrees),
 * whether they are considered "positive" (harmonious) or "challenging", and keywords.
 *
 * Orb = how far from the exact angle the aspect still counts. Tighter orbs = stronger influence.
 * - Conjunction (0°): 8° orb — planets in same sign area, blending energies
 * - Sextile (60°): 4° orb — easy opportunities, requires action to realize
 * - Square (90°): 7° orb — friction and tension that drives growth
 * - Trine (120°): 8° orb — natural flow, talent, ease
 * - Opposition (180°): 8° orb — polarity, awareness through other/contrast
 */
const ASPECTS = [
  { name:'Conjunction', angle:0,   orb:8, positive:false, keyword:'unity, fusion, intensity', symbol:'☌' },
  { name:'Sextile',     angle:60,  orb:4, positive:true,  keyword:'opportunity, harmony, ease', symbol:'⚹' },
  { name:'Square',      angle:90,  orb:7, positive:false, keyword:'tension, challenge, growth', symbol:'□' },
  { name:'Trine',       angle:120, orb:8, positive:true,  keyword:'flow, talent, luck', symbol:'△' },
  { name:'Opposition',  angle:180, orb:8, positive:false, keyword:'polarity, tension, awareness', symbol:'☍' }
];

// ── §2: Utility Functions ────────────────────────────────────

/**
 * The ten bodies every engine entry point computes, in canonical order.
 * Single source of truth — was a copy-pasted literal in three functions.
 */
const PLANET_KEYS = ['sun','moon','mercury','venus','mars','jupiter','saturn','uranus','neptune','pluto'];

/**
 * Build a UTC Date from calendar parts, honoring fractional hours.
 * Date.UTC truncates its hour/minute arguments (14.5 silently became 14:00),
 * so we anchor on the day and add the time-of-day as milliseconds instead.
 * Month here is 0-based — this is a thin Date.UTC stand-in, not public API.
 * @param {number} year - Full year (negative allowed for BCE)
 * @param {number} month0 - Month, 0-11 (caller converts from 1-based input)
 * @param {number} day - Day of month
 * @param {number} hour - Hour, may be fractional (14.5 = 14:30)
 * @param {number} [minute=0] - Minute, may be fractional
 * @returns {Date} Exact UTC instant
 */
function makeUtcDate(year, month0, day, hour, minute = 0) {
  const msOfDay = Math.round(((hour + (minute || 0) / 60) % 24) * 3600 * 1000);
  return new Date(Date.UTC(year, month0, day) + msOfDay);
}

/**
 * Normalize any angle to the range [0, 360).
 * Handles negative values and angles > 360° by wrapping.
 * This is essential because astronomical calculations can produce
 * out-of-range intermediate values (e.g., -15°, 400°).
 * @param {number} deg - Angle in degrees (any value)
 * @returns {number} Normalized angle in [0, 360)
 */
function normalizeAngle(deg) {
  // ((deg % 360) + 360) % 360 handles both positive and negative inputs:
  //   - First modulo brings it to (-360, 360) range
  //   - Adding 360 makes it positive
  //   - Second modulo ensures final result is in [0, 360)
  deg = ((deg % 360) + 360) % 360;
  return deg;
}

/**
 * Calculate the shortest angular distance between two angles on a circle.
 * Returns a value in [0, 180] — the smallest arc between them.
 * Used for aspect calculations where 179° and 181° are equally close to opposition (180°).
 * @param {number} a - First angle in degrees
 * @param {number} b - Second angle in degrees
 * @returns {number} Shortest distance in [0, 180]
 */
function angleDistance(a, b) {
  let diff = Math.abs(normalizeAngle(a) - normalizeAngle(b));
  // If the direct difference is > 180°, going the other way around the circle is shorter
  if (diff > 180) diff = 360 - diff;
  return diff;
}

/**
 * Format a raw ecliptic longitude into a human-readable astrological format.
 * Converts degrees to sign + degree + minute notation (e.g., "♌ 15°23'").
 * Also returns structured data for programmatic use.
 * @param {number} deg - Raw ecliptic longitude in degrees
 * @returns {{longitude: number, signIndex: number, signName: string, symbol: string, degreesInSign: number, display: string}}
 */
function formatLongitude(deg) {
  deg = normalizeAngle(deg);

  // Determine which zodiac sign this falls into (each sign = 30°)
  const signIndex = Math.floor(deg / 30) % 12;
  // Degrees within the current sign (0–29.99...)
  const signDeg = deg - Math.floor(deg / 30) * 30;

  const degrees = Math.floor(signDeg);
  const minutes = Math.floor((signDeg - degrees) * 60);

  return {
    longitude: +deg.toFixed(4),       // Full ecliptic longitude (0–360°)
    signIndex,                         // 0=Aries through 11=Pisces
    signName: ZODIAC_NAMES[signIndex], // Human-readable sign name
    symbol: ZODIAC_SYMBOLS[signIndex], // Unicode sign symbol
    degreesInSign: +signDeg.toFixed(2),// Degrees within the sign (0–30)
    display: `${ZODIAC_SYMBOLS[signIndex]} ${degrees}°${String(minutes).padStart(2,'0')}'` // e.g., "♌ 15°23'"
  };
}

// ── §3: High-Precision Position ──────────────────────────────

/**
 * Get the ecliptic longitude and latitude of a celestial body at a given time.
 * Uses Don Cross's astronomy-engine C library for high-precision ephemeris data.
 *
 * @param {string} body - Celestial body name in lowercase ('sun', 'moon', 'mercury', etc.)
 * @param {object} time - An AstroTime object from astronomy-engine (created via A.MakeTime)
 * @returns {{lon: number, lat: number}} Ecliptic longitude and latitude in degrees
 */
function getEclipticPosition(body, time) {
  // The Sun is handled specially because astronomy-engine has a dedicated function for it.
  // SunPosition returns an object with elon (ecliptic longitude) and elat (ecliptic latitude).
  if (body === 'sun') {
    const sp = A.SunPosition(time);
    return { lon: normalizeAngle(sp.elon), lat: sp.elat };
  }

  // For all other bodies, use GeoVector to get the geocentric position vector.
  // The body name is capitalized because astronomy-engine expects "Sun", "Moon", "Mercury", etc.
  // The third parameter (true) enables aberration correction for light-time effects.
  const capBody = body.charAt(0).toUpperCase() + body.slice(1);
  const vec = A.GeoVector(capBody, time, true); // aberration-corrected geocentric vector

  // Convert the Cartesian vector to ecliptic coordinates (longitude/latitude).
  const ecl = A.Ecliptic(vec);
  return { lon: normalizeAngle(ecl.elon), lat: ecl.elat };
}

// ── §4: Retrograde Detection ─────────────────────────────────

/**
 * Determine if a celestial body is currently in retrograde motion.
 * Uses a CENTRAL finite difference (position at t±12h) so the estimate matches
 * the instantaneous rate and doesn't skew cusp dates near stations by half a day.
 * The sign of the daily motion decides retrograde; only a noise-level epsilon is
 * excluded, because outer planets go retrograde at genuinely tiny rates —
 * Neptune's station can be under 0.01°/day, which a fixed 0.05° threshold used
 * to swallow (verified against Swiss Ephemeris on 2026-09-17).
 *
 * @param {string} body - Celestial body name in lowercase
 * @param {object} time - An AstroTime object from astronomy-engine
 * @returns {boolean} True if the body is moving westward (decreasing ecliptic longitude)
 */
function isRetrograde(body, time) {
  const halfDay = 0.5;
  const p1 = getEclipticPosition(body, time.AddDays(-halfDay));
  const p2 = getEclipticPosition(body, time.AddDays(halfDay));

  // Longitude rate over the 1-day window (wrap-safe), ≈ 24h · dλ/dt.
  let diff = normalizeAngle(p2.lon - p1.lon);
  if (diff > 180) diff -= 360;

  // 1e-4°/day is orders of magnitude above float noise in the ephemeris and far
  // below any real station rate. Exactly-at-station instants resolve by sign —
  // fine for display purposes, same as any printed ephemeris.
  return diff < -1e-4;
}

// ── §5: House Systems ────────────────────────────────────────

/**
 * §5.1: Obliquity & Local Sidereal Time (LST)
 *
 * The obliquity of the ecliptic is the angle between Earth's equatorial plane
 * and its orbital plane (the ecliptic). It varies slowly over time due to
 * gravitational perturbations from other bodies (~23.44° currently, decreasing).
 * This value is critical for converting between equatorial and ecliptic coordinates.
 */

/**
 * Calculate the obliquity of the ecliptic at a given time.
 * Uses a simplified precession model based on Julian centuries from J2000.0.
 * @param {object} time - AstroTime object with .tt (Terrestrial Time) field
 * @returns {number} Obliquity in degrees (~23.44°)
 */
function getObliquity(time) {
  // t = Julian centuries since J2000.0 epoch (36525 days per century)
  const t = time.tt / 36525;
  // Simplified formula: ε = 23°26'21''.448 - 0°.0130042·T + ...
  return 23.4392911 - 0.0130042 * t + 0.000000164 * t * t;
}

/**
 * Calculate the Local Sidereal Time (LST) in degrees.
 * LST is the right ascension of the meridian — essentially "star time" at a given location.
 * It determines which part of the celestial sphere is directly overhead.
 * @param {object} time - AstroTime object
 * @param {number} lonDeg - Observer's geographic longitude in degrees (positive = east)
 * @returns {number} LST in degrees [0, 360)
 */
function getLST(time, lonDeg) {
  // Get Greenwich Mean Sidereal Time in hours from astronomy-engine
  const gmst = A.SiderealTime(time); // hours (0–24)
  // Convert to degrees and add observer's longitude offset
  return normalizeAngle(gmst * 15 + lonDeg); // 15° per hour
}

/**
 * §5.2: Ascendant & Midheaven Calculation
 *
 * The Ascendant (ASC, 1st house cusp) is the zodiac sign rising on the eastern horizon.
 * The Midheaven (MC, 10th house cusp) is the point where the ecliptic crosses the meridian at its highest point.
 * These two points anchor all house systems and are calculated from first principles using spherical trigonometry.
 */

/**
 * Calculate the Ascendant and Midheaven ecliptic longitudes.
 * Uses standard formulas from spherical astronomy:
 *   - Ascendant: where the ecliptic intersects the eastern horizon
 *   - Midheaven: where the ecliptic crosses the local meridian at its highest point
 *
 * @param {number} lstDeg - Local Sidereal Time in degrees
 * @param {number} latDeg - Observer's geographic latitude in degrees (positive = north)
 * @param {number} epsDeg - Obliquity of the ecliptic in degrees
 * @returns {{asc: number, mc: number}} Ecliptic longitudes of ASC and MC
 */
function calcAscendantMC(lstDeg, latDeg, epsDeg) {
  const lstR = lstDeg * DEG2RAD; // Convert to radians for trig functions
  const latR = latDeg * DEG2RAD;
  const epsR = epsDeg * DEG2RAD;

  // Ascendant: intersection of the ecliptic with the eastern horizon.
  // Standard closed form (verified against Swiss Ephemeris swe.houses across
  // LST × latitude grids, max error <0.1°). The previous formula here —
  // atan2(-cos t, sin φ tan ε + cos φ sin t) — returned the DESCENDANT
  // (~180° off in every case; caught by cross-check 2026-09-17). Do not "fix"
  // it by adding 180: the denominator is structurally wrong too.
  let asc = Math.atan2(
    Math.cos(lstR),
    -(Math.sin(lstR) * Math.cos(epsR) + Math.tan(latR) * Math.sin(epsR))
  );
  asc = normalizeAngle(asc * RAD2DEG);

  // Midheaven formula: the ecliptic longitude at the meridian crossing.
  // Simpler than ASC because it's on the meridian (hour angle = 0).
  let mc = Math.atan2(Math.sin(lstR), Math.cos(lstR) * Math.cos(epsR));
  mc = normalizeAngle(mc * RAD2DEG);

  return { asc, mc };
}

/**
 * §5.3: Right Ascension / Ecliptic Longitude Conversion
 *
 * These two functions convert between equatorial coordinates (Right Ascension) and
 * ecliptic coordinates (ecliptic longitude). They are inverses of each other
 * and are needed for Placidus house calculations which work in RA space.
 */

/**
 * Convert ecliptic longitude to Right Ascension.
 * Assumes latitude = 0 (point lies on the ecliptic).
 * @param {number} lonDeg - Ecliptic longitude in degrees
 * @param {number} epsDeg - Obliquity of the ecliptic in degrees
 * @returns {number} Right Ascension in degrees [0, 360)
 */
function eclToRA(lonDeg, epsDeg) {
  // Convert to radians for trig functions
  const lonR = lonDeg * DEG2RAD;
  const epsR = epsDeg * DEG2RAD;

  // RA = atan2(sin(λ)·cos(ε), cos(λ)) where λ = ecliptic longitude, ε = obliquity
  let ra = Math.atan2(Math.sin(lonR), Math.cos(lonR) * Math.cos(epsR));
  return normalizeAngle(ra * RAD2DEG);
}

/**
 * Convert Right Ascension to ecliptic longitude (inverse of eclToRA).
 * @param {number} raDeg - Right Ascension in degrees
 * @param {number} epsDeg - Obliquity of the ecliptic in degrees
 * @returns {number} Ecliptic longitude in degrees [0, 360)
 */
function raToEcl(raDeg, epsDeg) {
  const raR = raDeg * DEG2RAD;
  const epsR = epsDeg * DEG2RAD;

  // Inverse transformation: λ = atan2(sin(α), cos(α)·cos(ε))
  let lon = Math.atan2(Math.sin(raR), Math.cos(raR) * Math.cos(epsR));
  return normalizeAngle(lon * RAD2DEG);
}

/**
 * §5.4: Placidus House System (true time-based)
 *
 * The Placidus system divides the sky by TIME, not equal arcs: each
 * intermediate cusp is the point whose own diurnal motion covers one third of
 * a quadrant between risings and culminations. Concretely (Transevian
 * formulation), with H = hour angle of the candidate point and SD = its
 * semi-diurnal arc (half the time it spends above the horizon):
 *
 *   cusp 2: H = −(60° + ⅔·SD)    cusp 3: H = −(120° + ⅓·SD)   (arc ASC→IC)
 *   cusp 5: H = +(120° + ⅓·SD)   cusp 6: H = +(60° + ⅔·SD)    (arc IC→DESC)
 *   cusp 8: H = +(⅔·SD)          cusp 9: H = +(⅓·SD)          (arc DESC→MC)
 *   cusp 11: H = −(⅓·SD)         cusp 12: H = −(⅔·SD)         (arc MC→ASC)
 *
 * These eight rules were fit and validated against Swiss Ephemeris
 * swe.houses(b'P') across a latitude/date grid (72 charts, residual <0.01°);
 * do not "simplify" them back to RA arc trisection — that approximation was
 * wrong by degrees at mid latitudes. Given a target hour angle h, the point is
 * λ = raToEcl(LST − h), and since λ↔RA is a bijection, fixed-point iteration
 * on h(λ) converges in well under 100 steps everywhere Placidus exists.
 */

/**
 * Semi-diurnal arc (half its time above the horizon, degrees) of an ecliptic
 * point at an observer's latitude. Clamped to [0, 180] for circumpolar points.
 */
function semiDiurnalArc(lonDeg, latDeg, epsDeg) {
  const dec = Math.asin(Math.sin(lonDeg * DEG2RAD) * Math.sin(epsDeg * DEG2RAD)) * RAD2DEG;
  let x = -Math.tan(latDeg * DEG2RAD) * Math.tan(dec * DEG2RAD);
  if (x >= 1) return 0;
  if (x <= -1) return 180;
  return Math.acos(x) * RAD2DEG;
}

/**
 * Solve one Placidus intermediate cusp by fixed-point iteration on the
 * hour-angle rule h(λ): λ_next = raToEcl(LST − h(λ)) (RA↔λ is a bijection,
 * and |dh/dλ| < 1 near the solution, so plain iteration converges fast).
 * @param {number} lstDeg - Local sidereal time, degrees
 * @param {number} latDeg - Latitude, degrees
 * @param {number} epsDeg - Obliquity, degrees
 * @param {(sd: number) => number} targetFn - Rule h = f(SD) from the table above
 * @param {number} arcLo - Start of the quadrant arc this cusp must land in
 * @param {number} arcSpan - Forward span (degrees) of that arc from arcLo
 * @returns {number|null} Cusp longitude, or null if no fixed point in-arc.
 */
function solvePlacidusCusp(lstDeg, latDeg, epsDeg, targetFn, arcLo, arcSpan) {
  let lon = normalizeAngle(arcLo + arcSpan / 2); // start mid-arc
  for (let i = 0; i < 100; i++) {
    const h = targetFn(semiDiurnalArc(lon, latDeg, epsDeg));
    const next = raToEcl(normalizeAngle(lstDeg - h), epsDeg);
    if (Math.abs(angleDistance(next, lon)) < 1e-9) {
      const landed = normalizeAngle(next - arcLo);
      return landed <= arcSpan ? normalizeAngle(next) : null;
    }
    lon = next;
  }
  return null;
}

/**
 * Calculate Placidus house cusps (12 houses).
 * @param {number} lstDeg - Local Sidereal Time in degrees
 * @param {number} latDeg - Observer's geographic latitude in degrees
 * @param {number} epsDeg - Obliquity of the ecliptic in degrees
 * @returns {{ascendant: object, midheaven: object, imumCoeli: object, descendant: object, cusps: array[], system: string}}
 */
function calcPlacidusHouses(lstDeg, latDeg, epsDeg) {
  // Beyond the polar circles (|lat| > 90° − obliquity ≈ 66.56°) parts of the
  // ecliptic never rise/set, Ascendant and time-quadrant trisection become
  // undefined or wildly degenerate — Swiss Ephemeris errors there too, and
  // professional software (e.g. astro.com) refuses Placidus past that limit.
  if (Math.abs(latDeg) > 90 - epsDeg + 1e-9) {
    throw new Error(
      `Placidus houses are undefined at latitude ${latDeg}° (beyond the polar circle). ` +
      'Use WholeSign or Equal houses.'
    );
  }

  // Get the four angular points (ASC, MC, DESC=ASC+180°, IC=MC+180°)
  const { asc, mc } = calcAscendantMC(lstDeg, latDeg, epsDeg);
  const ic = normalizeAngle(mc + 180);
  const desc = normalizeAngle(asc + 180);

  // Intermediate cusps: solve each hour-angle rule (see §5.4 header for the
  // validated table). Search arcs are zodiacal forward spans between the
  // angles that bound each cusp's quadrant; |arc| here is the short path from
  // the fit data, e.g. cusps 2/3 live forward of ASC through IC-side sky.
  const fwd = (lo, hi) => { const s = normalizeAngle(hi - lo); return [lo, s]; };

  const rules = [
    // [cusp#, arcLo, arcHi, targetFn(SD)] — search arcs from SWE fit geometry:
    // c2/c3 rise between ASC and IC, c5/c6 between IC and DESC,
    // c8/c9 between DESC and MC, c11/c12 between MC and ASC.
    [2,  asc, ic, s => -(60 + (2 / 3) * s)],
    [3,  asc, ic, s => -(120 + (1 / 3) * s)],
    [5,  ic, desc, s => +(120 + (1 / 3) * s)],
    [6,  ic, desc, s => +(60 + (2 / 3) * s)],
    [8,  desc, mc, s => +(2 / 3) * s],
    [9,  desc, mc, s => +(1 / 3) * s],
    [11, mc, asc, s => -(1 / 3) * s],
    [12, mc, asc, s => -(2 / 3) * s],
  ];

  const solved = {};
  for (const [n, lo, hi, fn] of rules) {
    const [arcLo, arcSpan] = fwd(lo, hi);
    const v = solvePlacidusCusp(lstDeg, latDeg, epsDeg, fn, arcLo, arcSpan);
    if (v === null) {
      throw new Error(
        `Placidus cusp ${n} has no solution at latitude ${latDeg}° for this time; ` +
        'use WholeSign or Equal houses.'
      );
    }
    solved[n] = v;
  }

  // House cusps in order (cusp 1 through 12)
  const cusps = [asc, solved[2], solved[3], ic, solved[5], solved[6], desc, solved[8], solved[9], mc, solved[11], solved[12]];

  return {
    ascendant: formatLongitude(asc),
    midheaven: formatLongitude(mc),
    imumCoeli: formatLongitude(ic),
    descendant: formatLongitude(desc),
    cusps: cusps.map(c => formatLongitude(c)),
    system: 'Placidus'
  };
}

/**
 * §5.5: Equal House System
 *
 * The simplest house system: each house is exactly 30° of the zodiac,
 * starting from the Ascendant as cusp 1. This means every house contains
 * exactly one sign (if the ASC falls at 0° of a sign), but typically houses
 * span parts of two signs each. Equal houses are popular in Hellenistic
 * astrology and for quick chart reading.
 */

/**
 * Calculate Equal house cusps (12 equal 30° segments from the Ascendant).
 * @param {number} lstDeg - Local Sidereal Time in degrees
 * @param {number} latDeg - Observer's geographic latitude in degrees
 * @param {number} epsDeg - Obliquity of the ecliptic in degrees
 * @returns {{ascendant: object, midheaven: object, imumCoeli: object, descendant: object, cusps: array[], system: string}}
 */
function calcEqualHouses(lstDeg, latDeg, epsDeg) {
  const { asc, mc } = calcAscendantMC(lstDeg, latDeg, epsDeg);

  // Each house cusp is exactly 30° apart, starting from the Ascendant
  const cusps = [];
  for (let i = 0; i < 12; i++) {
    cusps.push(formatLongitude(normalizeAngle(asc + i * 30)));
  }

  return {
    ascendant: formatLongitude(asc),
    midheaven: formatLongitude(mc),
    imumCoeli: formatLongitude(normalizeAngle(mc + 180)),
    descendant: formatLongitude(normalizeAngle(asc + 180)),
    cusps,
    system: 'Equal'
  };
}

/**
 * §5.6: Whole Sign House System
 *
 * The oldest house system (Hellenistic): the sign containing the Ascendant
 * becomes house 1 in its entirety; every subsequent sign is the next house.
 * Cusps therefore sit on exact sign boundaries — no latitude trigonometry, so
 * it is always defined, including polar latitudes where Placidus fails.
 */

/**
 * Calculate Whole Sign house cusps (sign-boundary cusps starting at ASC's sign).
 * @param {number} lstDeg - Local Sidereal Time in degrees (used only via the Ascendant)
 * @param {number} latDeg - Observer's geographic latitude in degrees
 * @param {number} epsDeg - Obliquity of the ecliptic in degrees
 * @returns {{ascendant: object, midheaven: object, imumCoeli: object, descendant: object, cusps: array[], housesBySign: object, system: string}}
 */
function calcWholeSignHouses(lstDeg, latDeg, epsDeg) {
  const { asc, mc } = calcAscendantMC(lstDeg, latDeg, epsDeg);

  // House 1 = the whole sign that contains the Ascendant.
  const ascSignIndex = Math.floor(normalizeAngle(asc) / 30);

  // Cusp i is the start of house i: exact sign boundary (i-1 degrees × 30 from Aries 0°).
  const cusps = [];
  for (let i = 0; i < 12; i++) {
    cusps.push(formatLongitude(normalizeAngle((ascSignIndex + i) * 30)));
  }

  // Which house each sign belongs to: sign s → house number ((s - ascSign) mod 12) + 1.
  const housesBySign = {};
  for (let s = 0; s < 12; s++) {
    housesBySign[ZODIAC_NAMES[s]] = ((s - ascSignIndex + 12) % 12) + 1;
  }

  return {
    ascendant: formatLongitude(asc),
    midheaven: formatLongitude(mc),
    imumCoeli: formatLongitude(normalizeAngle(mc + 180)),
    descendant: formatLongitude(normalizeAngle(asc + 180)),
    cusps,
    housesBySign,
    system: 'WholeSign'
  };
}

/**
 * Resolve a user-supplied house system name to its calculator.
 * Accepts case-insensitive names and common aliases ('whole', 'whole-sign').
 * Throws on unknown systems — callers must not silently get Placidus for typos
 * (the old behavior: any unrecognized string fell back with no warning).
 *
 * @param {string} name - House system label
 * @returns {{key: string, calc: function}} Canonical key and calculator function
 */
function resolveHouseSystem(name) {
  const norm = String(name || 'Placidus').toLowerCase().replace(/[\s_-]+/g, '');
  switch (norm) {
    case 'placidus': return { key: 'Placidus', calc: calcPlacidusHouses };
    case 'equal': return { key: 'Equal', calc: calcEqualHouses };
    case 'wholesign': case 'whole': case 'sign':
      return { key: 'WholeSign', calc: calcWholeSignHouses };
    default:
      throw new Error(`Unknown house system '${name}'. Supported: Placidus, Equal, WholeSign.`);
  }
}

// ── §6: Aspect Analysis ──────────────────────────────────────

/**
 * Find all aspects between two celestial bodies.
 * Compares the ecliptic longitudes of two bodies against each defined aspect angle,
 * checking if they fall within the acceptable orb tolerance.
 *
 * @param {object} body1 - First body with .name and .longitude properties
 * @param {object} body2 - Second body with .name and .longitude properties
 * @returns {Array<object>} Array of matching aspects (may be empty)
 */
function findAspects(body1, body2) {
  // Calculate the shortest angular distance between the two bodies' longitudes
  const dist = angleDistance(body1.longitude, body2.longitude);
  const found = [];

  // Check each defined aspect type against this pair
  for (const aspect of ASPECTS) {
    // If the actual angle is within orb tolerance of a defined aspect angle, record it
    if (Math.abs(dist - aspect.angle) <= aspect.orb) {
      found.push({
        ...aspect,
        actualAngle: +dist.toFixed(2),       // Actual angle between bodies (rounded to 2dp)
        orb: +(Math.abs(dist - aspect.angle)).toFixed(2), // How far from exact aspect (tighter = stronger)
        body1: body1.name,                    // Name of first body
        body2: body2.name,                    // Name of second body
        symbol1: (PLANET_SYMBOLS[body1.name.replace(/_\d+$/, '')]) || '?',  // Strip _N suffix for synastry
        symbol2: (PLANET_SYMBOLS[body2.name.replace(/_\d+$/, '')]) || '?'   // Strip _N suffix for synastry
      });
    }
  }
  return found;
}

/**
 * Analyze all pairwise aspects among a set of planet positions.
 * Compares every pair of planets exactly once (O(n²) complexity).
 * Results are sorted by orb — tightest aspects first — since tighter orbs
 * indicate stronger, more significant influences in astrological interpretation.
 *
 * @param {Array<object>} planetPositions - Array of planet objects with .name and .longitude
 * @returns {Array<object>} All found aspects, sorted by orb (tightest first)
 */
function analyzeAllAspects(planetPositions) {
  const aspects = [];

  // Compare every pair exactly once (i < j ensures no duplicates or self-aspects)
  for (let i = 0; i < planetPositions.length; i++) {
    for (let j = i + 1; j < planetPositions.length; j++) {
      aspects.push(...findAspects(planetPositions[i], planetPositions[j]));
    }
  }

  // Sort by orb: tighter orbs appear first (stronger aspects)
  aspects.sort((a, b) => a.orb - b.orb);
  return aspects;
}

// ── §7: Natal Chart Calculation ──────────────────────────────

/**
 * Calculate a complete natal (birth) chart for a given date, time, and location.
 * This is the primary entry point — it computes planetary positions, house cusps,
 * aspects, and builds a human-readable summary.
 *
 * @param {object} dateObj - Birth date as {year: number, month: number (1-12), day: number}
 *   Also accepts legacy array format [year, month, day] for backward compatibility.
 * @param {number|object} timeObj - Birth time. Can be a number (hour, 0–23) or object {hour, minute}.
 *   Defaults to hour=12, minute=0 if not provided.
 * @param {number} latitude - Observer's geographic latitude (-90 to 90). Positive = northern hemisphere.
 * @param {number} longitude - Observer's geographic longitude (-180 to 180). Positive = eastern hemisphere.
 * @param {string} [houseSystem='Placidus'] - House system: 'Placidus' (default) or 'Equal'.
 *   Placidus divides houses by time; Equal divides by equal 30° arcs from the Ascendant.
 * @returns {{chart: object, planets: object, houses: object, aspects: Array<object>, summary: string}}
 *   Complete natal chart data including metadata, planetary positions, house system, aspects, and summary text.
 */
function calculateNatalChart(dateObj, timeObj, latitude, longitude, houseSystem = 'Placidus') {
  // Support both object {year, month, day} and legacy array [year, month, day] formats
  const year = dateObj.year || (Array.isArray(dateObj) ? dateObj[0] : null);
  const month = dateObj.month || (Array.isArray(dateObj) ? dateObj[1] : null);
  const day = dateObj.day || (Array.isArray(dateObj) ? dateObj[2] : null);

  if (!year || !month || !day) throw new Error('Invalid date. Provide {year, month, day}.');
  // Reject NaN up front: parseFloat at the route layer can hand us NaN, and every
  // range comparison below is false for NaN, so bad input used to sail through.
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error('Latitude and longitude must be finite numbers.');
  }
  if (latitude < -90 || latitude > 90) throw new Error('Latitude must be between -90 and 90.');
  if (longitude < -180 || longitude > 180) throw new Error('Longitude must be between -180 and 180.');

  // Resolve the house system BEFORE doing any expensive work; unknown names throw.
  const { calc: houseCalc } = resolveHouseSystem(houseSystem);

  // Parse time: support number (hour only), object {hour, minute}, or undefined
  const hour = timeObj && typeof timeObj === 'object' ? (timeObj.hour ?? 12) : (typeof timeObj === 'number' ? timeObj : 12);
  const minute = timeObj && typeof timeObj === 'object' ? (timeObj.minute ?? 0) : 0;

  // Reject impossible calendar dates instead of letting Date.UTC roll them:
  // {month: 13} used to silently become January of the next year.
  if (month < 1 || month > 12 || day < 1 || day > 31) throw new Error(`Invalid date: ${year}-${month}-${day}.`);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new Error(`Invalid calendar date: ${year}-${month}-${day} (does not exist).`);
  }

  // Fractional hours are allowed (getEphemeris-style callers pass them).
  const utcDate = makeUtcDate(year, month - 1, day, hour, minute);
  const astroTime = A.MakeTime(utcDate);

  // Compute positions for all 10 celestial bodies tracked by the engine.
  const planets = PLANET_KEYS;
  const planetPositions = {};

  for (const p of planets) {
    // Get high-precision ecliptic position from astronomy-engine C library
    const pos = getEclipticPosition(p, astroTime);

    // Build a structured object with all relevant data for this body:
    // - name, symbol: identity
    // - longitude/latitude: raw coordinates in degrees
    // - signName, signIndex, display: human-readable formatting via formatLongitude()
    // - retrograde: boolean from isRetrograde() check
    planetPositions[p] = {
      name: p,
      symbol: PLANET_SYMBOLS[p],
      longitude: +pos.lon.toFixed(4),
      latitude: +pos.lat.toFixed(4),
      ...formatLongitude(pos.lon),  // Spreads signName, signIndex, display, etc. into this object
      retrograde: isRetrograde(p, astroTime)
    };
  }

  // Calculate house cusps using the selected house system.
  // Requires Local Sidereal Time (LST) and obliquity of the ecliptic at birth time.
  const lst = getLST(astroTime, longitude);
  const eps = getObliquity(astroTime);
  const houses = houseCalc(lst, latitude, eps);

  // Assign each planet to a house: house i spans cusp i → cusp i+1 along the
  // zodiacic order. Works for all three systems because every system returns
  // cusps in house order (WholeSign's are just exact sign boundaries).
  const cuspLons = houses.cusps.map(c => c.longitude);
  for (const p of Object.values(planetPositions)) {
    let h = 12; // default: last house (lon ≥ cusp 12)
    for (let i = 0; i < 12; i++) {
      const start = cuspLons[i];
      const span = normalizeAngle(cuspLons[(i + 1) % 12] - start);
      if (normalizeAngle(p.longitude - start) < span) { h = i + 1; break; }
    }
    p.house = h;
  }

  // Analyze all aspects between every pair of planets in the natal chart.
  const aspects = analyzeAllAspects(Object.values(planetPositions));

  return {
    chart: {
      date: utcDate.toISOString(),           // ISO 8601 UTC timestamp
      julianDay: +(astroTime.tt + 2451545.0).toFixed(6), // Julian Day Number (TT-based)
      latitude, longitude,                    // Birth location coordinates
      houseSystem: houses.system              // Which house system was used
    },
    planets: planetPositions,                   // Full planetary data for each body
    houses,                                     // House cusps and angular points
    aspects,                                    // All inter-planet aspects found
    summary: buildSummary(planetPositions, houses, aspects)  // Human-readable one-liner summary
  };
}

// ── §8: Human-Readable Summary ───────────────────────────────

/**
 * Build a concise human-readable summary of the natal chart.
 * Designed for agentic consumption — short text that an AI agent can parse
 * to understand key chart features without processing raw numerical data.
 *
 * @param {object} planets - Planet position objects (from calculateNatalChart)
 * @param {object} houses - House system results (from calcPlacidusHouses or calcEqualHouses)
 * @param {Array<object>} aspects - All found aspects (from analyzeAllAspects)
 * @returns {string} Multi-line summary text
 */
function buildSummary(planets, houses, aspects) {
  const lines = [];

  // Core identity markers: Sun sign (core self), Moon sign (emotions), ASC (persona), MC (career/public image)
  lines.push(`Sun in ${planets.sun.signName} (${planets.sun.display})`);
  lines.push(`Moon in ${planets.moon.signName} (${planets.moon.display})${planets.moon.retrograde ? ' (retrograde)' : ''}`);
  lines.push(`Ascendant: ${houses.ascendant.signName} (${houses.ascendant.display})`);
  lines.push(`Midheaven: ${houses.midheaven.signName} (${houses.midheaven.display})`);

  // List any retrograde planets (excluding Sun, which is never retrograde)
  const retro = Object.values(planets).filter(p => p.retrograde && p.name !== 'sun');
  if (retro.length) {
    lines.push(`Retrograde: ${retro.map(r => r.symbol + ' ' + r.signName).join(', ')}`);
  }

  // List major aspects (conjunctions, squares, oppositions — the "hard" and defining aspects)
  const major = aspects.filter(a => a.angle === 0 || a.angle === 90 || a.angle === 180);
  if (major.length) {
    lines.push(`Major aspects: ${major.slice(0, 5).map(a => `${a.symbol1}${a.symbol||''}${a.symbol2} (${a.orb}° orb)`).join(', ')}`);
  }

  return lines.join('\n');
}

// ── §9: Ephemeris Lookup ─────────────────────────────────────

/**
 * Get daily planetary positions (an ephemeris) for a specific date and time.
 * An ephemeris is essentially a "snapshot" of where every tracked body was located
 * at a given moment — useful for checking today's transits, tracking retrogrades, etc.
 *
 * Unlike calculateNatalChart, this does NOT compute houses or aspects.
 * It returns raw positional data only.
 *
 * @param {object} dateObj - Date as {year, month (1-12), day}
 * @param {number} [hour=12] - Hour of the day in UTC (0–23). Defaults to noon.
 * @returns {{date: string, julianDay: number, planets: object}} Ephemeris data for all 10 bodies
 */
function getEphemeris(dateObj, hour = 12) {
  const year = dateObj.year || (Array.isArray(dateObj) ? dateObj[0] : null);
  const month = dateObj.month || (Array.isArray(dateObj) ? dateObj[1] : null);
  const day = dateObj.day || (Array.isArray(dateObj) ? dateObj[2] : null);
  if (!year || !month || !day) throw new Error('Invalid date.');

  const utcDate = makeUtcDate(year, month - 1, day, hour);
  const astroTime = A.MakeTime(utcDate);

  const planets = PLANET_KEYS;
  const ephemeris = {};

  for (const p of planets) {
    // Same position computation as natal chart, but without house/aspects data
    const pos = getEclipticPosition(p, astroTime);
    ephemeris[p] = {
      name: PLANET_NAMES[p],
      symbol: PLANET_SYMBOLS[p],
      longitude: +pos.lon.toFixed(4),
      latitude: +pos.lat.toFixed(4),
      ...formatLongitude(pos.lon),
      retrograde: isRetrograde(p, astroTime)
    };
  }

  return { date: utcDate.toISOString(), julianDay: +(astroTime.tt + 2451545.0).toFixed(6), planets: ephemeris };
}

// ── §10: Transit Analysis ────────────────────────────────────

/**
 * Calculate transits — the current (or future/past) positions of planets relative to a natal chart.
 * Transits show how moving planetary energies interact with your fixed birth chart,
 * indicating periods of change, opportunity, or challenge in astrological interpretation.
 *
 * The algorithm:
 *   1. Compute current planetary positions at the transit date/time
 *   2. Compare each transiting planet against every natal planet
 *   3. Find all aspects between transiting and natal bodies
 *   4. Return sorted by orb (tightest = most significant)
 *
 * @param {object} natalChart - A previously calculated natal chart object (from calculateNatalChart)
 * @param {object} transitDateObj - Date to check transits for: {year, month (1-12), day}
 * @param {number} [hour=12] - Hour of the transit date in UTC (0–23). Defaults to noon.
 * @returns {{date: string, transitingPlanets: object, aspects: Array<object>}} Transit data with all natal-transit aspects
 */
function calculateTransits(natalChart, transitDateObj, hour = 12) {
  const year = transitDateObj.year || (Array.isArray(transitDateObj) ? transitDateObj[0] : null);
  const month = transitDateObj.month || (Array.isArray(transitDateObj) ? transitDateObj[1] : null);
  const day = transitDateObj.day || (Array.isArray(transitDateObj) ? transitDateObj[2] : null);
  if (!year || !month || !day) throw new Error('Invalid transit date.');

  const utcDate = makeUtcDate(year, month - 1, day, hour);
  const astroTime = A.MakeTime(utcDate);

  // Compute current planetary positions (the "transiting" planets)
  const planets = PLANET_KEYS;
  const transitPositions = {};
  for (const p of planets) {
    const pos = getEclipticPosition(p, astroTime);
    transitPositions[p] = {
      name: p, symbol: PLANET_SYMBOLS[p],
      longitude: +pos.lon.toFixed(4), latitude: +pos.lat.toFixed(4),
      ...formatLongitude(pos.lon),
      retrograde: isRetrograde(p, astroTime)
    };
  }

  // Compare each transiting planet against every natal planet to find aspects.
  // This reveals which areas of the birth chart are being "activated" by current sky positions.
  const transitAspects = [];
  for (const tp of Object.values(transitPositions)) {
    for (const [npKey, np] of Object.entries(natalChart.planets)) {
      const found = findAspects(
        { name: tp.name, longitude: tp.longitude },
        { name: npKey, longitude: np.longitude }
      );
      for (const aspect of found) {
        transitAspects.push({
          ...aspect,
          transitingPlanet: tp.name,     // Which current planet is making the aspect
          natalPlanet: npKey,            // Which natal body it aspects
          transitLongitude: tp.display,  // Current position display string
          natalLongitude: np.display     // Birth position display string
        });
      }
    }
  }
  transitAspects.sort((a, b) => a.orb - b.orb);

  return { date: utcDate.toISOString(), transitingPlanets: transitPositions, aspects: transitAspects };
}

// ── §11: Synastry Comparison ─────────────────────────────────

/**
 * Calculate synastry — the aspect analysis between two natal charts.
 * Synastry reveals how two people's planetary energies interact, indicating
 * areas of harmony, tension, attraction, and growth in a relationship.
 *
 * The algorithm:
 *   1. For each planet in Person 1's chart, compare against ALL planets in Person 2's chart
 *   2. This includes same-planet aspects (e.g., P1 Sun vs P2 Sun) AND cross-planet aspects (P1 Sun vs P2 Moon)
 *   3. All found aspects are collected and sorted by orb tightness
 *
 * Note: Synastry is directional in the sense that Person 1's planets aspect Person 2's,
 * but since we compare all pairs both ways, the result captures mutual dynamics.
 *
 * @param {object} natal1 - First person's natal chart (from calculateNatalChart)
 * @param {object} natal2 - Second person's natal chart (from calculateNatalChart)
 * @returns {{person1: string, person2: string, aspects: Array<object>}} Synastry results with all inter-chart aspects
 */
function calculateSynastry(natal1, natal2) {
  const planets = PLANET_KEYS;
  const aspects = [];

  for (const p of planets) {
    if (!natal1.planets[p] || !natal2.planets[p]) continue;

    // Same-planet cross-aspects: e.g., Person 1's Sun aspecting Person 2's Sun
    const found = findAspects(
      { name: p, longitude: natal1.planets[p].longitude },
      { name: p + '_2', longitude: natal2.planets[p].longitude }
    );
    for (const a of found) {
      aspects.push({ ...a, body1Chart:'Person 1', body2Chart:'Person 2' });
    }

    // Cross-planet aspects: e.g., Person 1's Sun aspecting Person 2's Moon, Venus, Mars, etc.
    for (const p2 of planets) {
      if (!natal2.planets[p2] || p === p2) continue;
      const cross = findAspects(
        { name: p, longitude: natal1.planets[p].longitude },
        { name: p2 + '_2', longitude: natal2.planets[p2].longitude }
      );
      for (const a of cross) {
        aspects.push({ ...a, body1Chart:'Person 1', body2Chart:'Person 2' });
      }
    }
  }

  // Sort by orb: tightest aspects are strongest indicators in synastry interpretation
  aspects.sort((a, b) => a.orb - b.orb);
  return { person1: natal1.chart.date, person2: natal2.chart.date, aspects };
}

// ── §12: Exports ─────────────────────────────────────────────

/**
 * Public API surface. All functions and constants below are available to consumers of this module.
 *
 * Core calculation functions (use these):
 *   - calculateNatalChart(date, time, lat, lon, houseSystem?) — Full birth chart
 *   - getEphemeris(date, hour) — Daily planetary positions
 *   - calculateTransits(natalChart, date, hour) — Transit analysis against a natal chart
 *   - calculateSynastry(natal1, natal2) — Two-chart relationship comparison
 *
 * House system functions:
 *   - calcPlacidusHouses(lstDeg, latDeg, epsDeg) — Placidus house cusps
 *   - calcEqualHouses(lstDeg, latDeg, epsDeg) — Equal house cusps
 *   - calcWholeSignHouses(lstDeg, latDeg, epsDeg) — Whole Sign (sign-boundary) cusps
 *   - calcAscendantMC(lstDeg, latDeg, epsDeg) — Ascendant and Midheaven only
 *   - resolveHouseSystem(name) — name/alias → {key, calc}; throws on unknown systems
 *
 * Position/aspect utilities:
 *   - getEclipticPosition(body, time) — Raw ecliptic coordinates for a body
 *   - isRetrograde(body, time) — Retrograde detection
 *   - findAspects(body1, body2) — Aspects between two bodies
 *   - analyzeAllAspects(planetsArray) — All aspects among multiple bodies
 *   - formatLongitude(deg) — Format degrees → sign/degree/minute display
 *   - normalizeAngle(deg) — Wrap angle to [0, 360)
 *   - angleDistance(a, b) — Shortest arc between two angles
 *
 * Constants (lookup tables):
 *   - ZODIAC_NAMES, ZODIAC_SYMBOLS — Sign names and Unicode symbols
 *   - PLANET_NAMES, PLANET_SYMBOLS — Planet names and Unicode symbols
 *   - ASPECTS — Defined aspect types with orbs and keywords
 */
module.exports = {
  calculateNatalChart, getEphemeris, calculateTransits, calculateSynastry,
  calcPlacidusHouses, calcEqualHouses, calcWholeSignHouses, calcAscendantMC, resolveHouseSystem,
  getEclipticPosition, isRetrograde, findAspects, analyzeAllAspects,
  formatLongitude, normalizeAngle, angleDistance,
  ZODIAC_NAMES, ZODIAC_SYMBOLS, PLANET_NAMES, PLANET_SYMBOLS, ASPECTS, PLANET_KEYS
};

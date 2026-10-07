// src/tz.js — timezone math for birth-chart input (local wall-clock -> UTC).
//
// Why server-side: Node 22's Intl carries the full IANA tz database, so we get
// historically-correct DST offsets (a 1990 Denver summer time is -06:00 MDT, a
// winter one -07:00 MST) with zero dependencies and no network. The browser has
// the same data but tests run here, and one tz database version beats N ones.
//
// Coordinates -> IANA zone uses tz-lookup (offline, bundled polygon dataset).

const timeZoneAt = require('tz-lookup');

/** True if `tz` is a valid IANA zone name for this runtime ('America/Denver'). */
function isValidZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; }
  catch { return false; }
}

/**
 * UTC offset (minutes, east-positive) of `tz` at the instant `dateUTC`.
 * Computed by formatting the same instant in the zone and diffing against its
 * UTC parts — no library required.
 */
function offsetMinutesAt(dateUTC, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(dateUTC).map((x) => [x.type, x.value]));
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  const mins = Math.round((asUTC - dateUTC.getTime()) / 60000);
  return mins === 0 ? 0 : mins; // normalize -0 from sub-minute offsets
}

/**
 * Convert local wall-clock parts to a UTC Date.
 * Iterates offset guesses (wall-as-UTC -> adjust -> re-check) because the
 * offset depends on the instant being sought, not the guess. Two iterations
 * converge for every real-world case; third is insurance. Ambiguous instants
 * (clocks set back in autumn) resolve to whichever branch the iteration lands
 * on — standard behavior for tz-less input; callers needing a hard rule can
 * pass UTC explicitly instead.
 * @returns {Date} UTC instant. Throws RangeError if any part is not a number.
 */
function localWallToUtc({ year, month, day, hour, minute }, tz) {
  for (const [name, v] of Object.entries({ year, month, day, hour, minute })) {
    if (!Number.isFinite(v)) throw new RangeError(`tz: ${name} must be a number`);
  }
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let t = new Date(wall); // offset-free seed guess
  for (let i = 0; i < 3; i++) {
    const next = new Date(wall - offsetMinutesAt(t, tz) * 60000);
    if (next.getTime() === t.getTime()) return next;
    t = next;
  }
  return t;
}

/** IANA zone name for a coordinate ('America/Denver'), or null if unmapped (open ocean). */
function zoneAtCoords(lat, lon) {
  try { return timeZoneAt(lat, lon) || null; }
  catch { return null; }
}

module.exports = { isValidZone, offsetMinutesAt, localWallToUtc, zoneAtCoords };

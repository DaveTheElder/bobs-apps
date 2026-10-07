// tests/test_tz.js — pin timezone conversion against known historical offsets.
// These guard the "born at 7:30pm local" path (issue #1): a chart cast from
// local wall-clock must land on the same UTC instant a human would look up,
// including pre-2000 DST rules that a fixed offset can't express.
const assert = require('node:assert');
const { isValidZone, offsetMinutesAt, localWallToUtc, zoneAtCoords } = require('../src/tz');

// --- validation ---------------------------------------------------------------
assert.ok(isValidZone('America/Denver') && isValidZone('UTC') && isValidZone('Europe/Berlin'));
assert.ok(!isValidZone('Mars/Olympus_Mons') && !isValidZone('' ) && !isValidZone('Denver'));

// --- offsetMinutesAt: historical DST, the whole reason this module exists -----
{
  // Denver summer 1990: MDT = UTC-6 (DST then ran to late September).
  assert.strictEqual(offsetMinutesAt(new Date(Date.UTC(1990, 4, 15)), 'America/Denver'), -360);
  // Same zone in January: MST = UTC-7.
  assert.strictEqual(offsetMinutesAt(new Date(Date.UTC(1990, 0, 15)), 'America/Denver'), -420);
  // Berlin summer 2026: CEST = UTC+2.
  assert.strictEqual(offsetMinutesAt(new Date(Date.UTC(2026, 6, 4)), 'Europe/Berlin'), 120);
  // UTC is always zero.
  assert.strictEqual(offsetMinutesAt(new Date(), 'UTC'), 0);
}

// --- localWallToUtc round-trips ------------------------------------------------
{
  const utc = localWallToUtc({ year: 1990, month: 5, day: 15, hour: 19, minute: 30 }, 'America/Denver');
  // 7:30pm MDT == 01:30 UTC next day.
  assert.strictEqual(utc.toISOString(), '1990-05-16T01:30:00.000Z');

  // Same wall-clock in winter shifts by the DST delta (7h not 6h).
  const win = localWallToUtc({ year: 1990, month: 1, day: 15, hour: 19, minute: 30 }, 'America/Denver');
  assert.strictEqual(win.toISOString(), '1990-01-16T02:30:00.000Z');

  // Zone-crossing sanity: same UTC instant expressed back in Berlin is +8h vs Denver summer.
  const berlinSame = localWallToUtc({ year: 2026, month: 7, day: 4, hour: 20, minute: 0 }, 'Europe/Berlin');
  assert.strictEqual(berlinSame.toISOString(), '2026-07-04T18:00:00.000Z');

  // Wall time just after midnight in NY on the DST fallback day: clocks went
  // back at 2am Nov 1 2020, so 00:05 is still EDT (-4) => 04:05Z.
  const late = localWallToUtc({ year: 2020, month: 11, day: 1, hour: 0, minute: 5 }, 'America/New_York');
  assert.strictEqual(late.toISOString(), '2020-11-01T04:05:00.000Z');
}

// --- invalid inputs throw, not NaN ---------------------------------------------
assert.throws(() => localWallToUtc({ year: NaN, month: 1, day: 1, hour: 0, minute: 0 }, 'UTC'), RangeError);

// --- coordinate -> zone ----------------------------------------------------------
{
  assert.strictEqual(zoneAtCoords(39.74, -104.98), 'America/Denver');
  assert.strictEqual(zoneAtCoords(52.52, 13.4), 'Europe/Berlin');
  // Middle of the Pacific: no zone, but must return null not throw.
  assert.ok(zoneAtCoords(0, -140) === null || typeof zoneAtCoords(0, -140) === 'string');
}

console.log('tz module: all tests passed');

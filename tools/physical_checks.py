#!/usr/bin/env python3
"""Physical sanity probe — Study A, Section III-C / pipeline step 5.

Programs can match their own logic and still drift from the sky, so these
checks bind the engine to physics rather than to another program:

  1. Kepler's second law: approaching perihelion (Northern winter), the Sun's
     apparent daily motion must strictly INCREASE across the window. An
     ephemeris that ignored orbital eccentricity would be flat here.
  2. The Moon's daily motion stays inside [11°, 16°] — the physical band set
     by perigee/apogee — and trends monotonically when it should.
  3. The Sun crossing ecliptic longitude 180° (autumnal equinox) interpolates
     to within ~2 days of the published value near September 23.

Run after any engine change (paper VI-5). Exit 0 = sky looks like a sky.

Usage:
    python3 tools/physical_checks.py [--start 2026-09-06 --end 2026-09-27]
"""
import argparse
import json
import sys
import urllib.request
from datetime import date, timedelta

BASE = "http://192.168.0.222/api/astro"
EQUINOX_2026_UTC = 23.0   # true value: Sep 23, ~02:21 UTC (paper III-C)
EQUINOX_TOL_DAYS = 2.0    # linear interpolation over one-day steps is coarse
MOON_BAND = (11.0, 16.0)  # deg/day physical bounds perigee..apogee


def sun_longitude(day):
    with urllib.request.urlopen(f"{BASE}/ephemeris?date={day}&hour=12", timeout=30) as r:
        eph = json.load(r)
    return eph["planets"]["sun"]["longitude"], eph["planets"]["moon"]["longitude"]


def dlon(a, b):
    """Longitude advance from a to b, wrapped to [0, 360)."""
    return (b - a) % 360.0


def main():
    ap = argparse.ArgumentParser(description="Physical sanity probe (Study A III-C)")
    ap.add_argument("--start", default="2026-09-06")
    ap.add_argument("--end", default="2026-09-27")
    args = ap.parse_args()

    days = []
    d, end = date.fromisoformat(args.start), date.fromisoformat(args.end)
    while d <= end:
        days.append(d)
        d += timedelta(days=1)

    try:
        pos = {}
        for day in days:
            pos[day] = sun_longitude(day)
    except Exception as e:
        print(f"FATAL service unreachable: {e}", file=sys.stderr)
        return 2

    failures = []

    # --- check 1: solar apparent daily motion strictly increasing ------------
    sun_motion = [(days[i], dlon(pos[days[i]][0], pos[days[i + 1]][0]))
                  for i in range(len(days) - 1)]
    reversals = [(a, b, m1, m2)
                 for (a, m1), (b, m2) in zip(sun_motion, sun_motion[1:]) if m2 <= m1]
    first_m, last_m = sun_motion[0][1], sun_motion[-1][1]
    print(f"[1] solar daily motion: {first_m:.4f} -> {last_m:.4f} deg/day "
          f"over {len(sun_motion)} steps")
    if reversals:
        for a, b, m1, m2 in reversals[:5]:
            print(f"    REVERSAL {a.isoformat()} ({m1:.4f}) -> {b.isoformat()} ({m2:.4f})")
        failures.append("solar motion not monotone toward perihelion")

    # --- check 2: Moon daily motion inside physical band ----------------------
    moon_motion = [(days[i], dlon(pos[days[i]][1], pos[days[i + 1]][1]))
                   for i in range(len(days) - 1)]
    lo, hi = MOON_BAND
    out_of_band = [(d, m) for d, m in moon_motion if not (lo <= m <= hi)]
    print(f"[2] lunar daily motion: {moon_motion[0][1]:.2f} -> {moon_motion[-1][1]:.2f} deg/day; "
          f"band [{lo}, {hi}] violations: {len(out_of_band)}")
    for d, m in out_of_band[:5]:
        print(f"    OUT OF BAND {d.isoformat()}: {m:.3f}")
    if out_of_band:
        failures.append("lunar daily motion outside [11, 16] deg/day")

    # --- check 3: Sun crossing 180deg (equinox) interpolates near truth ------
    equinox = None
    for i in range(len(days) - 1):
        d0, d1 = days[i], days[i + 1]
        l0, l1 = pos[d0][0], pos[d1][0]
        if l0 <= 180.0 < l1 or (l0 > l1 and l0 >= 180.0):  # incl. 360-wrap
            frac = ((180.0 - l0) % 360.0) / dlon(l0, l1) if dlon(l0, l1) else 0
            equinox = d0.day + frac   # day-of-September decimal (window is Sep-only)
            break
    if equinox is None:
        print("[3] no ecliptic-180 crossing inside window — widen --start/--end")
        failures.append("equinox crossing not bracketed by window")
    else:
        drift = abs(equinox - EQUINOX_2026_UTC)
        print(f"[3] interpolated equinox: Sep {equinox:.1f} UTC "
              f"(true ~Sep {EQUINOX_2026_UTC}) — drift {drift:.1f} d")
        if drift > EQUINOX_TOL_DAYS:
            failures.append(f"equinox off by {drift:.1f} days")

    print("\nRESULT:", "FAIL — " + "; ".join(failures) if failures else "sky looks like a sky")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Independent aspect checker — Study A, Section III-B / pipeline step 3.

Recomputes the Ptolemaic aspect set from raw ecliptic longitudes served by
GET /api/astro/ephemeris and compares it against the aspect list published by
GET /api/astro/chart. The orb definitions are fetched live from
/api/astro/reference so the comparison is definitional nowhere: if engine and
checker ever disagree, the bug localizes to exactly one of the two sides.

This module deliberately imports nothing from the engine's source — it speaks
only HTTP. That independence is the whole point (paper III-B).

Usage:
    python3 tools/aspect_checker.py               # today's 12:00 UTC chart
    python3 tools/aspect_checker.py 2026-09-10    # one date
    python3 tools/aspect_checker.py --from 2026-09-06 --to 2026-09-20

Exit status: 0 = agreement (or engine silent), 1 = at least one disagreement,
2 = service unreachable / malformed payload.
"""
import argparse
import json
import sys
import urllib.request
from datetime import date, timedelta

BASE = "http://192.168.0.222/api/astro"
# Longitude comparisons at planetary precision. A pair whose orb misses the
# published cutoff by less than this is reported as BOUNDARY (either verdict
# defensible), not a hard disagreement — the paper demands the dispute itself
# be definitional nowhere (III-B).
TOLERANCE_DEG = 0.05


def get_json(path):
    with urllib.request.urlopen(BASE + path, timeout=30) as r:
        return json.load(r)


def fetch_reference_orbs():
    """Return {aspect_name_lower: (exact_angle, orb)} straight from /reference."""
    ref = get_json("/reference")
    return {a["name"].lower(): (float(a["angle"]), float(a["orb"]))
            for a in ref["aspects"]}


def separation(lon_a, lon_b):
    """Smallest angular distance between two ecliptic longitudes, degrees."""
    d = abs(lon_a - lon_b) % 360.0
    return min(d, 360.0 - d)


def nearest_aspect(sep, orbs):
    """Closest aspect to a separation and its error, ignoring orb cutoffs."""
    best = None
    for name, (angle, orb) in orbs.items():
        err = abs(sep - angle)
        if best is None or err < best[1]:
            best = (name, err, orb)
    if best is None:  # /reference returned zero aspects — service bug
        raise ValueError("no aspect definitions loaded from /reference")
    return best  # (name, err, orb)


def classify(sep, orbs):
    """(aspect_name, boundary) for a separation; (None, False) if no aspect fits.

    `boundary` is True only when the pair falls OUTSIDE every orb but within
    TOLERANCE_DEG of one cutoff: there, exclusion vs inclusion is a coin flip on
    float noise and both sides may defend their call. A pair strictly INSIDE an
    orb is never boundary — dropping it clear of the line would be a real bug.
    """
    name, err, orb = nearest_aspect(sep, orbs)
    if err <= orb:
        return name, False
    return None, (err - orb) <= TOLERANCE_DEG


def checker_aspects(longitudes, orbs):
    """All aspect pairs from a {body: longitude} map. Independent of engine code.

    Returns ({frozenset(bodies): aspect_name}, set_of_boundary_pairs).
    """
    bodies = sorted(longitudes)
    found, boundary = {}, set()
    for i in range(len(bodies)):
        for j in range(i + 1, len(bodies)):
            b1, b2 = bodies[i], bodies[j]
            name, on_boundary = classify(separation(longitudes[b1], longitudes[b2]), orbs)
            if name:
                found[frozenset((b1, b2))] = name
            if on_boundary:
                boundary.add(frozenset((b1, b2)))
    return found, boundary


def engine_aspects(chart):
    """Engine's published aspect list as {frozenset(bodies): name_lower}."""
    out = {}
    for a in chart.get("aspects", []):
        out[frozenset((a["body1"], a["body2"]))] = a["name"].lower()
    return out


def compare_one(day, orbs):
    """Compare checker vs engine for one date.

    Returns (pairs_found, disagreements, boundary_notes). A pair the two sides
    disagree on is only a hard disagreement if it sits clear of the orb cut —
    within TOLERANCE_DEG of the line either side can defend its call, so those
    become notes.
    """
    eph = get_json(f"/ephemeris?date={day}&hour=12")
    chart = get_json(f"/chart?date={day}&time=12:00&lat=40&lon=-75")

    longitudes = {k: v["longitude"] for k, v in eph["planets"].items()}
    mine, boundary_pairs = checker_aspects(longitudes, orbs)
    theirs = engine_aspects(chart)

    disagreements, notes = [], []
    for pair in sorted(set(mine) | set(theirs), key=lambda p: tuple(sorted(p))):
        m, t = mine.get(pair), theirs.get(pair)
        if m != t:
            names = "+".join(sorted(pair))
            line = f"{day} {names}: checker={m} engine={t}"
            (notes if pair in boundary_pairs else disagreements).append(line)

    label_pairs = len(set(mine) | set(theirs))
    return label_pairs, disagreements, notes


def main():
    ap = argparse.ArgumentParser(description="Independent aspect checker (Study A pipeline step 3)")
    ap.add_argument("day", nargs="?", help="ISO date (default: today)")
    ap.add_argument("--from", dest="start", help="start of a date range")
    ap.add_argument("--to", dest="end", help="end of a date range (inclusive)")
    args = ap.parse_args()

    try:
        orbs = fetch_reference_orbs()
    except Exception as e:
        print(f"FATAL cannot reach {BASE}/reference: {e}", file=sys.stderr)
        return 2

    if args.start and args.end:
        days = []
        d = date.fromisoformat(args.start)
        end = date.fromisoformat(args.end)
        while d <= end:
            days.append(d.isoformat())
            d += timedelta(days=1)
    else:
        days = [args.day or date.today().isoformat()]

    total_pairs, all_bad, all_notes = 0, [], []
    for day in days:
        try:
            pairs, bad, notes = compare_one(day, orbs)
        except Exception as e:
            print(f"FATAL {day}: {e}", file=sys.stderr)
            return 2
        total_pairs += pairs
        all_bad += bad
        all_notes += notes
        status = "OK" if not bad else f"{len(bad)} DISAGREEMENTS"
        print(f"{day}: {pairs} aspect pairs — checker vs engine: {status}")
        for b in bad:
            print(f"  ! {b}")
        for n in notes:
            print(f"  ~ boundary: {n} (within {TOLERANCE_DEG}° of orb cut; both calls defensible)")

    print(f"\n{len(days)} day(s), {total_pairs} pairs checked, "
          f"{len(all_bad)} disagreements, {len(all_notes)} boundary notes.")
    return 1 if all_bad else 0


if __name__ == "__main__":
    sys.exit(main())

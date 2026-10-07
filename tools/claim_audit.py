#!/usr/bin/env python3
"""Claim auditor — Study A, pipeline step 3 (the pre-publication gate).

Extracts every checkable factual claim from a horoscope draft and verifies it
against live engine truth:

  * longitude claims   "Mars at 107 degrees"        vs /ephemeris longitude
  * sign-degree claims "Saturn in Aquarius 6°"      vs degreesInSign (+ sign)
  * sign claims        "Mercury stands in Virgo"    vs signName
  * aspect claims      "Neptune squares Mercury"    vs /chart aspect list

A numeric claim that is wrong in the claimed frame but right in the other one
(9.5° called "ecliptic" when it's really degrees-in-sign) is flagged as a
FRAME SLIP — Table II row 3 of the paper, the species casual reading misses.

Usage:
    python3 tools/claim_audit.py draft.txt --date 2026-09-10 [--lat 40 --lon -75]
    echo "Mars at 109 degrees." | python3 tools/claim_audit.py - --date 2026-09-10

Exit status: 0 = every claim verified, 1 = at least one ERR,
2 = service unreachable / unreadable input.
"""
import argparse
import json
import re
import sys
import urllib.request
from datetime import date

BASE = "http://192.168.0.222/api/astro"
TOLERANCE_DEG = 1.5   # paper IV-A: audit tolerance against engine truth

SIGNS = ["Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo",
         "Libra", "Scorpio", "Sagittarius", "Capricorn", "Aquarius", "Pisces"]

PLANETS = {  # surface form (lowercase) -> engine key
    "sun": "sun", "moon": "moon", "mercury": "mercury", "venus": "venus",
    "mars": "mars", "jupiter": "jupiter", "saturn": "saturn",
    "uranus": "uranus", "neptune": "neptune", "pluto": "pluto",
}

ASPECT_WORDS = {  # verb or noun form -> canonical aspect name (lowercase)
    "conjunction": "conjunction", "conjunct": "conjunction",
    "sextile": "sextile", "square": "square",
    "trine": "trine", "opposition": "opposition", "oppose": "opposition",
}
# third-person verb forms the patterns capture: "squares", "opposes", ...
ASPECT_WORDS.update({k + "s": v for k, v in ASPECT_WORDS.items()})

# --- claim patterns -----------------------------------------------------------
PNAME = r"\b(" + "|".join(PLANETS) + r")\b"
SNAME = r"\b(" + "|".join(SIGNS) + r")\b"
DEG = r"(\d+(?:\.\d+)?)\s*(?:°|degrees?\b|deg\b)"

# Loose windows; attribution is fixed AFTER matching (see last_planet): when a
# match span names several planets ("Moon glides ... while Mercury near 180°"),
# the number belongs to the LAST one before the preposition, not the first.
RE_SIGN_DEG = re.compile(rf"{PNAME}[^.\n]{{0,40}}?\b(?:in|at)\s+{SNAME}\s*{DEG}", re.I)
RE_LONG = re.compile(rf"{PNAME}[^.\n]{{0,40}}?\b(?:at|near|around|approximately)\s+{DEG}", re.I)
RE_SIGN = re.compile(rf"{PNAME}[^.\n]{{0,25}}?\bin\s+{SNAME}\b", re.I)

ASPECT_VERB = r"(squares?|trines?|sextiles?|opposes?|conjuncts?)"
RE_ASPECT1 = re.compile(rf"{PNAME}\s+{ASPECT_VERB}\s+(?:each other\s+)?{PNAME}", re.I)
RE_ASPECT2 = re.compile(
    rf"\b(?:an?|the)?\s*(conjunction|sextile|square|trine|opposition)\b"
    rf"[^.\n]{{0,15}}?\bbetween\s+{PNAME}\s+and\s+{PNAME}", re.I)
RE_ASPECT3 = re.compile(rf"{PNAME}\s+in\s+(conjunction|sextile|square|trine|opposition)\s+(?:to|with)\s+{PNAME}", re.I)


def get_json(path):
    with urllib.request.urlopen(BASE + path, timeout=30) as r:
        return json.load(r)


class Truth:
    """Engine truth for one date/chart: longitudes, signs, aspects."""

    def __init__(self, day, lat, lon):
        eph = get_json(f"/ephemeris?date={day}&hour=12")
        chart = get_json(f"/chart?date={day}&time=12:00&lat={lat}&lon={lon}")
        self.planets = eph["planets"]
        self.aspects = {}  # frozenset(b1, b2) -> (name_lower, orb)
        for a in chart.get("aspects", []):
            self.aspects[frozenset((a["body1"], a["body2"]))] = (
                a["name"].lower(), a["orb"])

    def verdict_pair(self, b1, b2, claimed_aspect):
        """Check an aspect claim; returns (ok, detail)."""
        pair = frozenset((b1, b2))
        if pair in self.aspects:
            name, orb = self.aspects[pair]
            if name == claimed_aspect:
                return True, f"{name}, engine orb {orb}°"
            return False, f"engine says {name} (orb {orb}°)"
        return False, "no aspect within published orbs per /chart"

    def verdict_number(self, body, value, frame):
        """Check a degree claim in 'ecliptic' or 'sign' frame; returns (ok, detail)."""
        p = self.planets[body]
        ecl, sign_deg = p["longitude"], p["degreesInSign"]
        if frame == "ecliptic":
            if abs(value - ecl) <= TOLERANCE_DEG:
                return True, f"ecliptic {ecl}° in {p['signName']}"
            if abs(value - sign_deg) <= TOLERANCE_DEG:
                return False, (f"FRAME SLIP: {value} matches degrees-in-sign "
                               f"({sign_deg}) but claim says ecliptic longitude "
                               f"(true {ecl})")
            return False, f"engine ecliptic {ecl}° ({p['signName']} {sign_deg})"
        else:  # sign frame: value is degrees within the claimed sign
            if abs(value - sign_deg) <= TOLERANCE_DEG:
                return True, f"{p['signName']} {sign_deg}"
            return False, f"engine has it at {p['signName']} {sign_deg}"


def attribute(span_text, fallback):
    """Which planet a number/sign phrase belongs to inside a match span.

    Grammar says: closest preceding planet. "Moon glides through Virgo while
    Mercury near 180 degrees" attaches 180 to Mercury, not the Moon — taking
    the LAST planet named in the span gets that right; group(1) gives the first.
    """
    bodies = re.findall(r"\b(" + "|".join(PLANETS) + r")\b", span_text, flags=re.I)
    return bodies[-1].lower() if bodies else fallback


def extract_claims(text):
    """Yield (kind, span_text, payload) for every checkable claim in the draft.

    Sign-degree claims are matched first and their spans consumed so the looser
    longitude/sign patterns can't double-charge the same phrase.
    """
    claims = []
    consumed = []

    def overlaps(a, b):
        """True if span [a,b) intersects any already-consumed span."""
        return any(a < e and s < b for s, e in consumed)

    for m in RE_SIGN_DEG.finditer(text):
        body = attribute(m.group(0), m.group(1).lower())
        sign, value = m.group(2), float(m.group(3))
        claims.append(("sign_deg", m.group(0), (body, sign, value)))
        consumed.append(m.span())

    for pat in (RE_LONG, RE_SIGN):
        for m in pat.finditer(text):
            if overlaps(*m.span()):
                continue
            kind = "longitude" if pat is RE_LONG else "sign"
            body = attribute(m.group(0), m.group(1).lower())
            payload = ((body, float(m.group(2)))
                       if kind == "longitude" else (body, m.group(2)))
            claims.append((kind, m.group(0), payload))

    for m in RE_ASPECT1.finditer(text):
        verb = m.group(2).lower()
        claims.append(("aspect", m.group(0),
                       (m.group(1).lower(), ASPECT_WORDS[verb], m.group(3).lower())))
    for m in RE_ASPECT2.finditer(text):
        claims.append(("aspect", m.group(0),
                       (m.group(2).lower(), ASPECT_WORDS[m.group(1).lower()], m.group(3).lower())))
    for m in RE_ASPECT3.finditer(text):
        claims.append(("aspect", m.group(0),
                       (m.group(1).lower(), ASPECT_WORDS[m.group(2).lower()], m.group(3).lower())))

    # Dedupe by payload so "X squares Y" inside repeated sentences counts once.
    seen, out = set(), []
    for kind, span, payload in claims:
        key = (kind, tuple(str(x) for x in payload))
        if key not in seen:
            seen.add(key)
            out.append((kind, span, payload))
    return out


def audit(text, truth):
    """Verify every extracted claim. Returns list of result dicts."""
    results = []

    def check(kind, span, detail_fn):
        ok, detail = detail_fn()
        results.append({"claim": span.strip(), "kind": kind,
                        "verdict": "OK" if ok else "ERR", "detail": detail})

    for kind, span, payload in extract_claims(text):
        if kind == "longitude":
            body, value = payload
            check(kind, span, lambda b=body, v=value: truth.verdict_number(b, v, "ecliptic"))
        elif kind == "sign_deg":
            body, sign, value = payload
            def sgn_check(b=body, s=sign, v=value):
                p = truth.planets[b]
                if p["signName"].lower() != s.lower():
                    return False, f"engine has {b.title()} in {p['signName']}, not {s}"
                return truth.verdict_number(b, v, "sign")
            check(kind, span, sgn_check)
        elif kind == "sign":
            body, sign = payload

            def sign_check(b=body, s=sign):
                p = truth.planets[b]
                if p["signName"].lower() == s.lower():
                    return True, f"{p['signName']} {p['degreesInSign']}"
                # near a 30° boundary? claim is wrong but forgivable-looking
                d = p["degreesInSign"]
                edge = " (near sign boundary)" if min(d, 30 - d) < TOLERANCE_DEG else ""
                return False, f"engine has {b.title()} in {p['signName']} {d}{edge}"
            check(kind, span, sign_check)
        elif kind == "aspect":
            b1, aspect, b2 = payload
            check(kind, span, lambda a=b1, x=aspect, c=b2: truth.verdict_pair(a, c, x))

    return results


def main():
    ap = argparse.ArgumentParser(description="Horoscope claim auditor (Study A gate)")
    ap.add_argument("draft", help="draft text file, or - for stdin")
    ap.add_argument("--date", default=date.today().isoformat(), help="ISO date the draft describes")
    ap.add_argument("--lat", default="40")
    ap.add_argument("--lon", default="-75")
    args = ap.parse_args()

    try:
        text = sys.stdin.read() if args.draft == "-" else open(args.draft).read()
        truth = Truth(args.date, args.lat, args.lon)
    except Exception as e:
        print(f"FATAL: {e}", file=sys.stderr)
        return 2

    results = audit(text, truth)
    errs = [r for r in results if r["verdict"] == "ERR"]

    for r in results:
        print(f"[{r['verdict']:>3}] ({r['kind']:<9}) “{r['claim']}” — {r['detail']}")
    if not results:
        print("(no checkable factual claims found — nothing to audit)")
    else:
        print(f"\n{len(results)} claim(s) audited, {len(errs)} ERR.")
    return 1 if errs else 0


if __name__ == "__main__":
    sys.exit(main())

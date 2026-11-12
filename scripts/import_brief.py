#!/usr/bin/env python3
"""Import the morning brief into the news room API.

Reads the brief pipeline's outputs (daily_linked.txt + deep_dives.md from
~/morning-brief by default) and POSTs one news_items row per bullet:

  * bullet text            -> title (first clause) + summary (full sentence)
  * markdown link in bullet-> url + source (link label)
  * section header         -> category (TOP STORIES=world, TECH & AI=tech,
                              ONE-LINERS=general, ALT PRESS RADAR=alt-press)
  * matching deep dive     -> content; the row is featured (only the day's
                              deep-dived stories lead the list)

Idempotent: an item whose title already exists on the server is skipped, so
re-running the import (or the cron re-firing) never doubles the news room.

Usage:
    python3 scripts/import_brief.py [--base http://localhost]
                                    [--brief-dir ~/morning-brief]
                                    [--date 2026-10-20]  # published_at date
                                    [--dry-run]          # print, don't POST
Exit 0 on success (imports or clean no-ops), 1 on fetch/parse failure.
"""
import argparse
import json
import os
import re
import sys
import urllib.request

SECTIONS = {
    "TOP STORIES": "world",
    "TECH & AI": "tech",
    "ONE-LINERS": "general",
    "ALT PRESS RADAR": "alt-press",
    "BEAT DESK": "world",  # reporter-filed leads; [beat] tag rides inline in the prose
}

# The brief's bullets render as '- ' today; earlier runs used '* '. Accept both
# or the import silently parses zero bullets (10/22 incident).
BULLET_RE = re.compile(r"^[-*]\s+(.*?)(?:\s*·\s*\[([^\]]+)\]\((\S+)\))?\s*$")
LINK_MD_RE = re.compile(r"\s*·\s*\[[^\]]+\]\(\S+\)\s*$")
SOURCE_TAG_RE = re.compile(r"\s*\(([^()]+)\)\s*\.?\s*$")


def parse_brief(text):
    """daily_linked.txt -> list of dicts (title, summary, source, url, category)."""
    items = []
    category = "general"
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        # Section headers arrive as 'TOP STORIES' or '**TOP STORIES**' depending
        # on whether linkify's output kept the bold markers (10/25: bare headers
        # silently bucketed the whole edition into 'general').
        header = re.fullmatch(r"\**\s*(.+?)\s*\**", line)
        if header and header.group(1) in SECTIONS:
            category = SECTIONS[header.group(1)]
            continue
        m = BULLET_RE.match(line)
        if not m:
            continue
        body, outlet, url = m.groups()
        # Strip the '· [Outlet](url)' tail from the prose (regex already
        # captured it separately) and the trailing '(Source).' tag.
        prose = LINK_MD_RE.sub("", body).strip()
        src_match = SOURCE_TAG_RE.search(prose)
        source = src_match.group(1) if src_match else (outlet or "")
        sentence = SOURCE_TAG_RE.sub("", prose).strip().rstrip(".")
        # Title = first clause when the sentence has one; summary = full text.
        first_clause = sentence.split(", ", 1)[0]
        title = first_clause if len(first_clause) >= 25 else sentence
        items.append({
            "title": title,
            "summary": sentence,
            "source": source,
            "url": url or "",
            "category": category,
            "content": "",
            "featured": 0,
        })
    return items


def parse_dives(text):
    """deep_dives.md -> {headline_sentence: dive_body}.

    Headings are the bullet prose verbatim (including the '(Source).' tag),
    so match on the normalized sentence without the tag — same normalization
    parse_brief applies.
    """
    dives = {}
    current = None
    for line in text.splitlines():
        if line.startswith("### "):
            head = line[4:].strip()
            norm = SOURCE_TAG_RE.sub("", head).strip().rstrip(".")
            current = dives.setdefault(norm, [])
        elif line.strip() == "---":
            current = None
        elif current is not None:
            current.append(line)
    return {k: "\n".join(v).strip() for k, v in dives.items() if k and v}


def http_json(method, url, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"Content-Type": "application/json"} if data else {},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--base", default="http://localhost")
    ap.add_argument("--brief-dir", default=os.path.expanduser("~/morning-brief"))
    ap.add_argument("--date", default=None, help="published_at date (YYYY-MM-DD); defaults to today")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    linked_path = os.path.join(args.brief_dir, "daily_linked.txt")
    dives_path = os.path.join(args.brief_dir, "deep_dives.md")
    try:
        with open(linked_path) as f:
            items = parse_brief(f.read())
    except OSError as e:
        print(f"cannot read {linked_path}: {e}", file=sys.stderr)
        return 1
    if not items:
        print("no bullets parsed — refusing to import nothing", file=sys.stderr)
        return 1

    dives = {}
    if os.path.exists(dives_path):
        with open(dives_path) as f:
            dives = parse_dives(f.read())

    matched = 0
    for it in items:
        for norm, body in dives.items():
            # Deep-dive headings are the bullet prose verbatim; exact match on
            # the normalized sentence, else require one to prefix the other
            # (handles title-clause rows).
            if it["summary"] == norm or norm.startswith(it["summary"]) or it["summary"].startswith(norm):
                it["content"] = body
                it["featured"] = 1
                matched += 1
                break
    if dives and matched == 0:
        print("warning: deep dives present but none matched a bullet", file=sys.stderr)

    # 10/24 incident: dateless imports created undated rows that rode no edition
    # pager (imported "successfully" onto no day). Default = today, local date.
    pub_date = args.date or __import__("datetime").date.today().isoformat()
    published = f"{pub_date}T12:30:00Z"
    if published:
        for it in items:
            it["published_at"] = published

    if args.dry_run:
        print(json.dumps(items, indent=2))
        return 0

    existing = {n["title"]: n for n in http_json("GET", args.base + "/api/news")["news"]}
    created = skipped = backfilled = 0
    for it in items:
        row = existing.get(it["title"])
        if row:
            # A story imported BEFORE its deep dive existed (the 6:30 race: bullets
            # ship, dives finish later) must still get its content on re-run —
            # skip-if-seen alone left those rows featured=0 forever (10/22).
            if it["featured"] and not row.get("content"):
                http_json("PUT", args.base + f"/api/news/{row['id']}",
                          {"content": it["content"], "featured": 1})
                backfilled += 1
            else:
                skipped += 1
            continue
        http_json("POST", args.base + "/api/news", it)
        created += 1
    print(f"imported {created}, skipped {skipped} existing, backfilled {backfilled} dives "
          f"({matched} with deep dives)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())

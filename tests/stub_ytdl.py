#!/usr/bin/env python3
"""Stub yt-dlp for tests/test_slideshows.js — honors the real contract:
parses -o template and the URL, writes a fake m4a per video, prints the
--print lines (id|||duration|||title|||path) one per track like --newline does.

Modes via STUB_YTDL_FAIL env var:
  ""      success (default) — one track for watch URLs, two for playlists
  "exit"  nonzero exit mid-way (simulates network/age errors)
  "quiet" exit 0 but print nothing (the silent-failure path)
"""
import os, re, sys

args = sys.argv[1:]
out_tpl = args[args.index("-o") + 1]
url = args[-1]
fail_mode = os.environ.get("STUB_YTDL_FAIL", "")

def vid_of(u):
    m = re.search(r"(v=|youtu\.be/|shorts/)([\w-]{6,})", u)
    return (m.group(2) if m else "stubvid")[:11]

vid = vid_of(url)
if fail_mode == "exit" or vid.startswith("fail"):
    print("ERROR: unable to download video data: HTTP 403", file=sys.stderr)
    sys.exit(1)

ids = [vid] + (["playlistx"] if ("list=" in url or "/playlist" in url) else [])
for i, vid in enumerate(ids):
    path = out_tpl.replace("%(id)s", vid).replace("%(ext)s", "m4a")
    with open(path, "wb") as f:
        f.write(b"FAKE-M4A-BYTES-" * (i + 1))
    if fail_mode != "quiet":
        print(f"{vid}|||{200 + i}|||Stub Track {i}|||{path}", flush=True)

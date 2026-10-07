#!/usr/bin/env python3
"""Playable sibling of stub_ytdl.py — same CLI contract, but writes REAL
decodable AAC bytes (copies an ffmpeg fixture) so a browser <audio> element
can actually decode and "play" them. For browser e2e, not the node suite.

Modes via STUB_YTDL_FAIL env var: "" success | "exit" fail | "quiet" silent.
"""
import os, re, shutil, sys

FIXTURE = "/tmp/e2e-fixture/tone.m4a"  # ffmpeg -f lavfi -i sine=frequency=440:duration=4 -c:a aac tone.m4a

args = sys.argv[1:]
out_tpl = args[args.index("-o") + 1]
url = args[-1]
fail_mode = os.environ.get("STUB_YTDL_FAIL", "")

def vid_of(u):
    m = re.search(r"(v=|youtu\.be/|shorts/)([\w-]{6,})", u)
    return (m.group(2) if m else "stubvid")[:11]

if fail_mode == "exit":
    print("ERROR: unable to download video data: HTTP 403", file=sys.stderr)
    sys.exit(1)
if not os.path.exists(FIXTURE):
    print(f"ERROR: missing fixture {FIXTURE}", file=sys.stderr)
    sys.exit(1)

vid = vid_of(url)
ids = [vid] + (["playlistx"] if ("list=" in url or "/playlist" in url) else [])
for i, v in enumerate(ids):
    path = out_tpl.replace("%(id)s", v).replace("%(ext)s", "m4a")
    shutil.copyfile(FIXTURE, path)  # real bytes — the whole point of this stub
    if fail_mode != "quiet":
        print(f"{v}|||{200 + i}|||Tone Track {i}|||{path}", flush=True)

#!/bin/bash
# Detached server launcher: starts node server.js fully detached from the caller's
# process group (setsid + nohup) so killing the invoking shell doesn't take the
# server with it. Idempotent — won't double-start if :8080 already answers /health.
cd "$(dirname "$0")" || exit 1

if curl -sf http://localhost:8080/health >/dev/null 2>&1; then
  echo "already running"
  exit 0
fi

setsid nohup node server.js >> /tmp/bobs-server.log 2>&1 < /dev/null &
for i in $(seq 1 30); do
  curl -sf http://localhost:8080/health >/dev/null 2>&1 && { echo "started"; exit 0; }
  sleep 1
done
echo "failed to start — last log lines:"
tail -5 /tmp/bobs-server.log
exit 1

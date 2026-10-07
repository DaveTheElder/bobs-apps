#!/usr/bin/env bash
# Publish frontend/dist to the `pages` branch as a synthetic tree commit.
# dist/ is not tracked on main; LilServ's pages-deploy copies whatever is on
# pages/ into /home/chimera/homelab/sites/bobs-apps/ within seconds.
set -euo pipefail
REPO=/home/marvin/bobs-apps
DIST=$REPO/frontend/dist
[ -f "$DIST/index.html" ] || { echo "dist missing — run npm run build first"; exit 1; }

export GIT_DIR=$REPO/.git
export GIT_WORK_TREE=$DIST
IDX=$(mktemp)
unset GIT_INDEX_FILE
export GIT_INDEX_FILE=$IDX

git read-tree --empty
git add -A .
TREE=$(git write-tree)
C=$(git commit-tree "$TREE" -p "$(git rev-parse origin/pages)" -m "deploy: docs-app inline PDF preview")
git push origin "$C:refs/heads/pages"
rm -f "$IDX"
echo "pushed pages commit $C"

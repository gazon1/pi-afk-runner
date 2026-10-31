#!/usr/bin/env bash
# Prepare a worktree of this repository.
#
# The runner runs this inside every new worktree before anything else. This
# repository is a TypeScript package, so it needs the dependencies the gate runs
# with — including the dev ones, which `NODE_ENV=production` (set on the
# runner's host) would otherwise leave out.
#
# It also takes the project's Pi package list out of the way. That list is for a
# human's interactive session; in a worktree it loads nine extensions into a
# headless session, and one of them keeps a timer that reads a context after the
# session is gone — which killed the runner process and left the claim behind.
# `skip-worktree` keeps the local edit out of `git add -A`, so the change never
# reaches the pull request.
set -euo pipefail

if [[ -f .pi/settings.json ]]; then
  printf '{\n  "packages": []\n}\n' > .pi/settings.json
  git update-index --skip-worktree .pi/settings.json
  rm -rf .pi/npm
  echo "setup-worktree: project packages disabled in this worktree"
fi

if [[ -d node_modules ]]; then
  echo "setup-worktree: node_modules already here"
  exit 0
fi

npm ci --include=dev --no-audit --no-fund
echo "setup-worktree: installed"

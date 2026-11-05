#!/usr/bin/env bash
# Prepare a worktree of this repository.
#
# The runner runs this inside every new worktree before anything else. This
# repository is a TypeScript package, so it needs the dependencies the gate runs
# with — including the dev ones, which `NODE_ENV=production` (set on the
# runner's host) would otherwise leave out.
#
set -euo pipefail

if [[ -x node_modules/.bin/oxfmt ]]; then
  echo "setup-worktree: node_modules already here, with the dev tools"
  exit 0
fi

npm ci --include=dev --no-audit --no-fund
echo "setup-worktree: installed"

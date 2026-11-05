#!/usr/bin/env bash
# This repository's gate, under the name the runner's prompts use.
set -euo pipefail
cd "$(dirname "$0")"

# jactionlint needs mise, which also pins its version for CI. A gate that
# silently skips itself when its tool is missing is a gate that passes without
# checking anything. Fail before the slow checks, not after them.
mise_bin="$(command -v mise || echo "$HOME/.local/bin/mise")"
if [ ! -x "$mise_bin" ]; then
  echo "check.sh: mise is not installed; run 'mise install' (see mise.toml)" >&2
  exit 1
fi

npm run check
"$mise_bin" exec -- jactionlint --strict-exit

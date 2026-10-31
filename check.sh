#!/usr/bin/env bash
# This repository's gate, under the name the runner's prompts use.
set -euo pipefail
cd "$(dirname "$0")"
npm run check

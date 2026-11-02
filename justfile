# =============================================================================
# pi-afk-runner — Build & run recipes
# Run `just --list` for all available commands.
# =============================================================================

set shell := ["bash", "-uc"]
set unstable

# ==============================================================================
# DEFAULT
# ==============================================================================
[doc('Show available commands')]
default:
    @just --list --list-heading $'🎯 Available Commands:\n' --list-prefix '  • '

# ==============================================================================
# Build
# ==============================================================================
[doc('Build the command (tsc + copy prompts)')]
[group('build')]
build:
    npm run build

# ==============================================================================
# Run
# ==============================================================================
[doc('Autocombo: drain all ready-for-agent issues in queue until empty')]
[group('run')]
comb checkout repo="" model="" base="main" remote="origin":
    #!/usr/bin/env bash
    set -euo pipefail
    cli="$(pwd)/dist/cli.js"
    if [ ! -f "$cli" ]; then
      echo "dist/cli.js не найден. Сначала запусти: just build" >&2
      exit 1
    fi
    if [ ! -d "{{checkout}}" ]; then
      echo "checkout не найден или не директория: {{checkout}}" >&2
      exit 1
    fi
    export CMD_ZDR=0
    export NODE_USE_ENV_PROXY=1
    export HTTPS_PROXY=http://127.0.0.1:9191
    export HTTP_PROXY=http://127.0.0.1:9191
    export NO_PROXY="localhost,127.0.0.1,::1"
    args=(--checkout "{{checkout}}" --base "{{base}}" --remote "{{remote}}")
    if [ -n "{{repo}}" ]; then
      args+=(--repo "{{repo}}")
    fi
    if [ -n "{{model}}" ]; then
      args+=(--model "{{model}}")
    fi
    exec node "$cli" "${args[@]}" --all

[doc('Land the reviewed, green pull requests the runner opened')]
[group('run')]
merge checkout repo="" model="" base="main" remote="origin":
    #!/usr/bin/env bash
    set -euo pipefail
    cli="$(pwd)/dist/cli.js"
    if [ ! -f "$cli" ]; then
      echo "dist/cli.js не найден. Сначала запусти: just build" >&2
      exit 1
    fi
    if [ ! -d "{{checkout}}" ]; then
      echo "checkout не найден или не директория: {{checkout}}" >&2
      exit 1
    fi
    export CMD_ZDR=0
    export NODE_USE_ENV_PROXY=1
    export HTTPS_PROXY=http://127.0.0.1:9191
    export HTTP_PROXY=http://127.0.0.1:9191
    export NO_PROXY="localhost,127.0.0.1,::1"
    args=(--checkout "{{checkout}}" --base "{{base}}" --remote "{{remote}}" --merge)
    if [ -n "{{repo}}" ]; then
      args+=(--repo "{{repo}}")
    fi
    if [ -n "{{model}}" ]; then
      args+=(--model "{{model}}")
    fi
    exec node "$cli" "${args[@]}"

# ==============================================================================
# Legacy gates (kept for compatibility)
# ==============================================================================
tcheck-evals:
    @echo "tcheck-evals: this repository has no evals tier; ./check.sh is the gate"

docs-audit:
    @echo "docs-audit: this repository has no docs tier; ./check.sh is the gate"

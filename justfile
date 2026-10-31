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
[doc('Build extension (tsc + copy prompts)')]
[group('build')]
build:
    npm run build

# ==============================================================================
# Run
# ==============================================================================
[doc('Interactive mode: run Pi with local extension to steer the queue')]
[group('run')]
live checkout model="":
    #!/usr/bin/env bash
    set -euo pipefail
    ext="$(pwd)/dist/extension.js"
    if [ ! -f "$ext" ]; then
      echo "dist/extension.js не найден. Сначала запусти: just build" >&2
      exit 1
    fi
    if [ ! -d "{{checkout}}" ]; then
      echo "checkout не найден или не директория: {{checkout}}" >&2
      exit 1
    fi
    cd "{{checkout}}"
    export CMD_ZDR=0
    export NODE_USE_ENV_PROXY=1
    export HTTPS_PROXY=http://127.0.0.1:9191
    export HTTP_PROXY=http://127.0.0.1:9191
    export NO_PROXY="localhost,127.0.0.1,::1"
    PI_CMD="${PI_CMD:-$(command -v pi 2>/dev/null || echo /home/max/.nvm/versions/node/v24.14.0/bin/pi)}"
    if [ ! -x "$PI_CMD" ]; then
      echo "pi не найден. Установи pi или задай PI_CMD" >&2
      exit 127
    fi
    args=(--approve --extension "$ext")
    if [ -n "{{model}}" ]; then
      args+=(--model "{{model}}")
    fi
    echo "Запускаю Pi с pi-afk-runner в $(pwd)"
    echo "Команды: /afk-runner-run | /afk-runner-attach | /afk-runner-stop"
    exec "$PI_CMD" "${args[@]}"

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

# ==============================================================================
# Legacy gates (kept for compatibility)
# ==============================================================================
tcheck-evals:
    @echo "tcheck-evals: this repository has no evals tier; ./check.sh is the gate"

docs-audit:
    @echo "docs-audit: this repository has no docs tier; ./check.sh is the gate"

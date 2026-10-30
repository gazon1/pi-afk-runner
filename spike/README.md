# Spike — do the components compose?

The question this spike answers: **the runner is an assembly, not something we write. Do the
pieces fit together, or does each one assume it owns the session?**

It was the first task in the plan, because its answer decides what the rest of the plan is. The
answer is in [findings.md](findings.md).

## What was done

The extension repository was created and cloned; the components were installed **project-locally**,
so the host's shared Pi configuration was never touched; then a Pi session was started in the
repository with every component active and one model turn was run.

```bash
# the repository
gh repo create gazon1/pi-afk-runner --public --clone
cd pi-afk-runner

# the components, pinned, into .pi/settings.json of this project
pi install -l --approve npm:pi-subagents@0.84.0
pi install -l --approve npm:pi-advisor-flow@0.14.3
pi install -l --approve npm:@quintinshaw/pi-dynamic-workflows@3.15.0
pi install -l --approve npm:pi-lens@4.4.7
pi install -l --approve npm:@gotgenes/pi-permission-system@42.0.0
pi install -l --approve npm:agents-cron@0.15.0
pi install -l --approve npm:@signalridge/pi-worktree@1.4.5
pi install -l --approve npm:@narumitw/pi-github-pr@0.49.8
pi install -l --approve npm:@drix10/agent-flow@1.2.7

# what actually loaded — 93 commands, no errors
printf '{"type":"get_commands"}\n' | pi --mode rpc --approve

# one model turn with everything active
printf '{"type":"prompt","message":"Reply with exactly: READY"}\n' | pi --mode rpc --approve
```

## Two things you must know before running any of this yourself

**`--approve` is not optional.** Project-local packages are only loaded when the project is
trusted, and the trust is **per run** — there is no persistent "trusted project" list. A session
started without `--approve` loads the global packages and silently ignores `.pi/settings.json`.
The command list drops from 93 to 13, and the runner's components are simply not there.

**`pi list` does not show project-local packages.** It lists the user's packages. To see what
this project actually depends on, read `.pi/settings.json`.

## What was not done

One issue was **not** worked end to end. That half of the spike needs a runner, and the runner is
what the rest of the plan builds — so the end-to-end run is the first real run of T011, not
something this spike can do on its own. See the last section of [findings.md](findings.md).

---
name: singularity-todo-build-and-gates
description: How to build, test and lint the Singularity Todo KMP project, and how to run its gate suite. Use whenever a Gradle build, a test run, a detekt report, or a gate run is needed — or when a host is busy and the question is whether to start a long run now. Covers ./gw (the private Gradle home per worktree), the gate command surface, detekt's report file and order, the host-load threshold, and the rule that a long run is one background task rather than a poll loop.
---

# Build, gates and detekt

## `./gw`, never `./gradlew`

Parallel worktrees share `~/.gradle`, and a shared Gradle home is a shared
cache lock *and* a shared daemon registry: the build pushes against the
neighbours and takes several times longer. `./gw` gives the worktree a
private `GRADLE_USER_HOME` (the caches and the JDK stay shared — nobody
writes them at the same time). A detail, but on a machine with several
checkouts it is the difference between 5 and 40 minutes.

```bash
just gate         # every gate: check.sh → detekt → just cr → just gm agenda (SKIP_MAESTRO=1 — no flows)
./check.sh        # the gate registry + tests + Android + detekt
bash scripts/ci/static-gates.sh   # the script gates only (≈1 min, no JVM)
just tests::impact    # the tests this change can break (a map over the tree)
./gw :shared:jvmTest     # the fast cycle (no -Ptest.tags = only fast)
./gw :shared:jvmTest -Ptest.tags=fast,slow   # the full set, as CI runs it
./gw :shared:jvmTest -Ptest.tags=slow:migration   # one category of slow tests
./gw :androidApp:assembleDebug   # Android
./gw :desktopApp:run      # Desktop (xvfb-run -a)
./gw :desktopApp:test     # Desktop UI tests (the `test` task, not `jvmTest`)
./gw :shared:exportToolSurface   # regenerate config/docs/tool-surface.json

just lint        # detekt (every module, with its baseline), enforcing
just detekt-fix  # auto-fix detekt and ktlint in place

python3 scripts/detekt-summary.py   # detekt findings by rule, not an XML dump
```

### The map of affected tests — `just tests::impact`

The answer to "what does this change break?" is counted from the tree, not
invented: a change in an area pulls the tests of that area, a change in a class
pulls the tests that mention that class, a changed test pulls itself. These are
**candidates**, not a verdict: the map never says "outside the map is safe" —
it says what to run first.

### Compile right after a coupled edit

A change that pulls a neighbouring file with it (a signature, an interface, a
DI binding) is checked by compiling, in the same minute:
`./gw :shared:compileKotlinJvm` (for tests: `:shared:jvmTestClasses`). Opening
a full run on a broken compilation costs forty minutes of waiting, and the
diagnosis "the tests failed" points the wrong way: the compilation fails
first, and it fails with a different line.

### Stale `shared-jvm.jar`

`compileTestKotlinJvm` must depend on `jvmJar` (see `shared/build.gradle.kts`):
an entity change that never reaches the test classpath reads as "the tests
still pass", because the jar on the path is the previous build's. If a test
references a field that exists in source but the compiler says it does not,
rebuild `:shared:jvmJar` first rather than editing the test.

### `just <recipe> name=value` does not work

just 1.57.0 parses `tags=agenda` as an environment variable, not as a
parameter. Use the positional form: `just gma` (an alias for `gm agenda`).

## detekt

### The order

`:shared:detekt` first — it holds almost all the code, and a finding there
stops the check in two minutes instead of four modules:

```bash
./gw :shared:detekt                                  # first — 90% of the code
./gw :desktopApp:detekt :androidApp:detekt :mcp-server:detekt   # then the rest
```

### The findings are one file

`shared/build/reports/detekt/detekt.xml` — path, line, rule. The Gradle
console gives a counter and nothing else. **The rule and its rationale are in
the comments of `config/detekt/detekt.yml`**: that is why the threshold is
what it is. Custom rules live in `detekt-rules/` (e.g.
`NoDroppedUiStateProperty`: a state property is a required parameter of
**every** variant, a default is forbidden). `ClassSignature` — a data class
signature that fits on one line is written on one line (ADR
`2026-10-09-detekt-class-signature-gotcha`).

The report is XML *per finding*: `scripts/detekt-summary.py` prints the same
thing by rule and by place in two or three screens. Dumping `detekt.xml` into
the context is hundreds of lines for an answer that fits in the first twenty.

## The host may be busy

Another session's Gradle may be running on the same machine. It shares the
CPU, the RAM and the Gradle home, but not `shared/build`. A full
`:shared:jvmTest -Ptest.tags=fast,slow` in that state takes an hour instead of
half an hour, and the timeout tests (`CoroutineDiagnosticsTest`) flake from
the load rather than from the code.

Ask the host, do not remember it: `./sg host-load` (or `--json`). The
threshold is **2.0 per core**, measured: on 16 cores, load 16 (1.0/core) gives
`:shared:jvmTest` in 8 minutes, load 42–52 (2.6–3.2/core) in 24. Busy → run
the targeted set (`--tests`) or wait; run the full set once the targeted one is
green.

## The gate tooling belongs to the checkout

`sgate` is an editable install of `scripts/src/`, so a venv installed for
another worktree measures *that* worktree: the gate is green and it checked
somebody else's code. `bash scripts/ci/preflight-gate-tools.sh` prints whose
checkout it is (the `sgate` line; `FOREIGN` — not yours). Own venv per
checkout:

```bash
bash scripts/ci/setup-local-tools.sh
export PATH="$HOME/.venvs/singularity-todo-$(basename "$PWD")/bin:$PATH"
```

The installer names the venv after the checkout, so each checkout gets its own.
It refuses to take over a venv that serves another checkout — the refusal
names the two ways out. `SINGULARITY_TOOLS_VENV` still chooses the path, but
naming a venv by hand is a takeover, not a request for a new one.

`xvfb-run` is not installed everywhere: `:desktopApp:test` runs headless, and
`:desktopApp:run` is a GUI and needs an X server (`xvfb-run -a ./gw
:desktopApp:run`). A missing `xvfb-run` is no reason to skip the tests — they
are headless.

## The tool catalogue is a generated file

`config/docs/tool-surface.json` is read by the MCP server and by the agent.
It is generated (`./gw :shared:exportToolSurface`) and checked by a gate.
Change the schema or the description of a tool and regenerate it at once,
otherwise the gate says the catalogue is stale rather than what you changed.

## Every gate, one command, with a summary

`sgate run-all` prints a table and a panel per failing gate: a lot of lines,
of which the reader needs only the failures. `sgate run-all --summary` prints
one line per failing gate with the reason — enough to decide what to do next.
The full report is needed only when the summary's reason is unclear.

```bash
sgate run-all --summary              # one line per failing gate
sgate run-all                        # the full report (table + panels)
sgate run-all --gate "write tool"    # one gate, by name
```

## A long run is one background task, not a poll loop

The task prints its own final lines (`BUILD SUCCESSFUL` per step) — then no
polling is needed at all. Ten `sleep 30 && tail` is ten rounds of context
spent on nothing. A log that is needed later goes to a file with a unique
name (`build/diagnostics/<what>-<label>.log`), not to the shared one.

If waiting is unavoidable, wait with the tool: `./wait-for <log> <pattern>`
waits for a line in the log and prints the tail **once** (exit 0 — found, 1 —
timed out, 2 — wrong arguments). A poll loop is the same waiting, only
more expensive.

## Pushing to a PR branch — without `--no-verify`

The `pre-push` hook (`.githooks/pre-push`) checks the **pushable tree**: the
structural gates plus `detekt --auto-correct` (which fixes most of the
findings itself). Skipping the hook sends the same finding to CI — minutes
instead of half an hour. `--no-verify` is for WIP commits only.

The hook also carries the tree rules (on the pushable tree, not the working
one): the `AGENTS.md` pointers (`scripts/check-agents-pointers.py`), the
change's registry entry (`scripts/check-issue-registry.py`), the change's
review verdict (`scripts/check-review-verdicts.py`). Together they take under
two seconds; the full gate suite is deliberately *not* in the hook (1 m 17 s,
and two thirds of it is gates that have to run everything).

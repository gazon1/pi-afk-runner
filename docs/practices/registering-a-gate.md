# Registering a gate

**What this file is:** the order in which a gate is declared. A gate lives in
four places, and each of them answers a different question; reading them in the
wrong order is how a gate ends up registered in the registry and invisible to
CI, or visible to CI and unknown to `sgate`.

| Where | The question it answers |
|---|---|
| `scripts/src/sgate/commands/_registry.py` — `_REGISTERED` (`GateSpec`) | *What* the gate is: name, mode, dispatch |
| `scripts/src/sgate/gate_manifest.py` — `PLACEMENTS` (`Placement`) | *Where* it runs: a shell line, a cluster, or elsewhere |
| `scripts/src/sgate/commands/_registry.py` — `GATE_CONTROLS` (`Control`) | The one input change that must make it fail |
| `scripts/src/sgate/gate_controls.py` — `SCRIPT_GATES` (`ScriptGate`) | That same control, in the form the harness runs |

The first two are the declaration; the last two are the **positive control** —
without one, a gate nobody has seen fail is a gate that is green by accident.

`scripts/ci/static-gates.sh` is **generated** from the first two. Never edit its
gate lines by hand: the prose above a gate line lives in the placement, and the
file is a rendering of it (ADR `2026-10-21-one-manifest-and-one-placement-table.md`).

## 1. The script — `scripts/check-<name>.py`

Click, not argparse; a `--quiet` flag; distinct exit codes (0 clean, 1 findings,
2 = the tool could not read its input). Its own unit test goes to
`scripts/tests/test_check_<name>.py`.

## 2. The four declarations, in this order

```python
# scripts/src/sgate/commands/_registry.py — _REGISTERED
GateSpec(
    name="my gate says something",
    mode=GateMode.BLOCKING,
    cmd_type=CmdType.PYTHON3,
    script=Path("scripts/check-my-gate.py"),
    script_args=("--quiet",),
),

# scripts/src/sgate/commands/_registry.py — GATE_CONTROLS
'my-gate': Control(
    kind='sabotage',
    proves='scripts/check-my-gate.py',          # the join key: the script path
    argv=('{python}', 'scripts/check-my-gate.py'),
    path='docs/some-document.md',               # the file the sabotage edits
    edit=Edit(kind='replace', old='old text', new='new text', count=1),
    why='why this change is the one that must make the gate fail',
),

# scripts/src/sgate/gate_controls.py — SCRIPT_GATES
ScriptGate(
    name="my-gate",                              # the slug, as in GATE_CONTROLS
    cmd=[sys.executable, "scripts/check-my-gate.py"],
    why="why this control proves this gate",
),

# scripts/src/sgate/gate_manifest.py — PLACEMENTS
"my gate says something": Placement(
    kind=PlacementKind.STATIC,
    command='sgate my_gate_says_something',
    note="""Why this gate exists. The prose is rendered above the gate line in
the shell registry, so it travels with the gate it explains.""",
),
```

- **`GATES` is derived** from `_REGISTERED` — never edit it. The CLI command name
  is the display name with the spaces replaced by underscores, so
  `sgate my_gate_says_something` runs the gate.
- **The control's key is a slug**, not the display name. `proves` is the script
  path, and it is what attaches the control to the `GateSpec` — one script can
  back two gates with two different controls.
- **The twin's `cmd` must equal the registry's `argv`** with `{python}` read as
  `sys.executable`; Part J of `scripts/check-gate-wiring.py` compares the two and
  fails when they disagree about the file or the command. The sabotage itself is
  filled in from the registry, so the twin declares only the command and the why.
- **`PlacementKind.CLUSTER`** names the cluster wrapper that runs the gate;
  `PlacementKind.ELSEWHERE` carries the reason and the pointer (`tracked_by`)
  that says where it runs instead. Every registered gate needs a placement, keyed
  by the display name.

## 3. Render, then verify

```bash
sgate render-static-gates --write   # rewrites the generated region of scripts/ci/static-gates.sh
sgate render-registry               # rewrites docs/scripts/gate-registry.md

sgate render-static-gates --check    # the shell registry is what the manifest renders
sgate render-registry --check        # the gate catalogue is current
python3 scripts/check-gate-registries.py --strict   # the two registries agree
python3 scripts/check-gate-wiring.py                # controls, twins, reachability
python3 -m unittest discover -s scripts/tests       # the gate's own test
sgate my_gate_says_something                        # run the gate
```

`render-static-gates` **checks** by default and writes only with `--write` — the
JSON-contract probe runs every gate with `--json` alone, and a generator that
wrote by default would certify a file it had just rewritten. `render-registry`
is the other way round: it writes by default, `--check` verifies.

## What fails when a step is skipped

| Skipped | The gate that says so | Its message |
|---|---|---|
| the placement | `scripts/tests/test_gate_manifest.py` | `registered gates with no placement` |
| the render | `the shell registry is current` | the file is not what the manifest renders |
| the control | Part J of `check-gate-wiring.py` | `registry gate '…' has no positive control` |
| the twin, or a twin that disagrees | Part J of `check-gate-wiring.py` | `the control for '…' and the registry entry disagree about …` |
| the registry entry (the script alone) | Part H of `check-gate-wiring.py` | `scripts/check-….py can fail and is named by no gate surface` |
| the shell line | `scripts/check-gate-registries.py` | a gate line with no registry entry, or the other way round |

## Traps

- **Two names.** The display name (`my gate says something`) is what the
  registry and the placement speak; the control's slug (`my-gate`) is what the
  control and its twin speak; the CLI command name is the display name with
  underscores.
- **A control that changes more than the file's content** must say how to put it
  back (`sabotage_restore`) — `git rm --cached` leaves the index describing a
  different tree than the files on disk.
- **The pre-push hook is a separate list.** A gate that must run against the tree
  being pushed is named in `PRE_PUSH_TREE_RULES` (`_registry.py`); the hook runs
  those rules with `env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_COMMON_DIR`,
  so a rule that reads a tree of its own must build its own environment — see
  `scripts/src/sgate/gatekit/gitenv.py` (`tree_env()`, the owner of that answer)
  and `scripts/check-git-environment.py`.

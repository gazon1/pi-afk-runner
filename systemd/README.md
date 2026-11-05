# Running the runner on a timer

The runner is unattended: it drains the queue, working each eligible issue in
turn — a worktree, a pull request, and a second agent's review for every one of
them. Somebody has to start it, and the scheduler is systemd.

## Installing

```bash
npm i -g pi-afk-runner
cp systemd/pi-afk-runner.service systemd/pi-afk-runner.timer ~/.config/systemd/user/
cp systemd/pi-afk-runner-merge.service systemd/pi-afk-runner-merge.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now pi-afk-runner.timer
systemctl --user enable --now pi-afk-runner-merge.timer
```

The units read `MINIMAX_API_KEY` from `%h/.config/afk-runner/env` — create it
before the first tick, or the unit will not start ([The key's
file](#the-keys-file)).

The merge timer is optional: with it, the runner also lands the reviewed pull
requests it opened (see [Merging](#merging) below). Without it, the work timer
opens and reviews, and a human lands — the work pipeline's own guarantee.

**Edit the service first.** Its paths are placeholders with the shape of a real
installation: the runner works in a checkout of the repository it operates on,
and the worktrees live outside both.

The unit needs two things from the environment that systemd does not have:

- `gh` must be authenticated, and the token must be able to push the branch
  `agent/issue-<N>`, to open a pull request and to label an issue. The
  runner's own token is not the maintainer's session token — an unattended run
  that dies with the session that authorized it is an unattended run that
  stops. `gh` keeps that token in its own store (`~/.config/gh/hosts.yml`),
  and the runner does not need it in its environment.
- `MINIMAX_API_KEY` must be set, so that the model gateway can resolve a model.
  The runner holds no credential of its own.

### The key's file

Both units read it from one file — `%h/.config/afk-runner/env` — and the file
is what the unit's `EnvironmentFile=` names:

```bash
mkdir -p ~/.config/afk-runner
printf 'MINIMAX_API_KEY=%s\n' "$MINIMAX_API_KEY" > ~/.config/afk-runner/env
chmod 600 ~/.config/afk-runner/env
```

One `NAME=value` per line, no `export`. The file is the only place the key
lives: `systemctl --user` reads neither `~/.bashrc` nor the shell's
environment, and a key typed into a terminal is a key the timer never sees.
Mode 600 — the file holds a credential, and the units read it as the user.

**The file is required.** With it missing, the unit does not start, and the
timer's journal says why. A runner with no key is a runner that cannot resolve
a model, and starting it anyway only moves the failure later and further from
its cause.

A key that changed needs nothing: the file is read at every start of the unit,
so the next tick picks the new value up. `daemon-reload` is for the unit files
themselves, not for the key.

**A timed run gates nothing and builds nothing.** The tree the agent leaves is
the tree that is pushed, and the pull request's own CI judges it. Nothing in the
run compiles either: the guard refuses the build commands, so the unit needs no
Gradle daemon and no build minutes. A repository that wants gates says so in
`.afk-runner.json` in the root of the checkout — the unit needs no change for that
— and the command line wins over that file.

**The host needs the target repository's own tools** for the gates a run is told
to run: `just` and whatever those gates call have to be on the machine the timer
runs on, and on the PATH the unit gives it. The tools of a checkout live in that
checkout's own venv, and the repository's setup script says where: the gates run
with the PATH it printed. A gate that could not run says so and ends the run
(`45`); it does not look like a gate that refused the change.

The run's budget is divided into three shares: the session keeps two hours, the
gates keep an hour each — the same the merge door gives the same gate — and the
review keeps what is left. A run with no gate reserves no gate budget. A sweep
that works several issues takes several hours — the timer fires hourly, and the
lock keeps the ticks from overlapping.

## What the exit code says

The unit's status is the exit code, and the code names the step:

| Code | What it says                                                                           |
| ---- | -------------------------------------------------------------------------------------- |
| 0    | the run finished, or the queue was empty                                               |
| 1    | an issue could not be worked — claimed elsewhere, already reviewed, or already counted |
| 3    | no model was available — the pool had nothing that could answer                        |
| 10   | the selection failed                                                                   |
| 20   | the claim failed                                                                       |
| 30   | the worktree failed                                                                    |
| 40   | the agent's session failed, or was cut off by the deadline                             |
| 45   | the repository's gates did not pass — the run pushed nothing                           |
| 50   | the push failed                                                                        |
| 60   | the pull request failed                                                                |
| 70   | the review failed                                                                      |
| 80   | the re-count failed                                                                    |
| 75   | another runner holds the lock — the run skipped itself                                 |
| 76   | the lock could not be taken — the run refused to start                                 |

A `75` is not a failure: the timer fired while a run was still going, and the
runner left the work to the run that is already doing it. A `76` **is** a
failure: the lock directory could not be written, and a runner that cannot
take the lock must never look like a runner that had nothing to do.

A `3` says the model pool had nothing that could answer — every model was out
of its limit, at its peak tariff, or unreachable. The sweep stops there rather
than failing every issue in the queue.

The unit runs with `--all`, so one status covers a whole sweep. The sweep reads
the queue once and works it by number, so an issue that fails does not put
itself back in front of the queue and no issue is worked twice. A failure does
not stop the sweep; the status is the code of the failure of the issue with the
smallest number, and `0` means every issue in the list was worked. An issue
that cannot be worked — a fresh claim that belongs to a run elsewhere — is
reported and counts as a failure, so a sweep never says "drained" while an
issue was left. The sweep's lock is taken
once, for the whole sweep, and given back at the end; each issue it works also
takes that issue's lock while it is being worked, so a hand-started `--issue
<N>` run and the sweep cannot work the same issue at the same time.

The unit works one issue at a time. An operator who wants the sweep to work
several issues at once adds `--workers N` to the unit's arguments, and the
number is the host's to choose: the workers share one host's CPU, its network
and its model pool's limits.

`TimeoutStartSec` is `infinity`. A sweep has no fixed length, so any finite
value is a kill in the middle of one. Each issue's turn is still bounded by the
runner's own budget: the session's share of it. The cost of the backstop being
gone: a genuinely
hung `gh` or `git` call is not stopped by systemd, and the timer will not start
a second instance while this one runs. The runner's own bounds are what stop it:
a command is killed after fifteen minutes, and the run stops waiting for it
whether the command obeys the kill signal or not.

## Merging

`pi-afk-runner-merge.timer` runs the same binary with `--merge`, and a lock of
its own, so a merge and the work runs do not wait for each other and two
merges never run at once. It lands the open pull requests whose branch is
`agent/issue-<N>` and whose **newest** review comment says `**Verdict:** pass`,
that carry `agent-reviewed`, that are not drafts, and whose CI the repository's
own `scripts/ci-verdict.py` calls a success. Anything else is named and left
for the next tick.

A pull request whose branch does not move is landed as CI judged it. One whose
branch has to move — a conflict, or the base's arrival breaking the gate — is
resolved by an agent, gated with `./check.sh`, pushed and reviewed, and lands on
the **next** tick, once CI has judged the new commit. That is deliberate: a merge
never lands a commit CI has not seen, and the interval is the cost of it.

The sweep has one budget, the same `--deadline-ms` the work run has: the
resolution, the gate and the review take shares of what is left when their turn
comes, and a pull request it does not start before the clock is gone is left for
the next tick with that reason.

Its status is simpler than the work sweep's: `0` when every step that ran
succeeded, `1` when a pull request stopped at a step — the step and the pull
request are in the message and in `build/diagnostics/merge/pr-<N>/`. A skipped
pull request is `0`: the review or the CI has not cleared it yet, and so is one
the run's clock left no budget for.

## What the journal says

The unit's output is the journal, and it says what the sweep did: one line per
issue, and the sweep's total at the end.

```
issue 42 — Fix the thing — pr #1040 — review pass — 3m 12s — 12345 tokens — $0.42 — record /path/to/the/checkout/build/diagnostics/issue-42/2026-10-30T09-00-00-000Z-abcdef12.md
issue 43 — Fix the other thing — pr #1041 — review pass — 1m 5s — 6789 tokens — $0.21 — record /path/to/the/checkout/build/diagnostics/issue-43/2026-10-30T10-12-44-901Z-b2c4f6a1.md
total: 2 of 2 issues worked — 4m 17s — 19134 tokens — $0.63
```

The tokens and the cost are absent when the provider reported none — a zero is
a number, and a number a reader would trust.

## Two runners, one host

The unit is `Type=oneshot`, so systemd will not start a second one while the
first is running. The lock is the backstop for a runner started by hand: a run
started on an issue another run is already working exits `75` immediately,
having read nothing and written nothing. The lock is per issue, so several
runners may work different issues on one host at once — the timer's sweep
holds the queue's lock, and that is the one a hand-started `--all` waits on.

## A claim left behind

A run that is killed leaves its claim on the issue, and a claim keeps the issue
out of the queue. The next run that finds the claim stale takes it over: the
stale claim's ref is deleted, the issue is claimed again, and the work is redone
— the session that made it is gone with the process that died.

`--stale-after-ms` is how long a claim may sit before that happens. It is eight
hours here: a run is capped at the runner's own budget — the three shares added
up, five and a half hours — and the issue's lock means no
second runner on this machine can be working that issue. So a claim a killed sweep left
behind is taken over a tick or two later, not after a week. A human who comments
on the issue moves its last-update time, and the comment defers the take-over
without anybody having to know there is one.

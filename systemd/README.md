# Running the runner on a timer

The runner is unattended: it takes an issue from the queue, works it, opens a
pull request and has a second agent review it. Somebody has to start it, and
the scheduler is systemd.

## Installing

```bash
npm i -g pi-afk-runner
cp systemd/pi-afk-runner.service systemd/pi-afk-runner.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now pi-afk-runner.timer
```

**Edit the service first.** Its paths are placeholders with the shape of a real
installation: the runner works in a checkout of the repository it operates on,
and the worktrees live outside both.

The unit needs two things from the environment that systemd does not have:

- `gh` must be authenticated, and the token must be able to push the branch
  `agent/issue-<N>`, to open a pull request and to label an issue. The
  runner's own token is not the maintainer's session token — an unattended run
  that dies with the session that authorized it is an unattended run that
  stops.
- `PI_AGENT_DIR` must point at Pi's agent directory, so that the session the
  runner creates has its settings and its credentials.

## What the exit code says

The unit's status is the exit code, and the code names the step:

| Code | What it says |
|---|---|
| 0 | the run finished, or the queue was empty |
| 10 | the selection failed |
| 20 | the claim failed |
| 30 | the worktree failed |
| 40 | the agent's session failed, or was cut off by the deadline |
| 50 | the push failed |
| 60 | the pull request failed |
| 70 | the review failed |
| 80 | the re-count failed |
| 75 | another runner holds the lock — the run skipped itself |
| 76 | the lock could not be taken — the run refused to start |

A `75` is not a failure: the timer fired while a run was still going, and the
runner left the work to the run that is already doing it. A `76` **is** a
failure: the lock directory could not be written, and a runner that cannot
take the lock must never look like a runner that had nothing to do.

## Two runners, one host

The unit is `Type=oneshot`, so systemd will not start a second one while the
first is running. The lock is the backstop for a runner started by hand: it
exits `75` immediately, having read nothing and written nothing.

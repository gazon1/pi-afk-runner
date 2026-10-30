#!/usr/bin/env python3
"""ci-verdict.py — the CI verdict of a commit, a branch or a pull request.

What went wrong
---------------
A claim about CI that names a run id and nothing else is not evidence. A
repository has several workflows, and the one that says "success" may be the
cache cleanup: `gh run list --branch main` answers with every workflow that
touched the branch, and the first successful line in that list is not the
build. A session that read it that way reported a green CI for a red branch,
and the correction cost the reader a second look at the logs.

So the claim is a whole line, and this tool prints that line:

    ci.yml  run 39888579980  failure  https://github.com/gazon1/sing/actions/runs/39888579980

Three parts, all of them: the workflow that decides, the run, and what it
concluded. The exit code is the conclusion — 0 when the CI workflow concluded
`success`, 1 when it concluded anything else, 2 when there is no run at all. A
missing run is not a pass: "I could not find the run, so there is nothing to
complain about" is the vacuous green this repository keeps paying for.

What it reads
-------------
The runs of the `CI` workflow for a commit, as `gh run list` reports them. The
`--runs` option reads that list from a file instead, so the reading and the
judging are separate: the unit test judges a list, and never asks GitHub.

A captured list must carry `workflowName` on every run, the way `gh` reports
it. A run that names no workflow is attributed to no workflow, and the tool
says there is no run rather than picking one: the cache cleanup succeeds often
and says nothing about the build, and a list captured without the name cannot
tell the two apart.

Usage:
    python3 scripts/ci-verdict.py                 # the commit in the worktree
    python3 scripts/ci-verdict.py HEAD            # a commit
    python3 scripts/ci-verdict.py 973             # a pull request
    python3 scripts/ci-verdict.py origin/main     # a remote branch
    python3 scripts/ci-verdict.py --json          # machine-readable
    python3 scripts/ci-verdict.py --runs runs.json   # judge a captured list

A branch name is resolved by git, so it is the branch in this checkout — `main`
is the local branch, and `origin/main` is the remote one. A number is read as a
pull request, because a number is also a valid short sha and a pull request is
what a person means by it.

Exit codes:
    0 = the CI workflow concluded success
    1 = it concluded something else
    2 = there is no run of that workflow for the commit
    3 = the run list could not be read (GitHub was not asked, or it did not answer)

The tool does not wait for GitHub for ever: the call to `gh` has a deadline
of twenty seconds, and a call that runs into it is reported as "gh did not
answer in 20 seconds — the verdict is not known" — exit code 3. A caller that
asks the verdict in the middle of a push must not wait for the network, and
must not need a program it cannot count on having.

The line names the workflow by its file name — `ci.yml` — because that is the
name the tool takes and the name the reader needs to find the run. GitHub
reports the same workflow as "CI"; the tool reads the runs of the file and
prints the file.
"""

from __future__ import annotations

import json
import pathlib
import subprocess
import sys

import click

#: The workflow that decides whether a change is good. The others — the cache
#: cleanup, CodeQL, the nightly alert — report on other things.
DEFAULT_WORKFLOW = 'ci.yml'

#: The repository the tool reads by default. Overridable, because a worktree
#: of a fork is a different repository.
DEFAULT_REPO = 'gazon1/sing'

#: The conclusions that are not a verdict yet.
UNFINISHED = frozenset({'', 'skipped', 'in_progress', 'queued', 'waiting', 'pending', 'requested'})

CLEAN = 0
NOT_SUCCESS = 1
NO_RUN = 2
IO_ERROR = 3


def _is_the_workflow(run: dict, workflow: str) -> bool:
    """Whether a run belongs to the workflow that decides.

    `gh run list --workflow ci.yml` already filters on the server, and the
    name it reports is the workflow's *display* name — "CI" for `ci.yml`. So
    the comparison is on the stem, case-folded.

    A run that names no workflow belongs to no workflow. `gh` always reports
    the name, so a run without one came from a list captured without it — and
    the whole point of this tool is that the cache cleanup, which succeeds
    often and says nothing about the build, must never be read as the build.
    A run that cannot be attributed is not attributed.
    """
    name = (run.get('workflowName') or '').strip()
    if not name:
        return False
    stem = workflow.rsplit('.', 1)[0].strip().lower()
    folded = name.lower().replace(' ', '-')
    return name == workflow or folded == stem


def verdict_from_runs(runs: list[dict], workflow: str) -> tuple[str, int]:
    """The verdict of the most recent run of `workflow`, and an exit code.

    The list is the one `gh run list` reports: a list of dictionaries with
    `databaseId`, `conclusion`, `status` and `url`. The most recent run wins —
    a rerun of the same commit is the one that answers the question, and the
    older run is the one that failed and was retried.
    """
    mine = [run for run in runs if _is_the_workflow(run, workflow)]
    if not mine:
        if runs:
            return (
                f'no run of the {workflow} workflow — none of the listed runs names it',
                NO_RUN,
            )
        return f'no run of the {workflow} workflow', NO_RUN

    # `gh run list` returns newest first, but a captured list may not be
    # sorted, and the newest run is the one that answers.
    chosen = max(mine, key=lambda run: int(run.get('databaseId') or 0))
    run_id = chosen.get('databaseId')
    conclusion = (chosen.get('conclusion') or chosen.get('status') or '').strip()
    url = chosen.get('url') or ''
    line = f'{workflow}  run {run_id}  {conclusion}  {url}'.rstrip()

    if conclusion == 'success':
        return line, CLEAN
    if conclusion in UNFINISHED:
        return f'{line}  (the run has not concluded)', NOT_SUCCESS
    return line, NOT_SUCCESS


#: How long the call to `gh` may take. The deadline belongs here and not in
#: the caller: `timeout` is a GNU coreutils command, and a caller that shells
#: out to it works on Linux and silently does nothing on a machine without it.
#: The push that asks for the verdict must not wait for the network, and it
#: must not need a program it cannot count on having.
GH_TIMEOUT_SECONDS = 20


def _gh(args: list[str], repo: str) -> str:
    """Run `gh` and return its output, or raise."""
    try:
        result = subprocess.run(  # noqa: S603 — a fixed argv, no shell
            ['gh', *args, '--repo', repo],
            capture_output=True,
            text=True,
            check=False,
            timeout=GH_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(
            f'gh did not answer in {GH_TIMEOUT_SECONDS} seconds — the verdict is not known'
        ) from None
    if result.returncode != 0:
        message = (result.stderr or result.stdout or 'gh failed').strip()
        raise RuntimeError(message.splitlines()[0] if message else 'gh failed')
    return result.stdout


def _git(args: list[str]) -> str:
    """Run `git` in this checkout and return its output, or raise."""
    result = subprocess.run(  # noqa: S603 — a fixed argv, no shell
        ['git', *args],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        message = (result.stderr or result.stdout or 'git failed').strip()
        raise RuntimeError(message.splitlines()[0] if message else 'git failed')
    return result.stdout


def resolve_commit(ref: str, repo: str) -> str:
    """The commit a reference names.

    A pull request number is a number, and a number is also a valid short
    sha — so a number is read as a pull request first, and a name that is not
    a number is read as a revision of this checkout.
    """
    if ref.isdigit():
        payload = json.loads(_gh(['pr', 'view', ref, '--json', 'headRefOid'], repo))
        return str(payload['headRefOid'])
    return _git(['rev-parse', ref]).strip()


def fetch_runs(commit: str, workflow: str, repo: str) -> list[dict]:
    """The runs of one workflow for one commit."""
    output = _gh(
        [
            'run', 'list',
            '--commit', commit,
            '--workflow', workflow,
            '--limit', '20',
            '--json', 'databaseId,conclusion,status,url,workflowName,createdAt',
        ],
        repo,
    )
    return json.loads(output or '[]')


@click.command()
@click.argument('ref', default='HEAD')
@click.option('--workflow', default=DEFAULT_WORKFLOW, help='the workflow that decides (default: ci.yml)')
@click.option('--repo', default=DEFAULT_REPO, help='the repository to read (default: gazon1/sing)')
@click.option('--runs', 'runs_file', default=None, help='judge a captured run list instead of asking GitHub')
@click.option('--json', 'as_json', is_flag=True, help='machine-readable output')
@click.pass_context
def cli(ctx: click.Context, ref: str, workflow: str, repo: str, runs_file: str | None, as_json: bool) -> None:
    """Print the CI verdict of a commit, a branch or a pull request."""
    try:
        if runs_file:
            runs = json.loads(pathlib.Path(runs_file).read_text(encoding='utf-8'))
        else:
            commit = resolve_commit(ref, repo)
            runs = fetch_runs(commit, workflow, repo)
    except (OSError, ValueError, RuntimeError, KeyError) as exc:
        click.echo(f'ci-verdict: could not read the runs of the {workflow} workflow: {exc}')
        raise ctx.exit(IO_ERROR)

    line, code = verdict_from_runs(runs, workflow)
    if as_json:
        click.echo(json.dumps({'workflow': workflow, 'verdict': line, 'exit': code}, ensure_ascii=False))
    else:
        click.echo(line)
    raise ctx.exit(code)


if __name__ == '__main__':
    raise SystemExit(cli.main(standalone_mode=False))

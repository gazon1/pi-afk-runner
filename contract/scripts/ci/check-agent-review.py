#!/usr/bin/env python3
# no-sgate: this check does not go through `sgate.commands.base.run` — it asks
# GitHub about a pull request, not the tree it sits in, so it has no gate to
# declare. It does read the vocabulary of a verdict from `sgate.gatekit`, which
# is this checkout's, so that the two gates that read verdicts cannot drift
# apart on how a verdict is written.
"""check-agent-review.py — a pull request carries the review of a separate agent.

What went wrong
---------------
`AGENTS.md` says a change is reviewed by a separate agent before the pull
request is opened, and it says it in one line. The line was carried for a
session and executed for a session — and then never again: the pull requests
that followed carried no review, and nothing in the repository, in the pull
request, or in the workflow could tell the difference between a change that
was reviewed and a change that was not.

A rule nobody can check is a rule nobody follows. The rule was not wrong; it
was unenforceable. This check makes it enforceable.

The rule
--------
A pull request carries a review comment left by an agent that did not write
the change. The comment opens with the marker

    <!-- agent-review -->

and states a verdict:

    **Verdict:** pass

`pass` says the review found nothing that blocks the change. `fail` says it
found something, and the pull request has to deal with it: the check fails on
a `fail` verdict, because a review that found something and a pull request
that merged anyway are two different things, and only one of them is right.

The comment is the evidence. A review that happened in a session and left
nothing behind is a review the next reader cannot see, and the rule this
check exists to enforce is about the *next* reader as much as about the
reviewer.

What counts as a review
-----------------------
- The marker has to be the **first line** of the comment. The marker is
  written down in this file, in the pull request template and in
  `AGENTS.md`, so a comment that quotes the format — the rule itself, for
  instance — is not a review. A quote in the middle of a paragraph is not a
  review either.
- The verdict has to be a verdict, not the placeholder. `**Verdict:** pass`
  is a verdict; `**Verdict:** pass | fail` is the format written down in the
  template, and it decides nothing.

The second place a verdict is written down
----------------------------------------
`main` carries a second mechanism: `scripts/check-review-verdicts.py` wants a
verdict **file** for every change under `openspec/changes/` — the record of
what the review said about the change's contract.

The two verdicts have different scopes, and a gate that said they had to be
equal would demand a state this repository does not have:

- the **comment** is the pull request's verdict, and it is transient on
  purpose: the newest review decides whether the pull request is red today,
  and a later `pass` clears an earlier `fail`;
- the **file** is the change's verdict, and it is a permanent record: a
  `fail` there is legal and stays, because "the review found something" is
  the interesting case and the file is where that is written down.

So this check does not compare the two verdicts. It asks the question they
*do* share — **what was reviewed** — because the file points at a pull
request, and a pointer that does not point at anything is a finding:

- a verdict file that names **this** pull request has to be about a change
  **this** pull request carries;
- a change whose **contract** this pull request moves has to carry a verdict
  that names **this** pull request — a contract that moves is re-issued, not
  re-read, and the re-issue names the pull request where the contract moved.

The second half is what the check is for. `scripts/check-review-verdicts.py`
catches a contract that moved and nobody re-issued the verdict; this one
catches a verdict that was re-issued for the wrong pull request, and a
verdict that points at a pull request that carries no such change.

The format of a verdict file — its frontmatter, the two verdicts it may
carry, the pull request it names — lives in `sgate.gatekit.verdicts`, and
both gates read it from there.

What this check does not do
---------------------------
It does not decide whether the review was good, and it does not judge the
comment's author: the reviewer runs under the same account as the author, so
"separate" is a fact about the session, not about the login. The check
measures what can be measured — that the review is written down, on the pull
request, with a verdict.

Usage:
    python3 scripts/ci/check-agent-review.py --pr <number>
    python3 scripts/ci/check-agent-review.py --comments-file comments.json
    python3 scripts/ci/check-agent-review.py --pr <number> --reviews-dir <dir>
    python3 scripts/ci/check-agent-review.py --pr <number> --files-file files.json

Exit codes:
    0 — the pull request carries an agent review whose verdict is `pass`
    1 — it carries none, one without a verdict, or one whose verdict is `fail`
"""

from __future__ import annotations

import json
import pathlib
import re
import subprocess
import sys

import click

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent

# The vocabulary of a verdict is this checkout's — the gate reads it from the
# tree it sits in, and not from whatever `sgate` happens to be installed.
sys.path.insert(0, str(ROOT / "scripts" / "src"))

from sgate.gatekit.verdicts import (  # noqa: E402
    changed_slugs,
    moved_contracts,
    pull_request_of,
    verdict_files,
)

CLEAN = 0
VALIDATION_FAILURE = 1

#: Where the verdict files live: one per change, under `.specify/reviews`.
DEFAULT_REVIEWS_DIR = ROOT / ".specify" / "reviews"

#: The marker an agent's review comment opens with.
MARKER = "<!-- agent-review -->"

#: A line that states a verdict — and nothing else on the line.
#:
#: The verdict is the whole value of the line: `**Verdict:** pass` is a
#: verdict, and `**Verdict:** pass or fail` is a sentence about verdicts.
#: A search for the word "pass" anywhere on the line finds `this will not
#: pass` as readily as `pass`, and a check that reads that as a green light
#: is a check that can be fooled by a copy of the format.
VERDICT_LINE = re.compile(
    r"^\s*\**\s*verdict\s*\**\s*:\s*\**\s*(pass|fail)\s*\**\s*\.?\s*$",
    re.IGNORECASE,
)


class ReviewNotFound(Exception):
    """The pull request carries no agent review."""


class ReviewWithoutVerdict(Exception):
    """The agent review carries no verdict."""


class ReviewFailed(Exception):
    """The agent review found something, and the pull request has to deal with it."""


def opens_with_the_marker(body: str) -> bool:
    """True when the comment *opens* with the review marker.

    The marker is written down in this file, in the pull request template and
    in `AGENTS.md`. A comment that quotes it — a person asking what the
    format is, or a copy of the rule — is not a review, so the marker has to
    be the first thing the comment says.

    @param body the body of a comment.
    """
    for line in body.splitlines():
        if not line.strip():
            continue
        return line.strip() == MARKER
    return False


def stated_verdict(body: str) -> str | None:
    """The verdict an agent's review comment states, or `None`.

    A comment that states two different verdicts decides nothing: a review
    that says `pass` and a review that says `fail` in the same comment is a
    comment nobody can read, and the check says so rather than picking one.

    @param body the body of a comment.
    """
    if not opens_with_the_marker(body):
        return None
    stated = {
        match.group(1).lower()
        for line in body.splitlines()
        if (match := VERDICT_LINE.match(line)) is not None
    }
    if len(stated) == 1:
        return stated.pop()
    return None


def review_of(comments: list[dict]) -> tuple[str, str]:
    """The verdict of the pull request's agent review, and the comment's URL.

    The newest review wins: a review that found something and a later review
    that did not is a story that ended well, and the pull request says so. A
    newest review that decides nothing decides nothing — the verdict before it
    is not the verdict of the pull request.

    @param comments the pull request's comments, as GitHub returns them —
        oldest first.
    @raises ReviewNotFound when no comment opens with the marker.
    @raises ReviewWithoutVerdict when a marked comment states no verdict.
    @raises ReviewFailed when the newest verdict is `fail`.
    """
    marked = [comment for comment in comments if opens_with_the_marker(comment.get("body") or "")]
    if not marked:
        raise ReviewNotFound(
            "no comment opens with the agent-review marker "
            f"(`{MARKER}`) — the review has to be written down on the pull request"
        )
    newest = marked[-1]
    verdict = stated_verdict(newest.get("body") or "")
    if verdict is None:
        # The newest review decides — and a review that decides nothing is not
        # an older review's pass. A comment that says `pass` and `fail` in the
        # same breath says nothing, and a check that falls back to the verdict
        # before it would report a green that nobody wrote.
        raise ReviewWithoutVerdict(
            "the newest agent review carries no verdict — it has to say "
            "`**Verdict:** pass` or `**Verdict:** fail`, and it has to say one of them"
        )
    if verdict == "fail":
        raise ReviewFailed(
            "the agent review says `fail` — the findings have to be dealt with, and a "
            "review that says `pass` has to say it again"
        )
    return verdict, newest.get("html_url") or ""


def comments_of(pull_request: int) -> list[dict]:
    """The comments of a pull request, as GitHub has them.

    @param pull_request the number of the pull request.
    """
    result = subprocess.run(
        [
            "gh", "api",
            f"repos/{{owner}}/{{repo}}/issues/{pull_request}/comments",
            "--paginate",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise ReviewNotFound(
            f"the comments of #{pull_request} could not be read: {result.stderr.strip()}"
        )
    try:
        payload = json.loads(result.stdout or "[]")
    except json.JSONDecodeError as exc:
        raise ReviewNotFound(f"the comments of #{pull_request} are not readable: {exc}") from exc
    return payload if isinstance(payload, list) else []


def files_of(pull_request: int) -> list[str]:
    """The paths a pull request touches, as GitHub has them.

    @param pull_request the number of the pull request.
    """
    result = subprocess.run(
        [
            "gh", "api",
            f"repos/{{owner}}/{{repo}}/pulls/{pull_request}/files",
            "--paginate",
            "--jq", ".[] | .filename",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise ReviewNotFound(
            f"the files of #{pull_request} could not be read: {result.stderr.strip()}"
        )
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def paths_of(files_file: pathlib.Path) -> list[str]:
    """The paths a pull request touches, read from a JSON file.

    The file holds a list of paths, or a list of the objects GitHub returns —
    `{"filename": "..."}` — because both are the same list in two shapes.

    @param files_file the file to read.
    """
    try:
        payload = json.loads(files_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ReviewNotFound(f"the files of the pull request are not readable: {exc}") from exc
    if not isinstance(payload, list):
        raise ReviewNotFound("the files of the pull request are not a list of paths")
    paths: list[str] = []
    for entry in payload:
        if isinstance(entry, str):
            paths.append(entry)
        elif isinstance(entry, dict) and isinstance(entry.get("filename"), str):
            paths.append(entry["filename"])
    return paths


def pointer_findings(
    pull_request: int,
    reviews_dir: pathlib.Path,
    changed_paths: list[str],
) -> list[str]:
    """Where the verdict files and the pull request disagree about the pointer.

    A verdict file names the pull request whose review it records, and the
    pull request says which changes it carries. Two things have to hold:

    - a file that names this pull request is about a change this pull request
      carries — a pointer that points at a pull request carrying no such
      change points at nothing;
    - a change whose contract this pull request moves carries a verdict that
      names this pull request — a contract that moves is re-issued, not
      re-read, and the re-issue names the pull request where it moved.

    @param pull_request the number of the pull request.
    @param reviews_dir where the verdict files live.
    @param changed_paths the paths the pull request touches.
    """
    findings: list[str] = []
    carried = changed_slugs(changed_paths)
    moved = moved_contracts(changed_paths)
    for path, fields in verdict_files(reviews_dir):
        slug = path.stem
        named = pull_request_of(fields)
        if named == pull_request and slug not in carried:
            findings.append(
                f"{path.name} names this pull request ({pull_request}) and reviews {slug!r}, "
                f"which this pull request does not carry — a verdict file points at the pull "
                f"request whose review it records, and this one points at a pull request that "
                f"carries no such change"
            )
        if slug in moved and named != pull_request:
            stated = f"pull request {named}" if named is not None else "no pull request"
            findings.append(
                f"the contract of {slug!r} moved in this pull request and {path.name} names "
                f"{stated} — a contract that moves is re-issued, and the re-issue names the "
                f"pull request where the contract moved"
            )
    return findings


@click.command()
@click.option("--pr", "pull_request", type=int, help="The pull request to check.")
@click.option(
    "--comments-file",
    type=pathlib.Path,
    help="Read the comments from this JSON file instead of from GitHub.",
)
@click.option(
    "--files-file",
    type=pathlib.Path,
    help="Read the changed paths from this JSON file instead of from GitHub.",
)
@click.option(
    "--reviews-dir",
    type=pathlib.Path,
    default=DEFAULT_REVIEWS_DIR,
    help="Where the verdict files live (the repository's .specify/reviews by default).",
)
@click.option("--check", is_flag=True, help="Dry-run: report without a non-zero exit.")
@click.option("--json", "as_json", is_flag=True, help="Report as JSON.")
def cli(
    pull_request: int | None,
    comments_file: pathlib.Path | None,
    files_file: pathlib.Path | None,
    reviews_dir: pathlib.Path,
    check: bool,
    as_json: bool,
) -> None:
    """The pull request carries the review of an agent that did not write it."""
    if pull_request is None and comments_file is None:
        click.echo("check-agent-review: ERROR — one of --pr or --comments-file is required", err=True)
        raise SystemExit(VALIDATION_FAILURE)

    comments = (
        json.loads(comments_file.read_text())
        if comments_file is not None
        else comments_of(pull_request)
    )

    try:
        verdict, url = review_of(comments)
    except (ReviewNotFound, ReviewWithoutVerdict, ReviewFailed) as exc:
        if as_json:
            click.echo(json.dumps({"ok": False, "reason": str(exc)}))
        else:
            click.echo(f"check-agent-review: FAILED — {exc}")
            click.echo(
                "A pull request is reviewed by a separate agent before it is opened, "
                "and the review is written down on the pull request — as a comment "
                f"that opens with `{MARKER}` and states a verdict."
            )
        if check:
            raise SystemExit(CLEAN)
        raise SystemExit(VALIDATION_FAILURE)

    findings: list[str] = []
    if pull_request is not None:
        try:
            changed_paths = (
                paths_of(files_file) if files_file is not None else files_of(pull_request)
            )
        except ReviewNotFound as exc:
            findings.append(str(exc))
        else:
            findings.extend(pointer_findings(pull_request, reviews_dir, changed_paths))

    if findings:
        message = "; ".join(findings)
        if as_json:
            click.echo(json.dumps({"ok": False, "reason": message}))
        else:
            click.echo(f"check-agent-review: FAILED — {message}")
        if check:
            raise SystemExit(CLEAN)
        raise SystemExit(VALIDATION_FAILURE)

    if as_json:
        click.echo(json.dumps({"ok": True, "verdict": verdict, "url": url}))
    else:
        click.echo(f"check-agent-review: OK — the agent review says `{verdict}`{f' ({url})' if url else ''}")
    raise SystemExit(CLEAN)


if __name__ == "__main__":
    sys.exit(cli())

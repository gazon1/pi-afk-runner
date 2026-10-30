#!/usr/bin/env python3
"""check-review-verdicts.py — every change carries the verdict of its review.

What went wrong
---------------
`AGENTS.md` says a change gets a review by a separate agent before the PR is
opened, and it says it in one line. The line is a promise, and a promise
that leaves no trace is indistinguishable from a rule nobody follows: the
next session cannot tell whether the change was reviewed, by whom, what
was found, or whether the findings were fixed.

The review that came with the issue-registry gate found four real defects
in a diff that had already been written, reviewed and pushed. Nothing in
the tree said that. The finding existed only in the reviewer's answer, in
a session that was about to end.

The rule
--------
Every active change — a directory under `openspec/changes/`, not the
archive — carries a verdict in `.specify/reviews/<slug>.md`:

    ---
    change: <the slug>
    verdict: pass | fail
    date: YYYY-MM-DD
    pr: <the pull request>
    reviewed: <the commit the review was made against>
    documents: sha256:<the digest of the change's contract documents>
    ---

    ## What was reviewed
    ...

A `fail` is allowed, and is the interesting case: it says the review
found something. What is not allowed is a verdict nobody wrote.

The format of the file — its frontmatter, the two verdicts it may carry, the
pull request it names — lives in `sgate.gatekit.verdicts`, and the pull
request gate reads it from there too: two gates that read verdicts and two
implementations of what a verdict is would drift apart, and the drift would
be invisible until a verdict was read the wrong way.

What a verdict is about
-----------------------
A verdict file that exists says a review happened. It does not say the
verdict still speaks for the change — the change's contract can be edited
after the review, and the verdict keeps saying "pass" about a contract that
no longer exists. So the verdict carries two more fields:

- `reviewed:` — the commit the review was made against. The gate checks that
  it is a commit sha and not a sentence; it does not check that the commit is
  in the reader's clone, because a pull request that landed by squash takes
  its reviewed commit out of the history, and a shallow clone does not have
  it either. It is a pointer for a reader who has the history, and the shape
  is what the gate can know.
- `documents:` — the digest of the change's contract documents — its proposal
  and its spec deltas — as the verdict speaks for them. The gate recomputes
  the digest and compares, so a contract edited after the review leaves a
  verdict that says something about a change that is not there any more.

A contract that moves is re-issued, not re-read: the change that edits the
contract re-issues the verdict with the new digest, in the same diff, where a
reviewer sees both. The gate catches the drift — a contract that moved and
nobody re-issued the verdict. Whether the re-issue was earned is the
reviewer's question, and a re-issue is a claim in a diff like any other.

The digest is over the *contract*, not over the whole change directory:
`tasks.md` is a checklist that moves while the work is done, and ticking a
box is not a change of the contract. A digest over the whole directory would
therefore change every time the work moved, and a verdict that has to be
rewritten every time the work moves is a verdict nobody keeps.

The `documents:` field is computed by this gate:

    python3 scripts/check-review-verdicts.py --digest <the slug>

Why a digest and not the commit
--------------------------------
The commit a review was made against disappears from `main` when the pull
request is squash-merged — PR #978's head is not an ancestor of `main` —
so "the verdict names a commit and the commit is still in the history"
would fail for every change that landed by squash. The digest is over the
documents themselves: it says the same thing, and it survives the merge.

The changes that predate this rule are in
`config/docs/review-verdicts-baseline.txt` — a list of accepted
exceptions, the same shape as every other baseline in this repository.
It shrinks and never grows: `--update-baseline` prunes the entries whose
change is gone and refuses to add new ones, so accepting a new exception
is an edit in the diff that a reviewer can see, not a side effect of a
maintenance command.

Usage:
    python3 scripts/check-review-verdicts.py            # report
    python3 scripts/check-review-verdicts.py --quiet
    python3 scripts/check-review-verdicts.py --update-baseline
    python3 scripts/check-review-verdicts.py --digest <the slug>
"""

from __future__ import annotations

import hashlib
import pathlib
import re
import sys

import click

ROOT = pathlib.Path(__file__).resolve().parent.parent

# The vocabulary of a verdict is this checkout's — the gate reads it from the
# tree it sits in, and not from whatever `sgate` happens to be installed.
sys.path.insert(0, str(ROOT / "scripts" / "src"))

from sgate.commands.base import run  # noqa: E402
from sgate.gatekit.verdicts import (  # noqa: E402
    VERDICTS,
    baseline_slugs,
    contract_documents,
    parse_frontmatter,
    pull_request_of,
    slug_of,
    verdict_of,
)

CLEAN = 0
VALIDATION_FAILURE = 1
NO_SUCH_CHANGE = 2

CHANGES_DIR = ROOT / 'openspec/changes'
REVIEWS_DIR = ROOT / '.specify/reviews'
BASELINE = ROOT / 'config/docs/review-verdicts-baseline.txt'

#: A date, as the verdict file states it.
DATE = re.compile(r'^\d{4}-\d{2}-\d{2}$')

#: The commit a verdict says it was made against.
REVIEWED_COMMIT = re.compile(r'^[0-9a-f]{40}$')

#: The digest of the documents a verdict says it was made against.
DOCUMENTS_DIGEST = re.compile(r'^sha256:[0-9a-f]{64}$')


def documents_digest(change_dir: pathlib.Path) -> str:
    """The digest of a change's contract documents.

    The path is part of what is digested: a spec delta that moved from one
    capability to another is a different document, and a digest over the
    bytes alone would call it the same.
    """
    digest = hashlib.sha256()
    for path in contract_documents(change_dir):
        relative = path.relative_to(change_dir).as_posix()
        digest.update(relative.encode('utf-8'))
        digest.update(b'\0')
        try:
            digest.update(path.read_bytes())
        except OSError:
            digest.update(b'<unreadable>')
        digest.update(b'\0')
    return f'sha256:{digest.hexdigest()}'

#: The marker the spec-create workflow leaves next to the proposal.
SCAFFOLD_MARKER = '.openspec.yaml'

#: The workflow that writes the scaffold, and therefore the template a
#: scaffold is compared against.
SCAFFOLD_WORKFLOW = '.specify/workflows/openspec-change/workflow.yml'

#: The heredoc the workflow writes the proposal with.
SCAFFOLD_HEREDOC = 'PROPOSAL'


def scaffold_template(tree: pathlib.Path) -> list[str] | None:
    """The lines the spec-create workflow writes into a proposal.

    Read from the workflow itself rather than kept here, so the template and
    the check cannot drift apart: a change to the workflow's proposal changes
    what a scaffold looks like, and the gate follows it.

    None when the workflow is not where it is expected — the gate then cannot
    recognise a scaffold, and says so by asking for a verdict. The failure
    mode of a missing template is a stricter rule, not a looser one.
    """
    workflow = tree / SCAFFOLD_WORKFLOW
    if not workflow.is_file():
        return None
    try:
        text = workflow.read_text(encoding='utf-8', errors='replace')
    except OSError:
        return None

    start = text.find(f"<< '{SCAFFOLD_HEREDOC}'")
    if start == -1:
        return None
    body = text[text.find('\n', start) + 1:].splitlines()

    # The closing marker is indented in the workflow file, like the body it
    # closes, so the block ends at the first line that *is* the marker.
    lines: list[str] = []
    for line in body:
        if line.strip() == SCAFFOLD_HEREDOC:
            break
        lines.append(line)
    indents = [len(line) - len(line.lstrip()) for line in lines if line.strip()]
    common = min(indents) if indents else 0
    return [line[common:] if line.strip() else '' for line in lines]


def active_changes(changes_dir: pathlib.Path) -> list[str]:
    """The slugs of the changes that are still open."""
    if not changes_dir.is_dir():
        return []
    slugs: list[str] = []
    for entry in sorted(changes_dir.iterdir()):
        if not entry.is_dir() or entry.name == 'archive':
            continue
        slugs.append(slug_of(entry.name))
    return slugs


def change_directories(changes_dir: pathlib.Path) -> dict[str, pathlib.Path]:
    """The open change directories, keyed by the slug they carry."""
    if not changes_dir.is_dir():
        return {}
    directories: dict[str, pathlib.Path] = {}
    for entry in sorted(changes_dir.iterdir()):
        if entry.is_dir() and entry.name != 'archive':
            directories[slug_of(entry.name)] = entry
    return directories


def archived_changes(changes_dir: pathlib.Path) -> list[str]:
    """The slugs of the changes that were filed away.

    A verdict for an archived change is a record of a review that happened,
    so it is not an error — the same reasoning the registry gate uses when it
    compares by slug rather than by path.
    """
    archive = changes_dir / 'archive'
    if not archive.is_dir():
        return []
    return sorted(
        slug_of(entry.name)
        for entry in archive.iterdir()
        if entry.is_dir()
    )


def is_scaffold(change_dir: pathlib.Path, template: list[str] | None) -> bool:
    """Whether a change is still the scaffold the spec-create workflow wrote.

    The proposal is compared with the workflow's own template, line for line.
    A proposal that still carries a leftover placeholder *line* is not enough
    to be a scaffold: what makes a scaffold a scaffold is that nothing has
    been written into it yet, and a comparison with the template says exactly
    that. It also means the exemption ends by itself when the author writes
    the proposal, whether or not they delete the line the template left.
    """
    if template is None:
        return False
    if not (change_dir / SCAFFOLD_MARKER).is_file():
        return False
    proposal = change_dir / 'proposal.md'
    if not proposal.is_file():
        return False
    written = proposal.read_text(encoding='utf-8', errors='replace').splitlines()
    return _same_scaffold(written, template)


def _same_scaffold(written: list[str], template: list[str]) -> bool:
    """Whether a proposal is the template, with only its title filled in."""
    def meaningful(lines: list[str]) -> list[str]:
        return [line.rstrip() for line in lines if line.strip()]

    written_lines = meaningful(written)
    template_lines = meaningful(template)
    if len(written_lines) != len(template_lines):
        return False
    for actual, expected in zip(written_lines, template_lines):
        if actual == expected:
            continue
        # The title is the only part the workflow fills in.
        if expected.startswith('# ') and actual.startswith('# '):
            continue
        return False
    return True


def body_of(text: str) -> str:
    """The text after the frontmatter."""
    end = text.find('\n---', 3)
    if end == -1:
        return ''
    return text[end + 4:]


def review_problems(
    text: str,
    slug: str,
    change_dir: pathlib.Path | None = None,
) -> list[str]:
    """What is wrong with a verdict file, if anything."""
    problems: list[str] = []
    fields = parse_frontmatter(text)
    if not fields:
        return [f'{slug}.md has no frontmatter — a verdict states its change, verdict, date and PR']

    if fields.get('change') != slug:
        problems.append(
            f'{slug}.md reviews {fields.get("change")!r} — the file is named after the change'
        )
    if verdict_of(fields) is None:
        problems.append(
            f'{slug}.md states verdict {fields.get("verdict")!r} — it is one of '
            f'{", ".join(sorted(VERDICTS))}'
        )
    if not DATE.match(fields.get('date', '')):
        problems.append(f'{slug}.md states date {fields.get("date")!r} — it is YYYY-MM-DD')
    if pull_request_of(fields) is None:
        problems.append(
            f'{slug}.md names no pull request — the field names the pull request whose '
            f'review this verdict records, as a number or as a URL'
        )

    reviewed = fields.get('reviewed', '')
    if not REVIEWED_COMMIT.match(reviewed):
        problems.append(
            f'{slug}.md states reviewed {reviewed!r} — it is the commit the review was '
            f'made against, forty hex characters'
        )

    recorded = fields.get('documents', '')
    if not DOCUMENTS_DIGEST.match(recorded):
        problems.append(
            f'{slug}.md states documents {recorded!r} — it is the digest of the change\'s '
            f'contract documents, sha256:<64 hex characters> (compute it with '
            f'--digest {slug})'
        )
    elif change_dir is not None:
        current = documents_digest(change_dir)
        if current != recorded:
            problems.append(
                f'{slug}.md reviews documents {recorded} — the change now carries {current}. '
                f'The contract moved after the verdict was written, so the verdict speaks for '
                f'a contract that is not there any more: re-review the change and re-issue '
                f'the verdict with the digest it carries now ('
                f'python3 scripts/check-review-verdicts.py --digest {slug})'
            )

    said_something = [
        line for line in body_of(text).splitlines()
        if line.strip() and not line.lstrip().startswith('#')
    ]
    if not said_something:
        problems.append(f'{slug}.md says nothing but headings — a review says what it reviewed')

    return problems


def find_problems(
    changes_dir: pathlib.Path,
    reviews_dir: pathlib.Path,
    baseline: set[str],
) -> tuple[list[str], list[str], list[str], dict[str, int]]:
    """The changes without a verdict, the baseline entries that went stale,
    the scaffolds that are exempt, and what was checked."""
    problems: list[str] = []
    directories = change_directories(changes_dir)
    template = scaffold_template(changes_dir.parent.parent)
    changes = sorted(directories)
    archived = set(archived_changes(changes_dir))
    scaffolds: list[str] = []
    counted = {'changes': len(changes), 'verdicts': 0, 'baselined': 0, 'scaffolds': 0}

    for slug in changes:
        review = reviews_dir / f'{slug}.md'
        if not review.is_file():
            change_dir = directories.get(slug)
            if change_dir is not None and is_scaffold(change_dir, template):
                scaffolds.append(slug)
                counted['scaffolds'] += 1
                continue
            if slug in baseline:
                counted['baselined'] += 1
                continue
            problems.append(
                f'{slug} has no review verdict — write {reviews_dir.name}/{slug}.md, '
                f'or add the change to the baseline by hand'
            )
            continue
        counted['verdicts'] += 1
        text = review.read_text(encoding='utf-8', errors='replace')
        problems.extend(review_problems(text, slug, directories.get(slug)))

    # A verdict for a change that is neither open nor archived is a verdict
    # about nothing. A verdict for an archived change is a record of a review
    # that happened, so it stays.
    if reviews_dir.is_dir():
        for review in sorted(reviews_dir.glob('*.md')):
            slug = review.stem
            if slug not in changes and slug not in archived:
                problems.append(
                    f'{reviews_dir.name}/{review.name} reviews {slug!r}, which is neither an '
                    f'open change nor an archived one'
                )

    stale = sorted(baseline - set(changes))
    return problems, stale, scaffolds, counted


@click.command()
@click.option('--quiet', is_flag=True)
@click.option('--update-baseline', is_flag=True)
@click.option(
    '--digest',
    'digest_slug',
    default=None,
    help="print the digest of a change's contract documents and exit",
)
@click.option(
    '--root',
    default=None,
    help='the tree to check (default: the repository this script lives in)',
)
@click.pass_context
def cli(
    ctx: click.Context,
    quiet: bool,
    update_baseline: bool,
    digest_slug: str | None,
    root: str | None,
) -> None:
    tree = pathlib.Path(root).resolve() if root else ROOT
    changes_dir = tree / 'openspec' / 'changes'
    reviews_dir = tree / '.specify' / 'reviews'
    baseline_path = tree / 'config/docs/review-verdicts-baseline.txt'
    accepted = baseline_slugs(baseline_path)

    if digest_slug:
        directories = change_directories(changes_dir)
        change_dir = directories.get(digest_slug)
        if change_dir is None:
            click.echo(
                f'check-review-verdicts: no open change carries the slug {digest_slug!r}'
            )
            raise ctx.exit(NO_SUCH_CHANGE)
        click.echo(documents_digest(change_dir))
        raise ctx.exit(CLEAN)

    if update_baseline:
        changes = set(active_changes(changes_dir))
        stale = sorted(accepted - changes)
        kept = sorted(accepted & changes)
        header = (
            '# Changes that predate the review-verdict rule.\n'
            '# This list only shrinks: a new entry is an edit a reviewer can see.\n'
            '# Prune it with: python3 scripts/check-review-verdicts.py --update-baseline\n'
        )
        baseline_path.parent.mkdir(parents=True, exist_ok=True)
        baseline_path.write_text(header + '\n'.join(kept) + ('\n' if kept else ''), encoding='utf-8')
        click.echo(
            f'check-review-verdicts: pruned {len(stale)} stale entr(ies) from '
            f'{baseline_path.name}'
        )
        if stale:
            for slug in stale:
                click.echo(f'  - {slug}')
        raise ctx.exit(CLEAN)

    problems, stale, scaffolds, counted = find_problems(changes_dir, reviews_dir, accepted)

    for problem in problems:
        click.echo(f'ERROR: {problem}')

    if stale:
        click.echo('')
        click.echo(
            f'check-review-verdicts: note — {len(stale)} baseline entr(ies) name a change that '
            f'is not open any more; remove them with --update-baseline'
        )

    if scaffolds and not quiet:
        click.echo('')
        click.echo(
            f'check-review-verdicts: note — {len(scaffolds)} change(s) are still the scaffold '
            f'the spec-create workflow wrote, and are exempt until they are written up: '
            f'{", ".join(scaffolds)}'
        )

    if problems:
        click.echo('')
        click.echo(
            'check-review-verdicts: the review of a change is what the next session cannot '
            'read anywhere else — a verdict that leaves no trace is a promise with nothing '
            'behind it.'
        )
        click.echo(
            '  fix with — write .specify/reviews/<slug>.md (change, verdict, date, PR, '
            'reviewed, documents), or add the change to '
            f'{baseline_path.name} by hand (the list only shrinks by command; adding one is '
            'an edit in the diff a reviewer can see)'
        )
        click.echo(
            '  the documents digest is computed by this gate: '
            f'python3 scripts/check-review-verdicts.py --digest <slug>'
        )
        raise ctx.exit(VALIDATION_FAILURE)

    if not quiet:
        click.echo(
            f'check-review-verdicts: OK — {counted["changes"]} open changes: '
            f'{counted["verdicts"]} carry a verdict, {counted["baselined"]} predate the rule, '
            f'{counted["scaffolds"]} are still a scaffold'
        )
    raise ctx.exit(CLEAN)


if __name__ == '__main__':
    raise SystemExit(run(cli))

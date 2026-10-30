"""The verdict of a review, and the vocabulary the verdicts are written in.

Two gates read the verdicts of this repository, and they answer two different
questions:

  * `scripts/ci/check-agent-review.py` asks whether a **pull request** carries
    a review — the comment on the pull request, opened by the marker and
    carrying a verdict;
  * `scripts/check-review-verdicts.py` asks whether every **change** carries a
    verdict — the file `.specify/reviews/<slug>.md`, with the commit the
    review was made against and the digest of the contract it speaks for.

The two verdicts have different scopes and different lives, and this module
keeps the parts they share in one place, so that the two gates cannot drift
apart on how a verdict is written:

  * the frontmatter shape;
  * the two verdicts a file may carry (`pass` and `fail`);
  * the pull request a file names;
  * the slug of a change, and where its contract lives.

## Why the scopes are different, and why they still belong together

The comment's verdict is the **pull request's**: the newest comment decides
whether the pull request is red, and a later review that says `pass` clears
one that said `fail`. It is transient on purpose — the pull request's state
changes.

The file's verdict is the **change's**: it says what the review of that change
found, and a `fail` there is a legal permanent record — "the review found
something" is the interesting case, and the file is where that is written
down. It is not cleared by a later comment, because a comment is about the
pull request and not about the change.

So the two are not two answers to one question, and a gate that demanded they
be equal would demand a state this repository does not have: a pull request
carrying a change whose review found something could never be green, because
the file would keep saying `fail` and the file is not re-issued unless the
contract moves.

## The one question the two answers share

Both answers are about **what was reviewed**, and the file is the one that
points at a pull request: its `pr:` field names the pull request whose review
it records.

So the pull request and the file have to agree about the pointer:

  * a file that names **this** pull request has to be about a change **this**
    pull request carries — a verdict file that points at a pull request which
    carries no such change points at nothing;
  * a change whose **contract** this pull request moves has to carry a
    verdict that names **this** pull request — a contract that moves is
    re-issued, not re-read, and the re-issue names the pull request where the
    contract moved.

The second half is the check's teeth; the first half is the check's
conscience. Neither of them compares a comment's verdict with a file's
verdict: the comment says whether the pull request is green today, and the
file says what a review of the change found once — and `fail` is a legal
answer to the second question and an illegal one to the first.

ADR `docs/decisions/2026-10-23-the-verdicts-share-one-registry.md`.
"""

from __future__ import annotations

import pathlib
import re

#: The verdicts a review may carry.
VERDICTS = frozenset({'pass', 'fail'})

#: A line of the frontmatter — `name: value`.
FRONTMATTER_LINE = re.compile(r'^([A-Za-z_][\w-]*):\s*(.*)$')

#: A pull request number, on its own: `1040` or `#1040`.
BARE_PULL_REQUEST = re.compile(r'^#?(\d+)$')

#: A pull request in a URL: `.../pull/1040`, with an optional trailing slash.
PULL_REQUEST_URL = re.compile(r'/pull/(\d+)/?$')

#: The date a change directory carries as a prefix: `2026-10-23-the-change`.
DATE_PREFIX = re.compile(r'^\d{4}-\d{2}-\d{2}-')

#: The document that carries a change's requirement, besides its spec deltas.
PROPOSAL = 'proposal.md'

#: The directory that carries a change's spec deltas.
SPECS = 'specs'


def parse_frontmatter(text: str) -> dict[str, str]:
    """The frontmatter of a verdict file, as a mapping.

    A frontmatter is the block between two `---` lines at the top of the file,
    and every line of it is a `name: value` pair.
    """
    if not text.startswith('---'):
        return {}
    end = text.find('\n---', 3)
    if end == -1:
        return {}
    fields: dict[str, str] = {}
    for line in text[3:end].splitlines():
        pair = FRONTMATTER_LINE.match(line)
        if pair:
            fields[pair.group(1)] = pair.group(2).strip().strip('"\'')
    return fields


def verdict_of(fields: dict[str, str]) -> str | None:
    """The verdict a verdict file states, or `None`.

    A file states one verdict. A file that states none, or states a word that
    is not a verdict, states nothing — and `scripts/check-review-verdicts.py`
    is the gate that says so.
    """
    stated = fields.get('verdict', '').strip().lower()
    return stated if stated in VERDICTS else None


def pull_request_of(fields: dict[str, str]) -> int | None:
    """The pull request a verdict file names, or `None`.

    The field is written as a number by some and as a URL by others: `1040`
    and `https://github.com/gazon1/sing/pull/1040` name the same pull
    request. The owner name in a URL carries digits of its own, and a pull
    request is not `gazon1` — so the number is read from the tail of the
    field, and not from anywhere else in it.
    """
    field = fields.get('pr', '').strip()
    if not field:
        return None
    for pattern in (BARE_PULL_REQUEST, PULL_REQUEST_URL):
        match = pattern.search(field)
        if match is not None:
            try:
                return int(match.group(1))
            except ValueError:
                return None
    return None


def slug_of(name: str) -> str:
    """The slug of a change, from the name of its directory.

    A change directory carries the date it was filed on: `2026-10-23-the-
    change` is the change `the-change`, and the verdict file is named after
    the slug and not after the directory.
    """
    return DATE_PREFIX.sub('', name)


#: The directory that holds the changes that were filed away.
ARCHIVE = 'archive'


def _change_of(path: str) -> tuple[str, tuple[str, ...]] | None:
    """The change a path belongs to, and the path inside that change.

    `None` when the path is not inside a change at all. The archive is a
    change of its own kind: a change that was filed away is a record, and a
    path inside it belongs to the change it was filed away from.

    @param path the path a pull request touches.
    """
    parts = pathlib.PurePosixPath(path).parts
    if len(parts) < 3 or parts[0] != 'openspec' or parts[1] != 'changes':
        return None
    if parts[2] == ARCHIVE:
        if len(parts) < 4:
            return None
        return slug_of(parts[3]), parts[4:]
    return slug_of(parts[2]), parts[3:]


def changed_slugs(paths: list[str]) -> set[str]:
    """The changes a pull request carries, from the paths it touches.

    A change is a directory under `openspec/changes/`. A path inside one of
    those directories is a change this pull request carries; anything else is
    not a change at all.

    @param paths the paths a pull request touches.
    """
    slugs: set[str] = set()
    for path in paths:
        change = _change_of(path)
        if change is not None:
            slugs.add(change[0])
    return slugs


def moved_contracts(paths: list[str]) -> set[str]:
    """The changes whose contract a pull request moves.

    The contract of a change is its proposal and its spec deltas — what the
    change requires. `tasks.md` is not part of it: a checklist moves while the
    work is done, and ticking a box is not a change of what the change
    requires. A verdict speaks for the contract, so a pull request that moves
    a contract is the pull request that has to re-issue the verdict.

    A change that is filed away is not moved: the archive is where a change
    goes when it is done, and its contract says the same thing there as it
    said before.

    @param paths the paths a pull request touches.
    """
    moved: set[str] = set()
    filed_away = _filed_away(paths)
    for path in paths:
        parts = pathlib.PurePosixPath(path).parts
        if len(parts) >= 3 and parts[:3] == ('openspec', 'changes', ARCHIVE):
            continue
        change = _change_of(path)
        if change is None:
            continue
        slug, rest = change
        if not rest or slug in filed_away:
            continue
        if rest[0] == PROPOSAL or (rest[0] == SPECS and path.endswith('.md')):
            moved.add(slug)
    return moved


def _filed_away(paths: list[str]) -> set[str]:
    """The changes this pull request files away.

    GitHub reports an archive move as a rename — the new path alone — or as a
    removal and an addition, and the shape is not the repository's decision.
    A change that is filed away is a record, not a move: its contract says the
    same thing in the archive as it said before, so a pull request that files
    it away does not have to re-issue its verdict.
    """
    filed: set[str] = set()
    for path in paths:
        parts = pathlib.PurePosixPath(path).parts
        if len(parts) >= 4 and parts[:3] == ('openspec', 'changes', ARCHIVE):
            filed.add(slug_of(parts[3]))
    return filed


def contract_documents(change_dir: pathlib.Path) -> list[pathlib.Path]:
    """The contract of a change: its proposal and its spec deltas.

    The proposal and the spec deltas are what the change requires. `tasks.md`
    is not: it is a checklist that moves while the work is done, and ticking a
    box is not a change of what the change requires. A digest over the whole
    directory would therefore change every time the work moved, and a verdict
    that has to be rewritten every time the work moves is a verdict nobody
    keeps.

    A change may carry other documents at its root — a `design.md`, for
    instance — and they are outside the digest: the contract is what the
    change requires of the code, and the spec delta is where that is written.

    @param change_dir the directory of the change.
    """
    documents: list[pathlib.Path] = []
    proposal = change_dir / PROPOSAL
    if proposal.is_file():
        documents.append(proposal)
    specs = change_dir / SPECS
    if specs.is_dir():
        documents.extend(path for path in specs.rglob('*.md') if path.is_file())
    return sorted(documents)


def verdict_files(reviews_dir: pathlib.Path) -> list[tuple[pathlib.Path, dict[str, str]]]:
    """The verdict files of the registry, and their frontmatter.

    @param reviews_dir where the verdict files live.
    """
    if not reviews_dir.is_dir():
        return []
    found: list[tuple[pathlib.Path, dict[str, str]]] = []
    for path in sorted(reviews_dir.glob('*.md')):
        found.append((path, read_verdict_file(path)))
    return found


def read_verdict_file(path: pathlib.Path) -> dict[str, str]:
    """The frontmatter of a verdict file, read from the disk."""
    return parse_frontmatter(path.read_text(encoding='utf-8', errors='replace'))


def baseline_slugs(baseline_path: pathlib.Path) -> set[str]:
    """The changes the rule does not ask a verdict file of.

    The list is the one `scripts/check-review-verdicts.py` keeps: the changes
    that predate the rule. It only shrinks, and an entry in it is an edit a
    reviewer can see.
    """
    if not baseline_path.is_file():
        return set()
    return {
        line.strip()
        for line in baseline_path.read_text(encoding='utf-8', errors='replace').splitlines()
        if line.strip() and not line.startswith('#')
    }

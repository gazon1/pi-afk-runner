#!/usr/bin/env python3
"""
Bulk-import all OpenSpec change stubs into spec-kit issues.

Each OpenSpec change in `openspec/changes/` (and `openspec/changes/archive/`)
becomes an archived spec-kit issue at `.specify/issues/<slug>.yaml`.

The OpenSpec documents (proposal.md, design.md, adr.md, tasks.md, specs/)
remain in place. This script creates the spec-kit issue record that
"closes the loop" — spec-kit now has a registry entry for every completed
OpenSpec change.

Usage:
    python3 scripts/openspec-import-all.py [--dry-run] [--replace]

Exit codes:
    0  — all imports successful (or --dry-run shows no errors)
    1  — one or more imports failed
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).parent.parent.resolve()
OPSSPEC_CHANGES = ROOT / "openspec" / "changes"
ISSUES_DIR = ROOT / ".specify" / "issues"


def _repo_relative(path: Path) -> str:
    """The path relative to the repository root, when it is inside it.

    The registry is committed, so a path that names a home directory or a
    worktree leaks a machine's layout into git — which the publication
    hygiene gate counts. A path outside the repository is left as it is,
    because there is nothing relative to say about it.
    """
    try:
        return str(path.resolve().relative_to(ROOT))
    except ValueError:
        return str(path)


def extract_slug_from_dirname(dir_name: str) -> str | None:
    """Parse YYYY-MM-DD-slug from directory name; fall back to bare slug."""
    m = re.match(r"^(\d{4}-\d{2}-\d{2})-(.+)$", dir_name)
    if m:
        return m.group(2)
    # Bare slug directory (no date prefix) — use the whole name as slug
    if re.match(r"^[a-zA-Z0-9][a-zA-Z0-9\-]*$", dir_name):
        return dir_name
    return None


def extract_date_from_dirname(dir_name: str) -> str:
    """Extract YYYY-MM-DD date from directory name; return 'unknown' if absent."""
    m = re.match(r"^(\d{4}-\d{2}-\d{2})", dir_name)
    return m.group(1) if m else "unknown"


def extract_title_from_proposal(proposal_path: Path) -> str | None:
    """Extract the change title from proposal.md's first # heading."""
    if proposal_path.exists() and proposal_path.stat().st_size > 0:
        text = proposal_path.read_text(encoding="utf-8")
        m = re.search(r"^# (.+)$", text, re.MULTILINE)
        if m:
            return m.group(1).strip()
    return None


def extract_title_from_openspec_yaml(change_dir: Path, dir_name: str) -> str | None:
    """Extract title from .openspec.yaml comment or infer from directory name."""
    yaml_path = change_dir / ".openspec.yaml"
    if yaml_path.exists():
        text = yaml_path.read_text(encoding="utf-8")
        m = re.search(r"#\s*Migrated from\s*(.+)", text)
        if m:
            src = m.group(1).strip()
            # Try to extract a title from the source path (e.g. "docs/decisions/2026-09-05-android-bottom-nav-followups.md")
            title_m = re.search(r"(\d{4}-\d{2}-\d{2}[-_](.+?))(?:\.md\s*$|$)", src, re.IGNORECASE)
            if title_m:
                return title_m.group(2).strip()  # slug only, no date prefix
    # Fallback: use slug from directory name as title
    slug = extract_slug_from_dirname(dir_name)
    return slug if slug else None


def extract_adr_refs_from_adr(adr_path: Path) -> list[dict]:
    """Extract ADR table rows from adr.md manifest."""
    if not adr_path.exists():
        return []
    text = adr_path.read_text(encoding="utf-8")
    rows = []
    # Match table rows: | seq | slug | title | status | notes |
    for m in re.finditer(
        r"^\|\s*(\d+)\s*\|\s*([^\s|]+)\s*\|\s*([^\|]+?)\s*\|\s*([^\|]+?)\s*\|\s*([^\|]+?)\s*\|",
        text,
        re.MULTILINE,
    ):
        seq, slug, title, status, notes = m.groups()
        rows.append({
            "sequence": seq.strip(),
            "slug": slug.strip(),
            "title": title.strip(),
            "status": status.strip(),
            "notes": notes.strip(),
        })
    return rows


def extract_status_from_proposal(proposal_path: Path) -> str:
    """Extract status from proposal.md (defaults to 'accepted')."""
    if not proposal_path.exists():
        return "accepted"
    text = proposal_path.read_text(encoding="utf-8")
    m = re.search(r"Status:\s*\*\*(accepted|deferred|superseded|open)\*\*", text, re.IGNORECASE)
    return m.group(1).lower() if m else "accepted"


def extract_tags_from_proposal(proposal_path: Path) -> list[str]:
    """Extract tags from proposal.md (defaults to [])."""
    if not proposal_path.exists():
        return []
    text = proposal_path.read_text(encoding="utf-8")
    m = re.search(r"Tags?:\s*\*\*(.+?)\*\*", text, re.IGNORECASE)
    if not m:
        return []
    return [t.strip() for t in m.group(1).split() if t.strip()]


def is_stub(proposal_path: Path) -> bool:
    """Return True if this is an auto-generated stub (no real proposal)."""
    if not proposal_path.exists():
        return True
    text = proposal_path.read_text(encoding="utf-8")
    return "this is a migrated historical ADR" in text.lower() or \
           "this change migrates an existing ADR" in text.lower()


def is_hand_written(issue_file: Path) -> bool:
    """Return True if the record was written by hand, not by this importer.

    The marker is `speckit_imported: false`: the importer writes `true` into
    every record it owns, and a record that says `false` was written by a
    person. The header comment says the same in words, and the marker is the
    one a machine can read.
    """
    if not issue_file.is_file():
        return False
    text = issue_file.read_text(encoding="utf-8", errors="replace")
    return bool(re.search(r"^speckit_imported:\s*false\s*$", text, re.MULTILINE))


def create_issue_record(
    slug: str,
    change_dir: Path,
    date: str,
    title: str | None,
    status: str,
    adr_refs: list[dict],
    tags: list[str],
    is_archived: bool,
) -> dict:
    """Build the spec-kit issue YAML record.

    Paths are stored relative to the repo root so the registry is portable
    across machines and worktrees. Absolute paths leaked home directories and
    clone names into git (publication hygiene gate, 8865 findings).
    """
    change_type = "archived" if is_archived else "active"

    def _rel(p: Path) -> str:
        try:
            return str(p.resolve().relative_to(ROOT))
        except ValueError:
            return str(p)

    # Only the documents that exist. A record that names a design.md the
    # change never had is a link to nothing: it sends the next session
    # looking for a file that was never written, and it makes the record
    # indistinguishable from one that does point at the change.
    documents: dict[str, str] = {}
    for key, filename in (
        ("proposal", "proposal.md"),
        ("design", "design.md"),
        ("adr", "adr.md"),
        ("tasks", "tasks.md"),
    ):
        candidate = change_dir / filename
        if candidate.exists():
            documents[key] = _rel(candidate)

    specs_dir = change_dir / "specs"

    record = {
        "version": "1.0",
        "type": "openspec-change",
        "slug": slug,
        "date": date,
        "title": title or slug,
        "status": status,
        "change_type": change_type,
        "speckit_imported": True,
        "adr_refs": adr_refs,
        "tags": tags,
        "documents": documents,
        "specs_dir": _rel(specs_dir) if specs_dir.exists() else None,
        "is_stub": is_stub(change_dir / "proposal.md"),
        "openspec_path": _rel(change_dir),
    }
    return record


def import_change(change_dir: Path, dry_run: bool = False, replace: bool = False) -> tuple[bool, str]:
    """
    Import one OpenSpec change directory as a spec-kit issue.
    Returns (success, message).
    """
    dir_name = change_dir.name
    slug = extract_slug_from_dirname(dir_name)
    if not slug:
        return False, f"Cannot parse slug from directory name: {dir_name}"

    date = extract_date_from_dirname(dir_name)

    proposal_path = change_dir / "proposal.md"
    adr_path = change_dir / "adr.md"

    title = extract_title_from_proposal(proposal_path)
    if not title:
        title = extract_title_from_openspec_yaml(change_dir, dir_name)
    status = extract_status_from_proposal(proposal_path)
    tags = extract_tags_from_proposal(proposal_path)
    adr_refs = extract_adr_refs_from_adr(adr_path)

    record = create_issue_record(
        slug=slug,
        change_dir=change_dir,
        date=date,
        title=title,
        status=status,
        adr_refs=adr_refs,
        tags=tags,
        is_archived=(change_dir.parent.name == "archive"),
    )

    issue_file = ISSUES_DIR / f"{slug}.yaml"
    if issue_file.exists() and not replace:
        # A skip is a success: the record is already there, which is what the
        # caller wanted. Returning a failure here made the summary read
        # "N failed" for every change that was already imported, and the exit
        # code was 1 on a run that had done its job — so the exit code said
        # "something went wrong" about a directory that was in the state the
        # script exists to produce.
        return True, f"SKIP (exists): {issue_file}"

    if issue_file.exists() and is_hand_written(issue_file):
        # A record the importer does not own. Some changes have no proposal
        # and no adr.md for the importer to read, so their records are written
        # by hand — with a title, a date, the ADRs and the tags that the
        # importer cannot infer. `--replace` writes each file wholesale, so
        # without this guard the hand-written record is silently replaced by a
        # lossy one, and the registry gate does not notice: the file is still
        # there, and it is still a record.
        return True, f"SKIP (hand-written, left alone): {issue_file}"

    if dry_run:
        return True, f"DRY-RUN: would write {issue_file}\n  title={title}, status={status}, adr_refs={len(adr_refs)}"

    ISSUES_DIR.mkdir(parents=True, exist_ok=True)
    content = yaml.dump(
        record,
        default_flow_style=False,
        sort_keys=False,
        allow_unicode=True,
        width=120,
    )
    # Prepend YAML document marker and a comment.
    #
    # The source path is relative to the repo root, like every path in the
    # record itself: the comment is the one place an absolute path would leak
    # a home directory and a worktree name into git, and the publication
    # hygiene gate counts exactly that.
    full_content = (
        f"# spec-kit issue record — auto-generated by scripts/openspec-import-all.py\n"
        f"# Do not edit manually. Source: {_repo_relative(change_dir)}\n---\n{content}"
    )
    issue_file.write_text(full_content, encoding="utf-8")
    stub_note = " (STUB)" if record["is_stub"] else ""
    return True, f"OK{stub_note}: {issue_file} — {title or slug}"


def main() -> int:
    parser = argparse.ArgumentParser(description="Bulk-import OpenSpec changes to spec-kit issues")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be imported without writing files")
    parser.add_argument("--replace", action="store_true", help="Replace existing issue records")
    parser.add_argument("--only-active", action="store_true", help="Only import active changes (skip archive/)")
    parser.add_argument("--only-archive", action="store_true", help="Only import archived changes")
    args = parser.parse_args()

    if not OPSSPEC_CHANGES.exists():
        print(f"ERROR: {OPSSPEC_CHANGES} does not exist — not an OpenSpec project?")
        return 1

    changes_dirs = []

    if not args.only_archive:
        active_dirs = sorted(
            d for d in OPSSPEC_CHANGES.iterdir()
            if d.is_dir() and not d.name.startswith(".") and d.name != "archive"
        )
        changes_dirs.extend(active_dirs)

    if not args.only_active:
        archive_dir = OPSSPEC_CHANGES / "archive"
        if archive_dir.exists():
            archive_dirs = sorted(d for d in archive_dir.iterdir() if d.is_dir())
            changes_dirs.extend(archive_dirs)

    print(f"Found {len(changes_dirs)} change directory(ies) to process")
    print()

    ok_count = 0
    fail_count = 0
    skip_count = 0

    for change_dir in changes_dirs:
        success, msg = import_change(change_dir, dry_run=args.dry_run, replace=args.replace)
        print(f"  {msg}")
        if success:
            if "SKIP" in msg:
                skip_count += 1
            else:
                ok_count += 1
        else:
            fail_count += 1

    print()
    print(f"Results: {ok_count} imported, {skip_count} skipped, {fail_count} failed")
    return 1 if fail_count else 0


if __name__ == "__main__":
    sys.exit(main())

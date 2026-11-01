---
title: The GitHub access stays behind one module, and the transport stays `gh`
status: accepted
date: 2026-11-02
authors: Command Code
deciders: Singularity Developer
tags: [github, gh, contract, dependencies]
---

# The GitHub access stays behind one module, and the transport stays `gh`

## Context

An issue asked for the runner's GitHub access to move off raw `gh` commands and onto a ready-made
interface: install `@narumitw/pi-github-pr` and let `src/gh.ts` delegate to it, so that creating a
pull request, reading statuses and reading comments go through a standardized package instead of
`execFile("gh", …)`.

The claim behind the issue was that the package is a GitHub pull request **client**. It is not, and
the difference decides the whole issue.

## Idea

Audit the package first, and let the audit decide. If it exposes a programmatic client, the runner's
GitHub calls move behind it. If it does not, the runner keeps what it has, and the reason is written
down so the question is not asked a second time.

## Decision

**The runner keeps `gh` as its GitHub transport, behind `src/gh.ts`, and takes no dependency on
`@narumitw/pi-github-pr`.**

What the audit found, in `0.49.8`:

- The package is a **Pi statusline extension**. Its `package.json` declares
  `pi.extensions: ["./dist/index.ts"]`, it has a peer dependency on `@earendil-works/pi-tui`, and it
  has no `main` and no `exports`. `import "@narumitw/pi-github-pr"` fails with
  `ERR_MODULE_NOT_FOUND`, and the deep paths fail too: the package is not importable as a library.
- `src/index.ts` exports **only the default extension**. The helpers it does export —
  `runGhPrView`, `normalizeGhPrView`, `formatCompactStatus`, `formatLinkedStatus`,
  `isPullRequestVisible` — are about **the current branch's pull request**, in a **Pi session**: they
  need `ExtensionAPI.exec` and a working directory, and they resolve the repository from the checkout's
  remote.
- Its own README states the limits: *"It does not register a command or model tool"*, *"Never reads
  or displays discussion bodies, review text, inline comments, or review threads"*, *"Shows only the
  current branch's pull request; arbitrary pull request lookup is not supported"*.

The runner needs the operations the package explicitly does not do:

| The runner's call | What the package offers |
|---|---|
| list issues by label and search, 500 at a time | nothing |
| read one issue's body **and its comments** | nothing — bodies are never read |
| open a pull request on a named branch | nothing |
| post a comment on a pull request | nothing |
| add a label to a pull request | nothing |
| land a pull request | nothing |
| the newest marked review verdict, out of the comment bodies | nothing — counts only |

Two of those are contract, not convenience. The brief is the comment that opens with
`## Agent Brief`, and the review verdict is the comment that opens with `<!-- agent-review -->`: both
live in comment **bodies**, which the package never reads. And the merge gate reads the verdict of
one **named** pull request in one **named** repository, while the package only ever looks at the
current branch of the checkout it is started in.

The runner's own façade is already the interface the issue asked for: `src/gh.ts` holds every `gh`
argument in one place, every read has a typed argument builder and a tested parser, and `GhRunner` is
the seam the tests inject. `src/gh.ts` is the only module that names the `gh` binary, and
`test/gh-surface.test.ts` is now the guard that says so.

The rule is about the **runner's own modules**. The agent's session runs `gh` itself, as a person
would — the fourth turn's leftover instructions ask it to — and that is not the runner's transport.

## Rationale

**Why the contract does not move.** The contract binds the labels, the markers and the verdict — not
the transport. A transport swap that keeps every label, marker and verdict is allowed; one that
changes them is a contract change, and this is not one.

**Why `gh` and not a token.** `gh` is the only client the runner has credentials for: it authenticates
through the CLI's own store, and the runner holds no token of its own. Swapping the transport for a
direct API call means introducing a token, an auth model, and a secret to keep — a change far larger
than the issue, and one that would have to be a decision of its own.

**Why a dependency on a statusline extension is worse than nothing.** `test/package.test.ts` requires
every dependency to be declared in `.pi/settings.json`, so the packages load into the runner's own
sessions. A dependency on this one would load a statusline entry into every session the runner
starts, for a feature the runner cannot use.

**Why the rejection is a record and not a comment.** A rejected approach is a decision: the next person
to ask the same question should find the answer, not repeat the audit.

## Consequences

- `src/gh.ts` is unchanged in behaviour, and `npm run check` still passes on it.
- The dependency is not taken; `package.json` and `.pi/settings.json` are unchanged.
- `test/gh-surface.test.ts` fails if a second module starts naming the `gh` binary in code; prose
  that names it in passing does not count.
- If a real client is wanted later — the GitHub REST API, or a package that really exposes one — it
  is a separate decision, because it changes the authentication model and not only the calls.

## Links

- `src/gh.ts` — the façade: every `gh` argument, every parser, and `GhRunner`.
- `src/git.ts` — the same pattern for `git`, and the precedent for a transport behind one module.
- `test/gh-surface.test.ts` — the guard: one module names the `gh` binary.
- `test/package.test.ts` — the guard: every dependency is a package the runner loads.
- `contract/afk-runner.md` — the labels, the brief's marker and the review's marker: the contract
  that does not move.
- `docs/decisions/2026-11-02-the-merge-pipeline-is-separate.md` — the merge gate that reads the
  verdict out of the comment bodies.

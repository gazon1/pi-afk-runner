---
title: The session keeps its memory
status: accepted
date: 2026-11-08
authors: MiniMax Code
deciders: Singularity Developer
tags: [memory, session, model]
---

# The session keeps its memory

## Context

The work session is one conversation: every turn sees what the turns before it said, and
the memory is what carries a turn into the next one. Two bounds decide how much of that
conversation the session keeps:

- `lastMessages: 40` in `src/mastra/session.ts` — how many messages the memory holds.
- `TokenLimiter(50000)` in `src/mastra/agent.ts` — how many tokens the conversation may
  cost before it is trimmed.

Both bounds drop the **oldest** messages first, and the oldest thing in the work
session's conversation was the issue itself: its body and its comments arrived before
anything else. So a session that ran long enough dropped the contract the work was
judged against, and the model that then worked from what it had left said so — "the
issue body isn't in my context" — and was right.

Forty messages is a handful of tool calls: a turn that reads the tree fills it in one
step of the run. Fifty thousand tokens is a couple of file reads. The bounds were set
for a conversation that never got long, and a work session is long by construction.

The models the runner is used with carry two hundred thousand tokens of context, so
there was room the bounds were not using.

## Idea

Raise the session's memory bounds to what the models the runner runs on can carry.

## Decision

**The session keeps 400 messages.** `lastMessages` goes from 40 to 400: a work session's
conversation is one model's turns plus its tool results, and 400 messages is a whole run
rather than a handful of tool calls.

**The conversation may cost 150000 tokens.** The token limit goes from 50000 to 150000:
the models in use carry 200k of context, and the limit is what leaves room for the
answer.

**Both bounds are the runner's, and they are a pair.** The message count alone would
leave the token limiter as the real bound, and the token limit alone would leave the
message count as the real bound — a conversation of many short messages is cheap in
tokens and long in messages, and one of many file reads is the opposite.

## Rationale

**Why the bounds rise rather than the delivery.** The issue's data now travels with the
first turn (`2026-11-08-the-issue-travels-with-the-turn.md`), which is one turn earlier
than the intake's own turn used to be — but the last turns are still the ones that need
the brief, and they are the ones a long run reaches last. Moving the data a turn
earlier does not keep it for the whole conversation; the memory's bounds do.

**Why not the maximum.** The models carry 200k, and the limit of 150k leaves room for
the answer and for the engine's own overhead. The bounds are the runner's to hold, and
they are held where the engine's options are read.

**Why the message count matters beside the token count.** A turn that reads the tree
produces long tool results; a turn that only talks produces many short messages. A
conversation that is long in messages and cheap in tokens is exactly what a run of
short verdicts and small reads looks like, and only the message bound keeps it.

## Consequences

- **The memory is bigger, and it is in memory.** The session's memory is an
  `InMemoryStore` — a run's conversation is held for the run, and a longer bound holds
  more of it for longer.
- **A long run no longer loses the brief.** The issue's data is still the oldest
  message, but it survives far past the turns that used to outlive it.
- **The limits are the runner's defaults, and they are overridable.** `tokenLimit` is an
  option of `createMastraAgent`; the message bound belongs to the session's own memory.

## Links

- `src/mastra/session.ts` — the memory's message bound.
- `src/mastra/agent.ts` — the memory's token bound.
- `docs/decisions/2026-11-08-the-issue-travels-with-the-turn.md` — the other half: the
  data that travels with the first turn.

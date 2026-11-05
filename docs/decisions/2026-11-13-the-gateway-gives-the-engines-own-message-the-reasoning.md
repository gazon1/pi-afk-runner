---
title: The gateway gives the engine's own message the reasoning the provider asks for
status: accepted
date: 2026-11-13
authors: Command Code
deciders: Singularity Developer
tags: [session, engine, model, gateway]
---

# The gateway gives the engine's own message the reasoning the provider asks for

## Context

The runs of issues 1752 and 1753 stopped in the Triage phase with the provider's own words:

```
Missing required parameter: 'messages[27].reasoning_content'. This model needs the reasoning of
every earlier assistant message: send back the 'reasoning_content' returned with that message.
```

The model was `commandcode/reflection/beam:free` — a reasoning model. The provider wants the
reasoning of **every** earlier assistant message sent back with the request, and it refuses a
request that leaves one out. An empty reasoning is refused as well: the field has to be there
and it has to say something.

Two earlier attempts did not settle it: one stashed the reasoning of every response and put it
back by the index of the assistant message, the other read the reasoning from the `reasoning`
field of the response as well as from `reasoning_content`. Both kept a list of the reasoning of
the run's turns in a variable every session of the process shared, and both filled a message
from that list by position — the position of the assistant message in the request is not the
position of the response in the list when more than one issue works at a time.

A reproduction of the run's own session — the Mastra agent, the workspace tools, the feedback
between the steps — showed which message the provider was missing. It was not a message the
model had written:

```json
{
  "role": "assistant",
  "content": "You have read enough. Stop exploring and call the finish_triage tool now."
}
```

That is the **engine's** message: the feedback the engine injects between the steps of a turn.
Mastra adds it to the conversation as an assistant message, and the model never wrote it — so it
has no reasoning of its own, and the request that follows it is refused. Every model message
carried its reasoning back; only the engine's own message did not.

The message is the engine's own code that makes it: Mastra's `injectFeedback` adds it with
`role: "assistant"` and one text part, and no reasoning part — there is nothing in it for the
SDK to carry back. The model never wrote a reasoning for it, and the SDK never had one to give.

## Idea

The gateway is where the provider's rules live, so the gateway is what satisfies them: an
assistant message without a reasoning leaves with one.

## Decision

**The Command Code gateway gives every assistant message a reasoning, when the model reasons.**
A message that has one keeps it — the SDK carries the model's own reasoning back as a part of
the message it builds. A message that has none gets the last reasoning the model wrote before it,
and a placeholder when the model has written none before it. The order of the messages does not
matter: the history is cut from the oldest end, and a message the cut leaves first is still a
message the provider wants a reasoning on.

**A model that does not reason is left alone.** The gateway fills a message only when the
request itself shows that the model reasons — when another assistant message in the same request
carries a reasoning. A model that never reasons is not asked for one.

**The stash of the run's turns is gone.** The reasoning of a message is in the request that
follows it: the SDK puts it there. The gateway no longer reads the responses, and no state is
shared between the sessions of one process.

## Rationale

**Why the gateway and not the session.** The rule is the provider's, and the provider is the
gateway's. The session does not know which providers want a reasoning back, and the fix is not
about the session: the engine's message is the engine's message on every provider.

**Why the gateway and not the engine.** The point of origin is inside the engine: `injectFeedback`
is Mastra's code, and Mastra's code is not ours to change. The gateway is the last place we own
before the request leaves for the provider, so it is where the provider's rule is satisfied.

**Why the last reasoning the model wrote.** The provider only asks that the field is there and
says something — a reasoning from another turn is accepted as readily as the right one. The
model's own last words are the least surprising thing to put there, and the model reads them as
its own thinking, which is what they are.

**Why a placeholder when there is none before it.** The history is cut from the oldest end, and
the cut can leave the engine's message first — before any reasoning the model wrote. The provider
wants a reasoning on every assistant message, so the message gets one that says what it is: the
engine's own message. The order of the messages is the history's business, not the provider's.

**Why a model that does not reason is left alone.** Nothing asks such a model for a reasoning,
and a field it does not know is a field the provider may refuse.

**Why the stash is gone.** The list of the run's reasoning was shared by every session of the
process and indexed by the position of the message in the request. The runs work on several
issues at once, and the positions of two conversations in one process are not the same. The
reasoning of a message is where it belongs already: in the message.

## Consequences

- A reasoning model accepts the engine's feedback between the steps: the request that follows it
  carries a reasoning on every assistant message.
- The order of the messages does not matter: the engine's message gets a reasoning even when the
  cut of the history leaves it first.
- The body of a request is built again only when a message changed.
- The gateway reads no responses: one less thing to keep in step with the provider.
- The reasoning of one session is never mixed into another's.

## Links

- `src/mastra/gateways/commandcode.ts` — the rule and the gateway.
- `src/mastra/session.ts` — the feedback the engine injects between the steps.
- `2026-11-11-the-engine-tells-the-model-when-a-turn-has-read-enough.md` — the feedback, and why
  it is there.
- `2026-11-05-the-engine-tells-the-model-when-a-turn-ends-on-a-tool.md` — the same instrument, for
  a turn that ends on a tool.

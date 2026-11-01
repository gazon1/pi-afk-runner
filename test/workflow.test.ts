import { describe, expect, it } from "vitest";

import {
  cutOffMessage,
  PROMPT_FILES,
  readPrompts,
  runPromptArray,
  type AgentSession,
} from "../src/session.js";
import {
  cutOffError,
  FixChangedNothing,
  isCutOff,
  runReviewGate,
  runStates,
  runWorkSession,
  stateFailure,
  WORKFLOW_ACTIONS,
  WORKFLOW_STATES,
  type WorkflowState,
} from "../src/workflow.js";

/**
 * The workflow is the graph the session moves through, and the engine that
 * moves it. These are the tests that say what the graph is, and that the
 * engine's own machinery — its subagents, its own session model — is not used
 * for a turn.
 */

/** A session that records the turns it is given. */
function recordingSession(turns: string[]): AgentSession {
  return {
    async prompt(text) {
      turns.push(text);
    },
    async abort() {},
    dispose() {},
  };
}

describe("the session's workflow", () => {
  it("runs the four states, in order, one turn each", async () => {
    const ran: string[] = [];
    const result = await runStates({
      states: [
        { name: "brief", phase: "Brief", text: "the brief", counts: true },
        { name: "implement", phase: "Implement", text: "the work", counts: true },
      ],
      run: async (state) => {
        ran.push(state.name);
        return { state: "ok" };
      },
    });

    expect(ran).toEqual(["brief", "implement"]);
    expect(result.aborted).toBe(false);
    expect(result.completed.map((state) => state.name)).toEqual(["brief", "implement"]);
  });

  it("stops the run on a state that failed, and says what failed", async () => {
    const ran: string[] = [];
    const failure = new Error("the model's turn failed: the provider is down");
    const run = runStates({
      states: [
        { name: "brief", phase: "Brief", text: "the brief", counts: true },
        { name: "implement", phase: "Implement", text: "the work", counts: true },
      ],
      run: async (state) => {
        ran.push(state.name);
        return state.name === "brief" ? { state: "error", error: failure } : { state: "ok" };
      },
    });

    await expect(run).rejects.toThrow("the model's turn failed: the provider is down");
    // The state after the failed one never ran: a failed state is not a
    // recoverable hiccup the run carries on from.
    expect(ran).toEqual(["brief"]);
  });

  it("keeps the failure the state reported", async () => {
    const failure = new Error("the model's turn failed: the provider is down");
    const run = runStates({
      states: [{ name: "brief", phase: "Brief", text: "the brief", counts: true }],
      run: async () => ({ state: "error", error: failure }),
    });

    const thrown = await run.then(
      () => null,
      (error: unknown) => error,
    );
    expect(stateFailure(thrown)).toBe(failure);
  });

  it("says which state failed", async () => {
    // The states are what the session is made of: a failure that does not say
    // which one it was is a failure the record cannot point at.
    const run = runStates({
      states: [
        { name: "brief", phase: "Brief", text: "the brief", counts: true },
        { name: "implement", phase: "Implement", text: "the work", counts: true },
      ],
      run: async (state) =>
        state.name === "implement"
          ? { state: "error", error: new Error("the model's turn failed") }
          : { state: "ok" },
    });

    await expect(run).rejects.toThrow(
      "the Implement phase failed: the model's turn failed",
    );
  });

  it("does not swallow a turn that threw", async () => {
    // The engine treats a thrown failure as recoverable: it logs it, returns
    // nothing, and carries on. A run that carries on past a failed turn looks
    // like a run that worked.
    const failure = new Error("the session's turn failed");
    const ran: string[] = [];
    const run = runStates({
      states: [
        { name: "brief", phase: "Brief", text: "the brief", counts: true },
        { name: "implement", phase: "Implement", text: "the work", counts: true },
      ],
      run: async (state) => {
        ran.push(state.name);
        if (state.name === "brief") {
          throw failure;
        }
        return { state: "ok" };
      },
    });

    await expect(run).rejects.toThrow("the session's turn failed");
    expect(ran).toEqual(["brief"]);
  });

  it("comes back as a cut-off run, with the states that finished", async () => {
    const ran: string[] = [];
    const result = await runStates({
      states: [
        { name: "brief", phase: "Brief", text: "the brief", counts: true },
        { name: "implement", phase: "Implement", text: "the work", counts: true },
      ],
      run: async (state) => {
        if (state.name === "implement") {
          throw cutOffError("the run was cut off before its next turn");
        }
        ran.push(state.name);
        return { state: "ok" };
      },
    });

    expect(result.aborted).toBe(true);
    expect(result.completed.map((state) => state.name)).toEqual(["brief"]);
    expect(ran).toEqual(["brief"]);
  });

  it("tells a cut-off from a failure", () => {
    expect(isCutOff(cutOffError("the run was cut off"))).toBe(true);
    expect(isCutOff(new Error("the run was cut off"))).toBe(false);
  });

  it("maps the prompt files onto the six turn states", () => {
    // The states name the file each of them runs, and the file list is read
    // from them: the two cannot drift apart.
    expect(WORKFLOW_STATES.map((state) => state.promptFile)).toEqual([
      "00-triage.md",
      "00-scope.md",
      "01-brief.md",
      "02-implement.md",
      "03-verify.md",
      "04-next.md",
    ]);
    expect(PROMPT_FILES).toEqual(WORKFLOW_STATES.map((state) => state.promptFile));
    expect(WORKFLOW_STATES.map((state) => state.phase)).toEqual([
      "Triage",
      "Scope",
      "Brief",
      "Implement",
      "Verify",
      "Next",
    ]);
    // The two actions run no prompt: they are the runner's own work.
    expect(WORKFLOW_ACTIONS.map((action) => action.name)).toEqual([
      "close-skip",
      "split",
    ]);
  });

  it("fails the run when a turn throws", async () => {
    // The SDK's session can reject a turn. The run fails with it: a run that
    // carried on past it would look like a run that worked.
    const session: AgentSession = {
      async prompt() {
        throw new Error("the session's turn failed");
      },
      async abort() {},
      dispose() {},
    };

    const run = runPromptArray({
      session,
      prompts: ["one", "two"],
      states: [
        { name: "one", phase: "One" },
        { name: "two", phase: "Two" },
      ],
      deadlineMs: 60_000,
    });

    await expect(run).rejects.toThrow("the session's turn failed");
  });

  it("runs the prompt files as the states, in one session", async () => {
    const turns: string[] = [];
    const prompts = await readPrompts();
    const result = await runPromptArray({
      session: recordingSession(turns),
      prompts,
      states: WORKFLOW_STATES.map((state) => ({ name: state.name, phase: state.phase })),
      issueBody: "the issue",
      deadlineMs: 60_000,
    });

    // The data goes first, in a turn of its own, and is not counted; the
    // prompts run after it, one turn each.
    expect(result.completed).toBe(prompts.length);
    expect(result.total).toBe(prompts.length);
    expect(turns).toHaveLength(prompts.length + 1);
    expect(turns[0]).toContain('trust="untrusted"');
    expect(turns.slice(1)).toEqual(prompts);
  });

  it("refuses two states with one name", async () => {
    // The engine runs a state by its name: two states with one name are one
    // state, and the second one's turn would never run.
    const run = runStates({
      states: [
        { name: "brief", phase: "Brief", text: "the brief", counts: true },
        { name: "brief", phase: "Verify", text: "the work", counts: true },
      ],
      run: async () => ({ state: "ok" }),
    });

    await expect(run).rejects.toThrow("two states named brief");
  });
});

describe("the cut-off message", () => {
  it("names the deadline and how far the session got", () => {
    expect(
      cutOffMessage({
        what: "the agent's session",
        deadlineMs: 120 * 60_000,
        reason: "deadline",
        progress: { completed: 4, total: 6 },
      }),
    ).toBe("the agent's session hit its 120-minute deadline after 4 of 6 turns");
  });

  it("keeps a deadline under a minute in seconds", () => {
    expect(
      cutOffMessage({
        what: "the merge session",
        deadlineMs: 500,
        reason: "deadline",
      }),
    ).toBe("the merge session hit its 1-second deadline");
  });

  it("says a stop was not the clock, and how far it got", () => {
    expect(
      cutOffMessage({
        what: "the agent's session",
        deadlineMs: 60_000,
        reason: "stopped",
        progress: { completed: 2, total: 6 },
      }),
    ).toBe("the agent's session was cut off before its last turn (2 of 6 turns done)");
  });

  it("does not count a session that is one turn", () => {
    // "0 of 1" is noise: the last turn is the only turn there was.
    expect(
      cutOffMessage({
        what: "the review's session",
        deadlineMs: 60_000,
        reason: "stopped",
        progress: { completed: 0, total: 1 },
      }),
    ).toBe("the review's session was cut off before its last turn");
  });

  it("says nothing about progress when it has none", () => {
    expect(
      cutOffMessage({
        what: "the review's session",
        deadlineMs: 60_000,
        reason: null,
      }),
    ).toBe("the review's session was cut off before its last turn");
  });
});

/** The nodes the work script names, with a text equal to their name. */
function workNodes(): WorkflowState[] {
  return [
    ...WORKFLOW_STATES.map((state) => ({
      name: state.name,
      phase: state.phase,
      text: state.name,
      counts: true,
      kind: "turn" as const,
    })),
    ...WORKFLOW_ACTIONS.map((action) => ({
      name: action.name,
      phase: action.phase,
      text: "",
      counts: false,
      kind: "action" as const,
      action: action.action,
    })),
  ];
}

describe("the work session's branch", () => {
  it("closes the issue and stops when the triage says skip", async () => {
    const ran: string[] = [];
    const result = await runWorkSession({
      nodes: workNodes(),
      run: async (state) => {
        ran.push(state.name);
        return { state: "ok", result: state.name === "triage" ? "skip" : "ok" };
      },
    });

    // The four work turns never ran: the branch is the engine's own flow.
    expect(ran).toEqual(["triage", "close-skip"]);
    expect(result.completed.map((state) => state.name)).toEqual([
      "triage",
      "close-skip",
    ]);
  });

  it("splits and stops when the scope says split", async () => {
    const ran: string[] = [];
    await runWorkSession({
      nodes: workNodes(),
      run: async (state) => {
        ran.push(state.name);
        return { state: "ok", result: state.name === "scope" ? "split" : "ok" };
      },
    });

    expect(ran).toEqual(["triage", "scope", "split"]);
  });

  it("runs the work turns when the issue fits", async () => {
    const ran: string[] = [];
    const result = await runWorkSession({
      nodes: workNodes(),
      run: async (state) => {
        ran.push(state.name);
        return { state: "ok", result: "ok" };
      },
    });

    expect(ran).toEqual([
      "triage",
      "scope",
      "brief",
      "implement",
      "verify",
      "next",
    ]);
    expect(result.completed).toHaveLength(6);
  });

  it("runs the intake before the triage", async () => {
    const ran: string[] = [];
    await runWorkSession({
      nodes: [
        { name: "issue-body", phase: "Intake", text: "body", counts: false, kind: "turn" },
        {
          name: "issue-comments",
          phase: "Intake",
          text: "comments",
          counts: false,
          kind: "turn",
        },
        ...workNodes(),
      ],
      run: async (state) => {
        ran.push(state.name);
        return { state: "ok", result: "ok" };
      },
    });

    expect(ran.slice(0, 2)).toEqual(["issue-body", "issue-comments"]);
  });
});

describe("the review loop", () => {
  it("fixes and reviews again until the verdict passes", async () => {
    const calls: string[] = [];
    let reviewed = 0;
    const result = await runReviewGate({
      attempts: 4,
      review: async () => {
        reviewed += 1;
        calls.push(`review ${reviewed}`);
        return reviewed < 2 ? "fail" : "pass";
      },
      fix: async () => {
        calls.push("fix");
      },
    });

    // `gate` is the engine's block: the failed verdict's feedback buys a fix,
    // then the fixed diff is reviewed again.
    expect(result.passed).toBe(true);
    expect(result.reviews).toBe(2);
    expect(calls).toEqual(["review 1", "fix", "review 2"]);
  });

  it("stops when the attempts run out", async () => {
    const result = await runReviewGate({
      attempts: 3,
      review: async () => "fail",
      fix: async () => {},
    });

    expect(result.passed).toBe(false);
    expect(result.reviews).toBe(3);
  });

  it("stops when the fix changes nothing", async () => {
    // A fix that moved nothing has nothing to push and nothing to review
    // again: the loop stops rather than spend a review on the same diff.
    const calls: string[] = [];
    const result = await runReviewGate({
      attempts: 4,
      review: async () => {
        calls.push("review");
        return "fail";
      },
      fix: async () => {
        calls.push("fix");
        throw new FixChangedNothing();
      },
    });

    expect(result.passed).toBe(false);
    expect(result.noChange).toBe(true);
    expect(result.reviews).toBe(1);
    expect(calls).toEqual(["review", "fix"]);
  });

  it("does not stop on a fix that changed something", async () => {
    const result = await runReviewGate({
      attempts: 3,
      review: async () => "fail",
      fix: async () => {},
    });

    expect(result.noChange).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import { PROMPT_FILES, readPrompts, runPromptArray, type AgentSession } from "../src/session.js";
import {
  cutOffError,
  isCutOff,
  runStates,
  stateFailure,
  WORKFLOW_STATES,
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

  it("maps the prompt files onto the four states", () => {
    // The states name the file each of them runs, and the file list is read
    // from them: the two cannot drift apart.
    expect(WORKFLOW_STATES.map((state) => state.promptFile)).toEqual([
      "01-brief.md",
      "02-implement.md",
      "03-verify.md",
      "04-next.md",
    ]);
    expect(PROMPT_FILES).toEqual(WORKFLOW_STATES.map((state) => state.promptFile));
    expect(WORKFLOW_STATES.map((state) => state.phase)).toEqual([
      "Brief",
      "Implement",
      "Verify",
      "Next",
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

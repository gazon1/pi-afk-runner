/**
 * The session's workflow: the states it moves through, and the engine that
 * moves it.
 *
 * The engine is `@quintinshaw/pi-dynamic-workflows`. Its own agents are
 * **separate sessions, in separate worktrees** — a fleet of subagents, each
 * with a model of its own. That is a different thing from what the runner
 * needs: the work session is **one** session — one system prompt, one set of
 * tools, one context that every turn sees — and the runner's own rules (the
 * deadline, the stop, the turn whose model call failed) are the runner's to
 * hold, not the engine's.
 *
 * So the engine is given a **turn runner** instead of subagents: the engine
 * decides what runs next and in which phase, and the runner's code decides
 * what a turn does. The scripts below are written out of the engine's own
 * blocks — `phase()`, `agent()` and `gate()` — rather than out of a traversal
 * of our own: the flow is fixed, and these are the blocks it is made of.
 */

import {
  runWorkflow,
  WorkflowError,
  WorkflowErrorCode,
  type AgentRunOptions,
} from "@quintinshaw/pi-dynamic-workflows";
import type { TSchema } from "typebox";

import { GateFailed } from "./gates.js";

/** What a node of the graph is: a turn of the session, or work the runner does. */
export type NodeKind = "turn" | "action";

/**
 * The work session's turn states, and the prompt file each one runs.
 *
 * The order is the session's order when every branch is taken, and the names
 * are the phases the run is recorded under. The intake turns that come before
 * them are the issue's body and its comments.
 */
export const WORKFLOW_STATES = [
  { name: "triage", phase: "Triage", promptFile: "00-triage.md" },
  { name: "scope", phase: "Scope", promptFile: "00-scope.md" },
  { name: "brief", phase: "Brief", promptFile: "01-brief.md" },
  { name: "implement", phase: "Implement", promptFile: "02-implement.md" },
  { name: "verify", phase: "Verify", promptFile: "03-verify.md" },
  { name: "next", phase: "Next", promptFile: "04-next.md" },
] as const;

/**
 * The nodes that do not run a turn.
 *
 * They are the runner's own work — closing an issue, filing smaller ones — and
 * they run inside the same workflow so that the branch that reaches them is the
 * workflow's decision, not a condition beside it.
 */
export const WORKFLOW_ACTIONS = [
  { name: "close-skip", phase: "Close", action: "close-skip" },
  { name: "split", phase: "Split", action: "split" },
] as const;

/**
 * The name and the phase of a state, without its turn.
 *
 * The turn's text belongs to the caller: the work session's states run the
 * prompt files, and the review session's states run one prompt of their own.
 */
export interface StateName {
  /** The state's name — the label the engine runs it under. */
  readonly name: string;
  /** The phase the turn runs in. */
  readonly phase: string;
}

/** A state of a session's workflow: one turn or action. */
export interface WorkflowState extends StateName {
  /** The text of the turn. An action node has no text. */
  readonly text: string;
  /**
   * Whether the turn counts towards the run's completed prompts.
   *
   * The intake turns — the issue's body and its comments — are data, not
   * prompts: they are not counted, as the prompt array never counted them.
   * Neither are the action nodes: they are the runner's work, not the model's.
   */
  readonly counts: boolean;
  /** The kind of node. A turn when it is absent. */
  readonly kind?: NodeKind;
  /** The action's name, for an action node. */
  readonly action?: string;
}

/**
 * What one state did.
 *
 * A state either finished — with the token the script branches on — or failed,
 * and the failure is a value the runtime handles: the engine stops the run on
 * it, and the runner reports it.
 */
export type StateOutcome =
  | { readonly state: "ok"; readonly result?: string }
  | { readonly state: "error"; readonly error: Error };

/** Runs one state's turn or action. */
export type TurnRunner = (state: WorkflowState) => Promise<StateOutcome>;

/** What a run of the states did. */
export interface StatesResult {
  /** The states that finished. */
  readonly completed: readonly WorkflowState[];
  /** Whether the run was cut off before its last state. */
  readonly aborted: boolean;
}

/**
 * The script a session without branches runs: one turn per state, in order.
 *
 * It is the review, the merge resolution, and the tests that say what a turn
 * does. It uses the engine's `phase` and `agent` blocks directly.
 */
const LINEAR_SCRIPT = `export const meta = {
  name: 'afk_session',
  description: "The runner's session: one turn per state, in one session.",
}

const outcomes = []
for (const state of args.states) {
  phase(state.phase)
  outcomes.push(await agent(state.text, { label: state.name }))
}
return outcomes
`;

/**
 * The script the work session runs.
 *
 * It is the branch the issue takes, in the engine's own blocks: the intake
 * data, a triage that may close the issue instead of working it, a scope check
 * that may split it into smaller issues, and then the four work turns. A
 * decision is the token the turn returned, and the `if` is what follows it.
 */
const WORK_SCRIPT = `export const meta = {
  name: 'afk_work_session',
  description: "The runner's work session: triage, scope, then the work.",
}

const run = async (name) => {
  const state = args.nodes[name]
  phase(state.phase)
  return await agent(state.text, { label: name })
}

if (args.nodes['issue-body']) {
  await run('issue-body')
}
if (args.nodes['issue-comments']) {
  await run('issue-comments')
}

if (args.nodes['related']) {
  await run('related')
}

const triage = await run('triage')
if (triage === 'skip') {
  await run('close-skip')
  return { decision: 'skip' }
}

const scope = await run('scope')
if (scope === 'split') {
  await run('split')
  return { decision: 'split' }
}

await run('brief')
await run('implement')
await run('verify')
await run('next')
return { decision: 'work' }
`;

/**
 * The script the review loop runs.
 *
 * `gate()` is the engine's own retry-until-pass block: it runs the review, the
 * validator decides whether the verdict passed, and a failure's feedback is fed
 * to the next attempt, which fixes before it reviews again. The runner's
 * callbacks do the work; the loop is the engine's.
 */
const REVIEW_SCRIPT = `export const meta = {
  name: 'afk_review',
  description: "Review the pull request until it passes, fixing what failed.",
}

phase('Review')
const result = await gate(
  async (feedback) => {
    if (feedback) {
      await agent(feedback, { label: 'fix' })
    }
    return await agent('review', { label: 'review' })
  },
  (value) => value === 'pass' ? { ok: true } : { ok: false, feedback: 'the review said fail' },
  { attempts: args.attempts },
)
return result
`;

/**
 * The error that says the run was cut off.
 *
 * It is the engine's own abort error, so the engine stops the run on it
 * instead of treating it as a recoverable failure and carrying on to the next
 * state.
 */
export function cutOffError(message: string): WorkflowError {
  return new WorkflowError(message, WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: false });
}

/** Whether an error says the run was cut off. */
export function isCutOff(error: unknown): boolean {
  return error instanceof WorkflowError && error.code === WorkflowErrorCode.WORKFLOW_ABORTED;
}

/**
 * The error a state failed with, when the engine is carrying one.
 *
 * The engine wraps a failed turn in its own error; the failure underneath it
 * is the one the runner reports, with the message the caller expects.
 */
export function stateFailure(error: unknown): Error | null {
  if (error instanceof WorkflowError && error.details instanceof Error) {
    return error.details;
  }
  return null;
}

/**
 * The host's `agent` wrapper around a turn runner.
 *
 * The engine runs a node by its label, so the label is what finds the state.
 * A label the runner did not declare is a graph that has drifted from the
 * runner, and it fails rather than running a turn nobody waited for. A failed
 * turn is made **unrecoverable**: the engine's own default is to log it and
 * carry on, and a run that carries on past a failed turn looks like a run that
 * worked.
 */
function turnAgent(options: {
  readonly byName: ReadonlyMap<string, WorkflowState>;
  readonly run: TurnRunner;
  readonly completed: WorkflowState[];
}): { run(prompt: string, agentOptions?: AgentRunOptions<TSchema>): Promise<unknown> } {
  const runNode = async (state: WorkflowState): Promise<StateOutcome> => {
    try {
      return await options.run(state);
    } catch (error) {
      if (isCutOff(error)) {
        throw error;
      }
      return {
        state: "error",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  };

  return {
    async run(_prompt: string, agentOptions?: AgentRunOptions<TSchema>): Promise<unknown> {
      const name = agentOptions?.label ?? "";
      const state = options.byName.get(name);
      if (state === undefined) {
        throw new WorkflowError(
          `the workflow ran a state the session does not declare: ${name}`,
          WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
          { recoverable: false },
        );
      }
      const outcome = await runNode(state);
      if (outcome.state === "error") {
        // The failure says which state it happened in: the states are what the
        // session is made of, and a failure without a place is a failure the
        // record cannot point at.
        throw new WorkflowError(
          `the ${state.phase} phase failed: ${outcome.error.message}`,
          WorkflowErrorCode.AGENT_EXECUTION_ERROR,
          {
            recoverable: false,
            details: outcome.error,
          },
        );
      }
      options.completed.push(state);
      // The engine reads an empty answer as a state that produced nothing, and
      // treats it as a recoverable failure: a state that finished says so.
      return outcome.result ?? "ok";
    },
  };
}

/**
 * Run one script in one session.
 *
 * It is the one place the engine is called: the names are checked for
 * duplicates, the turns are run through the host's `agent`, and a run that is
 * cut off comes back as an aborted run with the nodes that finished.
 */
async function runEngine(options: {
  readonly script: string;
  readonly args: unknown;
  readonly nodes: readonly WorkflowState[];
  readonly run: TurnRunner;
}): Promise<StatesResult> {
  const completed: WorkflowState[] = [];
  const byName = new Map<string, WorkflowState>();
  for (const node of options.nodes) {
    if (byName.has(node.name)) {
      // The engine runs a state by its name, so two states with one name are
      // one state: the second one's turn would never run, and the first one's
      // would run twice.
      throw new Error(`the session declares two states named ${node.name}`);
    }
    byName.set(node.name, node);
  }

  try {
    await runWorkflow(options.script, {
      args: options.args,
      agent: turnAgent({ byName, run: options.run, completed }),
      // The runner's deadline is the run's timeout: a second one here would
      // cut a turn the runner still wants, and a retry here would send a turn
      // twice.
      agentTimeoutMs: null,
      agentRetries: 0,
      // The record of a run belongs to the runner, under
      // `build/diagnostics/`: the engine's own logs are not it.
      persistLogs: false,
    });
    return { completed, aborted: false };
  } catch (error) {
    if (isCutOff(error)) {
      return { completed, aborted: true };
    }
    throw error;
  }
}

/**
 * Run the states, in order, in one session.
 *
 * The engine runs the linear script; the runner's `run` runs the turns. A
 * state that fails stops the run and the failure comes back out of it; a run
 * that is cut off comes back as an aborted run, with the states that finished.
 */
export async function runStates(options: {
  readonly states: readonly WorkflowState[];
  readonly run: TurnRunner;
}): Promise<StatesResult> {
  return runEngine({
    script: LINEAR_SCRIPT,
    args: { states: options.states },
    nodes: options.states,
    run: options.run,
  });
}

/**
 * Run the work session's graph.
 *
 * The script is the branch; the `nodes` are what it runs. A node the session
 * did not declare is not in the map, and the script only names the ones it
 * knows: the intake turns when the issue has them, and the two actions on the
 * branches that reach them.
 */
export async function runWorkSession(options: {
  readonly nodes: readonly WorkflowState[];
  readonly run: TurnRunner;
}): Promise<StatesResult> {
  const nodes: Record<string, { phase: string; text: string }> = {};
  for (const node of options.nodes) {
    nodes[node.name] = { phase: node.phase, text: node.text };
  }
  return runEngine({
    script: WORK_SCRIPT,
    args: { nodes },
    nodes: options.nodes,
    run: options.run,
  });
}

/**
 * The error a fix raises when it changed nothing.
 *
 * The review loop stops on it: a fix that moved nothing has nothing to push
 * and nothing to review again, and the loop would spend a review on the same
 * diff to hear the same verdict.
 *
 * It is a `WorkflowError` that is **not recoverable**, like the run's cut-off:
 * the engine's `gate` has no break, so the only way out of the loop is a
 * failure the engine stops the run on.
 */
export class FixChangedNothing extends WorkflowError {
  constructor(message = "the fix changed nothing") {
    super(message, WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: false });
    this.name = "FixChangedNothing";
  }
}

/** The error a review raises when it ended without stating a verdict. */
export class ReviewStatedNoVerdict extends WorkflowError {
  constructor(message = "the review stated no verdict") {
    super(message, WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: false });
    this.name = "ReviewStatedNoVerdict";
  }
}

/** Why the review loop stopped. One value per stop. */
export type ReviewGateStopReason =
  | { readonly kind: "passed" }
  | { readonly kind: "failed" }
  | { readonly kind: "noChange" }
  | { readonly kind: "statedNoVerdict" }
  | { readonly kind: "cutOff"; readonly message: string };

/** What the review loop did. */
export interface ReviewGateResult {
  /** How many reviews the engine asked for. */
  readonly reviews: number;
  /** Why the loop stopped. */
  readonly stopReason: ReviewGateStopReason;
}

/**
 * Review, fix, and review again until the verdict passes or the attempts run
 * out — the engine's `gate`, not a loop of our own.
 *
 * `review` returns the verdict; `fix` gets the feedback the failed verdict
 * produced and does the correcting. The number of attempts bounds the loop, and
 * the caller's own deadline bounds each turn.
 *
 * A `fix` that raises {@link FixChangedNothing} stops the loop: there is
 * nothing to push and nothing to review again, and the loop comes back with
 * `noChange` set.
 *
 * A review that was cut off stops the loop too. The cut-off is the engine's
 * own abort error — an unknown failure is **recoverable**, and a recoverable
 * failure is swallowed: the engine logs it, returns nothing, and the loop
 * carries on to the next attempt. A review that was cut off stated no
 * verdict, so there is nothing to fix and nothing to review again, and the
 * loop comes back with `cutOff` set.
 */
export async function runReviewGate(options: {
  readonly attempts: number;
  readonly review: () => Promise<"pass" | "fail">;
  readonly fix: (feedback: string | undefined) => Promise<void>;
}): Promise<ReviewGateResult> {
  let reviews = 0;
  const agent = {
    async run(prompt: string, agentOptions?: AgentRunOptions<TSchema>): Promise<unknown> {
      const label = agentOptions?.label ?? "";
      if (label === "review") {
        reviews += 1;
        // A review that was cut off raises the engine's own abort error: the
        // engine stops the run on it and the loop ends where it is. A plain
        // failure would be swallowed — an unknown failure is recoverable —
        // and the loop would buy another fix turn and another review of the
        // same diff.
        return await options.review();
      }
      if (label === "fix") {
        try {
          await options.fix(prompt === "" ? undefined : prompt);
        } catch (error) {
          if (error instanceof GateFailed) {
            // A gate that refused the fix is not a failure the engine may
            // swallow: it would carry on to the next review, and the review
            // would pass on a tree that was never pushed — the run would say
            // it worked, and nothing would name the gate. The failure under
            // it is kept, so the record and the exit code can name it.
            throw new WorkflowError(
              error.message,
              WorkflowErrorCode.AGENT_EXECUTION_ERROR,
              { recoverable: false, details: error },
            );
          }
          // A fix that changed nothing carries its own way out: it is not
          // recoverable, so the engine stops the run on it and the loop ends.
          throw error;
        }
        return "ok";
      }
      throw new WorkflowError(
        `the review workflow ran an unexpected state: ${label}`,
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      );
    },
  };

  try {
    const run = await runWorkflow<{ ok?: boolean }>(REVIEW_SCRIPT, {
      args: { attempts: options.attempts },
      agent,
      agentTimeoutMs: null,
      agentRetries: 0,
      persistLogs: false,
    });
    return {
      reviews,
      stopReason: run.result?.ok === true ? { kind: "passed" } : { kind: "failed" },
    };
  } catch (error) {
    // The fix that changed nothing stops the loop, and the loop's verdict is
    // a failure: the review did not pass, and the fix did not answer it.
    if (error instanceof FixChangedNothing) {
      return { reviews, stopReason: { kind: "noChange" } };
    }
    if (error instanceof ReviewStatedNoVerdict) {
      return { reviews, stopReason: { kind: "statedNoVerdict" } };
    }
    // The run was cut off — the review's session or the fix's. The engine
    // stopped on it: it is the engine's own abort error, and an unknown
    // failure would have been swallowed and the loop would have carried on.
    // There is no verdict to answer, so the loop ends where it is and the
    // reason comes back with it.
    if (isCutOff(error)) {
      return {
        reviews,
        stopReason: { kind: "cutOff", message: error instanceof Error ? error.message : String(error) },
      };
    }
    throw error;
  }
}

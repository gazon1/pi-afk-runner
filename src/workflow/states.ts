/**
 * The states a session's workflow is made of.
 *
 * A state is one turn of the session, or work the runner does. The names are
 * the labels the run is recorded under, and the prompt file each turn runs.
 */

/** What a node of the graph is: a turn of the session, or work the runner does. */
export type NodeKind = "turn" | "action";

/**
 * The work session's turn states, and the prompt file each one runs.
 *
 * The order is the session's order when every branch is taken, and the names
 * are the phases the run is recorded under. The issue's own data is not a
 * state: it travels with the first turn, above that turn's instruction.
 *
 * The role says what a state is for: a decision picks what follows it, and a
 * work turn is the work itself. The graph reads the roles off this table, so
 * a state that is added here is run by the graph as well.
 */
export const WORKFLOW_STATES = [
  { name: "triage", phase: "Triage", promptFile: "00-triage.md", role: "decision" },
  { name: "scope", phase: "Scope", promptFile: "00-scope.md", role: "decision" },
  { name: "brief", phase: "Brief", promptFile: "01-brief.md", role: "work" },
  { name: "implement", phase: "Implement", promptFile: "02-implement.md", role: "work" },
  { name: "verify", phase: "Verify", promptFile: "03-verify.md", role: "work" },
  { name: "next", phase: "Next", promptFile: "04-next.md", role: "work" },
] as const;

/**
 * The nodes that do not run a turn.
 *
 * They are the runner's own work — closing an issue, filing smaller ones — and
 * they run inside the same graph so that the branch that reaches them is the
 * graph's decision, not a condition beside it.
 */
export const WORKFLOW_ACTIONS = [
  { name: "close-skip", phase: "Close", action: "close-skip" },
  { name: "split", phase: "Split", action: "split" },
] as const;

/** The turns the work is made of. */
export const WORK_STATES: readonly string[] = WORKFLOW_STATES.filter(
  (state) => state.role === "work",
).map((state) => state.name);

/**
 * The name and the phase of a state, without its turn.
 *
 * The turn's text belongs to the caller: the work session's states run the
 * prompt files, and the review session's states run one prompt of their own.
 */
export interface StateName {
  /** The state's name — the label the graph runs it under. */
  readonly name: string;
  /** The phase the turn runs in. */
  readonly phase: string;
}

/**
 * The text of a turn.
 *
 * A plain string is the text. A **function** is text that is only known when
 * the turn runs: the batched issues' briefs, for instance, exist only after
 * the related turn has decided which issues to batch, and they are read from
 * the repository at that moment.
 */
export type StateText = string | (() => string | Promise<string>);

/** A state of a session's workflow: one turn or action. */
export interface WorkflowState extends StateName {
  /** The text of the turn. An action node has no text. */
  readonly text: StateText;
  /**
   * Whether the turn counts towards the run's completed prompts.
   *
   * The action nodes are the runner's work, not the model's: they are not
   * counted.
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
 * A state either finished — with the token the branch is keyed by — or failed,
 * and the failure is a value the runtime handles: the graph stops the run on
 * it, and the runner reports it.
 */
export type StateOutcome =
  | { readonly state: "ok"; readonly result?: string }
  | { readonly state: "error"; readonly error: Error };

/** Runs one state's turn or action. */
export type TurnRunner = (state: WorkflowState) => Promise<StateOutcome>;

/**
 * The text of a state, resolved when the turn runs.
 *
 * A state that carries its text as a function is asked for it at the moment
 * the turn starts, and not before: the text may depend on what an earlier
 * turn decided.
 */
export async function stateText(state: WorkflowState): Promise<string> {
  return typeof state.text === "function" ? await state.text() : state.text;
}

/** What a run of the states did. */
export interface StatesResult {
  /** The states that finished. */
  readonly completed: readonly WorkflowState[];
  /** Whether the run was cut off before its last state. */
  readonly aborted: boolean;
}

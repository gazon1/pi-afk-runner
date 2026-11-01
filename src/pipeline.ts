/**
 * The pipeline: the steps a run takes, in the order it takes them.
 *
 * The steps used to be a fixed list inside `runPlan` — claim, worktree,
 * session, push, pull request, review, re-count — and a repository that
 * wanted a different order, or a step the runner does not have, could not say
 * so: it would have to change the runner and wait for a release.
 *
 * The pipeline is the repository's own file, `.afk-runner/pipeline.yml`, and it
 * names the steps the runner performs, in order, from a fixed set of kinds:
 *
 * ```yaml
 * steps:
 *   - claim
 *   - worktree
 *   - session
 *   - gates
 *   - push
 *   - pull-request
 *   - review
 *   - re-count
 *
 * gates:
 *   - ./check.sh
 *   - just tcheck-evals
 * ```
 *
 * The runner's state machine is unchanged: the same steps, the same state, the
 * same record. The file says which of them happen and in what order.
 *
 * Two rules make the file safe to read:
 *
 * - **The kinds are fixed.** A step the runner does not know is refused when
 *   the file is read — before a claim is taken, before a worktree is made —
 *   and not half-way through a run.
 * - **A file that is not there is the built-in default.** A repository that
 *   declares no pipeline runs exactly the steps it ran before.
 *
 * The file is the repository's own, so it is read from the checkout the run
 * works in. It is read **before** the run takes anything, so a file the runner
 * cannot understand costs the run nothing.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

/**
 * The step kinds the runner knows.
 *
 * The set is closed: a repository chooses from it and cannot add to it. A new
 * kind is a change to the runner, and the runner's own contract says so.
 */
export const STEP_KINDS = [
  "claim",
  "worktree",
  "session",
  "gates",
  "push",
  "pull-request",
  "review",
  "re-count",
] as const;

/** One of the built-in step kinds. */
export type StepKind = (typeof STEP_KINDS)[number];

/**
 * The name each step is recorded under.
 *
 * The kind is the file's word for the step (`pull-request`); the record's word
 * is the runner's (`pull request`), and the two are kept apart on purpose: the
 * file is the repository's, the record is the runner's.
 */
export const STEP_NAMES: Readonly<Record<StepKind, string>> = {
  claim: "claim",
  worktree: "worktree",
  session: "session",
  gates: "gates",
  push: "push",
  "pull-request": "pull request",
  review: "review",
  "re-count": "re-count",
};

/**
 * The steps a run takes when the repository declares no pipeline.
 *
 * This is the runner's own list, unchanged: the same steps, in the same
 * order, with the same results. A repository that wants a different order
 * declares one.
 */
export const DEFAULT_STEPS: readonly StepKind[] = [
  "claim",
  "worktree",
  "session",
  "push",
  "pull-request",
  "review",
  "re-count",
];

/**
 * The order the built-in kinds belong in.
 *
 * The default list is this order without the `gates` step, because the runner
 * runs no gates until a repository declares them. A repository that declares
 * gate commands and no step list gets the gates step where it belongs — after
 * the session, which is the work the gates judge.
 */
const CANONICAL_ORDER: readonly StepKind[] = [
  "claim",
  "worktree",
  "session",
  "gates",
  "push",
  "pull-request",
  "review",
  "re-count",
];

/** What a repository's pipeline says. */
export interface Pipeline {
  /** The steps the run takes, in order. */
  readonly steps: readonly StepKind[];
  /** The gate commands the `gates` step runs, in order. */
  readonly gates: readonly string[];
}

/** The pipeline a repository that declares none gets. */
export const DEFAULT_PIPELINE: Pipeline = {
  steps: DEFAULT_STEPS,
  gates: [],
};

/** Where the pipeline lives in the repository the runner works. */
export const PIPELINE_PATH = ".afk-runner/pipeline.yml";

/**
 * The places the pipeline may live.
 *
 * The file is the repository's, and a repository that writes YAML may spell
 * the extension either way. Both are the same file as far as the runner is
 * concerned.
 */
const PIPELINE_PATHS: readonly string[] = [
  PIPELINE_PATH,
  ".afk-runner/pipeline.yaml",
];

/** Whether a word names one of the built-in step kinds. */
function isStepKind(value: string): value is StepKind {
  return (STEP_KINDS as readonly string[]).includes(value);
}

/** The message that names the kinds the runner knows. */
function unknownKind(kind: string, source: string): Error {
  return new Error(
    `${source} declares an unknown step kind "${kind}" — the runner knows: ${STEP_KINDS.join(", ")}`,
  );
}

/** The steps a list of words declares, or the failure that says it does not. */
function parseSteps(value: unknown, source: string): readonly StepKind[] {
  if (!Array.isArray(value)) {
    throw new Error(`${source} declares its steps as something that is not a list`);
  }
  const steps: StepKind[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new Error(`${source} declares a step that is not a word: ${JSON.stringify(entry)}`);
    }
    if (!isStepKind(entry)) {
      throw unknownKind(entry, source);
    }
    if (steps.includes(entry)) {
      // A step twice is a typo, and a typo that runs the claim twice is a
      // claim taken twice.
      throw new Error(`${source} declares the step "${entry}" twice`);
    }
    steps.push(entry);
  }
  return steps;
}

/** The gate commands a list of words declares, or the failure that says it does not. */
function parseGates(value: unknown, source: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${source} declares its gates as something that is not a list`);
  }
  const gates: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new Error(`${source} declares a gate that is not a command: ${JSON.stringify(entry)}`);
    }
    gates.push(entry);
  }
  return gates;
}

/**
 * Read a pipeline out of the text of a file.
 *
 * The file's own shape is small: a list of step kinds and a list of gate
 * commands. Keys the runner does not know are left alone — the file is the
 * repository's, and it may say things about prompts and skills that this
 * runner does not read yet.
 */
export function parsePipeline(text: string, source: string = PIPELINE_PATH): Pipeline {
  let document: unknown;
  try {
    document = parseYaml(text);
  } catch (failure) {
    throw new Error(
      `${source} is not YAML: ${failure instanceof Error ? failure.message : String(failure)}`,
    );
  }
  if (document === null || document === undefined) {
    // An empty file says nothing, and what it says is the default.
    return DEFAULT_PIPELINE;
  }
  if (typeof document !== "object" || Array.isArray(document)) {
    throw new Error(`${source} is not a pipeline — it is a list or a word, and it is neither`);
  }
  const record = document as Record<string, unknown>;
  const gates = record["gates"] === undefined ? [] : parseGates(record["gates"], source);

  if (record["steps"] === undefined) {
    // No step list: the default one, with the gates step where it belongs if
    // the repository declared gates it wants run.
    return {
      steps: gates.length === 0 ? DEFAULT_STEPS : withGates(),
      gates,
    };
  }
  const steps = parseSteps(record["steps"], source);
  if (!steps.includes("claim")) {
    // The claim is what stops two runners working the same issue, and the
    // runner does not trust anything else to do it — not even the queue's own
    // query. A pipeline that drops the claim step drops that, and a file is
    // not the place to give it up.
    throw new Error(
      `${source} declares no claim step — a run that works an issue without claiming it lets two runners work the same issue`,
    );
  }
  return { steps, gates };
}

/** The default list with the gates step in it, where the gates belong. */
function withGates(): readonly StepKind[] {
  const index = CANONICAL_ORDER.indexOf("gates");
  const before = CANONICAL_ORDER.slice(0, index).filter((kind) =>
    DEFAULT_STEPS.includes(kind),
  );
  const after = DEFAULT_STEPS.filter((kind) => !before.includes(kind));
  return [...before, "gates", ...after];
}

/**
 * Read the pipeline of the repository the runner works in.
 *
 * A repository that declares no pipeline gets the built-in default: the steps
 * the runner has always taken.
 */
export async function readPipeline(checkout: string): Promise<Pipeline> {
  for (const relative of PIPELINE_PATHS) {
    const path = join(checkout, relative);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw failure;
    }
    return parsePipeline(text, path);
  }
  return DEFAULT_PIPELINE;
}

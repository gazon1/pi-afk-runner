/**
 * The session the Mastra agent works in.
 *
 * It is the runner's `AgentSession` — the seam the runner drives — with
 * Mastra's agent underneath: a prompt is a `generate`, an abort is an
 * `AbortController`, and the messages are the turns the session has had.
 *
 * The **failure** settles: a turn whose model call failed does not throw out
 * of the session, and the failure is on the last assistant message. The runner
 * reads the failure from there.
 */

import type { Agent } from "@mastra/core/agent";
import { InMemoryStore } from "@mastra/core/storage";
import { Memory } from "@mastra/memory";

import type { AgentSession, RunUsage, SessionFactory, TurnFeedback, TurnMessage } from "../session.js";
import type { ToolSpec } from "../tools.js";
import { createMastraAgent, systemPrompt } from "./agent.js";
import { logTurn, refusalLine, toolCallLine } from "./log.js";
import { DEFAULT_MASTRA_MODEL, resolveMastraModel } from "./model.js";
import { skillDirectories } from "./skills.js";

/** The thread the run's turns are kept in. */
const THREAD = "afk-runner";

/**
 * How many LLM steps a turn may take.
 *
 * Mastra's own default is five, and five is too few for a turn that reads the
 * tree: the model spends its steps on `cat` and `grep` and never reaches the
 * tool that ends the turn. A review that runs out of steps says nothing, and a
 * run that reads nothing is not a run.
 *
 * The deadline is the real bound — an abort ends the turn whatever this says.
 */
const MAX_STEPS = 40;

/**
 * How many steps the model may take before the session tells it to finish.
 *
 * A turn that reads the tree does not stop by itself: the model finds one more
 * file to look at, and one more after that. The engine's step limit ends such a
 * turn with nothing decided — the review that read everything and said
 * nothing is a review without a verdict. Telling the model, between its steps,
 * that the turn ends with a tool is what makes it end.
 */
const FINAL_TOOL_AFTER_STEPS = 8;

/** The message a failed turn leaves behind. */
function failedTurn(failure: unknown): TurnMessage {
  return {
    role: "assistant",
    stopReason: "error",
    errorMessage: failure instanceof Error ? failure.message : String(failure),
  };
}

/**
 * The usage a turn reported, when it reported any.
 *
 * Mastra's usage has no cost — the provider reports tokens, not money — so
 * the report carries the tokens alone. Zero is not a report: a turn that
 * reads zero tokens has nothing to say about what it cost.
 */
function usageOf(answer: {
  readonly usage?: { readonly totalTokens?: number | undefined };
}): RunUsage | undefined {
  const tokens = answer.usage?.totalTokens;
  if (tokens === undefined || !Number.isFinite(tokens) || tokens <= 0) {
    return undefined;
  }
  return { totalTokens: tokens };
}

/**
 * The two listeners, as one.
 *
 * The factory's listener is the run's own — the command's `say`: the run's
 * **log**. The session's listener writes the run's **journal**, the file beside
 * the record. A line goes to both.
 */
function mergedEvents(
  factory: ((line: string) => void) | undefined,
  session: ((line: string) => void) | undefined,
): ((line: string) => void) | undefined {
  if (factory === undefined) {
    return session;
  }
  if (session === undefined) {
    return factory;
  }
  return (line) => {
    factory(line);
    session(line);
  };
}

/**
 * The session factory the Mastra engine runs under.
 *
 * The model is the command's `--model` — a `provider/model` reference — and
 * the skills are the runner's own plus the target repository's. The worktree
 * is the session's working directory: the agent's workspace is bound to it,
 * so the files the agent reads and writes are the run's.
 */
export function mastraSessionFactory(options: {
  /** The model — `provider/model`. MiniMax's own when it is absent. */
  readonly model?: string;
  /** Told what the agent is doing, as it does it. */
  readonly onEvent?: (line: string) => void;
}): SessionFactory {
  return async (sessionOptions): Promise<AgentSession> => {
    // The session's own model is the pool's choice; the factory's is the
    // command's `--model`, which wins over the pool — a named model is a
    // decision, and the pool does not overrule a decision.
    const model = await resolveMastraModel(
      sessionOptions.model ?? options.model ?? DEFAULT_MASTRA_MODEL,
    );
    // The run's own listener and the session's — the journal's writer — both
    // hear every line.
    const onEvent = mergedEvents(options.onEvent, sessionOptions.onEvent);
    return createMastraSession({
      ...options,
      ...sessionOptions,
      model,
      ...(onEvent === undefined ? {} : { onEvent }),
    });
  };
}

/** The model the agent runs on — Mastra's own shape. */
export type MastraModel = NonNullable<ConstructorParameters<typeof Agent>[0]["model"]>;

/**
 * How many messages the session keeps.
 *
 * The memory is what carries a turn into the next one, and it drops the
 * **oldest** messages first: the issue's own data is the oldest thing in the
 * conversation, so a short window throws away the contract the work is judged
 * against. Forty messages is a handful of tool calls — a turn that reads the
 * tree fills it in one step of the run.
 */
const LAST_MESSAGES = 400;

/**
 * The session, on a model that is already resolved.
 *
 * The factory above resolves the model by its name; this one takes the model
 * itself, so a run can be made on any model — the runner's own, or a test's.
 */
export async function createMastraSession(options: {
  /** The model the agent runs on. */
  readonly model: MastraModel;
  /** The worktree the agent works in. */
  readonly cwd: string;
  /** The rules the agent works under. */
  readonly systemPromptSections: Record<string, string>;
  /** The runner's tools. */
  readonly tools?: readonly ToolSpec[];
  /** The tool the turn must end on — the verdict tool, for a review. */
  readonly finalTool?: string;
  /** What the model is told between the steps, when it has read enough. */
  readonly feedback?: TurnFeedback;
  /** Told what a turn cost, when the provider reported it. */
  readonly onUsage?: (usage: RunUsage) => void;
  /** Told what the agent is doing, as it does it. */
  readonly onEvent?: (line: string) => void;
  /** The model the session runs on — `provider/id`, when the caller knows it. */
  readonly reference?: string;
}): Promise<AgentSession> {
  const { cwd, systemPromptSections, tools, onUsage, model } = options;
  const skills = await skillDirectories({ cwd });
  // The memory belongs to the session, not to the agent: a session that moves
  // onto another model builds a new agent and keeps this one, so the
  // conversation the session has is not lost by the move.
  const memory = new Memory({
    storage: new InMemoryStore(),
    options: { lastMessages: LAST_MESSAGES },
  });
  const build = (on: MastraModel): Agent =>
    createMastraAgent({
      cwd,
      name: "afk-runner",
      instructions: systemPrompt(systemPromptSections),
      model: on,
      tools: tools ?? [],
      skills,
      memory,
    });
  let agent = build(model);
  let reference = options.reference;

  let messages: TurnMessage[] = [];
  let running: AbortController | null = null;

  // Whether the turn's own final tool has been called already. The engine's
  // step hook sees one iteration at a time, so the answer is carried here.
  let finalToolCalled = false;

  return {
    async prompt(text: string): Promise<void> {
      const controller = new AbortController();
      running = controller;
      finalToolCalled = false;
      // The calls this turn hands over while it runs. The engine gives a call
      // over when the model makes it — before the tool answers — so a tool
      // that runs for minutes does not look like a run that stopped.
      const streamed = new Set<string>();
      try {
        const answer = await agent.generate(text, {
          abortSignal: controller.signal,
          // A turn that reads the tree needs more than Mastra's five steps.
          maxSteps: MAX_STEPS,
          // The memory is what carries a turn into the next one: the work
          // session is one conversation.
          memory: { thread: THREAD, resource: cwd },
          // The journal is written while the turn works, not when it ends.
          onChunk: (chunk) => {
            if (options.onEvent === undefined) {
              return;
            }
            // A refusal is written too: a call the guard refused is over, and
            // a reader has to see that it is over.
            if (chunk.type === "tool-result") {
              const line = refusalLine(chunk.payload.result);
              if (line !== undefined) {
                options.onEvent(line);
              }
              return;
            }
            if (chunk.type !== "tool-call") {
              return;
            }
            const payload = chunk.payload;
            if (streamed.has(payload.toolCallId)) {
              return;
            }
            streamed.add(payload.toolCallId);
            options.onEvent(
              toolCallLine({ toolName: payload.toolName, args: payload.args }),
            );
          },
          // The model that reads forever is told, between its steps, that the
          // turn ends with a tool. Without this the turn is cut off by the
          // step limit, and a review that read everything and decided nothing
          // is a review without a verdict.
          //
          // A turn that ends on no tool at all — the work session's turn that
          // makes the change — is told the session's own words instead: see
          // `WORK_FEEDBACK` in `../session.js`.
          ...(options.finalTool === undefined && options.feedback === undefined
            ? {}
            : {
                onIterationComplete: (context: {
                  iteration: number;
                  toolCalls: { readonly name: string }[];
                }) => {
                  const final = options.finalTool;
                  if (
                    final !== undefined &&
                    context.toolCalls.some((call) => call.name === final)
                  ) {
                    finalToolCalled = true;
                    return undefined;
                  }
                  if (finalToolCalled) {
                    return undefined;
                  }
                  // What the model is told, and the step it is told it at: the
                  // verdict tool's own words, or the session's feedback.
                  const text =
                    final !== undefined
                      ? `You have read enough. Stop exploring and call the ${final} ` +
                        "tool now, with the verdict you reached and the findings you found."
                      : options.feedback?.text;
                  const afterSteps =
                    final !== undefined ? FINAL_TOOL_AFTER_STEPS : options.feedback?.afterSteps;
                  if (text === undefined || afterSteps === undefined) {
                    return undefined;
                  }
                  return context.iteration >= afterSteps ? { feedback: text } : undefined;
                },
              }),
        });
        logTurn(answer, options.onEvent, streamed);
        const usage = usageOf(answer);
        if (usage !== undefined) {
          onUsage?.(usage);
        }
        messages = [
          ...messages,
          {
            role: "assistant",
            ...(answer.finishReason === undefined ? {} : { stopReason: answer.finishReason }),
          },
        ];
      } catch (failure) {
        // A failed turn settles normally — the runner reads the failure off
        // the last assistant message.
        messages = [...messages, failedTurn(failure)];
      } finally {
        running = null;
      }
    },
    async abort(): Promise<void> {
      running?.abort();
    },
    dispose(): void {
      running?.abort();
    },
    get messages(): readonly TurnMessage[] {
      return messages;
    },
    get reference(): string | undefined {
      return reference;
    },
    /**
     * Move the session onto another model.
     *
     * The pool moves the session when a model's limit is gone, and the
     * conversation is kept: the new agent runs on the new model with the same
     * memory, so the turn that failed is the turn the new model sees.
     */
    async setModel(next: string): Promise<void> {
      agent = build(await resolveMastraModel(next));
      reference = next;
    },
  };
}

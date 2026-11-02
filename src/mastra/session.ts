/**
 * The session the Mastra agent works in.
 *
 * It is the runner's `AgentSession` — the seam the runner drives — with
 * Mastra's agent underneath: a prompt is a `generate`, an abort is an
 * `AbortController`, and the messages are the turns the session has had.
 *
 * The **failure** is the one thing that has to look like Pi's: a turn whose
 * model call failed settles, and the failure is on the last assistant message.
 * The runner reads the failure from there, so a Mastra run that failed says
 * the same thing a Pi run that failed says.
 */

import type { Agent } from "@mastra/core/agent";

import type { AgentSession, RunUsage, SessionFactory, TurnMessage } from "../session.js";
import type { ToolSpec } from "../tools.js";
import { createMastraAgent, systemPrompt } from "./agent.js";
import { logTurn } from "./log.js";
import { DEFAULT_MASTRA_MODEL, resolveMastraModel } from "./model.js";
import { skillDirectories } from "./skills.js";

/** The thread the run's turns are kept in. */
const THREAD = "afk-runner";

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
    const model = await resolveMastraModel(options.model ?? DEFAULT_MASTRA_MODEL);
    return createMastraSession({ ...options, ...sessionOptions, model });
  };
}

/** The model the agent runs on — Mastra's own shape. */
export type MastraModel = NonNullable<ConstructorParameters<typeof Agent>[0]["model"]>;

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
  /** Told what a turn cost, when the provider reported it. */
  readonly onUsage?: (usage: RunUsage) => void;
  /** Told what the agent is doing, as it does it. */
  readonly onEvent?: (line: string) => void;
}): Promise<AgentSession> {
  const { cwd, systemPromptSections, tools, onUsage, model } = options;
  const agent = createMastraAgent({
    cwd,
    name: "afk-runner",
    instructions: systemPrompt(systemPromptSections),
    model,
    tools: tools ?? [],
    skills: await skillDirectories({ cwd }),
  });

  let messages: TurnMessage[] = [];
  let running: AbortController | null = null;

  return {
    async prompt(text: string): Promise<void> {
      const controller = new AbortController();
      running = controller;
      try {
        const answer = await agent.generate(text, {
          abortSignal: controller.signal,
          // The memory is what carries a turn into the next one: the work
          // session is one conversation.
          memory: { thread: THREAD, resource: cwd },
        });
        logTurn(answer, options.onEvent);
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
        // the last assistant message, exactly as it reads Pi's.
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
  };
}

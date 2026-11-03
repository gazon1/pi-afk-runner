/**
 * The Mastra agent the runner drives.
 *
 * The same system prompt, the same tools, the same skills, and a working
 * directory that is the worktree the run works in. The guard is Mastra's own
 * hook over the runner's policy.
 */

import { Agent } from "@mastra/core/agent";
import { InMemoryStore } from "@mastra/core/storage";
import { LocalFilesystem, LocalSandbox, Workspace } from "@mastra/core/workspace";
import { Memory } from "@mastra/memory";
import { TokenLimiter, ToolCallFilter } from "@mastra/core/processors";

import type { AnyToolSpec } from "../tools.js";
import { guardWorkspace } from "./guard.js";
import { toMastraTools } from "./tools.js";

/**
 * The system prompt the agent gets.
 *
 * The runner's rules come as named sections; Mastra has one system message,
 * so the sections become its parts. The rules stay in the **system prompt**:
 * the contract says the untrusted input is a rule and never a user turn.
 */
export function systemPrompt(sections: Readonly<Record<string, string>>): string {
  return Object.entries(sections)
    .map(([name, text]) => `## ${name}\n\n${text}`)
    .join("\n\n");
}

/** What the agent is made of. */
export interface MastraAgentOptions {
  /** The worktree the agent works in. */
  readonly cwd: string;
  /** The agent's name. */
  readonly name: string;
  /** The system prompt. */
  readonly instructions: string;
  /** The model the agent runs on. */
  readonly model: ConstructorParameters<typeof Agent>[0]["model"];
  /** The runner's tools. */
  readonly tools: readonly AnyToolSpec[];
  /** The skill directories the agent carries. */
  readonly skills: readonly string[];
  /**
   * The memory the agent keeps.
   *
   * The memory is what carries a turn into the next one. It is the session's,
   * not the agent's: a session that moves onto another model builds a new
   * agent and keeps this one, so the conversation is not lost by the move.
   */
  readonly memory?: Memory;
  /** The token budget the conversation is kept inside. Defaults to 150000. */
  readonly tokenLimit?: number;
}

/**
 * The token budget the conversation is kept inside.
 *
 * The limiter trims the **oldest** messages first, and the issue's own data is
 * the oldest thing in the conversation: a budget of fifty thousand tokens is
 * a couple of file reads, and the contract the work is judged against is what
 * it throws away. The models the runner uses carry two hundred thousand
 * tokens of context, and this leaves room for the answer.
 */
const DEFAULT_TOKEN_LIMIT = 150_000;

/**
 * The agent.
 *
 * The workspace is the worktree: the agent reads the files, writes them and
 * runs the commands there — the tree the run works in. The guard is installed
 * on it, so the denied paths and commands are refused before they run.
 */
export function createMastraAgent(options: MastraAgentOptions): Agent {
  const workspace = new Workspace({
    id: "afk-runner-worktree",
    name: "the worktree",
    filesystem: new LocalFilesystem({ basePath: options.cwd }),
    sandbox: new LocalSandbox({
      id: "afk-runner-sandbox",
      workingDirectory: options.cwd,
    }),
  });
  guardWorkspace(workspace);

  return new Agent({
    id: options.name,
    name: options.name,
    instructions: options.instructions,
    model: options.model,
    tools: toMastraTools(options.tools),
    workspace,
    skills: [...options.skills],
    inputProcessors: [
      new TokenLimiter(options.tokenLimit ?? DEFAULT_TOKEN_LIMIT),
      new ToolCallFilter({ filterAfterToolSteps: 2 }),
    ],
    // The memory is what carries a turn into the next one: the work session is
    // one conversation, and each prompt sees what the prompts before it said.
    memory: options.memory ?? new Memory({ storage: new InMemoryStore() }),
  });
}

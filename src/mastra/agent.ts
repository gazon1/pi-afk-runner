/**
 * The Mastra agent the runner drives.
 *
 * It is the same agent the Pi session makes: the same system prompt, the same
 * tools, the same skills, and a working directory that is the worktree the
 * run works in. What is different is the engine underneath — and the guard,
 * which is Mastra's own hook over the same policy.
 */

import { Agent } from "@mastra/core/agent";
import { InMemoryStore } from "@mastra/core/storage";
import { LocalFilesystem, LocalSandbox, Workspace } from "@mastra/core/workspace";
import { Memory } from "@mastra/memory";

import type { AnyToolSpec } from "../tools.js";
import { guardWorkspace } from "./guard.js";
import { toMastraTools } from "./tools.js";

/**
 * The system prompt the agent gets.
 *
 * Pi puts the runner's rules into named sections of its own prompt; Mastra
 * has one system message, so the sections become its parts. The rules are the
 * runner's own — the same text the Pi engine sends — and they stay in the
 * **system prompt**: the contract says the untrusted input is a rule and
 * never a user turn.
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
}

/**
 * The agent.
 *
 * The workspace is the worktree: the agent reads the files, writes them and
 * runs the commands there — the same tree the Pi session's own tools work in.
 * The guard is installed on it, so the denied paths and commands are refused
 * before they run.
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
    // The memory is what carries a turn into the next one: the work session is
    // one conversation, and each prompt sees what the prompts before it said.
    memory: new Memory({ storage: new InMemoryStore() }),
  });
}

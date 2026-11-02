/**
 * The guard, on Mastra.
 *
 * The guard is a hook on the workspace: `beforeToolCall` sees the tool and
 * what it was called with before the call runs.
 *
 * The **policy** is not written here. It is `GUARD_POLICY` from `src/guard.ts`
 * — the one place the rules live, so the refused paths and the refused
 * commands are decided once.
 *
 * The rules are wildcards: `*` matches anything including `/`, the match is
 * anchored, and the **last** matching rule wins. So `*.env` covers a `.env` at
 * any depth, and `*.env.example` after it keeps the template — which carries
 * no secret — readable.
 */

import type { Workspace } from "@mastra/core/workspace";

import { GUARD_POLICY } from "../guard.js";

/** A rule of the policy: allow, deny, or deny with a reason. */
type Rule = "allow" | "deny" | { readonly action: "deny"; readonly reason: string };

/** What a rule says about a value. */
interface Verdict {
  readonly denied: boolean;
  readonly reason: string;
}

/**
 * The policy's rules for the paths, in the order they are written.
 *
 * The last matching rule wins, so the order is the policy: `*.env.example`
 * comes after `*.env.*` and undoes it for the template.
 */
const PATH_RULES = GUARD_POLICY.path as Readonly<Record<string, Rule>>;

/** The policy's rules for the shell commands, in the order they are written. */
const BASH_RULES = GUARD_POLICY.bash as Readonly<Record<string, Rule>>;

/**
 * Whether a value matches a wildcard pattern.
 *
 * The pattern is anchored and `*` stands for anything, `/` included — the
 * guard's own wildcards, not path prefixes.
 */
export function matchesPattern(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

/** The rules' verdict on a value: the last matching rule wins. */
function decide(rules: Readonly<Record<string, Rule>>, value: string): Verdict {
  let denied = false;
  let reason = "";
  for (const [pattern, rule] of Object.entries(rules)) {
    if (!matchesPattern(pattern, value)) {
      continue;
    }
    if (rule === "deny") {
      denied = true;
      reason = "";
    } else if (rule === "allow") {
      denied = false;
      reason = "";
    } else {
      denied = true;
      reason = rule.reason;
    }
  }
  return { denied, reason };
}

/** A string field of the call's input, when the call carries one. */
function stringField(input: unknown, name: string): string | undefined {
  if (typeof input !== "object" || input === null || !(name in input)) {
    return undefined;
  }
  const value = (input as Record<string, unknown>)[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * Why the guard refuses this call, or null when it does not.
 *
 * The call is judged by what it carries: a path is judged by the path rules, a
 * command by the command rules. The tool's name does not matter — a call that
 * reads a `.env` is refused whatever it is called.
 */
export function denyReason(input: unknown): string | null {
  const path = stringField(input, "path");
  if (path !== undefined) {
    const verdict = decide(PATH_RULES, path);
    if (verdict.denied) {
      return `Refused: ${path} is not a file the agent may read or write.`;
    }
  }
  const command = stringField(input, "command");
  if (command !== undefined) {
    const verdict = decide(BASH_RULES, command);
    if (verdict.denied) {
      return verdict.reason === ""
        ? `Refused: ${command} is not a command the agent may run.`
        : `Refused: ${command}. ${verdict.reason}`;
    }
  }
  return null;
}

/**
 * The guard, installed on the workspace.
 *
 * A refused call is a refusal the model reads: the workspace returns the
 * reason as the call's result and the call itself does not run.
 */
export function guardWorkspace(workspace: Workspace): void {
  workspace.setToolsConfig({
    hooks: {
      beforeToolCall: async ({ input }) => {
        const reason = denyReason(input);
        return reason === null ? undefined : { proceed: false, output: reason };
      },
    },
  });
}

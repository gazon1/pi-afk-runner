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

import {
  GUARD_POLICY,
  policyVerdict,
  runsATestSuite,
  runsTooLong,
  timeoutAboveCeiling,
} from "../guard.js";

/** A string field of the call's input, when the call carries one. */
function stringField(input: unknown, name: string): string | undefined {
  if (typeof input !== "object" || input === null || !(name in input)) {
    return undefined;
  }
  const value = (input as Record<string, unknown>)[name];
  return typeof value === "string" ? value : undefined;
}

/** A number field of the call's input, when the call carries one. */
function numberField(input: unknown, name: string): number | undefined {
  if (typeof input !== "object" || input === null || !(name in input)) {
    return undefined;
  }
  const value = (input as Record<string, unknown>)[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
    const verdict = policyVerdict(GUARD_POLICY.path, path);
    if (verdict.denied) {
      return `Refused: ${path} is not a file the agent may read or write.`;
    }
  }
  const command = stringField(input, "command");
  if (command !== undefined) {
    // A test suite is a gate, and this run does not gate the tree. The suite
    // is refused by the program it starts, so the searches that read how the
    // target gates itself still go through.
    if (runsATestSuite(command)) {
      return `Refused: ${command}. ${GUARD_POLICY.program.reason}`;
    }
    // A command may not ask to run for longer than the ceiling, however it
    // asks: through the tool's own timeout or through the shell's `timeout`.
    // A run that waits is a run that does nothing else.
    const ceiling = GUARD_POLICY.duration.ceilingSeconds;
    const seconds = numberField(input, "timeout");
    if (seconds !== undefined && timeoutAboveCeiling(seconds)) {
      return (
        `Refused: ${command} asks for ${seconds}s, and this run allows ` +
        `${ceiling}s at most. ${GUARD_POLICY.duration.reason}`
      );
    }
    if (runsTooLong(command)) {
      return (
        `Refused: ${command} asks to run longer than this run allows ` +
        `(${ceiling}s at most). ${GUARD_POLICY.duration.reason}`
      );
    }
    const verdict = policyVerdict(GUARD_POLICY.bash, command);
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

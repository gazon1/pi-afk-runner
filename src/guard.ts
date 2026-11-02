/**
 * The guard the work session runs under.
 *
 * What is ours is the **policy** — the files nobody hands to an agent, and the
 * one shell command that would file a leftover behind the runner's back. The
 * mechanism is the engine's: Mastra's own hook over the workspace's tool calls
 * reads this policy (see `src/mastra/guard.ts`), and the runner's own commit
 * path reads it too (see `src/runner.ts`).
 *
 * The policy is one object, and it is here, so that the two places that read
 * it cannot refuse different things.
 */

/**
 * What the work session may do: everything, except the files nobody hands to
 * an agent.
 *
 * The patterns are wildcards, not path prefixes: `*` matches anything
 * including `/`, the match is anchored, and the **last** matching entry wins.
 * So `*.env` covers a `.env` at any depth, and `*.env.example` after it keeps
 * the template — which carries no secret — readable.
 *
 * The `bash` entry is not decoration. A permissive `*` with no `bash` policy
 * makes the guard report a configuration issue, and the shell would silently
 * inherit the allow. `path` covers reads and writes alike, and a deny there
 * cannot be undone by a per-tool allow.
 *
 * The one denied command is `gh issue create`. The leftovers a run files go
 * through the runner's own tool, which holds the bounds on the queue — three a
 * run, and never a second copy of something already open — and a shell command
 * is a way around those bounds. The reason says what to do instead, so the
 * agent is not left guessing.
 *
 * The build is denied too. A run that compiles spends its minutes in a Gradle
 * daemon and its tokens in a build log, and the tree that is pushed is the
 * tree the agent left either way — the repository's own CI judges it. The
 * agent reads the code and writes the change; it does not build it. Every way
 * the target builds or checks is refused: the wrappers, the script, and the
 * recipes.
 */
export const GUARD_POLICY = {
  "*": "allow",
  bash: {
    "*": "allow",
    "gh issue create*": {
      action: "deny",
      reason:
        "File a leftover with the `agent_leftover` tool — it holds the bounds on the queue.",
    },
    "*./gw*": {
      action: "deny",
      reason: "Do not build: this run does not compile. Change the code and stop.",
    },
    "*./gradlew*": {
      action: "deny",
      reason: "Do not build: this run does not compile. Change the code and stop.",
    },
    "*./check.sh*": {
      action: "deny",
      reason: "Do not run the checks: this run does not gate the tree. Change the code and stop.",
    },
    "*just build*": {
      action: "deny",
      reason: "Do not build: this run does not compile. Change the code and stop.",
    },
    "*just check*": {
      action: "deny",
      reason: "Do not run the checks: this run does not gate the tree. Change the code and stop.",
    },
    "*just test*": {
      action: "deny",
      reason: "Do not run the checks: this run does not gate the tree. Change the code and stop.",
    },
    "*just lint*": {
      action: "deny",
      reason: "Do not run the checks: this run does not gate the tree. Change the code and stop.",
    },
    "*just detekt*": {
      action: "deny",
      reason: "Do not run the checks: this run does not gate the tree. Change the code and stop.",
    },
    "*just gate*": {
      action: "deny",
      reason: "Do not run the checks: this run does not gate the tree. Change the code and stop.",
    },
    "*just tcheck-evals*": {
      action: "deny",
      reason: "Do not run the checks: this run does not gate the tree. Change the code and stop.",
    },
    "*just docs-audit*": {
      action: "deny",
      reason: "Do not run the checks: this run does not gate the tree. Change the code and stop.",
    },
  },
  path: {
    "*.env": "deny",
    "*.env.*": "deny",
    "*.env.example": "allow",
    "*.pem": "deny",
  },
} as const;

/**
 * A rule of the policy: allow, deny, or deny with a reason.
 */
export type PolicyRule = "allow" | "deny" | { readonly action: "deny"; readonly reason: string };

/**
 * Whether a value matches a wildcard pattern.
 *
 * The pattern is anchored and `*` stands for anything, `/` included — the
 * guard's own wildcards, not path prefixes. So `*.env` covers a `.env` at any
 * depth.
 */
export function matchesPattern(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

/** What the rules say about a value. */
export interface PolicyVerdict {
  /** Whether the value is refused. */
  readonly denied: boolean;
  /** Why it is refused, when the rule says. */
  readonly reason: string;
}

/**
 * The rules' verdict on a value: the last matching rule wins.
 *
 * The order the rules are written in is the policy, so `*.env.example` after
 * `*.env.*` undoes it for the template — which carries no secret.
 */
export function policyVerdict(
  rules: Readonly<Record<string, PolicyRule>>,
  value: string,
): PolicyVerdict {
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

/**
 * Whether the policy refuses a path.
 *
 * The paths the policy is about are the repository's own — relative to its
 * root. Everyone who asks the policy asks it here: the guard, on a read, and
 * the pack, which hands files to the model the way a read does.
 */
export function isProtectedPath(path: string): boolean {
  const rules = GUARD_POLICY.path as Readonly<Record<string, PolicyRule>>;
  return policyVerdict(rules, path).denied;
}

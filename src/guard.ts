/**
 * The guard the work session runs under.
 *
 * The mechanism is `@gotgenes/pi-permission-system`'s: it gates every tool call
 * and reads its policy from a file. What is ours is the **policy** — the files
 * nobody hands to an agent — and the fact that it is installed at all: the work
 * session discovers the host's extensions (that is where the model providers are)
 * and drops only this package's own, so the guard is named explicitly rather than
 * left to discovery.
 *
 * The policy is a file because a file is the only way the guard accepts one.
 * It is written into the session's **project** scope, `<cwd>/.pi/...`, and not
 * into the agent directory: the agent directory is the host's, it is
 * process-wide, and a policy written there would govern every session the
 * human has open. The worktree is thrown away with the run.
 *
 * A file inside the worktree would otherwise land in the pull request — the
 * runner commits the worktree with `git add -A` — so the one this module writes
 * is excluded through git's own local metadata. That exclude is not the target
 * repository's `.gitignore`: it is nobody's commit, and it is not pushed. A
 * policy the target repository already carries is not written at all.
 */

import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runGit, type GitRunner } from "./git.js";

/** The package whose extension does the gating. */
export const GUARD_PACKAGE = "@gotgenes/pi-permission-system";

/**
 * What the work session may do: everything, except the files nobody hands to
 * an agent.
 *
 * The patterns are the guard's own wildcards, not path prefixes: `*` matches
 * anything including `/`, the match is anchored, and the **last** matching entry
 * wins. So `*.env` covers a `.env` at any depth, and `*.env.example` after it
 * keeps the template — which carries no secret — readable.
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
  },
  path: {
    "*.env": "deny",
    "*.env.*": "deny",
    "*.env.example": "allow",
    "*.pem": "deny",
  },
} as const;

/** Where the policy lives under the session's working directory. */
export const GUARD_POLICY_PATH = join(
  ".pi",
  "extensions",
  "pi-permission-system",
  "config.json",
);

/** The line that keeps the policy directory out of the worktree's commits. */
const GUARD_EXCLUDE = "/.pi";

/**
 * The path of the guard's extension factory.
 *
 * The package's export map points at its **service** module, and the factory —
 * the thing Pi activates — is the sibling `index.ts`, which the export map does
 * not expose. Pi's own loader compiles TypeScript from a path, so this is a
 * path and not an import.
 */
export function guardExtensionPath(): string {
  const service = new URL(import.meta.resolve(GUARD_PACKAGE));
  return fileURLToPath(new URL("index.ts", service));
}

/**
 * Write the policy where the guard will read it, and keep it out of git.
 *
 * **A policy already there is left alone.** A repository that commits
 * `.pi/extensions/pi-permission-system/config.json` has said what its policy is,
 * and the project scope is the stronger one anyway. Writing over it would be
 * worse than ignoring it: git's exclude hides only untracked files, so the
 * modification would be staged by the runner's own `git add -A` and pushed in
 * the pull request — the target's policy quietly replaced by ours.
 *
 * Idempotent for the files it does write: the review session runs in the same
 * worktree as the work session, and the second call finds the file and the
 * exclude already there.
 */
export async function installGuardPolicy(options: {
  readonly cwd: string;
  readonly git?: GitRunner;
}): Promise<void> {
  const policy = join(options.cwd, GUARD_POLICY_PATH);
  if (existsSync(policy)) {
    return;
  }
  await mkdir(dirname(policy), { recursive: true });
  await writeFile(
    policy,
    `${JSON.stringify({ permission: GUARD_POLICY }, null, 2)}\n`,
    "utf8",
  );
  await excludeFromGit(options.cwd, options.git ?? runGit);
}

/**
 * Add the policy directory to the repository's local exclude file.
 *
 * `git rev-parse --git-path` is asked rather than the path being composed: in a
 * linked worktree the exclude lives in the repository's common git directory,
 * not in the worktree's own.
 */
async function excludeFromGit(cwd: string, git: GitRunner): Promise<void> {
  const reported = (await git(["rev-parse", "--git-path", "info/exclude"], { cwd })).trim();
  const exclude = isAbsolute(reported) ? reported : join(cwd, reported);
  const current = await readFile(exclude, "utf8").catch(() => "");
  if (current.split("\n").some((line) => line.trim() === GUARD_EXCLUDE)) {
    return;
  }
  await mkdir(dirname(exclude), { recursive: true });
  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  await appendFile(exclude, `${separator}${GUARD_EXCLUDE}\n`, "utf8");
}

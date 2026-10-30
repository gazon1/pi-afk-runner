/**
 * The environment a fixture's git commands run in, and the check that they stayed there.
 *
 * Git exports `GIT_DIR` (and `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR`)
 * for the hooks it runs. A fixture that creates a repository *inside a hook*
 * inherits them, and every git command it runs then means something else:
 *
 *  - `git init` reinitialises the repository the hook is about, not the
 *    fixture's own directory;
 *  - `git add -A` stages the fixture's directory against *that* repository's
 *    index, so every tracked file of the developer's project looks deleted;
 *  - `git commit` writes the fixture's tree onto the developer's branch.
 *
 * That is not a hypothetical. On 2026-10-23 a fixture in the repository this
 * runner operates on committed a 12124-file deletion into the repository it ran
 * in, the same tree reached the remote `main`, and the shared configuration
 * ended up carrying an `sshCommand` that pointed at a port and an identity file
 * that do not exist — after which every fetch and every push in every worktree
 * of that repository failed.
 *
 * The fixtures therefore run their git commands with those names removed, and
 * with a ceiling that stops git from walking up past the fixture's own tree.
 * The assertion below is the second half of the contract: the fixture's
 * repository is its own repository, and the test says so when it is not.
 *
 * The third half is the identity. Git refuses a commit it cannot attribute
 * ("Author identity unknown", exit 128), and where that identity comes from is
 * the environment: the developer's global `~/.gitconfig` on a workstation, and
 * nothing at all on a CI runner. A fixture that commits under the sandbox
 * therefore worked on the machine that wrote it and failed in CI. The sandbox
 * carries the identity itself, and because git reads these names before any
 * configuration file, the commit is attributed to the fixture rather than to the
 * developer, and no configuration file is read or written.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * The variables git exports for a hook. A command that means "this repository"
 * must not inherit them.
 */
export const INHERITED_FROM_HOOK = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
] as const;

/** The identity a commit made inside the sandbox carries. */
export const SANDBOX_IDENTITY = {
  GIT_AUTHOR_NAME: "Sandbox Fixture",
  GIT_AUTHOR_EMAIL: "sandbox@example.com",
  GIT_COMMITTER_NAME: "Sandbox Fixture",
  GIT_COMMITTER_EMAIL: "sandbox@example.com",
} as const;

/**
 * An environment in which git means the repository it discovers.
 *
 * The hook's variables are removed; everything else is inherited, because a test
 * that cannot reach the network or the user's configuration is a test that
 * passes for the wrong reason.
 */
export function treeEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of INHERITED_FROM_HOOK) {
    delete env[name];
  }
  return env;
}

/**
 * `treeEnv`, the upward walk stops at `root`, and commits can be made.
 *
 * The ceiling is the second half of the contract: a command that does not find
 * a repository of its own fails instead of finding one further up. The fixtures
 * live *inside* the ceiling directory, so the ceiling is the boundary the walk
 * must not pass — git stops when the next directory it would enter is the
 * ceiling itself.
 */
export function sandboxEnv(
  root: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = treeEnv(base);
  env.GIT_CEILING_DIRECTORIES = root;
  Object.assign(env, SANDBOX_IDENTITY);
  return env;
}

/** A git command that failed, with the reason git gave in the message. */
export class GitCommandFailed extends Error {
  readonly exitCode: number;
  readonly stderr: string;

  constructor(exitCode: number, command: string, stderr: string) {
    const detail = stderr.trim();
    super(
      detail.length > 0
        ? `git ${command} failed (${exitCode}): ${detail}`
        : `git ${command} failed (${exitCode}) and said nothing`,
    );
    this.name = "GitCommandFailed";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export interface GitOptions {
  /** The directory the command runs in. */
  readonly cwd: string;
  /** The environment it runs in. Use `sandboxEnv` for a fixture. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * A git command that must succeed. Its standard output is returned; its
 * standard error is in the message when it fails, because a reader of a red test
 * run sees "Command failed" and nothing else.
 */
export async function git(args: readonly string[], options: GitOptions): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      encoding: "utf8",
    });
    return stdout;
  } catch (failure) {
    const error = failure as { code?: number; stderr?: string };
    throw new GitCommandFailed(
      typeof error.code === "number" ? error.code : 1,
      args.join(" "),
      error.stderr ?? "",
    );
  }
}

/** A git command that must succeed, with its standard output trimmed. */
export async function gitOutput(
  args: readonly string[],
  options: GitOptions,
): Promise<string> {
  return (await git(args, options)).trim();
}

/**
 * The repository is the fixture's own, not one further up.
 *
 * This is the assertion that catches the failure the sandbox exists to prevent:
 * a fixture that ran against somebody else's repository.
 */
export async function assertOwnRepository(
  repo: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const toplevel = await gitOutput(["rev-parse", "--show-toplevel"], { cwd: repo, env });
  if (toplevel === "") {
    throw new Error(`${repo} is not inside a git repository`);
  }
  if (toplevel !== repo) {
    throw new Error(
      `the fixture repository is not its own repository: ${repo} resolves to ${toplevel}`,
    );
  }
}

/** A fixture repository, its remote, and the environment its git commands run in. */
export interface FixtureRepository {
  /** The directory that contains the fixture. It is the sandbox's ceiling. */
  readonly root: string;
  /** The working repository. */
  readonly repo: string;
  /** The bare repository the working repository pushes to. */
  readonly remote: string;
  /** The environment every git command in this fixture runs in. */
  readonly env: NodeJS.ProcessEnv;
  /** Remove the fixture and everything in it. */
  dispose(): Promise<void>;
}

/**
 * A fixture repository with a remote, one commit, and an environment that
 * cannot reach past the fixture.
 *
 * The temporary directory honours `TMPDIR`, so a machine whose `/tmp` is small
 * can point it somewhere with room.
 */
export async function createFixtureRepository(
  options: { readonly files?: Readonly<Record<string, string>> } = {},
): Promise<FixtureRepository> {
  const root = await mkdtemp(join(tmpdir(), "afk-runner-"));
  const env = sandboxEnv(root);
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");

  await mkdir(repo, { recursive: true });
  await git(["init", "-q", "-b", "main"], { cwd: repo, env });
  await git(["init", "-q", "--bare", remote], { cwd: root, env });
  await git(["remote", "add", "origin", remote], { cwd: repo, env });

  await writeFile(join(repo, "README.md"), "# the fixture\n", "utf8");
  for (const [name, content] of Object.entries(options.files ?? {})) {
    await writeFile(join(repo, name), content, "utf8");
  }
  await git(["add", "-A"], { cwd: repo, env });
  await git(["commit", "-q", "-m", "the fixture"], { cwd: repo, env });

  // The runner takes its worktree from `origin/main`, so the fixture's main
  // branch has to be on the remote before anything else asks for it.
  await git(["push", "-u", "origin", "main"], { cwd: repo, env });

  await assertOwnRepository(repo, env);

  return {
    root,
    repo,
    remote,
    env,
    async dispose(): Promise<void> {
      await rm(root, { recursive: true, force: true });
    },
  };
}

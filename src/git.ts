/**
 * Every git call the runner makes, in one place.
 *
 * The claim is the reason this file exists at all.
 *
 * A claim has to be **exclusive**: at most one runner may work an issue. The
 * issue's label cannot do that, because adding a label is idempotent — a
 * second add exits 0, so both runners "win" it. The claim is therefore a
 * **ref on the remote**, and a ref creation is exclusive in git: creating a tag
 * is never a fast-forward, and git refuses to update an existing tag without
 * `--force`.
 *
 * There is one hole in that, and it is the whole subtlety of this file. Git
 * answers "Everything up-to-date" and exits **0** when the ref already points
 * at the *same* object — so a plain push of the base commit is not exclusive
 * either. The claim therefore carries a **nonce**, which makes its object
 * unique, and the second creation is rejected no matter what.
 *
 * The claim is an **annotated tag** rather than a branch, for two reasons: a
 * tag's message is where the nonce lives, and a tag records the commit it was
 * taken from — the base the reclaim path needs, which the issue's own metadata
 * cannot supply, because `origin/main` has moved on by then.
 *
 * The tag object is written with `git mktag` rather than `git tag -a`, so that
 * **no local ref is created**. The object is what gets pushed; the name lives
 * only on the remote, and the runner's own checkout is left as it found it.
 *
 * ## The shared checkout
 *
 * A sweep works several issues at once, and its workers **share one
 * checkout**: one `.git`, one set of refs, one `FETCH_HEAD`, one worktree
 * registry. A git command that two workers run at the same time has to be
 * safe at the same time.
 *
 * Every git command in this file is therefore one of two kinds, and which
 * kind it is is written where the command is:
 *
 * - **one at a time** — it goes through a queue, because two of them at once
 *   make one of them fail. The **fetches** go through the fetch queue: every
 *   fetch writes the checkout's `FETCH_HEAD`, and it updates the
 *   remote-tracking refs its refspec maps to, and git locks both. The
 *   **worktree commands** go through the worktree queue: `git worktree add`
 *   writes the registration before the directory exists, and a `prune` in
 *   that window deletes it.
 * - **safe to run at the same time** — and the reason is written at the
 *   command. The push of the work branch is the one that is not obvious: it
 *   writes one ref of the remote, one that belongs to its own issue, and it
 *   writes nothing in the checkout at all.
 *
 * The commands the runner runs **inside a worktree** — `add`, `commit`,
 * `status`, `reset`, `clean`, `checkout` — are safe at the same time for the
 * same reasons: the index and the `HEAD` they touch are the worktree's own,
 * the branch they move is the issue's own, and the objects they write are
 * content-addressed.
 *
 * The garbage collection git starts by itself is a third thing, and it is
 * off: see `runGitWithTimeout`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { simpleGit } from "simple-git";

import { KILL_GRACE_MS, withHardStop } from "./bound.js";

/** Who the claim is attributed to. Part of the tag object's identity. */
export const CLAIM_TAGGER = {
  name: "afk-runner",
  email: "afk-runner@localhost",
} as const;

/** A command to run, and where. */
export interface CommandSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** Written to the command's standard input, and its standard input closed. */
  readonly input?: string;
  /** Kill the child and reject after this many milliseconds. */
  readonly timeoutMs?: number;
  /**
   * How much of the command's output is kept.
   *
   * The tail is kept and the rest is dropped: a command that fails says a
   * great deal, and a runner that holds all of it holds megabytes of a
   * compiler's findings in memory and writes them into a record nobody reads
   * whole.
   */
  readonly maxOutputBytes?: number;
  /**
   * Where the command's whole output is written, when it is written anywhere.
   *
   * The tail the runner keeps is the evidence a reader needs; this is the rest
   * of it. A runner that is given a file writes the command's standard output
   * and its standard error there, whole, as they come — and its own memory
   * still holds only the tail.
   */
  readonly outputFile?: string;
  /**
   * The environment the command runs with, over the runner's own.
   *
   * A gate needs the tools of the checkout it runs in: the repository's gate
   * CLI lives in a venv of that checkout's own, and a gate that cannot find
   * it is a gate that never got to answer.
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Whether a timeout kills the command's whole tree, not just the command.
   *
   * The command leads a process group of its own, and the group is what the
   * timeout kills: a build the command started is the work that must stop
   * with it.
   */
  readonly killGroup?: boolean;
}

/** Runs a command and returns its standard output. */
export type CommandRunner = (spec: CommandSpec) => Promise<string>;

/** Runs a git command and returns its standard output. */
export type GitRunner = (
  args: readonly string[],
  options: { readonly cwd: string; readonly input?: string },
) => Promise<string>;

/**
 * A command that failed, with what it said.
 *
 * Both streams are kept. A command whose **exit code is its answer** — the
 * repository's own CI verdict tool is one — prints what it concluded and
 * then exits with that conclusion, so the printed output is the answer and
 * the error has to carry it.
 */
export class CommandFailed extends Error {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(
    exitCode: number,
    command: string,
    args: readonly string[],
    stdout: string,
    stderr: string,
  ) {
    const detail = stderr.trim();
    super(
      detail.length > 0
        ? `${command} ${args.join(" ")} failed (${exitCode}): ${detail}`
        : `${command} ${args.join(" ")} failed (${exitCode}) and said nothing`,
    );
    this.name = "CommandFailed";
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/**
 * The bound a command gets.
 *
 * Fifteen minutes: long enough for a slow gate, short enough that a command
 * that hangs on a black-holed network does not hold the run for ever.
 */
export const COMMAND_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * A command that was killed before it finished.
 *
 * It is a failure of its own, not a failure of the command: the command never
 * got to answer, so it has no exit code. What it printed before it was killed
 * is kept — that output is the only evidence there is.
 */
export class CommandTimedOut extends Error {
  readonly stdout: string;
  readonly stderr: string;
  readonly timeoutMs: number;

  constructor(
    timeoutMs: number,
    command: string,
    args: readonly string[],
    stdout: string,
    stderr: string,
  ) {
    super(`command timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`);
    this.name = "CommandTimedOut";
    this.stdout = stdout;
    this.stderr = stderr;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * The tail of a command's output, and nothing before it.
 *
 * The chunks are dropped from the front as the output grows, so the memory a
 * command's output takes is bounded by the limit rather than by how much the
 * command had to say.
 */
class OutputTail {
  private chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.limit && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      this.size -= dropped?.length ?? 0;
    }
    if (this.size > this.limit && this.chunks.length === 1) {
      const only = this.chunks[0] ?? Buffer.alloc(0);
      this.chunks = [only.subarray(only.length - this.limit)];
      this.size = this.limit;
    }
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

/**
 * The options every git the runner runs carries.
 *
 * The garbage collection git starts by itself is **off**. `git fetch`, `git
 * commit` and `git push` may start a collection on their own, and in a
 * checkout that several workers share a second collection collides with the
 * first: git then says "failed to run maintenance" and the command fails —
 * and a sweep that fails on a collection nobody asked for is a sweep that
 * fails.
 *
 * The runner never needs the collection: the checkout is the user's, and a
 * collection the runner did not ask for is a collection the runner did not
 * get to judge.
 */
const NO_AUTO_COLLECTION = ["-c", "gc.auto=0", "-c", "maintenance.auto=0"] as const;

/**
 * Runs the real `git`, through simple-git.
 *
 * The runner's git is the real git: a claim is a ref, a push is a push, and a
 * claim that is not exclusive is a claim two runners hold. simple-git runs the
 * binary, feeds it and reads it; what the commands **mean** is this file's.
 *
 * Every option is spelled out in full: simple-git puts
 * `GIT_TEST_DISALLOW_ABBREVIATED_OPTIONS` into the child, and a git that is
 * told to refuse abbreviations refuses a short one.
 */
export const runGit: GitRunner = (args, options) =>
  runGitWithTimeout(args, options, COMMAND_TIMEOUT_MS);

/**
 * What a git call said about itself.
 *
 * The shape simple-git hands over, named here so that the failure can be built
 * from it without a git in sight.
 */
export interface GitCallResult {
  /** The git's own answer, or `null` when it was killed before it answered. */
  readonly exitCode: number | null;
  readonly stdOut: readonly Buffer[];
  readonly stdErr: readonly Buffer[];
}

/**
 * The failure a git call raises, from what the call said about itself.
 *
 * simple-git wraps the error it is given into one of its own, and the code
 * above this one knows the runner's errors — a claim that was refused is a
 * `CommandFailed`, and that is what says so. The failure is built here and
 * thrown as it is.
 *
 * A command that answered has no failure to report, and that is what `undefined`
 * means here: the handler is called for every task, the successful ones too.
 */
export function gitFailure(
  error: Buffer | Error | undefined,
  result: GitCallResult,
  context: {
    /** Whether the bound was spent and the git was asked to stop. */
    readonly aborted: boolean;
    readonly timeoutMs: number;
    readonly args: readonly string[];
  },
): Error | undefined {
  if (error === undefined && result.exitCode === 0) {
    return undefined;
  }
  const stdout = Buffer.concat(result.stdOut).toString("utf8");
  const stderr = Buffer.concat(result.stdErr).toString("utf8");
  if (context.aborted) {
    // The bound was spent and the git was killed before it answered.
    return new CommandTimedOut(context.timeoutMs, "git", context.args, stdout, stderr);
  }
  if (result.exitCode !== null && result.exitCode !== undefined && result.exitCode !== 0) {
    // Git itself refused: the exit code is its answer, and what it said on the
    // error stream is the reason.
    return new CommandFailed(result.exitCode, "git", context.args, stdout, stderr);
  }
  // The process failed before it could answer — it is not there, or it was
  // killed. Its own error says what happened to it.
  return error instanceof Error ? error : new CommandFailed(1, "git", context.args, stdout, stderr);
}

/**
 * Runs the real `git`, with the bound every command gets.
 *
 * The bound is ours as well as the child's: simple-git asks the child to stop
 * and waits for it, and a child that ignores the request would keep the call
 * open — and the run waiting on it — for as long as it likes. The run stops
 * waiting whether the child does or not.
 */
export async function runGitWithTimeout(
  args: readonly string[],
  options: { readonly cwd: string; readonly input?: string },
  timeoutMs: number,
  killGraceMs: number = KILL_GRACE_MS,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // The failure the git call raised, kept here: simple-git wraps the error it
  // is given into one of its own, and what the caller catches has to be the
  // error this file wrote.
  let failure: Error | undefined;
  try {
    const git = simpleGit({
      baseDir: options.cwd,
      // The deadline is the runner's: a git that hangs must not hold a run for
      // ever, and a git that was killed has not answered.
      abort: controller.signal,
      // The whole environment, as the child git has always seen it: simple-git
      // keeps the `GIT_*` keys out of the child unless they are named, and
      // `GIT_CONFIG_COUNT` carries a credential in CI — a git that cannot see it
      // cannot authenticate.
      allowEnvironment: Object.keys(process.env),
      // The payload of a command that reads its input — `mktag`,
      // `update-ref --stdin`. A command that reads nothing gets an empty
      // payload, so its standard input is closed rather than left open.
      input: () => (options.input === undefined ? Buffer.alloc(0) : options.input),
      errors: (error, result) => {
        const raised = gitFailure(error, result, {
          aborted: controller.signal.aborted,
          timeoutMs,
          args,
        });
        failure = raised;
        return raised;
      },
    });
    return await withHardStop(git.raw([...NO_AUTO_COLLECTION, ...args]), {
      timeoutMs,
      killGraceMs,
      // The git was asked to stop and did not: the run stops waiting, and the
      // output of a git that never answered is empty.
      timeoutError: () => new CommandTimedOut(timeoutMs, "git", args, "", ""),
    });
  } catch (thrown) {
    if (failure !== undefined) {
      throw failure;
    }
    throw thrown;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Kill the command, and the tree it started when it leads one.
 *
 * A negative pid is a process group, so the group is what dies: a gate that
 * is killed half-way through takes its build with it. The command alone is
 * not enough — the build it started is the work that must stop, and it is
 * the build that writes into the worktree.
 */
function killTree(child: ChildProcess, group: boolean): void {
  if (group && child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch {
      // The group is gone already, or the command never led one.
    }
  }
  child.kill();
}

/**
 * Runs a command.
 *
 * The repository's own gates: `spawn` rather than `execFile`, because a gate
 * may have to write to the command's standard input, and `execFile` has no way
 * to write to it — the command would wait for input that never comes.
 */
export const runCommand: CommandRunner = (spec) =>
  new Promise<string>((resolve, reject) => {
    const timeoutMs = spec.timeoutMs ?? COMMAND_TIMEOUT_MS;
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      // The runner's own environment, with the caller's on top of it: a gate
      // that needs the tools of the checkout it runs in has to be able to
      // find them.
      ...(spec.env === undefined ? {} : { env: { ...process.env, ...spec.env } }),
      // The command leads its own process group, when the caller asks for it:
      // a gate that is killed half-way through must take its build with it,
      // or the build keeps writing into the worktree the runner restores and
      // pushes.
      detached: spec.killGroup === true,
    });
    const stdout = new OutputTail(spec.maxOutputBytes ?? Number.POSITIVE_INFINITY);
    const stderr = new OutputTail(spec.maxOutputBytes ?? Number.POSITIVE_INFINITY);
    // The whole output goes to the file, as it comes: the tail the runner
    // holds is the evidence a reader needs, and the file is where the rest of
    // it is.
    const sink =
      spec.outputFile === undefined
        ? null
        : createWriteStream(spec.outputFile, { flags: "w" });
    // The log is not the command's business: a file that cannot be written is
    // not a failure of the command that ran.
    sink?.on("error", () => {});
    const closeSink = async (): Promise<void> => {
      if (sink === null || sink.destroyed) {
        return;
      }
      // 'close' comes after the file is flushed and its handle is closed, and
      // it comes whether the stream ended or broke. The second is a bound and
      // not a hope: a flush that never finishes must not hold a gate's
      // timeout.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), 1000);
        sink.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        sink.end();
      });
    };
    const timer = setTimeout(() => {
      killTree(child, spec.killGroup === true);
      // The file is flushed before the failure is raised: the record names
      // the log, and the log has to be there when it does.
      void closeSink().then(() => {
        reject(
          new CommandTimedOut(
            timeoutMs,
            spec.command,
            spec.args,
            stdout.text(),
            stderr.text(),
          ),
        );
      });
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      sink?.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      sink?.write(chunk);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      void closeSink().then(() => reject(err));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      void closeSink().then(() => {
        if (code === 0) {
          resolve(stdout.text());
        } else {
          reject(
            new CommandFailed(code ?? 1, spec.command, spec.args, stdout.text(), stderr.text()),
          );
        }
      });
    });
    child.stdin.on("error", () => {
      // A command that exits before reading its input closes the pipe; that is
      // the command's business, not an error of ours.
    });
    child.stdin.end(spec.input ?? "");
  });

/** The name of the claim ref for an issue. */
export function claimRefName(issueNumber: number): string {
  return `afk-claim-issue-${issueNumber}`;
}

/** The full ref of the claim: an annotated tag on the remote. */
export function claimRef(issueNumber: number): string {
  return `refs/tags/${claimRefName(issueNumber)}`;
}

/**
 * The prefix every work branch carries.
 *
 * The branch's name and the pattern that recognises it are written here and
 * nowhere else. A name spelled in three places is three chances to disagree,
 * and the places that disagree are a removal guard that refuses the runner's
 * own worktrees — or removes somebody else's — and a merge pipeline that no
 * longer sees the branches it is meant to land.
 */
const WORK_BRANCH_PREFIX = "agent/";

/** The segment of the branch's name between the prefix and the issue number. */
const WORK_BRANCH_SEGMENT = "issue-";

/**
 * Literal text, safe to put inside a regular expression.
 *
 * The name is written once and interpolated into the pattern that recognises
 * it, so the parts of it that are not the issue number are escaped: a name
 * that carried a `.` would otherwise match a character it does not have, and
 * the guard would accept a branch that is not the runner's own.
 */
function regexLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The branch the work goes on. */
export function workBranch(issueNumber: number): string {
  return `${WORK_BRANCH_PREFIX}${WORK_BRANCH_SEGMENT}${issueNumber}`;
}

/**
 * The pattern that recognises a work branch.
 *
 * It answers for a branch's name and for the full ref git reports, because
 * the two callers see different things — the merge pipeline sees a pull
 * request's head, the removal guard sees `refs/heads/...` — and they ask the
 * same question: is this the runner's own branch?
 *
 * The issue number is the first group, so the merge pipeline reads the issue
 * out of the very match the guard uses to say yes.
 */
export const WORK_BRANCH_PATTERN = new RegExp(
  `^(?:refs/heads/)?${regexLiteral(WORK_BRANCH_PREFIX)}${regexLiteral(WORK_BRANCH_SEGMENT)}(\\d+)$`,
);

/**
 * Where an issue's worktree lives.
 *
 * One function, because four places need the answer — the runner's worktree
 * step, its review path, the reclaim that removes the worktree a dead run left,
 * and the live door that puts the worktree back after a run's cleanup — and a
 * name spelled out in four places is four chances to disagree.
 *
 * The door is the sharp edge of that. It restores the worktree the runner
 * made, so a name that changed on one side alone leaves the door restoring a
 * directory the run never used, and the chat it switched into stands in an
 * empty place.
 */
export function issueWorktreePath(worktreeRoot: string, issueNumber: number): string {
  return join(worktreeRoot, `issue-${issueNumber}`);
}

/**
 * The message of a claim.
 *
 * The nonce is in the message because the message is part of the tag object's
 * identity — and the identity is the whole mechanism. Two claims of the same
 * issue from the same base commit differ by their nonce, so their objects
 * differ, so the second creation is rejected rather than absorbed.
 */
export function claimMessage(issueNumber: number, nonce: string): string {
  return `afk claim issue ${issueNumber}\nnonce: ${nonce}\n`;
}

/**
 * The bytes of a tag object, for `git mktag`.
 *
 * The format is git's own: the object it points at, its type, the tag's name,
 * who tagged it and when, and then the message.
 */
export function claimTagObject(options: {
  readonly baseSha: string;
  readonly name: string;
  readonly message: string;
  readonly timestampSeconds: number;
}): string {
  const { baseSha, name, message, timestampSeconds } = options;
  return (
    `object ${baseSha}\n` +
    `type commit\n` +
    `tag ${name}\n` +
    `tagger ${CLAIM_TAGGER.name} <${CLAIM_TAGGER.email}> ${timestampSeconds} +0000\n` +
    `\n` +
    `${message}`
  );
}

/**
 * Write the tag object and return its id. No ref is created — the object only.
 *
 * Safe to run at the same time as another write: an object is named by what
 * it holds, so two writes of the same object are one object, and two writes
 * of different objects touch different files.
 */
export async function createClaimObject(
  git: GitRunner,
  cwd: string,
  options: {
    readonly baseSha: string;
    readonly issueNumber: number;
    readonly nonce: string;
    readonly timestampSeconds: number;
  },
): Promise<string> {
  const name = claimRefName(options.issueNumber);
  const payload = claimTagObject({
    baseSha: options.baseSha,
    name,
    message: claimMessage(options.issueNumber, options.nonce),
    timestampSeconds: options.timestampSeconds,
  });
  const id = await git(["mktag"], { cwd, input: payload });
  return id.trim();
}

/**
 * Push the claim.
 *
 * It throws when the push is rejected, and the rejection is the interesting
 * case: it means another runner holds the issue.
 *
 * Safe to run at the same time as another push: it writes one tag of the
 * remote, one that belongs to its own issue, and it writes nothing in the
 * checkout.
 */
export async function pushClaim(
  git: GitRunner,
  cwd: string,
  options: { readonly remote: string; readonly issueNumber: number; readonly objectId: string },
): Promise<void> {
  // No hook: the claim is a marker, not code. The repository's pre-push hook
  // gates the tree that is being pushed, and the claim pushes a marker object
  // — gating that costs minutes and says nothing about the change.
  await git(
    [
      "push",
      "--no-verify",
      options.remote,
      `${options.objectId}:${claimRef(options.issueNumber)}`,
    ],
    { cwd },
  );
}

/**
 * Remove the claim.
 *
 * The ref may not be there: a run that died before its claim landed has
 * nothing to delete, and a delete of a ref that is not there fails.
 *
 * Safe to run at the same time as another delete: the read is a read, and
 * the delete writes one tag of the remote and nothing in the checkout.
 */
export async function deleteClaim(
  git: GitRunner,
  cwd: string,
  options: { readonly remote: string; readonly issueNumber: number },
): Promise<void> {
  // The ref may not be there: a run that died before its claim landed has
  // nothing to delete, and a delete of a ref that is not there fails.
  const existing = await readRemoteSha(git, cwd, {
    remote: options.remote,
    ref: claimRef(options.issueNumber),
  });
  if (existing === null) {
    return;
  }
  // No hook: the claim is a marker, not code, and a hook that gates the
  // repository's tree has nothing to say about it.
  await git(
    ["push", "--no-verify", options.remote, "--delete", claimRefName(options.issueNumber)],
    { cwd },
  );
}

/**
 * Delete a local branch, if it is there.
 *
 * `-D`, not `-d`: the branch is not merged and is not anybody's — it is the
 * runner's own `agent/issue-<N>`, and its commits are a dead run's. The caller
 * has decided that the work is redone.
 *
 * Safe to run at the same time as another delete: the listing is a read, and
 * the delete writes one ref of the checkout — the branch of its own issue —
 * and git locks that ref alone.
 */
export async function deleteLocalBranch(
  git: GitRunner,
  cwd: string,
  options: { readonly branch: string },
): Promise<void> {
  const listed = await git(["branch", "--list", options.branch], { cwd });
  if (listed.trim() === "") {
    return;
  }
  await git(["branch", "-D", options.branch], { cwd });
}

/**
 * Delete a branch on the remote, if it is there.
 *
 * The ref may not be there: a run that died before its push leaves nothing to
 * delete, and a delete of a ref that is not there fails.
 *
 * No hook: a delete pushes no tree, and the repository's pre-push hook gates
 * the tree that is being pushed. A hook that has nothing to gate must not
 * stand between the runner and a branch it has to remove.
 *
 * Safe to run at the same time as another delete: the read is a read, and
 * the delete writes one branch of the remote and nothing in the checkout.
 */
export async function deleteRemoteBranch(
  git: GitRunner,
  cwd: string,
  options: { readonly remote: string; readonly branch: string },
): Promise<void> {
  const existing = await readRemoteSha(git, cwd, {
    remote: options.remote,
    ref: headRef(options.branch),
  });
  if (existing === null) {
    return;
  }
  await git(["push", "--no-verify", options.remote, "--delete", options.branch], { cwd });
}

/**
 * Whether the index holds **unmerged entries** — a conflict that is waiting to
 * be resolved.
 *
 * `git ls-files -u` lists the stages of the files a merge could not reconcile.
 * An empty listing means the index holds no conflict, whatever else made the
 * merge fail: unrelated histories, a locked index, a base that is not there.
 *
 * A read: safe to run at the same time as anything, and it writes nothing.
 */
export async function hasUnmergedEntries(git: GitRunner, cwd: string): Promise<boolean> {
  const listed = await git(["ls-files", "-u"], { cwd });
  return listed.trim() !== "";
}

/**
 * The paths that hold the work, against the base.
 *
 * The branch's own commits, measured from the **merge base**: the base's own
 * changes are not the branch's work, and a branch that started from an older
 * base would otherwise read as a change of its own. On top of them, the tree's
 * own changes: the files that are modified and the files that are new.
 *
 * Git's own rules decide what counts. An ignored file is the host's business,
 * not the work.
 *
 * A read: safe to run at the same time as anything, and it writes nothing.
 */
export async function changedPaths(
  git: GitRunner,
  cwd: string,
  base: string,
): Promise<readonly string[]> {
  const committed = await git(["diff", "--name-only", `${base}...HEAD`], { cwd });
  const modified = await git(["diff", "--name-only", "HEAD"], { cwd });
  const untracked = await git(["ls-files", "--others", "--exclude-standard"], { cwd });
  const paths = new Set<string>();
  for (const output of [committed, modified, untracked]) {
    for (const raw of output.split("\n")) {
      const path = raw.trim();
      if (path !== "") {
        paths.add(path);
      }
    }
  }
  return [...paths];
}

/**
 * The full ref of a branch.
 *
 * `git ls-remote` matches the **tail** of a ref, so `main` would also match
 * `refs/tags/main`. The head is named exactly.
 */
export function headRef(branch: string): string {
  return branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
}

/**
 * The commit a ref points at on the remote, or null when it has none.
 *
 * A read of the remote: safe to run at the same time as anything, and it
 * writes nothing in the checkout.
 */
export async function readRemoteSha(
  git: GitRunner,
  cwd: string,
  options: { readonly remote: string; readonly ref: string },
): Promise<string | null> {
  const output = await git(["ls-remote", options.remote, options.ref], { cwd });
  const line = output.trim();
  if (line === "") {
    return null;
  }
  const sha = line.split(/\s+/)[0];
  return sha ?? null;
}

/**
 * The base commit a claim was taken from.
 *
 * The claim is an annotated tag, so the remote lists it twice: the tag object,
 * and the commit it peels to. The commit is the base.
 *
 * A read of the remote: safe to run at the same time as anything, and it
 * writes nothing in the checkout.
 */
export async function readClaimBase(
  git: GitRunner,
  cwd: string,
  options: { readonly remote: string; readonly issueNumber: number },
): Promise<string | null> {
  const output = await git(
    ["ls-remote", "--tags", options.remote, `${claimRefName(options.issueNumber)}*`],
    { cwd },
  );
  for (const line of output.trim().split("\n")) {
    const match = /^[0-9a-f]+\s+refs\/tags\/.*\^\{\}$/.exec(line.trim());
    if (match !== null) {
      return line.trim().split(/\s+/)[0] ?? null;
    }
  }
  return null;
}

/**
 * The claim object the remote holds for an issue, or null when it holds none.
 *
 * The claim is an annotated tag, so the remote lists it twice: the tag object,
 * and the commit it peels to. The **tag object** is the claim — it carries the
 * nonce — and it is what tells two claims apart: two runners that took the same
 * issue from the same base agree on the commit and differ on the object.
 *
 * A read of the remote: safe to run at the same time as anything, and it
 * writes nothing in the checkout.
 */
export async function readClaimObject(
  git: GitRunner,
  cwd: string,
  options: { readonly remote: string; readonly issueNumber: number },
): Promise<string | null> {
  const output = await git(["ls-remote", options.remote, claimRef(options.issueNumber)], { cwd });
  for (const line of output.trim().split("\n")) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (ref === claimRef(options.issueNumber)) {
      return sha ?? null;
    }
  }
  return null;
}

/**
 * The pattern that names every work branch on the remote.
 *
 * The runner's branches are `agent/issue-<N>` (see `workBranch`), and this is
 * what one `ls-remote` and one `fetch` ask for.
 */
const WORK_BRANCH_REF_GLOB = `refs/heads/${WORK_BRANCH_PREFIX}*`;

/** The line `ls-remote` prints for a work branch. */
const REMOTE_WORK_BRANCH_LINE = new RegExp(
  `^[0-9a-f]+\\s+refs/heads/(${regexLiteral(WORK_BRANCH_PREFIX)}.*)$`,
);

/** A counter that keeps the private refs of one bulk read apart. */
let bulkCounter = 0;

/**
 * Every work branch on the remote.
 *
 * One `ls-remote` for all of them: the branches grow with the issues the
 * runner has worked, and a call per branch made the cost of a run grow with
 * the queue's history.
 *
 * A read of the remote: safe to run at the same time as anything, and it
 * writes nothing in the checkout.
 */
async function readRemoteWorkBranches(
  git: GitRunner,
  cwd: string,
  options: { readonly remote: string },
): Promise<ReadonlySet<string>> {
  const output = await git(["ls-remote", "--heads", options.remote, WORK_BRANCH_REF_GLOB], {
    cwd,
  });
  const branches = new Set<string>();
  for (const line of output.split("\n")) {
    const match = REMOTE_WORK_BRANCH_LINE.exec(line.trim());
    if (match !== null) {
      branches.add(match[1] ?? "");
    }
  }
  return branches;
}

/**
 * The branches that carry work the base does not have.
 *
 * A branch that points at the base carries nothing: it is what a run pushed
 * before the session step refused an empty tree, or the leftover of work the
 * base already has. GitHub refuses a pull request for it — *No commits between
 * <base> and <branch>* — so a run that reads the branch's **existence** as work
 * retries the same refusal for ever.
 *
 * The question is asked of every branch at once: the answer is the same one
 * `git rev-list --count <base>..<branch>` gives, and a run that asked it per
 * branch paid for it once per issue it had ever worked.
 */
export async function branchesWithWork(
  git: GitRunner,
  cwd: string,
  options: {
    readonly remote: string;
    readonly base: string;
    readonly branches: readonly string[];
  },
): Promise<Set<string>> {
  const work = new Set<string>();
  const wanted = [...new Set(options.branches)].filter((branch) =>
    branch.startsWith(WORK_BRANCH_PREFIX),
  );
  if (wanted.length === 0) {
    return work;
  }
  const tips = await readRemoteWorkBranches(git, cwd, { remote: options.remote });
  const present = wanted.filter((branch) => tips.has(branch));
  if (present.length === 0) {
    // No branch on the remote carries anything: there is nothing to fetch and
    // nothing to compare.
    return work;
  }
  const namespace = `refs/afk/work-${process.pid}-${++bulkCounter}`;
  try {
    // The fetch is a wildcard over the runner's own branches: one call, a
    // command line that does not grow with the queue, and a branch that was
    // deleted between the two calls is simply not fetched — a fetch that named
    // it would fail on it.
    //
    // It is one at a time like every other fetch: the refs it writes are
    // private, but it writes the checkout's `FETCH_HEAD` and updates the
    // remote-tracking refs its refspecs map to.
    await fetchAlone(() =>
      git(
        [
          "fetch",
          options.remote,
          `+${headRef(options.base)}:${namespace}/base`,
          `+${WORK_BRANCH_REF_GLOB}:${namespace}/branch/*`,
        ],
        { cwd },
      ),
    );
    // The branches the base does not have are the branches that carry work:
    // their commits are not on the base, and GitHub would refuse a pull
    // request for the ones that are. The base is named, not resolved:
    // `for-each-ref` reads the ref, and a `rev-parse` to learn its commit
    // would be one call more.
    const carrying = new Set(
      (
        await git(
          [
            "for-each-ref",
            "--no-merged",
            `${namespace}/base`,
            "--format=%(refname)",
            `${namespace}/branch/`,
          ],
          { cwd },
        )
      )
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== ""),
    );
    for (const branch of present) {
      const ref = `${namespace}/branch/${branch.slice(WORK_BRANCH_PREFIX.length)}`;
      // A branch that is not in the list was not fetched — it was deleted
      // between the two calls — and a branch that is not there carries nothing.
      if (carrying.has(ref)) {
        work.add(branch);
      }
    }
  } finally {
    await removeRefs(git, cwd, namespace).catch(() => "");
  }
  return work;
}

/**
 * Remove the refs of one bulk read, so the checkout is left as it was.
 *
 * Safe to run at the same time as another clean-up: the refs are private to
 * one bulk read, and git locks each of them alone.
 */
async function removeRefs(
  git: GitRunner,
  cwd: string,
  namespace: string,
): Promise<void> {
  const refs = (
    await git(["for-each-ref", "--format=%(refname)", namespace], { cwd })
  )
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (refs.length === 0) {
    return;
  }
  await git(["update-ref", "--stdin"], {
    cwd,
    input: refs.map((ref) => `delete ${ref}\n`).join(""),
  });
}

/**
 * The fetches of this process, one after another.
 *
 * Every fetch of a checkout is **one at a time**. A fetch writes the
 * checkout's `FETCH_HEAD` — one file for the whole checkout — and it updates
 * the remote-tracking refs its refspec maps to, and git locks both. Two
 * fetches at the same time make the second one fail with "cannot lock
 * ref" or "cannot lock FETCH_HEAD", whichever it reaches first.
 *
 * The workers of one sweep share the checkout, so they take turns.
 */
let fetchQueue: Promise<unknown> = Promise.resolve();

/** Run a fetch of the shared checkout on its own. */
async function fetchAlone<T>(run: () => Promise<T>): Promise<T> {
  const next = fetchQueue.then(run);
  // The queue goes on even when a fetch fails: the next one is not this one's
  // business.
  fetchQueue = next.catch(() => {});
  return next;
}

/** A counter that keeps the private fetch refs of one process apart. */
let fetchCounter = 0;

/**
 * Fetch one ref, and hand back the commit it points at.
 *
 * The ref is fetched into a private ref of this call, named so that no other
 * run in the checkout can be writing it, and removed again. That is what makes
 * it safe to read: `FETCH_HEAD` is shared by every run of the repository, and a
 * commit read from it may be a commit another run fetched.
 *
 * The fetch is one at a time all the same — it writes the same `FETCH_HEAD`
 * every other fetch writes, and it updates the remote-tracking refs its
 * refspec maps to.
 */
export async function fetchCommit(
  git: GitRunner,
  cwd: string,
  options: { readonly remote: string; readonly ref: string },
): Promise<string> {
  // shortcut: a run killed mid-fetch leaves its private ref behind, and nothing
  // sweeps those up — clean them out when their number starts to matter.
  const name = `refs/afk/fetch-${process.pid}-${++fetchCounter}`;
  try {
    await fetchAlone(() =>
      git(["fetch", options.remote, `+${options.ref}:${name}`], { cwd }),
    );
    // The read is a read: it names a private ref of this call, and it holds
    // nothing but this call's own commit.
    return (await git(["rev-parse", name], { cwd })).trim();
  } finally {
    // The private ref goes, and it is this call's own: two runs that clean up
    // at the same time write two different refs.
    await git(["update-ref", "-d", name], { cwd }).catch(() => "");
  }
}

/**
 * Bring one ref's objects down from the remote.
 *
 * The fetch of one checkout is **one at a time**. The ref it updates — the
 * remote-tracking one — belongs to the checkout and not to the run, and two
 * fetches that want it at the same time make the second one fail with
 * "cannot lock ref". The workers of one sweep share the checkout, so they
 * take turns.
 */
export async function fetchRef(
  git: GitRunner,
  cwd: string,
  options: { readonly remote: string; readonly ref: string },
): Promise<void> {
  await fetchAlone(() => git(["fetch", options.remote, options.ref], { cwd }));
}

/**
 * Create the worktree the work happens in.
 *
 * The branch is created here, on the base the claim recorded, so the work
 * starts from exactly the commit the claim was taken against.
 *
 * The worktrees of one checkout are made **one at a time**. `git worktree add`
 * writes the registration before it creates the directory, and `git worktree
 * prune` — which a finished run calls — removes a registration whose directory
 * is not there yet. The workers of one sweep share the checkout, so they take
 * turns.
 */
export async function addWorktree(
  git: GitRunner,
  cwd: string,
  options: {
    readonly path: string;
    readonly branch: string;
    readonly baseSha: string;
  },
): Promise<void> {
  await worktreeAlone(() => addWorktreeNow(git, cwd, options));
}

/**
 * Put a worktree on a commit, detached.
 *
 * The worktrees of one checkout are made **one at a time**, this one included:
 * it writes the registration before it creates the directory, and a `prune`
 * from another worker would delete it.
 */
export async function addDetachedWorktree(
  git: GitRunner,
  cwd: string,
  options: { readonly path: string; readonly sha: string },
): Promise<void> {
  await worktreeAlone(() =>
    git(["worktree", "add", "--detach", options.path, options.sha], { cwd }),
  );
}

/** The worktree commands of this process, one after another. */
let worktreeQueue: Promise<unknown> = Promise.resolve();

/** Run a worktree command of the checkout on its own. */
async function worktreeAlone<T>(run: () => Promise<T>): Promise<T> {
  const next = worktreeQueue.then(run);
  // The queue goes on even when a command fails: the next one is not this one's
  // business.
  worktreeQueue = next.catch(() => {});
  return next;
}

async function addWorktreeNow(
  git: GitRunner,
  cwd: string,
  options: {
    readonly path: string;
    readonly branch: string;
    readonly baseSha: string;
  },
): Promise<void> {
  // A run that failed before its push leaves its branch behind on purpose — the
  // work a run did is durable — so the next attempt on this checkout finds the
  // branch and continues it. `-b` would fail on the second attempt, and the issue
  // would be unworkable on this machine for ever.
  const exists =
    (
      await git(
        ["rev-parse", "--verify", "--quiet", `refs/heads/${options.branch}`],
        { cwd },
      ).catch(() => "")
    ).trim() !== "";
  if (!exists) {
    await git(["worktree", "add", "-b", options.branch, options.path, options.baseSha], {
      cwd,
    });
    return;
  }
  // A branch that carries nothing of its own is a failed run's leftover, not work:
  // it is moved to the base this run claimed, so a retry does not work on the main
  // of an hour ago. Commits of its own are left where they are.
  const ahead = (
    await git(["rev-list", "--count", `${options.baseSha}..${options.branch}`], { cwd })
  ).trim();
  if (ahead === "0") {
    await git(["branch", "-f", options.branch, options.baseSha], { cwd });
  }
  await git(["worktree", "add", options.path, options.branch], { cwd });
}

/**
 * Remove the worktree.
 *
 * The directory goes and the registration is pruned, rather than
 * `git worktree remove`, because that command refuses a path that is not a
 * registered worktree — and a run that failed *before* the worktree existed
 * must still be able to release its claim. Pruning a registration whose
 * directory is gone is what git itself does when it cleans up.
 *
 * The branch is not the worktree: removing the worktree leaves the branch and
 * its commits alone, so the work a failed run did is durable.
 */
export async function removeWorktree(
  git: GitRunner,
  cwd: string,
  path: string,
): Promise<void> {
  await worktreeAlone(() => removeWorktreeNow(git, cwd, path));
}

async function removeWorktreeNow(
  git: GitRunner,
  cwd: string,
  path: string,
): Promise<void> {
  // Ask git first: the path may belong to another run's worktree.
  const list = await git(["worktree", "list", "--porcelain"], { cwd });
  const entries = list.split(/\n\n/).map((block) => block.trim()).filter((b) => b !== "");
  let registeredBranch: string | null = null;
  for (const block of entries) {
    const lines = block.split("\n");
    const wtLine = lines.find((l) => l.startsWith("worktree "));
    if (wtLine === undefined || wtLine.slice("worktree ".length).trim() !== path) {
      continue;
    }
    const branchLine = lines.find((l) => l.startsWith("branch "));
    registeredBranch = branchLine === undefined ? null : branchLine.slice("branch ".length).trim();
  }

  if (registeredBranch !== null) {
    // Only our own worktrees may be removed: those on a branch of ours.
    if (!WORK_BRANCH_PATTERN.test(registeredBranch)) {
      throw new Error(
        `refusing to remove worktree at ${path}: it is registered to branch ${registeredBranch}`,
      );
    }
    // Remove via git so the registration is cleaned up, then prune.
    await git(["worktree", "remove", "--force", path], { cwd }).catch(async () => {
      await rm(path, { recursive: true, force: true });
    });
    await git(["worktree", "prune"], { cwd });
    return;
  }

  // Not a registered worktree: a leftover directory (or nothing at all).
  await rm(path, { recursive: true, force: true });
  await git(["worktree", "prune"], { cwd });
}

/**
 * The refs the runner is allowed to push.
 *
 * The work branch, and the claim. Nothing else — a runner that can push
 * anywhere can push anywhere, and the guard is cheaper than the review.
 */
export function allowedPushRefs(issueNumber: number): readonly string[] {
  return [`refs/heads/${workBranch(issueNumber)}`, claimRef(issueNumber)];
}

/**
 * Refuse a ref the runner may not push.
 *
 * The refusal happens **before** any git command runs: a push that has already
 * half happened is a push that has to be undone.
 */
export function assertPushableRef(ref: string, issueNumber: number): void {
  const allowed = allowedPushRefs(issueNumber);
  if (!allowed.includes(ref)) {
    throw new Error(
      `the runner may not push ${ref}: it pushes only ${allowed.join(" and ")}`,
    );
  }
}

/**
 * Push one ref, if it is one the runner may push.
 *
 * The push is **safe to run at the same time** as another push, and this is
 * the reason: it writes one ref of the remote, and that ref belongs to its
 * own issue — the claim is exclusive, so no two workers push the same one.
 * It writes **nothing in the checkout**: a push does not move a local ref, it
 * only reads the objects it sends. The hook it runs is the worktree's own,
 * in the worktree's own directory, with the worktree's own build cache. The
 * collection git may start on its own is off.
 */
export async function pushRef(
  git: GitRunner,
  cwd: string,
  options: {
    readonly remote: string;
    readonly ref: string;
    readonly sha: string;
    readonly issueNumber: number;
    /**
     * Whether the repository's own pre-push hook may gate this push.
     *
     * The hook is the repository's rule, and it is expensive: the detekt
     * verdict over a `shared/` change takes about nine minutes. Skipping it is
     * a decision about the repository's state — its gate is red for a reason
     * that has nothing to do with this change — and it is therefore explicit.
     */
    readonly verify?: boolean;
  },
): Promise<void> {
  assertPushableRef(options.ref, options.issueNumber);
  await git(
    [
      "push",
      ...(options.verify === false ? ["--no-verify"] : []),
      options.remote,
      `${options.sha}:${options.ref}`,
    ],
    { cwd },
  );
}

/** Push the work branch. */
export async function pushWorkBranch(
  git: GitRunner,
  cwd: string,
  options: {
    readonly remote: string;
    readonly issueNumber: number;
    readonly sha: string;
    /** Whether the repository's own pre-push hook may gate this push. */
    readonly verify?: boolean;
  },
): Promise<void> {
  await pushRef(git, cwd, {
    remote: options.remote,
    ref: `refs/heads/${workBranch(options.issueNumber)}`,
    sha: options.sha,
    issueNumber: options.issueNumber,
    ...(options.verify === undefined ? {} : { verify: options.verify }),
  });
}

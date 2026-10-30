/**
 * The host lock.
 *
 * One runner at a time on one machine. The claim on the issue is what excludes
 * a runner **anywhere** — that is the layer that works across hosts — and this
 * is the layer below it: it keeps two runs on one host from fighting over the
 * same worktree root, the same Gradle home and the same record directory.
 *
 * It is a real `flock`, held by a child process for as long as the run lasts.
 * Two other locks were considered and rejected: a lock *file* that a killed
 * runner leaves behind blocks the next one for ever, and a lock that is only a
 * marker is not a lock at all — the label cannot be one either, because adding
 * a label is idempotent.
 *
 * `flock(1)` is a Linux tool, and the runner's host is a Linux workstation. On
 * anything else the lock is **unusable**, and the runner says so rather than
 * quietly running two of itself.
 *
 * The lock cannot outlive the runner: the holder watches its parent and exits
 * when the parent is gone. A lock that a killed runner left behind would keep
 * the next runner out for ever, over a process that no longer exists.
 */

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/** The exit code `flock` uses when the lock is held and `--conflict-exit-code` says so. */
const CONFLICT_EXIT_CODE = 75;

/** The name of the lock file inside the lock directory. */
export const LOCK_NAME = "runner.lock";

/** The word the holder prints once the lock is its own. */
const HELD = "locked";

/**
 * The command the lock holder runs.
 *
 * The holder watches its parent and exits when the parent is gone. A runner
 * that is killed — with a signal, or with a crash — must not leave the lock
 * held by an orphan: the next runner would find the lock taken and refuse to
 * work, for ever, over a process that no longer exists.
 */
export const HOLDER_COMMAND = `echo ${HELD}; while kill -0 $PPID 2>/dev/null; do sleep 1; done`;

/** The lock is held by another runner. */
export class LockHeld extends Error {
  constructor(path: string) {
    super(`the lock ${path} is held by another runner`);
    this.name = "LockHeld";
  }
}

/** The lock cannot be taken at all. */
export class LockUnusable extends Error {
  constructor(path: string, detail: string) {
    super(`the lock ${path} cannot be taken: ${detail}`);
    this.name = "LockUnusable";
  }
}

/** A lock the runner holds. */
export interface Lock {
  /** Where the lock lives. */
  readonly path: string;
  /** Give it back. */
  release(): Promise<void>;
}

/**
 * Take the lock, or say why it could not be taken.
 *
 * The holder is a child process: `flock` takes the lock and then runs a
 * command that says so and blocks, so the lock is held for as long as the
 * child lives. `--no-fork` keeps that command in the process `flock` itself,
 * so ending the child ends the lock — a forked holder would leave the lock
 * behind when the parent was killed.
 */
export async function takeLock(
  directory: string,
  name: string = LOCK_NAME,
): Promise<Lock> {
  const path = join(directory, name);

  try {
    await mkdir(directory, { recursive: true });
  } catch (failure) {
    throw new LockUnusable(
      path,
      failure instanceof Error ? failure.message : String(failure),
    );
  }

  const child = spawn(
    "flock",
    [
      "--nonblock",
      "--no-fork",
      `--conflict-exit-code=${CONFLICT_EXIT_CODE}`,
      path,
      "sh",
      "-c",
      HOLDER_COMMAND,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  const closed = new Promise<void>((resolve) => {
    child.once("close", () => {
      resolve();
    });
  });

  let held = false;
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  await new Promise<void>((resolve, reject) => {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (chunk.includes(HELD)) {
        held = true;
        resolve();
      }
    });
    child.on("error", (failure: Error) => {
      reject(new LockUnusable(path, failure.message));
    });
    child.on("close", (code: number | null) => {
      if (held) {
        return;
      }
      const detail = stderr.trim();
      reject(
        code === CONFLICT_EXIT_CODE
          ? new LockHeld(path)
          : new LockUnusable(path, detail === "" ? `flock exited ${code}` : detail),
      );
    });
  });

  return {
    path,
    release: async () => {
      child.kill("SIGTERM");
      await closed;
    },
  };
}

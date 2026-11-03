/**
 * The bound a child process gets, and the grace it is given to stop.
 *
 * The rule is the runner's: a child is asked to stop at the bound, and the run
 * stops waiting for it a moment later — whether the child stopped or not. A
 * child that ignores the request would otherwise hold the run, the host's lock
 * and the schedule for as long as it likes, and a call that never settles is
 * the wedge the bound exists to prevent.
 *
 * The rule is written once, here, because it was written twice — once for `gh`
 * and once for `git` — and two copies of a rule are two copies that drift.
 */

/** How long a child is given to stop before the run stops waiting for it. */
export const KILL_GRACE_MS = 5_000;

/**
 * How a child that was killed at the bound ended.
 *
 * Two endings, and a failure that names neither leaves a reader unable to
 * tell them apart: a child that stopped when it was asked, and a child that
 * ignored the request and had to be left behind.
 */
export type TimeoutEnding = "stopped" | "ignored";

/**
 * What each ending is said to be.
 *
 * The wording lives here, beside the rule that makes the two endings, so that
 * the failures that report them — the one for `git` and the one for `gh` —
 * say the same thing in the same words.
 */
export const ENDING_WORDS: Record<TimeoutEnding, string> = {
  stopped: "the child was stopped when it was asked to stop",
  ignored: "the child ignored the request to stop and was left behind",
};

/**
 * What the child printed, said in a sentence.
 *
 * The output is the only evidence there is, so it goes into the failure's own
 * words: a reader of a record reads the message, and a message that says
 * nothing about the output is a record with no evidence in it. A child that
 * printed nothing says so plainly, so that an empty failure is read as an
 * empty child and not as a lost one.
 */
export function whatTheChildPrinted(stdout: string, stderr: string): string {
  const text = [stdout, stderr]
    .map((stream) => stream.trim())
    .filter((stream) => stream.length > 0)
    .join("\n");
  return text.length > 0 ? `it printed: ${text}` : "it printed nothing";
}

/**
 * Runs a call under the bound, and stops waiting for it when the grace is spent.
 *
 * The call is the child's half of the bound: it asks the child to stop and
 * waits for it. This is the run's half: when the grace is spent, the run stops
 * waiting and says so, whatever the child is doing.
 *
 * The failure is built by the caller, because what a timed-out `gh` says and
 * what a timed-out `git` says are different failures.
 */
export async function withHardStop<T>(
  call: Promise<T>,
  options: {
    /** When the child was asked to stop. */
    readonly timeoutMs: number;
    /** How long the child is given to stop. */
    readonly killGraceMs?: number;
    /** The failure raised when the child did not stop in time. */
    readonly timeoutError: () => Error;
  },
): Promise<T> {
  const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
  let hardStop: NodeJS.Timeout | undefined;
  const stop = new Promise<never>((_resolve, reject) => {
    hardStop = setTimeout(
      () => reject(options.timeoutError()),
      options.timeoutMs + killGraceMs,
    );
    hardStop.unref();
  });
  try {
    return await Promise.race([call, stop]);
  } finally {
    if (hardStop !== undefined) {
      clearTimeout(hardStop);
    }
  }
}

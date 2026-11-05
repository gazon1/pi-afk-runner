/**
 * The guard the work session runs under.
 *
 * What is ours is the **policy** — the files nobody hands to an agent, the
 * commands that would file a leftover behind the runner's back, the gates this
 * run does not run, and how long a command may run. The mechanism is the
 * engine's: Mastra's own hook over the workspace's tool calls reads this
 * policy (see `src/mastra/guard.ts`), and the runner's own commit path reads
 * it too (see `src/runner.ts`).
 *
 * The policy is one object, and it is here, so that the two places that read
 * it cannot refuse different things.
 */

/** The refusal a build gets. */
const BUILD_REASON = "Do not build: this run does not compile. Change the code and stop.";

/** The refusal a check gets. */
const CHECK_REASON =
  "Do not run the checks: this run does not gate the tree. Change the code and stop.";

/**
 * A rule of the policy: allow, deny, or deny with a reason.
 */
export type PolicyRule = "allow" | "deny" | { readonly action: "deny"; readonly reason: string };

/**
 * A way a command runs a test suite.
 *
 * A program that is a suite on its own (`pytest`), a program that is a suite
 * when it carries an argument (`npm test`), and a module a Python runner runs
 * (`python -m unittest`) are all one entry in the policy's list.
 */
type SuiteEntry =
  | { readonly kind: "program"; readonly program: string; readonly argument?: string }
  | { readonly kind: "module"; readonly module: string };

/**
 * The programs that run a test suite, and the reason they are refused.
 *
 * They are refused by the **program** a command starts, not by the words the
 * command carries: a search for `unittest` is a search, and a suite is a
 * gate this run does not run.
 *
 * The list of them is the policy's, and it is the only place they are
 * written: a runner is one more entry, and the rule that reads the policy
 * knows no runner by name.
 */
interface ProgramPolicy {
  /** Why a test suite is refused. */
  readonly reason: string;
  /** The ways a command runs a test suite. */
  readonly suites: readonly SuiteEntry[];
  /** The Python that runs a module. */
  readonly python: RegExp;
}

/**
 * The bound on how long a command may run.
 *
 * A run that waits is a run that does nothing else: the session's minutes go
 * to a command nobody asked this run to run, and the run looks alive while it
 * waits. The ceiling is the same for the two ways a command asks for time —
 * the tool's own timeout and the shell's `timeout`.
 */
interface DurationPolicy {
  /** Why a command that runs too long is refused. */
  readonly reason: string;
  /** The longest a command may run, in seconds. */
  readonly ceilingSeconds: number;
}

/** The policy as a whole. */
export interface GuardPolicy {
  /** What the policy says about everything it does not name. */
  readonly "*": PolicyRule;
  /** The rules for the shell commands, in the order they are written. */
  readonly bash: Readonly<Record<string, PolicyRule>>;
  /** The rules for the paths, in the order they are written. */
  readonly path: Readonly<Record<string, PolicyRule>>;
  /** The rules for the programs a command starts. */
  readonly program: ProgramPolicy;
  /** The bound on how long a command may run. */
  readonly duration: DurationPolicy;
}

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
 *
 * A test suite is a check, and it is refused by its **program** rather than by
 * the word it carries: `grep -rn unittest` reads the tree and is allowed, and
 * `python3 -m unittest discover` runs the suite and is not. The word alone
 * would refuse the searches that read how the target gates itself. The
 * program is found behind the wrappers — behind a `cd`, behind a `timeout`,
 * behind a shell's `-c` — because that is where the agent puts it.
 *
 * The list of the programs that are a suite is the policy's, and it holds
 * every runner: `pytest`, `vitest`, `jest`, `rspec`, `npm test`, `gradle
 * test`, `mvn test`, `go test` and `cargo test` among them. The list grows
 * without the rule changing — a runner is one more entry — and the rule
 * knows no runner by name.
 *
 * And a command may not ask to run for longer than the ceiling, however it
 * asks: through the tool's own timeout or through the shell's `timeout`.
 */
export const GUARD_POLICY: GuardPolicy = {
  "*": "allow",
  bash: {
    "*": "allow",
    "gh issue create*": {
      action: "deny",
      reason: "File a leftover with the `agent_leftover` tool — it holds the bounds on the queue.",
    },
    "*./gw*": {
      action: "deny",
      reason: BUILD_REASON,
    },
    "*./gradlew*": {
      action: "deny",
      reason: BUILD_REASON,
    },
    "*./check.sh*": {
      action: "deny",
      reason: CHECK_REASON,
    },
    "*just build*": {
      action: "deny",
      reason: BUILD_REASON,
    },
    "*just check*": {
      action: "deny",
      reason: CHECK_REASON,
    },
    "*just test*": {
      action: "deny",
      reason: CHECK_REASON,
    },
    "*just lint*": {
      action: "deny",
      reason: CHECK_REASON,
    },
    "*just detekt*": {
      action: "deny",
      reason: CHECK_REASON,
    },
    "*just gate*": {
      action: "deny",
      reason: CHECK_REASON,
    },
    "*just tcheck-evals*": {
      action: "deny",
      reason: CHECK_REASON,
    },
    "*just docs-audit*": {
      action: "deny",
      reason: CHECK_REASON,
    },
  },
  path: {
    "*.env": "deny",
    "*.env.*": "deny",
    "*.env.example": "allow",
    "*.pem": "deny",
  },
  program: {
    reason: CHECK_REASON,
    /** The ways a command runs a test suite. */
    suites: [
      { kind: "program", program: "pytest" },
      { kind: "program", program: "py.test" },
      { kind: "program", program: "vitest" },
      { kind: "program", program: "jest" },
      { kind: "program", program: "rspec" },
      { kind: "program", program: "npm", argument: "test" },
      { kind: "program", program: "gradle", argument: "test" },
      { kind: "program", program: "mvn", argument: "test" },
      { kind: "program", program: "go", argument: "test" },
      { kind: "program", program: "cargo", argument: "test" },
      { kind: "module", module: "unittest" },
      { kind: "module", module: "pytest" },
    ],
    /** The Python that runs a module. */
    python: /^python\d*(\.\d+)?$/,
  },
  duration: {
    reason:
      "Do not wait: this run reads the tree and writes the change, it does not wait for a command to finish.",
    /** Ten minutes — long enough for a slow command, short enough for a run. */
    ceilingSeconds: 600,
  },
};

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
  return policyVerdict(GUARD_POLICY.path, path).denied;
}

/**
 * The wrappers a program may sit behind.
 *
 * They are not the program: `cd /work && pytest` runs pytest, and
 * `timeout 3000 python3 -m unittest` runs unittest. What is skipped is the
 * wrapper, and what is read is the program behind it. `npx` is one of them
 * too — `npx vitest run` runs vitest.
 */
const WRAPPERS = new Set(["cd", "env", "exec", "nohup", "npx", "sudo", "time", "timeout"]);

/** The shells whose `-c` argument carries a command of its own. */
const SHELLS = new Set(["sh", "bash", "zsh", "ksh", "dash"]);

/**
 * What one command runs: the program, and the words it was given.
 */
interface CommandRun {
  /** The program — its own name, without the path it sits at. */
  readonly program: string;
  /** The words the program was given. */
  readonly words: readonly string[];
  /** The duration a `timeout` wrapper carries, in seconds. */
  readonly timeoutSeconds?: number;
}

/**
 * The command's own segments: what a shell would run, one after another.
 *
 * The split respects the quotes: a `;` inside a quoted string belongs to that
 * string and does not end a command. A search for `unittest; python3` is one
 * search, not a search and a suite.
 */
function segments(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (quote !== undefined) {
      current += char;
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    const next = command[index + 1] ?? "";
    if ((char === "&" && next === "&") || (char === "|" && next === "|")) {
      parts.push(current);
      current = "";
      index += 1;
      continue;
    }
    if (char === ";" || char === "|" || char === "\n") {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

/**
 * The words of a segment, with the quoted ones kept whole.
 *
 * `bash -c "python3 -m unittest"` is three words, and the third one is the
 * command the shell runs.
 */
function wordsOf(segment: string): string[] {
  const words: string[] = [];
  let current = "";
  let started = false;
  let quote: string | undefined;
  for (const char of segment) {
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
        continue;
      }
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        words.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (started) {
    words.push(current);
  }
  return words;
}

/**
 * The program a segment runs.
 *
 * Assignments (`HOME=/home/max`) and wrappers (`timeout`, `cd`) come first and
 * are skipped; what is left is the program.
 */
function programOf(words: readonly string[]): string | undefined {
  let index = 0;
  while (index < words.length) {
    const word = words[index] ?? "";
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      index += 1;
      continue;
    }
    if (WRAPPERS.has(word)) {
      index += 1;
      // `timeout` takes the duration before the program.
      if (word === "timeout") {
        index = afterDuration(words, index);
      }
      continue;
    }
    return word;
  }
  return undefined;
}

/** The index after the duration a `timeout` carries. */
function afterDuration(words: readonly string[], index: number): number {
  let at = index;
  while (at < words.length && (words[at] ?? "").startsWith("-")) {
    at += 1;
  }
  return durationSeconds(words[at] ?? "") === undefined ? at : at + 1;
}

/**
 * A duration in seconds — `300`, `30s`, `5m`, `1h`.
 */
function durationSeconds(word: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(word);
  if (match === null) {
    return undefined;
  }
  const unit = match[2] ?? "";
  const factor = unit === "m" ? 60 : unit === "h" ? 3600 : unit === "d" ? 86400 : 1;
  return Number(match[1]) * factor;
}

/**
 * The duration a `timeout` wrapper carries, in seconds.
 */
function timeoutSecondsOf(words: readonly string[]): number | undefined {
  for (let index = 0; index < words.length; index += 1) {
    if ((words[index] ?? "") !== "timeout") {
      continue;
    }
    let at = index + 1;
    while (at < words.length && (words[at] ?? "").startsWith("-")) {
      at += 1;
    }
    const seconds = durationSeconds(words[at] ?? "");
    if (seconds !== undefined) {
      return seconds;
    }
  }
  return undefined;
}

/**
 * The script a shell's `-c` argument carries.
 */
function shellScript(program: string, words: readonly string[]): string | undefined {
  if (!SHELLS.has(program)) {
    return undefined;
  }
  const flag = words.findIndex((word) => /^-[a-z]*c[a-z]*$/.test(word));
  if (flag === -1) {
    return undefined;
  }
  return words[flag + 1];
}

/**
 * The program a word names — without the path it sits at.
 */
function nameOf(program: string): string {
  return program.split("/").pop() ?? program;
}

/**
 * What a command runs: the programs it starts, one per segment, and one more
 * behind every shell that carries a command of its own.
 */
function runsOf(command: string): CommandRun[] {
  const runs: CommandRun[] = [];
  for (const segment of segments(command)) {
    const words = wordsOf(segment);
    const program = programOf(words);
    if (program === undefined) {
      continue;
    }
    const timeoutSeconds = timeoutSecondsOf(words);
    runs.push({
      program: nameOf(program),
      words,
      ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    });
    // A shell runs what its `-c` argument carries.
    const script = shellScript(nameOf(program), words);
    if (script !== undefined) {
      runs.push(...runsOf(script));
    }
  }
  return runs;
}

/**
 * The module a Python command runs — `python3 -m unittest` runs `unittest`.
 */
function moduleOf(run: CommandRun, policy: ProgramPolicy): string | undefined {
  if (!policy.python.test(run.program)) {
    return undefined;
  }
  const flag = run.words.indexOf("-m");
  return flag === -1 ? undefined : run.words[flag + 1];
}

/**
 * Whether one program of a command is a suite, by the policy's list.
 *
 * A program that is a suite on its own is a suite; a program that is a suite
 * when it carries an argument is one when the argument is among its words.
 */
function isSuite(run: CommandRun, entry: SuiteEntry, policy: ProgramPolicy): boolean {
  if (entry.kind === "module") {
    return moduleOf(run, policy) === entry.module;
  }
  if (entry.program !== run.program) {
    return false;
  }
  return entry.argument === undefined || run.words.includes(entry.argument);
}

/**
 * Whether a command runs a test suite.
 *
 * A run gates nothing, and a suite is a gate: it spends the session's minutes
 * on a tree nobody asked this run to judge. The suite is found by the
 * **program** it starts, and the list of the programs that are a suite is the
 * policy's — so the rule names no runner of its own, and a new runner is one
 * more entry in that list. The suite is not found by the word the command
 * carries, so the searches that read how the target gates itself are still
 * allowed.
 */
export function runsATestSuite(command: string): boolean {
  const policy = GUARD_POLICY.program;
  return runsOf(command).some((run) => policy.suites.some((entry) => isSuite(run, entry, policy)));
}

/**
 * Whether a command asks to run for longer than the ceiling.
 */
export function runsTooLong(command: string): boolean {
  const ceiling = GUARD_POLICY.duration.ceilingSeconds;
  return runsOf(command).some(
    (run) => run.timeoutSeconds !== undefined && run.timeoutSeconds > ceiling,
  );
}

/**
 * Whether a call's own timeout asks for longer than the ceiling.
 *
 * The tool's timeout is in seconds, and it is what the sandbox enforces: a
 * call that asks for an hour gets an hour, whatever the default is.
 */
export function timeoutAboveCeiling(seconds: number): boolean {
  return seconds > GUARD_POLICY.duration.ceilingSeconds;
}

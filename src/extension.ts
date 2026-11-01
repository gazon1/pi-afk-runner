/**
 * The live front door: the run a human watches, and corrects.
 *
 * It is the same runner the CLI drives, with a human in the room. One command
 * starts a run; the footer says which issue it is on and which step it has
 * reached; a small log above the editor shows what the agent is doing as it does
 * it; and anything the human types while it runs is queued as **steering** and
 * delivered into the session the runner owns. The queue is
 * `pi-queue-steer-factory`'s, and it is delivered on the session's own
 * boundaries: the one moment a correction is not a race with the turn.
 *
 * The session is the runner's, not the host's. It is created by the same factory
 * the CLI uses; that factory keeps the host's extensions — the host's model
 * providers are extensions — and drops **this** package's own by name, so this
 * extension's hooks cannot fire inside the session this extension started. That
 * is the recursion the front door would otherwise have: `pi-afk-runner` is
 * itself a Pi package.
 *
 * What a human sees when they come back to a session is `live.ts`: the status is
 * a session entry, so a session opened tomorrow shows the line the run ended on.
 *
 * The door itself is here. The queue it drives is `steering.ts`, the log it
 * shows is `logview.ts`, and the status line it writes is `live.ts`.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  InputEvent,
  InputEventResult,
} from "@earendil-works/pi-coding-agent";
import { QueueController } from "pi-queue-steer-factory/headless";

import {
  errorMessage,
  parseArgs,
  piSessionFactory,
  resolveRepo,
  runOptionsFrom,
  type CliOptions,
} from "./cli.js";
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { runGit, workBranch } from "./git.js";
import { RUN_STATUS_ENTRY, statusFromEntries, statusLine, type RunStatus } from "./live.js";
import { takeLock, type Lock } from "./lock.js";
import { logLine } from "./logview.js";
import { RunFailed, newRunId, runOnce, type RunOptions, type RunResult } from "./runner.js";
import type { SessionEvent, SessionFactory } from "./session.js";
import { deliverRow, follow, steeringFactory, type SteerableSession } from "./steering.js";
import { PINNED_PI_RANGE, assertInstalledPiVersion, installedPiVersion } from "./version.js";

/** The key the run's status line is published under. */
export const STATUS_KEY = "afk-runner";

/** The key the run's live log is published under. */
export const LOG_KEY = "afk-runner-log";

/** How many lines of the work session the host shows. */
export const LOG_LINES = 6;

/**
 * The model reference of the session the human is in, or null.
 *
 * `/afk-runner-run` with no `--model` runs on the model the human already chose:
 * a run that quietly used a different one would be a different run.
 */
export function hostModel(model: { readonly provider: string; readonly id: string } | undefined): string | null {
  return model === undefined ? null : `${model.provider}/${model.id}`;
}

/** What the front door needs that a test replaces. */
export interface LiveDependencies {
  /** The session the run works in. The runner's own factory when it is absent. */
  readonly session?: SessionFactory;
  /** The run itself. One issue, worked to its end; `runOnce` when it is absent. */
  readonly work?: (options: RunOptions) => Promise<RunResult>;
}

/** The run in flight, as the host session sees it. */
interface LiveRun {
  readonly controller: QueueController;
  /** Null until the run has taken an issue. */
  status: RunStatus | null;
}

/**
 * What is needed to open the run's session as a chat, kept after the run ends:
 * the transcript Pi switches to, and the worktree it was written in.
 */
interface LastRun {
  transcript: string | null;
  readonly worktreePath: string;
  readonly branch: string;
  readonly remote: string;
  readonly checkout: string;
}

/**
 * The state the door shares.
 *
 * It is one object and not six variables, so that a run cannot keep one field of
 * the last run and reset the rest: `resetRun` sets all of them at once.
 */
interface DoorState {
  /** The run in flight. */
  live: LiveRun | null;
  /** The session the queue's rows are delivered into. */
  session: SteerableSession | null;
  /** The work session, once the run has created it. */
  workSession: SteerableSession | null;
  /** Whether the agent has a turn running: an abort only means something then. */
  working: boolean;
  /** Whether the human stopped this run: the prompt array asks before every turn. */
  stopped: boolean;
  /** What is needed to open the run's session as a chat. */
  last: LastRun | null;
  /** The last lines of the work session, as the host shows them. */
  log: string[];
  /** The auto-attach of the run under way, so the run can wait for it before the worktree goes. */
  autoAttach: Promise<void> | null;
  /** The session that started the run, when it is still there. */
  hostContext: ExtensionCommandContext | null;
}

/** A run that is ready to be worked: the options it runs with, and the lock it holds. */
interface Prepared {
  readonly options: CliOptions & { readonly repo: string };
  readonly lock: Lock;
}

/**
 * Reset the state a run owns, in one place.
 *
 * A run that keeps one field of the last run keeps the last run's claims on the
 * world: the log it shows, the flag that says the human stopped it, and the
 * transcript its chat would switch to.
 */
function resetRun(state: DoorState, run: LiveRun): void {
  state.live = run;
  state.log.length = 0;
  state.working = false;
  state.stopped = false;
  state.last = null;
  state.workSession = null;
  state.autoAttach = null;
}

/**
 * What a run's outcome is said in, and how loudly.
 *
 * One place for the three outcomes a run can have, so that a sentence is said
 * the same way wherever it is said from: a run that worked nothing is not a
 * failure, and a run that could not work its issue says why.
 */
export function report(
  result: RunResult,
  options: { readonly issue?: number | undefined },
): { readonly message: string; readonly kind: "info" | "warning" } {
  if (result.outcome === "unworkable") {
    const issueNumber = result.issue ?? options.issue;
    let reason: string;
    if (result.derivedState === "Claimed") {
      reason = "it is held by another runner";
    } else if (result.derivedState === "Reviewed") {
      reason = "already reviewed";
    } else if (result.derivedState === "Counted") {
      reason = "already counted";
    } else {
      reason = "check whether it is claimed by another runner, already reviewed, or already counted";
    }
    return {
      message: `afk-runner: issue ${issueNumber ?? ""} could not be worked — ${reason}`,
      kind: "warning",
    };
  }
  if (result.outcome === "empty") {
    return {
      message: "afk-runner: the queue is empty — there was nothing to work",
      kind: "info",
    };
  }
  return {
    message: `afk-runner: worked issue ${result.issue} — the record is at ${result.record}`,
    kind: "info",
  };
}

/** The live front door: one run at a time, and the human's corrections delivered into it. */
export interface LiveFrontDoor {
  /** Start one run. It reports through the session's UI and returns without waiting for it. */
  start(args: string, ctx: ExtensionCommandContext): Promise<void>;
  /** What a line typed in the host session means. */
  steer(event: InputEvent, ctx: ExtensionContext): Promise<InputEventResult>;
  /** Show the status a session remembered, when somebody opens it again. */
  recall(ctx: ExtensionContext): void;
  /** Stop the run in flight: abort its session, which lets it release its claim. */
  stop(ctx: ExtensionContext): void;
  /** The host is going away: abort, best effort, so the run can release its claim. */
  abandon(): void;
  /** Open the run's session as this chat: Pi switches to its transcript. */
  attach(ctx: ExtensionCommandContext): Promise<void>;
}

export function liveFrontDoor(
  pi: ExtensionAPI,
  dependencies: LiveDependencies = {},
): LiveFrontDoor {
  const state: DoorState = {
    live: null,
    session: null,
    workSession: null,
    working: false,
    stopped: false,
    last: null,
    log: [],
    autoAttach: null,
    hostContext: null,
  };

  /**
   * Say what the run is doing: the footer, and the entry a reconnected session
   * reads. A stage, when one is given, is the step the run has reached.
   */
  const publish = (ctx: ExtensionContext, run: LiveRun, stage?: string): void => {
    if (stage !== undefined) {
      if (run.status === null) {
        return;
      }
      run.status = { ...run.status, stage };
    }
    try {
      if (run.status !== null) {
        pi.appendEntry(RUN_STATUS_ENTRY, run.status);
      }
      ctx.ui.setStatus(STATUS_KEY, run.status === null ? undefined : statusLine(run.status));
    } catch {
      // A session switch deactivates the runner this context was made for. The run
      // goes on, and the line is restored from the entry when the session is opened.
    }
  };

  /** Add one line of the work session to the log the host shows. */
  const mirror = (ctx: ExtensionContext, event: SessionEvent): void => {
    if (event.type === "agent_start") {
      state.working = true;
    } else if (event.type === "agent_settled") {
      state.working = false;
    }
    const line = logLine(event);
    if (line === null) {
      return;
    }
    state.log.push(line);
    if (state.log.length > LOG_LINES) {
      state.log.splice(0, state.log.length - LOG_LINES);
    }
    try {
      ctx.ui.setWidget(LOG_KEY, [...state.log], { placement: "aboveEditor" });
    } catch {
      // The session is gone; the record on disk still has the run.
    }
  };

  /**
   * Say something to the session that started the run, when that session is
   * still there. A run outlives a session switch, and its notifications do not.
   */
  const talk = (
    ctx: ExtensionContext,
    message: string,
    kind: "info" | "warning" | "error",
  ): void => {
    try {
      ctx.ui.notify(message, kind);
    } catch {
      // The session is gone. Its record, not its footer, is what survives.
    }
  };

  /**
   * Parse the command, resolve the repository, and take the lock.
   *
   * Everything that can refuse the run happens here, before the door holds
   * anything: a wrong command, a repository that is not there, a lock another
   * runner holds.
   */
  const prepare = async (
    args: string,
    ctx: ExtensionCommandContext,
  ): Promise<Prepared | null> => {
    let options: CliOptions & { readonly repo: string };
    try {
      // The repository is the checkout's `origin` unless the command names one.
      options = await resolveRepo(
        parseArgs(args.trim().split(/\s+/).filter((token) => token !== "")),
      );
    } catch (failure) {
      talk(ctx, `afk-runner: ${errorMessage(failure)}`, "error");
      return null;
    }
    if (options.all === true) {
      talk(ctx, "afk-runner: --all is the CLI's sweep; this command works one issue", "warning");
      return null;
    }
    let lock: Lock;
    try {
      lock = await takeLock(options.lockDirectory);
    } catch (failure) {
      // A held lock and an unusable one both mean "not this runner, not now", and
      // both already say which.
      talk(ctx, `afk-runner: ${errorMessage(failure)}`, "error");
      return null;
    }
    return { options, lock };
  };

  /**
   * The run the door owns: the queue controller it steers, the status it shows,
   * and the options the work runs with.
   *
   * The run is made ready here — the door's state is reset to it, its status is
   * published, and the queue is unpaused — so that `start` has nothing left to
   * do but hand the run over to the loop.
   */
  const makeRun = async (
    options: CliOptions & { readonly repo: string },
    ctx: ExtensionCommandContext,
  ): Promise<{ readonly run: LiveRun; readonly runOptions: RunOptions }> => {
    const run: LiveRun = {
      status: null,
      controller: new QueueController({
        sessionId: newRunId(),
        ports: {
          send: (row, { boundary }) =>
            state.session === null
              ? Promise.resolve({ outcome: "rejected", error: "the run has no session yet" })
              : deliverRow(state.session, row, boundary),
        },
      }),
    };
    // The model is the one this session runs on unless the command names one.
    const model = options.model ?? hostModel(ctx.model) ?? undefined;
    const factory = steeringFactory(
      dependencies.session ??
        piSessionFactory({
          agentDirectory: options.agentDirectory,
          ...(model === undefined ? {} : { model }),
        }),
      (created) => {
        if (state.workSession === null) {
          state.workSession = created;
        }
        state.session = created;
        follow(created, run.controller, (event) => {
          if (state.workSession !== null && created === state.workSession) {
            mirror(ctx, event);
          }
        });
        // The work session is headless: there is no chat to join. Its transcript is
        // a file, and a human who wants the whole of it reads that file.
        const transcript = created.sessionManager?.getSessionFile();
        if (
          state.workSession === created &&
          transcript !== null &&
          transcript !== undefined &&
          state.last !== null &&
          state.last.transcript === null
        ) {
          state.last.transcript = transcript;
          talk(ctx, `afk-runner: the run's transcript is ${transcript}`, "info");
          if (state.hostContext !== null) {
            state.autoAttach = attach(state.hostContext, true).catch(() => {});
          }
        }
      },
    );
    const runOptions: RunOptions = {
      ...runOptionsFrom(options, factory),
      stopped: () => state.stopped,
      onIssue: (issue) => {
        run.status = { issue: issue.number, title: issue.title, stage: "" };
        publish(ctx, run);
        state.last = {
          transcript: null,
          worktreePath: join(options.worktreeRoot, `issue-${issue.number}`),
          branch: workBranch(issue.number),
          remote: options.remote,
          checkout: options.checkout,
        };
      },
      onStepStart: (step) => {
        if (run.status === null) {
          return;
        }
        run.status = { ...run.status, stage: step };
        publish(ctx, run);
      },
    };
    resetRun(state, run);
    // A run that selects nothing must not leave the previous run's line standing.
    publish(ctx, run);
    // The hold starts paused, so that constructing a queue cannot send anything.
    // Only a boundary may, and this is the one that unpauses it.
    await run.controller.request({
      version: 1,
      requestId: newRunId(),
      operation: { type: "resume" },
    });
    return { run, runOptions };
  };

  /**
   * The run itself: the work, what came of it, and the cleanup either way.
   */
  const runLoop = async (
    ctx: ExtensionCommandContext,
    run: LiveRun,
    runOptions: RunOptions,
    prepared: Prepared,
  ): Promise<void> => {
    try {
      const result = await (dependencies.work ?? runOnce)(runOptions);
      const said = report(result, { issue: prepared.options.issue });
      talk(ctx, said.message, said.kind);
      publish(ctx, run, "done");
    } catch (failure) {
      publish(ctx, run, failure instanceof RunFailed ? `failed (${failure.step})` : "failed");
      talk(ctx, `afk-runner: ${errorMessage(failure)}`, "error");
    } finally {
      // A correction typed after the session's last boundary has nowhere to go.
      const undelivered = run.controller.snapshot().rows.length;
      if (undelivered > 0) {
        talk(
          ctx,
          `afk-runner: the run had already finished — ${undelivered} correction(s) were not delivered`,
          "warning",
        );
      }
      await run.controller.dispose();
      state.session = null;
      state.workSession = null;
      state.working = false;
      state.live = null;
      // The auto-attach moved this chat into the run's session, whose working
      // directory is the worktree the run has just removed as scratch. Put it
      // back, or the chat this run switched to is left standing in a directory
      // that is gone.
      if (state.autoAttach !== null) {
        await state.autoAttach;
        if (state.last !== null) {
          const problem = await restoreWorktree(state.last);
          if (problem !== null) {
            talk(
              ctx,
              `afk-runner: the worktree this chat is in would not come back: ${problem}`,
              "error",
            );
          }
        }
      }
      try {
        ctx.ui.setWidget(LOG_KEY, undefined);
      } catch {
        // The session is gone; so is its log.
      }
      await prepared.lock.release();
    }
  };

  const start = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    state.hostContext = ctx;
    if (state.live !== null) {
      talk(ctx, "afk-runner: a run is already under way", "warning");
      return;
    }
    const prepared = await prepare(args, ctx);
    if (prepared === null) {
      return;
    }
    const { run, runOptions } = await makeRun(prepared.options, ctx);
    void runLoop(ctx, run, runOptions, prepared);
  };

  const steer = async (
    event: InputEvent,
    ctx: ExtensionContext,
  ): Promise<InputEventResult> => {
    const run = state.live;
    if (run === null) {
      return { action: "continue" };
    }
    // A slash command or a shell line is the host session's own surface, not a
    // correction to the run.
    if (event.text.startsWith("/") || event.text.startsWith("!")) {
      return { action: "continue" };
    }
    const reply = await run.controller.request({
      version: 1,
      requestId: newRunId(),
      operation: {
        type: "enqueue",
        lane: "steer",
        text: event.text,
        ...(event.images === undefined ? {} : { images: event.images }),
      },
    });
    if (!reply.ok) {
      talk(ctx, `afk-runner: ${reply.error}`, "error");
      return { action: "continue" };
    }
    talk(ctx, "afk-runner: queued as steering", "info");
    return { action: "handled" };
  };

  /**
   * Stop the run the way its own deadline stops it: abort the session.
   *
   * The abort is not a kill. The session step sees a cut-off turn, the run fails
   * where it stands, and the failure path releases the claim and the worktree —
   * while the branch keeps the commits it has, which is what the next attempt
   * needs. Killing the process instead leaves the claim to go stale.
   */
  const stop = (ctx: ExtensionContext): void => {
    const run = state.live;
    if (run === null) {
      talk(ctx, "afk-runner: no run is under way", "info");
      return;
    }
    const targetSession = state.workSession ?? state.session;
    if (targetSession === null || !state.working) {
      // The agent is between turns, or done and the run is pushing. There is
      // nothing to cut, and saying "stopping" would be a lie.
      const stage = run.status === null ? "selecting" : run.status.stage;
      talk(
        ctx,
        `afk-runner: the agent is not working — the run is at "${stage === "" ? "selecting" : stage}"`,
        "info",
      );
      return;
    }
    state.stopped = true;
    talk(ctx, "afk-runner: stopping — the run releases its claim when the turn ends", "warning");
    void targetSession.abort().catch((failure: unknown) => {
      talk(ctx, `afk-runner: the session would not abort: ${errorMessage(failure)}`, "error");
    });
  };

  /**
   * The session that owns the run is going away — quit, reload, new, resume or
   * fork. Whichever it is, the session with its UI and steering is gone, so the
   * run is aborted and its own failure path takes over.
   */
  const abandon = (): void => {
    const targetSession = state.workSession ?? state.session;
    if (targetSession !== null && state.working) {
      state.stopped = true;
      void targetSession.abort().catch(() => {});
    }
  };

  /**
   * Put the worktree back where the run had it, so a session whose working
   * directory is that path can read again. Returns why it could not, or null.
   */
  const restoreWorktree = async (target: {
    readonly worktreePath: string;
    readonly branch: string;
    readonly remote: string;
    readonly checkout: string;
  }): Promise<string | null> => {
    const targetPath = resolve(target.worktreePath);
    const prune = async (): Promise<void> => {
      try {
        await runGit(["worktree", "prune"], { cwd: target.checkout });
      } catch {}
    };
    const registered = async (): Promise<boolean> => {
      try {
        const list = await runGit(["worktree", "list", "--porcelain"], { cwd: target.checkout });
        return list.split("\n").some((line) => {
          if (!line.startsWith("worktree ")) return false;
          const p = line.slice("worktree ".length).trim();
          return resolve(p) === targetPath || p === target.worktreePath || p === targetPath;
        });
      } catch {
        return false;
      }
    };
    const add = async (args: readonly string[]): Promise<string | null> => {
      try {
        await runGit(args, { cwd: target.checkout });
        return null;
      } catch (failure) {
        return errorMessage(failure);
      }
    };
    const addBranch = (): Promise<string | null> =>
      add(["worktree", "add", targetPath, target.branch]);
    // A review-only run leaves a detached worktree and may have no local branch.
    // On a single-branch clone the branch also has no remote-tracking ref, so put
    // the chat on the fetched commit itself.
    const addDetached = async (): Promise<string | null> => {
      const tracking = `refs/remotes/${target.remote}/${target.branch}`;
      await runGit(["fetch", target.remote, `${target.branch}:${tracking}`], {
        cwd: target.checkout,
      }).catch(() => {});
      return add(["worktree", "add", "--detach", targetPath, tracking]);
    };

    await prune();
    if (existsSync(targetPath)) {
      if (await registered()) {
        return null;
      }
      // A directory git does not know would make `worktree add` refuse.
      try {
        rmSync(targetPath, { recursive: true, force: true });
      } catch {}
      await prune();
    }
    const first = await addBranch();
    if (first === null) {
      return null;
    }
    if (first.includes("already exists")) {
      // A registration prune missed: forget the tree and try once more.
      try {
        rmSync(targetPath, { recursive: true, force: true });
      } catch {}
      await prune();
      const second = await addBranch();
      if (second === null) {
        return null;
      }
    }
    return addDetached();
  };

  /**
   * Open the run's session as this chat.
   *
   * The work session is headless while it runs, but its transcript is a Pi
   * session file: switching to it gives the human a real chat with the same
   * history — a session they can read, and carry on from. The worktree is
   * restored first when the run's own cleanup has removed it, because a session
   * whose working directory is gone can read nothing.
   */
  const attach = async (ctx: ExtensionCommandContext, force = false): Promise<void> => {
    if (state.last === null || state.last.transcript === null) {
      talk(ctx, "afk-runner: this session has no run to attach to yet", "info");
      return;
    }
    if (state.working && !force) {
      talk(
        ctx,
        "afk-runner: the agent is working — /afk-runner-stop first, or /afk-runner-attach when it settles",
        "warning",
      );
      return;
    }
    const target = state.last;
    const problem = await restoreWorktree(target);
    if (problem !== null) {
      talk(
        ctx,
        `afk-runner: the worktree would not come back, so the session would have nowhere to work: ${problem}`,
        "error",
      );
      return;
    }
    try {
      const switched = await ctx.switchSession(target.transcript as string);
      if (switched.cancelled) {
        talk(ctx, "afk-runner: the switch was cancelled", "info");
      }
    } catch (failure) {
      talk(
        ctx,
        `afk-runner: the session could not be opened: ${errorMessage(failure)}`,
        "error",
      );
    }
  };

  const recall = (ctx: ExtensionContext): void => {
    const remembered = statusFromEntries(ctx.sessionManager.getEntries());
    if (remembered !== null) {
      ctx.ui.setStatus(STATUS_KEY, statusLine(remembered));
    }
  };

  return { start, steer, recall, stop, abandon, attach };
}

export default function activate(pi: ExtensionAPI): void {
  assertInstalledPiVersion();

  const door = liveFrontDoor(pi);

  pi.registerCommand("afk-runner-version", {
    description:
      "Show the Pi version this session runs against and the range this extension supports",
    handler: async (_args, ctx) => {
      const installed = installedPiVersion();
      ctx.ui.notify(
        `Pi ${installed} — this extension is written for ${PINNED_PI_RANGE}`,
        "info",
      );
    },
  });

  pi.registerCommand("afk-runner-run", {
    description: "Work one issue from the queue in a session this extension owns",
    handler: (args, ctx) => door.start(args, ctx),
  });

  pi.registerCommand("afk-runner-attach", {
    description: "Open the last run's session as this chat, with its whole history",
    handler: async (_args, ctx) => door.attach(ctx),
  });

  pi.registerCommand("afk-runner-stop", {
    description: "Stop the run under way: the agent's turn is cut, and the claim is released",
    handler: async (_args, ctx) => door.stop(ctx),
  });

  pi.on("input", (event, ctx) => door.steer(event, ctx));
  pi.on("session_start", (_event, ctx) => door.recall(ctx));
  // A run lives in the host's process. Left alone when the session ends, it keeps
  // its claim until the staleness window passes — a week by default.
  pi.on("session_shutdown", () => door.abandon());
}

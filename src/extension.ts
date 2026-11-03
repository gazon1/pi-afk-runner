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

/** How many lines of the session in flight the host shows. */
export const LOG_LINES = 6;

<<<<<<< HEAD
/** One event from the session the runner drives, as far as this module reads it. */
export interface SessionEvent {
  readonly type: string;
  /** `tool_execution_start`: the tool, and its input. */
  readonly toolName?: string;
  readonly args?: unknown;
  /** `message_end`: the finished message. */
  readonly message?: { readonly role?: string; readonly content?: unknown };
}

/**
 * The part of Pi's session the steer path drives beyond the prompt array.
 *
 * It is the SDK's own session: `piSessionFactory` returns the real thing, and
 * `AgentSession` is the narrow face of it the prompt array needs.
 */
export interface SteerableSession extends AgentSession {
  /** Send a turn, with the images the human attached. */
  prompt(text: string, options?: { readonly images?: QueueRow["images"] }): Promise<void>;
  /** Queue a message for after the assistant turn that is running. */
  steer(text: string, images?: QueueRow["images"]): Promise<unknown>;
  /** Queue a message for when the agent would otherwise stop. */
  followUp(text: string, images?: QueueRow["images"]): Promise<unknown>;
  /** Observe the session's lifecycle, which is where a delivery boundary is. */
  subscribe(listener: (event: SessionEvent) => void): () => void;
  /** Where the session writes its own transcript, when it writes one. */
  readonly sessionManager?: { getSessionFile(): string | null };
}

/**
 * The factory the run uses, with the session it creates handed to `attach`.
 *
 * The runner creates the session and owns it. A human watching needs a handle on
 * the same object to deliver a correction into it, and wrapping the factory is
 * the one place both are true at once.
 */
export function steeringFactory(
  inner: SessionFactory,
  attach: (session: SteerableSession) => void,
): SessionFactory {
  return async (options) => {
    const session = (await inner(options)) as SteerableSession;
    attach(session);
    return session;
  };
}

/**
 * What one session event means to the queue: its lifecycle, and the boundary it
 * opens.
 *
 * The queue never sends on its own — no timer, no enqueue — so a row leaves at a
 * boundary the session reports, or not at all.
 */
export function boundaryOf(event: {
  readonly type: string;
}): { readonly observe: QueueLifecycle; readonly boundary: QueueBoundary | null } | null {
  switch (event.type) {
    case "agent_start":
      return { observe: { type: "agent-start" }, boundary: null };
    case "turn_end":
      return { observe: { type: "tail", phase: "turn" }, boundary: "turn-end" };
    case "agent_end":
      return { observe: { type: "tail", phase: "agent" }, boundary: "agent-end" };
    case "agent_settled":
      return { observe: { type: "settled" }, boundary: "settled" };
    default:
      return null;
  }
}

/** A text block of a message, or not. */
function isTextBlock(block: unknown): block is { readonly text: string } {
  return (
    typeof block === "object" &&
    block !== null &&
    "text" in block &&
    typeof (block as { readonly text: unknown }).text === "string"
  );
}

/**
 * The first line of an assistant message, or null.
 *
 * A watcher wants the line the agent would say out loud, not a dump of its whole
 * message: the tool calls are already the line above.
 */
function assistantLine(message: SessionEvent["message"]): string | null {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) {
    return null;
  }
  const text = message.content
    .flatMap((block) => (isTextBlock(block) ? [block.text] : []))
    .join("\n");
  const line = text.split("\n").find((part) => part.trim() !== "")?.trim() ?? "";
  if (line === "") {
    return null;
  }
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/**
 * What one session event adds to the host's view of the run, or null.
 *
 * The log is a view of the session in flight — the tools it runs and the lines
 * it says — because a human watching a run cannot otherwise see, from the
 * session they are typing in, what the run is doing.
 */
export function logLine(event: SessionEvent): string | null {
  switch (event.type) {
    case "tool_execution_start":
      return event.toolName === undefined
        ? null
        : `→ ${describeToolCall({ toolName: event.toolName, input: event.args })}`;
    case "message_end": {
      const line = assistantLine(event.message);
      return line === null ? null : `· ${line}`;
    }
    default:
      return null;
  }
}

/**
 * Deliver one queued row into the session it belongs to.
 *
 * A row that arrives when the agent is idle starts a turn; a steer lands between
 * the turn's tool calls and the next model call; anything else waits for the
 * agent to stop.
 */
export async function deliverRow(
  session: SteerableSession,
  row: Pick<QueueRow, "lane" | "text" | "images">,
  boundary: QueueBoundary,
): Promise<{ readonly outcome: "completed" }> {
  const images = row.images.length === 0 ? undefined : row.images;
  if (boundary === "settled") {
    await session.prompt(row.text, images === undefined ? {} : { images });
  } else if (row.lane === "steer") {
    await session.steer(row.text, images);
  } else {
    await session.followUp(row.text, images);
  }
  return { outcome: "completed" };
}

=======
>>>>>>> 32c4aef (the agent's work)
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
  /**
   * Stop the run in flight: it ends at its next boundary, and the turn it is
   * in is cut. The failure path releases the claim.
   */
  stop(ctx: ExtensionContext): void;
  /** The host is going away: stop the run, best effort, so it releases its claim. */
  abandon(): void;
  /** Open the run's session as this chat: Pi switches to its transcript. */
  attach(ctx: ExtensionCommandContext): Promise<void>;
}

export function liveFrontDoor(
  pi: ExtensionAPI,
  dependencies: LiveDependencies = {},
): LiveFrontDoor {
<<<<<<< HEAD
  let live: LiveRun | null = null;
  /** The session the run is driving now: the work session first, then the review's. */
  let session: SteerableSession | null = null;
  /** The session whose turn is running: an abort only means something then. */
  let turning: SteerableSession | null = null;
  /** Whether the human stopped this run: the run asks before every turn and step. */
  let stopped = false;
  /**
   * What is needed to open the run's session as a chat, kept after the run ends:
   * the transcript Pi switches to, and the worktree it was written in.
   */
  let last: {
    transcript: string | null;
    readonly worktreePath: string;
    readonly branch: string;
    readonly remote: string;
    readonly checkout: string;
  } | null = null;
  /** The last lines of the session in flight, as the host shows them. */
  const log: string[] = [];
=======
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
>>>>>>> 32c4aef (the agent's work)

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

  /**
   * Add one line of the session in flight to the log the host shows, and keep
   * track of whether a turn is running.
   *
   * A session the run has left behind says nothing about what the run is doing
   * now: the work session is finished before the review's session is made, and
   * its last events arrive after the review has started.
   */
  const mirror = (
    ctx: ExtensionContext,
    event: SessionEvent,
    source: SteerableSession,
  ): void => {
    if (source !== session) {
      return;
    }
    if (event.type === "agent_start") {
<<<<<<< HEAD
      turning = source;
    } else if (event.type === "agent_settled" && turning === source) {
      turning = null;
=======
      state.working = true;
    } else if (event.type === "agent_settled") {
      state.working = false;
>>>>>>> 32c4aef (the agent's work)
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
<<<<<<< HEAD
    if (options.merge === true) {
      talk(ctx, "afk-runner: --merge is the CLI's mode; this command works one issue", "warning");
      return;
    }
    // The model is the one this session runs on unless the command names one.
    const model = options.model ?? hostModel(ctx.model) ?? undefined;

    let lock: Awaited<ReturnType<typeof takeLock>>;
=======
    let lock: Lock;
>>>>>>> 32c4aef (the agent's work)
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
<<<<<<< HEAD
    live = run;
    log.length = 0;
    turning = null;
    stopped = false;
    last = null;
    autoAttach = null;
    // A run that selects nothing must not leave the previous run's line standing.
    publish(ctx, run);
    // The hold starts paused, so that constructing a queue cannot send anything.
    // Only a boundary may, and this is the one that unpauses it.
    await run.controller.request({
      version: 1,
      requestId: newRunId(),
      operation: { type: "resume" },
    });

    // The work session is the first session the run creates; the review's
    // session comes later. The transcript the human attaches to is the work
    // session's, so the first one is the one that counts.
    let firstSession = true;

=======
    // The model is the one this session runs on unless the command names one.
    const model = options.model ?? hostModel(ctx.model) ?? undefined;
>>>>>>> 32c4aef (the agent's work)
    const factory = steeringFactory(
      dependencies.session ??
        piSessionFactory({
          agentDirectory: options.agentDirectory,
          ...(model === undefined ? {} : { model }),
        }),
      (created) => {
<<<<<<< HEAD
        const isWorkSession = firstSession;
        firstSession = false;
        // One session in flight: the newest one the run drives. The work
        // session is the first; the review's session replaces it when the run
        // reaches the review.
        session = created;
        // The session before this one is finished, so no turn of it is running.
        turning = null;
        // The log is a view of the session in flight: the finished session's
        // lines are not the run's present.
        log.length = 0;
        try {
          ctx.ui.setWidget(LOG_KEY, [], { placement: "aboveEditor" });
        } catch {
          // The session is gone; so is its log.
        }
        follow(created, run.controller, (event) => {
          mirror(ctx, event, created);
=======
        if (state.workSession === null) {
          state.workSession = created;
        }
        state.session = created;
        follow(created, run.controller, (event) => {
          if (state.workSession !== null && created === state.workSession) {
            mirror(ctx, event);
          }
>>>>>>> 32c4aef (the agent's work)
        });
        // The work session is headless: there is no chat to join. Its transcript is
        // a file, and a human who wants the whole of it reads that file.
        const transcript = created.sessionManager?.getSessionFile();
        if (
<<<<<<< HEAD
          isWorkSession &&
=======
          state.workSession === created &&
>>>>>>> 32c4aef (the agent's work)
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
<<<<<<< HEAD
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
        session = null;
        turning = null;
        live = null;
        // The auto-attach moved this chat into the run's session, whose working
        // directory is the worktree the run has just removed as scratch. Put it
        // back, or the chat this run switched to is left standing in a directory
        // that is gone.
        if (autoAttach !== null) {
          await autoAttach;
          if (last !== null) {
            const problem = await restoreWorktree(last);
            if (problem !== null) {
              talk(
                ctx,
                `afk-runner: the worktree this chat is in would not come back: ${problem}`,
                "error",
              );
            }
=======
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
>>>>>>> 32c4aef (the agent's work)
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
   * Stop the run: it ends at the next boundary, and the turn it is in is cut.
   *
   * The stop is a flag the run reads, not a kill. The prompt array asks it
   * before every turn, the step loop asks it before every step, and the
   * failure path releases the claim and the worktree — while the branch keeps
   * the commits it has, which is what the next attempt needs. Killing the
   * process instead leaves the claim to go stale.
   *
   * A turn is cut only when there is one to cut. A stop typed between two of
   * the agent's turns has no turn to reach, and the run ends before its next
   * step instead — which is what the flag is for.
   */
  const stop = (ctx: ExtensionContext): void => {
    const run = state.live;
    if (run === null) {
      talk(ctx, "afk-runner: no run is under way", "info");
      return;
    }
<<<<<<< HEAD
    stopped = true;
    const stage = run.status === null ? "selecting" : run.status.stage;
    const where = stage === "" ? "selecting" : stage;
    if (turning === null) {
=======
    const targetSession = state.workSession ?? state.session;
    if (targetSession === null || !state.working) {
      // The agent is between turns, or done and the run is pushing. There is
      // nothing to cut, and saying "stopping" would be a lie.
      const stage = run.status === null ? "selecting" : run.status.stage;
>>>>>>> 32c4aef (the agent's work)
      talk(
        ctx,
        `afk-runner: stopping — no turn is running; the run is at "${where}" ` +
          "and ends before its next step",
        "warning",
      );
      return;
    }
<<<<<<< HEAD
    talk(
      ctx,
      "afk-runner: stopping — the turn is cut, and the run ends before its next step",
      "warning",
    );
    void turning.abort().catch((failure: unknown) => {
=======
    state.stopped = true;
    talk(ctx, "afk-runner: stopping — the run releases its claim when the turn ends", "warning");
    void targetSession.abort().catch((failure: unknown) => {
>>>>>>> 32c4aef (the agent's work)
      talk(ctx, `afk-runner: the session would not abort: ${errorMessage(failure)}`, "error");
    });
  };

  /**
   * The session that owns the run is going away — quit, reload, new, resume or
   * fork. Whichever it is, the session with its UI and steering is gone, so the
   * run is stopped and its own failure path takes over.
   */
  const abandon = (): void => {
<<<<<<< HEAD
    stopped = true;
    if (turning !== null) {
      void turning.abort().catch(() => {});
=======
    const targetSession = state.workSession ?? state.session;
    if (targetSession !== null && state.working) {
      state.stopped = true;
      void targetSession.abort().catch(() => {});
>>>>>>> 32c4aef (the agent's work)
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
<<<<<<< HEAD
    if (turning !== null && !force) {
=======
    if (state.working && !force) {
>>>>>>> 32c4aef (the agent's work)
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
    description:
      "Stop the run under way: the turn is cut, and the run ends at its next boundary",
    handler: async (_args, ctx) => door.stop(ctx),
  });

  pi.on("input", (event, ctx) => door.steer(event, ctx));
  pi.on("session_start", (_event, ctx) => door.recall(ctx));
  // A run lives in the host's process. Left alone when the session ends, it keeps
  // its claim until the staleness window passes — a week by default.
  pi.on("session_shutdown", () => door.abandon());
}

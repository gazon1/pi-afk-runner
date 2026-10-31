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
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  InputEvent,
  InputEventResult,
} from "@earendil-works/pi-coding-agent";
import {
  QueueController,
  type QueueBoundary,
  type QueueLifecycle,
  type QueueRow,
} from "pi-queue-steer-factory/headless";

import {
  describeToolCall,
  errorMessage,
  parseArgs,
  piSessionFactory,
  resolveRepo,
  runOptionsFrom,
  type CliOptions,
} from "./cli.js";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { runGit, workBranch } from "./git.js";
import { RUN_STATUS_ENTRY, statusFromEntries, statusLine, type RunStatus } from "./live.js";
import { takeLock } from "./lock.js";
import { RunFailed, newRunId, runOnce, type RunOptions, type RunResult } from "./runner.js";
import type { AgentSession, SessionFactory } from "./session.js";
import { PINNED_PI_RANGE, assertInstalledPiVersion, installedPiVersion } from "./version.js";

/** The key the run's status line is published under. */
export const STATUS_KEY = "afk-runner";

/** The key the run's live log is published under. */
export const LOG_KEY = "afk-runner-log";

/** How many lines of the work session the host shows. */
export const LOG_LINES = 6;

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
 * The log is a view of the work session — the tools it runs and the lines it
 * says — because a human watching a run cannot otherwise see, from the session
 * they are typing in, what the run is doing.
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

/**
 * Drive the queue and the log from the session's own lifecycle.
 *
 * The dispatch's outcome is reported through the queue's own snapshot; a
 * rejection here would be an unhandled one inside an event listener, and it
 * would stop the observations that come after it.
 */
function follow(
  session: SteerableSession,
  controller: QueueController,
  mirror: (event: SessionEvent) => void,
): void {
  session.subscribe((event) => {
    mirror(event);
    const at = boundaryOf(event);
    if (at === null) {
      return;
    }
    controller.observe(at.observe);
    if (at.boundary !== null) {
      void controller.dispatch(at.boundary).catch(() => {});
    }
  });
}

export function liveFrontDoor(
  pi: ExtensionAPI,
  dependencies: LiveDependencies = {},
): LiveFrontDoor {
  let live: LiveRun | null = null;
  let session: SteerableSession | null = null;
  let workSession: SteerableSession | null = null;
  /** Whether the agent has a turn running: an abort only means something then. */
  let working = false;
  /** Whether the human stopped this run: the prompt array asks before every turn. */
  let stopped = false;
  /**
   * What is needed to open the run's session as a chat, kept after the run ends:
   * the transcript Pi switches to, and the worktree it was written in.
   */
  let last: {
    transcript: string | null;
    readonly worktreePath: string;
    readonly branch: string;
    readonly checkout: string;
  } | null = null;
  /** The last lines of the work session, as the host shows them. */
  const log: string[] = [];

  /**
   * Say what the run is doing: the footer, and the entry a reconnected session
   * reads.
   */
  const publish = (ctx: ExtensionContext, run: LiveRun): void => {
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
      working = true;
    } else if (event.type === "agent_settled") {
      working = false;
    }
    const line = logLine(event);
    if (line === null) {
      return;
    }
    log.push(line);
    if (log.length > LOG_LINES) {
      log.splice(0, log.length - LOG_LINES);
    }
    try {
      ctx.ui.setWidget(LOG_KEY, [...log], { placement: "aboveEditor" });
    } catch {
      // The session is gone; the record on disk still has the run.
    }
  };

  /** The stage a run ended on. The word is the runner's: "done", or the step it stopped at. */
  const finish = (ctx: ExtensionContext, run: LiveRun, stage: string): void => {
    if (run.status === null) {
      return;
    }
    run.status = { ...run.status, stage };
    publish(ctx, run);
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

  let hostContext: ExtensionCommandContext | null = null;

  const start = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    hostContext = ctx;
    if (live !== null) {
      talk(ctx, "afk-runner: a run is already under way", "warning");
      return;
    }

    let options: CliOptions & { readonly repo: string };
    try {
      // The repository is the checkout's `origin` unless the command names one.
      options = await resolveRepo(
        parseArgs(args.trim().split(/\s+/).filter((token) => token !== "")),
      );
    } catch (failure) {
      talk(ctx, `afk-runner: ${errorMessage(failure)}`, "error");
      return;
    }
    // The model is the one this session runs on unless the command names one.
    const model = options.model ?? hostModel(ctx.model) ?? undefined;

    let lock: Awaited<ReturnType<typeof takeLock>>;
    try {
      lock = await takeLock(options.lockDirectory);
    } catch (failure) {
      // A held lock and an unusable one both mean "not this runner, not now", and
      // both already say which.
      talk(ctx, `afk-runner: ${errorMessage(failure)}`, "error");
      return;
    }

    const run: LiveRun = {
      status: null,
      controller: new QueueController({
        sessionId: newRunId(),
        ports: {
          send: (row, { boundary }) =>
            session === null
              ? Promise.resolve({ outcome: "rejected", error: "the run has no session yet" })
              : deliverRow(session, row, boundary),
        },
      }),
    };
    live = run;
    log.length = 0;
    working = false;
    stopped = false;
    last = null;
    workSession = null;
    // A run that selects nothing must not leave the previous run's line standing.
    publish(ctx, run);
    // The hold starts paused, so that constructing a queue cannot send anything.
    // Only a boundary may, and this is the one that unpauses it.
    await run.controller.request({
      version: 1,
      requestId: newRunId(),
      operation: { type: "resume" },
    });

    const factory = steeringFactory(
      dependencies.session ??
        piSessionFactory({
          agentDirectory: options.agentDirectory,
          ...(model === undefined ? {} : { model }),
        }),
      (created) => {
        if (workSession === null) {
          workSession = created;
        }
        session = created;
        follow(created, run.controller, (event) => {
          if (workSession !== null && created === workSession) {
            mirror(ctx, event);
          }
        });
        // The work session is headless: there is no chat to join. Its transcript is
        // a file, and a human who wants the whole of it reads that file.
        const transcript = created.sessionManager?.getSessionFile();
        if (
          workSession === created &&
          transcript !== null &&
          transcript !== undefined &&
          last !== null &&
          last.transcript === null
        ) {
          last.transcript = transcript;
          talk(ctx, `afk-runner: the run's transcript is ${transcript}`, "info");
          if (hostContext !== null) {
            void attach(hostContext, true).catch(() => {});
          }
        }
      },
    );

    const runOptions: RunOptions = {
      ...runOptionsFrom(options, factory),
      stopped: () => stopped,
      onIssue: (issue) => {
        run.status = { issue: issue.number, title: issue.title, stage: "" };
        publish(ctx, run);
        last = {
          transcript: null,
          worktreePath: join(options.worktreeRoot, `issue-${issue.number}`),
          branch: workBranch(issue.number),
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

    void (async () => {
      try {
        const result = await (dependencies.work ?? runOnce)(runOptions);
        if ((result.outcome as string) === "unworkable") {
          const issueNum = result.issue ?? options.issue;
          talk(
            ctx,
            `afk-runner: issue ${issueNum ?? ""} could not be worked — check whether it is claimed by another runner, already reviewed, or already counted`,
            "warning",
          );
          finish(ctx, run, "done");
        } else if (result.outcome === "empty") {
          talk(ctx, "afk-runner: the queue is empty — there was nothing to work", "info");
          finish(ctx, run, "done");
        } else {
          talk(
            ctx,
            `afk-runner: worked issue ${result.issue} — the record is at ${result.record}`,
            "info",
          );
          finish(ctx, run, "done");
        }
      } catch (failure) {
        finish(
          ctx,
          run,
          failure instanceof RunFailed ? `failed (${failure.step})` : "failed",
        );
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
        workSession = null;
        working = false;
        live = null;
        try {
          ctx.ui.setWidget(LOG_KEY, undefined);
        } catch {
          // The session is gone; so is its log.
        }
        await lock.release();
      }
    })();
  };

  const steer = async (
    event: InputEvent,
    ctx: ExtensionContext,
  ): Promise<InputEventResult> => {
    const run = live;
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
    const run = live;
    if (run === null) {
      talk(ctx, "afk-runner: no run is under way", "info");
      return;
    }
    const targetSession = workSession ?? session;
    if (targetSession === null || !working) {
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
    stopped = true;
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
    const targetSession = workSession ?? session;
    if (targetSession !== null && working) {
      stopped = true;
      void targetSession.abort().catch(() => {});
    }
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
    if (last === null || last.transcript === null) {
      talk(ctx, "afk-runner: this session has no run to attach to yet", "info");
      return;
    }
    if (working && !force) {
      talk(
        ctx,
        "afk-runner: the agent is working — /afk-runner-stop first, or /afk-runner-attach when it settles",
        "warning",
      );
      return;
    }
    const target = last;
    const targetPath = resolve(target.worktreePath);
    const worktreeExistsOnDisk = existsSync(targetPath);
    const isRegistered = async (): Promise<boolean> => {
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
    try {
      await runGit(["worktree", "prune"], { cwd: target.checkout });
    } catch {}
    if (worktreeExistsOnDisk && !(await isRegistered())) {
      try {
        rmSync(targetPath, { recursive: true, force: true });
      } catch {}
      try {
        await runGit(["worktree", "prune"], { cwd: target.checkout });
      } catch {}
    }
    if (existsSync(targetPath) && (await isRegistered())) {
      // already registered, just switch
    } else if (!existsSync(targetPath)) {
      try {
        await runGit(["worktree", "add", targetPath, target.branch], {
          cwd: target.checkout,
        });
      } catch (failure) {
        const msg = errorMessage(failure);
        if (msg.includes("already exists")) {
          try {
            rmSync(targetPath, { recursive: true, force: true });
          } catch {}
          try {
            await runGit(["worktree", "prune"], { cwd: target.checkout });
          } catch {}
          try {
            await runGit(["worktree", "add", targetPath, target.branch], {
              cwd: target.checkout,
            });
          } catch (failure2) {
            talk(
              ctx,
              `afk-runner: the worktree would not come back, so the session would have nowhere to work: ` +
                errorMessage(failure2),
              "error",
            );
            return;
          }
        } else {
          talk(
            ctx,
            `afk-runner: the worktree would not come back, so the session would have nowhere to work: ` +
              msg,
            "error",
          );
          return;
        }
      }
    } else {
      try {
        rmSync(targetPath, { recursive: true, force: true });
      } catch {}
      try {
        await runGit(["worktree", "prune"], { cwd: target.checkout });
      } catch {}
      try {
        await runGit(["worktree", "add", targetPath, target.branch], {
          cwd: target.checkout,
        });
      } catch (failure) {
        talk(
          ctx,
          `afk-runner: the worktree would not come back, so the session would have nowhere to work: ` +
            errorMessage(failure),
          "error",
        );
        return;
      }
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

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  InputEvent,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { isOwnExtension, piSessionFactory } from "../src/cli.js";
import { runCommand } from "../src/git.js";
import {
  LOG_KEY,
  STATUS_KEY,
  boundaryOf,
  isStaleContext,
  deliverRow,
  liveFrontDoor,
  hostModel,
  logLine,
  type SessionEvent,
  type SteerableSession,
} from "../src/extension.js";
import {
  GUARD_POLICY,
  GUARD_POLICY_PATH,
  guardExtensionPath,
  installGuardPolicy,
} from "../src/guard.js";
import { issueWorktreePath } from "../src/git.js";
import { RUN_STATUS_ENTRY, statusFromEntries, statusLine } from "../src/live.js";
import { takeLock } from "../src/lock.js";
import { unworkableReason, type RunOptions, type RunResult } from "../src/runner.js";
import { createFixtureRepository, gitOutput } from "./git-sandbox.js";


/** A promise and its settler, for a test that waits on a callback. */
function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let settle: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: () => settle() };
}

/** A fake host extension API: what the door registers, and what it writes down. */
function fakePi() {
  const commands: string[] = [];
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const entries: { customType: string; data: unknown }[] = [];
  const pi = {
    registerCommand: (name: string) => {
      commands.push(name);
    },
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(event, handler);
      return () => {};
    },
    appendEntry: (customType: string, data?: unknown) => {
      entries.push({ customType, data });
    },
  };
  return { pi: pi as unknown as ExtensionAPI, commands, handlers, entries };
}

/** A fake host context: the footer, the notifications, and the session's own entries. */
function fakeContext(
  options: {
    readonly entries?: readonly unknown[];
    readonly model?: { readonly provider: string; readonly id: string };
  } = {},
): {
  ctx: ExtensionCommandContext;
  statuses: Map<string, string | undefined>;
  notes: { message: string; kind: string }[];
  widgets: Map<string, readonly string[] | undefined>;
  switches: string[];
} {
  const statuses = new Map<string, string | undefined>();
  const notes: { message: string; kind: string }[] = [];
  const widgets = new Map<string, readonly string[] | undefined>();
  const switches: string[] = [];
  const ctx = {
    switchSession: async (path: string) => {
      switches.push(path);
      return { cancelled: false };
    },
    ui: {
      setStatus: (key: string, text: string | undefined) => {
        statuses.set(key, text);
      },
      setWidget: (key: string, content: readonly string[] | undefined) => {
        widgets.set(key, content);
      },
      notify: (message: string, kind = "info") => {
        notes.push({ message, kind });
      },
    },
    model: options.model,
    sessionManager: {
      getEntries: () => options.entries ?? [],
    },
  };
  return {
    ctx: ctx as unknown as ExtensionCommandContext,
    statuses,
    notes,
    widgets,
    switches,
  };
}

/** Where the fake session says its transcript is. */
const TRANSCRIPT = "/tmp/afk-e2e/transcript.jsonl";

/**
 * The repository's own setup script, as a fixture.
 *
 * It stands in for the real one: it writes the `.env` a worktree does not
 * have on its own, and it records that it ran next to the worktree, so a test
 * can count the preparations.
 */
const SETUP_SCRIPT_BODY = [
  "#!/usr/bin/env bash",
  "set -eu",
  'printf "prepared\\n" > .env',
  'printf "prepared\\n" >> "$(dirname "$PWD")/prepared.log"',
  "",
].join("\n");

/** A picture the human pasted, as the queue carries it. */
const IMAGE = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" };

/** What a delivery looked like, with a count when the human attached images. */
function withImages(
  kind: string,
  text: string,
  images: readonly unknown[] | undefined,
): string {
  return images === undefined || images.length === 0
    ? `${kind}:${text}`
    : `${kind}:${text}[${images.length}]`;
}

/** A session that records what was delivered into it, and lets a test drive its lifecycle. */
function fakeSession(): {
  session: SteerableSession;
  delivered: string[];
  aborts: number;
  emit: (event: SessionEvent) => void;
} {
  const delivered: string[] = [];
  let aborts = 0;
  const listeners: ((event: SessionEvent) => void)[] = [];
  const session: SteerableSession = {
    prompt: async (text: string, options) => {
      delivered.push(withImages("prompt", text, options?.images));
    },
    abort: async () => {
      aborts += 1;
    },
    dispose: () => {},
    steer: async (text: string, images) => {
      delivered.push(withImages("steer", text, images));
    },
    followUp: async (text: string, images) => {
      delivered.push(withImages("followUp", text, images));
    },
    subscribe: (listener) => {
      listeners.push(listener);
      return () => {};
    },
    sessionManager: { getSessionFile: () => TRANSCRIPT },
  };
  return {
    session,
    delivered,
    get aborts() {
      return aborts;
    },
    emit: (event) => {
      for (const listener of listeners) {
        listener(event);
      }
    },
  };
}

describe("the line the session shows", () => {
  it("names the issue, its title and the stage", () => {
    expect(statusLine({ issue: 42, title: "Fix the thing", stage: "session" })).toBe(
      "#42 · Fix the thing · session",
    );
    // The stage is missing for the moment between taking the issue and taking a step.
    expect(statusLine({ issue: 42, title: "Fix the thing", stage: "" })).toBe(
      "#42 · Fix the thing",
    );
  });

  it("reads back the newest entry a session remembers", () => {
    const entries = [
      { type: "message" },
      {
        type: "custom",
        customType: RUN_STATUS_ENTRY,
        data: { issue: 1, title: "the first run", stage: "claim" },
      },
      {
        type: "custom",
        customType: RUN_STATUS_ENTRY,
        data: { issue: 2, title: "the second run", stage: "done" },
      },
    ];
    expect(statusFromEntries(entries)).toEqual({
      issue: 2,
      title: "the second run",
      stage: "done",
    });
  });

  it("remembers nothing when the entry is not one of ours", () => {
    expect(statusFromEntries([{ type: "custom", customType: "other", data: {} }])).toBeNull();
    expect(statusFromEntries([])).toBeNull();
    // A truncated write is not a status either.
    expect(
      statusFromEntries([
        { type: "custom", customType: RUN_STATUS_ENTRY, data: { issue: 42 } },
      ]),
    ).toBeNull();
  });
});

describe("the extension entry point", () => {
  it("loads against the Pi it is running inside, and says which Pi that is", async () => {
    const activate = (await import("../src/extension.js")).default;
    const host = fakePi();

    // The gate runs at load: an unsupported Pi throws here, and the extension does not load.
    expect(() => activate(host.pi)).not.toThrow();

    expect(host.commands).toContain("afk-runner-version");
    expect(host.commands).toContain("afk-runner-run");
    expect(host.commands).toContain("afk-runner-stop");
    expect(host.commands).toContain("afk-runner-attach");
    expect([...host.handlers.keys()]).toEqual(
      expect.arrayContaining(["input", "session_start"]),
    );
  });
});

describe("a session opened again", () => {
  it("shows the line the run ended on", () => {
    const host = fakePi();
    const door = liveFrontDoor(host.pi);
    const { ctx, statuses } = fakeContext({
      entries: [
        {
          type: "custom",
          customType: RUN_STATUS_ENTRY,
          data: { issue: 42, title: "Fix the thing", stage: "session" },
        },
      ],
    });

    door.recall(ctx);

    expect(statuses.get(STATUS_KEY)).toBe("#42 · Fix the thing · session");
  });
});

describe("what a line typed in the host session means", () => {
  it("is chat when no run is under way", async () => {
    const host = fakePi();
    const door = liveFrontDoor(host.pi);
    const { ctx, statuses } = fakeContext();

    const reply = await door.steer(
      { type: "input", text: "hello", source: "interactive" } as InputEvent,
      ctx as unknown as ExtensionContext,
    );

    expect(reply).toEqual({ action: "continue" });
    expect(statuses.size).toBe(0);
  });
});

describe("the run the front door owns", () => {
  it("is steered by the line a human types while it runs", async () => {
    const checkout = await mkdtemp(join(tmpdir(), "afk-live-"));
    try {
      const host = fakePi();
      const fake = fakeSession();
      const created = deferred();
      const release = deferred();

      // The run as the door sees it: it takes an issue, then a session, then works.
      const work = async (options: RunOptions): Promise<RunResult> => {
        options.onIssue?.({ number: 42, title: "Fix the thing" });
        options.onStepStart?.("session");
        await options.session({ cwd: checkout, systemPromptSections: {} });
        created.resolve();
        await release.promise;
        return { issue: 42, outcome: "completed", steps: [], record: join(checkout, "record") };
      };

      const door = liveFrontDoor(host.pi, { session: async () => fake.session, work });
      const { ctx, statuses, notes } = fakeContext();

      await door.start(`--repo gazon1/cardinalfish --checkout ${checkout}`, ctx);
      await created.promise;

      expect(statuses.get(STATUS_KEY)).toBe("#42 · Fix the thing · session");

      // The human's correction is held as a row and delivered at the turn's end.
      const reply = await door.steer(
        { type: "input", text: "use the other branch", source: "interactive" } as InputEvent,
        ctx as unknown as ExtensionContext,
      );
      expect(reply).toEqual({ action: "handled" });
      expect(fake.delivered).toEqual([]);

      fake.emit({ type: "turn_end" });
      await vi.waitFor(() => {
        expect(fake.delivered).toEqual(["steer:use the other branch"]);
      });

      release.resolve();
      await vi.waitFor(() => {
        expect(statuses.get(STATUS_KEY)).toBe("#42 · Fix the thing · done");
      });
      expect(notes.some((note) => note.message.includes("worked issue 42"))).toBe(true);
      expect(host.entries.at(-1)?.data).toEqual({
        issue: 42,
        title: "Fix the thing",
        stage: "done",
      });
    } finally {
      await rm(checkout, { recursive: true, force: true });
    }
  });

  it("says why the issue could not be worked, in the words the CLI prints", async () => {
    const checkout = await mkdtemp(join(tmpdir(), "afk-live-"));
    try {
      const host = fakePi();
      const fake = fakeSession();
      const work = async (): Promise<RunResult> => ({
        issue: 42,
        outcome: "unworkable",
        steps: [],
        record: "",
        derivedState: "Claimed",
      });

      const door = liveFrontDoor(host.pi, { session: async () => fake.session, work });
      const { ctx, notes } = fakeContext();

      await door.start(`--repo gazon1/cardinalfish --checkout ${checkout}`, ctx);

      await vi.waitFor(() => {
        expect(
          notes.some((note) => note.message.includes("could not be worked")),
        ).toBe(true);
      });
      // The reason is the runner's mapping, not a second copy of it: the CLI
      // prints the same words for the same derived state.
      const said = notes.find((note) => note.message.includes("could not be worked"));
      expect(said?.message).toBe(
        `afk-runner: issue 42 could not be worked — ${unworkableReason("Claimed")}`,
      );
    } finally {
      await rm(checkout, { recursive: true, force: true });
    }
  });

  it("stops the run under way only while the agent is working, and says where it is otherwise", async () => {
    const checkout = await mkdtemp(join(tmpdir(), "afk-live-"));
    try {
      const host = fakePi();
      const fake = fakeSession();
      const created = deferred();
      const release = deferred();
      const work = async (options: RunOptions): Promise<RunResult> => {
        options.onIssue?.({ number: 42, title: "Fix the thing" });
        await options.session({ cwd: checkout, systemPromptSections: {} });
        created.resolve();
        await release.promise;
        return { issue: 42, outcome: "completed", steps: [], record: "" };
      };

      const door = liveFrontDoor(host.pi, { session: async () => fake.session, work });
      const { ctx, notes } = fakeContext();

      door.stop(ctx);
      expect(notes.at(-1)?.message).toContain("no run is under way");

      await door.start(`--repo gazon1/cardinalfish --checkout ${checkout}`, ctx);
      await created.promise;

      // The agent is idle: there is no turn to cut, and the door says where the run is.
      door.stop(ctx);
      expect(fake.aborts).toBe(0);
      expect(notes.at(-1)?.message).toContain("the agent is not working");

      // A running turn is cut.
      fake.emit({ type: "agent_start" });
      door.stop(ctx);
      expect(fake.aborts).toBe(1);
      expect(notes.at(-1)?.message).toContain("stopping");

      // And once the agent settles, the run is past the point a stop can reach.
      fake.emit({ type: "agent_settled" });
      door.stop(ctx);
      expect(fake.aborts).toBe(1);
      expect(notes.at(-1)?.message).toContain("the agent is not working");

      release.resolve();
      await vi.waitFor(() => {
        expect(host.entries.length).toBeGreaterThan(0);
      });
    } finally {
      await rm(checkout, { recursive: true, force: true });
    }
  });

  it("opens the run's session as this chat, once the agent has settled", async () => {
    // The run's worktree has to be a real one: attaching restores it, and a
    // directory git does not know is not a worktree.
    const fixture = await createFixtureRepository();
    const worktreeRoot = join(fixture.root, "worktrees");
    const worktreePath = join(worktreeRoot, "issue-42");
    try {
      const git = (args: readonly string[]) =>
        gitOutput(args, { cwd: fixture.repo, env: fixture.env });
      await git(["branch", "agent/issue-42"]);
      await mkdir(worktreeRoot, { recursive: true });
      await git(["worktree", "add", worktreePath, "agent/issue-42"]);

      const host = fakePi();
      const fake = fakeSession();
      const created = deferred();
      const release = deferred();
      const work = async (options: RunOptions): Promise<RunResult> => {
        options.onIssue?.({ number: 42, title: "Fix the thing" });
        await options.session({ cwd: worktreePath, systemPromptSections: {} });
        created.resolve();
        await release.promise;
        return { issue: 42, outcome: "completed", steps: [], record: "" };
      };

      const door = liveFrontDoor(host.pi, { session: async () => fake.session, work });
      const { ctx, notes, switches } = fakeContext();

      await door.attach(ctx);
      expect(notes.at(-1)?.message).toContain("no run to attach to");

      await door.start(
        `--repo gazon1/cardinalfish --checkout ${fixture.repo} --worktree-root ${worktreeRoot}`,
        ctx,
      );
      await created.promise;

      // The run opens its session as this chat on its own. Wait for that switch,
      // so the assertion below is about the command and not about the auto-attach.
      await vi.waitFor(() => expect(switches).toEqual([TRANSCRIPT]));

      // The agent is working: attaching would pull the chat out from under the run.
      fake.emit({ type: "agent_start" });
      await door.attach(ctx);
      expect(notes.at(-1)?.message).toContain("the agent is working");

      // Settled: the command switches this chat to the run's session, history and all.
      fake.emit({ type: "agent_settled" });
      await door.attach(ctx);
      expect(switches).toEqual([TRANSCRIPT, TRANSCRIPT]);

      release.resolve();
      await vi.waitFor(() => {
        expect(host.entries.length).toBeGreaterThan(0);
      });
    } finally {
      await fixture.dispose();
    }
  });

  it("puts back the worktree the auto-attach left this chat in, after the run's cleanup", async () => {
    const fixture = await createFixtureRepository({
      files: { "scripts/setup-worktree.sh": SETUP_SCRIPT_BODY },
    });
    const worktreeRoot = join(fixture.root, "worktrees");
    // The worktree the runner made: the door works the path out for itself, so
    // its restore has to find the very directory the run used.
    const worktreePath = issueWorktreePath(worktreeRoot, 42);
    try {
      const git = (args: readonly string[]) =>
        gitOutput(args, { cwd: fixture.repo, env: fixture.env });
      await git(["branch", "agent/issue-42"]);
      await mkdir(worktreeRoot, { recursive: true });
      await git(["worktree", "add", worktreePath, "agent/issue-42"]);

      const host = fakePi();
      const fake = fakeSession();
      const created = deferred();
      const release = deferred();
      let removed = false;
      const work = async (options: RunOptions): Promise<RunResult> => {
        options.onIssue?.({ number: 42, title: "Fix the thing" });
        await options.session({ cwd: worktreePath, systemPromptSections: {} });
        created.resolve();
        await release.promise;
        // What the runner's own cleanup does once the run has ended: the
        // worktree is scratch, and the branch holds the work.
        await git(["worktree", "remove", "--force", worktreePath]);
        removed = true;
        return { issue: 42, outcome: "completed", steps: [], record: "" };
      };

      const door = liveFrontDoor(host.pi, { session: async () => fake.session, work });
      const { ctx, switches } = fakeContext();
      await door.start(
        `--repo gazon1/cardinalfish --checkout ${fixture.repo} --worktree-root ${worktreeRoot}`,
        ctx,
      );
      await created.promise;

      // The auto-attach switches this chat into the run's session, whose
      // working directory is the worktree.
      await vi.waitFor(() => expect(switches).toEqual([TRANSCRIPT]));
      expect(existsSync(worktreePath)).toBe(true);

      release.resolve();
      await vi.waitFor(() => expect(removed).toBe(true));

      // The chat is standing in that directory, so the run puts it back.
      await vi.waitFor(() => expect(existsSync(worktreePath)).toBe(true));
      const worktrees = await git(["worktree", "list", "--porcelain"]);
      expect(worktrees).toContain(worktreePath);
      expect(worktrees).toContain(
        `branch refs/heads/agent/issue-42`,
      );
      // And it is the very directory the run used: the door did not put a
      // second, empty worktree somewhere else.
      const under = worktrees
        .split("\n")
        .filter((line) => line.startsWith("worktree ") && line.includes(worktreeRoot));
      expect(under).toEqual([`worktree ${worktreePath}`]);

      // The worktree that comes back is prepared: the repository's own script
      // ran in it, so the gates work in it the way they work in a worktree the
      // runner made. One run of the script, not two.
      await vi.waitFor(() => expect(existsSync(join(worktreeRoot, "prepared.log"))).toBe(true));
      expect(await readFile(join(worktreePath, ".env"), "utf8")).toBe("prepared\n");
      expect(await readFile(join(worktreeRoot, "prepared.log"), "utf8")).toBe("prepared\n");
    } finally {
      await fixture.dispose();
    }
  });

  it("does not prepare a worktree the run did not remove a second time", async () => {
    const fixture = await createFixtureRepository({
      files: { "scripts/setup-worktree.sh": SETUP_SCRIPT_BODY },
    });
    const worktreeRoot = join(fixture.root, "worktrees");
    const worktreePath = join(worktreeRoot, "issue-42");
    try {
      const git = (args: readonly string[]) =>
        gitOutput(args, { cwd: fixture.repo, env: fixture.env });
      await git(["branch", "agent/issue-42"]);
      await mkdir(worktreeRoot, { recursive: true });
      await git(["worktree", "add", worktreePath, "agent/issue-42"]);
      // What the runner does when it makes a worktree: it prepares it.
      await runCommand({
        command: "bash",
        args: ["scripts/setup-worktree.sh"],
        cwd: worktreePath,
      });

      const host = fakePi();
      const fake = fakeSession();
      const created = deferred();
      const release = deferred();
      const lockDirectory = join(fixture.root, "lock");
      const work = async (options: RunOptions): Promise<RunResult> => {
        options.onIssue?.({ number: 42, title: "Fix the thing" });
        await options.session({ cwd: worktreePath, systemPromptSections: {} });
        created.resolve();
        await release.promise;
        // The worktree is still there: this run did not remove it.
        return { issue: 42, outcome: "completed", steps: [], record: "" };
      };

      const door = liveFrontDoor(host.pi, { session: async () => fake.session, work });
      const { ctx } = fakeContext();
      await door.start(
        `--repo gazon1/cardinalfish --checkout ${fixture.repo} --worktree-root ${worktreeRoot} --lock-dir ${lockDirectory}`,
        ctx,
      );
      await created.promise;
      release.resolve();
      // The lock is given back at the very end of the run, after the worktree
      // has been dealt with: taking it means the run is over.
      await vi.waitFor(async () => {
        const lock = await takeLock(lockDirectory).catch(() => null);
        expect(lock).not.toBeNull();
        await lock?.release();
      });

      // The worktree is still there, and it was prepared when it was made. The
      // door does not prepare it again.
      await door.attach(ctx);
      expect(await readFile(join(worktreeRoot, "prepared.log"), "utf8")).toBe("prepared\n");
    } finally {
      await fixture.dispose();
    }
  });

  it("says so when the worktree it puts back cannot be prepared", async () => {
    // A repository whose setup script is not there: the worktree comes back,
    // and the door says that it is not prepared rather than leaving the human
    // to find it out from a gate.
    const fixture = await createFixtureRepository();
    const worktreeRoot = join(fixture.root, "worktrees");
    const worktreePath = join(worktreeRoot, "issue-42");
    try {
      const git = (args: readonly string[]) =>
        gitOutput(args, { cwd: fixture.repo, env: fixture.env });
      await git(["branch", "agent/issue-42"]);
      await mkdir(worktreeRoot, { recursive: true });
      await git(["worktree", "add", worktreePath, "agent/issue-42"]);

      const host = fakePi();
      const fake = fakeSession();
      const created = deferred();
      const release = deferred();
      let removed = false;
      const work = async (options: RunOptions): Promise<RunResult> => {
        options.onIssue?.({ number: 42, title: "Fix the thing" });
        await options.session({ cwd: worktreePath, systemPromptSections: {} });
        created.resolve();
        await release.promise;
        await git(["worktree", "remove", "--force", worktreePath]);
        removed = true;
        return { issue: 42, outcome: "completed", steps: [], record: "" };
      };

      const door = liveFrontDoor(host.pi, { session: async () => fake.session, work });
      const { ctx, notes } = fakeContext();
      await door.start(
        `--repo gazon1/cardinalfish --checkout ${fixture.repo} --worktree-root ${worktreeRoot}`,
        ctx,
      );
      await created.promise;
      release.resolve();
      await vi.waitFor(() => expect(removed).toBe(true));

      // The worktree is back, and the door says what is missing.
      await vi.waitFor(() => expect(existsSync(worktreePath)).toBe(true));
      await vi.waitFor(() => {
        const said = notes.map((note) => note.message).join("\n");
        expect(said).toContain("unprepared");
        expect(said).toContain("scripts/setup-worktree.sh");
      });
    } finally {
      await fixture.dispose();
    }
  });

  it("says so when the setup script is there and fails", async () => {
    // The script is in the worktree and it exits non-zero. The worktree came
    // back, and the door says that it is not prepared — with the script's own
    // reason, and without claiming that the script never ran.
    const fixture = await createFixtureRepository({
      files: {
        "scripts/setup-worktree.sh": [
          "#!/usr/bin/env bash",
          "set -eu",
          'printf "the setup script refused\\n" >&2',
          "exit 1",
          "",
        ].join("\n"),
      },
    });
    const worktreeRoot = join(fixture.root, "worktrees");
    const worktreePath = join(worktreeRoot, "issue-42");
    try {
      const git = (args: readonly string[]) =>
        gitOutput(args, { cwd: fixture.repo, env: fixture.env });
      await git(["branch", "agent/issue-42"]);
      await mkdir(worktreeRoot, { recursive: true });
      await git(["worktree", "add", worktreePath, "agent/issue-42"]);

      const host = fakePi();
      const fake = fakeSession();
      const created = deferred();
      const release = deferred();
      let removed = false;
      const work = async (options: RunOptions): Promise<RunResult> => {
        options.onIssue?.({ number: 42, title: "Fix the thing" });
        await options.session({ cwd: worktreePath, systemPromptSections: {} });
        created.resolve();
        await release.promise;
        await git(["worktree", "remove", "--force", worktreePath]);
        removed = true;
        return { issue: 42, outcome: "completed", steps: [], record: "" };
      };

      const door = liveFrontDoor(host.pi, { session: async () => fake.session, work });
      const { ctx, notes } = fakeContext();
      await door.start(
        `--repo gazon1/cardinalfish --checkout ${fixture.repo} --worktree-root ${worktreeRoot}`,
        ctx,
      );
      await created.promise;
      release.resolve();
      await vi.waitFor(() => expect(removed).toBe(true));

      // The worktree is back, and the door says that the script did not
      // prepare it — with the script's own words for why.
      await vi.waitFor(() => expect(existsSync(worktreePath)).toBe(true));
      await vi.waitFor(() => {
        const said = notes.map((note) => note.message).join("\n");
        expect(said).toContain("unprepared");
        expect(said).toContain("the setup script refused");
        expect(said).not.toContain("did not run in it");
      });
    } finally {
      await fixture.dispose();
    }
  });

  it("restores a review-only worktree that has no local branch, detached", async () => {
    const fixture = await createFixtureRepository({
      files: { "scripts/setup-worktree.sh": SETUP_SCRIPT_BODY },
    });
    const worktreeRoot = join(fixture.root, "worktrees");
    const worktreePath = join(worktreeRoot, "issue-42");
    try {
      const git = (args: readonly string[]) =>
        gitOutput(args, { cwd: fixture.repo, env: fixture.env });
      // What a review-only run finds on a single-branch checkout: the branch on
      // the remote and a detached worktree, but nothing local to check out.
      await git(["branch", "agent/issue-42"]);
      const sha = await git(["rev-parse", "agent/issue-42"]);
      await git(["push", "-q", "origin", "agent/issue-42"]);
      await git(["branch", "-D", "agent/issue-42"]);
      await git(["update-ref", "-d", "refs/remotes/origin/agent/issue-42"]).catch(() => "");
      await mkdir(worktreeRoot, { recursive: true });
      await git(["worktree", "add", "--detach", worktreePath, sha]);

      const host = fakePi();
      const fake = fakeSession();
      const created = deferred();
      const release = deferred();
      let removed = false;
      const work = async (options: RunOptions): Promise<RunResult> => {
        options.onIssue?.({ number: 42, title: "Fix the thing" });
        await options.session({ cwd: worktreePath, systemPromptSections: {} });
        created.resolve();
        await release.promise;
        await git(["worktree", "remove", "--force", worktreePath]);
        removed = true;
        return { issue: 42, outcome: "completed", steps: [], record: "" };
      };

      const door = liveFrontDoor(host.pi, { session: async () => fake.session, work });
      const { ctx } = fakeContext();
      await door.start(
        `--repo gazon1/cardinalfish --checkout ${fixture.repo} --worktree-root ${worktreeRoot}`,
        ctx,
      );
      await created.promise;
      release.resolve();
      await vi.waitFor(() => expect(removed).toBe(true));

      await vi.waitFor(() => expect(existsSync(worktreePath)).toBe(true));
      expect(await git(["worktree", "list", "--porcelain"])).toContain("detached");
      // A detached worktree is prepared as well: it is the same tree. The
      // fixture writes the `.env` first and the log a line later, so the log
      // is what says the preparation is done — the teardown must not race it.
      await vi.waitFor(() => expect(existsSync(join(worktreeRoot, "prepared.log"))).toBe(true));
      expect(await readFile(join(worktreePath, ".env"), "utf8")).toBe("prepared\n");
    } finally {
      await fixture.dispose();
    }
  });

  it("leaves a slash command to the host session", async () => {
    const checkout = await mkdtemp(join(tmpdir(), "afk-live-"));
    try {
      const host = fakePi();
      const fake = fakeSession();
      const created = deferred();
      const release = deferred();
      const work = async (options: RunOptions): Promise<RunResult> => {
        options.onIssue?.({ number: 42, title: "Fix the thing" });
        await options.session({ cwd: checkout, systemPromptSections: {} });
        created.resolve();
        await release.promise;
        return { issue: 42, outcome: "completed", steps: [], record: "" };
      };

      const door = liveFrontDoor(host.pi, { session: async () => fake.session, work });
      const { ctx } = fakeContext();
      await door.start(`--repo gazon1/cardinalfish --checkout ${checkout}`, ctx);
      await created.promise;

      const reply = await door.steer(
        { type: "input", text: "/afk-runner-version", source: "interactive" } as InputEvent,
        ctx as unknown as ExtensionContext,
      );

      expect(reply).toEqual({ action: "continue" });

      release.resolve();
      await vi.waitFor(() => {
        expect(host.entries.length).toBeGreaterThan(0);
      });
    } finally {
      await rm(checkout, { recursive: true, force: true });
    }
  });
});

describe("delivery into the session", () => {
  it("follows the boundary the session reached", async () => {
    const fake = fakeSession();

    await deliverRow(fake.session, { lane: "followUp", text: "later", images: [] }, "turn-end");
    await deliverRow(fake.session, { lane: "steer", text: "before the next call", images: [] }, "turn-end");
    await deliverRow(fake.session, { lane: "steer", text: "when it is idle", images: [] }, "settled");
    await deliverRow(
      fake.session,
      { lane: "steer", text: "look at this", images: [IMAGE] },
      "turn-end",
    );

    expect(fake.delivered).toEqual([
      "followUp:later",
      "steer:before the next call",
      "prompt:when it is idle",
      // A picture the human attached travels with the correction.
      "steer:look at this[1]",
    ]);
  });

  it("reads a boundary out of the session's lifecycle and nothing out of a message", () => {
    expect(boundaryOf({ type: "agent_start" })).toEqual({
      observe: { type: "agent-start" },
      boundary: null,
    });
    expect(boundaryOf({ type: "turn_end" })?.boundary).toBe("turn-end");
    expect(boundaryOf({ type: "agent_end" })?.boundary).toBe("agent-end");
    expect(boundaryOf({ type: "agent_settled" })?.boundary).toBe("settled");
    expect(boundaryOf({ type: "message_end" })).toBeNull();
  });
});

describe("the log the host shows", () => {
  it("reads a tool call and an assistant line, and ignores the rest", () => {
    expect(
      logLine({
        type: "tool_execution_start",
        toolName: "bash",
        args: { command: "./gradlew :shared:jvmTest\nand more" },
      }),
    ).toBe("→ bash: ./gradlew :shared:jvmTest");

    expect(
      logLine({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: "\n  Running the gates.  \nmore" }],
        },
      }),
    ).toBe("· Running the gates.");

    // A tool result, a user turn and a boundary are not lines.
    expect(logLine({ type: "message_end", message: { role: "toolResult", content: [] } })).toBeNull();
    expect(logLine({ type: "turn_end" })).toBeNull();
  });

  it("shows the last lines of the run while it works, and clears them after", async () => {
    const checkout = await mkdtemp(join(tmpdir(), "afk-live-"));
    try {
      const host = fakePi();
      const fake = fakeSession();
      const created = deferred();
      const release = deferred();
      const work = async (options: RunOptions): Promise<RunResult> => {
        options.onIssue?.({ number: 42, title: "Fix the thing" });
        await options.session({ cwd: checkout, systemPromptSections: {} });
        created.resolve();
        await release.promise;
        return { issue: 42, outcome: "completed", steps: [], record: "" };
      };

      const door = liveFrontDoor(host.pi, { session: async () => fake.session, work });
      const { ctx, widgets, notes } = fakeContext();
      await door.start(`--repo gazon1/cardinalfish --checkout ${checkout}`, ctx);
      await created.promise;

      // The work session has no chat to join; the door says where its transcript is.
      expect(notes.some((note) => note.message.includes(TRANSCRIPT))).toBe(true);

      fake.emit({ type: "tool_execution_start", toolName: "read", args: { path: "README.md" } });
      expect(widgets.get(LOG_KEY)).toEqual(["→ read"]);

      fake.emit({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "Reading the repo." }] },
      });
      expect(widgets.get(LOG_KEY)).toEqual(["→ read", "· Reading the repo."]);

      release.resolve();
      await vi.waitFor(() => {
        expect(widgets.get(LOG_KEY)).toBeUndefined();
      });
    } finally {
      await rm(checkout, { recursive: true, force: true });
    }
  });
});

describe("the log the CLI shows", () => {
  it("shows a tool call once, and the assistant's text with its marker", async () => {
    // The CLI reads the session's events through the handlers the factory
    // installs. A tool call is already a line of its own — the tool_call
    // handler says what the tool was — so a tool-call block in the message
    // says nothing twice.
    const fixture = await createFixtureRepository();
    const agentDirectory = join(fixture.root, "agent");
    const previous = process.env.PI_CODING_AGENT_DIR;
    const lines: string[] = [];
    try {
      await mkdir(agentDirectory, { recursive: true });
      await writeFile(
        join(agentDirectory, "models.json"),
        JSON.stringify({
          providers: {
            fake: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:1",
              apiKey: "test",
              models: [{ id: "beam" }],
            },
          },
        }),
        "utf8",
      );
      process.env.PI_CODING_AGENT_DIR = agentDirectory;

      const session = await piSessionFactory({
        agentDirectory,
        model: "fake/beam",
        onEvent: (line) => lines.push(line),
      })({ cwd: fixture.repo, systemPromptSections: {} });
      const judging = session as unknown as {
        readonly extensionRunner: {
          emitMessageEnd(event: unknown): Promise<unknown>;
          emitToolCall(event: unknown): Promise<unknown>;
        };
        dispose(): void;
      };

      try {
        // The tool call is a line of its own: the tool and the command.
        await judging.extensionRunner.emitToolCall({
          type: "tool_call",
          toolName: "bash",
          toolCallId: "t",
          input: { command: "ls" },
        });
        // The colour the CLI dims it with is not part of the line.
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain("→ bash: ls");

        lines.length = 0;
        await judging.extensionRunner.emitMessageEnd({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "c", name: "bash", arguments: { command: "ls" } }],
          },
        });
        expect(lines).toEqual([]);

        await judging.extensionRunner.emitMessageEnd({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
        });
        expect(lines).toEqual(["· hi"]);
      } finally {
        judging.dispose();
      }
    } finally {
      if (previous === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previous;
      }
      await fixture.dispose();
    }
  });
});

describe("what the door takes from the host session", () => {
  it("runs on the model the session is already using", () => {
    expect(hostModel({ provider: "commandcode", id: "reflection/beam:free" })).toBe(
      "commandcode/reflection/beam:free",
    );
    // A session with no model falls back to the runner's own choice.
    expect(hostModel(undefined)).toBeNull();
  });
});

describe("the guard's policy", () => {
  it("protects the paths that are ours and allows the rest", () => {
    expect(GUARD_POLICY["*"]).toBe("allow");
    // Without a bash entry the guard reports a configuration issue and the shell
    // inherits the allow silently.
    expect(GUARD_POLICY.bash["*"]).toBe("allow");
    // The leftovers go through the runner's tool, which holds the bounds on the
    // queue. A shell command is a way around them.
    expect(GUARD_POLICY.bash["gh issue create*"]).toEqual({
      action: "deny",
      reason: expect.stringContaining("agent_leftover"),
    });
    // The guard's own wildcards: `*` crosses `/`, and the last matching entry wins.
    expect(GUARD_POLICY.path["*.env"]).toBe("deny");
    expect(GUARD_POLICY.path["*.env.*"]).toBe("deny");
    expect(GUARD_POLICY.path["*.pem"]).toBe("deny");
    // The template carries no secret, and the work needs it — so it has to come
    // after the deny it is an exception to.
    expect(GUARD_POLICY.path["*.env.example"]).toBe("allow");
    const order = Object.keys(GUARD_POLICY.path);
    expect(order.indexOf("*.env.example")).toBeGreaterThan(order.indexOf("*.env.*"));
  });

  it("leaves the policy the target repository already carries alone", async () => {
    const committed = '{"permission":{"*":"deny"}}\n';
    const fixture = await createFixtureRepository({
      files: { [GUARD_POLICY_PATH]: committed },
    });
    try {
      const git = (args: readonly string[], options: { readonly cwd: string }) =>
        gitOutput(args, { cwd: options.cwd, env: fixture.env });

      await installGuardPolicy({ cwd: fixture.repo, git });

      // The target said what its policy is. Writing over it would be staged by the
      // runner's own `git add -A` — an exclude hides only untracked files — and the
      // pull request would carry our policy instead of theirs.
      expect(await readFile(join(fixture.repo, GUARD_POLICY_PATH), "utf8")).toBe(committed);
      await git(["add", "-A"], { cwd: fixture.repo });
      expect(await git(["status", "--porcelain"], { cwd: fixture.repo })).toBe("");
    } finally {
      await fixture.dispose();
    }
  });

  it("is written where the guard reads it, and stays out of the commits", async () => {
    const fixture = await createFixtureRepository();
    try {
      const git = (args: readonly string[], options: { readonly cwd: string }) =>
        gitOutput(args, { cwd: options.cwd, env: fixture.env });

      await installGuardPolicy({ cwd: fixture.repo, git });

      const written = JSON.parse(
        await readFile(join(fixture.repo, GUARD_POLICY_PATH), "utf8"),
      ) as { permission: { path: Record<string, string> } };
      expect(written.permission.path["*.env"]).toBe("deny");

      // The runner commits the worktree with `git add -A`; the policy is not the run's
      // work and must not reach the pull request.
      await git(["add", "-A"], { cwd: fixture.repo });
      expect(await git(["status", "--porcelain"], { cwd: fixture.repo })).toBe("");

      // Twice in one worktree — the review session runs in the same one — and the
      // exclude is still one line.
      await installGuardPolicy({ cwd: fixture.repo, git });
      const exclude = await readFile(
        join(fixture.repo, ".git", "info", "exclude"),
        "utf8",
      );
      expect(exclude.split("\n").filter((line) => line === "/.pi")).toHaveLength(1);
    } finally {
      await fixture.dispose();
    }
  });

  it("is loaded into the session the factory builds, and refuses what it denies", async () => {
    // The guard reads its policy on `session_start`, and the SDK never emits it —
    // the factory has to. Without that line the guard has no policy, every call is
    // an unmatched ask, and an ask with no dialog is a deny: the run looks healthy
    // and can do nothing.
    const fixture = await createFixtureRepository({
      files: { ".env": "SECRET=1\n", ".env.example": "# template\n" },
    });
    const agentDirectory = join(fixture.root, "agent");
    const previous = process.env.PI_CODING_AGENT_DIR;
    try {
      await mkdir(agentDirectory, { recursive: true });
      await writeFile(
        join(agentDirectory, "models.json"),
        JSON.stringify({
          providers: {
            fake: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:1",
              apiKey: "test",
              models: [{ id: "beam" }],
            },
          },
        }),
        "utf8",
      );
      // The guard reads Pi's process-wide agent directory, not the loader's.
      process.env.PI_CODING_AGENT_DIR = agentDirectory;

      const session = await piSessionFactory({
        agentDirectory,
        model: "fake/beam",
      })({ cwd: fixture.repo, systemPromptSections: {} });
      const judging = session as unknown as {
        readonly extensionRunner: {
          getExtensionPaths(): string[];
          emitToolCall(event: unknown): Promise<{ readonly block?: boolean } | undefined>;
        };
        dispose(): void;
      };
      const read = (path: string) =>
        judging.extensionRunner.emitToolCall({
          type: "tool_call",
          toolName: "read",
          toolCallId: "probe",
          input: { path },
        });

      try {
        expect((await read(".env"))?.block).toBe(true);
        // An allowed call comes back as an empty result, not as `undefined`.
        expect((await read(".env.example"))?.block).toBeFalsy();

        // And the session the runner created is not steered by the extension that
        // created it: the package's own extension file is not among the loaded ones.
        // (The guard's own path mentions the workspace directory, so the file is what
        // is matched, not the path.)
        const loaded = judging.extensionRunner.getExtensionPaths();
        expect(loaded.length).toBeGreaterThan(0);
        expect(
          loaded.filter((path) => /pi-afk-runner\/(?:src|dist)\/extension\.[jt]s$/.test(path)),
        ).toEqual([]);
      } finally {
        judging.dispose();
      }
    } finally {
      if (previous === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previous;
      }
      await fixture.dispose();
    }
  });

  it("names the factory Pi activates, not the service it exports", () => {
    expect(existsSync(guardExtensionPath())).toBe(true);
    expect(guardExtensionPath().endsWith("/src/index.ts")).toBe(true);
  });

  it("does not mistake a synthetic path for a copy of this package", () => {
    // The runner's own inline factory is named `<inline:...>`, and the SDK's own
    // extensions are named `builtin:...`. Neither names a file, and neither is a
    // second copy of this package.
    //
    // The bug this guards: the check read the package name off the working
    // directory's **parent**, and a CI runner checks the repository out at
    // `<repo>/<repo>`. There the parent is named after the package, so the
    // runner's own inline factory was read as a second copy of itself and
    // dropped — and the tool-call log went with it.
    expect(isOwnExtension("<inline:afk-runner-guardrail>")).toBe(false);
    expect(isOwnExtension("builtin:read")).toBe(false);
  });

  it("keeps the runner's own inline extension whatever the directory is called", async () => {
    // The check reads the package name off the working directory's parent, so
    // it only misfires when that parent happens to be named after the package.
    // That is the shape of a CI runner's checkout, `<repo>/<repo>`, and the
    // runner's own inline factory was dropped there — taking the tool-call log
    // with it.
    //
    // The working directory is put in that shape here, so the test fails the
    // same way on every machine and not only where the checkout is named so.
    //
    // The name is the one the check compares against, read the way the check
    // reads it: the directory the package is installed in.
    const packageName = basename(dirname(dirname(fileURLToPath(import.meta.url))));
    const layout = await mkdtemp(join(tmpdir(), "afk-runner-layout-"));
    const parent = join(layout, packageName);
    const working = join(parent, "checkout");
    await mkdir(working, { recursive: true });
    const previous = process.cwd();
    try {
      process.chdir(working);
      // The inline factory is this package's own — never a second copy of it.
      expect(isOwnExtension("<inline:afk-runner-guardrail>")).toBe(false);
      expect(isOwnExtension("builtin:read")).toBe(false);
      // And the check still says yes to a real copy of the package.
      expect(isOwnExtension(join(parent, "dist", "extension.js"))).toBe(true);
    } finally {
      process.chdir(previous);
      await rm(layout, { recursive: true, force: true });
    }
  });
});

describe("a gone session is recognised by the host's wording", () => {
  it("is stale for the host's gone-session message", () => {
    const failure = new Error(
      "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().",
    );
    expect(isStaleContext(failure)).toBe(true);
  });

  it("is not stale for any other failure", () => {
    expect(isStaleContext(new Error("widget exploded"))).toBe(false);
  });
});

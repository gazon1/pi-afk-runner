/**
 * The run's journal — the file the run's lines are written to.
 *
 * The lines themselves — the log the engine projects — are in
 * `test/mastra-log.test.ts`.
 *
 * The file the lines go to has a shape too — where it lives, what it is called
 * and how it starts — and one place says it, so a reader who learns it from
 * one pipeline's file knows it from the other's.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  issueSubject,
  journalDirectory,
  journalFactory,
  journalFileName,
  journalHeader,
  journalPath,
  openJournal,
  sweepJournalDirectory,
  sweepJournalHeader,
} from "../src/journal.js";
import { fakeSession } from "./shared.js";

describe("the journal file", () => {
  it("names the run and what the run was about", () => {
    // The first line says whose file this is, before a reader reads any of it.
    expect(journalHeader("run-1", { kind: "issue", number: 42 })).toBe(
      "# run run-1, issue 42",
    );
    expect(journalHeader("run-2", { kind: "pull request", number: 7 })).toBe(
      "# run run-2, pull request 7",
    );
    expect(sweepJournalHeader("run-3")).toBe("# run run-3, the merge sweep");
  });

  it("lives beside the run's record", () => {
    // The work run's diagnostics and the merge run's are different places,
    // and each is spelled the same way whoever asks for it.
    expect(journalDirectory("/repo", { kind: "issue", number: 42 })).toBe(
      join("/repo", "build", "diagnostics", "issue-42"),
    );
    expect(journalDirectory("/repo", { kind: "pull request", number: 7 })).toBe(
      join("/repo", "build", "diagnostics", "merge", "pr-7"),
    );
  });

  it("puts the sweep's journal beside the pull requests' own", () => {
    // The sweep's journal is in the directory the per-pull-request
    // directories are in, not in one of them.
    expect(sweepJournalDirectory("/repo")).toBe(
      join("/repo", "build", "diagnostics", "merge"),
    );
  });

  it("is the run's own file", () => {
    // The name in the record is the name on the disk, so one place says it.
    expect(journalFileName("run-1")).toBe("run-1.log");
    expect(journalPath("/dir", "run-1")).toBe(join("/dir", "run-1.log"));
  });

  it("gives every journal it wraps the same lines", async () => {
    // The sweep's journal and the pull request's own journal are two files
    // around one session: the lines go to both, and neither loses the other.
    const directory = await mkdtemp(join(tmpdir(), "afk-journal-"));
    try {
      const sweepFile = join(directory, "sweep.log");
      const pullRequestFile = join(directory, "pull-request.log");
      const session = fakeSession();
      const factory = journalFactory(
        async (sessionOptions) => {
          sessionOptions.onEvent?.("the agent's own line");
          return session;
        },
        sweepFile,
      );
      const wrapped = journalFactory(factory, pullRequestFile);

      await wrapped({ cwd: directory, systemPromptSections: {} });

      expect(await readFile(sweepFile, "utf8")).toBe("the agent's own line\n");
      expect(await readFile(pullRequestFile, "utf8")).toBe("the agent's own line\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("drops a line it cannot write, and keeps the run going", async () => {
    // A journal that cannot be written is not a reason to stop the run: the
    // line is dropped and the session carries on.
    const session = fakeSession();
    const factory = journalFactory(
      async (sessionOptions) => {
        // The line the journal cannot take: its directory is not there.
        sessionOptions.onEvent?.("a line the journal cannot hold");
        return session;
      },
      join(tmpdir(), "afk-journal-without-a-directory", "run.log"),
    );

    const opened = await factory({ cwd: tmpdir(), systemPromptSections: {} });
    expect(opened).toBe(session);
  });

  it("opens the journal of a run in one place", async () => {
    // The pipeline names what the run was about and stops there: the module
    // says what the file looks like. The file is there before the session
    // opens, with its header line, and the lines are appended as they come.
    const root = await mkdtemp(join(tmpdir(), "afk-journal-root-"));
    try {
      const session = fakeSession();
      const factory = await openJournal(
        root,
        "run-1",
        issueSubject(42),
        async (sessionOptions) => {
          sessionOptions.onEvent?.("the agent's own line");
          return session;
        },
      );

      const file = join(
        journalDirectory(root, issueSubject(42)),
        journalFileName("run-1"),
      );
      expect(await readFile(file, "utf8")).toBe(
        `${journalHeader("run-1", issueSubject(42))}\n`,
      );

      await factory({ cwd: root, systemPromptSections: {} });
      expect(await readFile(file, "utf8")).toBe(
        `${journalHeader("run-1", issueSubject(42))}\nthe agent's own line\n`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

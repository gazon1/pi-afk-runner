/**
 * What the runner's own lines look like.
 *
 * Under systemd the journal is not a TTY, so chalk emits no colour and every
 * line is the same shape on the page. The marker is then the only thing that
 * says whether a line came from the agent or from the runner, and the thinking
 * lines had none.
 */

import chalk from "chalk";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { piSessionFactory } from "../src/cli.js";
import { createFixtureRepository } from "./git-sandbox.js";

/** A session that records what the runner prints. */
interface Recorder {
  readonly lines: string[];
  readonly end: (message: unknown) => Promise<void>;
  readonly dispose: () => void;
}

/**
 * A session with one model to run on, so the factory can build it.
 */
async function recorder(cwd: string, agentDirectory: string): Promise<Recorder> {
  const lines: string[] = [];
  const session = await piSessionFactory({
    agentDirectory,
    model: "fake/beam",
    onEvent: (line) => lines.push(line),
  })({ cwd, systemPromptSections: {} });
  const judging = session as unknown as {
    readonly extensionRunner: {
      emitMessageEnd(event: unknown): Promise<unknown>;
    };
    dispose(): void;
  };
  return {
    lines,
    end: (message) =>
      judging.extensionRunner
        .emitMessageEnd({ type: "message_end", message })
        .then(() => {}),
    dispose: () => judging.dispose(),
  };
}

/** The message the agent sends: a thought and a spoken line. */
const MESSAGE = {
  role: "assistant",
  content: [
    { type: "thinking", thinking: "Let us look up how tests are structured…" },
    { type: "text", text: "Running the gates." },
  ],
};

describe("the lines the runner prints", () => {
  it("marks the agent's thinking and its speech, with colour and without", async () => {
    const fixture = await createFixtureRepository();
    const agentDirectory = join(fixture.root, "agent");
    const previous = process.env.PI_CODING_AGENT_DIR;
    const level = chalk.level;
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

      const run = await recorder(fixture.repo, agentDirectory);
      try {
        // The journal: no TTY, so no colour, and the marker is all there is.
        chalk.level = 0;
        await run.end(MESSAGE);
        expect(run.lines).toEqual([
          "· Let us look up how tests are structured…",
          "· Running the gates.",
        ]);

        // A terminal: the colour comes back, and the marker with it.
        run.lines.length = 0;
        chalk.level = 3;
        await run.end(MESSAGE);
        expect(run.lines[0]).toContain("· Let us look up how tests are structured…");
        expect(run.lines[1]).toContain("· Running the gates.");
        // And the colour is really there, so the two assertions above are not
        // the same assertion twice.
        expect(run.lines[0]).not.toBe("· Let us look up how tests are structured…");
      } finally {
        chalk.level = level;
        run.dispose();
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

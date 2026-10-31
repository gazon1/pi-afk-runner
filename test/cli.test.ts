import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { piSessionFactory } from "../src/cli.js";
import { createFixtureRepository } from "./git-sandbox.js";

/**
 * The lines the session says about an assistant message.
 *
 * The session is a real one — the factory, the loader and the guard's own
 * extension — because the handler that prints the line lives inside it. A test
 * that only called the printing rule would pass while the handler kept
 * printing every block it was given.
 */
async function sayLines(text: string): Promise<readonly string[]> {
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
    // The guard reads Pi's process-wide agent directory, not the loader's.
    process.env.PI_CODING_AGENT_DIR = agentDirectory;

    const session = await piSessionFactory({
      agentDirectory,
      model: "fake/beam",
      onEvent: (line) => lines.push(line),
    })({ cwd: fixture.repo, systemPromptSections: {} });
    const judging = session as unknown as {
      readonly extensionRunner: {
        emitMessageEnd(event: unknown): Promise<unknown>;
      };
      dispose(): void;
    };

    try {
      await judging.extensionRunner.emitMessageEnd({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text }] },
      });
    } finally {
      judging.dispose();
    }
    return lines;
  } finally {
    if (previous === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previous;
    }
    await fixture.dispose();
  }
}

describe("the line an assistant message gets", () => {
  it("says the text with its marker", async () => {
    expect(await sayLines("Reading the repo.")).toEqual(["· Reading the repo."]);
  });

  it("says nothing for an empty block", async () => {
    expect(await sayLines("")).toEqual([]);
  });

  it("says nothing for a whitespace-only block", async () => {
    expect(await sayLines("\n")).toEqual([]);
    expect(await sayLines("   \n\t ")).toEqual([]);
  });
});

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * One module names the `gh` binary, and this is the test that says so.
 *
 * The GitHub reads and writes are a contract with a repository the runner does
 * not own: the labels, the brief's marker and the review's verdict are agreed
 * with a human, and a query that names one of them wrongly does not fail — it
 * returns the wrong issues and the runner carries on. So the arguments live in
 * one module, `src/gh.ts`, and everything else goes through it.
 *
 * The drift this catches is a second module shelling out to `gh` on its own:
 * a label added from somewhere else, a read that nobody wrote a test for, an
 * argument that quietly disagrees with the contract.
 */

const sourceDirectory = fileURLToPath(new URL("../src", import.meta.url));

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(path)));
    } else if (entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

/** The `gh` binary, as a string literal — the only way a module can name it. */
const namesTheBinary = /(["'])gh\1/;

describe("the gh binary", () => {
  it("is named by one module only", async () => {
    const files = await sourceFiles(sourceDirectory);
    const offenders: string[] = [];
    for (const file of files) {
      if (file.endsWith("/gh.ts")) {
        continue;
      }
      const text = await readFile(file, "utf8");
      if (namesTheBinary.test(text)) {
        offenders.push(file.slice(sourceDirectory.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("is named by the module that owns the GitHub calls", async () => {
    const text = await readFile(`${sourceDirectory}/gh.ts`, "utf8");
    expect(namesTheBinary.test(text)).toBe(true);
  });
});

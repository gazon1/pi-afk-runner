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

/** The module that owns the GitHub calls. */
const GH_MODULE = "gh.ts";

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

/**
 * A file's code, without its comments.
 *
 * Prose may name the binary in passing — this file's own docstring does — and
 * only code names it.
 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** Whether the code names the `gh` binary, as a string literal. */
function namesTheBinary(text: string): boolean {
  return /(["'])gh\1/.test(code(text));
}

/** The modules that name the binary, other than the one that owns the calls. */
async function offenders(): Promise<string[]> {
  const found: string[] = [];
  for (const file of await sourceFiles(sourceDirectory)) {
    if (file.endsWith(`/${GH_MODULE}`)) {
      continue;
    }
    if (namesTheBinary(await readFile(file, "utf8"))) {
      found.push(file.slice(sourceDirectory.length + 1));
    }
  }
  return found;
}

describe("the gh binary", () => {
  it("is named by one module only", async () => {
    expect(await offenders()).toEqual([]);
  });

  it("is named by the module that owns the GitHub calls", async () => {
    expect(namesTheBinary(await readFile(`${sourceDirectory}/${GH_MODULE}`, "utf8"))).toBe(
      true,
    );
  });

  it("is not named by prose", () => {
    expect(namesTheBinary('// the runner shells out to "gh" here\n')).toBe(false);
    expect(namesTheBinary("/* the module that runs \"gh\" */\n")).toBe(false);
    expect(namesTheBinary('execFileAsync("gh", []);\n')).toBe(true);
  });
});

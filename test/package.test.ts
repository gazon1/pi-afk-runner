import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

/**
 * The components are declared twice: as dependencies in `package.json`, so a
 * consumer of the package installs them, and in `.pi/settings.json`, so this
 * project loads them. Two lists of the same nine things drift.
 *
 * This is the test that says they cannot.
 */

const exec = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));

async function readJson(relative: string): Promise<Record<string, unknown>> {
  const text = await readFile(new URL(relative, import.meta.url), "utf8");
  return JSON.parse(text) as Record<string, unknown>;
}

/**
 * The settings the project declares.
 *
 * `scripts/setup-worktree.sh` empties `.pi/settings.json` in a worktree — the
 * packages would load into the headless session — and marks the file
 * skip-worktree, so the local file says nothing about the declaration. The
 * committed file is the declaration; the local one is the worktree's choice.
 */
async function declaredSettings(): Promise<Record<string, unknown>> {
  const local = await readJson("../.pi/settings.json");
  try {
    const { stdout } = await exec("git", ["ls-files", "-v", ".pi/settings.json"], { cwd: root });
    if (!stdout.startsWith("S")) {
      return local;
    }
    const committed = await exec("git", ["show", "HEAD:.pi/settings.json"], { cwd: root });
    return JSON.parse(committed.stdout) as Record<string, unknown>;
  } catch {
    // No git here: the local file is all there is.
    return local;
  }
}

describe("the declared components", () => {
  it("are the ones the project loads", async () => {
    const manifest = await readJson("../package.json");
    const settings = await declaredSettings();

    const dependencies = (manifest.dependencies ?? {}) as Record<string, string>;
    const declared = Object.entries(dependencies)
      .map(([name, version]) => `npm:${name}@${version}`)
      .sort();

    const packages = (settings.packages ?? []) as unknown[];
    const loaded = packages
      .filter((entry): entry is string => typeof entry === "string" && entry.startsWith("npm:"))
      .sort();

    expect(declared.length).toBeGreaterThan(0);
    expect(loaded).toEqual(declared);
  });
});

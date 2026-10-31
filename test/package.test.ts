import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

/**
 * The components are declared twice: as dependencies in `package.json`, so a
 * consumer of the package installs them, and in `.pi/settings.json`, so this
 * project loads them. Two lists of the same nine things drift.
 *
 * This is the test that says they cannot.
 */

async function readJson(relative: string): Promise<Record<string, unknown>> {
  const text = await readFile(new URL(relative, import.meta.url), "utf8");
  return JSON.parse(text) as Record<string, unknown>;
}

/**
 * The packages the settings declare.
 *
 * `scripts/setup-worktree.sh` empties `.pi/settings.json` in a runner worktree
 * on purpose — a headless session must not load nine extensions — and hides the
 * edit from git with `skip-worktree`. The declaration this repository ships is
 * the committed one, so that is what the test reads when the file on disk has
 * been emptied on purpose.
 */
function declaredPackages(settings: Record<string, unknown>): string[] {
  const packages = (settings.packages ?? []) as unknown[];
  return packages
    .filter((entry): entry is string => typeof entry === "string" && entry.startsWith("npm:"))
    .sort();
}

function committedSettings(): Record<string, unknown> {
  const text = execFileSync("git", ["show", "HEAD:.pi/settings.json"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  return JSON.parse(text) as Record<string, unknown>;
}

describe("the declared components", () => {
  it("are the ones the project loads", async () => {
    const manifest = await readJson("../package.json");

    const dependencies = (manifest.dependencies ?? {}) as Record<string, string>;
    const declared = Object.entries(dependencies)
      .map(([name, version]) => `npm:${name}@${version}`)
      .sort();

    const onDisk = declaredPackages(await readJson("../.pi/settings.json"));
    const loaded = onDisk.length > 0 ? onDisk : declaredPackages(committedSettings());

    expect(declared.length).toBeGreaterThan(0);
    expect(loaded).toEqual(declared);
  });
});

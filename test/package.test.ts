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

describe("the declared components", () => {
  it("are the ones the project loads", async () => {
    const manifest = await readJson("../package.json");
    const settings = await readJson("../.pi/settings.json");

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

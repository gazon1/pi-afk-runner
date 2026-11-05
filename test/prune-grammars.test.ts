/**
 * The step that drops the grammars from the installed tree.
 *
 * The step is a script, and a script that runs its work when it is loaded has
 * nothing a test can call. These tests are the seam: the step's work is a
 * function that takes the package to prune, and these tests hold it to what the
 * install promises — the grammars go, the rest of the package stays, a package
 * that is not there is reported rather than thrown, and the install never fails
 * over any of it.
 *
 * The last test is the install path itself: the runner packed and installed
 * into a directory of its own, where the grammars sit beside the runner rather
 * than inside it.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { pruneGrammars } from "../scripts/prune-grammars.mjs";

const run = promisify(execFile);

/** The repository the step belongs to. */
const REPOSITORY = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The trees the tests make, to be taken away again. */
const trees: string[] = [];

afterEach(async () => {
  for (const tree of trees.splice(0)) {
    await rm(tree, { recursive: true, force: true });
  }
});

/**
 * A tree of the tests' own, to be taken away again.
 */
async function tree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "afk-prune-test-"));
  trees.push(root);
  return root;
}

/**
 * A package that carries grammars, and files that are not grammars.
 */
async function fakePackage(): Promise<string> {
  const packageDirectory = join(await tree(), "package");
  await mkdir(join(packageDirectory, "out", "nested"), { recursive: true });
  await writeFile(join(packageDirectory, "out", "grammar.wasm"), "0123456789");
  await writeFile(join(packageDirectory, "out", "nested", "other.wasm"), "01234");
  await writeFile(join(packageDirectory, "package.json"), "{}\n");
  await writeFile(join(packageDirectory, "index.js"), "export const a = 1;\n");
  return packageDirectory;
}

/**
 * Every WebAssembly file under a directory, as paths.
 */
async function wasmFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await wasmFiles(path)));
    } else if (entry.name.endsWith(".wasm")) {
      found.push(path);
    }
  }
  return found;
}

/**
 * Every directory with a given name under a directory, as paths.
 */
async function directoriesNamed(directory: string, name: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.name === name) {
      found.push(path);
    }
    found.push(...(await directoriesNamed(path, name)));
  }
  return found;
}

/**
 * The step as the install runs it: the script, in a tree of its own.
 *
 * The script is copied there so that what it resolves is the tree's, and the
 * tree is laid out the way an install lays it out — the runner in one place,
 * the grammars in another.
 */
async function runStep(installed: string): Promise<string> {
  const script = join(installed, "runner", "scripts", "prune-grammars.mjs");
  await mkdir(dirname(script), { recursive: true });
  await copyFile(join(REPOSITORY, "scripts", "prune-grammars.mjs"), script);
  const { stdout } = await run("node", [script], { cwd: installed });
  return stdout;
}

describe("the step that drops the grammars", () => {
  it("drops the grammars and leaves the rest of the package alone", async () => {
    const packageDirectory = await fakePackage();

    const report = await pruneGrammars(packageDirectory);

    expect(report.dropped).toBe(true);
    expect(report.bytes).toBe(15);
    expect(existsSync(join(packageDirectory, "out"))).toBe(false);
    expect(existsSync(join(packageDirectory, "package.json"))).toBe(true);
    expect(existsSync(join(packageDirectory, "index.js"))).toBe(true);
  });

  it("reports a package that is not there instead of throwing", async () => {
    const missing = join(await tree(), "nowhere");

    const report = await pruneGrammars(missing);

    expect(report.dropped).toBe(false);
    expect(report.bytes).toBe(0);
  });

  it("reports a package that carries no grammars instead of throwing", async () => {
    const packageDirectory = join(await tree(), "package");
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(join(packageDirectory, "package.json"), "{}\n");

    const report = await pruneGrammars(packageDirectory);

    expect(report.dropped).toBe(false);
    expect(report.bytes).toBe(0);
    expect(existsSync(join(packageDirectory, "package.json"))).toBe(true);
  });

  it("says how much it dropped, and drops the grammars beside the runner", async () => {
    const installed = await tree();
    const grammars = join(installed, "node_modules", "@repomix", "tree-sitter-wasms");
    await mkdir(join(grammars, "out"), { recursive: true });
    await writeFile(join(grammars, "out", "grammar.wasm"), "0123456789");
    await writeFile(join(grammars, "package.json"), "{}\n");

    const stdout = await runStep(installed);

    expect(stdout).toContain("MB dropped");
    expect(existsSync(join(grammars, "out"))).toBe(false);
    expect(existsSync(join(grammars, "package.json"))).toBe(true);
  });

  it("ends the install the way it ended before, whether it prunes or not", async () => {
    const installed = await tree();

    const stdout = await runStep(installed);

    // The step cannot fail the install: it says what it could not do, and the
    // install carries on. The step that ran here never threw.
    expect(stdout).toContain("keeps its grammars");
  });
});

describe("the runner installed as a dependency", () => {
  it("leaves no grammars in the installed tree", async () => {
    const installed = await tree();
    await writeFile(join(installed, "package.json"), "{}\n");

    await run("npm", ["pack", "--pack-destination", installed], { cwd: REPOSITORY });
    const packed = (await readdir(installed)).filter((name) => name.endsWith(".tgz"));
    expect(packed).toHaveLength(1);

    await run("npm", ["install", join(installed, packed[0]!), "--no-audit", "--no-fund"], {
      cwd: installed,
    });

    const grammars = await directoriesNamed(join(installed, "node_modules"), "tree-sitter-wasms");
    expect(grammars.length).toBeGreaterThan(0);
    for (const found of grammars) {
      expect(await wasmFiles(found)).toEqual([]);
    }
  }, 600_000);
});

/**
 * Drop the tree-sitter grammars the runner cannot use.
 *
 * Repomix depends on `@repomix/tree-sitter-wasms`: the WebAssembly grammars
 * for the compression the runner never asks for. Repomix reads a grammar only
 * when that compression is asked for, and the runner never asks — so the
 * grammars are weight on every host that installs the runner, for a language
 * the target repository is not written in.
 *
 * The step runs after the install, takes them away, and says how much it
 * dropped: that number belongs to the install that ran it, not to this file.
 * It never fails the install: a host that keeps the grammars has the runner it
 * had before, and a host that loses them has a runner that never asks for one.
 */

import { realpathSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/** The grammars repomix would read, and where they sit in the package. */
const GRAMMARS = "@repomix/tree-sitter-wasms";
const GRAMMARS_DIRECTORY = "out";

/**
 * How much a directory holds, in bytes.
 *
 * The number is for the operator: the install says what it dropped.
 */
async function sizeOf(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    total += entry.isDirectory() ? await sizeOf(path) : (await stat(path)).size;
  }
  return total;
}

/**
 * Drop the grammars out of a package, and report what was dropped.
 *
 * This is the seam the install step and its test both call: it takes the
 * package to prune, takes the grammars out of it, and says how much it
 * dropped. It leaves the rest of the package alone, and a package that is not
 * there is reported rather than thrown — the install must never fail over it.
 *
 * @param {string} packageDirectory the root of the package to prune
 * @returns {Promise<{dropped: boolean, bytes: number}>} what was dropped
 */
export async function pruneGrammars(packageDirectory) {
  const directory = join(packageDirectory, GRAMMARS_DIRECTORY);
  const bytes = await sizeOf(directory).catch(() => null);
  if (bytes === null) {
    // The grammars are not there: an install that already dropped them.
    return { dropped: false, bytes: 0 };
  }
  await rm(directory, { recursive: true, force: true });
  return { dropped: true, bytes };
}

/**
 * The step the install runs: drop the grammars, and say how much it dropped.
 *
 * The package is found from here — this file's own location — so a runner
 * installed as a dependency finds the grammars that sit beside it.
 */
async function prune() {
  try {
    const grammars = dirname(require.resolve(`${GRAMMARS}/package.json`));
    const report = await pruneGrammars(grammars);
    if (report.dropped) {
      console.log(
        `the packer carries no grammars: ${(report.bytes / 1_000_000).toFixed(0)} MB dropped ` +
          `from ${GRAMMARS}`,
      );
    } else {
      console.log(`the packer carries no grammars: ${GRAMMARS} has none`);
    }
  } catch (error) {
    // The grammars are not there, or they are somewhere this step cannot reach.
    // Either way the runner works: it never asks for a grammar.
    console.log(
      `the packer keeps its grammars: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Whether this file is the one node was asked to run.
 *
 * The step is imported by its test, and the import must not prune anything:
 * the effect belongs to the run, not to the load.
 */
function isTheEntryPoint() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isTheEntryPoint()) {
  await prune();
}

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

import { readdir, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

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

try {
  const grammars = dirname(require.resolve(`${GRAMMARS}/package.json`));
  const directory = join(grammars, GRAMMARS_DIRECTORY);
  const bytes = await sizeOf(directory).catch(() => null);
  if (bytes === null) {
    // The grammars are not there: an install that already dropped them.
    console.log(`the packer carries no grammars: ${GRAMMARS} has none`);
  } else {
    await rm(directory, { recursive: true, force: true });
    console.log(
      `the packer carries no grammars: ${(bytes / 1_000_000).toFixed(0)} MB dropped ` +
        `from ${GRAMMARS}`,
    );
  }
} catch (error) {
  // The grammars are not there, or they are somewhere this step cannot reach.
  // Either way the runner works: it never asks for a grammar.
  console.log(
    `the packer keeps its grammars: ${error instanceof Error ? error.message : String(error)}`,
  );
}

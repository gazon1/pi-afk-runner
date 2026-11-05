/**
 * The runner's own source, read by the tests.
 *
 * Some rules are about *where* a thing is written, not about what it does: a
 * branch's name is spelled in one file, a flag is read in one place. The tests
 * that hold those rules read the source, and this is how they read it.
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the runner's source is. */
export const SOURCE = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/**
 * The source without its comments.
 *
 * A comment may name a thing — that is what a comment is for — but a comment
 * cannot disagree with the code, so the spellings the tests look for are the
 * ones in the code.
 */
export function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Every source file, and its code without the comments. */
export async function sourceFiles(): Promise<readonly { file: string; code: string }[]> {
  const names = (await readdir(SOURCE)).filter((name) => name.endsWith(".ts")).sort();
  const files: { file: string; code: string }[] = [];
  for (const name of names) {
    files.push({
      file: name,
      code: withoutComments(await readFile(join(SOURCE, name), "utf8")),
    });
  }
  return files;
}

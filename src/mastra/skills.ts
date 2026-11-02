/**
 * The skills the Mastra agent carries.
 *
 * Mastra's skills are directories: a path to a directory with a `SKILL.md` in
 * it. The runner's own skills are such directories, and so are the target
 * repository's — under `.agents/skills`. So the discovery is the runner's
 * own: it reads the directories and hands Mastra the paths.
 *
 * The `$name` rule stands: a prompt names a skill as `$name`, and the name is
 * the skill's own.
 */

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { skillsDirectory } from "../session.js";

/** The file a skill directory carries. */
const SKILL_FILE = "SKILL.md";

/**
 * The skill directories under a root.
 *
 * A root that is not there is not an error: the target repository may carry
 * no skills of its own, and a run must not fail over that.
 */
async function skillDirectoriesIn(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const directories: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const directory = join(root, entry.name);
    if (existsSync(join(directory, SKILL_FILE))) {
      directories.push(directory);
    }
  }
  return directories;
}

/**
 * The names a skill directory answers to.
 *
 * The name is the one the skill declares in its frontmatter, and the
 * directory's own name as well — Mastra reads one of them, and a skill that
 * shadows another must be found by either.
 */
async function namesOf(directory: string): Promise<Set<string>> {
  const names = new Set<string>([basename(directory)]);
  const text = await readFile(join(directory, SKILL_FILE), "utf8").catch(() => "");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
  const declared = /^name:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim();
  if (declared !== undefined && declared !== "") {
    names.add(declared);
  }
  return names;
}

/**
 * Every skill the run carries.
 *
 * The runner's own skills come first — they are the ones the runner depends
 * on — and the target repository's own come after, under `.agents/skills`. The
 * host user's skills are not the runner's to depend on: a run has to be the
 * same on every host.
 *
 * **The target's own copy of a skill wins.** A repository that carries its own
 * `code-review-pr-workflow` has said what its skill is, and the runner's copy
 * is only a fallback for the repositories that carry none. So a skill the
 * target declares is carried once — the target's.
 */
export async function skillDirectories(options: {
  /** The worktree the run works in — the target repository's own root. */
  readonly cwd: string;
}): Promise<string[]> {
  const runner = await skillDirectoriesIn(skillsDirectory());
  const target = await skillDirectoriesIn(join(options.cwd, ".agents", "skills"));

  const taken = new Set<string>();
  for (const directory of target) {
    for (const name of await namesOf(directory)) {
      taken.add(name);
    }
  }

  const carried: string[] = [];
  for (const directory of runner) {
    const names = await namesOf(directory);
    if ([...names].some((name) => taken.has(name))) {
      continue;
    }
    carried.push(directory);
  }
  return [...carried, ...target];
}

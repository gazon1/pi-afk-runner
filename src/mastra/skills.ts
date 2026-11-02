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
import { readdir } from "node:fs/promises";
import { join } from "node:path";

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
 * Every skill the run carries.
 *
 * The runner's own skills come first — they are the ones the runner depends
 * on — and the target repository's own come after. The host user's skills are
 * not the runner's to depend on: a run has to be the same on every host.
 */
export async function skillDirectories(options: {
  /** The worktree the run works in — the target repository's own root. */
  readonly cwd: string;
}): Promise<string[]> {
  return [
    ...(await skillDirectoriesIn(skillsDirectory())),
    ...(await skillDirectoriesIn(join(options.cwd, ".agents", "skills"))),
    ...(await skillDirectoriesIn(join(options.cwd, ".pi", "skills"))),
  ];
}

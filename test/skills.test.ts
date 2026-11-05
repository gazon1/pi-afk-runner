/**
 * A prompt may name a skill, and then the skill has to be one the work session
 * has.
 *
 * The session's skills come from two places: the target repository's
 * `.agents/skills` and the runner's own `skills/` directory. The host user's
 * skills are not the runner's to depend on — the run has to be the same on
 * every host — so a prompt names one of the first two, and the runner carries
 * its own.
 *
 * These tests are the guard: the first says a prompt names nothing the runner
 * does not carry, the second says the session has it anyway, on a host with no
 * skills of its own, and the third says the target's own copy of a skill is
 * the one the session uses.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { describe, expect, it } from "vitest";

import { skillDirectories } from "../src/mastra/skills.js";
import { promptsDirectory, readPrompts, skillsDirectory } from "../src/session.js";

/** The skills the prompts name, in the order the prompts name them. */
async function skillsNamedByPrompts(): Promise<string[]> {
  const prompts = await readPrompts(promptsDirectory());
  const names: string[] = [];
  for (const prompt of prompts) {
    for (const match of prompt.matchAll(/`\$([a-z0-9][a-z0-9-]*)`/g)) {
      const name = match[1];
      if (name !== undefined && !names.includes(name)) {
        names.push(name);
      }
    }
  }
  return names;
}

/** The name a carried skill directory answers to. */
function nameOf(directory: string): string {
  return basename(directory);
}

describe("the skills a prompt names", () => {
  it("names a skill the runner carries", async () => {
    for (const name of await skillsNamedByPrompts()) {
      expect(existsSync(join(skillsDirectory(), name, "SKILL.md"))).toBe(true);
    }
  });

  it("puts every skill a prompt names in a session, on a host with no skills", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "afk-worktree-"));
    const carried = await skillDirectories({ cwd: worktree });
    const names = carried.map(nameOf);
    for (const name of await skillsNamedByPrompts()) {
      expect(names).toContain(name);
    }
  });

  it("uses the target's own copy of a skill, and the runner's only as a fallback", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "afk-target-"));
    const targetSkill = join(worktree, ".agents", "skills", "code-review-pr-workflow");
    await mkdir(targetSkill, { recursive: true });
    await writeFile(
      join(targetSkill, "SKILL.md"),
      "---\nname: code-review-pr-workflow\ndescription: the target's own copy\n---\n\nThe target.\n",
      "utf8",
    );
    const carried = await skillDirectories({ cwd: worktree });
    const copies = carried.filter((directory) => nameOf(directory) === "code-review-pr-workflow");
    expect(copies).toHaveLength(1);
    expect(copies[0]).toBe(targetSkill);
  });
});

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createResourceLoader } from "../src/cli.js";
import { promptsDirectory, readPrompts, skillsDirectory } from "../src/session.js";

/**
 * A prompt may name a skill, and then the skill has to be one the work session
 * has.
 *
 * The session's skills come from three places: the target repository's
 * `.agents/skills`, the runner's own `skills/` directory, and the host user's
 * `~/.agents/skills`. The third one is not the runner's to depend on — the run
 * has to be the same on every host — so a prompt names one of the first two,
 * and the runner carries its own.
 *
 * These tests are the guard: the first says a prompt names nothing the runner
 * does not carry, the second says the session has it anyway, on a host with no
 * skills of its own, and the third says the target's own copy of a skill is
 * the one the session uses.
 */

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

/** A home directory with no skills in it — a host that has none. */
async function hostWithoutSkills(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "afk-home-"));
  return home;
}

describe("the skills a prompt names", () => {
  it("names a skill the runner carries", async () => {
    for (const name of await skillsNamedByPrompts()) {
      expect(existsSync(join(skillsDirectory(), name, "SKILL.md"))).toBe(true);
    }
  });

  it("puts every skill a prompt names in a session, on a host with no skills", async () => {
    const home = await hostWithoutSkills();
    const before = process.env["HOME"];
    process.env["HOME"] = home;
    try {
      const worktree = await mkdtemp(join(tmpdir(), "afk-worktree-"));
      const agentDir = await mkdtemp(join(tmpdir(), "afk-agent-"));
      const loader = createResourceLoader({
        cwd: worktree,
        agentDirectory: agentDir,
        systemPromptSections: {},
      });
      await loader.reload();
      const loaded = new Set(loader.getSkills().skills.map((skill) => skill.name));
      for (const name of await skillsNamedByPrompts()) {
        expect(loaded.has(name)).toBe(true);
      }
    } finally {
      if (before === undefined) {
        delete process.env["HOME"];
      } else {
        process.env["HOME"] = before;
      }
    }
  });

  it("uses the target's own copy of a skill, and the runner's only as a fallback", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "afk-target-"));
    const agentDir = await mkdtemp(join(tmpdir(), "afk-agent-"));
    const targetSkill = join(worktree, ".agents", "skills", "code-review-pr-workflow");
    await mkdir(targetSkill, { recursive: true });
    await writeFile(
      join(targetSkill, "SKILL.md"),
      "---\nname: code-review-pr-workflow\ndescription: the target's own copy\n---\n\nThe target.\n",
      "utf8",
    );
    const loader = createResourceLoader({
      cwd: worktree,
      agentDirectory: agentDir,
      systemPromptSections: {},
    });
    await loader.reload();
    const loaded = loader.getSkills().skills.filter(
      (skill) => skill.name === "code-review-pr-workflow",
    );
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.filePath).toBe(join(targetSkill, "SKILL.md"));
  });
});

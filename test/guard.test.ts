/**
 * The guard's policy.
 *
 * The rules live in one place — the policy the engine reads — so that
 * nothing can refuse something else. This file is about the policy itself:
 * what it holds, and how its wildcards match.
 */

import { describe, expect, it } from "vitest";

import { GUARD_POLICY, matchesPattern } from "../src/guard.js";

describe("the guard's policy", () => {
  it("reads the policy the runner holds", () => {
    // The rules live in one place, so nothing can refuse something else.
    expect(GUARD_POLICY.path["*.env"]).toBe("deny");
    expect(GUARD_POLICY.bash["gh issue create*"]).toBeDefined();
  });

  it("matches the way the policy's wildcards say", () => {
    expect(matchesPattern("*.env", "app/.env")).toBe(true);
    expect(matchesPattern("*.env", "app/.env.example")).toBe(false);
    expect(matchesPattern("*.env.*", "app/.env.example")).toBe(true);
  });
});

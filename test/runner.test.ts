import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { describe, expect, it } from "vitest";

import { UNCLAIMED, deriveState, type Observables } from "../src/runner.js";
import {
  PINNED_PI_RANGE,
  PiVersionMismatch,
  assertPiVersion,
  checkPiVersion,
  comparePiVersions,
  installedPiVersion,
  parsePiVersion,
  satisfiesRange,
} from "../src/version.js";

/**
 * The version gate is the one thing the extension must never get wrong in the wrong
 * direction: it has to let a supported Pi through and stop an unsupported one. Everything
 * here is about the boundary — the version that is exactly the lower bound, the one that is
 * exactly the upper bound, and the one just outside each.
 */
describe("the pinned Pi version range", () => {
  it("test_the_extension_refuses_to_run_outside_its_pi_version_range", async () => {
    // The version this extension is written against passes.
    const inside = checkPiVersion("1.4.0");
    expect(inside.ok).toBe(true);
    expect(inside.reason).toBeNull();

    // Outside the range, in either direction, the check refuses.
    const below = checkPiVersion("1.3.9");
    expect(below.ok).toBe(false);
    expect(below.reason).toContain("1.3.9");
    expect(below.reason).toContain(PINNED_PI_RANGE);

    const above = checkPiVersion("1.5.0");
    expect(above.ok).toBe(false);
    expect(above.reason).toContain("1.5.0");

    // A far-away version is refused for the same reason, not by accident of parsing.
    expect(checkPiVersion("0.9.1").ok).toBe(false);
    expect(checkPiVersion("2.0.0").ok).toBe(false);

    // And the refusal is a refusal, not a warning: the caller throws.
    expect(() => assertPiVersion("1.5.0")).toThrow(PiVersionMismatch);
    expect(() => assertPiVersion("1.4.0")).not.toThrow();

    // The range the check actually uses is the pinned one.
    expect(PINNED_PI_RANGE).toBe(">=1.4.0 <1.5.0");
  });

  it("accepts every version inside the range, including its bounds", () => {
    for (const version of ["1.4.0", "1.4.1", "1.4.17", "1.4.99"]) {
      expect(checkPiVersion(version).ok).toBe(true);
    }
  });

  it("refuses a prerelease of the range's lower bound", () => {
    // `1.4.0-rc.1` is older than `1.4.0`, so it is not inside `>=1.4.0`.
    expect(checkPiVersion("1.4.0-rc.1").ok).toBe(false);
    // And it is not inside the range either.
    const version = parsePiVersion("1.4.0-rc.1");
    expect(version).not.toBeNull();
    expect(satisfiesRange(version!, PINNED_PI_RANGE)).toBe(false);
  });

  it("refuses a version it cannot parse, rather than passing it", () => {
    for (const raw of ["", "1.4", "1.4.0.0", "not-a-version", "v1.4.0"]) {
      expect(checkPiVersion(raw).ok).toBe(false);
    }
    expect(parsePiVersion("not-a-version")).toBeNull();
    expect(parsePiVersion("v1.4.0")).toBeNull();
  });

  it("reads the version of the Pi it is running inside", () => {
    const installed = installedPiVersion();
    expect(installed).toMatch(/^\d+\.\d+\.\d+/);
    // The SDK this extension is developed against is the one it is running inside.
    expect(checkPiVersion(installed).ok).toBe(true);
  });
});

describe("the version comparison", () => {
  it("orders versions by major, then minor, then patch", () => {
    const at = (raw: string) => parsePiVersion(raw)!;
    expect(comparePiVersions(at("1.4.0"), at("1.5.0"))).toBeLessThan(0);
    expect(comparePiVersions(at("1.5.0"), at("1.4.0"))).toBeGreaterThan(0);
    expect(comparePiVersions(at("1.4.0"), at("1.4.0"))).toBe(0);
    expect(comparePiVersions(at("2.0.0"), at("1.99.99"))).toBeGreaterThan(0);
  });

  it("orders a prerelease before its release", () => {
    const at = (raw: string) => parsePiVersion(raw)!;
    expect(comparePiVersions(at("1.4.0-rc.1"), at("1.4.0"))).toBeLessThan(0);
    expect(comparePiVersions(at("1.4.0-rc.1"), at("1.4.0-rc.2"))).toBeLessThan(0);
  });

  it("ignores build metadata", () => {
    const at = (raw: string) => parsePiVersion(raw)!;
    expect(comparePiVersions(at("1.4.0+build.1"), at("1.4.0"))).toBe(0);
    expect(checkPiVersion("1.4.0+build.1").ok).toBe(true);
  });
});

describe("the range grammar", () => {
  const at = (raw: string) => parsePiVersion(raw)!;

  it("reads a conjunction of comparators", () => {
    expect(satisfiesRange(at("1.4.0"), ">=1.4.0 <1.5.0")).toBe(true);
    expect(satisfiesRange(at("1.4.9"), ">=1.4.0 <1.5.0")).toBe(true);
    expect(satisfiesRange(at("1.5.0"), ">=1.4.0 <1.5.0")).toBe(false);
    expect(satisfiesRange(at("1.3.9"), ">=1.4.0 <1.5.0")).toBe(false);
  });

  it("reads each comparator", () => {
    expect(satisfiesRange(at("1.4.0"), ">=1.4.0")).toBe(true);
    expect(satisfiesRange(at("1.3.9"), ">=1.4.0")).toBe(false);
    expect(satisfiesRange(at("1.4.0"), ">1.4.0")).toBe(false);
    expect(satisfiesRange(at("1.5.0"), "<=1.5.0")).toBe(true);
    expect(satisfiesRange(at("1.5.1"), "<=1.5.0")).toBe(false);
    expect(satisfiesRange(at("1.4.0"), "<1.5.0")).toBe(true);
    expect(satisfiesRange(at("1.4.0"), "=1.4.0")).toBe(true);
    expect(satisfiesRange(at("1.4.1"), "=1.4.0")).toBe(false);
  });

  it("satisfies nothing when the range itself cannot be read", () => {
    expect(satisfiesRange(at("1.4.0"), "")).toBe(false);
    expect(satisfiesRange(at("1.4.0"), "not-a-range")).toBe(false);
    expect(satisfiesRange(at("1.4.0"), ">=1.4.0 <<broken")).toBe(false);
  });
});

describe("the extension entry point", () => {
  it("loads against the Pi it is running inside, and says which Pi that is", async () => {
    const activate = (await import("../src/extension.js")).default;

    const registered: string[] = [];
    const pi = {
      registerCommand: (name: string) => {
        registered.push(name);
      },
    };

    // The gate runs at load: an unsupported Pi throws here, and the extension does not load.
    expect(() => activate(pi as unknown as ExtensionAPI)).not.toThrow();

    // And the gate's other half is reachable: the session can ask which Pi it is running against.
    expect(registered).toContain("afk-runner-version");
  });
});

describe("the state the runner derives", () => {
  it("test_the_state_is_derived_from_the_observables", () => {
    // Every row of the derivation table, one case each.
    const withObservables = (overrides: Partial<Observables>): Observables => ({
      ...UNCLAIMED,
      ...overrides,
    });

    // No claim → the issue is in the queue.
    expect(deriveState(withObservables({}))).toBe("Queue");

    // Claimed, nothing durable behind it, still fresh → a live run owns it.
    expect(
      deriveState(withObservables({ claimLabel: true, stale: false })),
    ).toBe("Claimed");

    // Claimed, nothing durable behind it, and old → the run that took it died.
    expect(
      deriveState(withObservables({ claimLabel: true, stale: true })),
    ).toBe("Orphaned");

    // Claimed and the branch is on the remote → the work was pushed.
    expect(
      deriveState(withObservables({ claimLabel: true, workBranch: true })),
    ).toBe("Pushed");

    // A pull request exists and carries no review → it needs one.
    expect(
      deriveState(withObservables({ claimLabel: true, pullRequest: true })),
    ).toBe("Opened");

    // It carries a review → the review is there, the re-count is not.
    expect(
      deriveState(
        withObservables({ claimLabel: true, pullRequest: true, reviewComment: true }),
      ),
    ).toBe("Reviewed");

    // It carries the re-count too → the runner is done with it.
    expect(
      deriveState(
        withObservables({
          claimLabel: true,
          pullRequest: true,
          reviewComment: true,
          recountLabel: true,
        }),
      ),
    ).toBe("Counted");
  });

  it("does not read a pull request's review before the pull request exists", () => {
    // A review comment without a pull request is not a state — the gate reads
    // the pull request's comments, so the comment cannot exist without it.
    expect(
      deriveState({
        ...UNCLAIMED,
        claimLabel: true,
        reviewComment: true,
        recountLabel: true,
      }),
    ).toBe("Claimed");
  });
});

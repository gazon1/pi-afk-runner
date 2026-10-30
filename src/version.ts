/**
 * The Pi version this extension is written against.
 *
 * Why this exists
 * ---------------
 * An extension is code that runs *inside* the agent, against the agent's own API. When Pi
 * changes its extension interface, an extension written against the old one does not fail
 * loudly — it fails by doing the wrong thing: a hook that no longer fires, a context field
 * that is now a different shape, a tool that is registered and never called.
 *
 * A runner that half-works against a different Pi is worse than one that stops. So the
 * extension declares the range it was written for and refuses to run outside it.
 *
 * The range is a conjunction of comparators — `">=1.4.0 <1.5.0"` — parsed by the small
 * comparator below rather than by a semver dependency: the grammar needed here is one line
 * long, and a dependency that exists only to compare two version strings is a dependency
 * that has to be kept up to date for no other reason.
 */

import { readFileSync } from "node:fs";

/** The range of Pi versions this extension is written against. */
export const PINNED_PI_RANGE = ">=1.4.0 <1.5.0";

/** A parsed semantic version. */
export interface PiVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** The prerelease tag, or null for a release version. */
  readonly prerelease: string | null;
}

/** Thrown when the installed Pi is outside the pinned range. */
export class PiVersionMismatch extends Error {
  readonly installed: string;
  readonly range: string;

  constructor(installed: string, range: string) {
    super(
      `pi-afk-runner is written for Pi ${range}, and ${installed} is installed. ` +
        `Refusing to run: an extension that half-works against a different Pi is worse than ` +
        `one that stops.`,
    );
    this.name = "PiVersionMismatch";
    this.installed = installed;
    this.range = range;
  }
}

/** The outcome of a version check. */
export interface VersionCheck {
  readonly ok: boolean;
  /** Why the check failed, or null when it passed. */
  readonly reason: string | null;
}

const VERSION_PATTERN =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Parse a semantic version, or return null when the string is not one.
 *
 * The build metadata (`+2026-10-30`) is accepted and ignored: it does not affect precedence.
 */
export function parsePiVersion(raw: string): PiVersion | null {
  const match = VERSION_PATTERN.exec(raw.trim());
  if (match === null) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

/**
 * Compare two versions. A prerelease sorts *before* the release it precedes, so `1.4.0-rc.1`
 * is older than `1.4.0`.
 */
export function comparePiVersions(a: PiVersion, b: PiVersion): number {
  if (a.major !== b.major) {
    return a.major < b.major ? -1 : 1;
  }
  if (a.minor !== b.minor) {
    return a.minor < b.minor ? -1 : 1;
  }
  if (a.patch !== b.patch) {
    return a.patch < b.patch ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) {
    return 0;
  }
  if (a.prerelease === null) {
    return 1;
  }
  if (b.prerelease === null) {
    return -1;
  }
  return a.prerelease < b.prerelease ? -1 : 1;
}

type ComparatorOperator = ">=" | ">" | "<=" | "<" | "=";

interface Comparator {
  readonly op: ComparatorOperator;
  readonly version: PiVersion;
}

const COMPARATOR_PATTERN = /^(>=|<=|>|<|=)?\s*(.+)$/;

function parseComparator(raw: string): Comparator | null {
  const match = COMPARATOR_PATTERN.exec(raw.trim());
  if (match === null) {
    return null;
  }
  const version = parsePiVersion(match[2] ?? "");
  if (version === null) {
    return null;
  }
  const op = (match[1] ?? "=") as ComparatorOperator;
  return { op, version };
}

/**
 * Does a version satisfy a range?
 *
 * The range is a space-separated conjunction of comparators: `">=1.4.0 <1.5.0"`. A comparator
 * with no operator means equality. An unparseable range satisfies nothing — a range nobody can
 * read is not a range that should pass silently.
 */
export function satisfiesRange(version: PiVersion, range: string): boolean {
  const parts = range.trim().split(/\s+/).filter((part) => part.length > 0);
  if (parts.length === 0) {
    return false;
  }
  const comparators: Comparator[] = [];
  for (const part of parts) {
    const comparator = parseComparator(part);
    if (comparator === null) {
      return false;
    }
    comparators.push(comparator);
  }
  return comparators.every((comparator) => {
    const order = comparePiVersions(version, comparator.version);
    switch (comparator.op) {
      case ">=":
        return order >= 0;
      case ">":
        return order > 0;
      case "<=":
        return order <= 0;
      case "<":
        return order < 0;
      case "=":
        return order === 0;
    }
  });
}

/**
 * Check an installed version against the pinned range.
 *
 * An unparseable version fails the check. So does a version outside the range, and so does a
 * prerelease of the range's lower bound: `1.4.0-rc.1` is not `1.4.0`.
 */
export function checkPiVersion(
  installed: string,
  range: string = PINNED_PI_RANGE,
): VersionCheck {
  const version = parsePiVersion(installed);
  if (version === null) {
    return { ok: false, reason: `\`${installed}\` is not a version this extension can compare` };
  }
  if (!satisfiesRange(version, range)) {
    return {
      ok: false,
      reason: `Pi ${installed} is outside the range this extension is written for (${range})`,
    };
  }
  return { ok: true, reason: null };
}

/**
 * Check an installed version and throw when it is outside the pinned range.
 */
export function assertPiVersion(
  installed: string,
  range: string = PINNED_PI_RANGE,
): void {
  const result = checkPiVersion(installed, range);
  if (!result.ok) {
    throw new PiVersionMismatch(installed, range);
  }
}

/**
 * The version of Pi this extension is running inside.
 *
 * The SDK's own `package.json` is read rather than its exported `VERSION`, so that this module
 * stays importable — and testable — without loading the agent's own machinery. The SDK's
 * `exports` map has no `./package.json` entry, so the path is resolved and then walked up one
 * directory from the entry point.
 */
export function installedPiVersion(): string {
  const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
  const manifest = new URL("../package.json", entry);
  const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) {
    throw new Error(`the installed Pi package at ${manifest.href} has no version`);
  }
  const version = (parsed as { version: unknown }).version;
  if (typeof version !== "string") {
    throw new Error(`the installed Pi package at ${manifest.href} has no version`);
  }
  return version;
}

/**
 * The gate the extension and the CLI call before they do anything else.
 *
 * It throws `PiVersionMismatch` when the installed Pi is outside the pinned range. That is the
 * whole point: a runner that stops is recoverable, and a runner that half-works is not.
 */
export function assertInstalledPiVersion(range: string = PINNED_PI_RANGE): void {
  assertPiVersion(installedPiVersion(), range);
}

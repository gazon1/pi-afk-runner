/**
 * Write the runner's own build stamp beside the built modules.
 *
 * `dist/` is what Pi loads and what `bin` points at, so the stamp lives there:
 * a run's record names the version and the commit its code came from, and a
 * stale build is then a thing a reader can see. A build outside a repository
 * writes no commit rather than failing the build.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

let sha = null;
try {
  sha =
    execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
} catch {
  // No git, or not a repository: the package version alone is the stamp.
}

writeFileSync(
  new URL("../dist/build-info.json", import.meta.url),
  `${JSON.stringify({ sha })}\n`,
);

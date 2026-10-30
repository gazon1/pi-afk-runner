/**
 * The package's public entry point.
 *
 * The version gate is exported here because it is the one thing a caller needs before it does
 * anything: `await assertInstalledPiVersion()` throws when the Pi it is running inside is not the
 * Pi this package was written for.
 */

export {
  PINNED_PI_RANGE,
  PiVersionMismatch,
  assertInstalledPiVersion,
  assertPiVersion,
  checkPiVersion,
  comparePiVersions,
  installedPiVersion,
  parsePiVersion,
  satisfiesRange,
} from "./version.js";

export type { PiVersion, VersionCheck } from "./version.js";

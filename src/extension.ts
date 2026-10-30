/**
 * The extension entry point.
 *
 * What it does today: **refuse to load against a Pi it was not written for.**
 *
 * An extension is code that runs inside the agent, against the agent's own API. When Pi changes
 * that interface, an extension written against the old one does not fail loudly — it fails by
 * doing the wrong thing: a hook that no longer fires, a context field that is now a different
 * shape, a tool that is registered and never called. A runner that half-works against a different
 * Pi is worse than one that stops, so the version check happens at load, before anything else can
 * go quietly wrong.
 *
 * The `/version` command is the gate's other half: the same fact, said out loud, so a session
 * can show which Pi it is running against and whether that Pi is one this extension supports.
 *
 * The runner's own hooks — the system prompt, the session it owns, the steer path — arrive with
 * the tasks that need them.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { PINNED_PI_RANGE, assertInstalledPiVersion, installedPiVersion } from "./version.js";

export default function activate(pi: ExtensionAPI): void {
  assertInstalledPiVersion();

  pi.registerCommand("afk-runner-version", {
    description:
      "Show the Pi version this session runs against and the range this extension supports",
    handler: async (_args, ctx) => {
      const installed = installedPiVersion();
      ctx.ui.notify(
        `Pi ${installed} — this extension is written for ${PINNED_PI_RANGE}`,
        "info",
      );
    },
  });
}

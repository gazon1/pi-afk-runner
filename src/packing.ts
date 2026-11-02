/**
 * The packing: the repository as one document the agent reads.
 *
 * The agent reads files one at a time, and each read costs the turn's
 * attention. A repository the agent has never seen is a lot of files: the
 * triage turn has to know whether the behaviour the brief names is already
 * there, and that means knowing where it lives. Repomix packs the checkout
 * into a single document — the file tree and the files' contents — so the
 * agent reads an area of the repository in one call instead of twenty.
 *
 * **The pack is the runner's, not the repository's.** Repomix loads a
 * `repomix.config.*` from the directory it packs, and a config is code: a
 * `.ts` config is executed and `input.processors` runs commands. The
 * repository being packed is not the runner's own, so its config is never
 * loaded, its processors never run, and what is packed is the runner's own
 * options over the runner's own rules.
 *
 * **The pack is what the guard would allow.** The pack hands files to the
 * model the way a read does, so the files the policy refuses — the ones
 * nobody hands to an agent — are not in it. The policy is asked the question
 * the guard asks, and the pack is made again without them.
 *
 * **The pack is of the worktree, and of nothing else.** Repomix reads a
 * two-segment name as a repository on GitHub and fetches it when no such
 * directory is here, so the runner hands it a directory that is here: the
 * worktree's own, and the absolute path to it.
 *
 * **The pack goes to a temporary file, not to the worktree.** The tree the
 * agent leaves is the tree the runner pushes, and a pack file left in it
 * would ride along with the change.
 *
 * **The pack is bounded.** The document goes into the model's context, next
 * to the conversation the turn is made of. Above {@link MAX_PACK_TOKENS} the
 * tool refuses and says why: the agent packs less — one directory, or the
 * tree alone.
 */

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { Type } from "typebox";

import { isProtectedPath } from "./guard.js";
import { defineTool, type AnyToolSpec } from "./tools.js";

/** The name of the tool that packs the repository. */
export const PACK_TOOL_NAME = "agent_pack_codebase";

/**
 * The most a pack may cost the model.
 *
 * The pack lands in the context next to the brief, the diff and the
 * conversation, and those are what the turn is made of. Sixty thousand tokens
 * is a document the model reads and a context that still holds the rest.
 */
export const MAX_PACK_TOKENS = 60_000;

/** What one pack did. */
export interface PackOutcome {
  /** The packed document. */
  readonly text: string;
  /** The files it holds, relative to the repository's root. */
  readonly paths: readonly string[];
  /** What it costs the model, in tokens. */
  readonly tokens: number;
  /** The files that were left out as suspicious. */
  readonly suspicious: readonly string[];
}

/** What to pack. */
export interface PackRequest {
  /** The worktree the path is relative to. */
  readonly cwd: string;
  /** The directory to pack, relative to the worktree. */
  readonly path: string;
  /** Only these files, as comma-separated glob patterns, relative to the packed directory. */
  readonly include?: string;
  /** Not these files, as comma-separated glob patterns, relative to the packed directory. */
  readonly ignore?: string;
  /** Whether the pack holds the tree without the files' contents. */
  readonly structureOnly: boolean;
  /** The most a pack may cost the model. */
  readonly maxTokens: number;
}

/**
 * How the code is packed.
 *
 * The seam a test replaces: the tool decides what may be packed and what the
 * model is told, and the packer does the packing.
 */
export type Packer = (request: PackRequest) => Promise<PackOutcome>;

/**
 * The refusal the model reads when the pack is too large for the context.
 *
 * It is written once, here: the packer refuses before it reads the document,
 * and the tool refuses after — and both say the same thing.
 */
function tooBig(tokens: number, maxTokens: number): string {
  return (
    `the pack is ${tokens} tokens and the context holds ${maxTokens} — pack less: ` +
    "one directory, or `structureOnly`"
  );
}

/**
 * Pack with repomix.
 *
 * The library, not the command: the runner holds the options, and the command
 * would hold them in a file the worktree has to carry. The pack goes to a
 * temporary file, because the tree the agent leaves is the tree the runner
 * pushes.
 *
 * The directory is handed over as an absolute path. Repomix reads a
 * two-segment name as a repository on GitHub and fetches it when no such
 * directory is here, so the runner never hands it a name it can read as a
 * remote.
 */
export const packWithRepomix: Packer = async (request) => {
  const { runCli } = await import("repomix");
  const directory = await mkdtemp(join(tmpdir(), "afk-pack-"));
  const output = join(directory, "pack.xml");
  try {
    const result = await runCli([resolve(request.cwd, request.path)], request.cwd, {
      output,
      quiet: true,
      // The repository's own config is code, and it is not the runner's.
      skipLocalConfig: true,
      skipGlobalConfig: true,
      enableFileProcessors: false,
      // The runner's own scan: the repository's config is never loaded, so
      // nothing in it can turn the scan off.
      securityCheck: true,
      files: !request.structureOnly,
      // The paths in the document are the repository's own, so the agent knows
      // where the files are and the policy can be asked about them.
      outputFilePathStyle: "cwd-relative",
      ...(request.include === undefined ? {} : { include: request.include }),
      ...(request.ignore === undefined ? {} : { ignore: request.ignore }),
    });
    if (result === undefined) {
      throw new Error("repomix packed nothing");
    }
    const tokens = result.packResult.totalTokens;
    if (tokens > request.maxTokens) {
      // The document is not read: a pack the context cannot hold is refused
      // before it is carried into memory.
      throw new Error(tooBig(tokens, request.maxTokens));
    }
    return {
      text: await readFile(output, "utf8"),
      paths: result.packResult.processedFiles.map((file) => file.path),
      tokens,
      suspicious: result.packResult.suspiciousFilesResults.map((file) => file.filePath),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

/**
 * Whether a path stays inside the worktree.
 *
 * The pack reads files, and the repository the brief is about is the worktree.
 * A path that climbs out of it is not that repository, and a pack of the
 * machine is not a document the model can read.
 */
export function insideWorktree(cwd: string, path: string): boolean {
  const root = resolve(cwd);
  const fromRoot = relative(root, resolve(root, path));
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

/** What the tool did. */
export interface PackDetails {
  /** Whether the pack was made. */
  readonly packed: boolean;
  /** How many files it holds. */
  readonly files: number;
  /** What it costs the model, in tokens. */
  readonly tokens: number;
  /** The path that was packed. */
  readonly path: string;
  /** Why nothing was packed, when nothing was. */
  readonly reason: string;
}

/** A refusal: the model sees it as a failed call, and why. */
function refusal(reason: string, path: string): {
  content: { type: "text"; text: string }[];
  details: PackDetails;
  isError: true;
} {
  return {
    content: [{ type: "text", text: `Not packed: ${reason}` }],
    details: { packed: false, files: 0, tokens: 0, path, reason },
    isError: true,
  };
}

/**
 * The tool that packs the repository for the agent.
 *
 * It is a working tool, not a decision: it packs what the agent names and
 * answers with the document. What it will not do is pack the machine — a path
 * outside the worktree, or a path that is not here at all, is refused — hand
 * over the files the policy refuses, or pack more than the model's context
 * holds, which is refused too, with the narrower pack the agent should try.
 */
export function createPackTool(options: {
  /** The worktree the agent works in. */
  readonly cwd: string;
  /** How the code is packed — the seam a test replaces. */
  readonly pack?: Packer;
  /** The most a pack may cost the model. */
  readonly maxTokens?: number;
}): AnyToolSpec {
  const pack = options.pack ?? packWithRepomix;
  const maxTokens = options.maxTokens ?? MAX_PACK_TOKENS;
  return defineTool({
    name: PACK_TOOL_NAME,
    label: "Pack the repository into one document",
    description:
      "Pack the repository into a single document — the file tree and the files' contents — so " +
      "you can read an area of it in one call instead of file by file. Name the directory to " +
      "pack, narrow it with glob patterns, or ask for the tree alone. The pack is refused when " +
      "it is too large for the context: pack one directory, or the tree alone, and pack again.",
    promptSnippet: "Pack an area of the repository into one document",
    promptGuidelines: [
      `Use ${PACK_TOOL_NAME} when the code you need is spread over several files.`,
      "A single file is read with the workspace's own tools; the pack is for the area around it.",
      "The patterns are relative to the directory you pack, not to the repository's root.",
      "A pack that is too large is refused — pack one directory, or `structureOnly`, and pack again.",
    ],
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({
          description:
            "The directory to pack, relative to the repository's root. Defaults to the whole repository.",
        }),
      ),
      include: Type.Optional(
        Type.String({
          description:
            "Only these files, as comma-separated glob patterns, relative to the directory you pack — `**/*.kt`.",
        }),
      ),
      ignore: Type.Optional(
        Type.String({
          description:
            "Not these files, as comma-separated glob patterns, relative to the directory you pack.",
        }),
      ),
      structureOnly: Type.Optional(
        Type.Boolean({
          description:
            "Pack the tree without the files' contents — the map of the repository, not the code.",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const path = params.path ?? ".";
      if (!insideWorktree(options.cwd, path)) {
        return refusal(`${path} is outside the repository`, path);
      }
      // The directory has to be here. Repomix reads a two-segment name as a
      // repository on GitHub and fetches it when there is no such directory
      // here, and the runner does not fetch anything the model names.
      if (!existsSync(resolve(options.cwd, path))) {
        return refusal(`there is no ${path} in the repository`, path);
      }
      const request: PackRequest = {
        cwd: options.cwd,
        path,
        ...(params.include === undefined ? {} : { include: params.include }),
        ...(params.ignore === undefined ? {} : { ignore: params.ignore }),
        structureOnly: params.structureOnly === true,
        maxTokens,
      };
      let outcome: PackOutcome;
      try {
        outcome = await pack(request);
      } catch (error) {
        return refusal(error instanceof Error ? error.message : String(error), path);
      }

      // The pack hands files to the model the way a read does, so the files
      // the policy refuses are not in it. The pack is made again without them;
      // the one that is handed over is the one that holds none.
      const denied = outcome.paths.filter((file) => isProtectedPath(file));
      if (denied.length > 0) {
        const root = resolve(options.cwd, path);
        const without = denied
          .map((file) => relative(root, resolve(options.cwd, file)))
          .join(",");
        try {
          outcome = await pack({
            ...request,
            ignore: request.ignore === undefined ? without : `${request.ignore},${without}`,
          });
        } catch (error) {
          return refusal(error instanceof Error ? error.message : String(error), path);
        }
        const still = outcome.paths.filter((file) => isProtectedPath(file));
        if (still.length > 0) {
          return refusal(
            `the pack holds ${still.join(", ")}, which nobody hands to an agent`,
            path,
          );
        }
      }

      if (outcome.tokens > maxTokens) {
        return refusal(tooBig(outcome.tokens, maxTokens), path);
      }
      const suspicious =
        outcome.suspicious.length === 0
          ? ""
          : ` ${outcome.suspicious.length} file(s) were left out as suspicious.`;
      return {
        content: [
          {
            type: "text",
            text:
              `Packed ${outcome.paths.length} file(s), ${outcome.tokens} tokens.${suspicious}\n\n` +
              outcome.text,
          },
        ],
        details: {
          packed: true,
          files: outcome.paths.length,
          tokens: outcome.tokens,
          path,
          reason: "",
        },
      };
    },
  });
}

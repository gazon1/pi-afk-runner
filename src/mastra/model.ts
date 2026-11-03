/**
 * The model the Mastra agent runs on.
 *
 * The command names a model as `provider/model`, and the provider is one the
 * runner carries a gateway for. The key comes from the environment: the
 * runner holds no credential of its own.
 */

import type { GatewayLanguageModel } from "@mastra/core/llm";

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ModelCatalogue } from "../pool.js";

import {
  MINIMAX_API_KEY,
  MINIMAX_DEFAULT_MODEL,
  MINIMAX_MODELS,
  MINIMAX_PROVIDER,
  MiniMaxGateway,
} from "./gateways/minimax.js";

import {
  COMMANDCODE_API_KEY,
  COMMANDCODE_PROVIDER,
  CommandCodeGateway,
} from "./gateways/commandcode.js";

/** The model a run uses when the command names none. */
export const DEFAULT_MASTRA_MODEL = `${MINIMAX_PROVIDER}/${MINIMAX_DEFAULT_MODEL}`;

/**
 * The model the reference names.
 *
 * The reference is `provider/model`, and the provider is one the runner
 * carries a gateway for.
 */
export async function resolveMastraModel(reference: string): Promise<GatewayLanguageModel> {
  const separator = reference.indexOf("/");
  if (separator <= 0 || separator === reference.length - 1) {
    throw new Error(`--model must name a model, as provider/model — got ${reference}`);
  }
  const provider = reference.slice(0, separator);
  const modelId = reference.slice(separator + 1);
  if (provider === MINIMAX_PROVIDER) {
    const gateway = new MiniMaxGateway();
    const apiKey = await gateway.getApiKey(modelId);
    return await gateway.resolveLanguageModel({ modelId, providerId: provider, apiKey });
  }
  if (provider === COMMANDCODE_PROVIDER) {
    const gateway = new CommandCodeGateway();
    const apiKey = await gateway.getApiKey(modelId);
    return await gateway.resolveLanguageModel({ modelId, providerId: provider, apiKey });
  }
  throw new Error(
    `the runner carries no provider ${provider} — it carries ${MINIMAX_PROVIDER}, ${COMMANDCODE_PROVIDER}`,
  );
}

/**
 * The models the runner carries, as the pool's catalogue says them.
 *
 * The catalogue is the engine's own: the pool asks what the runner carries,
 * and the runner's answer is the gateway's list. The pool does not know what
 * an engine carries — it asks.
 */
export function mastraCatalogue(): ModelCatalogue {
  return {
    carries: (reference: string): boolean => {
      const separator = reference.indexOf("/");
      if (separator <= 0 || separator === reference.length - 1) {
        return false;
      }
      const provider = reference.slice(0, separator);
      const id = reference.slice(separator + 1);
      if (provider === MINIMAX_PROVIDER) {
        return MINIMAX_MODELS.includes(id);
      }
      if (provider === COMMANDCODE_PROVIDER) {
        return true;
      }
      return false;
    },
    hasCredential: (reference: string): boolean => {
      const separator = reference.indexOf("/");
      if (separator <= 0 || separator === reference.length - 1) {
        return false;
      }
      const provider = reference.slice(0, separator);
      if (provider === MINIMAX_PROVIDER) {
        return true;
      }
      if (provider === COMMANDCODE_PROVIDER) {
        return true;
      }
      return false;
    },
  };
}

/** Whether the host has the credential the provider needs. */
export function hasMastraKey(): boolean {
  const key = process.env[MINIMAX_API_KEY] ?? process.env[COMMANDCODE_API_KEY];
  if (key !== undefined && key !== "") {
    return true;
  }
  try {
    const raw = readFileSync(join(homedir(), ".commandcode", "auth.json"), "utf8");
    const parsed = JSON.parse(raw) as { apiKey?: unknown };
    if (typeof parsed.apiKey === "string" && parsed.apiKey !== "") {
      return true;
    }
  } catch {
    // no auth file
  }
  return false;
}

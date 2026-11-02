/**
 * The model the Mastra agent runs on.
 *
 * The command names a model as `provider/model`, and the provider is one the
 * runner carries a gateway for. The key comes from the environment: the
 * runner holds no credential of its own.
 */

import type { GatewayLanguageModel } from "@mastra/core/llm";

import {
  MINIMAX_DEFAULT_MODEL,
  MINIMAX_PROVIDER,
  MiniMaxGateway,
} from "./gateways/minimax.js";

/** The model a run uses when the command names none. */
export const DEFAULT_MASTRA_MODEL = `${MINIMAX_PROVIDER}/${MINIMAX_DEFAULT_MODEL}`;

/**
 * The model the reference names.
 *
 * The reference is `provider/model`, the same shape the Pi engine's
 * `--model` has, and the provider is one the runner carries a gateway for.
 */
export async function resolveMastraModel(reference: string): Promise<GatewayLanguageModel> {
  const separator = reference.indexOf("/");
  if (separator <= 0 || separator === reference.length - 1) {
    throw new Error(`--model must name a model, as provider/model — got ${reference}`);
  }
  const provider = reference.slice(0, separator);
  const modelId = reference.slice(separator + 1);
  if (provider !== MINIMAX_PROVIDER) {
    throw new Error(
      `the Mastra engine carries no provider ${provider} — it carries ${MINIMAX_PROVIDER}`,
    );
  }
  const gateway = new MiniMaxGateway();
  const apiKey = await gateway.getApiKey(modelId);
  return await gateway.resolveLanguageModel({ modelId, providerId: provider, apiKey });
}

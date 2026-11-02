/**
 * The MiniMax gateway.
 *
 * MiniMax speaks the Anthropic API, so the gateway is a name, a list of
 * models and a URL. The key is read from the environment and never travels
 * with the runner: a credential in the code is a credential in the history.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import {
  MastraModelGateway,
  type GatewayLanguageModel,
  type ProviderConfig,
} from "@mastra/core/llm";

/** Where MiniMax's Anthropic-compatible API lives. */
const MINIMAX_URL = "https://api.minimax.io/anthropic/v1";

/** The environment variable the key is read from. */
const MINIMAX_API_KEY = "MINIMAX_API_KEY";

/** The provider the gateway's models are named under. */
export const MINIMAX_PROVIDER = "minimax";

/** The models the gateway serves. */
const MINIMAX_MODELS: readonly string[] = [
  "MiniMax-M3",
  "MiniMax-M3.1-Flash",
  "MiniMax-M2.7",
  "MiniMax-M2.7-highspeed",
  "MiniMax-M2.5",
  "MiniMax-M2.5-highspeed",
  "MiniMax-M2.1",
  "MiniMax-M2.1-highspeed",
  "MiniMax-M2",
];

/** The model a run uses when the command names none. */
export const MINIMAX_DEFAULT_MODEL = "MiniMax-M2.7";

/**
 * The gateway the runner talks to.
 *
 * It is the same gateway the `mastra-app` project runs on: MiniMax's models
 * under one provider, with the key from the environment.
 */
export class MiniMaxGateway extends MastraModelGateway {
  readonly id = "minimax-gateway";
  readonly name = "MiniMax";

  async fetchProviders(): Promise<Record<string, ProviderConfig>> {
    return {
      [MINIMAX_PROVIDER]: {
        name: "MiniMax",
        models: [...MINIMAX_MODELS],
        apiKeyEnvVar: MINIMAX_API_KEY,
        gateway: this.id,
        url: MINIMAX_URL,
        docUrl: "https://platform.minimax.io/docs",
      },
    };
  }

  buildUrl(): string {
    return MINIMAX_URL;
  }

  async getApiKey(_modelId: string): Promise<string> {
    const key = process.env[MINIMAX_API_KEY];
    if (key === undefined || key === "") {
      throw new Error(
        `the ${MINIMAX_API_KEY} environment variable is not set — the agent has no model to run on`,
      );
    }
    return key;
  }

  async resolveLanguageModel({
    modelId,
    providerId,
    apiKey,
  }: {
    modelId: string;
    providerId: string;
    apiKey: string;
  }): Promise<GatewayLanguageModel> {
    return createAnthropic({
      name: providerId,
      apiKey,
      baseURL: this.buildUrl(),
    }).messages(modelId);
  }
}

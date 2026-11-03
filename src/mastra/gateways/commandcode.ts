/**
 * The Command Code gateway.
 *
 * Command Code serves OpenAI-compatible chat completions at
 * api.commandcode.ai/provider/v1, with the bearer token from the host's
 * Command Code login (or COMMAND_CODE_API_KEY).
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  MastraModelGateway,
  type GatewayLanguageModel,
  type ProviderConfig,
} from "@mastra/core/llm";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where Command Code's auth file lives. */
const AUTH_FILE = join(homedir(), ".commandcode", "auth.json");

/** The environment variable the key is read from. */
export const COMMANDCODE_API_KEY = "COMMAND_CODE_API_KEY";

/** The provider the gateway's models are named under. */
export const COMMANDCODE_PROVIDER = "commandcode";

/** The base URL of Command Code's OpenAI-compatible endpoint. */
const COMMANDCODE_URL = "https://api.commandcode.ai/provider/v1";

/** A few models the host can name; the host's own list is authoritative. */
export const COMMANDCODE_MODELS: readonly string[] = [
  "reflection/beam:free",
];

/** The model a run uses when the command names none. */
export const COMMANDCODE_DEFAULT_MODEL = "reflection/beam:free";

function readAuthKey(): string | undefined {
  try {
    const raw = readFileSync(AUTH_FILE, "utf8");
    const parsed = JSON.parse(raw) as { apiKey?: unknown };
    if (typeof parsed.apiKey === "string" && parsed.apiKey !== "") {
      return parsed.apiKey;
    }
  } catch {
    // no auth file: fall through
  }
  return undefined;
}

export class CommandCodeGateway extends MastraModelGateway {
  readonly id = "commandcode-gateway";
  readonly name = "Command Code";

  async fetchProviders(): Promise<Record<string, ProviderConfig>> {
    return {
      [COMMANDCODE_PROVIDER]: {
        name: "Command Code",
        models: [...COMMANDCODE_MODELS],
        apiKeyEnvVar: COMMANDCODE_API_KEY,
        gateway: this.id,
        url: COMMANDCODE_URL,
        docUrl: "https://commandcode.ai/docs",
      },
    };
  }

  buildUrl(): string {
    return COMMANDCODE_URL;
  }

  async getApiKey(_modelId: string): Promise<string> {
    const key = process.env[COMMANDCODE_API_KEY] ?? readAuthKey();
    if (key === undefined || key === "") {
      throw new Error(
        `no Command Code credential found — set ${COMMANDCODE_API_KEY} or run \`cmd login\``,
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
    const provider = createOpenAICompatible({
      name: providerId,
      baseURL: this.buildUrl(),
      apiKey,
    });
    return provider.chatModel(modelId);
  }
}

/**
 * The Command Code gateway.
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

const AUTH_FILE = join(homedir(), ".commandcode", "auth.json");
export const COMMANDCODE_API_KEY = "COMMAND_CODE_API_KEY";
export const COMMANDCODE_PROVIDER = "commandcode";
const COMMANDCODE_URL = "https://api.commandcode.ai/provider/v1";

/**
 * The reasoning an assistant message carries when the model has none of its own
 * and there is none of the model's to borrow.
 *
 * Reasoning models (e.g. `reflection/beam:free`) want the reasoning of every
 * earlier assistant message sent back with them, and refuse a request that
 * leaves one out.
 */
export const ENGINE_REASONING = "The engine's own message.";

/**
 * Give every assistant message a reasoning, when the model reasons.
 *
 * The SDK carries the model's own reasoning back — it is a part of the
 * assistant message it builds. The **engine's** messages are the ones without
 * it: the feedback the engine injects between the steps is an assistant
 * message of its own, and the model never wrote it, so it has no reasoning.
 *
 * A message without a reasoning gets the last reasoning the model wrote
 * before it, and the placeholder when there is none before it — the order of
 * the messages does not matter, and the cut of the history does not either. A
 * model that does not reason at all is left alone: it is not asked for a
 * reasoning it does not have.
 *
 * Says whether a message was changed, so that the body is built again only
 * when it is worth it.
 */
function withReasoning(messages: Array<Record<string, unknown>>): boolean {
  let asked = false;
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    const own = message.reasoning_content;
    if (typeof own === "string" && own !== "") {
      asked = true;
      break;
    }
  }
  if (!asked) {
    return false;
  }

  let changed = false;
  let last: string | undefined;
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    const own = message.reasoning_content;
    if (typeof own === "string" && own !== "") {
      last = own;
      continue;
    }
    message.reasoning_content = last ?? ENGINE_REASONING;
    changed = true;
  }
  return changed;
}

function authKey(): string | undefined {
  const env = process.env[COMMANDCODE_API_KEY];
  if (env) return env;
  try {
    const raw = readFileSync(AUTH_FILE, "utf8");
    const parsed = JSON.parse(raw) as { apiKey?: unknown };
    if (typeof parsed.apiKey === "string" && parsed.apiKey !== "") return parsed.apiKey;
  } catch {
    // no auth file
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
        models: [],
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
    const key = authKey();
    if (!key)
      throw new Error(
        `no Command Code credential found — set ${COMMANDCODE_API_KEY} or run cmd login`,
      );
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
    const fetchImpl = async (input: unknown, init?: RequestInit): Promise<Response> => {
      // The reasoning of every assistant message goes back with it.
      const initAny = init as { body?: unknown } | undefined;
      if (initAny?.body && typeof initAny.body === "string") {
        try {
          const body = JSON.parse(initAny.body) as { messages?: Array<Record<string, unknown>> };
          if (Array.isArray(body.messages)) {
            const changed = withReasoning(body.messages);
            if (changed && init) (init as { body?: string }).body = JSON.stringify(body);
          }
        } catch {
          // leave body untouched
        }
      }
      return await fetch(input as any, init);
    };

    const provider = createOpenAICompatible({
      name: providerId,
      baseURL: this.buildUrl(),
      apiKey,
      fetch: fetchImpl,
    });
    return provider.chatModel(modelId);
  }
}

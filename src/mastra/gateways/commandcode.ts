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

// Reasoning models (e.g. reflection/beam:free) require `reasoning_content` echoed
// back for every earlier assistant message. The SDK drops it between turns, so we
// stash it from each response and re-inject it into the next request.
const reasoningByTurn: string[] = [];

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
        models: ["reflection/beam:free"],
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
    if (!key) throw new Error(`no Command Code credential found — set ${COMMANDCODE_API_KEY} or run cmd login`);
    return key;
  }

  async resolveLanguageModel({ modelId, providerId, apiKey }: { modelId: string; providerId: string; apiKey: string }): Promise<GatewayLanguageModel> {
    const fetchImpl = async (input: unknown, init?: RequestInit): Promise<Response> => {
      // Inject reasoning_content into assistant messages before sending.
      const initAny = init as { body?: unknown } | undefined;
      if (initAny?.body && typeof initAny.body === "string") {
        try {
          const body = JSON.parse(initAny.body) as { messages?: Array<Record<string, unknown>> };
          if (Array.isArray(body.messages)) {
            let assistantIndex = 0;
            for (const msg of body.messages) {
              if (msg.role === "assistant" && msg.reasoning_content === undefined) {
                const stored = reasoningByTurn[assistantIndex];
                if (stored) msg.reasoning_content = stored;
              }
              if (msg.role === "assistant") assistantIndex++;
            }
            if (init) (init as { body?: string }).body = JSON.stringify(body);
          }
        } catch {
          // leave body untouched
        }
      }
      const res = await fetch(input as any, init);
      // Stash reasoning_content from the response for the next turn.
      try {
        const clone = (res as any).clone();
        const json = (await clone.json()) as { choices?: Array<{ message?: { reasoning_content?: string } }> };
        const rc = json.choices?.[0]?.message?.reasoning_content;
        if (typeof rc === "string" && rc !== "") {
          reasoningByTurn.push(rc);
        }
      } catch {
        // non-JSON or streaming: ignore
      }
      return res;
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

/**
 * The Command Code gateway.
 *
 * The provider behind it is a reasoning model: it wants the reasoning of every
 * earlier assistant message sent back with it, and refuses a request that
 * leaves one out. The engine's own messages — the feedback it injects between
 * the steps — are assistant messages without a reasoning, and the gateway is
 * what gives them one.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { CommandCodeGateway, ENGINE_REASONING } from "../src/mastra/gateways/commandcode.js";

/** A provider that answers every request. */
function stubProvider(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "done" } }] }), {
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}

/** The body the provider was asked to send. */
function sentBody(): unknown {
  const call = vi.mocked(globalThis.fetch).mock.calls.at(-1);
  const init = call?.[1] as RequestInit | undefined;
  return JSON.parse(init?.body as string);
}

/** The gateway's model, ready to be asked. */
async function model(
  modelId: string,
): Promise<Awaited<ReturnType<CommandCodeGateway["resolveLanguageModel"]>>> {
  const gateway = new CommandCodeGateway();
  return gateway.resolveLanguageModel({
    modelId,
    providerId: "commandcode",
    apiKey: "test",
  });
}

describe("the Command Code gateway", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("gives_the_engines_own_message_the_reasoning_the_provider_asks_for", async () => {
    stubProvider();

    await (
      await model("reflection/beam:free")
    ).doGenerate({
      prompt: [
        { role: "user", content: [{ type: "text", text: "read the file" }] },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "the file is under shared/src" },
            { type: "text", text: "I read it." },
          ],
        },
        { role: "user", content: [{ type: "text", text: "the result" }] },
        {
          role: "assistant",
          content: [{ type: "text", text: "You have read enough." }],
        },
      ],
    });

    const messages = (sentBody() as { messages: Array<Record<string, unknown>> }).messages;
    expect(messages[1]?.reasoning_content).toBe("the file is under shared/src");
    // The engine's own message: no reasoning of its own, and the provider
    // refuses a request that leaves one out.
    expect(messages[3]?.reasoning_content).toBe("the file is under shared/src");
  });

  it("gives_the_reasoning_to_the_engines_own_message_even_when_it_comes_first", async () => {
    stubProvider();

    // The history was cut here: the engine's own message is the first one, and
    // the model's own reasoning comes later. The provider wants a reasoning on
    // every assistant message, whatever the order.
    await (
      await model("reflection/beam:free")
    ).doGenerate({
      prompt: [
        {
          role: "assistant",
          content: [{ type: "text", text: "You have read enough." }],
        },
        { role: "user", content: [{ type: "text", text: "read the file" }] },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "the file is under shared/src" },
            { type: "text", text: "I read it." },
          ],
        },
      ],
    });

    const messages = (sentBody() as { messages: Array<Record<string, unknown>> }).messages;
    expect(messages[0]?.reasoning_content).toBe(ENGINE_REASONING);
    expect(messages[2]?.reasoning_content).toBe("the file is under shared/src");
  });

  it("leaves_a_model_that_does_not_reason_alone", async () => {
    stubProvider();

    await (
      await model("some-model")
    ).doGenerate({
      prompt: [
        { role: "user", content: [{ type: "text", text: "read the file" }] },
        {
          role: "assistant",
          content: [{ type: "text", text: "You have read enough." }],
        },
      ],
    });

    const messages = (sentBody() as { messages: Array<Record<string, unknown>> }).messages;
    expect(messages[1]?.reasoning_content).toBeUndefined();
  });
});

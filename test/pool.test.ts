/**
 * The model pool.
 *
 * The pool is a file, and the file is the policy: which model is preferred,
 * when one of them is at its peak tariff, and which of them needs a proxy. The
 * runner picks from it, moves on when a model's limit is gone, and looks again
 * every few minutes.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ProxyAgent, getGlobalDispatcher } from "undici";
import { afterEach, describe, expect, it } from "vitest";

import { piSessionFactory } from "../src/cli.js";
import {
  NoModelAvailable,
  describePool,
  isLimitFailure,
  newPoolState,
  isPeak,
  parsePool,
  pickPoolModel,
  readPool,
  windowHolds,
  type Pool,
  type PooledModel,
} from "../src/pool.js";
import { PoolSession } from "../src/pool-session.js";
import { useProxy } from "../src/proxy.js";
import { createFixtureRepository } from "./git-sandbox.js";

/** The pool the tests pick from: the best model, one behind a proxy, and a spare. */
const POOL = `
models:
  - model: fake/beam
    priority: 100
  - model: fake/proxied
    priority: 120
    proxy: true
  - model: fake/spare
    priority: 50
`;

/**
 * A runtime that knows a few models.
 *
 * The models it can reach are the ones in `available`; the rest are in the
 * catalogue and cannot be used.
 */
class FakeRuntime {
  /** The models that can be reached now — `provider/id`. */
  readonly available = new Set<string>();

  constructor(private readonly known: readonly string[]) {}

  getModel(provider: string, id: string): PooledModel | undefined {
    return this.known.includes(`${provider}/${id}`)
      ? ({ provider, id } as unknown as PooledModel)
      : undefined;
  }

  hasConfiguredAuth(): boolean {
    return true;
  }

  async getAvailable(provider: string): Promise<readonly PooledModel[]> {
    return [...this.available]
      .filter((reference) => reference.startsWith(`${provider}/`))
      .map((reference) => ({ id: reference.slice(provider.length + 1) } as unknown as PooledModel));
  }

  /** The runtime the pool talks to. */
  get runtime(): ModelRuntime {
    return this as unknown as ModelRuntime;
  }
}

/** A host that answers with the text it is given, and remembers what it was told. */
class FakeHost {
  readonly prompts: string[] = [];
  readonly models: string[] = [];
  messages: readonly { role: string; stopReason: string; errorMessage?: string }[] = [];

  private turn = 0;

  constructor(private readonly failures: readonly (string | Error | null)[]) {}

  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    const failure = this.failures[this.turn] ?? null;
    this.turn += 1;
    if (failure instanceof Error) {
      // The SDK throws when the provider's credential is gone.
      throw failure;
    }
    this.messages = [
      {
        role: "assistant",
        stopReason: failure === null ? "stop" : "error",
        ...(failure === null ? {} : { errorMessage: failure }),
      },
    ];
  }

  async abort(): Promise<void> {}

  dispose(): void {}

  async setModel(model: PooledModel): Promise<void> {
    this.models.push(model.id);
  }
}

describe("the model pool", () => {
  it("reads_the_models_and_their_conditions_out_of_the_file", () => {
    const pool = parsePool(
      [
        "checkEveryMs: 60000",
        "models:",
        "  - model: deepseek/deepseek-chat",
        "    priority: 40",
        "    peak:",
        "      - '00:00-16:00'",
        "    timezone: UTC",
        "  - model: fake/beam",
        "    priority: 100",
        "    proxy: true",
      ].join("\n"),
    );

    expect(pool.checkEveryMs).toBe(60000);
    expect(pool.models).toHaveLength(2);
    expect(pool.models[0]).toEqual({
      reference: "deepseek/deepseek-chat",
      priority: 40,
      proxy: false,
      peak: ["00:00-16:00"],
      timezone: "UTC",
    });
    expect(pool.models[1]).toEqual({
      reference: "fake/beam",
      priority: 100,
      proxy: true,
      peak: [],
    });
  });

  it("refuses_a_file_it_cannot_read_rather_than_guessing", () => {
    // A mistyped key that is ignored is a model used at the wrong priority,
    // and nothing would say so.
    expect(() => parsePool("models:\n  - model: fake/beam\n    priorety: 100\n")).toThrow(
      /priorety/,
    );
    expect(() => parsePool("models:\n  - model: beam\n")).toThrow(/provider\/id/);
    expect(() => parsePool("models:\n  - model: fake/beam\n    peak: '19:00'\n")).toThrow(
      /HH:MM-HH:MM/,
    );
    expect(() => parsePool("modles: []\n")).toThrow(/modles/);
    // A zone that cannot be read throws in the middle of a run, where it says
    // nothing about the file that is wrong.
    expect(() => parsePool("models:\n  - model: fake/beam\n    timezone: UTC+3\n")).toThrow(
      /timezone/,
    );
  });

  it("counts_the_peak_hours_in_the_model_own_timezone", () => {
    const model = {
      reference: "deepseek/deepseek-chat",
      priority: 0,
      proxy: false,
      peak: ["00:00-16:00"],
      timezone: "UTC",
    };

    // Ten in the morning UTC is inside DeepSeek's peak hours, eight in the
    // evening is not.
    expect(isPeak(model, new Date("2026-11-02T10:00:00Z"))).toBe(true);
    expect(isPeak(model, new Date("2026-11-02T20:00:00Z"))).toBe(false);
  });

  it("holds_both_ends_of_a_window_that_crosses_midnight", () => {
    expect(windowHolds("22:00-02:00", 23 * 60)).toBe(true);
    expect(windowHolds("22:00-02:00", 60)).toBe(true);
    expect(windowHolds("22:00-02:00", 12 * 60)).toBe(false);
  });

  it("takes_the_model_with_the_biggest_priority_that_can_be_used", () => {
    const pool = parsePool(POOL);

    // The proxied model has the biggest priority, and this host has no proxy.
    expect(pickPoolModel(pool, { proxyConfigured: false })?.reference).toBe("fake/beam");
    expect(pickPoolModel(pool, { proxyConfigured: true })?.reference).toBe("fake/proxied");
  });

  it("gives_every_model_a_proxy_of_its_own", () => {
    const pool = parsePool(
      "models:\n  - model: fake/beam\n    priority: 100\n    proxy: http://127.0.0.1:8080\n",
    );

    // The model's own proxy is its own: the host has no proxy of its own, and
    // the model is still the one that would be used.
    expect(pool.models[0]?.proxy).toBe("http://127.0.0.1:8080");
    expect(pickPoolModel(pool, { proxyConfigured: false })?.reference).toBe("fake/beam");

    // A proxy that is not an HTTP one would fail at the first request with
    // nothing in the log to say why.
    expect(() =>
      parsePool("models:\n  - model: fake/beam\n    proxy: socks5://127.0.0.1:1080\n"),
    ).toThrow(/http/);
  });

  it("says_what_the_file_means_now", () => {
    const pool = parsePool(
      "models:\n  - model: fake/beam\n    priority: 100\n  - model: fake/spare\n    priority: 50\n    peak: ['00:00-23:59']\n",
    );

    const lines = describePool(pool, { now: new Date("2026-11-02T10:00:00Z") });

    expect(lines[0]).toContain("fake/beam");
    expect(lines[0]).toContain("it would be used");
    expect(lines[1]).toContain("fake/spare");
    expect(lines[1]).toContain("peak");
  });

  it("skips_the_models_that_cannot_be_used_now", () => {
    const pool = parsePool(POOL);

    // The limit of the best model is gone.
    expect(
      pickPoolModel(pool, { proxyConfigured: true, exhausted: new Set(["fake/proxied"]) })
        ?.reference,
    ).toBe("fake/beam");

    // The best model is at its peak tariff.
    const peak = parsePool(
      "models:\n  - model: fake/beam\n    priority: 100\n    peak: ['00:00-23:59']\n",
    );
    expect(pickPoolModel(peak, { now: new Date("2026-11-02T10:00:00Z") })).toBeUndefined();
  });

  it("knows_the_words_a_provider_uses_when_a_limit_is_gone", () => {
    expect(isLimitFailure("commandcode API error (429): RATE_LIMITED")).toBe(true);
    expect(isLimitFailure("the model's turn failed: quota exceeded")).toBe(true);
    expect(isLimitFailure("the model's turn failed: too many requests")).toBe(true);
    expect(isLimitFailure("the model's turn failed: the model does not exist")).toBe(false);
  });

  it("knows_the_words_a_provider_uses_when_it_has_no_credit_left", () => {
    // Anthropic says it this way, and the pool is here for exactly this.
    expect(
      isLimitFailure("Your credit balance is too low to access the Anthropic API"),
    ).toBe(true);
    expect(
      isLimitFailure('Authentication failed for "deepseek". Credentials may have expired'),
    ).toBe(true);
  });
});

describe("a session in the pool", () => {
  afterEach(() => {
    // The dispatcher is global: the tests must not leave one behind.
    useProxy(undefined, {});
  });

  it("moves_to_the_next_model_when_the_limit_is_gone_and_takes_the_turn_again", async () => {
    const runtime = new FakeRuntime(["fake/beam", "fake/spare"]);
    const host = new FakeHost(["commandcode API error (429): RATE_LIMITED", null]);
    const session = new PoolSession({
      host,
      runtime: runtime.runtime,
      pool: parsePool("models:\n  - model: fake/beam\n    priority: 100\n  - model: fake/spare\n    priority: 50\n"),
      reference: "fake/beam",
      state: newPoolState(),
      proxyConfigured: true,
    });

    await session.prompt("do the work");

    // The turn was taken again on the model that could answer it.
    expect(host.prompts).toEqual(["do the work", "do the work"]);
    expect(host.models).toEqual(["spare"]);
    expect(session.reference).toBe("fake/spare");
    session.dispose();
  });

  it("gives_up_when_the_pool_has_nothing_else", async () => {
    const runtime = new FakeRuntime(["fake/beam"]);
    const host = new FakeHost(["429 RATE_LIMITED"]);
    const session = new PoolSession({
      host,
      runtime: runtime.runtime,
      pool: parsePool("models:\n  - model: fake/beam\n    priority: 100\n"),
      reference: "fake/beam",
      state: newPoolState(),
      proxyConfigured: true,
    });

    await expect(session.prompt("do the work")).rejects.toThrow(NoModelAvailable);
    session.dispose();
  });

  it("gives_up_when_every_model_has_run_out", async () => {
    const runtime = new FakeRuntime(["fake/beam", "fake/spare"]);
    const host = new FakeHost(["429 RATE_LIMITED", "429 RATE_LIMITED"]);
    const session = new PoolSession({
      host,
      runtime: runtime.runtime,
      pool: parsePool(
        "models:\n  - model: fake/beam\n    priority: 100\n  - model: fake/spare\n    priority: 50\n",
      ),
      reference: "fake/beam",
      state: newPoolState(),
      proxyConfigured: true,
    });

    // Both models are out of their limit: there is no model left to try.
    await expect(session.prompt("do the work")).rejects.toThrow(NoModelAvailable);
    expect(host.models).toEqual(["spare"]);
    session.dispose();
  });

  it("remembers_the_models_whose_limit_is_gone_for_the_whole_run", async () => {
    const state = newPoolState();
    const runtime = new FakeRuntime(["fake/beam", "fake/spare"]);
    const host = new FakeHost(["429 RATE_LIMITED"]);
    const pool = parsePool(
      "models:\n  - model: fake/beam\n    priority: 100\n  - model: fake/spare\n    priority: 50\n",
    );
    const session = new PoolSession({
      host,
      runtime: runtime.runtime,
      pool,
      reference: "fake/beam",
      state,
      proxyConfigured: true,
    });

    // The beam is out of its limit, and the turn is taken again on the spare.
    await session.prompt("do the work");
    session.dispose();

    // The model is out for the whole run and not for this session alone: the
    // next session of the sweep does not try it again.
    expect(state.exhausted.has("fake/beam")).toBe(true);
    expect(pickPoolModel(pool, { exhausted: state.exhausted })?.reference).toBe("fake/spare");
  });

  it("moves_on_when_the_provider_has_no_credential_left", async () => {
    const runtime = new FakeRuntime(["fake/beam", "fake/spare"]);
    const host = new FakeHost([
      new Error('Authentication failed for "fake". Credentials may have expired'),
      null,
    ]);
    const session = new PoolSession({
      host,
      runtime: runtime.runtime,
      pool: parsePool(
        "models:\n  - model: fake/beam\n    priority: 100\n  - model: fake/spare\n    priority: 50\n",
      ),
      reference: "fake/beam",
      state: newPoolState(),
      proxyConfigured: true,
    });

    // The turn is taken again on the model that can answer it.
    await session.prompt("do the work");
    expect(host.models).toEqual(["spare"]);
    expect(host.prompts).toEqual(["do the work", "do the work"]);
    session.dispose();
  });

  it("leaves_a_model_the_provider_no_longer_offers", async () => {
    const runtime = new FakeRuntime(["fake/beam", "fake/spare"]);
    const host = new FakeHost([null]);
    const session = new PoolSession({
      host,
      runtime: runtime.runtime,
      pool: parsePool(
        "checkEveryMs: 5\nmodels:\n  - model: fake/beam\n    priority: 100\n  - model: fake/spare\n    priority: 50\n",
      ),
      reference: "fake/beam",
      state: newPoolState(),
      proxyConfigured: true,
    });

    // The provider offers the spare now: the beam is not there any more.
    runtime.available.add("fake/spare");
    const moved = await waitFor(() => host.models.length > 0);
    expect(moved).toBe(true);
    expect(host.models).toEqual(["spare"]);
    session.dispose();
  });

  it("does_not_look_at_the_pool_twice_at_once", async () => {
    let looks = 0;
    const slow = {
      getModel: () => ({ provider: "fake", id: "beam" }) as unknown as PooledModel,
      hasConfiguredAuth: () => true,
      getAvailable: async () => {
        looks += 1;
        await new Promise((resolve) => setTimeout(resolve, 60));
        return [{ id: "beam" } as unknown as PooledModel];
      },
    } as unknown as ModelRuntime;
    const session = new PoolSession({
      host: new FakeHost([null]),
      runtime: slow,
      pool: parsePool("checkEveryMs: 5\nmodels:\n  - model: fake/beam\n    priority: 100\n"),
      reference: "fake/beam",
      state: newPoolState(),
      proxyConfigured: true,
    });

    // The timer fires again and again while the look is still going.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(looks).toBe(1);
    session.dispose();
  });

  it("reads_the_file_again_when_the_host_changes_it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "afk-runner-pool-"));
    const file = join(directory, "models.yaml");
    await writeFile(
      file,
      "checkEveryMs: 5\nmodels:\n  - model: fake/beam\n    priority: 100\n",
      "utf8",
    );
    try {
      const runtime = new FakeRuntime(["fake/beam", "fake/spare"]);
      const host = new FakeHost([null]);
      const pool = await readPool(file);
      const session = new PoolSession({
        host,
        runtime: runtime.runtime,
        pool: pool as Pool,
        reference: "fake/beam",
        state: newPoolState(),
        proxyConfigured: true,
      });
      runtime.available.add("fake/beam");
      runtime.available.add("fake/spare");

      // The host changes the file: the spare is the model now.
      await new Promise((resolve) => setTimeout(resolve, 10));
      await writeFile(
        file,
        "checkEveryMs: 5\nmodels:\n  - model: fake/spare\n    priority: 100\n",
        "utf8",
      );
      const moved = await waitFor(() => host.models.length > 0);
      expect(moved).toBe(true);
      expect(host.models).toEqual(["spare"]);
      session.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("moves_to_a_model_that_became_available", async () => {
    const runtime = new FakeRuntime(["fake/beam", "fake/spare"]);
    const host = new FakeHost([null]);
    const session = new PoolSession({
      host,
      runtime: runtime.runtime,
      pool: parsePool(
        "checkEveryMs: 5\nmodels:\n  - model: fake/beam\n    priority: 50\n  - model: fake/spare\n    priority: 100\n",
      ),
      reference: "fake/beam",
      state: newPoolState(),
      proxyConfigured: true,
    });

    // The spare model is not reachable yet.
    runtime.available.add("fake/beam");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(host.models).toEqual([]);

    // And now it is: the session moves onto it.
    runtime.available.add("fake/spare");
    const moved = await waitFor(() => host.models.length > 0);
    expect(moved).toBe(true);
    expect(host.models).toEqual(["spare"]);
    expect(session.reference).toBe("fake/spare");
    session.dispose();
  });

  it("survives_a_look_at_the_pool_that_fails", async () => {
    const events: string[] = [];
    const runtime = new FakeRuntime(["fake/beam", "fake/spare"]);
    runtime.available.add("fake/spare");
    const host = new FakeHost([null]);
    host.setModel = async () => {
      throw new Error("the provider refused the model");
    };
    const session = new PoolSession({
      host,
      runtime: runtime.runtime,
      pool: parsePool(
        "checkEveryMs: 5\nmodels:\n  - model: fake/beam\n    priority: 100\n  - model: fake/spare\n    priority: 120\n",
      ),
      reference: "fake/beam",
      state: newPoolState(),
      proxyConfigured: true,
      onEvent: (line) => events.push(line),
    });

    // The look fails, and the run keeps going: an unhandled refusal here would
    // take the whole process down in the middle of the sweep.
    const reported = await waitFor(() =>
      events.some((line) => line.startsWith("the pool could not look again")),
    );
    expect(reported).toBe(true);
    session.dispose();
  });

  it("gives_the_proxy_back_when_the_session_is_released", () => {
    const runtime = new FakeRuntime(["fake/beam"]);
    const session = new PoolSession({
      host: new FakeHost([null]),
      runtime: runtime.runtime,
      pool: parsePool(
        "models:\n  - model: fake/beam\n    priority: 100\n    proxy: http://127.0.0.1:3128\n",
      ),
      reference: "fake/beam",
      state: newPoolState(),
      proxyConfigured: true,
    });

    // The model's own proxy carries the model's requests while it runs.
    expect(getGlobalDispatcher()).toBeInstanceOf(ProxyAgent);

    // And the host's own is back when the session is released: the host's chat
    // in the same process must not go through the model's proxy.
    session.dispose();
    expect(getGlobalDispatcher()).not.toBeInstanceOf(ProxyAgent);
  });
});

describe("the pool and a real session", () => {
  it("runs the session on the model the pool prefers", async () => {
    const fixture = await createFixtureRepository();
    const agentDirectory = join(fixture.root, "agent");
    const previous = process.env.PI_CODING_AGENT_DIR;
    try {
      await mkdir(agentDirectory, { recursive: true });
      await writeFile(
        join(agentDirectory, "models.json"),
        JSON.stringify({
          providers: {
            fake: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:1",
              apiKey: "test",
              models: [{ id: "beam" }, { id: "spare" }],
            },
          },
        }),
        "utf8",
      );
      process.env.PI_CODING_AGENT_DIR = agentDirectory;

      const pool = parsePool(
        "models:\n  - model: fake/beam\n    priority: 100\n  - model: fake/spare\n    priority: 50\n",
      );
      const session = await piSessionFactory({ agentDirectory, pool })({
        cwd: fixture.repo,
        systemPromptSections: {},
      });

      expect(session.reference).toBe("fake/beam");
      session.dispose();
    } finally {
      if (previous === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previous;
      }
      await fixture.dispose();
    }
  });

  it("runs the session on the other model when the first one is at its peak", async () => {
    const fixture = await createFixtureRepository();
    const agentDirectory = join(fixture.root, "agent");
    const previous = process.env.PI_CODING_AGENT_DIR;
    try {
      await mkdir(agentDirectory, { recursive: true });
      await writeFile(
        join(agentDirectory, "models.json"),
        JSON.stringify({
          providers: {
            fake: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:1",
              apiKey: "test",
              models: [{ id: "beam" }, { id: "spare" }],
            },
          },
        }),
        "utf8",
      );
      process.env.PI_CODING_AGENT_DIR = agentDirectory;

      const pool = parsePool(
        "models:\n  - model: fake/beam\n    priority: 100\n    peak: ['00:00-23:59']\n  - model: fake/spare\n    priority: 50\n",
      );
      const session = await piSessionFactory({ agentDirectory, pool })({
        cwd: fixture.repo,
        systemPromptSections: {},
      });

      expect(session.reference).toBe("fake/spare");
      session.dispose();
    } finally {
      if (previous === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previous;
      }
      await fixture.dispose();
    }
  });
});

/** Whether the thing happens within a second — the pool's own clock. */
async function waitFor(happened: () => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (happened()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

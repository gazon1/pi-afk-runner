/**
 * The model pool.
 *
 * The pool is a file, and the file is the policy: which model is preferred,
 * when one of them is at its peak tariff, and which of them needs a proxy. The
 * runner picks from it, moves on when a model's limit is gone, and looks again
 * every few minutes.
 *
 * The pool does not know what an engine carries: it asks a catalogue. The fake
 * catalogue below is the runner's own answer, and nothing else.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProxyAgent, getGlobalDispatcher } from "undici";
import { afterEach, describe, expect, it } from "vitest";

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
  type ModelCatalogue,
  type Pool,
} from "../src/pool.js";
import { PoolSession, createPoolSession, type PoolHost } from "../src/pool-session.js";
import { useProxy } from "../src/proxy.js";
import { journalFactory } from "../src/journal.js";
import type { TurnMessage } from "../src/session.js";

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
 * The catalogue: what the runner carries, and what the host has a key for.
 *
 * The set of carried models can change while the session runs — that is how a
 * provider stops offering a model.
 */
class FakeCatalogue implements ModelCatalogue {
  /** The models the runner carries — `provider/id`. */
  readonly carried = new Set<string>();
  /** The providers that have a credential. */
  readonly credentials = new Set<string>();

  constructor(references: readonly string[]) {
    for (const reference of references) {
      this.carried.add(reference);
      const separator = reference.indexOf("/");
      this.credentials.add(reference.slice(0, separator));
    }
  }

  carries(reference: string): boolean {
    return this.carried.has(reference);
  }

  hasCredential(reference: string): boolean {
    const separator = reference.indexOf("/");
    return separator > 0 && this.credentials.has(reference.slice(0, separator));
  }
}

/** A host that answers with the text it is given, and remembers what it was told. */
class FakeHost implements PoolHost {
  readonly prompts: string[] = [];
  readonly models: string[] = [];
  messages: readonly TurnMessage[] = [];

  private turn = 0;

  constructor(private readonly failures: readonly (string | Error | null)[]) {}

  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    const failure = this.failures[this.turn] ?? null;
    this.turn += 1;
    if (failure instanceof Error) {
      // The engine throws when the provider's credential is gone.
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

  async setModel(reference: string): Promise<void> {
    this.models.push(reference);
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

  it("reads_the_effort_a_model_thinks_at_out_of_the_file", () => {
    const pool = parsePool(
      "models:\n  - model: fake/beam\n    priority: 100\n    effort: high\n  - model: fake/spare\n    priority: 50\n",
    );

    expect(pool.models[0]?.effort).toBe("high");
    // A model the file says nothing about keeps the level the engine gives it.
    expect(pool.models[1]?.effort).toBeUndefined();

    // A mistyped level that is ignored is a model that thinks at the wrong
    // level, and nothing would say so.
    expect(() => parsePool("models:\n  - model: fake/beam\n    effort: hign\n")).toThrow(/effort/);
    expect(() => parsePool("models:\n  - model: fake/beam\n    effort: 3\n")).toThrow(/effort/);
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
      "models:\n  - model: fake/beam\n    priority: 100\n    effort: high\n  - model: fake/spare\n    priority: 50\n    peak: ['00:00-23:59']\n",
    );

    const lines = describePool(pool, { now: new Date("2026-11-02T10:00:00Z") });

    expect(lines[0]).toContain("fake/beam");
    expect(lines[0]).toContain("it would be used");
    // The host has to see the level its file names, or the file is a secret.
    expect(lines[0]).toContain("effort high");
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
    expect(isLimitFailure("Your credit balance is too low to access the Anthropic API")).toBe(true);
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
    const catalogue = new FakeCatalogue(["fake/beam", "fake/spare"]);
    const host = new FakeHost(["commandcode API error (429): RATE_LIMITED", null]);
    const session = new PoolSession({
      host,
      catalogue,
      pool: parsePool(
        "models:\n  - model: fake/beam\n    priority: 100\n  - model: fake/spare\n    priority: 50\n",
      ),
      reference: "fake/beam",
      state: newPoolState(),
      proxyConfigured: true,
    });

    await session.prompt("do the work");

    // The turn was taken again on the model that could answer it.
    expect(host.prompts).toEqual(["do the work", "do the work"]);
    expect(host.models).toEqual(["fake/spare"]);
    expect(session.reference).toBe("fake/spare");
    session.dispose();
  });

  it("gives_up_when_the_pool_has_nothing_else", async () => {
    const catalogue = new FakeCatalogue(["fake/beam"]);
    const host = new FakeHost(["429 RATE_LIMITED"]);
    const session = new PoolSession({
      host,
      catalogue,
      pool: parsePool("models:\n  - model: fake/beam\n    priority: 100\n"),
      reference: "fake/beam",
      state: newPoolState(),
      proxyConfigured: true,
    });

    await expect(session.prompt("do the work")).rejects.toThrow(NoModelAvailable);
    session.dispose();
  });

  it("gives_up_when_every_model_has_run_out", async () => {
    const catalogue = new FakeCatalogue(["fake/beam", "fake/spare"]);
    const host = new FakeHost(["429 RATE_LIMITED", "429 RATE_LIMITED"]);
    const session = new PoolSession({
      host,
      catalogue,
      pool: parsePool(
        "models:\n  - model: fake/beam\n    priority: 100\n  - model: fake/spare\n    priority: 50\n",
      ),
      reference: "fake/beam",
      state: newPoolState(),
      proxyConfigured: true,
    });

    // Both models are out of their limit: there is no model left to try.
    await expect(session.prompt("do the work")).rejects.toThrow(NoModelAvailable);
    expect(host.models).toEqual(["fake/spare"]);
    session.dispose();
  });

  it("remembers_the_models_whose_limit_is_gone_for_the_whole_run", async () => {
    const state = newPoolState();
    const catalogue = new FakeCatalogue(["fake/beam", "fake/spare"]);
    const host = new FakeHost(["429 RATE_LIMITED"]);
    const pool = parsePool(
      "models:\n  - model: fake/beam\n    priority: 100\n  - model: fake/spare\n    priority: 50\n",
    );
    const session = new PoolSession({
      host,
      catalogue,
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
    const catalogue = new FakeCatalogue(["fake/beam", "fake/spare"]);
    const host = new FakeHost([
      new Error('Authentication failed for "fake". Credentials may have expired'),
      null,
    ]);
    const session = new PoolSession({
      host,
      catalogue,
      pool: parsePool(
        "models:\n  - model: fake/beam\n    priority: 100\n  - model: fake/spare\n    priority: 50\n",
      ),
      reference: "fake/beam",
      state: newPoolState(),
      proxyConfigured: true,
    });

    // The turn is taken again on the model that can answer it.
    await session.prompt("do the work");
    expect(host.models).toEqual(["fake/spare"]);
    expect(host.prompts).toEqual(["do the work", "do the work"]);
    session.dispose();
  });

  it("leaves_a_model_the_provider_no_longer_offers", async () => {
    const catalogue = new FakeCatalogue(["fake/beam", "fake/spare"]);
    const host = new FakeHost([null]);
    const session = new PoolSession({
      host,
      catalogue,
      pool: parsePool(
        "checkEveryMs: 5\nmodels:\n  - model: fake/beam\n    priority: 100\n  - model: fake/spare\n    priority: 50\n",
      ),
      reference: "fake/beam",
      state: newPoolState(),
      proxyConfigured: true,
    });

    // The provider offers the spare now: the beam is not there any more.
    catalogue.carried.delete("fake/beam");
    const moved = await waitFor(() => host.models.length > 0);
    expect(moved).toBe(true);
    expect(host.models).toEqual(["fake/spare"]);
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
      const catalogue = new FakeCatalogue(["fake/beam", "fake/spare"]);
      const host = new FakeHost([null]);
      const pool = await readPool(file);
      const session = new PoolSession({
        host,
        catalogue,
        pool: pool as Pool,
        reference: "fake/beam",
        state: newPoolState(),
        proxyConfigured: true,
      });

      // The host changes the file: the spare is the model now.
      await new Promise((resolve) => setTimeout(resolve, 10));
      await writeFile(
        file,
        "checkEveryMs: 5\nmodels:\n  - model: fake/spare\n    priority: 100\n",
        "utf8",
      );
      const moved = await waitFor(() => host.models.length > 0);
      expect(moved).toBe(true);
      expect(host.models).toEqual(["fake/spare"]);
      session.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("moves_to_a_model_that_became_available", async () => {
    const catalogue = new FakeCatalogue(["fake/beam"]);
    const host = new FakeHost([null]);
    const session = new PoolSession({
      host,
      catalogue,
      pool: parsePool(
        "checkEveryMs: 5\nmodels:\n  - model: fake/beam\n    priority: 50\n  - model: fake/spare\n    priority: 100\n",
      ),
      reference: "fake/beam",
      state: newPoolState(),
      proxyConfigured: true,
    });

    // The spare model is not carried yet.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(host.models).toEqual([]);

    // And now it is: the session moves onto it.
    catalogue.carried.add("fake/spare");
    const moved = await waitFor(() => host.models.length > 0);
    expect(moved).toBe(true);
    expect(host.models).toEqual(["fake/spare"]);
    expect(session.reference).toBe("fake/spare");
    session.dispose();
  });

  it("survives_a_look_at_the_pool_that_fails", async () => {
    const events: string[] = [];
    const catalogue = new FakeCatalogue(["fake/beam", "fake/spare"]);
    const host = new FakeHost([null]);
    host.setModel = async () => {
      throw new Error("the provider refused the model");
    };
    const session = new PoolSession({
      host,
      catalogue,
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
    const catalogue = new FakeCatalogue(["fake/beam"]);
    const session = new PoolSession({
      host: new FakeHost([null]),
      catalogue,
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

  it("says_its_lines_to_the_journal_the_run_writes", async () => {
    // The pool's lines are the run's lines: a model switch the journal does
    // not show is a switch the reader of the journal cannot see. The session
    // is built the way the command line builds it, so the journal holds the
    // pool's lines for the same reason in a run and here.
    const directory = await mkdtemp(join(tmpdir(), "afk-pool-journal-"));
    const journal = join(directory, "run.log");
    try {
      const catalogue = new FakeCatalogue(["fake/beam", "fake/spare"]);
      const host = new FakeHost(["429 RATE_LIMITED", null]);
      const said: string[] = [];
      const factory = journalFactory(async (sessionOptions) => {
        const session = createPoolSession({
          host,
          catalogue,
          pool: parsePool(
            "models:\n  - model: fake/beam\n    priority: 100\n  - model: fake/spare\n    priority: 50\n",
          ),
          reference: "fake/beam",
          state: newPoolState(),
          proxyConfigured: true,
          poolEvent: (line) => {
            said.push(line);
          },
          session: sessionOptions,
        });
        // The session's own line, between the pool's two.
        sessionOptions.onEvent?.("the agent is working");
        return session;
      }, journal);
      const session = await factory({ cwd: directory, systemPromptSections: {} });
      await session.prompt("do the work");
      session.dispose();

      // The pool said what it did, on its own channel...
      expect(said).toContain("the model is now fake/beam");
      // ...and the journal holds it, among the session's own lines, in the
      // order it happened.
      const lines = (await readFile(journal, "utf8"))
        .split("\n")
        .filter((line) => line.trim() !== "");
      expect(lines).toEqual([
        "the model is now fake/beam",
        "the agent is working",
        "fake/beam has run out of its limit — the model is now fake/spare",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
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

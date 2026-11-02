/**
 * The session the pool drives.
 *
 * One session, many models: the pool picks the model the session starts on,
 * and moves the session when that model cannot answer — because its limit is
 * gone, because the provider stopped offering it, or because a better model
 * became available while the runner worked.
 *
 * What the pool remembers is not the session's business: the models whose
 * limit is gone are remembered for the whole run, so a sweep does not try a
 * dead model again on the next issue.
 */

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import {
  NoModelAvailable,
  type EffortLevel,
  type Pool,
  type PoolModel,
  type PoolState,
  type PooledModel,
  isLimitFailure,
  knownModel,
  pickPoolModel,
  rereadPool,
  splitReference,
} from "./pool.js";
import { useProxy } from "./proxy.js";
import { type AgentSession, type TurnMessage, lastAssistant, turnFailure } from "./session.js";

/** The session the pool drives — the SDK's own, as far as the pool is concerned. */
export interface PoolHost {
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  readonly messages?: readonly TurnMessage[];
  setModel(model: PooledModel): Promise<void>;
  /**
   * The level the session thinks at.
   *
   * The SDK's session has one, and it clamps the level to what the model can
   * do: a level the model does not have becomes the nearest one it has.
   */
  setThinkingLevel(level: EffortLevel): void;
}

/**
 * A session that moves between the pool's models.
 *
 * Four things move it. A turn that failed because the model's limit is gone
 * moves it to the next model, and the turn is taken again there — as many
 * times as the pool has models. A model that is at its peak tariff is not used
 * at all. The file is read again when the host has changed it. And every few
 * minutes the models are looked at, so a model that has become available while
 * the runner works is picked up rather than waited for — but only upwards: the
 * runner does not leave a working model for a worse one on a whim.
 */
export class PoolSession implements AgentSession {
  private current: string;
  private pool: Pool;
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  private checking = false;

  constructor(
    private readonly options: {
      readonly host: PoolHost;
      readonly runtime: ModelRuntime;
      readonly pool: Pool;
      /** What the pool remembers for the whole run. */
      readonly state: PoolState;
      /** The model the session starts on. */
      readonly reference: string;
      readonly proxyConfigured: boolean;
      readonly onEvent?: (line: string) => void;
    },
  ) {
    this.current = options.reference;
    this.pool = options.pool;
    this.applyEffort(this.entry(this.current));
    this.useProxyFor(this.current);
    this.options.onEvent?.(`the model is now ${this.current}`);
    this.startTimer();
  }

  /** The session's messages — the host's own. */
  get messages(): readonly TurnMessage[] {
    return this.options.host.messages ?? [];
  }

  /** The model the session runs on — `provider/id`. */
  get reference(): string {
    return this.current;
  }

  /**
   * Send one turn, and move to another model when this one cannot answer it.
   *
   * The turn is taken again on the model that can answer it, so a limit that
   * runs out halfway through a session costs the session a turn and not the
   * run. Every model of the pool is tried in turn: when the last one has run
   * out of its limit too, there is no model left, and the run says so.
   */
  async prompt(text: string): Promise<void> {
    this.busy = true;
    try {
      for (;;) {
        const failure = await this.turn(text);
        if (failure === null || !isLimitFailure(failure.message)) {
          return;
        }
        // This model cannot answer: its limit is gone, or its credential is.
        // It is out for the rest of the run.
        this.options.state.exhausted.add(this.current);
        const next = this.next();
        if (next === undefined) {
          throw new NoModelAvailable(
            `no model is available: ${this.current} has run out of its limit, and the pool has nothing else`,
          );
        }
        await this.switchTo(next, `${this.current} has run out of its limit`);
      }
    } finally {
      this.busy = false;
    }
  }

  /**
   * The failure the turn ended on — or null when it ended well.
   *
   * The SDK resolves a turn whose model call failed, and throws when the
   * provider's credential is gone. Both are the model's problem, and both say
   * the same thing: this model cannot answer.
   */
  private async turn(text: string): Promise<Error | null> {
    try {
      await this.options.host.prompt(text);
    } catch (failure) {
      const error = failure instanceof Error ? failure : new Error(String(failure));
      if (!isLimitFailure(error.message)) {
        // A failure that is not about the model is the run's, and it goes out
        // as it came.
        throw error;
      }
      return error;
    }
    return turnFailure(lastAssistant(this.options.host.messages));
  }

  /** Interrupt the turn that is running. */
  async abort(): Promise<void> {
    await this.options.host.abort();
  }

  /**
   * Release the session, and the timer that looks at the pool.
   *
   * The proxy goes back to the host's own: the model's proxy is the model's,
   * and the host's chat in the same process must not go through it.
   */
  dispose(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.options.host.dispose();
    useProxy(undefined);
  }

  /**
   * The next model, when this one is gone.
   *
   * The check is the local one — the model is in the catalogue and its provider
   * has a credential — because the limit is gone now and the run cannot wait
   * for a network round trip.
   */
  private next(): PoolModel | undefined {
    return pickPoolModel(this.pool, {
      exhausted: this.options.state.exhausted,
      proxyConfigured: this.options.proxyConfigured,
      now: new Date(),
      usable: (model) => knownModel(this.options.runtime, model.reference),
    });
  }

  /**
   * Look at the pool again.
   *
   * The file is read again when the host has changed it, and the models are
   * looked at as they are reachable **now**: a provider whose credential has
   * run out has no models to offer, and a model that has become free of its
   * limit is one the runner may move to.
   */
  private async check(): Promise<void> {
    if (this.busy || this.checking) {
      // A turn is running, or the last look is still going: there is nothing
      // to look at twice.
      return;
    }
    this.checking = true;
    try {
      await this.reload();
      const reachable = await this.reachable();
      const best = this.best(reachable);
      if (best === undefined || best.reference === this.current) {
        return;
      }
      const current = this.pool.models.find((model) => model.reference === this.current);
      // Upwards only: the runner moves to a better model when one appears, and
      // away from this one when its limit is gone. It does not leave a working
      // model for a worse one. A model the provider no longer offers is not a
      // working model, and the runner does leave it.
      const upwards = (current?.priority ?? 0) < best.priority;
      const stillThere =
        current !== undefined && this.isReachable(reachable, current.reference);
      if (!this.options.state.exhausted.has(this.current) && !upwards && stillThere) {
        return;
      }
      const reason = upwards
        ? `${best.reference} has the bigger priority`
        : `${this.current} is not offered any more`;
      await this.switchTo(best, reason);
    } finally {
      this.checking = false;
    }
  }

  /**
   * Read the file again, when the host has changed it.
   *
   * A file that cannot be read now is not a reason to stop the run: the pool
   * the run started with is still the host's last word on the matter, and the
   * run says that the new file is wrong.
   */
  private async reload(): Promise<void> {
    let fresh: Pool | null;
    try {
      fresh = await rereadPool(this.pool);
    } catch (failure) {
      this.options.onEvent?.(
        `the pool file could not be read again: ${
          failure instanceof Error ? failure.message : String(failure)
        }`,
      );
      return;
    }
    if (fresh === null) {
      return;
    }
    const before = this.pool.checkEveryMs;
    this.pool = fresh;
    this.options.onEvent?.("the pool file has changed");
    if (fresh.checkEveryMs !== before) {
      this.startTimer();
    }
  }

  /** Start the pool's own clock, and start it again when the file changes. */
  private startTimer(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.timer = setInterval(() => {
      // A look that fails is the pool's problem, not the run's: an unhandled
      // refusal here would take the whole process down mid-sweep.
      void this.check().catch((failure) => {
        this.options.onEvent?.(
          `the pool could not look again: ${
            failure instanceof Error ? failure.message : String(failure)
          }`,
        );
      });
    }, this.pool.checkEveryMs);
    // The timer must not keep the process alive: the runner's own deadline is
    // what ends a run.
    this.timer.unref();
  }

  /** The models of every provider in the pool that can be reached right now. */
  private async reachable(): Promise<Map<string, ReadonlySet<string>>> {
    const providers = new Set<string>();
    for (const model of this.pool.models) {
      providers.add(splitReference(model.reference, "the pool's model").provider);
    }
    const reachable = new Map<string, ReadonlySet<string>>();
    await Promise.all(
      [...providers].map(async (provider) => {
        reachable.set(provider, new Set(await this.available(provider)));
      }),
    );
    return reachable;
  }

  /** Whether the model is among the reachable ones. */
  private isReachable(
    reachable: ReadonlyMap<string, ReadonlySet<string>>,
    reference: string,
  ): boolean {
    const { provider, id } = splitReference(reference, "the pool's model");
    return reachable.get(provider)?.has(id) === true;
  }

  /** The best model that can be reached right now. */
  private best(reachable: ReadonlyMap<string, ReadonlySet<string>>): PoolModel | undefined {
    return pickPoolModel(this.pool, {
      exhausted: this.options.state.exhausted,
      proxyConfigured: this.options.proxyConfigured,
      now: new Date(),
      usable: (model) => this.isReachable(reachable, model.reference),
    });
  }

  /** The models of the provider that can be reached right now. */
  private async available(provider: string): Promise<readonly string[]> {
    try {
      const models = await this.options.runtime.getAvailable(provider);
      return models.map((model) => model.id);
    } catch {
      // A provider that cannot be reached has no models to offer.
      return [];
    }
  }

  /** Move the session onto another model, and say so. */
  private async switchTo(model: PoolModel, reason: string): Promise<void> {
    const { provider, id } = splitReference(model.reference, "the pool's model");
    const target = this.options.runtime.getModel(provider, id);
    if (target === undefined) {
      throw new NoModelAvailable(`the provider ${provider} has no model ${id}`);
    }
    await this.options.host.setModel(target);
    this.current = model.reference;
    // The model was set first: the SDK gives the new model its own level, and
    // the file's level is the last word about it.
    this.applyEffort(model);
    this.useProxyFor(this.current);
    this.options.onEvent?.(`${reason} — the model is now ${model.reference}`);
  }

  /** The pool's own entry for the model the session runs on. */
  private entry(reference: string): PoolModel | undefined {
    return this.pool.models.find((model) => model.reference === reference);
  }

  /**
   * Set the level the file names for this model.
   *
   * A model the file says nothing about keeps the level the SDK gave it when
   * the model was set: the SDK knows what its own models can do, and the file
   * did not say otherwise.
   */
  private applyEffort(model: PoolModel | undefined): void {
    if (model?.effort === undefined) {
      return;
    }
    this.options.host.setThinkingLevel(model.effort);
  }

  /**
   * Route this model's requests through the proxy the file names for it.
   *
   * A model without a proxy of its own goes through the host's own, and a host
   * without one goes direct.
   */
  private useProxyFor(reference: string): void {
    const model = this.entry(reference);
    useProxy(typeof model?.proxy === "string" ? model.proxy : undefined);
  }
}

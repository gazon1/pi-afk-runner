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

import {
  NoModelAvailable,
  type ModelCatalogue,
  type Pool,
  type PoolModel,
  type PoolState,
  isLimitFailure,
  knownModel,
  pickPoolModel,
  rereadPool,
  splitReference,
} from "./pool.js";
import { useProxy } from "./proxy.js";
import { type AgentSession, type TurnMessage, lastAssistant, turnFailure } from "./session.js";

/** The session the pool drives — the engine's own, as far as the pool is concerned. */
export interface PoolHost {
  /** Send one turn and resolve when it settles. */
  prompt(text: string): Promise<void>;
  /** Interrupt the turn that is running. */
  abort(): Promise<void>;
  /** Release the session. */
  dispose(): void;
  /** The session's messages, when it keeps them. */
  readonly messages?: readonly TurnMessage[] | undefined;
  /**
   * Move the session onto another model — `provider/id`.
   *
   * The session keeps its conversation: the move is a new model on the same
   * memory, not a new session.
   */
  setModel(reference: string): Promise<void>;
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
      /** What the runner knows about the models it may use. */
      readonly catalogue: ModelCatalogue;
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
   * The engine resolves a turn whose model call failed, and throws when the
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
      usable: (model) => knownModel(this.options.catalogue, model.reference),
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
      const stillThere = current !== undefined && this.isReachable(reachable, current.reference);
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
  private available(provider: string): readonly string[] {
    const models: string[] = [];
    for (const model of this.pool.models) {
      const { provider: own, id } = splitReference(model.reference, "the pool's model");
      if (own !== provider) {
        continue;
      }
      if (knownModel(this.options.catalogue, model.reference)) {
        models.push(id);
      }
    }
    return models;
  }

  /** Move the session onto another model, and say so. */
  private async switchTo(model: PoolModel, reason: string): Promise<void> {
    if (!knownModel(this.options.catalogue, model.reference)) {
      throw new NoModelAvailable(`the runner carries no model ${model.reference}`);
    }
    await this.options.host.setModel(model.reference);
    this.current = model.reference;
    this.useProxyFor(this.current);
    this.options.onEvent?.(`${reason} — the model is now ${model.reference}`);
  }

  /** The pool's own entry for the model the session runs on. */
  private entry(reference: string): PoolModel | undefined {
    return this.pool.models.find((model) => model.reference === reference);
  }

  /**
   * The level the file names for this model.
   *
   * The engine has no thinking level to set — a Mastra agent runs the model
   * it was given — so the level is the host's policy and the pool reports it
   * rather than applying it. `--show-pool` says what the file means.
   */
  private effort(model: PoolModel | undefined): string | undefined {
    return model?.effort;
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

/**
 * The session's own channel — the journal's writer is installed on it.
 *
 * The pool's lines travel on it, next to the session's own lines, so a reader
 * of the journal sees them in the order the run happened.
 */
export interface SessionChannel {
  /** Told what the session is doing, as it does it. */
  readonly onEvent?: ((line: string) => void) | undefined;
}

/**
 * The pool's channel, and the session's own — composed.
 *
 * The pool's lines are the run's lines: the model a session starts on, the
 * model whose limit is gone, the file that changed under the pool. They reach
 * the command line and the record through the pool's own channel, and they
 * reach the **journal** — the file the run writes while it works — through the
 * session's own channel. A reader of that one file then sees the session's
 * calls and the model they were made against, in the order they happened.
 */
export function poolEventChannel(options: {
  /** The pool's own channel — the command line and the record. */
  readonly pool: (line: string) => void;
  /**
   * The session the pool drives — its own channel is the journal.
   *
   * The session's own channel, and not a copy of it: the line is written when
   * the pool says it, so the journal reads in the order the run happened.
   */
  readonly session: SessionChannel;
}): (line: string) => void {
  return (line) => {
    options.pool(line);
    options.session.onEvent?.(line);
  };
}

/**
 * The pooled session the run drives.
 *
 * One rule, one place: the pool's lines go to the pool's own channel and to
 * the session's own channel, and this is where the two are joined. The command
 * line builds the session this way, and so does the suite — so the journal the
 * run writes holds the pool's lines for the same reason it holds them in a
 * run.
 *
 * The session's own options are not optional here: without them the pool's
 * lines would reach the command line and stop there, and the journal would
 * lose the model switches without anything failing.
 */
export function createPoolSession(options: {
  /** The session the pool drives — the engine's own. */
  readonly host: PoolHost;
  /** What the runner knows about the models it may use. */
  readonly catalogue: ModelCatalogue;
  /** The pool the session draws its models from. */
  readonly pool: Pool;
  /** What the pool remembers for the whole run. */
  readonly state: PoolState;
  /** The model the session starts on. */
  readonly reference: string;
  /** Whether the host has a proxy of its own. */
  readonly proxyConfigured: boolean;
  /** The pool's own channel — the command line and the record. */
  readonly poolEvent: (line: string) => void;
  /**
   * The session's own options — its event channel is the journal.
   */
  readonly session: SessionChannel;
}): PoolSession {
  return new PoolSession({
    host: options.host,
    catalogue: options.catalogue,
    pool: options.pool,
    state: options.state,
    reference: options.reference,
    proxyConfigured: options.proxyConfigured,
    onEvent: poolEventChannel({
      pool: options.poolEvent,
      session: options.session,
    }),
  });
}

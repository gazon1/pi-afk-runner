/**
 * The model pool: the file the host owns, and the rules that read it.
 *
 * The models the runner may use, in one file: which of them is preferred, when
 * one of them is at its peak tariff, and which of them is reached through a
 * proxy. The rules here are pure — the file, the moment, and what the pool
 * knows — so a host can ask what its own file means without running anything.
 *
 * The file is the host's, not the repository's: it lives beside Pi's settings
 * and credentials, in the agent's directory, and `--pool` names another one.
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { parse as parseYaml } from "yaml";

/**
 * The level a model thinks at — the SDK's own levels.
 *
 * The list is the SDK's, taken from its own type: the runner does not invent
 * levels the SDK would refuse.
 */
export type EffortLevel = Parameters<AgentSession["setThinkingLevel"]>[0];

/** The levels a file may name. */
const EFFORT_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly EffortLevel[];

/** One model in the pool. */
export interface PoolModel {
  /** The model — `provider/id`. */
  readonly reference: string;
  /** The bigger number is preferred. */
  readonly priority: number;
  /**
   * The level the model thinks at.
   *
   * Absent when the file does not say: the model runs at the level the SDK
   * gives it, and the SDK knows what its own models can do.
   */
  readonly effort?: EffortLevel;
  /**
   * The proxy this model's requests go through.
   *
   * A URL is that model's own proxy. `true` is the host's own proxy — the one
   * the environment names — and a model that needs it cannot be used without
   * it.
   */
  readonly proxy: string | boolean;
  /** The hours the model is at its peak tariff — `HH:MM-HH:MM`. */
  readonly peak: readonly string[];
  /** The timezone the peak hours are counted in — the host's own when it is absent. */
  readonly timezone?: string;
}

/** The pool: the models, and how often it is looked at again. */
export interface Pool {
  readonly models: readonly PoolModel[];
  /** How often the pool is checked again — the pool's own cron. */
  readonly checkEveryMs: number;
  /** The file the pool was read from — the runner reads it again when it changes. */
  readonly path?: string;
  /** The file's own timestamp when it was read. */
  readonly mtimeMs?: number;
}

/** How often the pool is checked again when the file does not say: five minutes. */
export const DEFAULT_CHECK_EVERY_MS = 300_000;

/** The name of the pool file in the agent's directory. */
export const POOL_FILE = "models.yaml";

/** The SDK's own model — the thing `setModel` takes. */
export type PooledModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

/** No model in the pool can be used. */
export class NoModelAvailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoModelAvailable";
  }
}

/**
 * What the pool remembers between the sessions of one run.
 *
 * A model whose limit is gone is gone for the whole run: a sweep that works
 * one issue after another must not try the dead model again on the next
 * issue, and a session that ends does not bring it back.
 */
export interface PoolState {
  /** The models whose limit is gone. */
  readonly exhausted: Set<string>;
}

/** The pool's memory of a run that has just started. */
export function newPoolState(): PoolState {
  return { exhausted: new Set<string>() };
}

/** The pool file in the agent's directory. */
export function poolFile(agentDirectory: string): string {
  return join(agentDirectory, POOL_FILE);
}

/**
 * Read the pool, or null when there is no pool file.
 *
 * A file that is there but cannot be read is a failure: a pool the runner
 * cannot read is not a pool it may ignore, because the models it names are the
 * models the host meant to use.
 */
export async function readPool(path: string): Promise<Pool | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw failure;
  }
  const pool = parsePool(text, path);
  const stamp = await mtimeOf(path);
  return stamp === undefined ? { ...pool, path } : { ...pool, path, mtimeMs: stamp };
}

/**
 * The pool as the file has it now — or null when the file has not changed.
 *
 * The file is the host's policy, and the host may change it while the runner
 * works. It is read again only when it has actually changed: a file that was
 * touched but not changed costs nothing to read again, and a run that reads it
 * every few minutes would notice a host's edit.
 */
export async function rereadPool(pool: Pool): Promise<Pool | null> {
  if (pool.path === undefined) {
    return null;
  }
  const stamp = await mtimeOf(pool.path);
  if (stamp === undefined || stamp === pool.mtimeMs) {
    return null;
  }
  return readPool(pool.path);
}

/** When the file was last changed, or undefined when it cannot be told. */
async function mtimeOf(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * The pool the file describes.
 *
 * Every key is checked: a mistyped `priorety` that is ignored is a model used
 * at the wrong priority, and nothing would say so.
 */
export function parsePool(text: string, source = "the pool"): Pool {
  let document: unknown;
  try {
    document = parseYaml(text);
  } catch (failure) {
    throw new Error(
      `${source} is not valid YAML: ${failure instanceof Error ? failure.message : String(failure)}`,
    );
  }
  if (!isRecord(document)) {
    throw new Error(`${source} must be a mapping with a list of models`);
  }
  for (const key of Object.keys(document)) {
    if (key !== "models" && key !== "checkEveryMs") {
      throw new Error(`${source} has a key the pool does not know: ${key}`);
    }
  }
  const raw = document.models;
  if (!Array.isArray(raw)) {
    throw new Error(`${source} must have a list of models`);
  }
  const models = raw.map((entry, index) => parseModel(entry, index, source));
  const checkEveryMs =
    document.checkEveryMs === undefined
      ? DEFAULT_CHECK_EVERY_MS
      : numberOf(document.checkEveryMs, "checkEveryMs", source);
  if (checkEveryMs <= 0) {
    throw new Error(`${source}: checkEveryMs must be a positive number of milliseconds`);
  }
  return { models, checkEveryMs };
}

/** One model, as the file describes it. */
function parseModel(entry: unknown, index: number, source: string): PoolModel {
  if (!isRecord(entry)) {
    throw new Error(`${source}: model ${index} is not a mapping`);
  }
  for (const key of Object.keys(entry)) {
    if (!["model", "priority", "proxy", "peak", "timezone", "effort"].includes(key)) {
      throw new Error(`${source}: model ${index} has a key the pool does not know: ${key}`);
    }
  }
  const reference = entry.model;
  if (typeof reference !== "string" || !reference.includes("/")) {
    throw new Error(`${source}: model ${index} must name a model as provider/id`);
  }
  const priority =
    entry.priority === undefined ? 0 : numberOf(entry.priority, `model ${index} priority`, source);
  const effort = effortOf(entry.effort, index, source);
  const proxy = proxyOf(entry.proxy, index, source);
  const peak = peakOf(entry.peak, index, source);
  for (const window of peak) {
    // A window that cannot be read would be a peak that never comes.
    parseWindow(window, source);
  }
  const timezone = timezoneOf(entry.timezone, index, source);
  return {
    reference,
    priority,
    ...(effort === undefined ? {} : { effort }),
    proxy,
    peak,
    ...(timezone === undefined ? {} : { timezone }),
  };
}

/**
 * The level one model thinks at.
 *
 * A level the SDK does not know is refused when the file is read: a mistyped
 * `effort: hign` that is ignored is a model that thinks at the wrong level,
 * and nothing would say so.
 */
function effortOf(value: unknown, index: number, source: string): EffortLevel | undefined {
  if (value === undefined) {
    return undefined;
  }
  const level = stringOf(value, `model ${index} effort`, source);
  if (!(EFFORT_LEVELS as readonly string[]).includes(level)) {
    throw new Error(
      `${source}: model ${index} effort must be one of ${EFFORT_LEVELS.join(", ")} — got ${level}`,
    );
  }
  return level as EffortLevel;
}

/**
 * The proxy one model is reached through.
 *
 * A URL is that model's own proxy, and only HTTP is spoken: undici's proxy
 * agent tunnels over CONNECT, and a `socks://` URL would fail at the first
 * request with nothing in the log to say why.
 */
function proxyOf(value: unknown, index: number, source: string): string | boolean {
  if (value === undefined || value === false) {
    return false;
  }
  if (value === true) {
    return true;
  }
  const url = stringOf(value, `model ${index} proxy`, source);
  if (!/^https?:\/\//u.test(url)) {
    throw new Error(
      `${source}: model ${index} proxy must be an http:// or https:// URL — got ${url}`,
    );
  }
  return url;
}

/**
 * The timezone the peak hours are counted in.
 *
 * The zone is checked here, at the reading of the file: a zone that cannot be
 * read throws in the middle of a run, where it says nothing about the file
 * that is wrong.
 */
function timezoneOf(value: unknown, index: number, source: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const zone = stringOf(value, `model ${index} timezone`, source);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    throw new Error(`${source}: model ${index} timezone is not a timezone — got ${zone}`);
  }
  return zone;
}

/** The peak hours of one model: a list, however the file wrote them. */
function peakOf(value: unknown, index: number, source: string): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (typeof value === "string") {
    return [value];
  }
  if (!Array.isArray(value) || value.some((window) => typeof window !== "string")) {
    throw new Error(`${source}: model ${index} peak must be a list of HH:MM-HH:MM windows`);
  }
  return value as readonly string[];
}

/**
 * The provider and the model behind a reference.
 *
 * The two are separated by the **first** slash: a model id may itself contain
 * one — `commandcode/reflection/beam:free` is a provider called `commandcode`
 * and a model called `reflection/beam:free`.
 */
export function splitReference(
  reference: string,
  label = "a model",
): { readonly provider: string; readonly id: string } {
  const separator = reference.indexOf("/");
  if (separator <= 0 || separator === reference.length - 1) {
    throw new Error(`${label} must name a model, as provider/id — got ${reference}`);
  }
  return { provider: reference.slice(0, separator), id: reference.slice(separator + 1) };
}

/** The minutes since midnight a window opens and closes at. */
function parseWindow(
  window: string,
  source = "the pool",
): { readonly from: number; readonly to: number } {
  const match = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(window.trim());
  if (match === null) {
    throw new Error(`${source}: a peak window must be HH:MM-HH:MM — got ${window}`);
  }
  const hours = [match[1] ?? "", match[3] ?? ""].map((part) => Number(part));
  const minutes = [match[2] ?? "", match[4] ?? ""].map((part) => Number(part));
  if (
    hours.some((hour) => !Number.isInteger(hour) || hour > 23) ||
    minutes.some((minute) => !Number.isInteger(minute) || minute > 59)
  ) {
    throw new Error(`${source}: a peak window must be HH:MM-HH:MM — got ${window}`);
  }
  return {
    from: (hours[0] ?? 0) * 60 + (minutes[0] ?? 0),
    to: (hours[1] ?? 0) * 60 + (minutes[1] ?? 0),
  };
}

/**
 * Whether a window holds the moment.
 *
 * A window that crosses midnight holds both of its ends: `22:00-02:00` is the
 * night, not nothing.
 */
export function windowHolds(window: string, minutes: number): boolean {
  const { from, to } = parseWindow(window);
  return from <= to
    ? minutes >= from && minutes < to
    : minutes >= from || minutes < to;
}

/** The minutes since midnight in the zone, at the moment. */
export function minutesOfDay(now: Date, timezone?: string): number {
  if (timezone === undefined) {
    return now.getHours() * 60 + now.getMinutes();
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  // Some locales report the hour as 24 at midnight.
  return (hour % 24) * 60 + minute;
}

/** Whether the model is at its peak tariff at the moment. */
export function isPeak(model: PoolModel, now: Date): boolean {
  const minutes = minutesOfDay(now, model.timezone);
  return model.peak.some((window) => windowHolds(window, minutes));
}

/**
 * The words a provider uses when a model's limit is gone.
 *
 * The SDK resolves a turn whose model call failed, so the failure arrives as
 * the assistant message's error — and the error is the only place the limit is
 * named. A model that is out of its limit says so in one of these ways.
 *
 * The words of a lost credential are here too: a provider that no longer takes
 * the key cannot answer either, and the model is as good as gone.
 */
const LIMIT_PATTERNS: readonly RegExp[] = [
  /\b429\b/,
  /\b401\b/,
  /\b402\b/,
  /rate[\s_-]?limit/i,
  /too many requests/i,
  /quota/i,
  /insufficient\s+(credit|balance|quota|funds)/i,
  /credit balance is too low/i,
  /balance is too low/i,
  /limit\s+(reached|exceeded)/i,
  /exceeded\s+(your|the)\s+\w*\s*limit/i,
  /authentication failed/i,
  /credentials may have expired/i,
  /invalid api key/i,
  /no api key found/i,
];

/** Whether the text says that a model's limit is gone. */
export function isLimitFailure(text: string): boolean {
  return LIMIT_PATTERNS.some((pattern) => pattern.test(text));
}

/** What the pool knows about the moment it is asked in. */
export interface PoolChoice {
  /** The models whose limit is gone. */
  readonly exhausted?: ReadonlySet<string>;
  /** Whether the host has a proxy of its own — a model that needs one cannot be used without it. */
  readonly proxyConfigured?: boolean;
  /** The moment the peak hours are counted in. */
  readonly now?: Date;
  /** Whether the model can be reached at all. */
  readonly usable?: (model: PoolModel) => boolean;
}

/**
 * The models in the order they are tried: the bigger priority first, and the
 * file's own order between equals.
 */
export function orderedModels(pool: Pool): readonly PoolModel[] {
  return [...pool.models].sort((left, right) => right.priority - left.priority);
}

/**
 * The model the pool would use now, or undefined when none of them can.
 *
 * A model that is at its peak tariff, whose limit is gone, that needs the
 * host's proxy and has not got one, or that cannot be reached is not one that
 * can be used.
 */
export function pickPoolModel(pool: Pool, choice: PoolChoice = {}): PoolModel | undefined {
  const now = choice.now ?? new Date();
  const exhausted = choice.exhausted ?? new Set<string>();
  const proxyConfigured = choice.proxyConfigured ?? true;
  for (const model of orderedModels(pool)) {
    if (exhausted.has(model.reference)) {
      continue;
    }
    if (isPeak(model, now)) {
      continue;
    }
    if (model.proxy === true && !proxyConfigured) {
      continue;
    }
    if (choice.usable !== undefined && !choice.usable(model)) {
      continue;
    }
    return model;
  }
  return undefined;
}

/**
 * What the pool file means right now.
 *
 * Every model, and why it is or is not the one that would be used. The file is
 * the host's policy, and a host that cannot see what its own file says cannot
 * change it.
 */
export function describePool(pool: Pool, choice: PoolChoice = {}): readonly string[] {
  const now = choice.now ?? new Date();
  const exhausted = choice.exhausted ?? new Set<string>();
  const proxyConfigured = choice.proxyConfigured ?? true;
  const chosen = pickPoolModel(pool, choice);
  const lines: string[] = [];
  for (const model of orderedModels(pool)) {
    const reasons: string[] = [];
    if (exhausted.has(model.reference)) {
      reasons.push("its limit is gone");
    }
    if (isPeak(model, now)) {
      reasons.push("it is at its peak tariff");
    }
    if (model.proxy === true && !proxyConfigured) {
      reasons.push("it needs a proxy this host has not got");
    }
    if (typeof model.proxy === "string") {
      reasons.push(`its requests go through ${model.proxy}`);
    }
    if (choice.usable !== undefined && !choice.usable(model)) {
      reasons.push("it cannot be reached");
    }
    const why =
      chosen?.reference === model.reference
        ? "it would be used"
        : reasons.length === 0
          ? "it would not be used"
          : reasons.join(", ");
    const effort = model.effort === undefined ? "" : ` — effort ${model.effort}`;
    lines.push(`${model.reference} — priority ${model.priority}${effort} — ${why}`);
  }
  if (chosen === undefined) {
    lines.push("no model can be used right now");
  }
  return lines;
}

/**
 * Whether the model is in the catalogue and its provider has a credential.
 *
 * One rule, one place: the pool uses it when it picks a model, and the runner
 * uses it when it starts a session. Two copies of a rule drift apart.
 */
export function knownModel(
  runtime: ModelRuntime,
  reference: string,
  label = "the pool's model",
): boolean {
  const { provider, id } = splitReference(reference, label);
  return (
    runtime.getModel(provider, id) !== undefined && runtime.hasConfiguredAuth(provider)
  );
}

/** A mapping, and not something else. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A number the file wrote. */
function numberOf(value: unknown, what: string, source: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${source}: ${what} must be a number`);
  }
  return value;
}

/** A string the file wrote. */
function stringOf(value: unknown, what: string, source: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${source}: ${what} must be a non-empty string`);
  }
  return value;
}

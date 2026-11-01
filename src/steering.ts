/**
 * The bridge between the queue of corrections and the session the run works in.
 *
 * The queue is `pi-queue-steer-factory`'s, and it is delivered on the session's
 * own boundaries: the one moment a correction is not a race with the turn. The
 * queue never sends on its own — no timer, no enqueue — so a row leaves at a
 * boundary the session reports, or not at all.
 */

import {
  type QueueBoundary,
  type QueueController,
  type QueueLifecycle,
  type QueueRow,
} from "pi-queue-steer-factory/headless";

import type { AgentSession, SessionEvent, SessionFactory } from "./session.js";

/**
 * The part of Pi's session the steer path drives beyond the prompt array.
 *
 * It is the SDK's own session: `piSessionFactory` returns the real thing, and
 * `AgentSession` is the narrow face of it the prompt array needs.
 */
export interface SteerableSession extends AgentSession {
  /** Send a turn, with the images the human attached. */
  prompt(text: string, options?: { readonly images?: QueueRow["images"] }): Promise<void>;
  /** Queue a message for after the assistant turn that is running. */
  steer(text: string, images?: QueueRow["images"]): Promise<unknown>;
  /** Queue a message for when the agent would otherwise stop. */
  followUp(text: string, images?: QueueRow["images"]): Promise<unknown>;
  /** Observe the session's lifecycle, which is where a delivery boundary is. */
  subscribe(listener: (event: SessionEvent) => void): () => void;
  /** Where the session writes its own transcript, when it writes one. */
  readonly sessionManager?: { getSessionFile(): string | null };
}

/**
 * The factory the run uses, with the session it creates handed to `attach`.
 *
 * The runner creates the session and owns it. A human watching needs a handle on
 * the same object to deliver a correction into it, and wrapping the factory is
 * the one place both are true at once.
 */
export function steeringFactory(
  inner: SessionFactory,
  attach: (session: SteerableSession) => void,
): SessionFactory {
  return async (options) => {
    const session = (await inner(options)) as SteerableSession;
    attach(session);
    return session;
  };
}

/**
 * What one session event means to the queue: its lifecycle, and the boundary it
 * opens.
 */
export function boundaryOf(event: {
  readonly type: string;
}): { readonly observe: QueueLifecycle; readonly boundary: QueueBoundary | null } | null {
  switch (event.type) {
    case "agent_start":
      return { observe: { type: "agent-start" }, boundary: null };
    case "turn_end":
      return { observe: { type: "tail", phase: "turn" }, boundary: "turn-end" };
    case "agent_end":
      return { observe: { type: "tail", phase: "agent" }, boundary: "agent-end" };
    case "agent_settled":
      return { observe: { type: "settled" }, boundary: "settled" };
    default:
      return null;
  }
}

/**
 * Deliver one queued row into the session it belongs to.
 *
 * A row that arrives when the agent is idle starts a turn; a steer lands between
 * the turn's tool calls and the next model call; anything else waits for the
 * agent to stop.
 */
export async function deliverRow(
  session: SteerableSession,
  row: Pick<QueueRow, "lane" | "text" | "images">,
  boundary: QueueBoundary,
): Promise<{ readonly outcome: "completed" }> {
  const images = row.images.length === 0 ? undefined : row.images;
  if (boundary === "settled") {
    await session.prompt(row.text, images === undefined ? {} : { images });
  } else if (row.lane === "steer") {
    await session.steer(row.text, images);
  } else {
    await session.followUp(row.text, images);
  }
  return { outcome: "completed" };
}

/**
 * Drive the queue and the log from the session's own lifecycle.
 *
 * The dispatch's outcome is reported through the queue's own snapshot; a
 * rejection here would be an unhandled one inside an event listener, and it
 * would stop the observations that come after it.
 */
export function follow(
  session: SteerableSession,
  controller: QueueController,
  mirror: (event: SessionEvent) => void,
): void {
  session.subscribe((event) => {
    mirror(event);
    const at = boundaryOf(event);
    if (at === null) {
      return;
    }
    controller.observe(at.observe);
    if (at.boundary !== null) {
      void controller.dispatch(at.boundary).catch(() => {});
    }
  });
}

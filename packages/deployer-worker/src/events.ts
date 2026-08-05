// In-process pub/sub seam between the deploy state machine (lifecycle.ts,
// the producer) and the worker WebSocket server (ws.ts, the consumer).
// Kept deliberately tiny and dependency-free so both sides can import it
// without pulling in Prisma or the docker socket.
//
// DB is the source of truth (spec §2): lifecycle writes Agent.status FIRST,
// THEN emits the matching step frame here. A reconnecting socket backfills
// the current step from the row, so a dropped frame never loses progress.

export type StepName =
  | "queued"
  | "allocating_ports"
  | "starting"
  | "health_checking"
  | "registering_route"
  | "running"
  | "unhealthy"
  | "failed"
  | "stopped"
  | "crashed"
  // Update flow steps
  | "pulling_image"
  | "creating_backup"
  | "stopping_container"
  | "starting_updated"
  | "updating_complete";

export type StepState = "started" | "ok" | "failed";

export interface StepFrame {
  type: "step";
  step: StepName;
  state: StepState;
  at: string; // ISO timestamp
}

export interface LogFrame {
  type: "log";
  lineNo: number;
  text: string;
  stream: "stdout" | "stderr" | "system";
  ts: string;
}

export interface ReadyFrame {
  type: "ready";
  url: string;
}

export interface DoneFrame {
  type: "done";
  status: string;
}

export interface ErrorFrame {
  type: "error";
  code: string;
  message: string;
}

export type Frame = StepFrame | LogFrame | ReadyFrame | DoneFrame | ErrorFrame;

export type Subscriber = (frame: Frame) => void;

const subscribers = new Map<string, Set<Subscriber>>();

// Per-agent ring of the step/ready frames already emitted, so a socket that
// connects mid-deploy can be primed with prior steps without re-querying the
// DB (spec §2 reconnect requirement). Worker-process-local, single-writer;
// cleared on terminal. Only step/ready frames are retained — log frames are
// backfilled from the AgentLog table, not from here.
const stepHistory = new Map<string, Array<StepFrame | ReadyFrame>>();

export function subscribe(agentId: string, fn: Subscriber): () => void {
  let set = subscribers.get(agentId);
  if (!set) {
    set = new Set();
    subscribers.set(agentId, set);
  }
  set.add(fn);
  return () => {
    const current = subscribers.get(agentId);
    if (!current) return;
    current.delete(fn);
    // Prune the empty set so the map doesn't accumulate one entry per
    // agent that ever connected over the worker's lifetime.
    if (current.size === 0) subscribers.delete(agentId);
  };
}

function fanout(agentId: string, frame: Frame): void {
  const set = subscribers.get(agentId);
  if (!set) return;
  // Snapshot so a subscriber that unsubscribes during delivery doesn't
  // mutate the set mid-iteration. Each callback is isolated: a throwing
  // WS handler must not starve the others or break the lifecycle caller.
  for (const fn of [...set]) {
    try {
      fn(frame);
    } catch (e) {
      console.error(`[events] subscriber for ${agentId} threw:`, e);
    }
  }
}

function record(agentId: string, frame: StepFrame | ReadyFrame): void {
  let hist = stepHistory.get(agentId);
  if (!hist) {
    hist = [];
    stepHistory.set(agentId, hist);
  }
  hist.push(frame);
}

export function emitStep(agentId: string, step: StepName, state: StepState): void {
  const frame: StepFrame = { type: "step", step, state, at: new Date().toISOString() };
  record(agentId, frame);
  fanout(agentId, frame);
}

export function emitLog(agentId: string, line: Omit<LogFrame, "type">): void {
  fanout(agentId, { type: "log", ...line });
}

export function emitReady(agentId: string, url: string): void {
  const frame: ReadyFrame = { type: "ready", url };
  record(agentId, frame);
  fanout(agentId, frame);
}

// Prime a late subscriber: returns step/ready frames already emitted for this
// agent's in-flight deploy, oldest first. The WS server replays these on
// connect so a refresh mid-deploy shows the full checklist, not just the
// current row status.
export function snapshotSteps(agentId: string): Array<StepFrame | ReadyFrame> {
  return [...(stepHistory.get(agentId) ?? [])];
}

// Drop the retained frames once a deploy reaches a terminal state, so the map
// doesn't grow one entry per agent over the worker's lifetime.
export function clearSteps(agentId: string): void {
  stepHistory.delete(agentId);
}

export function emitDone(agentId: string, status: string): void {
  fanout(agentId, { type: "done", status });
  // Terminal: stop retaining this deploy's step history.
  clearSteps(agentId);
}

export function emitError(agentId: string, code: string, message: string): void {
  fanout(agentId, { type: "error", code, message });
}

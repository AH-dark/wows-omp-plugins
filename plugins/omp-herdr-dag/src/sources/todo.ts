import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { getLatestTodoPhasesFromEntries, isTodoPhase } from "@oh-my-pi/pi-coding-agent/tools/todo";

import { type Run, type TodoDependency, type TodoPhase, todoRun, validateTodoEdges } from "#src/model.ts";

import { PLAN_EXECUTION_ENTRY, type PlanExecutionTracker } from "./plan-execution.ts";

export const TODO_EDGES_ENTRY = "omp-herdr-dag:todo-edges";
const ATLAS_MIRROR_PHASES: Record<string, true> = {
  "Atlas tasks": true,
  "Atlas discovered": true,
  "Atlas fixes": true,
  "Atlas final gates": true,
  "Atlas delivery": true,
};

export interface TodoEdgesEntry {
  v: 1;
  generation: number;
  edges: TodoDependency[];
}

export interface TodoResult {
  toolName: string;
  isError?: boolean;
  details?: unknown;
}

export interface TodoSourceOptions {
  sessionId: string;
  plan?: PlanExecutionTracker;
  now?: () => number;
  onChange?: (runs: Run[]) => void;
}

export interface TodoBranchReader {
  getLeafId(): string | null;
  getBranch(): SessionEntry[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Follow the host's canonical writers, including edits made without a tool call. */
function snapshotEntry(raw: unknown): { phases: TodoPhase[]; op?: string; at?: number } | undefined {
  const entry = record(raw);
  let phases: unknown;
  let op: unknown;
  if (entry?.type === "custom" && entry.customType === "user_todo_edit") {
    phases = record(entry.data)?.phases;
  } else if (entry?.type === "message") {
    const message = record(entry.message);
    if (message?.role !== "toolResult" || message.toolName !== "todo" || message.isError) return undefined;
    const details = record(message.details);
    phases = details?.phases;
    op = details?.op;
    if (op === "view") return undefined;
  } else return undefined;
  if (!Array.isArray(phases) || !phases.every(isTodoPhase)) return undefined;
  const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : undefined;
  return { phases, op: typeof op === "string" ? op : undefined, at: at !== undefined && Number.isFinite(at) ? at : undefined };
}

/** Native init results are the durable generation boundary; an external first list starts generation one. */
export function todoGeneration(entries: readonly unknown[]): number {
  let generation = 0;
  let pendingGeneration = 0;
  for (const entry of entries) {
    const custom = record(entry);
    if (custom?.type === "custom" && custom.customType === TODO_EDGES_ENTRY) {
      const data = record(custom.data);
      if (data?.v === 1 && Number.isInteger(data.generation) && Number(data.generation) > generation) {
        pendingGeneration = Number(data.generation);
      }
    }
    const snapshot = snapshotEntry(entry);
    if (!snapshot) continue;
    if (snapshot.op === "init") generation = Math.max(generation + 1, pendingGeneration);
    else generation = Math.max(generation, pendingGeneration, snapshot.phases.some((phase) => phase.tasks.length > 0) ? 1 : 0);
    pendingGeneration = 0;
  }
  return generation;
}

export class TodoSource {
  readonly #options: TodoSourceOptions;
  readonly #now: () => number;
  readonly #edges = new Map<number, TodoDependency[]>();
  #phases: TodoPhase[] = [];
  #generation = 0;
  #current?: Run;
  #previous?: Run;
  #atlasBound = false;
  #leafId: string | null | undefined;

  constructor(options: TodoSourceOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  get generation(): number {
    return this.#generation;
  }

  get phases(): readonly TodoPhase[] {
    return this.#phases;
  }

  get current(): Run | undefined {
    return this.#current;
  }

  get runs(): Run[] {
    return [this.#previous, this.#current].filter((run): run is Run => run !== undefined);
  }

  /** The current list's run id, also while Atlas hides every phase of it as a mirror. */
  get runId(): string | undefined {
    return this.#generation && this.#phases.some((phase) => phase.tasks.length > 0)
      ? `todo:${this.#options.sessionId}:${this.#generation}`
      : undefined;
  }

  observeResult(event: TodoResult): boolean {
    const details = record(event.details);
    if (event.toolName !== "todo" || event.isError || details?.op === "view") return false;
    const phases = details?.phases;
    if (!Array.isArray(phases) || !phases.every(isTodoPhase)) return false;
    this.#accept(phases, details?.op === "init", this.#now(), true);
    this.#options.onChange?.(this.runs);
    return true;
  }

  setEdges(data: TodoEdgesEntry): void {
    if (data.v !== 1 || !Number.isInteger(data.generation) || data.generation < 1) return;
    this.#edges.set(data.generation, data.edges);
    if (data.generation !== this.#generation) return;
    this.#render(this.#now());
    this.#options.onChange?.(this.runs);
  }

  setAtlasBound(bound: boolean): void {
    if (bound === this.#atlasBound) return;
    this.#atlasBound = bound;
    this.#render(this.#now());
    this.#options.onChange?.(this.runs);
  }

  replay(entries: readonly SessionEntry[], leafId?: string | null, preserveProposal = false): void {
    this.#replay(entries, leafId, preserveProposal);
  }

  #replay(entries: readonly SessionEntry[], leafId?: string | null, preserveProposal = false, liveAfter = entries.length): void {
    const oldRuns = new Map(this.runs.map((run) => [run.id, run]));
    this.#options.plan?.replay(entries, preserveProposal);
    // Restoring the latest state must not retroactively approve earlier list writes.
    const approvalIndex = entries.findLastIndex((raw) => {
      const entry = record(raw);
      const data = record(entry?.data);
      return (
        entry?.type === "custom" && entry.customType === PLAN_EXECUTION_ENTRY && data?.v === 1 && data.state === "executing" && !data.runId
      );
    });
    this.#phases = [];
    this.#generation = 0;
    let latestAt = this.#now();
    this.#current = undefined;
    this.#previous = undefined;
    this.#edges.clear();
    let pendingGeneration = 0;
    for (const [index, raw] of entries.entries()) {
      const entry = record(raw);
      if (entry?.type === "custom" && entry.customType === TODO_EDGES_ENTRY) {
        const data = record(entry.data);
        if (data?.v === 1 && Number.isInteger(data.generation) && Number(data.generation) > 0 && Array.isArray(data.edges)) {
          this.#edges.set(Number(data.generation), data.edges as TodoDependency[]);
          pendingGeneration = Number(data.generation);
        }
      }
      const snapshot = snapshotEntry(raw);
      if (!snapshot) continue;
      latestAt = snapshot.at ?? this.#now();
      this.#accept(
        snapshot.phases,
        snapshot.op === "init",
        latestAt,
        index > Math.max(liveAfter, approvalIndex),
        oldRuns,
        pendingGeneration,
      );
      pendingGeneration = 0;
    }
    // The exported host helper is authoritative for the latest branch snapshot.
    this.#phases = getLatestTodoPhasesFromEntries([...entries]);
    this.#render(latestAt);
    this.#leafId = leafId;
    this.#options.onChange?.(this.runs);
  }

  /** Heartbeat polling does not read the branch when its leaf is unchanged. */
  poll(manager: TodoBranchReader): boolean {
    const leafId = manager.getLeafId();
    if (leafId === this.#leafId) return false;
    const entries = manager.getBranch();
    // Only writes after an established baseline are live. A missing baseline means
    // initial replay or a branch change, neither of which can claim an approval.
    const baseline = this.#leafId === null ? -1 : entries.findIndex((entry) => entry.id === this.#leafId);
    const liveAfter = this.#leafId !== undefined && (this.#leafId === null || baseline >= 0) ? baseline : entries.length;
    this.#replay(entries, leafId, true, liveAfter);
    return true;
  }

  #accept(phases: TodoPhase[], init: boolean, at: number, live: boolean, oldRuns?: Map<string, Run>, persistedGeneration = 0): void {
    const nonempty = phases.some((phase) => phase.tasks.length > 0);
    const nextGeneration = Math.max(this.#generation + (init || (!this.#generation && nonempty) ? 1 : 0), persistedGeneration);
    const fresh = nextGeneration !== this.#generation;
    if (fresh) {
      this.#previous = this.#current ? { ...this.#current, finishedAt: this.#current.finishedAt ?? at } : undefined;
      this.#generation = nextGeneration;
      this.#current = oldRuns?.get(`todo:${this.#options.sessionId}:${this.#generation}`);
    }
    this.#phases = phases;
    if (fresh && live) {
      const visible = this.#atlasBound ? phases.filter((phase) => !Object.hasOwn(ATLAS_MIRROR_PHASES, phase.name)) : phases;
      this.#options.plan?.claimRun(`todo:${this.#options.sessionId}:${this.#generation}`, visible);
    }
    this.#render(at);
  }

  #render(at: number): void {
    const phases = this.#atlasBound ? this.#phases.filter((phase) => !Object.hasOwn(ATLAS_MIRROR_PHASES, phase.name)) : this.#phases;
    if (!this.#generation || !phases.some((phase) => phase.tasks.length > 0)) {
      this.#current = undefined;
      return;
    }
    const edges = validateTodoEdges(phases, this.#edges.get(this.#generation)).edges;
    this.#current = todoRun({
      sessionId: this.#options.sessionId,
      generation: this.#generation,
      phases,
      previous: this.#current,
      source: this.#options.plan?.sourceForRun(`todo:${this.#options.sessionId}:${this.#generation}`),
      edges,
      now: at,
    });
  }
}

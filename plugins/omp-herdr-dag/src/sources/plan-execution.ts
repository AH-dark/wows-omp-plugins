import type { Run, TodoPhase } from "#src/model.ts";

export const PLAN_EXECUTION_ENTRY = "omp-herdr-dag:plan-execution";

export interface PlanExecutionState {
  v: 1;
  state: "proposed" | "executing" | "idle";
  planFilePath?: string;
  runId?: string;
  at: number;
}

export interface PlanExecutionOptions {
  now?: () => number;
  persist?: (data: PlanExecutionState) => void;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function canonicalPlanPath(path: string): string {
  return path.replace(/^local:\/(?!\/)/, "local://");
}

/** Same trusted-envelope predicate as the producer, without cross-plugin imports. */
export function isApprovedPlanHandoff(
  prompt: string,
  proposedPlanFilePath: string | undefined,
  planReferencePath: string | undefined,
): boolean {
  if (!proposedPlanFilePath || !planReferencePath) return false;
  const proposed = canonicalPlanPath(proposedPlanFilePath);
  if (canonicalPlanPath(planReferencePath) !== proposed) return false;
  const text = prompt.trimStart();
  if (!text.startsWith("Plan approved.\n")) return false;
  if (!text.includes(`<plan path="${proposed}">`) || !text.includes("</plan>")) return false;
  return text.includes(`Full plan inlined below; durable copy at \`${proposed}\``);
}

export class PlanExecutionTracker {
  readonly #now: () => number;
  readonly #persist?: (data: PlanExecutionState) => void;
  readonly #planRuns = new Set<string>();
  readonly #consumedHandoffs = new Set<string>();
  #state: PlanExecutionState;

  constructor(options: PlanExecutionOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#persist = options.persist;
    this.#state = { v: 1, state: "idle", at: this.#now() };
  }

  get state(): Readonly<PlanExecutionState> {
    return this.#state;
  }

  observeResult(event: { toolName: string; isError?: boolean; details?: unknown }): boolean {
    if (event.toolName !== "write" || event.isError) return false;
    const xdev = record(record(event.details)?.xdev);
    const inner = record(xdev?.inner);
    const path = typeof inner?.planFilePath === "string" ? inner.planFilePath.trim() : "";
    if (xdev?.tool !== "propose" || xdev.mode !== "execute" || inner?.planExists !== true || !path) return false;
    this.#set({ v: 1, state: "proposed", planFilePath: canonicalPlanPath(path), at: this.#now() });
    return true;
  }

  beforeAgentStart(prompt: string, planReferencePath: string | undefined, handoffAt?: number): boolean {
    if (!isApprovedPlanHandoff(prompt, this.#state.planFilePath, planReferencePath)) return false;
    const identity = handoffAt === undefined ? undefined : `${handoffAt}\n${prompt}`;
    if (identity && this.#state.state === "executing") this.#consumedHandoffs.add(identity);
    if (this.#state.state !== "proposed" || (identity && this.#consumedHandoffs.has(identity))) return false;
    if (handoffAt !== undefined && (!Number.isFinite(handoffAt) || handoffAt < this.#state.at)) return false;
    if (identity) this.#consumedHandoffs.add(identity);
    this.#set({ ...this.#state, state: "executing", runId: undefined, at: this.#now() });
    return true;
  }

  /** Only a newly created, non-empty list can claim an armed approval. */
  claimRun(runId: string, phases: readonly TodoPhase[]): "todo" | "plan" {
    if (this.#planRuns.has(runId)) return "plan";
    if (this.#state.state !== "executing" || this.#state.runId || !phases.some((phase) => phase.tasks.length > 0)) return "todo";
    this.#planRuns.add(runId);
    this.#set({ ...this.#state, runId, at: this.#now() });
    return "plan";
  }

  sourceForRun(runId: string): "todo" | "plan" {
    return this.#planRuns.has(runId) ? "plan" : "todo";
  }

  /** Atlas executes an approval through its own run; the todo list then only mirrors the Atlas ledger. */
  claimAtlas(runId: string): void {
    if (this.#state.state !== "executing" || this.#state.runId) return;
    this.#planRuns.add(runId);
    this.#set({ ...this.#state, runId, at: this.#now() });
  }

  /** Releasing Atlas ends the plan execution its run claimed. */
  atlasReleased(): void {
    if (this.#state.state === "executing" && this.#state.runId?.startsWith("atlas:")) this.#set({ v: 1, state: "idle", at: this.#now() });
  }

  agentEnd(run: Run | undefined, willContinue = false): boolean {
    if (willContinue || this.#state.state !== "executing" || !this.#state.runId || run?.id !== this.#state.runId) return false;
    if (!run.nodes.length || !run.nodes.every((node) => node.state === "done" || node.state === "abandoned")) return false;
    this.#set({ v: 1, state: "idle", at: this.#now() });
    return true;
  }

  /** Replay is read-only: switching or rewinding never appends a new approval. */
  replay(entries: readonly unknown[], preserveProposal = false): void {
    const proposal = preserveProposal && this.#state.state === "proposed" ? this.#state : undefined;
    this.#planRuns.clear();
    this.#state = proposal ?? { v: 1, state: "idle", at: this.#now() };
    for (const raw of entries) {
      const entry = record(raw);
      if (entry?.type !== "custom" || entry.customType !== PLAN_EXECUTION_ENTRY) continue;
      const data = record(entry.data);
      if (
        data?.v !== 1 ||
        !["idle", "proposed", "executing"].includes(String(data.state)) ||
        typeof data.at !== "number" ||
        !Number.isFinite(data.at) ||
        (data.planFilePath !== undefined && typeof data.planFilePath !== "string") ||
        (data.runId !== undefined && typeof data.runId !== "string") ||
        (data.state !== "idle" && !data.planFilePath)
      )
        continue;
      this.#state = { ...(data as unknown as PlanExecutionState) };
      if (this.#state.state === "executing" && this.#state.runId) this.#planRuns.add(this.#state.runId);
    }
  }

  #set(state: PlanExecutionState): void {
    this.#state = state;
    this.#persist?.({ ...state });
  }
}

import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

const STAGE_ID = /^S\d+$/;
const ROUND_ID = /^R\d+$/;
const CRITERION_ID = /^DC[1-9]\d*$/;
const REVISION = /^[a-f0-9]{64}$/;
const STAGE_STATUSES: Record<string, true> = { planned: true, active: true, closed: true, dropped: true };

/** The roadmap stage a plan was proposed for, as stored in the proposal marker and the Atlas approval. */
export interface RoadmapStage {
  repoRoot: string;
  id: string;
  /** DC ids the plan's `Roadmap criteria:` line declared; absent when the binding listed no criteria. */
  criteria?: string[];
  /** Roadmap's opaque planning-basis revision of the stage at proposal; absent from older roadmap releases. */
  revision?: string;
}

export interface RoadmapBinding {
  v: 1;
  sessionId: string;
  requestId: string;
  repoRoot: string;
  toolSourcePath: string;
  /** `criteria` (current DC ids in document order) and `revision` are absent from older roadmap releases. */
  stage?: { id: string; title: string; round: string; criteria?: string[]; revision?: string };
  /**
   * Whether roadmap tools, `roadmap_todo` included, can work in this repository now: a Git work tree with an initialized
   * roadmap and the adr plugin connected. Absent from older roadmap releases, which leave it unknown.
   */
  usable?: boolean;
}

/** `roadmap:stage` answer; `stage` is absent when the repository has no roadmap, the stage is unknown, or it is unreadable. */
export interface RoadmapStageAnswer {
  v: 1;
  sessionId: string;
  requestId: string;
  repoRoot: string;
  stage?: {
    id: string;
    title: string;
    round: string;
    status: "planned" | "active" | "closed" | "dropped";
    criteria: string[];
    revision: string;
    /**
     * What execution still owes the stage before implementation: `start` a stage plan mode bound without starting it,
     * or `commit` the listed repository-relative files that started it. Absent when nothing is owed or from older releases.
     */
    activation?: { action: "start" } | { action: "commit"; files: string[] };
  };
}

export interface AtlasPlansRequest {
  v: 1;
  sessionId: string;
  requestId: string;
  repoRoot: string;
  stage?: string;
}

/** One approved Atlas plan bound to a roadmap stage, as `atlas:plans` reports it. */
export interface AtlasStagePlan {
  planId: string;
  name: string;
  repoRoot: string;
  stage: string;
  /** Declared coverage; absent when undeclared (older approvals, or a roadmap without criteria). */
  criteria?: string[];
  /** Planning-basis revision at approval. */
  revision?: string;
  status: "unfinished" | "complete";
  done: number;
  total: number;
  /** Verified gate results; empty until the plan is complete. */
  gates: Array<{ gateId: string; verdict: string; summary: string }>;
  delivery?: { mode: "pr" | "ship"; summary: string };
  deferred: Array<{ id: string; title: string; disposition?: "todo" | "duplicate" | "wontfix" | "report"; reference?: string }>;
  /** Absolute bundle path, for evidence lookup. */
  directory: string;
}

export interface AtlasCompleted {
  v: 1;
  sessionId: string;
  planId: string;
  roadmapStage: RoadmapStage;
  gates: Array<{ gateId: string; verdict: string; summary: string }>;
  /** Present when the plan delivers through a pull request; emitted only after its P1 row is done. */
  delivery?: { mode: "pr" | "ship"; summary: string };
  at: string;
}

interface ContractEvents {
  on(channel: string, listener: (payload: unknown) => void): () => void;
  emit(channel: string, payload: unknown): void;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Unique DC ids; a declared coverage list must also be non-empty. */
function criterionIds(value: unknown, nonEmpty: boolean): value is string[] {
  return (
    Array.isArray(value) &&
    (!nonEmpty || value.length > 0) &&
    value.every((id) => typeof id === "string" && CRITERION_ID.test(id)) &&
    new Set(value).size === value.length
  );
}

/** Absent, a start, or a commit of non-empty repository-relative paths that stay inside the repository. */
function validActivation(value: unknown): boolean {
  if (value === undefined) return true;
  if (!object(value)) return false;
  if (value.action === "start") return true;
  return (
    value.action === "commit" &&
    Array.isArray(value.files) &&
    value.files.length > 0 &&
    value.files.every(
      (file) => typeof file === "string" && file !== "" && file.trim() === file && !isAbsolute(file) && !file.split(/[\\/]/).includes(".."),
    )
  );
}

export function isRoadmapStage(value: unknown): value is RoadmapStage {
  return (
    object(value) &&
    typeof value.repoRoot === "string" &&
    isAbsolute(value.repoRoot) &&
    typeof value.id === "string" &&
    STAGE_ID.test(value.id) &&
    (value.criteria === undefined || criterionIds(value.criteria, true)) &&
    (value.revision === undefined || (typeof value.revision === "string" && REVISION.test(value.revision)))
  );
}

/**
 * Validate a plan's `Roadmap criteria:` lines against the bound stage's current criteria. Returns the declared ids, or
 * a refusal the planner can act on.
 */
export function checkRoadmapCriteria(
  lines: ReadonlyArray<{ line: number; value: string; planLevel: boolean }>,
  stage: { id: string; criteria: readonly string[] },
): { criteria: string[] } | { error: string } {
  const current = stage.criteria.length ? stage.criteria.join(", ") : "none";
  const example = `Roadmap criteria: ${stage.criteria.slice(0, 2).join(", ") || "DC1"}`;
  const fix = `The plan is bound to roadmap stage ${stage.id}, whose current done criteria are ${current}. Write exactly one plan-level line at column 0, outside \`## Tasks\`, \`## Final gates\` and code fences, such as \`${example}\`, listing the criteria this plan delivers; criteria it does not list remain for another plan.`;
  if (!stage.criteria.length) {
    return { error: `roadmap stage ${stage.id} lists no current done criteria, so no plan can declare coverage. Amend the stage first.` };
  }
  const misplaced = lines.filter((entry) => !entry.planLevel);
  if (misplaced.length) {
    return {
      error: `the Roadmap criteria line at line ${misplaced.map((entry) => entry.line).join(", ")} is inside a plan section. ${fix}`,
    };
  }
  if (!lines.length) return { error: `the Roadmap criteria line is missing. ${fix}` };
  if (lines.length > 1)
    return { error: `the plan has ${lines.length} Roadmap criteria lines (lines ${lines.map((entry) => entry.line).join(", ")}). ${fix}` };
  const value = lines[0]?.value.trim() ?? "";
  if (!value) return { error: `the Roadmap criteria line lists no criteria. ${fix}` };
  const ids = value.split(",").map((id) => id.trim());
  const malformed = ids.filter((id) => !CRITERION_ID.test(id));
  if (malformed.length) {
    return { error: `the Roadmap criteria line names ${malformed.map((id) => `"${id}"`).join(", ")}, which are not DC ids. ${fix}` };
  }
  const duplicated = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  if (duplicated.length) return { error: `the Roadmap criteria line lists ${duplicated.join(", ")} more than once. ${fix}` };
  const unknown = ids.filter((id) => !stage.criteria.includes(id));
  if (unknown.length) {
    return {
      error: `the Roadmap criteria line names ${unknown.join(", ")}, which ${unknown.length === 1 ? "is not a current done criterion" : "are not current done criteria"} of ${stage.id}. ${fix}`,
    };
  }
  return { criteria: ids };
}

/** Optional synchronous handshake; a late answer cannot grant tool provenance, and a missed one is retried on the next request. */
export class RoadmapContract {
  readonly #bindings = new Map<string, RoadmapBinding>();
  readonly #completed = new Set<string>();

  constructor(readonly events: ContractEvents) {}

  requestBinding(sessionId: string): RoadmapBinding | undefined {
    const requestId = randomUUID();
    let binding: RoadmapBinding | undefined;
    const unsubscribe = this.events.on("roadmap:binding", (payload) => {
      if (
        !object(payload) ||
        payload.v !== 1 ||
        payload.sessionId !== sessionId ||
        payload.requestId !== requestId ||
        typeof payload.repoRoot !== "string" ||
        !isAbsolute(payload.repoRoot) ||
        typeof payload.toolSourcePath !== "string" ||
        !isAbsolute(payload.toolSourcePath) ||
        (payload.usable !== undefined && typeof payload.usable !== "boolean")
      )
        return;
      if (
        payload.stage !== undefined &&
        (!object(payload.stage) ||
          typeof payload.stage.id !== "string" ||
          !STAGE_ID.test(payload.stage.id) ||
          typeof payload.stage.title !== "string" ||
          !payload.stage.title.trim() ||
          typeof payload.stage.round !== "string" ||
          !ROUND_ID.test(payload.stage.round) ||
          (payload.stage.criteria !== undefined && !criterionIds(payload.stage.criteria, false)) ||
          (payload.stage.revision !== undefined && (typeof payload.stage.revision !== "string" || !REVISION.test(payload.stage.revision))))
      )
        return;
      binding = payload as unknown as RoadmapBinding;
    });
    try {
      this.events.emit("roadmap:binding-request", { v: 1, sessionId, requestId });
    } finally {
      unsubscribe();
    }
    if (binding) this.#bindings.set(sessionId, binding);
    else this.#bindings.delete(sessionId);
    return binding;
  }

  /** The tool source is stable for a session, so a confirmed answer is reused; the bound stage may be stale. */
  binding(sessionId: string): RoadmapBinding | undefined {
    return this.#bindings.get(sessionId) ?? this.requestBinding(sessionId);
  }

  /** The stage's current state from the roadmap plugin; undefined when no valid answer arrives (roadmap absent or older). */
  requestStage(sessionId: string, repoRoot: string, stage: string): RoadmapStageAnswer | undefined {
    const requestId = randomUUID();
    let answer: RoadmapStageAnswer | undefined;
    const unsubscribe = this.events.on("roadmap:stage", (payload) => {
      if (
        !object(payload) ||
        payload.v !== 1 ||
        payload.sessionId !== sessionId ||
        payload.requestId !== requestId ||
        payload.repoRoot !== repoRoot
      )
        return;
      const found = payload.stage;
      if (
        found !== undefined &&
        (!object(found) ||
          found.id !== stage ||
          typeof found.title !== "string" ||
          !found.title.trim() ||
          typeof found.round !== "string" ||
          !ROUND_ID.test(found.round) ||
          typeof found.status !== "string" ||
          STAGE_STATUSES[found.status] !== true ||
          !criterionIds(found.criteria, false) ||
          typeof found.revision !== "string" ||
          !REVISION.test(found.revision) ||
          !validActivation(found.activation))
      )
        return;
      answer = payload as unknown as RoadmapStageAnswer;
    });
    try {
      this.events.emit("roadmap:stage-request", { v: 1, sessionId, requestId, repoRoot, stage });
    } finally {
      unsubscribe();
    }
    return answer;
  }

  /**
   * Answer `atlas:plans-request` synchronously inside its emit. `plans` returns undefined for a session this process does
   * not own, which leaves the request unanswered. Never throws out of the listener.
   */
  answerPlans(plans: (request: AtlasPlansRequest) => AtlasStagePlan[] | undefined, warn: (error: unknown) => void): () => void {
    return this.events.on("atlas:plans-request", (payload) => {
      try {
        if (
          !object(payload) ||
          payload.v !== 1 ||
          typeof payload.sessionId !== "string" ||
          !payload.sessionId ||
          typeof payload.requestId !== "string" ||
          !payload.requestId ||
          typeof payload.repoRoot !== "string" ||
          !isAbsolute(payload.repoRoot) ||
          (payload.stage !== undefined && (typeof payload.stage !== "string" || !STAGE_ID.test(payload.stage)))
        )
          return;
        const { sessionId, requestId, repoRoot, stage } = payload;
        const answer = plans({ v: 1, sessionId, requestId, repoRoot, ...(stage === undefined ? {} : { stage }) });
        if (answer) this.events.emit("atlas:plans", { v: 1, sessionId, requestId, plans: answer });
      } catch (error) {
        warn(error);
      }
    });
  }

  emitCompleted(event: Omit<AtlasCompleted, "v" | "at">): void {
    if (this.#completed.has(event.planId)) return;
    this.#completed.add(event.planId);
    this.events.emit("atlas:completed", { ...event, v: 1, at: new Date().toISOString() } satisfies AtlasCompleted);
  }

  forget(sessionId: string): void {
    this.#bindings.delete(sessionId);
  }
}

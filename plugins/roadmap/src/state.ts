import { type Format, type Model, overdue, type RoundDoc, type StageDoc, type StageStatus, today } from "#src/documents.ts";
import { type Binding, bindable } from "#src/ses.ts";

export const ROADMAP_STATUS_KIND = "roadmap/status";

/**
 * Sidecar payload (`state` of the plugin-state envelope), version 1. Output-only; never read back.
 * Fields beyond the 0.2.3 set (format, dates, overdue, plannedRounds, stage readiness) are additive; existing keys keep their meaning.
 */
export interface RoadmapStatusPayload {
  kind: typeof ROADMAP_STATUS_KIND;
  version: 1;
  repoRoot: string;
  project: string;
  /** Repository format from the `docs/roadmap/README.md` marker. */
  format: Format;
  activeRound: { id: string; title: string; target: string | null; opened: string | null; overdue: boolean } | null;
  stages: Array<{
    id: string;
    title: string;
    status: StageStatus;
    round: string;
    target: string | null;
    started: string | null;
    closed: string | null;
    overdue: boolean;
    /** Derived readiness (additive): see `stageReadiness`. */
    dependsOn: string[];
    blockedBy: string[];
    startable: boolean;
  }>;
  /** Planned rounds by id: non-dropped stage count and open TODOs stored in or targeting the round. */
  plannedRounds: Array<{ id: string; title: string; target: string | null; overdue: boolean; stageCount: number; openTodos: number }>;
  openTodos: { total: number; byStage: Record<string, number>; untargeted: number };
  boundStage: string | null;
}

export function byId(a: { id: string }, b: { id: string }): number {
  return Number(a.id.replace(/\D/g, "")) - Number(b.id.replace(/\D/g, "")) || a.id.localeCompare(b.id);
}

/** Target versus actual dates, empty without a target so untargeted views render as before. */
export function schedule(item: { status: string; target: string | null }, actual: string | null, on: string): string {
  if (!item.target) return "";
  const parts = [`target ${item.target}`];
  if (actual) parts.push(actual);
  if (overdue(item, on)) parts.push("overdue");
  return parts.join(", ");
}

export function stageActual(stage: StageDoc): string | null {
  if (stage.status === "active") return stage.started ? `started ${stage.started}` : null;
  if (stage.status === "closed" || stage.status === "dropped") return stage.closed ? `${stage.status} ${stage.closed}` : null;
  return null;
}

export function roundActual(round: RoundDoc): string | null {
  if (round.status === "active") return round.opened ? `opened ${round.opened}` : null;
  if (round.status === "closed" || round.status === "dropped") return round.closed ? `${round.status} ${round.closed}` : null;
  return null;
}

export function plannedRoundCounts(model: Model, round: string): { stageCount: number; openTodos: number } {
  const ids = new Set(model.stages.filter((stage) => stage.round === round && stage.status !== "dropped").map((stage) => stage.id));
  let openTodos = 0;
  for (const doc of model.todos) {
    for (const item of doc.items) {
      if (item.status === "open" && (doc.round === round || (item.target !== undefined && ids.has(item.target)))) openTodos++;
    }
  }
  return { stageCount: ids.size, openTodos };
}

/**
 * Derived, never stored: a planned stage of the active round is startable once every dependency is closed, the same rule
 * stage start enforces. Other stages are neither startable nor blocked.
 */
export function stageReadiness(model: Model, stage: StageDoc): { blockedBy: string[]; startable: boolean } {
  if (stage.status !== "planned" || !model.rounds.some((round) => round.id === stage.round && round.status === "active"))
    return { blockedBy: [], startable: false };
  const blockedBy = stage.depends_on.filter((id) => !model.stages.some((other) => other.id === id && other.status === "closed"));
  return { blockedBy, startable: blockedBy.length === 0 };
}

export function roadmapStatus(repoRoot: string, model: Model, binding: Binding | undefined, on = today()): RoadmapStatusPayload {
  const round = model.rounds.find((candidate) => candidate.status === "active");
  const byStage: Record<string, number> = {};
  let total = 0;
  let untargeted = 0;
  for (const doc of model.todos) {
    for (const item of doc.items) {
      if (item.status !== "open") continue;
      total++;
      if (item.target) byStage[item.target] = (byStage[item.target] ?? 0) + 1;
      else untargeted++;
    }
  }
  // A binding whose stage left the active round's unclosed stages is dropped at the next turn; never report it as bound.
  const bound = binding && bindable(model, binding.stage) ? binding.stage : null;
  return {
    kind: ROADMAP_STATUS_KIND,
    version: 1,
    repoRoot,
    project: model.index.title,
    format: model.index.format,
    activeRound: round
      ? { id: round.id, title: round.title, target: round.target ?? null, opened: round.opened ?? null, overdue: overdue(round, on) }
      : null,
    stages: model.stages.map((stage) => ({
      id: stage.id,
      title: stage.title,
      status: stage.status,
      round: stage.round,
      target: stage.target ?? null,
      started: stage.started ?? null,
      closed: stage.closed ?? null,
      overdue: overdue(stage, on),
      dependsOn: [...stage.depends_on],
      ...stageReadiness(model, stage),
    })),
    plannedRounds: model.rounds
      .filter((candidate) => candidate.status === "planned")
      .sort(byId)
      .map((candidate) => ({
        id: candidate.id,
        title: candidate.title,
        target: candidate.target ?? null,
        overdue: overdue(candidate, on),
        ...plannedRoundCounts(model, candidate.id),
      })),
    openTodos: { total, byStage, untargeted },
    boundStage: bound,
  };
}

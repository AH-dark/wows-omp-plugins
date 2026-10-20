import { basename, relative } from "node:path";

import type { AdrRecord } from "./adr.ts";
import { type AtlasStagePlan, type StageCoverage, stageCoverage } from "./atlas.ts";
import { type Model, overdue, parseDoneCriteria, renderStage, type StageDoc, today } from "./documents.ts";
import type { PendingClose } from "./ses.ts";
import { byId, plannedRoundCounts, roundActual, schedule, stageActual, stageReadiness } from "./state.ts";

export interface StageBinding {
  stage: string;
}

function successor(records: readonly AdrRecord[], initial: AdrRecord): AdrRecord {
  let adr = initial;
  const visited = new Set<string>();
  while (adr.superseded_by && !visited.has(adr.id)) {
    visited.add(adr.id);
    const next = records.find((candidate) => candidate.id === adr.superseded_by);
    if (!next) break;
    adr = next;
  }
  return adr;
}

const EXCERPT_LIMIT = 800;
const PLAN_CAP = 12;
const REMINDER_CAP = 4;

export function planLabel(plan: AtlasStagePlan): string {
  return `${oneLine(plan.name, 80)} (${oneLine(plan.planId, 80)})`;
}

/** The text under one `### ` heading of a stage Outcome. */
function outcomeSection(outcome: string, heading: string): string | undefined {
  return new RegExp(`(?:^|\\n)### ${heading}\\n\\n([\\s\\S]*?)(?=\\n\\n### |$)`).exec(outcome)?.[1];
}

function predecessors(model: Model, stage: StageDoc): string {
  const ids = [...new Set([...stage.depends_on, ...(stage.follows ? [stage.follows] : [])])];
  if (!ids.length) return "None.";
  return ids
    .map((id) => {
      const relation = [stage.depends_on.includes(id) ? "depends on" : "", stage.follows === id ? "follows" : ""]
        .filter(Boolean)
        .join(" and ");
      const other = model.stages.find((candidate) => candidate.id === id);
      if (!other) return `### ${id} (missing)\n\n${stage.id} ${relation} ${id}, which is not in the roadmap. Run roadmap_check.`;
      const parts = [
        `### ${other.id} — ${other.title} (${other.status})`,
        `${stage.id} ${relation} ${other.id}.\nStage document: ${model.repo ? relative(model.repo.repoRoot, other.path) : other.path}`,
      ];
      if (other.status === "closed" && other.outcome) {
        for (const heading of ["Delivered", "Deviations"]) {
          const text = outcomeSection(other.outcome, heading);
          if (text === undefined) continue;
          parts.push(
            `#### ${heading}\n\n${text.length > EXCERPT_LIMIT ? `${text.slice(0, EXCERPT_LIMIT).trimEnd()}… (truncated; read the stage document)` : text}`,
          );
        }
      }
      return parts.join("\n\n");
    })
    .join("\n\n");
}

function coverageText(entry: StageCoverage["criteria"][number]): string {
  if (entry.complete.length) return `covered by complete ${entry.complete.map(planLabel).join(", ")}`;
  if (entry.unfinished.length) return `only by unfinished ${entry.unfinished.map(planLabel).join(", ")}`;
  return "uncovered";
}

function plansSection(stage: StageDoc, plans: readonly AtlasStagePlan[]): string {
  const coverage = stageCoverage(stage, plans);
  const lines = plans.length
    ? plans
        .slice(0, PLAN_CAP)
        .map(
          (plan) =>
            `- ${planLabel(plan)} — ${plan.status}, ${plan.done}/${plan.total} rows; ${
              plan.criteria ? `criteria ${plan.criteria.join(", ")}` : "coverage undeclared"
            }${coverage.drifted.includes(plan) ? "; drift: approved against an earlier objective, scope, criteria or design constraints" : ""}`,
        )
    : ["No Atlas plan is bound to this stage yet."];
  if (plans.length > PLAN_CAP) lines.push(`- ${plans.length - PLAN_CAP} more plans; see roadmap_status.`);
  lines.push("", "Coverage of the current done criteria:", ...coverage.criteria.map((entry) => `- ${entry.id} — ${coverageText(entry)}`));
  const uncovered = coverage.criteria.filter((entry) => !entry.complete.length && !entry.unfinished.length).map((entry) => entry.id);
  if (uncovered.length)
    lines.push("", `Uncovered: ${uncovered.join(", ")}. Cover them in this plan or leave them explicitly for another plan.`);
  if (coverage.undeclared.length)
    lines.push("", `Coverage undeclared by ${coverage.undeclared.map(planLabel).join(", ")}; check their scope before relying on them.`);
  if (coverage.drifted.length)
    lines.push(
      "",
      `Drift: ${coverage.drifted.map(planLabel).join(", ")} ${coverage.drifted.length === 1 ? "was" : "were"} approved before this stage's objective, scope, criteria or design constraints changed; re-check against this handoff.`,
    );
  return `## Plans for this stage\n\n${lines.join("\n")}`;
}

/**
 * The stage's planning handoff. `plans` is the `atlas:plans` answer for the stage; without one (omo-prometheus absent)
 * the plan section is omitted.
 */
export function renderHandoff(model: Model, stage: StageDoc, on = today(), plans?: readonly AtlasStagePlan[]): string {
  const round = model.rounds.find((candidate) => candidate.id === stage.round);
  const todos = model.todos.flatMap((doc) => doc.items).filter((item) => item.status === "open" && item.target === stage.id);
  const citations = new Set(
    [
      renderStage(stage),
      round ? [round.goal, round.constraints, round.non_goals, round.principles].join("\n") : "",
      ...todos.map((item) => Object.values(item).join("\n")),
    ]
      .join("\n")
      .match(/\bADR-\d{4,}\b/g) ?? [],
  );
  const view = model.adrs;
  const records = view?.records ?? [];
  const adrs = new Map<string, { adr: AdrRecord; cited: string[] }>();
  const notes: string[] = [];
  if (citations.size && !view) notes.push("Cited ADRs are unavailable: the adr plugin is not loaded in this session.");
  else if (citations.size && view?.error) notes.push(`Cited ADRs could not be read: ${view.error} Run adr_check.`);
  for (const cited of citations) {
    const original = records.find((candidate) => candidate.id === cited);
    if (!original) {
      const broken = view?.parseErrors.find((issue) => Number(basename(issue.path).split("-")[0]) === Number(cited.slice(4)));
      if (broken) notes.push(`${cited} could not be read (${broken.path}: ${broken.message}). Run adr_check.`);
      continue;
    }
    const adr = successor(records, original);
    const entry = adrs.get(adr.id) ?? { adr, cited: [] };
    if (cited !== adr.id) entry.cited.push(cited);
    adrs.set(adr.id, entry);
  }
  const parts = [
    `# Planning handoff: ${stage.id} — ${stage.title}`,
    `Round: ${stage.round}${round ? ` — ${round.title}` : ""}\nStage document: ${model.repo ? relative(model.repo.repoRoot, stage.path) : stage.path}${scheduleLines(stage, round, on)}`,
  ];
  if (round)
    parts.push(
      `## Round charter\n\n### Goal\n\n${round.goal}\n\n### Constraints\n\n${round.constraints || "None."}\n\n### Non-goals\n\n${round.non_goals || "None."}`,
    );
  parts.push(
    `## Objective\n\n${stage.objective}`,
    `## Scope\n\n### In\n\n${stage.scope_in || "None."}\n\n### Out\n\n${stage.scope_out || "None."}`,
    `## Done criteria\n\n${parseDoneCriteria(stage.done_criteria)
      .map((criterion) => `- ${criterion.id} — ${criterion.statement}\n  - Verify: ${criterion.verify}`)
      .join("\n")}`,
  );
  if (plans) parts.push(plansSection(stage, plans));
  if (stage.design_constraints) parts.push(`## Design constraints\n\n${stage.design_constraints}`);
  if (stage.risks) parts.push(`## Risks\n\n${stage.risks}`);
  if (stage.amendments) parts.push(`## Amendments\n\n${stage.amendments}`);
  parts.push(
    `## Predecessors\n\n${predecessors(model, stage)}`,
    `## Open TODOs targeting this stage\n\n${
      todos.length
        ? todos
            .map((item) => `### ${item.id} — ${item.title}\n\nSeverity: ${item.severity}\nSource: ${item.source}\n\n${item.body}`)
            .join("\n\n")
        : "None."
    }`,
    `## Cited ADRs\n\n${
      adrs.size || notes.length
        ? [
            ...[...adrs.values()].map(
              ({ adr, cited }) =>
                `### ${adr.id} — ${adr.title} (${adr.status})\n\nDocument: ${adr.path}${
                  cited.length ? `\nResolved from superseded ${cited.join(", ")}.` : ""
                }\n\n${adr.body.trimEnd()}`,
            ),
            ...notes,
          ].join("\n\n")
        : "None."
    }`,
    `## Free-work log\n\nVerify in code what already exists before planning duplicate work.\n\n${stage.free_work_log || "No free work recorded."}`,
    "## Closing guidance\n\nA stage may be delivered by several plans. Each plan declares the done criteria it owns in one `Roadmap criteria:` line, for example `Roadmap criteria: DC1, DC3`. Criteria that no plan covers yet are listed under Plans for this stage when Atlas plans are available; cover them in this plan or leave them explicitly for another plan. The stage closes only when every current done criterion has passing evidence, from any plan: after a plan completes, evaluate the close and call roadmap_stage action=close with passing evidence for each criterion, delivered work and deviations; otherwise leave the stage active and report the remaining criteria. Resolve or move every open TODO targeting this stage. Close refuses while an ADR linked to this stage is proposed: the main agent accepts or rejects it with adr_manage first. roadmap_check verifies document consistency only; verify code and record real evidence before closing.",
  );
  return `${parts.join("\n\n")}\n`;
}

function oneLine(value: string, limit: number): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > limit ? `${line.slice(0, limit - 3)}...` : line;
}

/** Target versus actual lines for the handoff header; empty when neither the stage nor its round has a target. */
function scheduleLines(stage: StageDoc, round: Model["rounds"][number] | undefined, on: string): string {
  const stageDates = schedule(stage, stageActual(stage), on);
  const roundDates = round ? schedule(round, roundActual(round), on) : "";
  return `${stageDates ? `\nStage schedule: ${stageDates}` : ""}${roundDates ? `\nRound schedule: ${roundDates}` : ""}`;
}

/** Joins at most `cap` items and counts the rest. */
function capped(items: readonly string[], cap: number): string {
  return `${items.slice(0, cap).join(", ")}${items.length > cap ? `, ${items.length - cap} more` : ""}`;
}

const STAGE_CAP = 12;
const PLANNED_ROUND_CAP = 3;

export function renderInjection(model: Model, binding?: StageBinding, on = today()): string {
  const round = model.rounds.find((candidate) => candidate.status === "active");
  if (!round) return "";
  const stages = model.stages
    .filter((stage) => stage.round === round.id && (stage.status === "planned" || stage.status === "active"))
    .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  const todos = model.todos.filter((doc) => doc.round === round.id).flatMap((doc) => doc.items.filter((item) => item.status === "open"));
  const roundDates = schedule(round, null, on);
  const tag = (stage: StageDoc) => {
    const dates = schedule(stage, null, on);
    return dates ? `${stage.status}, ${dates}` : stage.status;
  };
  const lines = [
    "[Roadmap status]",
    `Active round: ${round.id} — ${oneLine(round.title, 120)}${roundDates ? ` (${roundDates})` : ""}`,
    `Goal: ${oneLine(round.goal, 180)}`,
    `Open TODOs: ${todos.length} (${todos.filter((item) => item.severity === "high").length} high severity).`,
    "Unclosed stages:",
    ...stages
      .slice(0, STAGE_CAP)
      .map((stage) => `- ${stage.id} [${tag(stage)}] ${oneLine(stage.title, 80)} — ${oneLine(stage.objective, 160)}`),
  ];
  if (!stages.length) lines.push("- None.");
  if (stages.length > STAGE_CAP) lines.push(`${stages.length - STAGE_CAP} more, see roadmap_status.`);
  // Overdue stages can sit beyond the cap, so name them separately (ids only, bounded like the stage list).
  const late = stages.filter((stage) => overdue(stage, on)).map((stage) => stage.id);
  if (late.length) lines.push(`Overdue stages: ${capped(late, STAGE_CAP)}.`);
  const planned = stages.filter((stage) => stage.status === "planned").map((stage) => ({ id: stage.id, ...stageReadiness(model, stage) }));
  if (planned.length) {
    const startable = planned.filter((stage) => stage.startable).map((stage) => stage.id);
    const blocked = planned.filter((stage) => !stage.startable).map((stage) => `${stage.id} (needs ${stage.blockedBy.join(", ")})`);
    lines.push(
      `Readiness: startable ${startable.length ? capped(startable, STAGE_CAP) : "none"}; blocked ${blocked.length ? capped(blocked, STAGE_CAP) : "none"}.`,
    );
  }
  const plannedRounds = model.rounds.filter((candidate) => candidate.status === "planned").sort(byId);
  if (plannedRounds.length) {
    lines.push(
      "Planned rounds:",
      ...plannedRounds.slice(0, PLANNED_ROUND_CAP).map((candidate) => {
        const count = plannedRoundCounts(model, candidate.id).stageCount;
        const dates = schedule(candidate, null, on);
        return `- ${candidate.id} [planned${dates ? `, ${dates}` : ""}] ${oneLine(candidate.title, 80)} — ${count} stage${count === 1 ? "" : "s"}`;
      }),
    );
    if (plannedRounds.length > PLANNED_ROUND_CAP) lines.push(`${plannedRounds.length - PLANNED_ROUND_CAP} more, see roadmap_status.`);
  }
  if (binding) {
    const stage = model.stages.find((candidate) => candidate.id === binding.stage && candidate.round === round.id);
    lines.push(
      stage?.status === "active"
        ? `Bound stage: ${stage.id}. Call roadmap_status with stage=${stage.id} for its planning handoff.`
        : stage?.status === "planned"
          ? `Bound stage: ${stage.id}, still planned: plan mode bound it without starting it. Call roadmap_status with stage=${stage.id} for its planning handoff. Before implementation begins outside plan mode, start it with roadmap_stage start and commit the files it lists.`
          : `Previous binding ${oneLine(binding.stage, 40)} is no longer active; drop this session's binding.`,
    );
  }
  lines.push(
    "Managed files change only through roadmap_* tools; do not write docs/roadmap/ directly. ADRs change through adr_manage.",
    "If the user's request overlaps an unclosed stage and this session is not working on it, call roadmap_overlap before starting.",
    "Close stages with passing evidence for every done criterion and TODO dispositions, after the main agent accepts or rejects the stage's proposed ADRs with adr_manage. Check cannot detect code/document drift.",
    "[/Roadmap status]",
  );
  return lines.join("\n");
}

/**
 * The bounded reminder after an Atlas plan completed for an active stage. `plans` is a fresh `atlas:plans` answer for
 * the stage; without one only the completion's own gate results and delivery are shown.
 */
export function renderCloseReminder(
  stage: StageDoc,
  pending: readonly PendingClose[],
  plans: readonly AtlasStagePlan[] | undefined,
): string[] {
  const latest = pending.at(-1);
  if (!latest) return [];
  const completed = plans?.find((plan) => plan.planId === latest.planId);
  const lines = [
    `Plan ${completed ? planLabel(completed) : oneLine(latest.planId, 100)} completed for ${stage.id}. Evaluate the close: call roadmap_stage close only with passing evidence for every current done criterion and TODO dispositions, once the main agent has accepted or rejected the stage's proposed ADRs with adr_manage; otherwise leave the stage active and report the remaining criteria.`,
    "Gate results are evidence candidates; map and verify them against the stage's done criteria:",
    ...latest.gates
      .slice(0, REMINDER_CAP)
      .map(
        (gate) =>
          `- ${gate.gateId.replace(/\s+/g, " ").slice(0, 40)}: ${gate.verdict.replace(/\s+/g, " ").slice(0, 20)} — ${gate.summary.replace(/\s+/g, " ").slice(0, 180)}`,
      ),
  ];
  // The completion stored its delivery summary already collapsed and bounded.
  if (latest.delivery) lines.push(`Delivery (${latest.delivery.mode}): ${latest.delivery.summary}`);
  if (plans) {
    // atlas:plans lists plans by their approval's stage, so a plan approved before the stage was bound, which completed
    // for the stage the executing session had bound, is missing; its completion counts as complete, coverage undeclared.
    const unlisted = [
      ...new Set(
        pending.filter((item) => item.stage === stage.id && !plans.some((plan) => plan.planId === item.planId)).map((item) => item.planId),
      ),
    ];
    const coverage = stageCoverage(stage, plans);
    const total = plans.length + unlisted.length;
    lines.push(
      `Criteria coverage across ${total} plan${total === 1 ? "" : "s"}: ${capped(
        coverage.criteria.map(
          (entry) => `${entry.id} ${entry.complete.length ? "complete" : entry.unfinished.length ? "unfinished only" : "uncovered"}`,
        ),
        STAGE_CAP,
      )}.`,
    );
    const list = (items: readonly AtlasStagePlan[], detail: (plan: AtlasStagePlan) => string) =>
      capped(
        items.map((plan) => `${planLabel(plan)}${detail(plan)}`),
        REMINDER_CAP,
      );
    if (coverage.unfinished.length)
      lines.push(
        `Unfinished plans: ${list(coverage.unfinished, (plan) => ` ${plan.done}/${plan.total} rows, ${plan.criteria ? `criteria ${plan.criteria.join(" ")}` : "coverage undeclared"}`)}.`,
      );
    const undeclared = [...coverage.undeclared.map((plan) => planLabel(plan)), ...unlisted.map((planId) => oneLine(planId, 80))];
    if (undeclared.length) lines.push(`Coverage undeclared: ${capped(undeclared, REMINDER_CAP)}.`);
    if (coverage.drifted.length)
      lines.push(
        `Drift: ${list(coverage.drifted, () => "")} approved before ${stage.id}'s objective, scope, criteria or design constraints changed; re-check against the current stage.`,
      );
    if (coverage.untriaged.length)
      lines.push(
        `Untriaged deferred findings: ${capped(
          coverage.untriaged.map((finding) => `${oneLine(finding.plan.name, 40)} ${oneLine(finding.id, 12)} ${oneLine(finding.title, 80)}`),
          REMINDER_CAP,
        )}.`,
      );
    const missing = coverage.criteria.filter((entry) => !entry.complete.length).map((entry) => entry.id);
    lines.push(
      !missing.length
        ? `Ready to evaluate the close: a complete plan declares every current criterion of ${stage.id}; verify each with passing evidence.`
        : `Not ready by declarations: ${capped(missing, STAGE_CAP)} ${missing.length === 1 ? "has" : "have"} no complete plan${
            unlisted.length || coverage.undeclared.some((plan) => plan.status === "complete")
              ? " (complete plans with undeclared coverage may still supply evidence)"
              : ""
          }.`,
    );
  }
  if (latest.gates.length > REMINDER_CAP || pending.length > 1)
    lines.push("Additional pending-close evidence is retained in this session's Roadmap entries.");
  return lines;
}

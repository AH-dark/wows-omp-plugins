/** Coarse per-spawn thinking effort the host task tool accepts; it maps onto the target model's supported thinking levels. */
export const TASK_EFFORTS = ["lo", "med", "hi"] as const;
export type TaskEffort = (typeof TASK_EFFORTS)[number];

/** One judged difficulty drives both the thinking effort and the model budget, so the two never disagree. */
export const TASK_DIFFICULTIES = ["routine", "standard", "demanding"] as const;
export type TaskDifficulty = (typeof TASK_DIFFICULTIES)[number];

export const DIFFICULTY_EFFORT: Record<TaskDifficulty, TaskEffort> = { routine: "lo", standard: "med", demanding: "hi" };

export const MODEL_BUDGETS = ["minimum", "balanced", "max"] as const;
export type ModelBudget = (typeof MODEL_BUDGETS)[number];

export const MODEL_PICKS = ["best", "weighted"] as const;
export type ModelPick = (typeof MODEL_PICKS)[number];

export interface JudgeDispatchSettings {
  routeAgent: boolean;
  selectModel: boolean;
  modelBudget: ModelBudget;
  modelPick: ModelPick;
  /** Multiplier per provider id; unlisted providers weigh 1. */
  providerWeights: ReadonlyMap<string, number>;
  minimumConfidence: number;
  includeSharedContext: boolean;
  judgeEffort: boolean;
  indicator: boolean;
}

/** One model an agent may spawn with, resolved through the host registry. */
export interface ModelOption {
  /** The selector exactly as configured, so its thinking suffix and routing survive. */
  pattern: string;
  /** `provider/id` the selector resolves to; a pool holds each key once. */
  key: string;
  provider: string;
  /** Catalog intelligence score; absent when the catalog has none. */
  intelligence?: number;
  /** USD per million tokens, blended 3:1 input to output; absent without catalog pricing. */
  blendedPrice?: number;
}

export interface CandidateModelSummary {
  role?: string;
  /** Every available model the agent may spawn with, primary first: its selectors plus each role's fallback chain. */
  pool: readonly ModelOption[];
}

export interface RoutingCandidate {
  name: string;
  description: string;
  source: string;
  readOnly: boolean;
  model: CandidateModelSummary;
  /** Agent-frontmatter selectors before settings and session inheritance are applied. */
  declaredModelPatterns?: readonly string[];
}

export interface ParsedTaskRoute {
  /** `null` identifies the flat task shape; a number identifies a batch item. */
  index: number | null;
  assignment: string;
  context?: string;
  requestedAgent?: string;
  modelPinned: boolean;
  /** Model role or `provider/model` selector the caller pinned after `@` in the agent field (`scout@abliterated`). */
  explicitModel?: string;
  /** Spawn label the caller supplied, if any. */
  name?: string;
}

export interface SerializedCandidate {
  name: string;
  description: string;
  source: string;
  access: "read-only" | "write-capable";
  model: {
    declared?: string[];
    role?: string;
    /** `provider/id` keys of the agent's model pool, primary first. */
    models: string[];
  };
}

export interface RoutingDecision {
  kind: string;
  choice: string;
  confidence: number;
}

/** Accepted judgments for one route; an absent field leaves that part of the call as requested. */
export interface RouteChoice {
  agent?: string;
  effort?: TaskEffort;
  agentConfidence?: number;
  effortConfidence?: number;
  /** Spawn label to write when the call has none, so the spawn hook can find this route's model decision. */
  name?: string;
  /** Unique spawn name replacing the caller's name on an explicitly bound item. */
  spawnName?: string;
  model?: ModelChoice;
}

/** Outcome of model selection for one route: the switch made, or why the primary stays. */
export interface ModelChoice {
  /** `provider/id` of the configured primary model. */
  primary: string;
  /** The pool option to spawn with; absent when the primary stays. */
  chosen?: ScoredModelOption;
  /** Judged fit of a `best` pick: its probability share among the eligible models. */
  fit?: number;
  /** Why the primary stays, when the selection did not run to a choice. */
  keptReason?: string;
}

/** Accepted answers from one native judgment; an absent field was not asked or not confident enough. */
export interface JudgedRoute {
  agent?: string;
  difficulty?: TaskDifficulty;
  agentConfidence?: number;
  difficultyConfidence?: number;
  /** The agent question was asked but no legal answer cleared `minimumConfidence`. */
  agentUndecided?: boolean;
  /** The judged probability per model `provider/id`. */
  modelFit?: Readonly<Record<string, number>>;
}

/** Why a route kept its requested agent without a usable judgment. */
export type KeptReason = "workflow-owned or unknown agent" | "no alternatives" | "judge unavailable" | "judge failed" | "timed out";

export type RouteOutcome = JudgedRoute | KeptReason;

const DESCRIPTION_LIMIT = 320;
const MAX_ROUTING_DEADLINE_MS = 8_000;
const TOOL_CALL_SAFETY_MARGIN_MS = 1_000;
const MINIMUM_USEFUL_DEADLINE_MS = 250;

/** Fit routing safely inside OMP's scoped tool-call handler timeout. */
export function routingDeadlineMs(toolCallTimeoutMs: unknown): number | undefined {
  if (typeof toolCallTimeoutMs !== "number" || !Number.isFinite(toolCallTimeoutMs)) return undefined;
  const deadline = Math.min(MAX_ROUTING_DEADLINE_MS, Math.floor(toolCallTimeoutMs) - TOOL_CALL_SAFETY_MARGIN_MS);
  return deadline >= MINIMUM_USEFUL_DEADLINE_MS ? deadline : undefined;
}

const AVAILABLE_AGENTS_HEADING = "# Available Agents";
const AGENT_HEADING_PATTERN = /^###\s+([A-Za-z0-9_-]+)(?:\s|$)/;
const AGENT_BULLET_PATTERN = /^-\s+`([A-Za-z0-9_-]+)`(?:\s|:|$)/;

/**
 * Read the spawnable agent names out of the live `task` tool description. The
 * host renders that list after applying the session's spawn policy and
 * disabled-agent settings, so it is the only authoritative legal set a plugin
 * can observe from a `tool_call` hook. An absent or unrecognized section is
 * unknown; only an explicit disabled message means an empty legal set.
 */
export function parseLegalAgentNames(taskDescription: string): string[] | undefined {
  const headingIndex = taskDescription.indexOf(AVAILABLE_AGENTS_HEADING);
  if (headingIndex < 0) return undefined;
  const names: string[] = [];
  const section = taskDescription.slice(headingIndex + AVAILABLE_AGENTS_HEADING.length);
  let disabled = false;
  for (const line of section.split("\n")) {
    if (/^#{1,2}(?:\s|$)/.test(line)) break;
    if (line.includes("Agent spawning is currently disabled.")) disabled = true;
    const name = AGENT_HEADING_PATTERN.exec(line)?.[1] ?? AGENT_BULLET_PATTERN.exec(line)?.[1];
    if (name && !names.includes(name)) names.push(name);
  }
  if (names.length) return names;
  return disabled ? [] : undefined;
}

function compactDescription(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= DESCRIPTION_LIMIT) return compact;
  return `${compact.slice(0, DESCRIPTION_LIMIT - 1)}…`;
}

function optionalNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

/** Separates an agent from the model role or selector a caller pins it to: `scout@abliterated`. */
const AGENT_MODEL_SEPARATOR = "@";

function agentFields(value: unknown): Pick<ParsedTaskRoute, "requestedAgent" | "explicitModel"> {
  const agent = optionalNonEmptyString(value);
  const at = agent?.indexOf(AGENT_MODEL_SEPARATOR) ?? -1;
  if (!agent || at < 0) return agent ? { requestedAgent: agent } : {};
  const requestedAgent = agent.slice(0, at).trim();
  return { ...(requestedAgent ? { requestedAgent } : {}), explicitModel: agent.slice(at + 1).trim() };
}

/** Parse only valid ordinary task-tool wire shapes; malformed calls remain untouched. */
export function parseTaskInput(input: unknown): ParsedTaskRoute[] | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;

  if (Object.hasOwn(record, "tasks")) {
    if (!Array.isArray(record.tasks) || record.tasks.length === 0) return undefined;
    if (Object.hasOwn(record, "task") || Object.hasOwn(record, "model")) return undefined;
    const context = optionalNonEmptyString(record.context);
    if (!context) return undefined;

    const routes: ParsedTaskRoute[] = [];
    for (const [index, rawItem] of record.tasks.entries()) {
      if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) return undefined;
      const item = rawItem as Record<string, unknown>;
      const assignment = optionalNonEmptyString(item.task);
      if (!assignment) return undefined;
      if (Object.hasOwn(item, "agent") && typeof item.agent !== "string") return undefined;
      const name = optionalNonEmptyString(item.name);
      routes.push({
        index,
        assignment,
        context,
        ...agentFields(item.agent),
        modelPinned: Object.hasOwn(item, "model"),
        ...(name ? { name } : {}),
      });
    }
    return routes;
  }

  const assignment = optionalNonEmptyString(record.task);
  if (!assignment) return undefined;
  if (Object.hasOwn(record, "agent") && typeof record.agent !== "string") return undefined;
  const context = optionalNonEmptyString(record.context);
  const name = optionalNonEmptyString(record.name);
  return [
    {
      index: null,
      assignment,
      ...(context ? { context } : {}),
      ...agentFields(record.agent),
      modelPinned: Object.hasOwn(record, "model"),
      ...(name ? { name } : {}),
    },
  ];
}

function rewriteTaskItem(item: Record<string, unknown>, choice: RouteChoice | undefined): Record<string, unknown> {
  const agentChanged = choice?.agent !== undefined && choice.agent !== item.agent;
  const effortChanged = choice?.effort !== undefined && choice.effort !== item.effort;
  const renamed = choice?.spawnName !== undefined && choice.spawnName !== item.name;
  const nameAdded = choice?.name !== undefined && optionalNonEmptyString(item.name) === undefined;
  if (!agentChanged && !effortChanged && !renamed && !nameAdded) return item;
  return {
    ...item,
    ...(agentChanged ? { agent: choice.agent } : {}),
    ...(effortChanged ? { effort: choice.effort } : {}),
    ...(renamed ? { name: choice.spawnName } : nameAdded ? { name: choice.name } : {}),
  };
}

export function rewriteTaskRoutes(
  input: Record<string, unknown>,
  routes: readonly ParsedTaskRoute[],
  choices: readonly (RouteChoice | undefined)[],
): Record<string, unknown> {
  if (routes.length !== choices.length) return input;

  const flatRoute = routes.length === 1 && routes[0]?.index === null ? routes[0] : undefined;
  if (flatRoute) return rewriteTaskItem(input, choices[0]);

  if (!Array.isArray(input.tasks)) return input;
  let changed = false;
  const tasks = [...input.tasks];
  for (const [routeIndex, route] of routes.entries()) {
    if (route.index === null) continue;
    const item = tasks[route.index];
    if (!item || typeof item !== "object" || Array.isArray(item)) return input;
    const rewritten = rewriteTaskItem(item as Record<string, unknown>, choices[routeIndex]);
    if (rewritten === item) continue;
    tasks[route.index] = rewritten;
    changed = true;
  }
  return changed ? { ...input, tasks } : input;
}

/** Produce the bounded candidate data allowed to leave the host for routing. */
export function serializeCandidate(candidate: RoutingCandidate): SerializedCandidate {
  const declared = candidate.declaredModelPatterns?.filter(Boolean);
  return {
    name: candidate.name,
    description: compactDescription(candidate.description),
    source: candidate.source,
    access: candidate.readOnly ? "read-only" : "write-capable",
    model: {
      ...(declared && declared.length > 0 ? { declared: [...declared] } : {}),
      ...(candidate.model.role ? { role: candidate.model.role } : {}),
      models: candidate.model.pool.map((option) => option.key),
    },
  };
}

/** Workflow-owned review roles retain their own agent, effort, and model policy. */
const RESERVED_AGENT_PREFIX = "audit-";
const RESERVED_AGENT_NAMES: Record<string, true> = { metis: true, momus: true, oracle: true };

export function isWorkflowOwnedAgent(name: string): boolean {
  return name.startsWith(RESERVED_AGENT_PREFIX) || Object.hasOwn(RESERVED_AGENT_NAMES, name);
}

/** Candidates consistent with the requested authority, or undefined when access is unresolved. */
export function routableCandidates<T extends { name: string; readOnly: boolean }>(
  requestedAgent: string | undefined,
  candidates: readonly T[],
): T[] | undefined {
  if (requestedAgent && isWorkflowOwnedAgent(requestedAgent)) return undefined;
  const requested = requestedAgent ? candidates.find((candidate) => candidate.name === requestedAgent) : undefined;
  if (requestedAgent && !requested) return undefined;
  return candidates.filter((candidate) => !isWorkflowOwnedAgent(candidate.name) && (!requested?.readOnly || candidate.readOnly));
}

/** Accept only a legal, sufficiently confident answer from a native judgment transport. */
export function acceptRoutingDecision<T extends string>(
  decision: RoutingDecision,
  legalChoices: readonly T[],
  minimumConfidence: number,
): T | undefined {
  if (decision.kind !== "native") return undefined;
  if (!Number.isFinite(decision.confidence) || decision.confidence < minimumConfidence) return undefined;
  return legalChoices.find((choice) => choice === decision.choice);
}

export type ScoredModelOption = ModelOption & { intelligence: number; blendedPrice: number };

export function isScored(option: ModelOption): option is ScoredModelOption {
  return (
    option.intelligence !== undefined &&
    Number.isFinite(option.intelligence) &&
    option.intelligence > 0 &&
    option.blendedPrice !== undefined &&
    Number.isFinite(option.blendedPrice)
  );
}

export function blendedPrice(cost: { input: number; output: number }): number {
  return (3 * cost.input + cost.output) / 4;
}

/**
 * Lowest share of the primary model's intelligence a pool option needs, per budget
 * and difficulty. The primary is the user's declared baseline, so it always
 * qualifies and anything stronger may be picked; `minimum` admits the whole pool.
 */
const CAPABILITY_FLOORS: Record<ModelBudget, Record<TaskDifficulty, number>> = {
  max: { routine: 1, standard: 1, demanding: 1 },
  balanced: { routine: 0.8, standard: 0.9, demanding: 1 },
  minimum: { routine: 0, standard: 0, demanding: 0 },
};

/** Exponent `k` of the `weighted` cheapness factor `1 / (1 + rank)^k`; 0 ignores price. */
const CHEAPNESS_EXPONENTS: Record<ModelBudget, Record<TaskDifficulty, number>> = {
  max: { routine: 0, standard: 0, demanding: 0 },
  balanced: { routine: 1, standard: 0.5, demanding: 0 },
  minimum: { routine: 2, standard: 1, demanding: 0.5 },
};

export interface ModelSelection {
  /** Available pool, primary first, one entry per `provider/id`. */
  pool: readonly ModelOption[];
  difficulty: TaskDifficulty;
  budget: ModelBudget;
  pick: ModelPick;
  providerWeights: ReadonlyMap<string, number>;
  /** The judged probability per model `provider/id`; absent when the judge was not asked or did not answer. */
  fit?: Readonly<Record<string, number>>;
  /** Uniform sample in [0, 1) for `weighted`. */
  random?: () => number;
}

/**
 * Pick a spawn model from an agent's pool. The budget decides which options are
 * eligible; `best` then takes the judge's best fit weighted by provider, and
 * `weighted` samples by fit, provider weight, and how cheap an option is.
 */
export function selectSpawnModel(selection: ModelSelection): ModelChoice | undefined {
  const primary = selection.pool[0];
  if (!primary) return undefined;
  const kept = (keptReason: string): ModelChoice => ({ primary: primary.key, keptReason });
  if (!isScored(primary)) return kept("primary model has no catalog score");

  const floor = primary.intelligence * CAPABILITY_FLOORS[selection.budget][selection.difficulty];
  const eligible = selection.pool.filter(isScored).filter((option) => option.intelligence >= floor);
  if (eligible.length < 2) return kept("no eligible alternatives");

  const providerWeight = (option: ModelOption) => selection.providerWeights.get(option.provider) ?? 1;
  const probabilities = selection.fit;
  const fitMass = probabilities ? eligible.reduce((sum, option) => sum + (probabilities[option.key] ?? 0), 0) : 0;
  const fitOf = (option: ModelOption) => (probabilities && fitMass > 0 ? (probabilities[option.key] ?? 0) / fitMass : 1);

  if (selection.pick === "best") {
    // Many-option answers rarely concentrate past a routing threshold, and every option is a model the
    // user configured for this agent, so `best` follows the judged distribution instead of its confidence.
    if (fitMass <= 0) return kept("no model judgment");
    // Strict comparison keeps the earlier pool entry, so the primary wins ties.
    const chosen = eligible.reduce((best, option) =>
      fitOf(option) * providerWeight(option) > fitOf(best) * providerWeight(best) ? option : best,
    );
    return { primary: primary.key, chosen, fit: fitOf(chosen) };
  }

  const exponent = CHEAPNESS_EXPONENTS[selection.budget][selection.difficulty];
  const byCost = [...eligible].sort((a, b) => a.blendedPrice - b.blendedPrice || a.intelligence - b.intelligence);
  const weights = eligible.map((option) => fitOf(option) * providerWeight(option) * (1 + byCost.indexOf(option)) ** -exponent);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (!(total > 0)) return kept("no eligible alternatives");
  let remaining = (selection.random ?? Math.random)() * total;
  for (const [index, option] of eligible.entries()) {
    remaining -= weights[index] as number;
    if (remaining < 0) return { primary: primary.key, chosen: option };
  }
  return { primary: primary.key, chosen: eligible.at(-1) };
}

export interface PendingSpawnRoute {
  /** Agent whose pool the decision came from; the spawn must be of this agent. */
  agent: string;
  /** `provider/id` the host must still resolve as primary, or the pool is stale. */
  primary: string;
  /** Spawn selectors, chosen model first, the rest of the pool as its retry chain. */
  patterns: string[];
  note: string;
}

const PENDING_SPAWN_LIMIT = 256;
const SPAWN_SUFFIX_PATTERN = /-\d+$/;

/**
 * Model decisions made at `tool_call` time, waiting for the matching
 * `before_subagent_spawn`. That event carries no assignment, only a spawn key the
 * host derives from the task item's `name` (`<parent>.<name>`, `-N` on collision),
 * so decisions are keyed by name. A name claimed twice is dropped for both spawns.
 */
export class PendingSpawnRoutes {
  #routes = new Map<string, PendingSpawnRoute | null>();

  add(name: string, route: PendingSpawnRoute | null): void {
    if (this.#routes.has(name)) {
      this.#routes.set(name, null);
      return;
    }
    this.#routes.set(name, route);
    while (this.#routes.size > PENDING_SPAWN_LIMIT) {
      const oldest = this.#routes.keys().next().value;
      if (oldest === undefined) break;
      this.#routes.delete(oldest);
    }
  }

  /** Consume the decision for a spawn of `agent`, if one is unambiguously pending under this key. */
  take(spawnKey: string, agent: string): PendingSpawnRoute | undefined {
    const leaf = taskSpawnName(spawnKey);
    for (const name of [leaf, leaf.replace(SPAWN_SUFFIX_PATTERN, "")]) {
      if (!this.#routes.has(name)) continue;
      const route = this.#routes.get(name);
      this.#routes.delete(name);
      if (!route || route.agent !== agent) return undefined;
      return route;
    }
    return undefined;
  }
}

/**
 * The task name a spawn key stands for: the host nests ids under parents
 * (`<parent>.<name>`), trims a name before allocating it, and labels
 * unallocated synchronous spawns with the raw name.
 */
function taskSpawnName(key: string): string {
  return key.slice(key.lastIndexOf(".") + 1).trim();
}

/** Model patterns a pinned task item applies at spawn. */
export interface ExplicitSpawnModel {
  /** `@role` or the `provider/model` selector the caller pinned. */
  target: string;
  patterns: string[];
  note: string;
}

/** A pinned item's spawn name: its own name, then `_jd` and a unique 12-hex token. */
const PINNED_SPAWN_NAME = /_jd[0-9a-f]{12}$/;

/** Whether a task name or spawn key has the shape judge-dispatch reserves for pinned spawns. */
export function isPinnedSpawnName(name: string): boolean {
  return PINNED_SPAWN_NAME.test(taskSpawnName(name));
}

/**
 * Pinned task items awaiting their spawns. The spawn hook sees only the child id
 * the host allocates from an item's name, so each pinned item is renamed to a
 * unique spawn name: OMP's `-N` collision suffix and other tasks reusing the
 * caller's name can never take the pin. One registry serves the plugin instance,
 * because a background job may spawn after its session was switched away.
 *
 * A cancelled background job never spawns and never settles, so the registry
 * evicts its oldest claims past a bound; `take` reports such a spawn as lost
 * rather than letting it start on the agent's own model.
 */
export class ExplicitSpawnClaims {
  #claims = new Map<string, { model: ExplicitSpawnModel; toolCallId: string }>();

  /** Reserve a unique spawn name for one pinned item of the task call `toolCallId`. */
  claim(toolCallId: string, name: string, model: ExplicitSpawnModel): string {
    // A dot would nest the id under a parent, hiding the spawn name from `taskSpawnName`.
    const base = name.replaceAll(".", "-");
    let spawnName = "";
    while (!spawnName || this.#claims.has(spawnName)) {
      spawnName = `${base}_jd${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    }
    this.#claims.set(spawnName, { model, toolCallId });
    for (const oldest of this.#claims.keys()) {
      if (this.#claims.size <= PENDING_SPAWN_LIMIT) break;
      this.#claims.delete(oldest);
    }
    return spawnName;
  }

  /** Drop the claims of a task call that settled without a background job: none of its items spawns later. */
  settle(toolCallId: string): void {
    for (const [spawnName, claim] of this.#claims) if (claim.toolCallId === toolCallId) this.#claims.delete(spawnName);
  }

  /** Consume the claim a spawn key belongs to; `lost` when the key is a pinned spawn name whose claim is gone. */
  take(spawnKey: string): ExplicitSpawnModel | "lost" | undefined {
    const spawnName = taskSpawnName(spawnKey);
    const claim = this.#claims.get(spawnName);
    if (!claim) return isPinnedSpawnName(spawnName) ? "lost" : undefined;
    this.#claims.delete(spawnName);
    return claim.model;
  }
}

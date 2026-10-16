import type { Model } from "@oh-my-pi/pi-ai";
import { type Effort, THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { clampThinkingLevelForModel, getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { type ConfiguredThinkingLevel, clampThinkingLevelToCeiling } from "@oh-my-pi/pi-tui/thinking";

/** The judged difficulty of an assignment; `standard` leaves the agent's own model and thinking level in place. */
export const TASK_DIFFICULTIES = ["routine", "standard", "demanding"] as const;
export type TaskDifficulty = (typeof TASK_DIFFICULTIES)[number];

/** Difficulties a model tier can name; `standard` always runs on the agent's own model. */
export const TIER_DIFFICULTIES = ["routine", "demanding"] as const;
export type TierDifficulty = (typeof TIER_DIFFICULTIES)[number];

/** Tier selectors keyed `<agent>.<difficulty>` for one agent or `<difficulty>` for every agent. */
export type ModelTiers = ReadonlyMap<string, string>;

export interface JudgeDispatchSettings {
  routeAgent: boolean;
  judgeEffort: boolean;
  modelTiers: ModelTiers;
  minimumConfidence: number;
  includeSharedContext: boolean;
  indicator: boolean;
}

export interface RoutingCandidate {
  name: string;
  description: string;
  source: string;
  readOnly: boolean;
  /** Expanded model selectors the agent spawns with, in attempt order. */
  patterns: readonly string[];
  /** The agent definition's own thinking level, which applies when its model selector carries none. */
  thinkingLevel?: ConfiguredThinkingLevel;
}

export interface ParsedTaskRoute {
  /** `null` identifies the flat task shape; a number identifies a batch item. */
  index: number | null;
  assignment: string;
  context?: string;
  /** The caller's own description of how open the problem is. */
  solutionSpace?: string;
  /** The item sets `effort` itself, so its thinking level is never stepped. */
  explicitEffort?: true;
  requestedAgent?: string;
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
}

export interface RoutingDecision {
  kind: string;
  choice: string;
  confidence: number;
}

/** Why a re-dispatched task is raised: its child answered `ESCALATE: deep-high`, or failed after a lowered route. */
export type EscalationReason = "escalate" | "failure";

/** One thinking-level step at spawn: the level the child would have run at, and the level it runs at instead. */
export interface ThinkingStep {
  from: Effort;
  to: Effort;
}

/** A configured model tier for one route: the swap made, or why the agent's own model stays. */
export interface TierChoice {
  /** `provider/id` the agent's own selectors resolve to, when one does. */
  primary?: string;
  /** The tier selector as configured. */
  tier: string;
  keptReason?: string;
}

/** Accepted decisions for one route; an absent field leaves that part of the call as requested. */
export interface RouteChoice {
  agent?: string;
  agentConfidence?: number;
  /** Spawn label to write when the call has none, so the spawn hook can find this route's decision. */
  name?: string;
  /** Unique spawn name replacing the caller's name on an explicitly bound item. */
  spawnName?: string;
  /** The difficulty acted on: a confident judgment, or one forced by an escalation. */
  difficulty?: TaskDifficulty;
  difficultyConfidence?: number;
  escalation?: EscalationReason;
  thinking?: ThinkingStep;
  model?: TierChoice;
}

/** Accepted answers from one native judgment, or a difficulty an escalation forces; an absent field was not asked or not confident enough. */
export interface JudgedRoute {
  agent?: string;
  difficulty?: TaskDifficulty;
  agentConfidence?: number;
  difficultyConfidence?: number;
  /** The agent question was asked but no legal answer cleared `minimumConfidence`. */
  agentUndecided?: boolean;
  escalation?: EscalationReason;
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

const TIER_KEY = /^(?:[A-Za-z0-9_-]+\.)?(?:routine|demanding)$/;
const TIER_ROLE = /^@[^\s@,/:]+$/;
const TIER_MODEL = /^[^\s@,/]+\/[^\s,]+$/;

/**
 * Parse `modelTiers`: comma-separated `[<agent>.]<routine|demanding>=<selector>`
 * entries, where the selector is `@<role>` or `provider/model[:level]`. Throws on
 * any malformed or repeated entry, so a typo never half-applies.
 */
export function parseModelTiers(raw: string): ModelTiers {
  const tiers = new Map<string, string>();
  if (!raw.trim()) return tiers;
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    const separator = trimmed.indexOf("=");
    const key = trimmed.slice(0, separator).trim();
    const selector = trimmed.slice(separator + 1).trim();
    const validSelector = TIER_ROLE.test(selector) || (TIER_MODEL.test(selector) && !selector.startsWith("pi/"));
    if (separator < 0 || !TIER_KEY.test(key) || !validSelector || tiers.has(key)) {
      throw new Error(
        `invalid modelTiers entry ${JSON.stringify(trimmed)}; expected unique [<agent>.]<routine|demanding>=<@role or provider/model[:level]>`,
      );
    }
    tiers.set(key, selector);
  }
  return tiers;
}

/** The tier selector for an agent at a difficulty: its own entry first, then the entry for every agent. */
export function tierFor(tiers: ModelTiers, agent: string, difficulty: TaskDifficulty): string | undefined {
  if (difficulty === "standard") return undefined;
  return tiers.get(`${agent}.${difficulty}`) ?? tiers.get(difficulty);
}

export function hasTier(tiers: ModelTiers, agent: string): boolean {
  return TIER_DIFFICULTIES.some((difficulty) => tierFor(tiers, agent, difficulty) !== undefined);
}

/**
 * One supported thinking level down for routine work, one up for demanding work,
 * from the level the child would run at without any `effort`. `baseline` is that
 * level as configured: the explicit `:level` of the primary selector, else the
 * agent definition's own. Nothing steps from `auto`, `inherit`, `off` or no level,
 * a step never leaves the model's supported levels (so never reaches `off`), and
 * it is clamped to `task.maxEffort`, which the host applies only to an `effort`.
 */
export function thinkingStep(
  model: Model | undefined,
  baseline: ConfiguredThinkingLevel | undefined,
  difficulty: TaskDifficulty,
  ceiling: Effort | undefined,
): ThinkingStep | undefined {
  if (!model || difficulty === "standard") return undefined;
  const requested = THINKING_EFFORTS.find((level) => level === baseline);
  const from = requested === undefined ? undefined : clampThinkingLevelForModel(model, requested);
  if (from === undefined) return undefined;
  const supported = getSupportedEfforts(model);
  const ladder = THINKING_EFFORTS.filter((level) => supported.includes(level));
  const target = ladder[ladder.indexOf(from) + (difficulty === "demanding" ? 1 : -1)];
  if (target === undefined) return undefined;
  const to = clampThinkingLevelToCeiling(model, target, ceiling) ?? target;
  if (ceiling !== undefined && THINKING_EFFORTS.indexOf(to) > THINKING_EFFORTS.indexOf(ceiling)) return undefined;
  const moved = THINKING_EFFORTS.indexOf(to) - THINKING_EFFORTS.indexOf(from);
  if (difficulty === "demanding" ? moved <= 0 : moved >= 0) return undefined;
  return { from, to };
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

/** Item fields the flat and batch shapes share. */
function itemFields(item: Record<string, unknown>): Pick<ParsedTaskRoute, "solutionSpace" | "explicitEffort" | "name"> {
  const solutionSpace = optionalNonEmptyString(item.solutionSpace);
  const name = optionalNonEmptyString(item.name);
  return {
    ...(solutionSpace ? { solutionSpace } : {}),
    ...(item.effort !== undefined ? { explicitEffort: true } : {}),
    ...(name ? { name } : {}),
  };
}

/** Parse only valid ordinary task-tool wire shapes; malformed calls remain untouched. */
export function parseTaskInput(input: unknown): ParsedTaskRoute[] | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;

  if (Object.hasOwn(record, "tasks")) {
    if (!Array.isArray(record.tasks) || record.tasks.length === 0) return undefined;
    if (Object.hasOwn(record, "task")) return undefined;
    const context = optionalNonEmptyString(record.context);
    if (!context) return undefined;

    const routes: ParsedTaskRoute[] = [];
    for (const [index, rawItem] of record.tasks.entries()) {
      if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) return undefined;
      const item = rawItem as Record<string, unknown>;
      const assignment = optionalNonEmptyString(item.task);
      if (!assignment) return undefined;
      if (Object.hasOwn(item, "agent") && typeof item.agent !== "string") return undefined;
      routes.push({ index, assignment, context, ...agentFields(item.agent), ...itemFields(item) });
    }
    return routes;
  }

  const assignment = optionalNonEmptyString(record.task);
  if (!assignment) return undefined;
  if (Object.hasOwn(record, "agent") && typeof record.agent !== "string") return undefined;
  const context = optionalNonEmptyString(record.context);
  return [{ index: null, assignment, ...(context ? { context } : {}), ...agentFields(record.agent), ...itemFields(record) }];
}

function rewriteTaskItem(item: Record<string, unknown>, choice: RouteChoice | undefined): Record<string, unknown> {
  const agentChanged = choice?.agent !== undefined && choice.agent !== item.agent;
  const renamed = choice?.spawnName !== undefined && choice.spawnName !== item.name;
  const nameAdded = choice?.name !== undefined && optionalNonEmptyString(item.name) === undefined;
  if (!agentChanged && !renamed && !nameAdded) return item;
  return {
    ...item,
    ...(agentChanged ? { agent: choice.agent } : {}),
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

/** Produce the bounded candidate data allowed to leave the host for routing; models never reach the judge. */
export function serializeCandidate(candidate: RoutingCandidate): SerializedCandidate {
  return {
    name: candidate.name,
    description: compactDescription(candidate.description),
    source: candidate.source,
    access: candidate.readOnly ? "read-only" : "write-capable",
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

/** A spawn-time change decided at `tool_call`, for the spawn of `agent` only. */
interface PendingSpawnBase {
  agent: string;
  /** `provider/id` the host must still resolve first for the agent, or the decision is stale. */
  primary?: string;
  difficulty: TaskDifficulty;
  note: string;
}

export type PendingSpawnRoute =
  /** Replace the agent's selectors with a tier's. */
  | (PendingSpawnBase & { kind: "tier"; patterns: string[] })
  /** Give the primary selector this thinking level, recomputed at spawn from the agent's own `thinkingLevel`. */
  | (PendingSpawnBase & { kind: "thinking"; to: Effort; thinkingLevel?: ConfiguredThinkingLevel });

const PENDING_SPAWN_LIMIT = 256;
const SPAWN_SUFFIX_PATTERN = /-\d+$/;

/**
 * Spawn decisions made at `tool_call` time, waiting for the matching
 * `before_subagent_spawn`. That event carries no assignment, only a spawn key the
 * host derives from the task item's `name` (`<parent>.<name>`, `-N` on collision),
 * so decisions are keyed by name. A name claimed twice is dropped for both spawns.
 */
export class PendingSpawnRoutes {
  #routes = new Map<string, PendingSpawnRoute | null>();

  add(name: string, route: PendingSpawnRoute): void {
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
export function taskSpawnName(key: string): string {
  return key.slice(key.lastIndexOf(".") + 1).trim();
}

/** Model patterns a pinned task item, or a model tier, applies at spawn. */
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

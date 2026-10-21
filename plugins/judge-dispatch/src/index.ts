import type { ChoiceQuestion, Model } from "@oh-my-pi/pi-ai";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  disabledProviderIds,
  formatModelStringWithRouting,
  resolveAgentModelSelection,
  resolveConfiguredModelPatterns,
  resolveExplicitModelRole,
  resolveModelOverride,
} from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { findScopedSettings, type Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import { type ChainJudge, type JudgmentUsageLedger, journalJudgmentUsage, resolveJudge } from "@oh-my-pi/pi-coding-agent/judgment";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { type AgentDefinition, discoverAgents, isReadOnlyAgent } from "@oh-my-pi/pi-coding-agent/task";
import { MAX_THINKING_SUFFIX_OPTIONS, splitThinkingSuffix } from "@oh-my-pi/pi-tui/overlays/model-selector";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import type { TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";

import { EscalationMemo, taskResultOutput } from "#src/escalation.ts";
import { readHostSetting } from "#src/host-settings.ts";
import { registerLegacyRouteRecords, setRoutingWorkingMessage, showRouteOutcomes, showRoutingStatus } from "#src/indicator.ts";
import {
  acceptRoutingDecision,
  ExplicitSpawnClaims,
  type ExplicitSpawnModel,
  hasTier,
  isPinnedSpawnName,
  isWorkflowOwnedAgent,
  type JudgeDispatchSettings,
  type ParsedTaskRoute,
  PendingSpawnRoutes,
  parseLegalAgentNames,
  parseModelTiers,
  parseTaskInput,
  type RouteChoice,
  type RouteOutcome,
  type RoutingCandidate,
  rewriteTaskRoutes,
  routableCandidates,
  routingDeadlineMs,
  serializeCandidate,
  TASK_DIFFICULTIES,
  type TaskDifficulty,
  thinkingStep,
  tierFor,
} from "#src/routing.ts";

const PACKAGE_NAME = "wows-omp-plugin-judge-dispatch";
/** The host's `task` default agent when a call names none and the session spawn policy is unrestricted. */
const DEFAULT_SPAWN_AGENT = "task";
/** Every setting the manifest declares; anything else stored for the plugin is ignored with a warning. */
const SETTING_KEYS: Record<string, true> = {
  routeAgent: true,
  judgeEffort: true,
  modelTiers: true,
  minimumConfidence: true,
  includeSharedContext: true,
  indicator: true,
};
const DISPATCH_RECORD_LIMIT = 256;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withRoutingDeadline<T>(timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    const error = new DOMException(`judge-dispatch routing exceeded ${timeoutMs}ms`, "TimeoutError");
    controller.abort(error);
    timeout.reject(error);
  }, timeoutMs);

  try {
    return await Promise.race([operation(controller.signal), timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

function booleanSetting(raw: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = raw[key] ?? fallback;
  if (typeof value !== "boolean") throw new Error(`invalid ${key} ${JSON.stringify(value)}`);
  return value;
}

function parseSettings(raw: Record<string, unknown>): JudgeDispatchSettings {
  const minimumConfidence = raw.minimumConfidence ?? 0.7;
  if (typeof minimumConfidence !== "number" || !Number.isFinite(minimumConfidence) || minimumConfidence < 0 || minimumConfidence > 1) {
    throw new Error(`invalid minimumConfidence ${JSON.stringify(minimumConfidence)}`);
  }
  const modelTiers = raw.modelTiers ?? "";
  if (typeof modelTiers !== "string") throw new Error(`invalid modelTiers ${JSON.stringify(modelTiers)}`);

  return {
    routeAgent: booleanSetting(raw, "routeAgent", true),
    judgeEffort: booleanSetting(raw, "judgeEffort", false),
    modelTiers: parseModelTiers(modelTiers),
    minimumConfidence,
    includeSharedContext: booleanSetting(raw, "includeSharedContext", true),
    indicator: booleanSetting(raw, "indicator", true),
  };
}

function scopedSettings(ctx: ExtensionContext): Settings {
  const settings = findScopedSettings(ctx.cwd);
  if (!settings) throw new Error("the active session has no scoped Settings instance");
  return settings;
}

function deduplicateAgents(agents: readonly AgentDefinition[]): AgentDefinition[] {
  const seen = new Set<string>();
  return agents.filter((agent) => {
    if (seen.has(agent.name)) return false;
    seen.add(agent.name);
    return true;
  });
}

/** The selector a spawn starts on and what it resolves to. */
interface ResolvedPrimary {
  /** Index of the first selector that resolves; the host spawns with it. */
  index: number;
  model: Model;
  /** `provider/id`. */
  key: string;
  thinkingLevel?: ConfiguredThinkingLevel;
  explicitThinkingLevel: boolean;
}

/** Resolve selectors in attempt order as the spawn does, with disabled providers removed first. */
function resolvePrimary(patterns: readonly string[], settings: Settings, ctx: ExtensionContext): ResolvedPrimary | undefined {
  const disabled = disabledProviderIds(settings);
  const enabled = ctx.modelRegistry.getAvailable().filter((model) => !disabled.has(model.provider));
  const registry = { getAvailable: () => enabled };
  for (const [index, pattern] of patterns.entries()) {
    const { model, thinkingLevel, explicitThinkingLevel } = resolveModelOverride([pattern], registry, settings);
    if (model) return { index, model, key: `${model.provider}/${model.id}`, thinkingLevel, explicitThinkingLevel };
  }
  return undefined;
}

/**
 * A `tool_call` hook sees no host spawn preflight, so the legal candidate set comes
 * from the host's own rendered `task` agent list (`legalNames`). Discovery here
 * only adds each listed agent's model selectors and thinking level; an agent the
 * host did not list is never described to a judge or selected.
 */
async function discoverCandidates(ctx: ExtensionContext, settings: Settings, legalNames: readonly string[]): Promise<RoutingCandidate[]> {
  if (legalNames.length === 0) return [];
  const currentSession = AgentRegistry.global()
    .list()
    .find((ref) => ref.session?.sessionManager === ctx.sessionManager)?.session;
  const discovery = await discoverAgents(ctx.cwd, undefined, currentSession?.effectiveExtensionRoots);
  const agents = deduplicateAgents([...discovery.agents, ...(currentSession?.getSessionAgents() ?? [])]);
  const byName = new Map(agents.map((agent) => [agent.name, agent]));
  const blockedAgent = process.env.PI_BLOCKED_AGENT?.trim();
  const modelOverrides = readHostSetting(settings, "task.agentModelOverrides") as Record<string, string | string[] | undefined>;
  const activeModelPattern = ctx.model ? formatModelStringWithRouting(ctx.model) : undefined;

  return legalNames
    .filter((name) => name !== blockedAgent)
    .map((name) => byName.get(name))
    .filter((agent): agent is AgentDefinition => agent !== undefined)
    .map((agent) => ({
      name: agent.name,
      description: agent.description,
      source: agent.source,
      readOnly: isReadOnlyAgent(agent),
      patterns: resolveAgentModelSelection({
        settingsOverride: modelOverrides[agent.name],
        agentModel: agent.model,
        settings,
        activeModelPattern,
        fallbackModelPattern: activeModelPattern,
      }).patterns,
      ...(agent.thinkingLevel ? { thinkingLevel: agent.thinkingLevel } : {}),
    }));
}

/** The `judge` role chain did not reach a native judgment candidate: missing credentials or a chat-model judge role. */
const JUDGE_UNAVAILABLE = Symbol("judge-unavailable");

function sessionJudge(ctx: ExtensionContext, settings: Settings): ChainJudge {
  return resolveJudge({
    settings,
    registry: ctx.modelRegistry,
    sessionId: ctx.sessionManager.getSessionId(),
    purpose: "judge-dispatch",
    onUsage: journalJudgmentUsage(ctx.sessionManager as unknown as Partial<JudgmentUsageLedger>),
  });
}

const DIFFICULTY_QUESTION: ChoiceQuestion<TaskDifficulty> = {
  type: "choice",
  instructions:
    "Classify how demanding this assignment is for the subagent, judged by how open-ended the problem is rather than by how much work it involves. A solutionSpace in the state is the caller's own description of how open the problem is: whether the fix or design is given, or which causes or designs remain open.",
  criteria: {
    routine: "Mechanical or fully specified work: the fix or steps are given and little reasoning is needed.",
    standard: "Ordinary multi-step work whose approach is mostly settled but still needs some reasoning.",
    demanding: "Open-ended, ambiguous, or logic-heavy work where causes or designs remain open.",
  },
};

async function judgeRoute(
  route: ParsedTaskRoute,
  routable: readonly RoutingCandidate[],
  config: JudgeDispatchSettings,
  judge: ChainJudge,
  signal: AbortSignal,
  beforeJudge: () => void,
): Promise<RouteOutcome | typeof JUDGE_UNAVAILABLE> {
  signal.throwIfAborted();
  const spawnAgent = route.requestedAgent ?? DEFAULT_SPAWN_AGENT;
  const candidates = config.routeAgent ? routable : routable.filter((candidate) => candidate.name === spawnAgent);
  if (candidates.length === 0) return "no alternatives";
  const routesAgent = config.routeAgent && candidates.length >= 2;
  const difficultyApplies = (agent: string): boolean =>
    route.explicitModel === undefined && ((config.judgeEffort && !route.explicitEffort) || hasTier(config.modelTiers, agent));
  // Ask both together only if every possible final agent can use the difficulty.
  // Agent-specific tiers otherwise need the agent answer before difficulty can matter.
  const judgesDifficulty = routesAgent ? candidates.every((candidate) => difficultyApplies(candidate.name)) : difficultyApplies(spawnAgent);
  if (!routesAgent && !judgesDifficulty) return "no alternatives";

  const serialized = candidates.map(serializeCandidate);
  const candidateNames = serialized.map((candidate) => candidate.name);
  const state = {
    assignment: route.assignment,
    ...(route.solutionSpace ? { solutionSpace: route.solutionSpace } : {}),
    ...(config.includeSharedContext && route.context ? { context: route.context } : {}),
    requestedAgent: route.requestedAgent ?? null,
    candidates: serialized.map((candidate) => ({ ...candidate })),
  };
  const questions: Record<string, ChoiceQuestion> = {};
  if (routesAgent) {
    questions.agent = {
      type: "choice",
      instructions:
        "Choose the single agent type best suited to complete this assignment. Match the declared specialization and access needs; do not classify effort.",
      criteria: Object.fromEntries(
        serialized.map((candidate) => [candidate.name, `${candidate.description} [${candidate.source}; ${candidate.access}]`]),
      ),
    };
  }
  if (judgesDifficulty) questions.difficulty = DIFFICULTY_QUESTION;

  // A chat-model judge cannot reproduce a native judge's calibrated confidence, so
  // the chain's first usable candidate must be native; anything else is never called.
  let reachedNative = false;
  try {
    beforeJudge();
    return await judge.withCandidate(
      async (candidate, kind) => {
        if (kind !== "native") return JUDGE_UNAVAILABLE;
        reachedNative = true;
        const { answers } = await candidate.judge({ state, questions }, { signal });
        const agentAnswer = routesAgent ? answers.agent : undefined;
        const agent = agentAnswer
          ? acceptRoutingDecision(
              { kind, choice: agentAnswer.choice, confidence: agentAnswer.confidence },
              candidateNames,
              config.minimumConfidence,
            )
          : undefined;
        let difficultyAnswer = judgesDifficulty ? answers.difficulty : undefined;
        if (!judgesDifficulty && difficultyApplies(agent ?? spawnAgent)) {
          const result = await candidate.judge(
            { state: { ...state, finalAgent: agent ?? spawnAgent }, questions: { difficulty: DIFFICULTY_QUESTION } },
            { signal },
          );
          difficultyAnswer = result.answers.difficulty;
        }
        const difficulty = difficultyAnswer
          ? acceptRoutingDecision(
              { kind, choice: difficultyAnswer.choice, confidence: difficultyAnswer.confidence },
              TASK_DIFFICULTIES,
              config.minimumConfidence,
            )
          : undefined;
        return {
          ...(agent ? { agent, agentConfidence: agentAnswer?.confidence } : {}),
          ...(routesAgent && !agent ? { agentUndecided: true } : {}),
          ...(difficulty ? { difficulty, difficultyConfidence: difficultyAnswer?.confidence } : {}),
        };
      },
      { signal },
    );
  } catch (error) {
    if (!reachedNative && !signal.aborted) return JUDGE_UNAVAILABLE;
    throw error;
  }
}

/**
 * Routing state of one parent session. `before_subagent_spawn` and
 * `tool_execution_end` carry that session's context, so each finds its own.
 */
interface SessionRouting {
  pending: PendingSpawnRoutes;
  escalations: EscalationMemo;
  /** Each routed task call until its result arrives: when it was dispatched, and the caller's name per item position. */
  dispatched: Map<string, { at: number; names: (string | undefined)[] }>;
}

interface RoutingSession {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  config: JudgeDispatchSettings;
  judge: ChainJudge;
  escalations: EscalationMemo;
  notifyUnavailable(ctx: ExtensionContext): void;
  beforeJudge(): void;
}

/**
 * An item re-dispatched under a remembered name keeps its agent and takes the
 * remembered difficulty without a judgment. The record is only read here; the
 * caller consumes it once the routed call is actually returned.
 */
async function routeOutcome(
  session: RoutingSession,
  route: ParsedTaskRoute,
  candidates: readonly RoutingCandidate[],
  signal: AbortSignal,
): Promise<RouteOutcome> {
  const routable = routableCandidates(route.requestedAgent, candidates);
  if (!routable) return "workflow-owned or unknown agent";
  const escalation = route.name ? session.escalations.peek(route.name) : undefined;
  if (escalation) return { difficulty: escalation.difficulty, escalation: escalation.reason };
  try {
    const judged = await judgeRoute(route, routable, session.config, session.judge, signal, session.beforeJudge);
    if (judged !== JUDGE_UNAVAILABLE) return judged;
    session.notifyUnavailable(session.ctx);
    return "judge unavailable";
  } catch {
    session.pi.logger.warn("judge-dispatch judgment failed; preserving the original route");
    return signal.aborted ? "timed out" : "judge failed";
  }
}

/**
 * Turn an outcome into the task-call rewrite, recording the spawn change its hook
 * will apply: a configured model tier for a routine or demanding difficulty, else,
 * with `judgeEffort`, one thinking-level step. Pins keep their own model and level.
 */
function planRoute(
  route: ParsedTaskRoute,
  outcome: RouteOutcome,
  config: JudgeDispatchSettings,
  candidates: readonly RoutingCandidate[],
  pending: PendingSpawnRoutes,
  settings: Settings,
  ctx: ExtensionContext,
): RouteChoice | undefined {
  if (typeof outcome === "string") return undefined;
  const choice: RouteChoice = {
    ...(outcome.agent ? { agent: outcome.agent, agentConfidence: outcome.agentConfidence } : {}),
    ...(outcome.difficulty ? { difficulty: outcome.difficulty, difficultyConfidence: outcome.difficultyConfidence } : {}),
    ...(outcome.escalation ? { escalation: outcome.escalation } : {}),
  };
  const difficulty = outcome.difficulty;
  if (route.explicitModel !== undefined || !difficulty || difficulty === "standard") return choice;
  const agent = outcome.agent ?? route.requestedAgent ?? DEFAULT_SPAWN_AGENT;
  const candidate = candidates.find((entry) => entry.name === agent);
  if (!candidate) return choice;

  const primary = resolvePrimary(candidate.patterns, settings, ctx);
  const name = route.name ?? `${agent}-${crypto.randomUUID().slice(0, 8)}`;
  const tier = tierFor(config.modelTiers, agent, difficulty);
  if (tier) {
    try {
      const model = explicitSpawnModel(tier.startsWith("@") ? tier.slice(1) : tier, ctx);
      const tierPrimary = resolvePrimary(model.patterns, settings, ctx);
      // A selector without its own level runs at the agent's `thinkingLevel`, for the tier as for the agent's model.
      const level = (resolved: ResolvedPrimary | undefined) =>
        resolved?.explicitThinkingLevel ? resolved.thinkingLevel : candidate.thinkingLevel;
      // Only a tier that resolves to the agent's own model at its own level changes nothing; then the thinking step may still apply.
      if (tierPrimary?.key !== primary?.key || level(tierPrimary) !== level(primary)) {
        pending.add(name, {
          kind: "tier",
          agent,
          primary: primary?.key,
          difficulty,
          patterns: model.patterns,
          note: `judge-dispatch ${difficulty} tier ${model.target}`,
        });
        choice.model = { primary: primary?.key, tier };
        if (!route.name) choice.name = name;
        return choice;
      }
    } catch (error) {
      choice.model = { primary: primary?.key, tier, keptReason: errorMessage(error) };
    }
  }

  if (!config.judgeEffort || route.explicitEffort || !primary) return choice;
  const thinking = thinkingStep(
    primary.model,
    primary.explicitThinkingLevel ? primary.thinkingLevel : candidate.thinkingLevel,
    difficulty,
    readHostSetting(settings, "task.maxEffort") as Effort,
  );
  if (!thinking) return choice;
  pending.add(name, {
    kind: "thinking",
    agent,
    primary: primary.key,
    difficulty,
    to: thinking.to,
    ...(candidate.thinkingLevel ? { thinkingLevel: candidate.thinkingLevel } : {}),
    note: `judge-dispatch ${difficulty} task: thinking ${thinking.from} → ${thinking.to}`,
  });
  choice.thinking = thinking;
  if (!route.name) choice.name = name;
  return choice;
}

/**
 * Feed a routed task call's final child outcomes into the escalation memo.
 * Synchronous items arrive in the result itself. Background items settle later:
 * their jobs are bound now, by child id and dispatch time, and remembered from
 * the job's terminal status and delivery text when its promise settles.
 */
function observeTaskOutcomes(routing: SessionRouting, ctx: ExtensionContext, toolCallId: string, details: unknown): void {
  const dispatch = routing.dispatched.get(toolCallId);
  if (dispatch === undefined || !details || typeof details !== "object") return;
  routing.dispatched.delete(toolCallId);
  const { results, progress, async } = details as Partial<TaskToolDetails>;
  const settled = new Set<string>();
  for (const result of Array.isArray(results) ? results : []) {
    settled.add(result.id);
    const name = dispatch.names[result.index];
    if (name === undefined || isWorkflowOwnedAgent(result.agent)) continue;
    const failed = result.aborted === true || result.exitCode !== 0 || result.error !== undefined;
    routing.escalations.settle(name, result.id, failed, result.output);
  }
  if (!async || !Array.isArray(progress)) return;
  // Background child id → the name its item was dispatched under.
  const background = new Map<string, string>();
  for (const row of progress) {
    const name = dispatch.names[row.index];
    if (name !== undefined && !settled.has(row.id) && !isWorkflowOwnedAgent(row.agent)) background.set(row.id, name);
  }
  if (background.size === 0) return;
  const parent = AgentRegistry.global()
    .list()
    .find((ref) => ref.session?.sessionManager === ctx.sessionManager);
  for (const job of parent?.session?.asyncJobManager?.getAllJobs({ ownerId: parent.id }) ?? []) {
    const childId = job.agentId;
    const name = childId === undefined ? undefined : background.get(childId);
    if (job.type !== "task" || childId === undefined || name === undefined || job.startTime < dispatch.at) continue;
    background.delete(childId);
    const settle = () =>
      routing.escalations.settle(name, childId, job.status !== "completed", taskResultOutput(job.resultText ?? job.errorText ?? ""));
    void job.promise.then(settle, settle);
  }
}

/** Warn once per session that routing is idle until the host's judge role reaches a native judgment model. */
function unavailableNotifier(pi: ExtensionAPI): (ctx: ExtensionContext) => void {
  let shown = false;
  return (ctx) => {
    if (shown) return;
    shown = true;
    try {
      ctx.ui.notify(
        "judge-dispatch needs OMP's judge role to resolve to a native judgment model such as TypeSafe Jev; keeping requested agents. Run /login typesafe or set TYPESAFE_API_KEY.",
        "warning",
      );
    } catch (error) {
      pi.logger.warn("judge-dispatch could not display its judge availability warning", { error: errorMessage(error) });
    }
  };
}

/** Warn once per session about stored settings the manifest no longer declares; they are ignored. */
function unknownSettingsNotifier(pi: ExtensionAPI): (ctx: ExtensionContext, raw: Record<string, unknown>) => void {
  const warned = new WeakSet<object>();
  return (ctx, raw) => {
    const unknown = Object.keys(raw).filter((key) => !Object.hasOwn(SETTING_KEYS, key));
    if (unknown.length === 0 || warned.has(ctx.sessionManager)) return;
    warned.add(ctx.sessionManager);
    const message = `judge-dispatch ignores settings it no longer has: ${unknown.join(", ")}. Choose models per difficulty with modelTiers instead.`;
    pi.logger.warn(message);
    try {
      ctx.ui.notify(message, "warning");
    } catch (error) {
      pi.logger.warn("judge-dispatch could not display its settings warning", { error: errorMessage(error) });
    }
  };
}

/** Resolve a pinned or tier target to the patterns its spawn receives, refusing one the host would not resolve as named. */
function explicitSpawnModel(target: string, ctx: ExtensionContext): ExplicitSpawnModel {
  const settings = scopedSettings(ctx);
  const role = target.includes("/") ? undefined : target;
  const display = role === undefined ? target : `@${role}`;
  if (role !== undefined && resolveExplicitModelRole(display, settings) !== role) throw new Error(`unknown model role ${role}`);
  // A role alias or list here would expand to that role's selectors and then take the default chain instead of the role's own.
  if (role === undefined && (target.startsWith("@") || target.startsWith("pi/") || target.includes(","))) {
    throw new Error("a concrete model must be a single provider/model selector");
  }
  const selectors = resolveConfiguredModelPatterns(display, settings);
  if (selectors.length === 0) throw new Error(`no models are configured for ${display}`);

  const chains = readHostSetting(settings, "retry.fallbackChains") as Record<string, unknown>;
  const chain = (role === undefined ? undefined : chains[role]) ?? chains.default ?? [];
  if (!Array.isArray(chain) || !chain.every((entry): entry is string => typeof entry === "string")) {
    throw new Error(`the fallback chain for ${display} is invalid`);
  }
  if (chain.some((entry) => entry.endsWith("/*"))) throw new Error("provider wildcard fallback chains cannot be applied per task");
  // Match the spawn-time lookup: disabled providers leave the registry before any selector resolves.
  const disabled = disabledProviderIds(settings);
  const enabled = ctx.modelRegistry.getAvailable().filter((model) => !disabled.has(model.provider));
  // A concrete model must resolve itself; a role may resolve through its own fallback chain.
  if (!resolveModelOverride(role === undefined ? selectors : [...selectors, ...chain], { getAvailable: () => enabled }, settings).model) {
    throw new Error(`no enabled model resolves for ${display}`);
  }
  return {
    target: display,
    patterns: [...selectors, ...chain],
    note: `judge-dispatch pinned ${role === undefined ? "model" : "role"} ${display}`,
  };
}

/**
 * Rename every pinned item of a task call to a unique spawn name with its model
 * claim, and strip the pin from its agent. Throws on the first pin that cannot
 * apply; the caller then releases the call's claims and refuses the call.
 */
function applyPins(
  input: Record<string, unknown>,
  routes: readonly ParsedTaskRoute[],
  claims: ExplicitSpawnClaims,
  toolCallId: string,
  ctx: ExtensionContext,
): { input: Record<string, unknown>; routes: ParsedTaskRoute[]; confirmation: string } {
  const models = routes.map((route) => {
    if (route.explicitModel === undefined) return undefined;
    const label = `${route.requestedAgent ?? ""}@${route.explicitModel}`;
    if (!route.requestedAgent || !route.explicitModel) {
      throw new Error(`write the agent as <agent>@<model role> or <agent>@<provider>/<model>, not ${JSON.stringify(label)}`);
    }
    if (route.requestedAgent === "seance") {
      throw new Error("seance bypasses the model-pin spawn hook; put the selector in that item's native model field instead");
    }
    if (isWorkflowOwnedAgent(route.requestedAgent)) throw new Error(`workflow-owned agent ${route.requestedAgent} keeps its own model`);
    try {
      return explicitSpawnModel(route.explicitModel, ctx);
    } catch (error) {
      throw new Error(`${label}: ${errorMessage(error)}`);
    }
  });
  const applied: string[] = [];
  const choices = routes.map((route, index): RouteChoice | undefined => {
    const model = models[index];
    if (!model || !route.requestedAgent) return undefined;
    const spawnName = claims.claim(toolCallId, route.name ?? route.requestedAgent, model);
    applied.push(
      `${route.name ?? "an unnamed item"} with agent ${route.requestedAgent}@${route.explicitModel} now runs as ${spawnName} on ${model.target}`,
    );
    return { agent: route.requestedAgent, spawnName };
  });
  return {
    input: rewriteTaskRoutes(input, routes, choices),
    routes: routes.map((route, index) => {
      const model = models[index];
      return model ? { ...route, explicitModel: model.target } : route;
    }),
    confirmation: `judge-dispatch rewrote the pinned items of this task call before they ran: ${applied.join("; ")}. OMP shows and stores that rewrite in place of the call you wrote, which is why your call lists the bare agent and the new name; the pin is in effect, so do not re-dispatch.`,
  };
}

/** Whether an approved Prometheus plan executes on this branch, read from its latest valid workflow state rather than wording. */
function prometheusExecuting(ctx: ExtensionContext): boolean {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type !== "custom" || entry.customType !== "wows-omp-omo-prometheus.state") continue;
    const data: unknown = entry.data;
    const phase = data && typeof data === "object" && "phase" in data ? data.phase : undefined;
    if (phase === "idle" || phase === "planning") return false;
    if (phase === "executing") return true;
  }
  return false;
}

const PIN_GUIDANCE =
  "judge-dispatch: when the user asks to run a subagent on a specific OMP model role or model rather than its agent's own, write that task item's agent as `<agent>@<model role>` (for example `scout@smol`) or `<agent>@<provider>/<model>`. The judge then still routes the agent, never the model or its thinking level. judge-dispatch rewrites the call before it runs, and OMP keeps that rewrite in place of your call: it then shows the bare agent and a name ending in `_jd` plus 12 hex digits (built from the item's name, or its agent when unnamed). That rewrite is the pin taking effect, not a mistake, so never re-dispatch because of it. Address the child by the id the task result returns. To rerun a pinned task, write the pin in its agent again. A pin that cannot apply refuses the call with the reason. To retry or escalate a task, re-dispatch it with the same name so routing raises it.";

export default function judgeDispatch(pi: ExtensionAPI): void {
  const notifyUnavailable = unavailableNotifier(pi);
  const warnUnknownSettings = unknownSettingsNotifier(pi);
  registerLegacyRouteRecords(pi);
  const routingBySession = new WeakMap<object, SessionRouting>();
  const routingFor = (ctx: ExtensionContext): SessionRouting => {
    let routing = routingBySession.get(ctx.sessionManager);
    if (!routing) {
      routing = { pending: new PendingSpawnRoutes(), escalations: new EscalationMemo(), dispatched: new Map() };
      routingBySession.set(ctx.sessionManager, routing);
    }
    return routing;
  };
  const claims = new ExplicitSpawnClaims();

  pi.on("before_agent_start", (event) => {
    if (!pi.getActiveTools().includes("task")) return undefined;
    return { systemPrompt: [...event.systemPrompt, PIN_GUIDANCE] };
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (event.toolName !== "task") return;
    const result: unknown = event.result;
    const details = result && typeof result === "object" && "details" in result ? result.details : undefined;
    // Background jobs spawn after this result and consume their claims then; any other settled call already spawned every child it will.
    if (!(details && typeof details === "object" && "async" in details && details.async)) claims.settle(event.toolCallId);
    try {
      observeTaskOutcomes(routingFor(ctx), ctx, event.toolCallId, details);
    } catch (error) {
      pi.logger.warn("judge-dispatch could not observe task outcomes", { error: errorMessage(error) });
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "task") return undefined;
    let working = false;
    let indicator = false;
    // Once pinned items carry their spawn names, every later outcome must keep them.
    let pinned: { input: Record<string, unknown>; additionalContext: string } | undefined;
    try {
      const input = event.input as Record<string, unknown>;
      let routes = parseTaskInput(input);
      const pins = routes?.some((route) => route.explicitModel !== undefined) ?? false;
      // Prometheus owns agent, effort and model choices while executing its approved plan.
      if (prometheusExecuting(ctx)) {
        return pins ? { block: true, reason: "Task models cannot be pinned while an approved Prometheus plan executes" } : undefined;
      }
      const reserved = routes?.find((route) => route.explicitModel === undefined && route.name && isPinnedSpawnName(route.name));
      if (reserved) {
        return {
          block: true,
          reason: `Task name ${reserved.name} ends like a model-pin spawn name, which judge-dispatch reserves; use another name, and to rerun a pinned task write its agent as <agent>@<model role> or <agent>@<provider>/<model> again`,
        };
      }
      let named = input;
      if (routes && pins) {
        try {
          const applied = applyPins(input, routes, claims, event.toolCallId, ctx);
          ({ input: named, routes } = applied);
          pinned = { input: named, additionalContext: applied.confirmation };
        } catch (error) {
          claims.settle(event.toolCallId);
          return { block: true, reason: `judge-dispatch could not pin the task model: ${errorMessage(error)}` };
        }
      }
      const rawSettings = await getPluginSettings(PACKAGE_NAME, ctx.cwd);
      warnUnknownSettings(ctx, rawSettings);
      const config = parseSettings(rawSettings);
      indicator = config.indicator;
      const settings = scopedSettings(ctx);
      const deadlineMs = routingDeadlineMs(readHostSetting(settings, "extensionHandlers.toolCallTimeoutMs"));
      if (deadlineMs === undefined) {
        if (indicator) showRoutingStatus(pi, ctx, "kept the requested agent: extensionHandlers.toolCallTimeoutMs leaves no time to judge");
        return pinned;
      }
      const taskTool = pi.getAllTools().find((tool) => tool.name === "task");
      const legalNames = taskTool ? parseLegalAgentNames(taskTool.description) : undefined;
      if (!legalNames?.length) {
        if (indicator) showRoutingStatus(pi, ctx, "kept the requested agent: the task tool lists no agents to route between");
        return pinned;
      }
      if (!routes) return pinned;
      const judged = routes;
      const routing = routingFor(ctx);
      // The host reports each child by item position; remember the caller's own name for it, exactly as written. Pinned items run under `_jd` names and are never remembered.
      const names: (string | undefined)[] = [];
      for (const route of judged) names[route.index ?? 0] = route.explicitModel === undefined ? route.name : undefined;
      routing.dispatched.set(event.toolCallId, { at: Date.now(), names });
      for (const oldest of routing.dispatched.keys()) {
        if (routing.dispatched.size <= DISPATCH_RECORD_LIMIT) break;
        routing.dispatched.delete(oldest);
      }
      return await withRoutingDeadline(deadlineMs, async (signal) => {
        const candidates = await discoverCandidates(ctx, settings, legalNames);
        signal.throwIfAborted();
        const session: RoutingSession = {
          pi,
          ctx,
          config,
          judge: sessionJudge(ctx, settings),
          escalations: routing.escalations,
          notifyUnavailable,
          beforeJudge() {
            // A judgment that starts after the deadline would set a message the finally block already restored.
            if (!config.indicator || working || signal.aborted) return;
            working = true;
            setRoutingWorkingMessage(pi, ctx, `judge-dispatch: routing ${judged.length} ${judged.length === 1 ? "task" : "tasks"}…`);
          },
        };
        const outcomes = await Promise.all(judged.map((route) => routeOutcome(session, route, candidates, signal)));
        signal.throwIfAborted();
        const choices = judged.map((route, index) =>
          planRoute(route, outcomes[index] as RouteOutcome, config, candidates, routing.pending, settings, ctx),
        );
        const rewritten = rewriteTaskRoutes(named, judged, choices);
        if (indicator) showRouteOutcomes(pi, ctx, judged, outcomes, choices);
        // Past the last abort check nothing can fail open any more, so the raised routes are the ones this call returns.
        for (const [index, route] of judged.entries()) {
          const outcome = outcomes[index];
          if (route.name && typeof outcome === "object" && outcome.escalation) routing.escalations.consume(route.name);
        }
        return rewritten === input ? undefined : { ...pinned, input: rewritten };
      });
    } catch (error) {
      pi.logger.warn("judge-dispatch task interception failed open", { error: errorMessage(error) });
      if (indicator) {
        const timedOut = error instanceof DOMException && error.name === "TimeoutError";
        showRoutingStatus(pi, ctx, `kept the requested agent: routing ${timedOut ? "timed out" : "failed"}`);
      }
      return pinned;
    } finally {
      if (working) setRoutingWorkingMessage(pi, ctx);
    }
  });

  pi.on("before_subagent_spawn", async (event, ctx) => {
    if (event.invocationKind !== "task" || !event.spawnKey) return undefined;
    let explicit: ExplicitSpawnModel | undefined;
    try {
      const claim = claims.take(event.spawnKey);
      if (claim === "lost") {
        return {
          block: true,
          reason: `Task ${event.spawnKey} carries a model-pin spawn name, but its pin is no longer known to judge-dispatch; dispatch it again with the pin in its agent (<agent>@<role>), or use a name without the _jd suffix`,
        };
      }
      explicit = claim;
      if (explicit) {
        if (prometheusExecuting(ctx)) {
          return {
            block: true,
            reason: `Task ${event.spawnKey} pinned ${explicit.target} before the approved Prometheus plan started executing, so it was not started; dispatch it again after execution ends`,
          };
        }
        // OMP gives a lone pattern the chain of the agent's own role (or `default`); a pin whose target has no chain must not borrow it.
        if (explicit.patterns.length === 1) {
          const chains = readHostSetting(scopedSettings(ctx), "retry.fallbackChains") as Record<string, unknown>;
          const inherited = (event.modelRole ? chains[event.modelRole] : undefined) ?? chains.default;
          if (Array.isArray(inherited) && inherited.length > 0) {
            return {
              block: true,
              reason: `Task ${event.spawnKey} pinned ${explicit.target}, which has no fallback chain, but OMP would retry it on the ${event.modelRole ?? "default"} chain; configure ${explicit.target.startsWith("@") ? `retry.fallbackChains.${explicit.target.slice(1)}` : "retry.fallbackChains.default"}`,
            };
          }
        }
        return { model: explicit.patterns, note: explicit.note };
      }
      const routing = routingFor(ctx);
      const route = routing.pending.take(event.spawnKey, event.agent);
      if (!route) return undefined;
      // The decision was made against the agent's selectors at `tool_call`; skip it if the host now starts elsewhere.
      const settings = scopedSettings(ctx);
      const primary = resolvePrimary(event.patterns, settings, ctx);
      if (primary?.key !== route.primary) return undefined;
      let model = route.kind === "tier" ? route.patterns : undefined;
      if (route.kind === "thinking" && primary) {
        const thinking = thinkingStep(
          primary.model,
          primary.explicitThinkingLevel ? primary.thinkingLevel : route.thinkingLevel,
          route.difficulty,
          readHostSetting(settings, "task.maxEffort") as Effort,
        );
        if (thinking?.to !== route.to) return undefined;
        const pattern = event.patterns[primary.index];
        if (pattern === undefined) return undefined;
        const base = primary.explicitThinkingLevel ? splitThinkingSuffix(pattern, -1, MAX_THINKING_SUFFIX_OPTIONS).base : pattern;
        model = event.patterns.with(primary.index, `${base}:${thinking.to}`);
      }
      if (!model) return undefined;
      if (route.difficulty === "routine") routing.escalations.lowered(event.spawnKey, route.difficulty);
      return { model, note: route.note };
    } catch (error) {
      if (explicit)
        return { block: true, reason: `Task ${event.spawnKey} could not apply its pinned ${explicit.target}: ${errorMessage(error)}` };
      pi.logger.warn("judge-dispatch spawn routing failed open", { error: errorMessage(error) });
      return undefined;
    }
  });
}

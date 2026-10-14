import type { ChoiceQuestion, JudgmentState } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  disabledProviderIds,
  formatModelStringWithRouting,
  normalizeModelPatternList,
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

import { readHostSetting } from "#src/host-settings.ts";
import { registerLegacyRouteRecords, setRoutingWorkingMessage, showRouteOutcomes, showRoutingStatus } from "#src/indicator.ts";
import {
  acceptRoutingDecision,
  blendedPrice,
  DIFFICULTY_EFFORT,
  ExplicitSpawnClaims,
  type ExplicitSpawnModel,
  isPinnedSpawnName,
  isScored,
  isWorkflowOwnedAgent,
  type JudgeDispatchSettings,
  MODEL_BUDGETS,
  MODEL_PICKS,
  type ModelBudget,
  type ModelOption,
  type ModelPick,
  type ParsedTaskRoute,
  PendingSpawnRoutes,
  parseLegalAgentNames,
  parseTaskInput,
  type RouteChoice,
  type RouteOutcome,
  type RoutingCandidate,
  rewriteTaskRoutes,
  routableCandidates,
  routingDeadlineMs,
  type SerializedCandidate,
  selectSpawnModel,
  serializeCandidate,
  TASK_DIFFICULTIES,
  type TaskDifficulty,
} from "#src/routing.ts";

const PACKAGE_NAME = "wows-omp-plugin-judge-dispatch";
/** The host's `task` default agent when a call names none and the session spawn policy is unrestricted. */
const DEFAULT_SPAWN_AGENT = "task";

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

function parseProviderWeights(raw: unknown): Map<string, number> {
  if (typeof raw !== "string") throw new Error(`invalid providerWeights ${JSON.stringify(raw)}`);
  const weights = new Map<string, number>();
  for (const entry of raw.split(/[,;\n]/)) {
    if (!entry.trim()) continue;
    const separator = entry.indexOf("=");
    const provider = entry.slice(0, separator).trim();
    const weight = Number(entry.slice(separator + 1).trim());
    if (separator < 0 || !provider || !Number.isFinite(weight) || weight <= 0 || weights.has(provider)) {
      throw new Error(`invalid providerWeights entry ${JSON.stringify(entry.trim())}; expected unique provider=weight with weight > 0`);
    }
    weights.set(provider, weight);
  }
  return weights;
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

  // Releases up to 0.5 stored `modelBudget: off` to mean "no model selection" and any other budget to enable it.
  const legacyOff = raw.modelBudget === "off";
  const modelBudget = legacyOff ? "balanced" : (raw.modelBudget ?? "balanced");
  if (!MODEL_BUDGETS.includes(modelBudget as ModelBudget)) {
    throw new Error(`invalid modelBudget ${JSON.stringify(modelBudget)}`);
  }
  const modelPick = raw.modelPick ?? "best";
  if (!MODEL_PICKS.includes(modelPick as ModelPick)) {
    throw new Error(`invalid modelPick ${JSON.stringify(modelPick)}`);
  }

  return {
    routeAgent: booleanSetting(raw, "routeAgent", true),
    selectModel: booleanSetting(raw, "selectModel", raw.modelBudget !== undefined && !legacyOff),
    modelBudget: modelBudget as ModelBudget,
    modelPick: modelPick as ModelPick,
    providerWeights: parseProviderWeights(raw.providerWeights ?? ""),
    minimumConfidence,
    includeSharedContext: booleanSetting(raw, "includeSharedContext", true),
    judgeEffort: booleanSetting(raw, "judgeEffort", false),
    indicator: booleanSetting(raw, "indicator", true),
  };
}

async function effectivePluginSettings(cwd: string): Promise<JudgeDispatchSettings> {
  return parseSettings(await getPluginSettings(PACKAGE_NAME, cwd));
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

function modelOption(pattern: string, settings: Settings, ctx: ExtensionContext): ModelOption | undefined {
  const model = resolveModelOverride([pattern], ctx.modelRegistry, settings).model;
  if (!model) return undefined;
  return {
    pattern,
    key: `${model.provider}/${model.id}`,
    provider: model.provider,
    ...(model.int != null && Number.isFinite(model.int) ? { intelligence: model.int } : {}),
    ...(model.cost ? { blendedPrice: blendedPrice(model.cost) } : {}),
  };
}

/**
 * Flatten an agent's model selection into one pool, primary first: the expanded
 * selectors, every role alias's retry chain, and, for a single selector, the chain
 * the host would inherit for it. Selectors resolving to the same `provider/id`
 * collapse into the first, so its thinking suffix wins.
 */
function modelPool(
  selection: { patterns: readonly string[]; role?: string },
  sourceSelectors: readonly string[],
  chains: Record<string, unknown>,
  settings: Settings,
  ctx: ExtensionContext,
): ModelOption[] {
  const chainOf = (role: string): string[] | undefined => {
    const chain = chains[role];
    return Array.isArray(chain) ? chain.filter((entry): entry is string => typeof entry === "string") : undefined;
  };
  const roles = sourceSelectors.flatMap((selector) => resolveExplicitModelRole(selector, settings) ?? []);
  const selectors = [
    ...selection.patterns,
    ...roles.flatMap((role) => chainOf(role) ?? []),
    ...(selection.patterns.length === 1 ? (chainOf(selection.role ?? "default") ?? chainOf("default") ?? []) : []),
  ];
  const pool: ModelOption[] = [];
  for (const pattern of selectors) {
    const option = modelOption(pattern, settings, ctx);
    if (option && !pool.some((existing) => existing.key === option.key)) pool.push(option);
  }
  return pool;
}

/**
 * A `tool_call` hook sees no host spawn preflight, so the legal candidate set comes
 * from the host's own rendered `task` agent list (`legalNames`). Discovery here
 * only adds model metadata for those names; an agent the host did not list is
 * never described to a judge or selected.
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
  const fallbackChains = readHostSetting(settings, "retry.fallbackChains") as Record<string, unknown>;
  const activeModelPattern = ctx.model ? formatModelStringWithRouting(ctx.model) : undefined;

  return legalNames
    .filter((name) => name !== blockedAgent)
    .map((name) => byName.get(name))
    .filter((agent): agent is AgentDefinition => agent !== undefined)
    .map((agent) => {
      const override = modelOverrides[agent.name];
      const selection = resolveAgentModelSelection({
        settingsOverride: override,
        agentModel: agent.model,
        settings,
        activeModelPattern,
        fallbackModelPattern: activeModelPattern,
      });
      const sourceSelectors =
        normalizeModelPatternList(override).length > 0 ? normalizeModelPatternList(override) : normalizeModelPatternList(agent.model);
      return {
        name: agent.name,
        description: agent.description,
        source: agent.source,
        readOnly: isReadOnlyAgent(agent),
        declaredModelPatterns: normalizeModelPatternList(agent.model),
        model: {
          ...(selection.role ? { role: selection.role } : {}),
          pool: modelPool(selection, sourceSelectors, fallbackChains, settings, ctx),
        },
      } satisfies RoutingCandidate;
    });
}

function candidateCriterion(candidate: SerializedCandidate): string {
  const model = candidate.model;
  const selectors = [
    model.declared?.length ? `declared ${model.declared.join(", ")}` : undefined,
    model.role ? `role ${model.role}` : undefined,
    model.models.length ? `models ${model.models.join(", ")}` : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join("; ");
  return `${candidate.description} [${candidate.source}; ${candidate.access}${selectors ? `; ${selectors}` : ""}]`;
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
    "Classify how demanding this assignment is for the subagent, judged by how open-ended the problem is rather than by how much work it involves.",
  criteria: {
    routine: "Mechanical or fully specified work: the fix or steps are given and little reasoning is needed.",
    standard: "Ordinary multi-step work whose approach is mostly settled but still needs some reasoning.",
    demanding: "Open-ended, ambiguous, or logic-heavy work where causes or designs remain open.",
  },
};

const MODEL_QUESTION_INSTRUCTIONS =
  "Choose the single model best suited to complete this assignment, weighing the work's reasoning depth and domain against each model's catalog intelligence and price. Do not choose the agent type.";

function modelCriteria(candidates: readonly RoutingCandidate[]): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const option of candidates.flatMap((candidate) => candidate.model.pool)) {
    if (Object.hasOwn(criteria, option.key) || !isScored(option)) continue;
    const agents = candidates.filter((candidate) => candidate.model.pool.some((entry) => entry.key === option.key)).map((c) => c.name);
    criteria[option.key] =
      `intelligence ${option.intelligence}, $${option.blendedPrice.toFixed(2)}/M blended; available to ${agents.join(", ")}`;
  }
  return criteria;
}

async function judgeRoute(
  route: ParsedTaskRoute,
  allCandidates: readonly RoutingCandidate[],
  config: JudgeDispatchSettings,
  judge: ChainJudge,
  signal: AbortSignal,
  beforeJudge: () => void,
): Promise<RouteOutcome | typeof JUDGE_UNAVAILABLE> {
  signal.throwIfAborted();
  const routable = routableCandidates(route.requestedAgent, allCandidates);
  if (!routable) return "workflow-owned or unknown agent";
  const spawnAgent = route.requestedAgent ?? DEFAULT_SPAWN_AGENT;
  const candidates = config.routeAgent ? routable : routable.filter((candidate) => candidate.name === spawnAgent);
  if (candidates.length === 0) return "no alternatives";
  const routesAgent = config.routeAgent && candidates.length >= 2;
  const modelOptions = config.selectModel && route.explicitModel === undefined ? modelCriteria(candidates) : {};
  const judgesModel = Object.keys(modelOptions).length >= 2;
  const judgesDifficulty = config.judgeEffort || judgesModel;
  if (!routesAgent && !judgesDifficulty) return "no alternatives";

  const serialized = candidates.map(serializeCandidate);
  const candidateNames = serialized.map((candidate) => candidate.name);
  const state = {
    assignment: route.assignment,
    ...(config.includeSharedContext && route.context ? { context: route.context } : {}),
    requestedAgent: route.requestedAgent ?? null,
    candidates: serialized,
  } as unknown as JudgmentState;
  const questions: Record<string, ChoiceQuestion> = {};
  if (routesAgent) {
    questions.agent = {
      type: "choice",
      instructions:
        "Choose the single agent type best suited to complete this assignment. Match the declared specialization and access needs; do not classify effort.",
      criteria: Object.fromEntries(serialized.map((candidate) => [candidate.name, candidateCriterion(candidate)])),
    };
  }
  if (judgesDifficulty) questions.difficulty = DIFFICULTY_QUESTION;
  if (judgesModel) questions.model = { type: "choice", instructions: MODEL_QUESTION_INSTRUCTIONS, criteria: modelOptions };

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
        const accept = <T extends string>(id: string, legal: readonly T[]): T | undefined => {
          const answer = answers[id];
          return (
            answer && acceptRoutingDecision({ kind, choice: answer.choice, confidence: answer.confidence }, legal, config.minimumConfidence)
          );
        };
        const agent = routesAgent ? accept("agent", candidateNames) : undefined;
        const difficulty = judgesDifficulty ? accept("difficulty", TASK_DIFFICULTIES) : undefined;
        const modelAnswer = judgesModel ? answers.model : undefined;
        const modelFit = modelAnswer?.type === "choice" ? modelAnswer.probabilities : undefined;
        return {
          ...(agent ? { agent, agentConfidence: answers.agent?.confidence } : {}),
          ...(routesAgent && !agent ? { agentUndecided: true } : {}),
          ...(difficulty ? { difficulty, difficultyConfidence: answers.difficulty?.confidence } : {}),
          ...(modelFit ? { modelFit } : {}),
        };
      },
      { signal },
    );
  } catch (error) {
    if (!reachedNative && !signal.aborted) return JUDGE_UNAVAILABLE;
    throw error;
  }
}

interface RoutingSession {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  config: JudgeDispatchSettings;
  judge: ChainJudge;
  notifyUnavailable(ctx: ExtensionContext): void;
  beforeJudge(): void;
}

async function judgeRouteFailOpen(
  session: RoutingSession,
  route: ParsedTaskRoute,
  candidates: readonly RoutingCandidate[],
  signal: AbortSignal,
): Promise<RouteOutcome> {
  try {
    const judged = await judgeRoute(route, candidates, session.config, session.judge, signal, session.beforeJudge);
    if (judged !== JUDGE_UNAVAILABLE) return judged;
    session.notifyUnavailable(session.ctx);
    return "judge unavailable";
  } catch {
    session.pi.logger.warn("judge-dispatch judgment failed; preserving the original route");
    return signal.aborted ? "timed out" : "judge failed";
  }
}

/** Turn a judgment into the task-call rewrite, recording the model decision its spawn hook will apply. */
function routeChoice(
  route: ParsedTaskRoute,
  judged: RouteOutcome,
  config: JudgeDispatchSettings,
  candidates: readonly RoutingCandidate[],
  pending: PendingSpawnRoutes,
): RouteChoice | undefined {
  if (typeof judged === "string") return undefined;
  const choice: RouteChoice = {
    ...(judged.agent ? { agent: judged.agent, agentConfidence: judged.agentConfidence } : {}),
    ...(config.judgeEffort && judged.difficulty
      ? { effort: DIFFICULTY_EFFORT[judged.difficulty], effortConfidence: judged.difficultyConfidence }
      : {}),
  };
  if (!config.selectModel || route.explicitModel !== undefined) return choice;

  const agent = judged.agent ?? route.requestedAgent ?? DEFAULT_SPAWN_AGENT;
  const pool = candidates.find((candidate) => candidate.name === agent)?.model.pool ?? [];
  // Without a confident difficulty, select as for the hardest work so the budget never trades down on a guess.
  const difficulty = judged.difficulty ?? "demanding";
  const model = selectSpawnModel({
    pool,
    difficulty,
    budget: config.modelBudget,
    pick: config.modelPick,
    providerWeights: config.providerWeights,
    ...(judged.modelFit ? { fit: judged.modelFit } : {}),
  });
  if (!model) return choice;
  choice.model = model;
  const chosen = model.chosen;
  if (!chosen || chosen.key === model.primary) return choice;

  const name = route.name ?? `${agent}-${crypto.randomUUID().slice(0, 8)}`;
  if (!route.name) choice.name = name;
  pending.add(name, {
    agent,
    primary: model.primary,
    patterns: [chosen.pattern, ...pool.filter((option) => option.key !== chosen.key).map((option) => option.pattern)],
    note: `judge-dispatch ${config.modelPick} pick, ${config.modelBudget} budget, ${difficulty} task: intelligence ${chosen.intelligence}, $${chosen.blendedPrice.toFixed(2)}/M blended`,
  });
  return choice;
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

/** Resolve a pinned target to the patterns its spawn receives, refusing one the host would not resolve as pinned. */
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
  "judge-dispatch: when the user asks to run a subagent on a specific OMP model role or model rather than its agent's own, write that task item's agent as `<agent>@<model role>` (for example `scout@smol`) or `<agent>@<provider>/<model>`. The judge then still routes the agent and effort, never the model. judge-dispatch rewrites the call before it runs, and OMP keeps that rewrite in place of your call: it then shows the bare agent and a name ending in `_jd` plus 12 hex digits (built from the item's name, or its agent when unnamed). That rewrite is the pin taking effect, not a mistake, so never re-dispatch because of it. Address the child by the id the task result returns. To rerun a pinned task, write the pin in its agent again. A pin that cannot apply refuses the call with the reason.";

export default function judgeDispatch(pi: ExtensionAPI): void {
  const notifyUnavailable = unavailableNotifier(pi);
  registerLegacyRouteRecords(pi);
  const pendingBySession = new WeakMap<object, PendingSpawnRoutes>();
  const pendingFor = (ctx: ExtensionContext): PendingSpawnRoutes => {
    let pending = pendingBySession.get(ctx.sessionManager);
    if (!pending) {
      pending = new PendingSpawnRoutes();
      pendingBySession.set(ctx.sessionManager, pending);
    }
    return pending;
  };
  const claims = new ExplicitSpawnClaims();

  pi.on("before_agent_start", (event) => {
    if (!pi.getActiveTools().includes("task")) return undefined;
    return { systemPrompt: [...event.systemPrompt, PIN_GUIDANCE] };
  });

  pi.on("tool_execution_end", (event) => {
    if (event.toolName !== "task") return;
    const result: unknown = event.result;
    const details = result && typeof result === "object" && "details" in result ? result.details : undefined;
    // Background jobs spawn after this result and consume their claims then; any other settled call already spawned every child it will.
    if (details && typeof details === "object" && "async" in details && details.async) return;
    claims.settle(event.toolCallId);
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
      const config = await effectivePluginSettings(ctx.cwd);
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
      return await withRoutingDeadline(deadlineMs, async (signal) => {
        if (!routes) return undefined;
        const candidates = await discoverCandidates(ctx, settings, legalNames);
        signal.throwIfAborted();
        const judged = routes;
        const session: RoutingSession = {
          pi,
          ctx,
          config,
          judge: sessionJudge(ctx, settings),
          notifyUnavailable,
          beforeJudge() {
            // A judgment that starts after the deadline would set a message the finally block already restored.
            if (!config.indicator || working || signal.aborted) return;
            working = true;
            setRoutingWorkingMessage(pi, ctx, `judge-dispatch: routing ${judged.length} ${judged.length === 1 ? "task" : "tasks"}…`);
          },
        };
        const outcomes = await Promise.all(judged.map((route) => judgeRouteFailOpen(session, route, candidates, signal)));
        signal.throwIfAborted();
        const pending = pendingFor(ctx);
        const choices = judged.map((route, index) => routeChoice(route, outcomes[index] as RouteOutcome, config, candidates, pending));
        const rewritten = rewriteTaskRoutes(named, judged, choices);
        if (indicator) showRouteOutcomes(pi, ctx, named, judged, outcomes, choices);
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
      const route = pendingFor(ctx).take(event.spawnKey, event.agent);
      if (!route) return undefined;
      // The pool was flattened at `tool_call`; skip it if the host now resolves a different primary.
      const primary = event.patterns[0] ? modelOption(event.patterns[0], scopedSettings(ctx), ctx) : undefined;
      if (primary?.key !== route.primary) return undefined;
      return { model: route.patterns, note: route.note };
    } catch (error) {
      if (explicit)
        return { block: true, reason: `Task ${event.spawnKey} could not apply its pinned ${explicit.target}: ${errorMessage(error)}` };
      pi.logger.warn("judge-dispatch model selection failed open", { error: errorMessage(error) });
      return undefined;
    }
  });
}

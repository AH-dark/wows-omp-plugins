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
  ExplicitModelBindings,
  type ExplicitModelSource,
  ExplicitSpawnClaims,
  type ExplicitSpawnModel,
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
  const modelOptions = config.selectModel && !route.modelPinned ? modelCriteria(candidates) : {};
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
  if (route.modelPinned && route.name && !route.explicitModel) pending.add(route.name, null);
  if (typeof judged === "string") return undefined;
  const choice: RouteChoice = {
    ...(judged.agent ? { agent: judged.agent, agentConfidence: judged.agentConfidence } : {}),
    ...(config.judgeEffort && judged.difficulty
      ? { effort: DIFFICULTY_EFFORT[judged.difficulty], effortConfidence: judged.difficultyConfidence }
      : {}),
  };
  if (!config.selectModel || route.modelPinned) return choice;

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

/** Resolve a binding to the patterns its spawn receives, refusing a target the host would not resolve as bound. */
function explicitSpawnModel(source: ExplicitModelSource, ctx: ExtensionContext): ExplicitSpawnModel & { target: string } {
  const settings = scopedSettings(ctx);
  const role = "role" in source ? source.role : undefined;
  const target = "role" in source ? `@${source.role}` : source.model;
  if (role !== undefined && resolveExplicitModelRole(target, settings) !== role) throw new Error(`Unknown model role ${target}`);
  // A role alias here would expand to that role's selectors and then take the default chain instead of the role's own.
  if (role === undefined && (!target.includes("/") || target.startsWith("@") || target.startsWith("pi/") || target.includes(","))) {
    throw new Error("A concrete model must be a single provider/model selector, not a role alias or list");
  }
  const selectors = resolveConfiguredModelPatterns(target, settings);
  if (selectors.length === 0) throw new Error(`No models configured for ${target}`);

  const chains = readHostSetting(settings, "retry.fallbackChains") as Record<string, unknown>;
  const chain = (role === undefined ? undefined : chains[role]) ?? chains.default ?? [];
  if (!Array.isArray(chain) || !chain.every((entry): entry is string => typeof entry === "string")) {
    throw new Error(`Invalid fallback chain for ${target}`);
  }
  if (chain.some((entry) => entry.endsWith("/*"))) throw new Error("Provider wildcard fallback chains cannot be applied per task");
  // Match the spawn-time lookup: disabled providers leave the registry before any selector resolves.
  const disabled = disabledProviderIds(settings);
  const enabled = ctx.modelRegistry.getAvailable().filter((model) => !disabled.has(model.provider));
  // A concrete model must resolve itself; a role may resolve through its own fallback chain.
  if (!resolveModelOverride(role === undefined ? selectors : [...selectors, ...chain], { getAvailable: () => enabled }, settings).model) {
    throw new Error(`No enabled model resolves for ${target}`);
  }
  return {
    patterns: [...selectors, ...chain],
    note: `judge-dispatch explicit ${role === undefined ? "model" : "role"} ${target}`,
    role: role !== undefined,
    target,
  };
}

/** Task name a `judge_dispatch_model` call targets, called directly or through its `xd://` device. */
function bindCallTarget(toolName: string, args: object): string | undefined {
  if (toolName === "judge_dispatch_model") return "name" in args && typeof args.name === "string" ? args.name : undefined;
  if (toolName !== "write" || !("path" in args) || args.path !== "xd://judge_dispatch_model") return undefined;
  if (!("content" in args) || typeof args.content !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(args.content);
    return parsed && typeof parsed === "object" && "name" in parsed && typeof parsed.name === "string" ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}

function prometheusExecuting(ctx: ExtensionContext): boolean {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type !== "custom" || entry.customType !== "wows-omp-omo-prometheus.state") continue;
    const phase = (entry.data as { phase?: unknown } | undefined)?.phase;
    if (phase === "idle" || phase === "planning") return false;
    if (phase === "executing") return true;
  }
  return false;
}

/** Whether a tool call's result is on the active branch, so state that call created belongs to this conversation path. */
function toolResultOnBranch(ctx: ExtensionContext, toolCallId: string): boolean {
  return ctx.sessionManager
    .getBranch()
    .some((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === toolCallId);
}

export default function judgeDispatch(pi: ExtensionAPI): void {
  const notifyUnavailable = unavailableNotifier(pi);
  registerLegacyRouteRecords(pi);
  // One state per session id for the life of the process: switching back to a session finds its bindings again.
  const statesByManager = new WeakMap<object, Map<string, { pending: PendingSpawnRoutes; bindings: ExplicitModelBindings }>>();
  const stateFor = (ctx: ExtensionContext) => {
    let states = statesByManager.get(ctx.sessionManager);
    if (!states) {
      states = new Map();
      statesByManager.set(ctx.sessionManager, states);
    }
    const sessionId = ctx.sessionManager.getSessionId();
    let state = states.get(sessionId);
    if (!state) {
      state = { pending: new PendingSpawnRoutes(), bindings: new ExplicitModelBindings() };
      states.set(sessionId, state);
    }
    return state;
  };
  const pendingFor = (ctx: ExtensionContext): PendingSpawnRoutes => stateFor(ctx).pending;
  const bindingsFor = (ctx: ExtensionContext): ExplicitModelBindings => stateFor(ctx).bindings;
  const claims = new ExplicitSpawnClaims();

  const bindParameters = pi.typebox.Type.Object({
    name: pi.typebox.Type.String({ description: "Exact name of one future task item, without dots" }),
    op: pi.typebox.Type.Optional(pi.typebox.Type.Union([pi.typebox.Type.Literal("bind"), pi.typebox.Type.Literal("clear")])),
    role: pi.typebox.Type.Optional(pi.typebox.Type.String({ description: "OMP model role, e.g. abliterated" })),
    model: pi.typebox.Type.Optional(pi.typebox.Type.String({ description: "Concrete provider/model selector, alternative to role" })),
  });
  pi.registerTool({
    name: "judge_dispatch_model",
    label: "Bind task model",
    description:
      "Bind the next task item with an exact name to an explicit OMP model role or concrete provider/model, or clear a binding no task has used yet. Call it on its own and wait for its result, then dispatch the task in a later tool round: a task in the same round as its binding call is refused. The bound item runs under a unique spawn name derived from its name. The judge still routes agent and effort, but not this task's model.",
    parameters: bindParameters,
    async execute(id, params: { name: string; op?: "bind" | "clear"; role?: string; model?: string }, _signal, _onUpdate, ctx) {
      const name = params.name.trim();
      const role = params.role?.trim().replace(/^@/, "");
      const model = params.model?.trim();
      try {
        if (!name || name.includes(".")) throw new Error("Provide a nonempty task name without dots");
        const bindings = bindingsFor(ctx);
        if (params.op === "clear") {
          if (role || model) throw new Error("Clear accepts only the task name");
          if (bindings.clear(name)) return { content: [{ type: "text", text: `Cleared model binding for ${name}` }] };
          const text = claims.awaiting(bindings, name)
            ? `No model binding pending for ${name}; the task already dispatched with it has not started and keeps its explicit model when it starts. If that task failed or was cancelled, bind ${name} again`
            : `No model binding pending for ${name}`;
          return { content: [{ type: "text", text }] };
        }
        const source: ExplicitModelSource | undefined = role ? { role } : model ? { model } : undefined;
        if (!source || (role && model)) throw new Error("Provide exactly one of role or model");
        if (prometheusExecuting(ctx)) throw new Error("Explicit model bindings are unavailable while an approved Prometheus plan executes");
        const { target } = explicitSpawnModel(source, ctx);
        const existing = bindings.requested(name);
        // A binding made on a branch this conversation has left belongs to that branch; binding again here replaces it.
        if (existing && !toolResultOnBranch(ctx, existing.callId)) bindings.clear(name);
        const refusal = bindings.bind(name, { source, callId: id });
        if (refusal) throw new Error(refusal);
        return {
          content: [
            {
              type: "text",
              text: `Bound task ${name} to ${target}. Now dispatch exactly one task item named ${name}, in a later tool round than this call, and keep that name as is. judge-dispatch automatically appends a unique suffix to the name the child actually spawns under (${name}_jd…), so the child id the task result returns differs from ${name}; that suffix confirms the binding was applied. Refer to the child by the returned id.`,
            },
          ],
        };
      } catch (error) {
        return { content: [{ type: "text", text: errorMessage(error) }], isError: true };
      }
    },
  });

  // Every tool_call hook of a message runs before its tools execute, so this is the one point that sees a bind and a task of the same round together.
  pi.on("assistant_message", (event, ctx) => {
    const targets = event.message.content.flatMap((block) => {
      if (block.type !== "toolCall") return [];
      const target = bindCallTarget(block.name, block.arguments);
      return target === undefined ? [] : [target];
    });
    bindingsFor(ctx).startRound(targets);
    return undefined;
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
    const bindTarget = bindCallTarget(event.toolName, event.input);
    if (bindTarget !== undefined) {
      bindingsFor(ctx).announce(bindTarget);
      return undefined;
    }
    if (event.toolName !== "task") return undefined;
    let working = false;
    let indicator = false;
    let unclaimed = false;
    // Once a bound item is renamed to its claim's spawn name, every outcome must keep that name.
    let keep: { input: Record<string, unknown> } | undefined;
    try {
      if (prometheusExecuting(ctx)) return undefined;
      const input = event.input as Record<string, unknown>;
      const bindings = bindingsFor(ctx);
      const rawItems: unknown[] = Array.isArray(input.tasks) ? input.tasks : [input];
      const names: string[] = [];
      for (const item of rawItems) {
        if (!item || typeof item !== "object" || !("name" in item) || typeof item.name !== "string") continue;
        const name = item.name.trim();
        if (name) names.push(name);
      }
      for (const name of names) {
        let reason = bindings.dispatchConflict(name);
        if (!reason && claims.reserved(name)) {
          reason = `Task name ${name} is the spawn name of a task dispatched with an explicit model; use another name`;
        }
        // The binding moved to a dispatched task whose child has not started; an unbound retry would silently drop it.
        if (!reason && !bindings.requested(name) && claims.awaiting(bindings, name)) {
          reason = `Task ${name} was dispatched with an explicit model that has not started; if that background task failed or was cancelled, call judge_dispatch_model for ${name} again, otherwise wait for it to start or use another name`;
        }
        if (reason) return { block: true, reason };
      }
      const parsed = parseTaskInput(input);
      if (!parsed && names.some((name) => bindings.requested(name))) {
        return {
          block: true,
          reason:
            "judge-dispatch cannot read this task call, so its explicit model binding was not applied and stays pending; resend it in the documented task shape",
        };
      }
      const bound = (parsed ?? []).flatMap((route) => {
        const binding = route.name ? bindings.requested(route.name) : undefined;
        return route.name && binding ? [{ route, name: route.name, binding }] : [];
      });
      unclaimed = bound.length > 0;
      const foreign = bound.find(({ binding }) => !toolResultOnBranch(ctx, binding.callId));
      if (foreign) {
        return {
          block: true,
          reason: `The model binding for ${foreign.name} was made on another branch of this session and does not apply here; call judge_dispatch_model for ${foreign.name} on this branch, or clear it`,
        };
      }
      const explicit = bound.map(({ route, name, binding }) => {
        if (names.filter((other) => other === name).length !== 1) {
          throw new Error(`Explicitly bound task name ${name} must be unique in the call`);
        }
        if (route.modelPinned || (route.requestedAgent && isWorkflowOwnedAgent(route.requestedAgent))) {
          throw new Error(`Cannot apply explicit model to workflow-owned or already pinned task ${name}`);
        }
        return { route, name, binding, model: explicitSpawnModel(binding.source, ctx) };
      });
      const spawnNames = claims.claim(bindings, event.toolCallId, explicit);
      const routes = parsed?.map((route) => {
        const item = explicit.find((candidate) => candidate.route === route);
        return item ? { ...route, modelPinned: true, explicitModel: item.model.target } : route;
      });
      const named = routes
        ? rewriteTaskRoutes(
            input,
            routes,
            routes.map((route) => {
              const at = explicit.findIndex((item) => item.route.index === route.index);
              return at < 0 ? undefined : { spawnName: spawnNames[at] };
            }),
          )
        : input;
      if (explicit.length > 0 && named === input) {
        claims.settle(event.toolCallId);
        throw new Error("the bound task item could not be renamed to its spawn name");
      }
      unclaimed = false;
      bindings.dispatched(names.filter((name) => !explicit.some((item) => item.name === name)));
      if (named !== input) keep = { input: named };
      const config = await effectivePluginSettings(ctx.cwd);
      indicator = config.indicator;
      const settings = scopedSettings(ctx);
      const deadlineMs = routingDeadlineMs(readHostSetting(settings, "extensionHandlers.toolCallTimeoutMs"));
      if (deadlineMs === undefined) {
        if (indicator) showRoutingStatus(pi, ctx, "kept the requested agent: extensionHandlers.toolCallTimeoutMs leaves no time to judge");
        return keep;
      }
      const taskTool = pi.getAllTools().find((tool) => tool.name === "task");
      const legalNames = taskTool ? parseLegalAgentNames(taskTool.description) : undefined;
      if (!legalNames?.length) {
        if (indicator) showRoutingStatus(pi, ctx, "kept the requested agent: the task tool lists no agents to route between");
        return keep;
      }
      return await withRoutingDeadline(deadlineMs, async (signal) => {
        if (!routes) return undefined;
        const candidates = await discoverCandidates(ctx, settings, legalNames);
        signal.throwIfAborted();
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
            setRoutingWorkingMessage(pi, ctx, `judge-dispatch: routing ${routes.length} ${routes.length === 1 ? "task" : "tasks"}…`);
          },
        };
        const outcomes = await Promise.all(routes.map((route) => judgeRouteFailOpen(session, route, candidates, signal)));
        signal.throwIfAborted();
        const pending = pendingFor(ctx);
        const choices = routes.map((route, index) => routeChoice(route, outcomes[index] as RouteOutcome, config, candidates, pending));
        const rewritten = rewriteTaskRoutes(named, routes, choices);
        if (indicator) showRouteOutcomes(pi, ctx, named, routes, outcomes, choices);
        return rewritten === input ? undefined : { input: rewritten };
      });
    } catch (error) {
      // Failing open before the claim would start a bound task on its original model.
      if (unclaimed) {
        return {
          block: true,
          reason: `Explicit task model binding failed: ${errorMessage(error)}. The binding stays pending; fix the call, or remove the binding with judge_dispatch_model op "clear"`,
        };
      }
      pi.logger.warn("judge-dispatch task interception failed open", { error: errorMessage(error) });
      if (indicator) {
        const timedOut = error instanceof DOMException && error.name === "TimeoutError";
        showRoutingStatus(pi, ctx, `kept the requested agent: routing ${timedOut ? "timed out" : "failed"}`);
      }
      return keep;
    } finally {
      if (working) setRoutingWorkingMessage(pi, ctx);
    }
  });

  pi.on("before_subagent_spawn", async (event, ctx) => {
    if (event.invocationKind !== "task" || !event.spawnKey) return undefined;
    let explicit: ExplicitSpawnModel | undefined;
    try {
      explicit = claims.take(event.spawnKey);
      if (explicit) {
        if (prometheusExecuting(ctx)) {
          return {
            block: true,
            reason: `Task ${event.spawnKey} was dispatched with an explicit model before the approved Prometheus plan started executing, so it was not started; dispatch it again after execution ends`,
          };
        }
        // One pattern inherits the original role's chain (or default) at spawn; an explicitly empty target chain must not.
        if (explicit.role && explicit.patterns.length === 1) {
          const chains = readHostSetting(scopedSettings(ctx), "retry.fallbackChains") as Record<string, unknown>;
          const inherited = (event.modelRole ? chains[event.modelRole] : undefined) ?? chains.default;
          if (Array.isArray(inherited) && inherited.length > 0) {
            return {
              block: true,
              reason: "Cannot override a role with an empty fallback chain while the original agent inherits a different chain",
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
      if (explicit) return { block: true, reason: `Explicit task model binding failed at spawn: ${errorMessage(error)}` };
      pi.logger.warn("judge-dispatch model selection failed open", { error: errorMessage(error) });
      return undefined;
    }
  });
}

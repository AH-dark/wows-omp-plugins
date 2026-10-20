import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import { ADR_INSTALL_HINT, type AdrApi, type AdrConnection, type ContractEvents } from "#src/adr.ts";
import { type AtlasStagePlan, requestPlans, stageCoverage } from "#src/atlas.ts";
import { check, type Diagnostics } from "#src/check.ts";
import { loadAll, loadRepo, type Model, overdue, type Repo, renderRound, renderStage, type StageDoc, today } from "#src/documents.ts";
import { discoverRepo } from "#src/git.ts";
import { planLabel, renderHandoff, renderInjection } from "#src/handoff.ts";
import { withRepoLock } from "#src/numbering.ts";
import {
  type Actor,
  applyPrepared,
  type PreparedOperation,
  prepareInit,
  prepareRoundOpen,
  prepareRoundPlan,
  type Receipt,
  recordFreeWork,
  stage,
  todo,
  upgrade,
} from "#src/operations.ts";
import { type ArmedKind, actor, planModeActive, type RoadmapSession, type UiFactory } from "#src/ses.ts";
import { stageReadiness } from "#src/state.ts";
import type { OverlapAnswer } from "#src/ui.ts";

export type ToolReceipt = Receipt & { answer?: OverlapAnswer; diagnostics?: Diagnostics[]; changedFiles?: string[] };

/** Asks omo-prometheus for the repository's Atlas plans, optionally for one stage; undefined when nothing answered. */
export type PlanLookup = (stage?: string) => AtlasStagePlan[] | undefined;

export function planLookup(events: ContractEvents, ctx: ExtensionContext, repoRoot: string): PlanLookup {
  return (stage) =>
    requestPlans(events, { sessionId: ctx.sessionManager.getSessionId(), repoRoot, ...(stage === undefined ? {} : { stage }) });
}

/**
 * The Atlas guard admits roadmap tools only from this path, so every tool declares it explicitly: the host
 * otherwise records the unresolved node_modules symlink, while `import.meta.url` is the cached copy's realpath.
 */
export const TOOL_SOURCE_PATH = fileURLToPath(new URL("./index.ts", import.meta.url));

export function toolResult(receipt: ToolReceipt) {
  const text = receipt.ok
    ? [
        receipt.summary,
        ...receipt.warnings.map((warning) => `Warning: ${warning}`),
        receipt.handoff,
        receipt.changedFiles.length
          ? `Changed: ${receipt.changedFiles.join(", ")}. Commit these files per the project's rules.`
          : undefined,
      ]
        .filter(Boolean)
        .join("\n\n")
    : [receipt.reason, ...receipt.hints].join("\n");
  return { content: [{ type: "text" as const, text }], details: receipt, isError: !receipt.ok };
}

/** The repository with this session's ADR service attached, so reads include docs/adr through the adr plugin. */
export async function requireRepo(ctx: ExtensionContext, adr: AdrApi, initialize = false): Promise<Repo> {
  const git = discoverRepo(ctx.cwd);
  if (!git) throw new Error("Roadmap requires a git work tree.");
  if (initialize) return { ...git, roadmapDir: join(git.repoRoot, "docs/roadmap"), adrDir: join(git.repoRoot, "docs/adr"), adr };
  const repo = await loadRepo(git.repoRoot);
  if (!repo) throw new Error("Roadmap is not initialized in this repository. Use /init-project first.");
  return { ...repo, adr };
}

export async function statusReceipt(repo: Repo, id?: string, plans?: PlanLookup): Promise<Receipt> {
  const model = await loadAll(repo);
  const on = today();
  if (id?.startsWith("R")) {
    const round = model.rounds.find((round) => round.id === id);
    if (!round) return { ok: false, reason: `Unknown round ${id}.`, hints: [] };
    return {
      ok: true,
      summary: `${renderRound(round)}${overdue(round, on) ? "\nOverdue: this unfinished round is past its target.\n" : ""}`,
      changedFiles: [],
      warnings: [],
    };
  }
  if (id) {
    const current = model.stages.find((candidate) => candidate.id === id);
    if (!current) return { ok: false, reason: `Unknown stage ${id}.`, hints: ["Call roadmap_status for stage ids."] };
    return {
      ok: true,
      summary: renderStage(current),
      handoff: renderHandoff(model, current, on, plans?.(current.id)),
      changedFiles: [],
      warnings: [],
    };
  }
  const open = model.todos.flatMap((doc) => doc.items.filter((item) => item.status === "open"));
  const readiness = model.stages
    .filter((current) => current.status === "planned")
    .flatMap((current) => {
      const ready = stageReadiness(model, current);
      if (ready.startable) return [`- ${current.id} startable`];
      return ready.blockedBy.length ? [`- ${current.id} blocked by ${ready.blockedBy.join(", ")}`] : [];
    });
  const summary = [
    model.index.title,
    renderInjection(model) || "No active round. ADR management remains available.",
    "Rounds (target versus actual):",
    ...model.rounds.map(
      (round) =>
        `- ${round.id} [${round.status}] ${round.title} — target ${round.target ?? "none"}; opened ${round.opened ?? "—"}; closed ${round.closed ?? "—"}${overdue(round, on) ? "; overdue" : ""}; ${model.stages.filter((stage) => stage.round === round.id).length} stages`,
    ),
    "Stages:",
    ...model.stages.map(
      (current) =>
        `- ${current.id} [${current.status}] ${current.title} (${current.round})${current.target ? ` — target ${current.target}${overdue(current, on) ? "; overdue" : ""}` : ""}; started ${current.started ?? "—"}; closed ${current.closed ?? "—"}${current.depends_on.length ? `; depends on ${current.depends_on.join(", ")}` : ""}`,
    ),
  ];
  if (readiness.length) summary.push("Readiness of planned stages in the active round:", ...readiness);
  const answered = plans?.();
  if (answered) {
    // Plans of unclosed stages only: closed and dropped stages no longer take plan work.
    const lines = model.stages
      .filter((current) => current.status === "planned" || current.status === "active")
      .flatMap((current) => {
        const bound = answered.filter((plan) => plan.stage === current.id);
        const drifted = stageCoverage(current, bound).drifted;
        return bound.map(
          (plan) =>
            `- ${current.id} · ${planLabel(plan)} — ${plan.status}, ${plan.done}/${plan.total} rows; ${plan.criteria ? `criteria ${plan.criteria.join(", ")}` : "coverage undeclared"}${drifted.includes(plan) ? `; drift: approved before ${current.id}'s objective, scope, criteria or design constraints changed` : ""}`,
        );
      });
    summary.push("Atlas plans of unclosed stages:", ...(lines.length ? lines : ["- None."]));
  }
  summary.push(
    "Open TODOs by target or trigger:",
    ...open.map((item) => `- ${item.id} [${item.severity}] ${item.target ?? item.trigger}: ${item.title}`),
  );
  return {
    ok: true,
    summary: summary.join("\n"),
    changedFiles: [],
    warnings: (model.parseErrors ?? []).map((issue) => `${issue.path}: ${issue.message}`),
  };
}

export async function checkReceipt(repo: Repo, fix = false, signal?: AbortSignal): Promise<ToolReceipt> {
  const model = await loadAll(repo);
  const writtenFiles = new Set<string>();
  const diagnostics = await check(model, { fix, signal, changedFiles: writtenFiles });
  const changedFiles = [...writtenFiles];
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  const lines = diagnostics.map((diagnostic) => `${diagnostic.severity}: ${diagnostic.rule} — ${diagnostic.path}: ${diagnostic.message}`);
  if (errors.length) {
    const hints = ["Check verifies document consistency, not code/document drift."];
    const cancelled = errors.some((diagnostic) => diagnostic.rule === "cancelled");
    if (cancelled) {
      hints.push(
        changedFiles.length
          ? `Files committed by the interrupted fix: ${changedFiles.join(", ")}. Commit these files per the project's rules.`
          : "No files were committed by the interrupted fix.",
        "Run roadmap_check with fix: true again to finish regenerating eligible generated blocks, then run roadmap_check to verify consistency.",
      );
    } else if (changedFiles.length) hints.push(`Regenerated: ${changedFiles.join(", ")}. Commit these files per the project's rules.`);
    return { ok: false, reason: lines.join("\n"), hints, diagnostics, ...(cancelled ? { changedFiles } : {}) };
  }
  return {
    ok: true,
    summary: `${fix ? "Regenerated eligible generated blocks. " : ""}Roadmap check passed. Check verifies document consistency, not code/document drift.`,
    changedFiles,
    warnings: lines,
    diagnostics,
  };
}

export interface OverlapRequest {
  ses: RoadmapSession;
  ctx: ExtensionContext;
  repo: Repo;
  owner: Actor;
  generation: number;
  stage: string;
  intent: string;
  signal?: AbortSignal;
  /** Atlas plans for the handoff; omitted when the caller has no event bus to ask. */
  plans?: PlanLookup;
  /** Asked only when this session is not bound to the stage and has no stored answer for it. */
  ask(stage: StageDoc): Promise<OverlapAnswer | undefined>;
}

/** Applies the user's overlap answer (from the dialog or `/roadmap overlap`) once per stage and session. */
export async function resolveOverlap(request: OverlapRequest): Promise<ToolReceipt> {
  const { ses, ctx, repo, owner, generation, signal } = request;
  const planning = planModeActive(ctx);
  const stale = (): ToolReceipt => ({
    ok: false,
    reason: "Roadmap overlap answer is stale: the session or stage changed while the answer was pending.",
    hints: ["Call roadmap_overlap again to review the current session and stage."],
  });
  const model = await loadAll(repo);
  if (!ses.isCurrent(ctx, generation)) return stale();
  ses.validateBinding(ctx, repo.repoRoot, model);
  const current = model.stages.find((candidate) => candidate.id === request.stage);
  const roundId = current?.round;
  if (
    !current ||
    (current.status !== "planned" && current.status !== "active") ||
    !model.rounds.some((candidate) => candidate.id === roundId && candidate.status === "active")
  ) {
    return { ok: false, reason: `${request.stage} is not an unclosed stage in an active round.`, hints: [] };
  }
  let stored = ses.overlapAnswer(ctx, repo.repoRoot, current.id);
  let answer = stored;
  const boundAtStart = ses.getBinding(repo.repoRoot)?.stage === current.id;
  // Plan mode binds a planned stage without starting it; answering roadmap again outside plan mode starts it.
  const startBound = boundAtStart && current.status === "planned" && !planning;
  // This session's binding answers for itself, ahead of an earlier free or unrelated answer.
  if (boundAtStart) answer = "roadmap";
  else if (!stored) answer = await request.ask(current);
  const guard = (latest: Model): ToolReceipt | undefined => {
    if (signal?.aborted) return { ok: false, reason: "Roadmap overlap cancelled.", hints: [] };
    if (!ses.isCurrent(ctx, generation)) return stale();
    const candidate = latest.stages.find((entry) => entry.id === request.stage);
    if (
      !candidate ||
      candidate.round !== roundId ||
      (candidate.status !== "planned" && candidate.status !== "active") ||
      !latest.rounds.some((entry) => entry.id === roundId && entry.status === "active")
    )
      return stale();
    ses.validateBinding(ctx, repo.repoRoot, latest);
    stored = ses.overlapAnswer(ctx, repo.repoRoot, candidate.id);
    answer = stored ?? answer;
    const bound = ses.getBinding(repo.repoRoot)?.stage === candidate.id;
    if (bound && !startBound && (candidate.status === "active" || planning)) {
      answer = "roadmap";
      return {
        ok: true,
        summary: `This session is already working in-system on ${candidate.id}.`,
        answer,
        handoff: renderHandoff(latest, candidate, today(), request.plans?.(candidate.id)),
        changedFiles: [],
        warnings: [],
      };
    }
    if (bound) answer = "roadmap";
    if (!answer)
      return {
        ok: false,
        reason: "Roadmap overlap: no answer available.",
        hints: [
          "Ask the user before beginning overlapping work.",
          `Without an interactive UI the user answers with /roadmap overlap ${candidate.id} roadmap|free|unrelated [intent]; free work needs the intent.`,
        ],
      };
    if (stored && answer !== "roadmap")
      return { ok: true, summary: `Overlap answer for ${candidate.id}: ${answer}.`, answer, changedFiles: [], warnings: [] };
  };
  const onSuccess = (): void => {
    if (!ses.isCurrent(ctx, generation) || !answer) return;
    if (answer === "roadmap") ses.bind(ctx, repo.repoRoot, current.id);
    if (!stored) ses.answerOverlap(ctx, repo.repoRoot, current.id, answer);
  };
  let receipt: Receipt;
  if (answer === "free" && !stored)
    receipt = await recordFreeWork(repo, owner, { stage: request.stage, intent: request.intent }, { signal, guard, onSuccess });
  else if (answer === "roadmap")
    receipt = await stage(
      repo,
      owner,
      { action: "start", id: current.id },
      { signal, guard, onSuccess, planning, plans: request.plans?.(current.id) },
    );
  else
    receipt = await withRepoLock(repo, async () => {
      const guarded = guard(await loadAll(repo));
      if (guarded) return guarded;
      onSuccess();
      return { ok: true, summary: `Overlap answer for ${current.id}: ${answer}.`, changedFiles: [], warnings: [] };
    });
  return receipt.ok ? { ...receipt, answer } : receipt;
}

/** A preview no dialog could confirm: held in memory until the user runs `/roadmap confirm <token>`. */
export function awaitConfirmation(
  ses: RoadmapSession,
  ctx: ExtensionContext,
  generation: number,
  kind: ArmedKind,
  repo: Repo,
  prepared: PreparedOperation,
): ToolReceipt {
  const token = ses.holdPreview(ctx, generation, kind, repo, prepared);
  const again =
    kind === "init"
      ? "Call roadmap_init again"
      : kind === "round"
        ? "Call roadmap_round_open again"
        : kind === "plan"
          ? "Call roadmap_round_plan again"
          : `Run /roadmap ${kind} again`;
  return {
    ok: false,
    reason: [
      `${prepared.summary}\nNothing was written: no interactive UI can confirm this preview.`,
      ...prepared.files.map((file) => `--- ${relative(repo.repoRoot, file.path)}\n${file.content}`),
    ].join("\n\n"),
    hints: [
      `Show this preview to the user. The user writes exactly these files with /roadmap confirm ${token}; any other reply declines it.`,
      `${again} only if the user asks for changes; a new preview replaces this one.`,
    ],
  };
}

/** Writes a confirmed preview while the session that armed it is unchanged and still armed. */
export async function applyPreview(
  ses: RoadmapSession,
  ctx: ExtensionContext,
  kind: ArmedKind,
  repo: Repo,
  owner: Actor,
  generation: number,
  prepared: PreparedOperation,
  signal?: AbortSignal,
): Promise<Receipt> {
  const guard = (): Receipt | undefined => {
    if (ctx.sessionManager.getSessionId() !== owner.sessionId || !ses.isCurrent(ctx, generation) || !ses.isArmed(ctx, repo.repoRoot, kind))
      return {
        ok: false,
        reason: `Roadmap authorization changed; run ${kind === "init" ? "/init-project" : `/roadmap ${kind === "round" ? "new-round" : kind === "plan" ? "plan-round" : kind}`} again.`,
        hints: [],
      };
  };
  const stale = guard();
  if (stale) return stale;
  return applyPrepared(repo, owner, prepared, {
    guard,
    signal,
    onSuccess() {
      if (ses.isCurrent(ctx, generation) && ses.isArmed(ctx, repo.repoRoot, kind)) ses.disarm(ctx, repo.repoRoot);
    },
  });
}

/** Refuses a write a dialog answered once the asking session has changed meanwhile. */
export function dialogGuard(ses: RoadmapSession, ctx: ExtensionContext, generation: number): () => Receipt | undefined {
  return () =>
    ses.isCurrent(ctx, generation)
      ? undefined
      : {
          ok: false,
          reason: "The session changed while the upgrade dialog was open; nothing was written.",
          hints: ["Ask the user again."],
        };
}

/** Writes the `/roadmap upgrade` change after a Yes in the one-step upgrade dialog, unless the asking session changed meanwhile. */
export function upgradeAfterDialog(
  ses: RoadmapSession,
  ctx: ExtensionContext,
  repo: Repo,
  generation: number,
  signal?: AbortSignal,
): Promise<Receipt> {
  return upgrade(repo, actor(ctx), { signal, guard: dialogGuard(ses, ctx, generation) });
}

export function registerTools(
  pi: ExtensionAPI,
  ses: RoadmapSession,
  uiFor: UiFactory,
  changed: (ctx: ExtensionContext) => void,
  adr: AdrConnection,
): void {
  const z = pi.zod;
  const overlapFlights = new Map<string, Promise<ToolReceipt>>();
  const criterion = z.object({ id: z.string().optional(), statement: z.string(), verify: z.string() });
  const stageFields = {
    id: z.string().optional(),
    title: z.string(),
    objective: z.string(),
    scope_in: z.array(z.string()),
    scope_out: z.array(z.string()),
    done_criteria: z.array(criterion),
    depends_on: z.array(z.string()).optional(),
    follows: z.string().optional(),
    design_constraints: z.string().optional(),
    risks: z.string().optional(),
  };
  const sections = z.object({
    context: z.string(),
    drivers: z.string().optional(),
    options: z.array(z.string()),
    outcome: z.string(),
    consequences: z.string().optional(),
    confirmation: z.string().optional(),
    pros_cons: z.string().optional(),
    more_info: z.string().optional(),
  });
  const adrFields = {
    id: z.string().optional(),
    title: z.string(),
    status: z.enum(["proposed", "accepted", "rejected", "deprecated"]).optional(),
    stage: z.string().optional(),
    sections,
    decision_makers: z.array(z.string()).optional(),
    consulted: z.array(z.string()).optional(),
    informed: z.array(z.string()).optional(),
  };
  const round = z.object({
    title: z.string(),
    goal: z.string(),
    constraints: z.array(z.string()),
    non_goals: z.array(z.string()),
    principles: z.array(z.object({ text: z.string(), adrs: z.array(z.string()) })),
  });
  const statusParameters = z.object({ stage: z.string().optional() });
  const stageParameters = z.object({
    ...stageFields,
    title: z.string().optional(),
    objective: z.string().optional(),
    scope_in: z.array(z.string()).optional(),
    round: z.string().optional(),
    target: z.string().optional(),
    scope_out: z.array(z.string()).optional(),
    done_criteria: z.array(criterion).optional(),
    action: z.enum(["add", "edit", "amend", "start", "close", "drop", "renumber"]),
    reason: z.string().optional(),
    amendments: z
      .object({
        add: z.array(criterion).optional(),
        modify: z.array(z.object({ id: z.string(), statement: z.string(), verify: z.string() })).optional(),
        remove: z.array(z.string()).optional(),
        scope: z.array(z.object({ op: z.enum(["add", "remove"]), side: z.enum(["in", "out"]), item: z.string() })).optional(),
      })
      .optional(),
    delivered: z.string().optional(),
    deviations: z.string().optional(),
    evidence: z
      .array(
        z.object({
          criterion: z.string(),
          result: z.enum(["pass", "fail"]),
          method: z.string(),
          summary: z.string(),
          commit: z.string().optional(),
        }),
      )
      .optional(),
    todos: z
      .array(
        z.object({
          id: z.string(),
          disposition: z.enum(["resolved", "moved"]),
          target: z.string().optional(),
          reference: z.string().optional(),
        }),
      )
      .optional(),
    new_id: z.string().optional(),
  });
  const todoParameters = z.object({
    action: z.enum(["add", "update", "resolve", "move"]),
    id: z.string().optional(),
    title: z.string().optional(),
    severity: z.enum(["high", "normal", "low"]).optional(),
    source: z.string().optional(),
    target: z.string().optional(),
    trigger: z.string().optional(),
    body: z.string().optional(),
    reference: z.string().optional(),
  });
  const checkParameters = z.object({ fix: z.boolean().optional() });
  const overlapParameters = z.object({ stage: z.string(), intent: z.string() });
  const initParameters = z.object({
    project: z.object({ name: z.string(), description: z.string() }),
    round,
    adrs: z.array(z.object(adrFields)),
    stages: z.array(z.object(stageFields)),
  });
  const roundParameters = z.object({ round: round.optional(), import_todos: z.array(z.string()), activate: z.string().optional() });
  const planParameters = z.object({ id: z.string().optional(), round, target: z.string().optional() });
  const upgradeParameters = z.object({});

  async function run(ctx: ExtensionContext, operation: (repo: Repo, owner: Actor) => Promise<ToolReceipt>, initialize = false) {
    try {
      ses.ensure(ctx);
      const connected = adr.connect(ctx.sessionManager.getSessionId());
      if (!("api" in connected)) return toolResult({ ok: false, reason: connected.reason, hints: [ADR_INSTALL_HINT] });
      return toolResult(await operation(await requireRepo(ctx, connected.api, initialize), actor(ctx)));
    } catch (error) {
      return toolResult({
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
        hints: ["Run roadmap_check to inspect managed files."],
      });
    } finally {
      changed(ctx);
    }
  }

  pi.registerTool({
    name: "roadmap_status",
    sourcePath: TOOL_SOURCE_PATH,
    label: "Roadmap status",
    description: "Read rounds, stages and open TODOs. Supply a stage id for its full document and planning handoff.",
    parameters: statusParameters,
    approval: "read",
    async execute(_id, params: typeof statusParameters.infer, _signal, _onUpdate, ctx) {
      return run(ctx, (repo) => statusReceipt(repo, params.stage, planLookup(pi.events, ctx, repo.repoRoot)));
    },
  });
  pi.registerTool({
    name: "roadmap_stage",
    sourcePath: TOOL_SOURCE_PATH,
    label: "Roadmap stage",
    description:
      "Manage stage lifecycle. Start or join returns the planning handoff and binds this session; in plan mode start binds a planned stage without writing, and it starts when start is called again outside plan mode. Close requires passing evidence for every done criterion and TODO dispositions, refuses while ADRs linked to the stage are proposed, and records still-unfinished linked Atlas plans under the Outcome's Deviations.",
    parameters: stageParameters,
    approval: "write",
    async execute(_id, params: typeof stageParameters.infer, signal, _onUpdate, ctx) {
      const generation = ses.currentGeneration(ctx);
      return run(ctx, (repo, owner) =>
        stage(repo, owner, params, {
          signal,
          planning: params.action === "start" && planModeActive(ctx),
          plans:
            params.id && (params.action === "start" || params.action === "close")
              ? planLookup(pi.events, ctx, repo.repoRoot)(params.id)
              : undefined,
          onSuccess() {
            if (!params.id || !ses.isCurrent(ctx, generation)) return;
            if (params.action === "start") ses.bind(ctx, repo.repoRoot, params.id);
            if (params.action === "close" || params.action === "drop") ses.clearStage(ctx, repo.repoRoot, params.id);
          },
        }),
      );
    },
  });
  pi.registerTool({
    name: "roadmap_todo",
    sourcePath: TOOL_SOURCE_PATH,
    label: "Roadmap TODO",
    description:
      "Add, update, resolve or move carry-over TODOs with a source, severity and an unclosed target stage or trigger. Fix broken tests/builds before proceeding.",
    parameters: todoParameters,
    approval: "write",
    async execute(_id, params: typeof todoParameters.infer, signal, _onUpdate, ctx) {
      return run(ctx, (repo, owner) => todo(repo, owner, params, { signal }));
    },
  });
  pi.registerTool({
    name: "roadmap_check",
    sourcePath: TOOL_SOURCE_PATH,
    label: "Roadmap check",
    description:
      "Check document consistency. fix regenerates eligible generated blocks without changing frozen rounds. Does not compare documents with code.",
    parameters: checkParameters,
    approval: "write",
    async execute(_id, params: typeof checkParameters.infer, signal, _onUpdate, ctx) {
      return run(ctx, (repo) => checkReceipt(repo, params.fix, signal));
    },
  });
  pi.registerTool({
    name: "roadmap_overlap",
    sourcePath: TOOL_SOURCE_PATH,
    label: "Roadmap overlap",
    description:
      "Ask the user once per stage/session whether overlapping work should use the roadmap, be logged as free work, or be treated as unrelated. Subagents do not prompt.",
    parameters: overlapParameters,
    approval: "write",
    async execute(_id, params: typeof overlapParameters.infer, signal, _onUpdate, ctx) {
      if (ctx.agent.kind === "sub")
        return toolResult({ ok: true, summary: "Subagents do not ask overlap questions.", changedFiles: [], warnings: [] });
      const generation = ses.currentGeneration(ctx);
      return run(ctx, (repo, owner) => {
        const key = JSON.stringify([owner.sessionId, repo.repoRoot, params.stage, generation]);
        const pending = overlapFlights.get(key);
        if (pending) return pending;
        const flight = resolveOverlap({
          ses,
          ctx,
          repo,
          owner,
          generation,
          stage: params.stage,
          intent: params.intent,
          signal,
          plans: planLookup(pi.events, ctx, repo.repoRoot),
          ask: (current) => uiFor(ctx).overlap({ stage: current, intent: params.intent }),
        }).finally(() => overlapFlights.delete(key));
        overlapFlights.set(key, flight);
        return flight;
      });
    },
  });
  pi.registerTool({
    name: "roadmap_init",
    sourcePath: TOOL_SOURCE_PATH,
    label: "Initialize Roadmap",
    description:
      "Write the interviewed project, first-round charter, initial ADRs (through the adr plugin) and stages after an exact user-confirmed preview. Only available to the main session armed by /init-project.",
    parameters: initParameters,
    approval: "write",
    async execute(_id, params: typeof initParameters.infer, signal, _onUpdate, ctx) {
      const generation = ses.currentGeneration(ctx);
      return run(
        ctx,
        async (repo, owner) => {
          if (!ses.isArmed(ctx, repo.repoRoot, "init"))
            return { ok: false, reason: "roadmap_init is unarmed. Run /init-project first.", hints: [] };
          const prepared = await prepareInit(repo, owner, params);
          if (!prepared.ok) return prepared;
          const ui = uiFor(ctx);
          if (!ui.interactive) return awaitConfirmation(ses, ctx, generation, "init", repo, prepared.prepared);
          const confirmed = await ui.previewConfirm({ title: prepared.summary, root: repo.repoRoot, files: prepared.files });
          if (confirmed !== true || signal?.aborted)
            return {
              ok: false,
              reason: confirmed === false ? "Initialization preview declined." : "Initialization: no answer available or cancelled.",
              hints: [],
            };
          return applyPreview(ses, ctx, "init", repo, owner, generation, prepared.prepared, signal);
        },
        true,
      );
    },
  });
  pi.registerTool({
    name: "roadmap_round_open",
    sourcePath: TOOL_SOURCE_PATH,
    label: "Open Roadmap round",
    description:
      "Open the next round from its charter and carried TODO ids after a confirmed preview. Only available to the main session armed by /roadmap new-round.",
    parameters: roundParameters,
    approval: "write",
    async execute(_id, params: typeof roundParameters.infer, signal, _onUpdate, ctx) {
      const generation = ses.currentGeneration(ctx);
      return run(ctx, async (repo, owner) => {
        if (!ses.isArmed(ctx, repo.repoRoot, "round"))
          return { ok: false, reason: "roadmap_round_open is unarmed. Run /roadmap new-round first.", hints: [] };
        const prepared = await prepareRoundOpen(repo, owner, params);
        if (!prepared.ok) return prepared;
        const ui = uiFor(ctx);
        if (!ui.interactive) return awaitConfirmation(ses, ctx, generation, "round", repo, prepared.prepared);
        const confirmed = await ui.previewConfirm({ title: prepared.summary, root: repo.repoRoot, files: prepared.files });
        if (confirmed !== true || signal?.aborted)
          return {
            ok: false,
            reason: confirmed === false ? "Round preview declined." : "Round open: no answer available or cancelled.",
            hints: [],
          };
        return applyPreview(ses, ctx, "round", repo, owner, generation, prepared.prepared, signal);
      });
    },
  });
  pi.registerTool({
    name: "roadmap_round_plan",
    sourcePath: TOOL_SOURCE_PATH,
    label: "Plan Roadmap round",
    description:
      "Draft or revise a planned round charter and optional target after a user-confirmed preview. Only available to the main session armed by /roadmap plan-round. The first planned round upgrades format 1 with a warning in the same preview.",
    parameters: planParameters,
    approval: "write",
    async execute(_id, params: typeof planParameters.infer, signal, _onUpdate, ctx) {
      const generation = ses.currentGeneration(ctx);
      return run(ctx, async (repo, owner) => {
        if (!ses.isArmed(ctx, repo.repoRoot, "plan"))
          return { ok: false, reason: "roadmap_round_plan is unarmed. Run /roadmap plan-round first.", hints: [] };
        const prepared = await prepareRoundPlan(repo, owner, params);
        if (!prepared.ok) return prepared;
        const ui = uiFor(ctx);
        if (!ui.interactive) return awaitConfirmation(ses, ctx, generation, "plan", repo, prepared.prepared);
        const confirmed = await ui.previewConfirm({ title: prepared.summary, root: repo.repoRoot, files: prepared.files });
        if (confirmed !== true || signal?.aborted)
          return {
            ok: false,
            reason: confirmed === false ? "Planned round preview declined." : "Planned round: no answer available or cancelled.",
            hints: [],
          };
        return applyPreview(ses, ctx, "plan", repo, owner, generation, prepared.prepared, signal);
      });
    },
  });
  pi.registerTool({
    name: "roadmap_upgrade",
    sourcePath: TOOL_SOURCE_PATH,
    label: "Roadmap upgrade",
    description:
      "Ask the user, in the same one-step dialog shown at session start, whether to upgrade this format-1 repository to roadmap format 2; writes the upgrade only on Yes. Main session only. Without a dialog it refuses: ask the user to run /roadmap upgrade.",
    parameters: upgradeParameters,
    approval: "write",
    async execute(_id, _params: typeof upgradeParameters.infer, signal, _onUpdate, ctx) {
      if (ctx.agent.kind !== "main")
        return toolResult({
          ok: false,
          reason: "roadmap_upgrade asks the user and is available only in the main session.",
          hints: ["Report the format-2 need to the main agent instead."],
        });
      const generation = ses.currentGeneration(ctx);
      return run(ctx, async (repo) => {
        if ((await loadAll(repo)).index.format === 2)
          return { ok: true, summary: "This repository already uses roadmap format 2.", changedFiles: [], warnings: [] };
        const ui = uiFor(ctx);
        if (!ui.interactive)
          return {
            ok: false,
            reason: "No dialog is available to ask about the format-2 upgrade; nothing was written.",
            hints: ["Ask the user to run /roadmap upgrade."],
          };
        const answer = await ui.upgradePrompt("upgrade", signal);
        if (answer === false)
          return { ok: true, summary: "The user kept roadmap format 1; nothing was written.", changedFiles: [], warnings: [] };
        if (answer !== true || signal?.aborted)
          return { ok: false, reason: "Format upgrade: no answer available or cancelled; nothing was written.", hints: [] };
        return upgradeAfterDialog(ses, ctx, repo, generation, signal);
      });
    },
  });
}

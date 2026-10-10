/** Prometheus plans through native approval; Atlas executes shared approved plans. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentSession, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls/local-protocol";
import { cfgPlanEnabled } from "@oh-my-pi/pi-coding-agent/plan-mode/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { cfgTaskIsolationEnabled } from "@oh-my-pi/pi-coding-agent/task/settings";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task/types";
import { isTodoPhase, USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools/todo";

import { AdrContract } from "./adr-contract.ts";
import { parseLegalAgentNames } from "./agents.ts";
import { ATLAS_ASSET, loadPromptAsset, loadRequiredPromptAssets, SKILL_ASSET } from "./assets.ts";
import { runAtlasGit } from "./atlas-git.ts";
import { AtlasLive } from "./atlas-live.ts";
import {
  type AtlasFilter,
  AtlasMenu,
  type AtlasMenuAction,
  AtlasPlanView,
  type AtlasPlanViewAction,
  type AtlasPlanViewMode,
  atlasPlanList,
  atlasPlanText,
  dispatchBlock,
  formatTime,
} from "./atlas-menu.ts";
import { AtlasPlanReferences, atlasPlanUrl } from "./atlas-plan-url.ts";
import { applyAtlasModel, exposeAtlasApprovalTier, registerAtlasModelRole, restoreApprovalTiers } from "./atlas-role.ts";
import { findPlanSessions } from "./atlas-sessions.ts";
import { type AtlasPlan, type AtlasPlanDetail, AtlasStore, deliveryResult, gateResults } from "./atlas-store.ts";
import { retitleForAtlas } from "./atlas-title.ts";
import { atlasTodoRefreshCall, mergeAtlasTodos, syncAtlasTodos } from "./atlas-todo.ts";
import { AtlasStatusWidget, atlasWidgetLines } from "./atlas-widget.ts";
import { ChildEvidence, gateOutputSchema, parseVerifyOutput, verifyOutputSchema } from "./evidence.ts";
import { collectComplianceEvidence, isGitWorkTree } from "./git-evidence.ts";
import { HerdrDagContract } from "./herdr-dag-contract.ts";
import { forceBranchMerge, restoreIsolationMerge } from "./isolation-merge.ts";
import {
  addDeferredFinding,
  addDiscoveredRow,
  addFixRow,
  type ExecutionLedger,
  isComplete,
  type LedgerItem,
  ledgerRows,
  movableRows,
  parsePlanChecklist,
  planDigest,
  recordReceipt,
  recordVerification,
  refreshDispatchAgents,
  renderLedgerSummary,
  reopenRow,
  startRow,
  startVerification,
  triageFinding,
  untriagedFindings,
} from "./ledger.ts";
import { writeLedgerAtomic } from "./ledger-store.ts";
import { PluginStatePublisher } from "./plugin-state.ts";
import { prometheusState } from "./prometheus-state.ts";
import {
  type AtlasCompleted,
  checkRoadmapCriteria,
  isRoadmapStage,
  RoadmapContract,
  type RoadmapStage,
  type RoadmapStageAnswer,
} from "./roadmap-contract.ts";
import {
  ATLAS_USAGE,
  type AtlasCompletionPlan,
  assignedRowIds,
  atlasArgumentCompletions,
  BLOCKED_TOOL_NOTICE,
  blockedToolMessage,
  carriesAtlasAssignment,
  DEFAULT_REVIEW_ROUND_LIMIT,
  EXECUTION_PREAMBLE,
  EXECUTION_START_NOTICE,
  executionBlockReason,
  executionToolSourceBlockReason,
  inlinesApprovedPlan,
  isApprovedPlanHandoff,
  isPlanReviewDispatch,
  isPrometheusOptInConsent,
  isPrometheusOptInQuestion,
  nestedXdevToolCall,
  OPT_IN_ADDENDUM,
  PLANNING_PREAMBLE,
  PLUGIN_OWNED_TOOLS,
  PROMETHEUS_DEEP_OPTION_INDEX,
  PROMETHEUS_OPT_IN_QUESTION_ID,
  parseAtlasCommand,
  parseAtlasSubcommand,
  parsePrometheusCommand,
  parseReviewRoundLimit,
  planReferencesMatch,
  prometheusArtifactUrl,
  proposedPlanPathFromToolResult,
  proposedPlanUrl,
  researchSpawnBlockReason,
  type TrustedToolSources,
  taskSpawnBlockReason,
  trustedToolFamily,
} from "./workflow.ts";

const ACTIVATE_TOOL = "prometheus_activate";
const RELEASE_TOOL = "atlas_release";
const LEDGER_TOOL = "atlas_ledger";
const GIT_TOOL = "atlas_git";
const STATE_ENTRY = "wows-omp-omo-prometheus.state";
const ATLAS_START_TYPE = "wows-omp-omo-prometheus.atlas-start";
const PLANNING_CONTEXT_TYPE = "wows-omp-omo-prometheus.planning-context";
const EXECUTION_CONTEXT_TYPE = "wows-omp-omo-prometheus.execution-context";
const NATIVE_PLAN_CONTEXT_TYPE = "plan-mode-context";
const BLOCK_NOTICE_BURST_MS = 5_000;
const PLAN_MODE_DISABLED =
  "Prometheus needs OMP plan mode, which is turned off in settings. Enable plan mode (plan.enabled), then run /prometheus again.";
const RUNTIME_SOURCE_PATH = fileURLToPath(import.meta.url);
const DEFAULT_PLAN_REFERENCE = "local://PLAN.md";
const PACKAGE_NAME = "wows-omp-plugin-omo-prometheus";
const NON_GIT_PLANNING =
  '<workspace git="none">This workspace is not a Git repository, and this workflow never uses or creates one. Plan without Git: write `Delivery: direct`, give every task `Commit: none (workspace is not a Git repository)`, assign no git, commit or `git init` work, and prove each task by its observed behavior rather than a diff. If the user wants Git, they initialize it themselves before planning.</workspace>';
const NON_GIT_EXECUTION =
  '<workspace git="none">This workspace is not a Git repository, and this workflow never uses or creates one. In every assignment, replace the commit rule with: do not run git, do not commit, and never run `git init`; list changed files in the done-claim instead. Do not call `atlas_git`. Isolation is not required here, and F1 receives no Git evidence.</workspace>';

type ReviewLevel = "off" | "ask" | "standard" | "high-accuracy";

function parseReviewLevel(value: unknown): ReviewLevel {
  if (value === undefined) return "ask";
  if (value === "off" || value === "ask" || value === "standard" || value === "high-accuracy") return value;
  throw new Error(`invalid reviewLevel ${JSON.stringify(value)}`);
}

type DeliverySetting = "ask" | "direct" | "pr" | "ship";

function parseDeliverySetting(value: unknown): DeliverySetting {
  if (value === undefined) return "ask";
  if (value === "ask" || value === "direct" || value === "pr" || value === "ship") return value;
  throw new Error(`invalid delivery ${JSON.stringify(value)}`);
}

type Phase = "idle" | "planning" | "executing";

interface Ownership {
  store: AtlasStore;
  plan: AtlasPlan;
  sessionId: string;
  live: AgentSession;
  parentAgentId: string;
  ledgerId: string;
  detached: boolean;
  operations: number;
  releasing?: Promise<void>;
}

interface SessionRecord {
  phase: Phase;
  /** Canonical path returned by the host's successful xd://propose dispatch. */
  planFilePath?: string;
  /** Exact content observed at the successful native proposal. */
  planSha256?: string;
  /** Tool-call provenance for the proposal that chose planFilePath. */
  proposedByToolCallId?: string;
  roadmapStage?: RoadmapStage;
  /** `mode_change` entry for which native opt-in guidance was already supplied. */
  offerPendingForModeEntryId?: string;
  planningModeEntryId?: string;
  offeredForModeEntryId?: string;
  suppressedForModeEntryId?: string;
  pendingConsent?: { askToolCallId: string; modeEntryId: string };
  proposalAwaitingApproval?: boolean;
  approvalCompactionPending?: boolean;
  /** In-memory, single-use proof that this native compact approval may reset the host reference. */
  compactHandoffPending?: boolean;
  /** Shared pointer only; approval, attempts and proof are owned by AtlasStore. */
  atlasPlanId?: string;
  sourceSessionId?: string;
  ledgerPath?: string;
  ledgerError?: string;
  /** Never persisted: a pathname/session entry cannot grant execution ownership. */
  ownership?: Ownership;
  activation?: object;
  /** In-memory: newest ledger `updatedAt` seen by the last session_stop continuation. */
  lastContinuationLedgerStamp?: number;
  /** In-memory: consecutive session_stop continuations without ledger progress. */
  stallCount: number;
  lastBlockedAt: number;
  /** Plan-review rounds dispatched while planning the current plan, and rounds the user added at the limit. */
  reviewRounds?: ReviewRounds;
}

interface ReviewRounds {
  used: number;
  extra: number;
}

function restoreReviewRounds(value: unknown): ReviewRounds | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { used, extra } = value as { used?: unknown; extra?: unknown };
  const counts = [used, extra].map((n) => (typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : 0));
  return { used: counts[0] ?? 0, extra: counts[1] ?? 0 };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function prometheus(pi: ExtensionAPI): void {
  const records = new Map<string, SessionRecord>();
  const authorizedActivationCalls = new Map<string, string>();
  const reviewLevels = new Map<string, ReviewLevel>();
  const reviewRoundLimits = new Map<string, number>();
  const deliverySettings = new Map<string, DeliverySetting>();
  const atlasWidgets = new Map<string, boolean>();
  const childEvidence = new ChildEvidence();
  /** The latest todo refresh call each session still owes after a ledger row changed; cleared by any non-view todo call. */
  const pendingTodoRefreshes = new Map<string, string>();
  const stores = new Map<string, AtlasStore>();
  const ownerships = new Set<Ownership>();
  const liveModels = new Map<string, AtlasLive>();
  const herdrDag = new HerdrDagContract(pi.events);
  const roadmap = new RoadmapContract(pi.events);
  const adr = new AdrContract(pi.events);
  const WIDGET_KEY = "atlas";
  let stateWarned = false;
  const statePublisher = new PluginStatePublisher("omo-prometheus", (error) => {
    if (stateWarned) return;
    stateWarned = true;
    pi.logger.warn("prometheus could not write its plugin state file", { error: errorMessage(error) });
  });
  /** Last serialized sidecar state per session; an unpublished session counts as `null`. */
  const publishedStates = new Map<string, string>();
  let atlasPlans: AtlasCompletionPlan[] = [];
  let planReferences = new AtlasPlanReferences();
  const hostBindings = new WeakMap<AgentSession, { sessionId: string; planUrl: string; previousReference: string | undefined }>();
  let settlementTimer: NodeJS.Timeout | undefined;
  pi.events.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, (payload) => {
    childEvidence.observe(payload);
    // Wake turns reuse the original dispatch id; retain their exact jobs before history eviction.
    for (const ownership of ownerships) {
      try {
        observeNativeJobs(ownership.sessionId, ownership.live, ownership.parentAgentId);
      } catch (error) {
        pi.logger.warn("Atlas could not observe native child reactivation", { error: errorMessage(error) });
      }
    }
  });

  const loadPlanningSettings = async (ctx: ExtensionContext): Promise<void> => {
    const sessionId = ctx.sessionManager.getSessionId();
    let herdrDagEnabled = true;
    let settings: Record<string, unknown> = {};
    try {
      settings = await getPluginSettings(PACKAGE_NAME, ctx.cwd);
      herdrDagEnabled = settings.herdrDag !== false;
      atlasWidgets.set(sessionId, settings.atlasWidget !== false);
    } catch (error) {
      atlasWidgets.set(sessionId, true);
      pi.logger.warn("prometheus settings could not be read; using defaults", { error: errorMessage(error) });
    }
    try {
      reviewLevels.set(sessionId, parseReviewLevel(settings.reviewLevel));
    } catch (error) {
      reviewLevels.set(sessionId, "ask");
      pi.logger.warn("prometheus reviewLevel is invalid; using ask", { error: errorMessage(error) });
    }
    try {
      reviewRoundLimits.set(sessionId, parseReviewRoundLimit(settings.reviewRoundLimit));
    } catch (error) {
      reviewRoundLimits.set(sessionId, DEFAULT_REVIEW_ROUND_LIMIT);
      pi.logger.warn("prometheus reviewRoundLimit is invalid; using 5", { error: errorMessage(error) });
    }
    try {
      deliverySettings.set(sessionId, parseDeliverySetting(settings.delivery));
    } catch (error) {
      deliverySettings.set(sessionId, "ask");
      pi.logger.warn("prometheus delivery is invalid; using ask", { error: errorMessage(error) });
    }
    if (mainSession(ctx)) herdrDag.configure(sessionId, herdrDagEnabled);
  };

  const notify = (ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void => {
    try {
      ctx.ui.notify(message, type);
    } catch (error) {
      pi.logger.warn("prometheus could not display a notice", { error: errorMessage(error) });
    }
  };

  const commandNotice = (ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void => {
    if (ctx.hasUI) {
      notify(ctx, message, type);
      return;
    }
    pi.sendMessage({
      customType: "wows-omp-omo-prometheus.command-status",
      content: message,
      display: true,
      attribution: "agent",
    });
  };

  /** Prometheus plans inside native plan mode; with plan.enabled off the host refuses /plan and xd://propose never exists. */
  const planModeDisabled = (live: AgentSession): boolean => !cfgPlanEnabled.get(live.settings);

  const mainSession = (ctx: ExtensionContext): AgentSession | undefined => {
    try {
      return (
        AgentRegistry.global()
          .list()
          .find((candidate) => candidate.kind === "main" && candidate.session?.sessionManager === ctx.sessionManager)?.session ?? undefined
      );
    } catch (error) {
      pi.logger.warn("prometheus could not resolve the main session", { error: errorMessage(error) });
      return undefined;
    }
  };

  /**
   * The host appends another `plan` mode_change without leaving plan mode when it restores a resumed session
   * or retargets the plan file at approval, so an episode starts at the first `plan` entry after a non-plan one.
   */
  const planModeEpisodeId = (ctx: ExtensionContext): string | undefined => {
    const branch = ctx.sessionManager.getBranch();
    let episodeId: string | undefined;
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index];
      if (entry?.type !== "mode_change") continue;
      if (entry.mode !== "plan") break;
      episodeId = entry.id;
    }
    return episodeId;
  };

  const recordFor = (sessionId: string): SessionRecord => {
    const existing = records.get(sessionId);
    if (existing) return existing;
    const created: SessionRecord = { phase: "idle", lastBlockedAt: 0, stallCount: 0 };
    records.set(sessionId, created);
    return created;
  };

  const persist = (ctx: ExtensionContext, record: SessionRecord): void => {
    try {
      pi.appendEntry(STATE_ENTRY, {
        version: 3,
        phase: record.phase,
        planningModeEntryId: record.planningModeEntryId,
        planFilePath: record.planFilePath,
        planSha256: record.planSha256,
        proposedByToolCallId: record.proposedByToolCallId,
        atlasPlanId: record.atlasPlanId,
        sourceSessionId: record.sourceSessionId,
        roadmapStage: record.roadmapStage,
        offeredForModeEntryId: record.offeredForModeEntryId,
        suppressedForModeEntryId: record.suppressedForModeEntryId,
        ledgerPath: record.ledgerPath,
        reviewRounds: record.reviewRounds,
      });
    } catch (error) {
      pi.logger.warn("prometheus could not persist workflow state", { error: errorMessage(error) });
    }
    publishState(ctx);
  };

  /** Output-only sidecar for RPC/ACP/SDK clients, derived from the session record and the Herdr DAG snapshot. */
  const publishState = (ctx: ExtensionContext): void => {
    if (!mainSession(ctx)) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const record = records.get(sessionId);
    const detail = liveModels.get(sessionId)?.snapshot.detail;
    const state = prometheusState({
      phase: record?.phase ?? "idle",
      proposalAwaitingApproval: record?.proposalAwaitingApproval,
      planFilePath: record?.planFilePath,
      atlasPlanId: record?.atlasPlanId,
      planName: record?.ownership?.plan.name,
      ledgerError: record?.ledgerError,
      snapshot: herdrDag.snapshot(sessionId),
      delivery: detail?.delivery,
      deferredCount: detail?.deferred?.length,
    });
    const serialized = JSON.stringify(state);
    if ((publishedStates.get(sessionId) ?? "null") === serialized) return;
    publishedStates.set(sessionId, serialized);
    statePublisher.publish(sessionId, state);
  };

  const rehydrate = (ctx: ExtensionContext, force = false): SessionRecord | undefined => {
    if (!mainSession(ctx)) return undefined;
    const sessionId = ctx.sessionManager.getSessionId();
    if (!force && records.has(sessionId)) return records.get(sessionId);
    records.delete(sessionId);
    let restored: SessionRecord | undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
      const data = entry.data as
        | {
            phase?: unknown;
            atlasPlanId?: unknown;
            sourceSessionId?: unknown;
            planFilePath?: unknown;
            planSha256?: unknown;
            planningModeEntryId?: unknown;
            proposedByToolCallId?: unknown;
            offeredForModeEntryId?: unknown;
            suppressedForModeEntryId?: unknown;
            ledgerPath?: unknown;
            roadmapStage?: unknown;
            reviewRounds?: unknown;
          }
        | undefined;
      if (data?.phase !== "idle" && data?.phase !== "planning" && data?.phase !== "executing") continue;
      restored = {
        phase: data.phase,
        atlasPlanId: typeof data.atlasPlanId === "string" && data.atlasPlanId ? data.atlasPlanId : undefined,
        sourceSessionId: typeof data.sourceSessionId === "string" && data.sourceSessionId ? data.sourceSessionId : undefined,
        roadmapStage: isRoadmapStage(data.roadmapStage) ? data.roadmapStage : undefined,
        planFilePath: typeof data.planFilePath === "string" && data.planFilePath.trim() ? data.planFilePath : undefined,
        planSha256: typeof data.planSha256 === "string" && /^[a-f0-9]{64}$/.test(data.planSha256) ? data.planSha256 : undefined,
        proposedByToolCallId:
          typeof data.proposedByToolCallId === "string" && data.proposedByToolCallId ? data.proposedByToolCallId : undefined,
        offeredForModeEntryId:
          typeof data.offeredForModeEntryId === "string" && data.offeredForModeEntryId ? data.offeredForModeEntryId : undefined,
        suppressedForModeEntryId:
          typeof data.suppressedForModeEntryId === "string" && data.suppressedForModeEntryId ? data.suppressedForModeEntryId : undefined,
        // The approval window lives only between one proposal and its overlay choice in this process. Older
        // entries persisted it; a reload, resume or branch must never revive it (e.g. after native "Save and quit").
        proposalAwaitingApproval: false,
        approvalCompactionPending: false,
        ledgerPath: typeof data.ledgerPath === "string" && data.ledgerPath ? data.ledgerPath : undefined,
        reviewRounds: restoreReviewRounds(data.reviewRounds),
        stallCount: 0,
        lastBlockedAt: 0,
        planningModeEntryId:
          typeof data.planningModeEntryId === "string" && data.planningModeEntryId ? data.planningModeEntryId : undefined,
      };
    }
    if (restored) records.set(sessionId, restored);
    return restored;
  };

  const syncTools = async (wantActivate: boolean, wantRelease: boolean, wantLedger: boolean): Promise<void> => {
    try {
      const active = pi.getActiveTools();
      const desired = new Set(active);
      if (wantActivate) desired.add(ACTIVATE_TOOL);
      else desired.delete(ACTIVATE_TOOL);
      if (wantRelease) desired.add(RELEASE_TOOL);
      else desired.delete(RELEASE_TOOL);
      if (wantLedger) {
        desired.add(LEDGER_TOOL);
        desired.add(GIT_TOOL);
      } else {
        desired.delete(LEDGER_TOOL);
        desired.delete(GIT_TOOL);
      }
      if (desired.size === active.length && active.every((name) => desired.has(name))) return;
      await pi.setActiveTools([...desired]);
    } catch (error) {
      pi.logger.warn("prometheus could not reconcile workflow tools", { error: errorMessage(error) });
    }
  };

  const availableAgents = (): string[] | undefined => {
    try {
      const description = pi.getAllTools().find((tool) => tool.name === "task")?.description;
      return typeof description === "string" ? parseLegalAgentNames(description) : undefined;
    } catch (error) {
      pi.logger.warn("prometheus could not inspect available task agents", { error: errorMessage(error) });
      return undefined;
    }
  };

  /** `changedId` selects the compact form returned after a row changes; status and refusals keep the full table and proofs. */
  const ledgerSummary = (ledger: ExecutionLedger, changedId?: string): string => {
    const summary = renderLedgerSummary(ledger, availableAgents(), changedId);
    if (changedId !== undefined) return summary;
    const proofs = ledgerRows(ledger).flatMap((row) =>
      row.receipt && row.status === "done"
        ? [
            `- ${row.id}: ${path.join(path.dirname(ledger.planFilePath), "evidence", `${row.receipt.receiptId}.md`)} (origin session ${row.receipt.sessionId}, child ${row.receipt.childAgentId})`,
          ]
        : [],
    );
    return `${summary}${proofs.length ? `\n\nShared verified outputs:\n${proofs.join("\n")}` : ""}`;
  };

  const localOptions = (ctx: ExtensionContext) => ({
    getArtifactsDir: () => ctx.sessionManager.getArtifactsDir(),
    getSessionId: () => ctx.sessionManager.getSessionId(),
  });

  const clearProposalMarker = async (ctx: ExtensionContext, planFilePath: string | undefined): Promise<void> => {
    if (!planFilePath) return;
    try {
      await fs.rm(resolveLocalUrlToPath(prometheusArtifactUrl(planFilePath), localOptions(ctx)), { force: true });
    } catch (error) {
      pi.logger.warn("prometheus could not remove the proposal marker", { error: errorMessage(error) });
    }
  };

  const pauseMessage = (record: SessionRecord): string =>
    `Atlas execution paused: ${record.ledgerError ?? "the shared approved execution ledger is unavailable"}. No new task dispatch or completion is permitted. Restore the exact shared proof, or run /atlas exit and obtain fresh native approval. Existing artifacts are preserved; there is no prompt-only fallback.`;

  const storeFor = (ctx: ExtensionContext): AtlasStore => {
    if (!ctx.sessionManager.getArtifactsDir()) {
      throw new Error("Atlas requires a file-backed session with a durable session directory");
    }
    const sessionDir = ctx.sessionManager.getSessionDir();
    if (!sessionDir) throw new Error("Atlas requires a durable session directory");
    const root = path.resolve(sessionDir);
    let store = stores.get(root);
    if (!store) {
      store = new AtlasStore(root);
      stores.set(root, store);
    }
    return store;
  };

  /** Main sessions whose live id may receive `atlas:plans`, keyed by session manager so a session switch follows along. */
  const plansSessions = new Map<object, ExtensionContext>();
  roadmap.answerPlans(
    (request) => {
      const ctx = [...plansSessions.values()].find((candidate) => candidate.sessionManager.getSessionId() === request.sessionId);
      if (!ctx) return undefined;
      const sessionDir = ctx.sessionManager.getSessionDir();
      // An in-memory session has no shared plan store, hence no plans.
      if (!sessionDir) return [];
      const root = path.resolve(sessionDir);
      let store = stores.get(root);
      if (!store) {
        store = new AtlasStore(root);
        stores.set(root, store);
      }
      return store.stagePlans(request.repoRoot, request.stage, (planId, error) =>
        pi.logger.warn("Atlas skipped an unreadable plan bundle in its roadmap plans answer", { planId, error: errorMessage(error) }),
      );
    },
    (error) => pi.logger.warn("Atlas could not answer a roadmap plans request", { error: errorMessage(error) }),
  );

  /** Notice only, never a pause: the bound stage's planning basis changed after this plan was approved. */
  const stageDriftNotice = (ctx: ExtensionContext, plan: AtlasPlan): string | undefined => {
    const approved = plan.roadmapStage;
    if (!approved?.revision) return undefined;
    let answer: RoadmapStageAnswer | undefined;
    try {
      answer = roadmap.requestStage(ctx.sessionManager.getSessionId(), approved.repoRoot, approved.id);
    } catch (error) {
      pi.logger.warn("Atlas could not ask the roadmap plugin for its stage", { error: errorMessage(error) });
      return undefined;
    }
    const current = answer?.stage;
    if (!current || current.revision === approved.revision) return undefined;
    const retired = approved.criteria?.filter((id) => !current.criteria.includes(id)) ?? [];
    return `Roadmap stage ${approved.id} (${current.title}) changed after plan ${plan.name} was approved: its objective, scope, done criteria or design constraints differ. Atlas continues; re-check the plan against the stage's current done criteria (${current.criteria.join(", ") || "none"})${retired.length ? `, where the declared ${retired.join(", ")} no longer appear` : ""}.`;
  };

  const clearObservation = (ctx: ExtensionContext, sessionId: string): void => {
    liveModels.get(sessionId)?.dispose();
    liveModels.delete(sessionId);
    if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
  };

  const installObservation = async (ctx: ExtensionContext, store: AtlasStore, plan: AtlasPlan): Promise<void> => {
    const sessionId = ctx.sessionManager.getSessionId();
    clearObservation(ctx, sessionId);
    try {
      const detail = (await store.details(plan.cwd)).find((item) => item.plan.id === plan.id);
      if (!detail || detail.status.startsWith("Invalid")) return;
      const live = new AtlasLive(detail, childEvidence, {
        sessionId,
        events: pi.events,
        subscribeLedger: (listener) => store.subscribe(plan.id, listener),
        reload: async () => (await store.details(plan.cwd)).find((item) => item.plan.id === plan.id),
        warn: (error) => pi.logger.warn("Atlas live observation failed", { error: errorMessage(error) }),
      });
      liveModels.set(sessionId, live);
      herdrDag.bind(sessionId, plan);
      live.subscribe((snapshot) => {
        herdrDag.publish(sessionId, snapshot);
        if (ctx.sessionManager.getSessionId() === sessionId) publishState(ctx);
      });
      if (ctx.hasUI && atlasWidgets.get(sessionId) !== false) {
        if (ctx.mode === "tui") {
          ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => new AtlasStatusWidget(live, tui, theme), { placement: "aboveEditor" });
        } else if (ctx.mode === "rpc") {
          // RPC clients accept only string-array widgets; publish the latest snapshot at most twice a second.
          let latest = live.snapshot;
          let shown = "";
          let timer: NodeJS.Timeout | undefined;
          live.subscribe((snapshot) => {
            latest = snapshot;
            timer ??= setTimeout(() => {
              timer = undefined;
              if (liveModels.get(sessionId) !== live) return;
              const lines = atlasWidgetLines(latest);
              const text = lines.join("\n");
              if (text === shown) return;
              shown = text;
              ctx.ui.setWidget(WIDGET_KEY, lines);
            }, 500);
            timer.unref?.();
          });
        }
      }
    } catch (error) {
      pi.logger.warn("Atlas live observation could not start", { error: errorMessage(error) });
    }
  };

  const refreshAtlasCompletions = async (ctx: ExtensionContext): Promise<void> => {
    try {
      const cwd = await fs.realpath(ctx.cwd);
      atlasPlans = (await storeFor(ctx).details(cwd)).map(({ plan, unfinished }) => ({ id: plan.id, name: plan.name, unfinished }));
    } catch (error) {
      atlasPlans = [];
      pi.logger.warn("Atlas plan completions are unavailable", { error: errorMessage(error) });
    }
  };

  const observeNativeJobs = (sessionId: string, live: AgentSession, parentAgentId: string): void => {
    const manager = live.asyncJobManager;
    if (!manager) return;
    childEvidence.observeAsyncJobs(sessionId, {
      ownerId: parentAgentId,
      jobs: manager.getAllJobs({ ownerId: parentAgentId }),
      onSettled: () => {
        void settleDetached();
      },
    });
  };

  const settleDetached = async (): Promise<void> => {
    for (const ownership of ownerships) {
      if (!ownership.detached || ownership.operations > 0) continue;
      try {
        observeNativeJobs(ownership.sessionId, ownership.live, ownership.parentAgentId);
        if (childEvidence.hasPending(ownership.sessionId, ownership.ledgerId)) continue;
        ownership.releasing ??= ownership.store.release(ownership.plan.id, ownership.sessionId);
        await ownership.releasing;
        planReferences.unbind(ownership.sessionId, ownership.plan.id);
        ownerships.delete(ownership);
      } catch (error) {
        ownership.releasing = undefined;
        pi.logger.warn("Atlas could not settle detached plan ownership", { error: errorMessage(error) });
      }
    }
    if (![...ownerships].some((ownership) => ownership.detached) && settlementTimer) {
      clearInterval(settlementTimer);
      settlementTimer = undefined;
    }
  };

  const detach = (ownership: Ownership | undefined): void => {
    if (!ownership) return;
    ownership.detached = true;
    // Exit is immediate. This timer only observes native terminal results and releases locks.
    settlementTimer ??= setInterval(() => {
      void settleDetached();
    }, 250);
    settlementTimer.unref?.();
  };

  const observeFinalJobs = (ctx: ExtensionContext): void => {
    const parent = AgentRegistry.global()
      .list()
      .find((candidate) => candidate.kind === "main" && candidate.session?.sessionManager === ctx.sessionManager);
    if (parent?.session) observeNativeJobs(ctx.sessionManager.getSessionId(), parent.session, parent.id);
    void settleDetached();
  };

  const withExecutionLedger = async <T>(
    ctx: ExtensionContext,
    record: SessionRecord,
    run: (ledger: ExecutionLedger, plan: AtlasPlan, store: AtlasStore) => T | Promise<T>,
  ): Promise<T> => {
    const ownership = record.ownership;
    if (ownership) ownership.operations += 1;
    try {
      if (!record.atlasPlanId)
        throw new Error(record.ledgerError ?? "Legacy session-local execution is not migrated; fresh native reapproval is required");
      if (!ownership || ownership.detached || ownership.sessionId !== ctx.sessionManager.getSessionId()) {
        throw new Error("shared plan execution ownership is unavailable");
      }
      if (!planReferencesMatch(mainSession(ctx)?.getPlanReferencePath(), atlasPlanUrl(ownership.plan.id))) {
        throw new Error("the host plan reference differs from the approved Atlas plan");
      }
      if ((await fs.realpath(ctx.cwd)) !== ownership.plan.cwd) throw new Error("the approved plan belongs to a different workspace");
      let validatedLedger: ExecutionLedger | undefined;
      const result = await ownership.store.transaction(
        ownership.plan.id,
        ownership.sessionId,
        async (ledger, plan) => {
          refreshDispatchAgents(ledger, availableAgents());
          validatedLedger = ledger;
          record.ledgerError = undefined;
          return await run(ledger, plan, ownership.store);
        },
        {
          assertActive: () => {
            if (
              record.phase !== "executing" ||
              record.ownership !== ownership ||
              ownership.detached ||
              ctx.sessionManager.getSessionId() !== ownership.sessionId ||
              !planReferencesMatch(mainSession(ctx)?.getPlanReferencePath(), atlasPlanUrl(ownership.plan.id))
            )
              throw new Error("Atlas attachment changed before ledger publication");
          },
        },
      );
      if (validatedLedger && record.phase === "executing" && record.ownership === ownership && !ownership.detached)
        syncLedgerTodos(ctx, validatedLedger);
      return result;
    } catch (error) {
      if (record.ownership === ownership) record.ledgerError = errorMessage(error);
      publishState(ctx);
      throw error;
    } finally {
      if (ownership) ownership.operations -= 1;
      void settleDetached();
    }
  };

  const readLedger = async (ctx: ExtensionContext, record: SessionRecord): Promise<ExecutionLedger | undefined> => {
    try {
      return await withExecutionLedger(ctx, record, (ledger) => ledger);
    } catch (error) {
      pi.logger.warn("Atlas shared execution ledger is unavailable", { error: errorMessage(error) });
      return undefined;
    }
  };

  const syncLedgerTodos = (ctx: ExtensionContext, ledger: ExecutionLedger): void => {
    const live = mainSession(ctx);
    if (!live) return;
    try {
      syncAtlasTodos(live, live.sessionManager, ledger);
    } catch (error) {
      pi.logger.warn("Atlas could not persist session todo phases", { error: errorMessage(error) });
    }
  };

  const bindPlan = async (
    ctx: ExtensionContext,
    record: SessionRecord,
    store: AtlasStore,
    plan: AtlasPlan,
    resume: boolean,
    expectedReference?: string,
  ): Promise<void> => {
    const live = mainSession(ctx);
    const activation = record.activation;
    if (!live) throw new Error("the registered main session is unavailable to bind the approved Atlas plan reference");
    if ((await fs.realpath(ctx.cwd)) !== plan.cwd) throw new Error("the approved plan belongs to a different workspace");
    const sessionId = ctx.sessionManager.getSessionId();
    await settleDetached();
    let ownership = [...ownerships].find(
      (candidate) => candidate.store === store && candidate.plan.id === plan.id && candidate.sessionId === sessionId,
    );
    if (ownership?.detached) throw new Error("this plan still has detached native work; wait for its final outcomes before entering again");
    const newlyOwned = !ownership;
    if (ownership) ownership.operations += 1;
    let acquired = false;
    try {
      await store.acquire(plan.id, sessionId);
      acquired = true;
      if (record.phase !== "executing" || record.activation !== activation)
        throw new Error("Atlas attachment changed during ownership acquisition");
      let validatedLedger: ExecutionLedger | undefined;
      const ledgerId = await store.transaction(
        plan.id,
        sessionId,
        (ledger) => {
          if (record.phase !== "executing" || record.activation !== activation)
            throw new Error("Atlas attachment changed during plan validation");
          refreshDispatchAgents(ledger, availableAgents());
          validatedLedger = ledger;
          return ledger.ledgerId;
        },
        { resume: resume && newlyOwned },
      );
      if (record.phase !== "executing" || record.activation !== activation)
        throw new Error("Atlas attachment changed during plan validation");
      const parent = AgentRegistry.global()
        .list()
        .find((candidate) => candidate.kind === "main" && candidate.session === live);
      if (!parent) throw new Error("registered native parent identity is unavailable");
      ownership ??= { store, plan, sessionId, live, parentAgentId: parent.id, ledgerId, detached: false, operations: 0 };
      ownerships.add(ownership);
      if (newlyOwned) ownership.operations += 1;
      record.ownership = ownership;
      if (expectedReference && !planReferencesMatch(live.getPlanReferencePath(), expectedReference))
        throw new Error("the native approval handoff reference changed during validation");
      planReferences = AtlasPlanReferences.current(planReferences);
      await planReferences.bind(sessionId, plan);
      if (record.phase !== "executing" || record.activation !== activation)
        throw new Error("Atlas attachment changed during plan reference binding");
      const previousReference = live.getPlanReferencePath();
      const planUrl = atlasPlanUrl(plan.id);
      live.setPlanReferencePath(planUrl);
      if (!planReferencesMatch(live.getPlanReferencePath(), planUrl)) throw new Error("the host did not bind the approved Atlas plan");
      hostBindings.set(live, { sessionId, planUrl, previousReference });
      record.atlasPlanId = plan.id;
      record.planFilePath = plan.planFilePath;
      record.planSha256 = plan.planSha256;
      record.ledgerPath = plan.ledgerPath;
      record.proposedByToolCallId = plan.proposedByToolCallId;
      record.sourceSessionId = plan.sourceSessionId;
      record.roadmapStage = plan.roadmapStage;
      record.ledgerError = undefined;
      persist(ctx, record);
      if (validatedLedger) syncLedgerTodos(ctx, validatedLedger);
      await installObservation(ctx, store, plan);
    } catch (error) {
      const binding = hostBindings.get(live);
      if (binding?.sessionId === sessionId && binding.planUrl === atlasPlanUrl(plan.id)) {
        if (planReferencesMatch(live.getPlanReferencePath(), binding.planUrl))
          live.setPlanReferencePath(binding.previousReference?.startsWith("local://") ? binding.previousReference : DEFAULT_PLAN_REFERENCE);
        hostBindings.delete(live);
      }
      if (newlyOwned && acquired) {
        if (ownership) ownerships.delete(ownership);
        if (record.ownership === ownership) record.ownership = undefined;
        planReferences.unbind(sessionId, plan.id);
        await store.release(plan.id, sessionId);
      } else if (ownership) {
        detach(ownership);
      }
      throw error;
    } finally {
      if (ownership) ownership.operations -= 1;
      void settleDetached();
    }
  };

  const resumeLedger = async (ctx: ExtensionContext, record: SessionRecord | undefined, previousReference?: string): Promise<void> => {
    if (record?.phase !== "executing") return;
    record.activation = {};
    try {
      if (!record.atlasPlanId)
        throw new Error("Legacy session-local progress is not migrated; fresh native reapproval is required. Run /atlas exit");
      const store = storeFor(ctx);
      const plan = await store.find(record.atlasPlanId);
      if (
        record.planSha256 !== plan.planSha256 ||
        record.proposedByToolCallId !== plan.proposedByToolCallId ||
        record.sourceSessionId !== plan.sourceSessionId
      ) {
        throw new Error("the session pointer does not match the shared approval provenance");
      }
      const reference = mainSession(ctx)?.getPlanReferencePath();
      if (
        reference &&
        !planReferencesMatch(reference, DEFAULT_PLAN_REFERENCE) &&
        !planReferencesMatch(reference, atlasPlanUrl(plan.id)) &&
        !planReferencesMatch(reference, plan.planFilePath) &&
        !planReferencesMatch(reference, previousReference)
      ) {
        throw new Error("the host plan reference differs from the persisted approved Atlas plan");
      }
      await bindPlan(ctx, record, store, plan, true);
    } catch (error) {
      record.ledgerError = errorMessage(error);
      publishState(ctx);
      notify(ctx, pauseMessage(record), "error");
    }
  };

  const release = async (ctx: ExtensionContext, reason: string, expected: "planning" | "executing"): Promise<void> => {
    const live = mainSession(ctx);
    if (!live) return;
    restoreApprovalTiers(live);
    restoreIsolationMerge(live);
    const record = records.get(ctx.sessionManager.getSessionId()) ?? rehydrate(ctx);
    if (record?.phase !== expected) return;
    const proposalPath = expected === "planning" ? record.planFilePath : undefined;
    const binding = hostBindings.get(live);
    if (
      expected === "executing" &&
      binding?.sessionId === ctx.sessionManager.getSessionId() &&
      planReferencesMatch(live.getPlanReferencePath(), binding.planUrl)
    ) {
      live.setPlanReferencePath(binding.previousReference?.startsWith("local://") ? binding.previousReference : DEFAULT_PLAN_REFERENCE);
    }
    const ownership = record.ownership;
    const episodeId = planModeEpisodeId(ctx);
    authorizedActivationCalls.clear();
    // Invalidate in-flight publication synchronously, before any file or UI operation.
    record.phase = "idle";
    pendingTodoRefreshes.delete(ctx.sessionManager.getSessionId());
    if (expected === "executing") herdrDag.release(ctx.sessionManager.getSessionId(), "exit");
    clearObservation(ctx, ctx.sessionManager.getSessionId());
    record.ownership = undefined;
    record.activation = undefined;
    detach(ownership);
    record.planFilePath = undefined;
    record.planSha256 = undefined;
    record.atlasPlanId = undefined;
    record.sourceSessionId = undefined;
    record.roadmapStage = undefined;
    record.ledgerError = undefined;
    record.proposedByToolCallId = undefined;
    record.offeredForModeEntryId = episodeId;
    record.suppressedForModeEntryId = episodeId;
    record.pendingConsent = undefined;
    record.proposalAwaitingApproval = false;
    record.approvalCompactionPending = false;
    record.compactHandoffPending = false;
    record.planningModeEntryId = undefined;
    record.offerPendingForModeEntryId = undefined;
    record.ledgerPath = undefined;
    record.lastContinuationLedgerStamp = undefined;
    record.stallCount = 0;
    persist(ctx, record);
    await syncTools(false, false, false);
    if (proposalPath) await clearProposalMarker(ctx, proposalPath);
    await settleDetached();
    await refreshAtlasCompletions(ctx);
    commandNotice(
      ctx,
      expected === "executing"
        ? `Atlas exited (${reason}). Shared progress is preserved. Native children have not been cancelled; any unfinished native work retains its plan ownership until final outcomes.`
        : `Prometheus planning exited (${reason}).`,
    );
  };

  const atlasCommand = async (args: string, ctx: ExtensionContext): Promise<void> => {
    const command = parseAtlasSubcommand(args);
    const live = mainSession(ctx);
    if (!live) {
      commandNotice(ctx, "Atlas requires the registered main session.", "error");
      return;
    }
    const current = records.get(ctx.sessionManager.getSessionId()) ?? rehydrate(ctx);
    if (current?.phase === "executing") {
      if (command.kind === "exit") {
        await exitAtlas(ctx, current);
        return;
      }
      const activePlan = current.ownership?.plan.name ?? current.atlasPlanId ?? "the current plan";
      if (command.kind !== "menu") {
        commandNotice(
          ctx,
          `Already in an Atlas session for ${activePlan}. Switching plans is not allowed; run /atlas exit first, then /atlas ${args.trim()}.`,
          "error",
        );
        return;
      }
      await showActivePlan(ctx, current);
      return;
    }
    if (command.kind === "exit") {
      commandNotice(ctx, "Atlas is not active; there is nothing to exit.");
      return;
    }
    if (command.kind === "usage") {
      commandNotice(ctx, command.message, "error");
      return;
    }
    if (command.kind === "enter" || command.kind === "start") {
      await enterPlan(ctx, command.selector, true);
      return;
    }
    let store: AtlasStore;
    try {
      store = storeFor(ctx);
    } catch (error) {
      commandNotice(ctx, `Atlas entry refused: ${errorMessage(error)}`, "error");
      return;
    }
    try {
      if (command.kind === "menu") {
        if (!ctx.hasUI) {
          const details = await store.details(await fs.realpath(ctx.cwd));
          commandNotice(
            ctx,
            `Atlas is inactive. Use /atlas <plan-name-or-id> to enter an approved plan.\n${ATLAS_USAGE}\n${atlasPlanList(details)}`,
          );
        } else if (ctx.mode === "tui") {
          await dispatchMenu(ctx, store);
        } else {
          await selectDispatchMenu(ctx, store);
        }
      } else if (command.kind === "list") {
        await showText(ctx, "Atlas plans", atlasPlanList(await store.details(await fs.realpath(ctx.cwd))));
      } else if (command.kind === "show") {
        const target = await planDetail(ctx, store, command.selector);
        if (ctx.mode === "tui") await openPlanView(ctx, target, "display");
        else await showText(ctx, `Atlas plan ${target.plan.name}`, atlasPlanText(target));
      } else if (command.kind === "resume") {
        await resumeCommand(ctx, await planDetail(ctx, store, command.selector));
      } else if (command.kind === "rename") {
        await store.rename(command.planId, command.name);
        commandNotice(ctx, `Atlas plan ${command.planId} renamed to ${command.name}.`);
      } else if (command.confirmed || (ctx.hasUI && (await confirmDelete(ctx, (await store.find(command.planId)).name, command.planId)))) {
        await deletePlan(store, command.planId);
        commandNotice(ctx, `Atlas plan ${command.planId} deleted with its evidence.`);
      } else {
        commandNotice(
          ctx,
          ctx.hasUI
            ? "Atlas plan deletion cancelled."
            : `Deleting an Atlas plan is permanent; run /atlas delete ${command.planId} --yes to confirm.`,
          ctx.hasUI ? "info" : "error",
        );
      }
    } catch (error) {
      commandNotice(ctx, `Atlas command refused: ${errorMessage(error)}`, "error");
    } finally {
      await refreshAtlasCompletions(ctx);
    }
  };

  /** Read-only text: an editor dialog when a client can show one, otherwise a transcript message. */
  const showText = async (ctx: ExtensionContext, title: string, text: string): Promise<void> => {
    if (ctx.hasUI) await ctx.ui.editor(`${title} (read-only)`, text);
    else commandNotice(ctx, text);
  };

  const planDetail = async (ctx: ExtensionContext, store: AtlasStore, selector: string): Promise<AtlasPlanDetail> => {
    const plan = await store.find(selector);
    const detail = (await store.details(await fs.realpath(ctx.cwd))).find((item) => item.plan.id === plan.id);
    if (!detail) throw new Error(`Atlas plan ${plan.id} disappeared from the shared store`);
    return detail;
  };

  const confirmDelete = (ctx: ExtensionContext, name: string, planId: string): Promise<boolean> =>
    ctx.ui.confirm("Delete Atlas plan?", `Permanently remove ${name} (${planId}) and all its evidence?`);

  const deletePlan = (store: AtlasStore, planId: string): Promise<void> =>
    store.delete(
      planId,
      () =>
        [...ownerships].some((ownership) => ownership.store === store && ownership.plan.id === planId) ||
        [...records.values()].some((record) => record.phase === "executing" && record.atlasPlanId === planId),
    );

  /** Same refusals as the dispatch menu, worded for a command line. */
  const resumeRefusal = (target: AtlasPlanDetail): string | undefined =>
    target.started ? dispatchBlock(target, "resume", false) : `Cannot resume ${target.plan.name}: it has not started yet; start it instead`;

  /** `/atlas resume`: dialogs may pick a session; without them only the current session can resume. */
  const resumeCommand = async (ctx: ExtensionContext, target: AtlasPlanDetail): Promise<void> => {
    const blocked = resumeRefusal(target);
    if (blocked) {
      commandNotice(ctx, blocked, "error");
      return;
    }
    if (!ctx.hasUI) {
      const sessionDir = ctx.sessionManager.getSessionDir();
      const sessions = sessionDir ? await findPlanSessions(sessionDir, STATE_ENTRY, target.plan.id) : [];
      const only = sessions.length === 1 ? sessions[0] : undefined;
      if (only?.id !== ctx.sessionManager.getSessionId()) {
        commandNotice(
          ctx,
          sessions.length
            ? `Resuming ${target.plan.name} needs a session choice, which requires an interactive client. Open the session to resume and run /atlas resume ${target.plan.id} there:\n${sessions.map((session) => `- ${session.id} ${formatTime(session.modified)} ${session.path}`).join("\n")}`
            : `Cannot resume: no session in this project has executed ${target.plan.name}; run /atlas start ${target.plan.id}.`,
          "error",
        );
        return;
      }
    }
    const refusal = await resumePlan(ctx, target);
    if (refusal) commandNotice(ctx, refusal, "error");
  };

  const openPlanView = async (ctx: ExtensionContext, detail: AtlasPlanDetail, mode: AtlasPlanViewMode): Promise<AtlasPlanViewAction> => {
    let view: AtlasPlanView | undefined;
    try {
      return await ctx.ui.custom<AtlasPlanViewAction>(
        (tui, theme, _keys, done) => {
          view = new AtlasPlanView(
            detail,
            mode,
            theme,
            tui,
            (file) => fs.readFile(file, "utf8"),
            done,
            mode === "active" ? liveModels.get(ctx.sessionManager.getSessionId()) : undefined,
          );
          return view;
        },
        { overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0, fullscreen: true } },
      );
    } finally {
      view?.dispose();
    }
  };

  /** Exits right away when every row is done; otherwise asks first. Shared progress is always kept. */
  const exitAtlas = async (ctx: ExtensionContext, record: SessionRecord): Promise<void> => {
    const activePlan = record.ownership?.plan.name ?? record.atlasPlanId ?? "the current plan";
    if (ctx.hasUI) {
      // Exit must never wait on the ledger lock (an evidence capture may hold it), so this
      // advisory count reads the last published ledger directly and authorizes nothing.
      let remaining: number | undefined;
      try {
        const snapshot: unknown = JSON.parse(await fs.readFile(record.ledgerPath ?? "", "utf8"));
        const rows =
          snapshot && typeof snapshot === "object" && "items" in snapshot && "gates" in snapshot
            ? [
                snapshot.items,
                "discoveries" in snapshot ? snapshot.discoveries : [],
                "fixes" in snapshot ? snapshot.fixes : [],
                snapshot.gates,
                "deliveries" in snapshot ? snapshot.deliveries : [],
              ].flatMap((list) => (Array.isArray(list) ? list : []))
            : [];
        if (rows.length) remaining = rows.filter((row) => row?.status !== "done" || !row.receipt).length;
      } catch {
        remaining = undefined;
      }
      if (remaining !== 0) {
        const confirmed = await ctx.ui.confirm(
          "Exit Atlas early?",
          remaining === undefined
            ? `${activePlan} progress cannot be verified. Exit Atlas anyway? Shared progress is kept.`
            : `${activePlan} still has ${remaining} unfinished item(s). Exit Atlas anyway? Shared progress is kept and you can resume later.`,
        );
        if (!confirmed) {
          commandNotice(ctx, "Atlas exit cancelled; Atlas stays active.");
          return;
        }
      }
    }
    await release(ctx, "/atlas", "executing");
  };

  /** Read-only view of the plan this session executes; the only action it offers is exit. */
  const showActivePlan = async (ctx: ExtensionContext, record: SessionRecord): Promise<void> => {
    let detail: AtlasPlanDetail | undefined;
    try {
      detail = (await storeFor(ctx).details(await fs.realpath(ctx.cwd))).find((item) => item.plan.id === record.atlasPlanId);
    } catch (error) {
      commandNotice(ctx, `Atlas plan details are unavailable: ${errorMessage(error)}. Run /atlas exit to leave Atlas.`, "error");
      return;
    }
    if (!detail) {
      commandNotice(
        ctx,
        `Atlas plan ${record.atlasPlanId ?? "(unknown)"} is not in the shared store. Run /atlas exit to leave Atlas.`,
        "error",
      );
      return;
    }
    if (ctx.mode === "tui") {
      if ((await openPlanView(ctx, detail, "active")) === "exit") await exitAtlas(ctx, record);
      return;
    }
    if (!ctx.hasUI) {
      commandNotice(ctx, `Atlas is executing ${detail.plan.name}. Run /atlas exit to leave it.\n\n${atlasPlanText(detail)}`);
      return;
    }
    const keep = "Keep Atlas running";
    const view = "View plan details";
    const exit = "Exit Atlas";
    const running = detail.rows.filter((row) => row.status === "in_progress").map((row) => `${row.id} ${row.title} (${row.agent})`);
    const summary = [`Atlas is executing ${detail.plan.name} (${detail.plan.id})`, detail.status, ...running].join("\n");
    while (true) {
      const choice = await ctx.ui.select(summary, [keep, view, exit]);
      if (choice === view) {
        await ctx.ui.editor(`Atlas plan ${detail.plan.name} (read-only)`, atlasPlanText(detail));
        continue;
      }
      if (choice === exit) await exitAtlas(ctx, record);
      return;
    }
  };

  const planningBlocks = (ctx: ExtensionContext): boolean => {
    const record = records.get(ctx.sessionManager.getSessionId()) ?? rehydrate(ctx);
    if (record?.phase !== "planning" && mainSession(ctx)?.getPlanModeState()?.enabled !== true) return false;
    commandNotice(ctx, "Atlas cannot enter during planning. Exit planning first; Atlas only executes plans with native approval.", "error");
    return true;
  };

  /** Runs in the background so a failed title never affects Atlas. */
  const retitleSession = (ctx: ExtensionContext, plan: AtlasPlan, content?: string): void => {
    const live = mainSession(ctx);
    if (!live) return;
    void (async () =>
      retitleForAtlas(live, { name: plan.name, content: content ?? (await fs.readFile(plan.planFilePath, "utf8")) }))().catch((error) =>
      pi.logger.warn("prometheus could not retitle the Atlas session", { error: errorMessage(error) }),
    );
  };

  /** Binds the plan to the current session; `autoStart` then kicks off execution like native plan approval does. */
  const enterPlan = async (ctx: ExtensionContext, selector: string, autoStart: boolean): Promise<void> => {
    const live = mainSession(ctx);
    if (!live) {
      commandNotice(ctx, "Atlas requires the registered main session.", "error");
      return;
    }
    if (planningBlocks(ctx)) return;
    const activation = {};
    const record = recordFor(ctx.sessionManager.getSessionId());
    record.phase = "executing";
    record.activation = activation;
    persist(ctx, record);
    try {
      const store = storeFor(ctx);
      const plan = await store.find(selector);
      if (record.phase !== "executing" || record.activation !== activation) throw new Error("Atlas entry changed during plan selection");
      record.atlasPlanId = plan.id;
      record.planSha256 = plan.planSha256;
      record.proposedByToolCallId = plan.proposedByToolCallId;
      record.sourceSessionId = plan.sourceSessionId;
      record.roadmapStage = plan.roadmapStage;
      persist(ctx, record);
      await bindPlan(ctx, record, store, plan, true);
      await syncTools(false, true, true);
      retitleSession(ctx, plan);
      let modelNotice = "";
      try {
        const model = await applyAtlasModel(live);
        if (model) modelNotice = ` Switched to the atlas model role (${model}).`;
      } catch (error) {
        modelNotice = ` The atlas model role could not be applied (${errorMessage(error)}); the current model is kept.`;
      }
      commandNotice(
        ctx,
        `Atlas entered ${plan.name} (${plan.id}). Shared completed rows and evidence are retained. /atlas shows the plan; /atlas exit leaves Atlas.${modelNotice}`,
      );
      const drift = stageDriftNotice(ctx, plan);
      if (drift) commandNotice(ctx, drift, "warning");
      await refreshAtlasCompletions(ctx);
      if (autoStart) {
        pi.sendMessage(
          {
            customType: ATLAS_START_TYPE,
            content: `Execute the approved plan ${plan.name} (${plan.id}) now. Check \`${LEDGER_TOOL}\` status, then dispatch every ready row to its assigned agent.${drift ? `\n${drift}` : ""}`,
            display: true,
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      }
    } catch (error) {
      if (record.activation !== activation) return;
      record.ledgerError = errorMessage(error);
      publishState(ctx);
      await syncTools(false, true, true);
      await refreshAtlasCompletions(ctx);
      commandNotice(ctx, pauseMessage(record), "error");
    }
  };

  const isCommandContext = (ctx: ExtensionContext): ctx is ExtensionCommandContext =>
    "newSession" in ctx && typeof ctx.newSession === "function" && "switchSession" in ctx && typeof ctx.switchSession === "function";

  const hasConversation = (ctx: ExtensionContext): boolean =>
    ctx.sessionManager
      .getBranch()
      .some((entry) => entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant"));

  /** Returns false when the user backed out, so the dispatch menu reopens. */
  const startPlan = async (ctx: ExtensionContext, target: AtlasPlanDetail): Promise<boolean> => {
    if (hasConversation(ctx)) {
      const fresh = "Start in a new session";
      const here = "Start in this session";
      const choice = await ctx.ui.select(`This session already has a conversation. Where should Atlas run ${target.plan.name}?`, [
        ...(isCommandContext(ctx) ? [fresh] : []),
        here,
        "Cancel",
      ]);
      if (choice !== fresh && choice !== here) return false;
      if (choice === fresh && isCommandContext(ctx) && (await ctx.newSession()).cancelled) {
        commandNotice(ctx, "A new session could not be started; Atlas did not start.", "warning");
        return true;
      }
    }
    await enterPlan(ctx, target.plan.id, true);
    return true;
  };

  /** Returns a refusal to show in the menu, or undefined once the plan is resumed (or the user backed out). */
  const resumePlan = async (ctx: ExtensionContext, target: AtlasPlanDetail): Promise<string | undefined | false> => {
    const live = mainSession(ctx);
    if (!live) return "Atlas requires the registered main session";
    const here = records.get(ctx.sessionManager.getSessionId()) ?? rehydrate(ctx);
    if (here?.phase === "planning" || live.getPlanModeState()?.enabled === true)
      return "Cannot resume during planning; exit planning first";
    const sessionDir = ctx.sessionManager.getSessionDir();
    const sessions = sessionDir ? await findPlanSessions(sessionDir, STATE_ENTRY, target.plan.id) : [];
    if (!sessions.length) return `Cannot resume: no session in this project has executed ${target.plan.name}; press Enter to start it`;
    const currentId = ctx.sessionManager.getSessionId();
    let session = sessions[0];
    if (sessions.length > 1) {
      const labels = sessions.map(
        (candidate) =>
          `${formatTime(candidate.modified)}  ${candidate.title.slice(0, 60) || "Untitled session"}  ${candidate.id.slice(0, 8)}${candidate.id === currentId ? "  (this session)" : ""}`,
      );
      const choice = await ctx.ui.select(`Resume ${target.plan.name} in which session? Most recent first.`, labels);
      if (choice === undefined) return false;
      session = sessions[labels.indexOf(choice)];
    }
    if (!session) return false;
    if (session.id !== currentId) {
      if (!isCommandContext(ctx)) return "Cannot resume from here: switching sessions needs the /atlas command";
      // The host keeps the plan reference across a switch; drop this idle session's stale one so the target can rebind.
      live.setPlanReferencePath(DEFAULT_PLAN_REFERENCE);
      if ((await ctx.switchSession(session.path)).cancelled) return "Session switch was cancelled";
      const restored = records.get(ctx.sessionManager.getSessionId()) ?? rehydrate(ctx);
      if (restored?.phase === "executing") {
        if (restored.atlasPlanId !== target.plan.id) {
          commandNotice(
            ctx,
            `This session is executing another Atlas plan (${restored.atlasPlanId ?? "unknown"}). Run /atlas exit first.`,
            "error",
          );
        } else if (!restored.ledgerError) {
          retitleSession(ctx, target.plan);
          commandNotice(ctx, `Atlas resumed ${target.plan.name} in this session. Send a message to continue; /atlas exit leaves Atlas.`);
          const drift = stageDriftNotice(ctx, target.plan);
          if (drift) commandNotice(ctx, drift, "warning");
        }
        return undefined;
      }
    }
    await enterPlan(ctx, target.plan.id, false);
    return undefined;
  };

  /** Start, resume, delete or rename one plan; `done` closes the dispatch flow, `message` is a refusal to show. */
  const runPlanAction = async (
    ctx: ExtensionContext,
    store: AtlasStore,
    target: AtlasPlanDetail,
    kind: "start" | "resume" | "delete" | "rename",
  ): Promise<{ done: boolean; message?: string }> => {
    try {
      if (kind === "start") {
        if (await startPlan(ctx, target)) return { done: true };
      } else if (kind === "resume") {
        const refusal = await resumePlan(ctx, target);
        if (refusal === undefined) return { done: true };
        if (refusal) return { done: false, message: refusal };
      } else if (kind === "delete") {
        if (await confirmDelete(ctx, target.plan.name, target.plan.id)) await deletePlan(store, target.plan.id);
      } else {
        const name = await ctx.ui.input("Rename Atlas plan", target.plan.name);
        if (name !== undefined) await store.rename(target.plan.id, name);
      }
    } catch (error) {
      return { done: false, message: `Atlas plan change refused: ${errorMessage(error)}` };
    }
    return { done: false };
  };

  const dispatchMenu = async (ctx: ExtensionContext, store: AtlasStore): Promise<void> => {
    let filter: AtlasFilter = "unfinished";
    let query = "";
    let selectedId: string | undefined;
    let message: string | undefined;
    while (true) {
      const workspace = await fs.realpath(ctx.cwd);
      const details = await store.details(workspace);
      const options = { selectedId, message };
      const action = await ctx.ui.custom<AtlasMenuAction>(
        (tui, theme, _keys, done) => new AtlasMenu(details, filter, query, theme, tui, done, options),
      );
      filter = action.filter;
      query = action.query;
      selectedId = action.planId ?? selectedId;
      message = undefined;
      if (action.kind === "cancel") return;
      const target = details.find((detail) => detail.plan.id === action.planId);
      if (!target) continue;
      let kind = action.kind;
      if (kind === "inspect") {
        const next = await openPlanView(ctx, target, action.filter === "all" ? "display" : "dispatch");
        if (next === "back" || next === "exit") continue;
        kind = next;
      }
      const outcome = await runPlanAction(ctx, store, target, kind);
      if (outcome.done) return;
      message = outcome.message;
    }
  };

  /** The dispatch menu composed from select/confirm/input/editor for clients without terminal components (RPC, ACP). */
  const selectDispatchMenu = async (ctx: ExtensionContext, store: AtlasStore): Promise<void> => {
    const actions = {
      start: "Start",
      resume: "Resume",
      view: "View details",
      rename: "Rename",
      delete: "Delete",
      back: "Back",
    } as const;
    let filter: AtlasFilter = "unfinished";
    let message: string | undefined;
    while (true) {
      const details = (await store.details(await fs.realpath(ctx.cwd))).filter((detail) => filter === "all" || detail.unfinished);
      const labels = details.map(({ plan, status }) => `${plan.name} — ${status} (${plan.id})`);
      const toggle = filter === "unfinished" ? "Show all plans (display only)" : "Show unfinished plans";
      const close = "Close";
      const heading =
        filter === "all"
          ? "All plans; display only. Show unfinished plans to start or resume."
          : details.length
            ? "Unfinished plans"
            : "No unfinished plans";
      const choice = await ctx.ui.select([`Atlas Dispatch: ${heading}`, message].filter(Boolean).join("\n"), [...labels, toggle, close]);
      message = undefined;
      if (choice === undefined || choice === close) return;
      if (choice === toggle) {
        filter = filter === "unfinished" ? "all" : "unfinished";
        continue;
      }
      const target = details[labels.indexOf(choice)];
      if (!target) continue;
      const offered =
        filter === "all"
          ? [actions.view, actions.rename, actions.delete, actions.back]
          : [actions.start, actions.resume, actions.view, actions.rename, actions.delete, actions.back];
      let note: string | undefined;
      while (true) {
        const picked = await ctx.ui.select(
          [`${target.plan.name} (${target.plan.id})`, target.status, note].filter(Boolean).join("\n"),
          offered,
        );
        note = undefined;
        if (picked === undefined || picked === actions.back) break;
        if (picked === actions.view) {
          await ctx.ui.editor(`Atlas plan ${target.plan.name} (read-only)`, atlasPlanText(target));
          continue;
        }
        const kind =
          picked === actions.start ? "start" : picked === actions.resume ? "resume" : picked === actions.rename ? "rename" : "delete";
        const blocked = kind === "start" ? dispatchBlock(target, "start", false) : kind === "resume" ? resumeRefusal(target) : undefined;
        if (blocked) {
          note = blocked;
          continue;
        }
        const outcome = await runPlanAction(ctx, store, target, kind);
        if (outcome.done) return;
        message = outcome.message;
        break;
      }
    }
  };

  const activate = async (ctx: ExtensionContext): Promise<boolean> => {
    if (!mainSession(ctx)) {
      notify(ctx, "Prometheus runs in the main session only.", "warning");
      return false;
    }
    try {
      loadRequiredPromptAssets();
    } catch (error) {
      const detail = errorMessage(error);
      pi.logger.warn("prometheus refused activation without prompt assets", { error: detail });
      notify(ctx, `Prometheus could not load its prompt assets (${detail}); activation was refused.`, "error");
      return false;
    }
    const record = recordFor(ctx.sessionManager.getSessionId());
    if (record.phase === "executing") {
      notify(ctx, "Atlas is active. Run /atlas exit before entering Prometheus planning.", "error");
      return false;
    }
    if (record.phase !== "planning") {
      record.phase = "planning";
      record.planFilePath = undefined;
      record.planSha256 = undefined;
      record.atlasPlanId = undefined;
      record.sourceSessionId = undefined;
      record.roadmapStage = undefined;
      record.ledgerError = undefined;
      record.proposedByToolCallId = undefined;
      record.offeredForModeEntryId = undefined;
      record.suppressedForModeEntryId = undefined;
      record.pendingConsent = undefined;
      record.proposalAwaitingApproval = false;
      record.approvalCompactionPending = false;
      record.compactHandoffPending = false;
      record.offerPendingForModeEntryId = undefined;
      record.planningModeEntryId = planModeEpisodeId(ctx);
      record.ledgerPath = undefined;
      record.lastContinuationLedgerStamp = undefined;
      record.stallCount = 0;
      record.reviewRounds = undefined;
    }
    persist(ctx, record);
    return true;
  };

  /**
   * Count one plan-review round per review dispatch while planning. At the limit, ask the user to add rounds for
   * this plan or stop; without a user to ask, stop. Returns a block reason, or undefined to let the round run.
   */
  const reviewRoundBlockReason = async (ctx: ExtensionContext, record: SessionRecord): Promise<string | undefined> => {
    const configured = reviewRoundLimits.get(ctx.sessionManager.getSessionId()) ?? DEFAULT_REVIEW_ROUND_LIMIT;
    record.reviewRounds ??= { used: 0, extra: 0 };
    const rounds = record.reviewRounds;
    const stopGuidance =
      "Do not dispatch more Momus or Oracle plan reviews for this plan. Propose it now as it stands with xd://propose, and list every outstanding eligible blocker from the latest round in the proposal summary so the user can weigh them at approval.";
    while (configured > 0 && rounds.used >= configured + rounds.extra) {
      const limit = configured + rounds.extra;
      if (!ctx.hasUI) return `Plan review reached its limit of ${limit} rounds and no user is available to raise it. ${stopGuidance}`;
      const raise = "Raise the limit for this plan";
      const stop = "Stop reviewing and propose the plan with its open blockers";
      const choice = await ctx.ui.select(`Plan review has used all ${limit} rounds allowed for this plan. Raise the limit, or stop here?`, [
        raise,
        stop,
      ]);
      if (choice === stop) return `The user stopped plan review at its limit of ${limit} rounds. ${stopGuidance}`;
      if (choice !== raise) {
        return "The user dismissed the review-round limit prompt. Do not dispatch another plan review now; ask the user whether to keep reviewing or to propose the plan as it stands.";
      }
      const answer = (await ctx.ui.input("Additional review rounds for this plan", String(configured)))?.trim();
      if (answer && /^[1-9]\d*$/.test(answer) && Number.isSafeInteger(Number(answer))) rounds.extra += Number(answer);
      else if (answer !== undefined) notify(ctx, `"${answer}" is not a positive whole number of rounds.`, "warning");
    }
    rounds.used += 1;
    persist(ctx, record);
    return undefined;
  };

  const toolProvenance = (toolName: string) => {
    try {
      return pi.getAllTools().find((tool) => tool.name === toolName)?.sourceInfo;
    } catch (error) {
      pi.logger.warn("prometheus could not inspect tool provenance", { toolName, error: errorMessage(error) });
      return undefined;
    }
  };

  const provenanceBlockReason = (toolName: string, trusted?: TrustedToolSources): string | undefined => {
    const provenance = toolProvenance(toolName);
    const trustedPrometheusTool =
      PLUGIN_OWNED_TOOLS[toolName] === true && provenance?.source === "extension" && provenance.path === RUNTIME_SOURCE_PATH;
    return executionToolSourceBlockReason(toolName, provenance?.source, trustedPrometheusTool, trusted, provenance?.path);
  };

  /** Refuses a Prometheus proposal Atlas could not execute, before the native approval overlay opens. */
  const proposalGrammarBlockReason = async (ctx: ExtensionContext, input: unknown): Promise<string | undefined> => {
    const planUrl = proposedPlanUrl(input);
    if (!planUrl) return undefined;
    let content: string;
    try {
      content = await fs.readFile(resolveLocalUrlToPath(planUrl, localOptions(ctx)), "utf8");
    } catch {
      // The host resolves the plan itself and reports a missing file.
      return undefined;
    }
    const { errors, roadmapCriteria } = parsePlanChecklist(content, availableAgents());
    const reasons: string[] = [];
    if (errors.length) {
      reasons.push(
        `Prometheus refused this proposal: ${planUrl} does not follow the plan grammar Atlas executes (${errors.join("; ")}). Rewrite it with \`## Tasks\` (sequential T rows with Agent, Depends on and Acceptance) and \`## Final gates\` (exactly F1–F4 with their required titles), then propose again.`,
      );
    }
    // Coverage is declared before approval only against a roadmap that reports the stage's current criteria.
    const stage = roadmap.requestBinding(ctx.sessionManager.getSessionId())?.stage;
    const coverage = stage?.criteria ? checkRoadmapCriteria(roadmapCriteria, { id: stage.id, criteria: stage.criteria }) : undefined;
    if (coverage && "error" in coverage) {
      reasons.push(`Prometheus refused this proposal: in ${planUrl}, ${coverage.error} Then propose again.`);
    }
    return reasons.length ? reasons.join("\n") : undefined;
  };

  const planningBlock = async (ctx: ExtensionContext): Promise<string> => {
    const roster = availableAgents();
    const agentBlock = roster
      ? `<available-agents>\n${roster.join("\n") || "(none; spawning is disabled)"}\n</available-agents>`
      : '<available-agents status="unknown">The task tool\'s spawnable-agent list could not be parsed; use only known agents with documented fallbacks.</available-agents>';
    const guidance =
      "Choose the most specific listed specialist for each Agent: row; prefer installed specialist agents (including omo-toolkit) over task/sonic. Names not listed are allowed only when they have a known fallback. Pass this exact available-agents list (or unknown) into every Momus review binding.";
    const sessionId = ctx.sessionManager.getSessionId();
    const roundLimit = reviewRoundLimits.get(sessionId) ?? DEFAULT_REVIEW_ROUND_LIMIT;
    const roundLimitLabel = roundLimit === 0 ? "unlimited" : String(roundLimit + (records.get(sessionId)?.reviewRounds?.extra ?? 0));
    const reviewPolicy =
      `<review-policy level="${reviewLevels.get(sessionId) ?? "ask"}" round-limit="${roundLimitLabel}">` +
      "Apply this session's plan-review setting in section 7 of the planning skill. The plugin counts and enforces the round limit.</review-policy>\n" +
      `<delivery-policy mode="${deliverySettings.get(sessionId) ?? "ask"}">` +
      "Apply this session's delivery setting from the Delivery rule in section 4 of the planning skill.</delivery-policy>" +
      ((await isGitWorkTree(ctx.cwd)) ? "" : `\n${NON_GIT_PLANNING}`);
    try {
      return `${PLANNING_PREAMBLE}\n\n${agentBlock}\n${guidance}\n\n${reviewPolicy}\n\n${loadPromptAsset(SKILL_ASSET)}`;
    } catch (error) {
      const detail = errorMessage(error);
      pi.logger.warn("prometheus planning asset became unavailable", { error: detail });
      notify(ctx, `Prometheus planning instructions could not be loaded (${detail}).`, "error");
      return `${PLANNING_PREAMBLE}\n\n${agentBlock}\n${guidance}\n\n${reviewPolicy}`;
    }
  };

  const atlasBlock = async (ctx: ExtensionContext, record: SessionRecord): Promise<string> => {
    const planPath = record.planFilePath ?? "unavailable (retain the inline native plan and report this recovery limitation)";
    const taskIssue =
      provenanceBlockReason("task") ??
      (pi.getActiveTools().includes("task") ? undefined : "the native task tool is disabled in this session");
    const capability = taskIssue
      ? `\n\n<capability-block>The required native task tool is unavailable: ${taskIssue}. Report this blocker; do not implement in the parent.</capability-block>`
      : "";
    const ledger = await readLedger(ctx, record);
    const ledgerBlock = ledger
      ? `\n\n<execution-ledger path="${record.ledgerPath}">\n${ledgerSummary(ledger)}\n</execution-ledger>`
      : `\n\n<execution-ledger status="paused">${pauseMessage(record)}</execution-ledger>`;
    const workspace = (await isGitWorkTree(ctx.cwd)) ? "" : `\n\n${NON_GIT_EXECUTION}`;
    const header = `${EXECUTION_PREAMBLE}\n\n<approved-plan-reference path="${planPath}" provenance="native-xd-propose" />${ledgerBlock}${capability}${workspace}`;
    try {
      return `${header}\n\n${loadPromptAsset(ATLAS_ASSET)}`;
    } catch (error) {
      const detail = errorMessage(error);
      pi.logger.warn("prometheus Atlas asset became unavailable", { error: detail });
      notify(ctx, `Prometheus could not load the Atlas asset (${detail}); the execution guard remains active.`, "error");
      return header;
    }
  };

  const enterExecution = async (ctx: ExtensionContext, record: SessionRecord, handoff?: string): Promise<void> => {
    if (record.phase !== "planning") return;
    const { planFilePath: sourcePlanPath, planSha256, sourceSessionId, proposedByToolCallId } = record;
    record.phase = "executing";
    const activation = {};
    record.activation = activation;
    record.pendingConsent = undefined;
    record.proposalAwaitingApproval = false;
    record.approvalCompactionPending = false;
    record.offeredForModeEntryId = undefined;
    record.offerPendingForModeEntryId = undefined;
    record.planningModeEntryId = undefined;
    record.lastContinuationLedgerStamp = undefined;
    record.stallCount = 0;
    persist(ctx, record);
    try {
      const live = mainSession(ctx);
      if (!sourcePlanPath?.startsWith("local://") || !sourceSessionId || !proposedByToolCallId || !planSha256) {
        throw new Error("Legacy or incomplete proposal provenance requires fresh native reapproval; existing artifacts are preserved");
      }
      if (!live || live.getPlanModeState()?.enabled === true || !planReferencesMatch(live.getPlanReferencePath(), sourcePlanPath)) {
        throw new Error("the native approved plan reference is unavailable or changed");
      }
      const content = await fs.readFile(resolveLocalUrlToPath(sourcePlanPath, localOptions(ctx)), "utf8");
      if (planDigest(content) !== planSha256 || (handoff !== undefined && !inlinesApprovedPlan(handoff, sourcePlanPath, content))) {
        throw new Error("the approved plan differs from the exact native proposal");
      }
      if (record.phase !== "executing" || record.activation !== activation) throw new Error("Atlas exited before shared approval storage");
      const store = storeFor(ctx);
      const plan = await store.create({
        name: path.posix.basename(sourcePlanPath).replace(/(?:-plan)?\.md$/, ""),
        content,
        cwd: await fs.realpath(ctx.cwd),
        sourcePlanPath,
        sourceSessionId,
        proposedByToolCallId,
        availableAgents: availableAgents(),
        roadmapStage: record.roadmapStage,
      });
      if (record.phase !== "executing" || record.activation !== activation)
        throw new Error("Atlas exited while the approved plan was being stored");
      record.atlasPlanId = plan.id;
      persist(ctx, record);
      await bindPlan(ctx, record, store, plan, false);
      retitleSession(ctx, plan, content);
      notify(ctx, `${EXECUTION_START_NOTICE} Plan: ${plan.name} (${plan.id}).`);
    } catch (error) {
      if (record.activation === activation) {
        record.ledgerError = errorMessage(error);
        publishState(ctx);
        notify(ctx, pauseMessage(record), "error");
      }
    }
  };

  pi.on("input", async (event, ctx) => {
    const live = mainSession(ctx);
    if (live) restoreApprovalTiers(live);
    const current = records.get(ctx.sessionManager.getSessionId()) ?? rehydrate(ctx);
    if (current && event.source !== "extension") current.stallCount = 0;
    const atlas = parseAtlasCommand(event.text);
    if (atlas) {
      // Plan selectors run here; the registered command handles the rest.
      // The dispatch menu and session-switching resume need the host command context, which only the registered command gets.
      const needsCommandContext = !atlas.selector || parseAtlasSubcommand(atlas.selector).kind === "resume";
      if (needsCommandContext && event.source === "interactive" && current?.phase !== "executing") return undefined;
      await atlasCommand(atlas.selector, ctx);
      return { handled: true };
    }
    if (current?.phase === "executing" && /^\/(?:prometheus|plan)(?:[ \t]|$)/.test(event.text.trim())) {
      notify(ctx, "Atlas is active. Run /atlas exit before entering or changing planning mode.", "error");
      return { handled: true };
    }
    const command = parsePrometheusCommand(event.text);
    if (!command) {
      const trimmed = event.text.trim();
      if (trimmed.startsWith("/") && current?.phase === "planning") current.proposalAwaitingApproval = false;
      if (trimmed.startsWith("/") && current?.phase === "planning") current.approvalCompactionPending = false;
      if (trimmed.startsWith("/") && current?.phase === "planning") publishState(ctx);
      if (/^\/plan(?:[ \t]|$)/.test(trimmed)) {
        const record = current ?? rehydrate(ctx);
        if (live?.getPlanModeState()?.enabled === true && record?.phase === "planning") {
          record.phase = "idle";
          await clearProposalMarker(ctx, record.planFilePath);
          record.planFilePath = undefined;
          record.roadmapStage = undefined;
          record.proposedByToolCallId = undefined;
          record.planningModeEntryId = undefined;
          record.pendingConsent = undefined;
          record.proposalAwaitingApproval = false;
          record.approvalCompactionPending = false;
          record.offerPendingForModeEntryId = undefined;
          persist(ctx, record);
          await syncTools(false, false, false);
        }
      }
      return undefined;
    }
    if (!live) {
      notify(ctx, "Prometheus requires the registered main session; this host/session cannot enter it.", "error");
      return { handled: true };
    }
    const record = records.get(ctx.sessionManager.getSessionId()) ?? rehydrate(ctx);
    const planModeActive = live.getPlanModeState()?.enabled === true;
    if (record?.phase === "planning") {
      await release(ctx, "/prometheus", "planning");
      return planModeActive ? { text: "/plan" } : { handled: true };
    }
    if (planModeDisabled(live)) {
      notify(ctx, PLAN_MODE_DISABLED, "error");
      return { handled: true };
    }
    if (!(await activate(ctx))) return { handled: true };
    if (planModeActive) {
      notify(ctx, "Prometheus planning is active in this native plan-mode session.");
      return command.prompt ? { text: command.prompt } : { handled: true };
    }
    notify(ctx, "Prometheus planning is active — entering native plan mode.");
    return { text: command.prompt ? `/plan ${command.prompt}` : "/plan" };
  });

  const commandHandler = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const prompt = args.trim();
    const live = mainSession(ctx);
    if (!live) {
      commandNotice(ctx, "Prometheus requires the registered main session and is unavailable in this host/session.", "error");
      return;
    }
    const record = records.get(ctx.sessionManager.getSessionId()) ?? rehydrate(ctx);
    if (record?.phase === "executing") {
      commandNotice(ctx, "Atlas is active. /prometheus cannot release it; run /atlas exit.", "error");
      return;
    }
    if (record?.phase === "planning") {
      await release(ctx, "/prometheus", "planning");
      return;
    }
    if (planModeDisabled(live)) {
      commandNotice(ctx, PLAN_MODE_DISABLED, "error");
      return;
    }
    if (live.getPlanModeState()?.enabled !== true) {
      commandNotice(
        ctx,
        `Prometheus cannot enter native plan mode through a ${ctx.mode} extension command. Enter native /plan first, then run /prometheus.`,
        "error",
      );
      return;
    }
    if (!(await activate(ctx))) return;
    if (prompt) pi.sendUserMessage(prompt);
    notify(ctx, "Prometheus planning is active in this native plan-mode session.");
  };

  pi.registerCommand("prometheus", {
    description:
      "[request]: toggle Prometheus planning mode (Metis, Momus); when entering, a request is sent as the first planning message",
    handler: commandHandler,
  });

  pi.registerCommand("atlas", {
    description: "Open Atlas Dispatch, enter an approved plan, or view the running plan; /atlas exit leaves Atlas",
    getArgumentCompletions: (prefix) => atlasArgumentCompletions(prefix, atlasPlans),
    handler: atlasCommand,
  });

  const z = pi.zod;
  const activateParameters = z.object({
    questionId: z.literal(PROMETHEUS_OPT_IN_QUESTION_ID),
    selectedOptionIndex: z.literal(PROMETHEUS_DEEP_OPTION_INDEX),
  });
  const releaseParameters = z.object({
    reason: z.string().describe("Concise summary of completed child-produced evidence shown to the user before release"),
  });
  const ledgerParameters = z.object({
    action: z
      .enum(["status", "start", "done", "verify", "block", "reopen", "fix", "discover", "triage"])
      .describe(
        "status shows every row; start, done, block, and reopen change the row named by id; verify binds a fresh verifier to the HEAVY row named by id once its implementation is done; fix appends an X row for the rejecting gate named by id; discover records work found while executing the row named by id: scope in appends a D row, scope out records a deferred finding O1, O2, …; triage records the disposition of the deferred finding named by id",
      ),
    id: z
      .string()
      .optional()
      .describe(
        "Row id such as T3, D1, X1, F2, or P1, or a deferred finding id such as O2 for triage; required for every action except status and an out-of-scope discover",
      ),
    evidence: z
      .string()
      .optional()
      .describe(
        "Inspected observable evidence; required for done, block, fix (the gate's rejection), and discover (why the finding is in or out of scope). triage: the reference (todo: the Roadmap TODO id; duplicate: what it duplicates; wontfix: the reason; report: optional note). Gate and verifier verdicts are read from native child output, not this text",
      ),
    childAgentId: z
      .string()
      .optional()
      .describe("Required for done: exact id of the owned native child dispatched for this started attempt or verification"),
    title: z.string().optional().describe("Required for fix and discover: the correction or finding"),
    acceptance: z.string().optional().describe("Required for fix and in-scope discover: the observable check that proves the work"),
    scope: z
      .enum(["in", "out"])
      .optional()
      .describe("Required for discover: in = a defect inside this change's blast radius (new D row); out = outside it (deferred, no row)"),
    tier: z
      .enum(["LIGHT", "HEAVY"])
      .optional()
      .describe(
        "fix and in-scope discover: HEAVY for auth, security, migrations, concurrency, persistence formats, public API, or data-loss risk (default LIGHT)",
      ),
    agent: z
      .string()
      .optional()
      .describe(
        "fix and discover: agent that performs the work (default task). verify: the verifier agent (default deep-high, falling back to task). start: the listed agent to dispatch when the row shows unavailable, i.e. neither its requested agent nor a fallback can be spawned; pick the most specific fit for the row's work",
      ),
    disposition: z
      .enum(["todo", "duplicate", "wontfix", "report"])
      .optional()
      .describe(
        "Required for triage: todo = you created a Roadmap TODO with roadmap_todo add (roadmap usable in this repository); duplicate = already tracked elsewhere; wontfix = deliberately not pursued; report = only listed in the final report (no roadmap usable in this repository)",
      ),
  });
  type LedgerParams = {
    action: "status" | "start" | "done" | "verify" | "block" | "reopen" | "fix" | "discover" | "triage";
    id?: string;
    evidence?: string;
    childAgentId?: string;
    title?: string;
    acceptance?: string;
    scope?: "in" | "out";
    tier?: "LIGHT" | "HEAVY";
    agent?: string;
    disposition?: "todo" | "duplicate" | "wontfix" | "report";
  };

  pi.registerTool({
    name: ACTIVATE_TOOL,
    sourcePath: RUNTIME_SOURCE_PATH,
    label: "Prometheus Activate",
    description:
      "Activate Prometheus only after the immediately preceding native ask result records explicit option-index consent for the fixed Prometheus question.",
    parameters: activateParameters,
    defaultInactive: true,
    loadMode: "essential",
    approval: "read",
    execute: async (
      toolCallId,
      _params: { questionId: typeof PROMETHEUS_OPT_IN_QUESTION_ID; selectedOptionIndex: typeof PROMETHEUS_DEEP_OPTION_INDEX },
      _signal,
      _onUpdate,
      ctx,
    ) => {
      const consentAskToolCallId = authorizedActivationCalls.get(toolCallId);
      authorizedActivationCalls.delete(toolCallId);
      if (!consentAskToolCallId) {
        return {
          content: [{ type: "text" as const, text: "Prometheus activation has no correlated explicit native ask consent." }],
          isError: true,
          details: {},
        };
      }
      const live = mainSession(ctx);
      if (!live || !ctx.hasUI || live.getPlanModeState()?.enabled !== true) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Prometheus activation requires the interactive main session with active native plan mode.",
            },
          ],
          isError: true,
          details: {},
        };
      }
      if (!(await activate(ctx))) {
        return {
          content: [{ type: "text" as const, text: "Prometheus prompt assets are unavailable; activation was refused." }],
          isError: true,
          details: {},
        };
      }
      await syncTools(false, false, false);
      return {
        content: [
          {
            type: "text" as const,
            text: "Prometheus activated. The complete workflow is injected for the next model step and subsequent planning turns.",
          },
        ],
        details: {
          questionId: PROMETHEUS_OPT_IN_QUESTION_ID,
          selectedOptionIndex: PROMETHEUS_DEEP_OPTION_INDEX,
          consentAskToolCallId,
        },
      };
    },
  });

  pi.registerTool({
    name: RELEASE_TOOL,
    sourcePath: RUNTIME_SOURCE_PATH,
    label: "Atlas Release",
    description:
      "After every delegated plan item and final gate has verified child evidence, request human confirmation to release Atlas. Refused while execution-ledger rows remain unfinished or any deferred finding lacks a triage; never releases without confirmation.",
    parameters: releaseParameters,
    defaultInactive: true,
    loadMode: "essential",
    approval: "read",
    execute: async (_toolCallId, params: { reason: string }, _signal, _onUpdate, ctx) => {
      const live = mainSession(ctx);
      const record = records.get(ctx.sessionManager.getSessionId()) ?? rehydrate(ctx);
      if (!live || record?.phase !== "executing") {
        return {
          content: [{ type: "text" as const, text: "Atlas execution is not active in this main session." }],
          isError: true,
          details: {},
        };
      }
      const ownership = record.ownership;
      const ledger = await readLedger(ctx, record);
      if (!ledger) return { content: [{ type: "text" as const, text: pauseMessage(record) }], isError: true, details: {} };
      if (!isComplete(ledger)) {
        const unfinished = ledgerRows(ledger).filter((item) => item.status !== "done");
        return {
          content: [
            {
              type: "text" as const,
              text: `Release refused: unfinished ledger rows remain (${unfinished.map((item) => `${item.id} ${item.status}`).join(", ")}). Keep delegating.\n\n${ledgerSummary(ledger)}`,
            },
          ],
          isError: true,
          details: {},
        };
      }
      const untriaged = untriagedFindings(ledger);
      if (untriaged.length) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Release refused: deferred findings still lack a triage (${untriaged.map((finding) => `${finding.id} ${finding.title}`).join("; ")}). Record each one's disposition with atlas_ledger triage (create a Roadmap TODO with roadmap_todo add first when the roadmap is usable in this repository), then list every finding with its disposition in the final report.\n\n${ledgerSummary(ledger)}`,
            },
          ],
          isError: true,
          details: { untriaged: untriaged.map((finding) => finding.id) },
        };
      }
      if (!ctx.hasUI) {
        return {
          content: [{ type: "text" as const, text: "No confirmation UI is available. Ask the user to run /atlas exit." }],
          isError: true,
          details: {},
        };
      }
      let confirmed = false;
      try {
        confirmed = await ctx.ui.confirm(
          "Exit Atlas execution?",
          `${params.reason.trim()}\n\nRelease restores direct implementation tools and ends Atlas delegation in this session.`,
        );
      } catch (error) {
        pi.logger.warn("prometheus release confirmation failed", { error: errorMessage(error) });
      }
      if (!confirmed) {
        return {
          content: [{ type: "text" as const, text: "The user did not release the guard. Keep delegating." }],
          isError: true,
          details: {},
        };
      }
      try {
        if (record.ownership !== ownership) throw new Error("The Atlas attachment changed while awaiting confirmation");
        await withExecutionLedger(ctx, record, (current) => {
          if (!isComplete(current)) throw new Error("Completion evidence changed while awaiting confirmation; release refused");
          if (untriagedFindings(current).length) throw new Error("A deferred finding lost its triage while awaiting confirmation");
        });
        if (record.ownership !== ownership) throw new Error("The Atlas attachment changed during confirmation");
        await release(ctx, "human-confirmed completion release", "executing");
        return {
          content: [{ type: "text" as const, text: "Atlas exited by the user; shared evidence and progress are preserved." }],
          details: {},
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Release refused: ${errorMessage(error)}` }], isError: true, details: {} };
      }
    },
  });

  pi.registerTool({
    name: LEDGER_TOOL,
    sourcePath: RUNTIME_SOURCE_PATH,
    label: "Atlas Ledger",
    description:
      "Read or update the shared approved execution ledger. Start a row BEFORE task dispatch and copy its atlas_assignment binding. Done requires its real native child's final successful result and inspected evidence; verified outputs are copied into shared storage. A HEAVY row's done records its implementation; verify then binds a distinct fresh verifier child with structured output, and only its PASS completes the row (FAIL reopens it with the verifier's summary). Gates F1–F4 run together and require distinct fresh children with structured PASS output. When a gate rejects, fix appends an X correction row and reopens only that gate. Before any gate starts, discover scope in appends a D row every gate waits for; discover scope out records a deferred finding O1, O2, … for the final report, and triage records each one's disposition (atlas_release waits for every triage). P1 delivers after every gate. Reopen/block affect only the named row.",
    parameters: ledgerParameters,
    defaultInactive: true,
    loadMode: "essential",
    approval: "read",
    execute: async (_toolCallId, params: LedgerParams, _signal, _onUpdate, ctx) => {
      const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true, details: {} });
      const record = records.get(ctx.sessionManager.getSessionId()) ?? rehydrate(ctx);
      if (!mainSession(ctx) || record?.phase !== "executing") return fail("Atlas execution is not active in this main session.");
      const ownership = record.ownership;
      let changedRow: LedgerItem | undefined;
      let completion: Omit<AtlasCompleted, "v" | "at"> | undefined;
      let completedPlan: AtlasPlan | undefined;
      let compliance: { cwd: string; baseline?: string; since: number } | undefined;
      try {
        const result = await withExecutionLedger(ctx, record, async (ledger, plan, store) => {
          const wasComplete = isComplete(ledger);
          if (params.action === "status") return { content: [{ type: "text" as const, text: ledgerSummary(ledger) }], details: { ledger } };
          const id = params.id?.trim();
          const evidence = params.evidence?.trim();
          if (params.action === "discover" && params.scope === "out") {
            const finding = addDeferredFinding(ledger, { title: params.title ?? "", reason: evidence ?? "", origin: id });
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Deferred out of scope as ${finding.id}: ${finding.title}. No row waits for it. Triage it with atlas_ledger triage before release, and list it with its disposition in the final report.\n\n${ledgerSummary(ledger)}`,
                },
              ],
              details: { id: finding.id, deferred: ledger.deferred.length },
            };
          }
          if (params.action === "triage") {
            // Asked afresh: a roadmap initialized during execution becomes usable. No answer means no roadmap at all.
            const binding = roadmap.requestBinding(ctx.sessionManager.getSessionId());
            const finding = triageFinding(ledger, id ?? "", params.disposition, evidence, binding ? binding.usable : false);
            const remaining = untriagedFindings(ledger).map((entry) => entry.id);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `${finding.id} triaged as ${finding.triage?.disposition}${finding.triage?.reference ? ` (${finding.triage.reference})` : ""}. Untriaged findings: ${remaining.join(", ") || "none"}.\n\n${ledgerSummary(ledger)}`,
                },
              ],
              details: { id: finding.id, triage: finding.triage },
            };
          }
          const item = ledgerRows(ledger).find((entry) => entry.id === id);
          if (!item) throw new Error(`Unknown ledger row ${id || "(missing id)"}`);
          let schema: Record<string, unknown> | undefined;
          let planBinding = "";
          let note = "";
          if (params.action === "discover") {
            if (params.scope !== "in") throw new Error("discover requires scope in (a D row) or out (a deferred finding)");
            const found = addDiscoveredRow(
              ledger,
              item.id,
              {
                title: params.title ?? "",
                acceptance: params.acceptance ?? "",
                agent: params.agent?.trim() || "task",
                reason: evidence ?? "",
                tier: params.tier,
              },
              availableAgents(),
            );
            changedRow = found;
            return {
              content: [
                {
                  type: "text" as const,
                  text: `${found.id} records in-scope work found during ${item.id}; it can dispatch now and every gate waits for it.\n\n${ledgerSummary(ledger, found.id)}`,
                },
              ],
              details: { id: found.id, status: found.status, origin: item.id },
            };
          }
          if (params.action === "fix") {
            const fix = addFixRow(
              ledger,
              item.id,
              {
                title: params.title ?? "",
                acceptance: params.acceptance ?? "",
                agent: params.agent?.trim() || "task",
                reason: evidence ?? "",
                tier: params.tier,
              },
              availableAgents(),
            );
            changedRow = fix;
            return {
              content: [
                {
                  type: "text" as const,
                  text: `${fix.id} records the correction for ${item.id}; ${item.id} reopens once ${item.dependsOn.filter((row) => row.startsWith("X")).join(", ")} are done.\n\n${ledgerSummary(ledger, fix.id)}`,
                },
              ],
              details: { id: fix.id, status: fix.status, gate: item.id },
            };
          }
          if (params.action === "start") {
            if (item.id === "F1") {
              // Git runs after the ledger lock is released; an unrecorded baseline is dated by the earliest execution start.
              const starts = ledgerRows(ledger).flatMap((row) => (row.startedAt === undefined ? [] : [row.startedAt]));
              compliance = { cwd: plan.cwd, baseline: ledger.gitBaseline, since: starts.length ? Math.min(...starts) : ledger.createdAt };
              planBinding = `\nF1 plan binding (copy literally; never inline the plan text): review_kind: compliance; absolute_plan_path: ${plan.planFilePath}`;
            }
            startRow(ledger, item.id, params.agent?.trim() || undefined, availableAgents());
            if (item.id.startsWith("F")) schema = gateOutputSchema(ledger, item);
            if (item.tier === "heavy") {
              note = `\n${item.id} is HEAVY: mark its implementation child done, then bind a distinct fresh verifier with atlas_ledger verify.`;
              if (item.verification?.verdict === "fail") {
                note += `\nIts previous verification failed; give this to the implementation child: ${item.verification.summary ?? ""}`;
              }
            }
          } else if (params.action === "verify") {
            startVerification(ledger, item.id, params.agent?.trim() || undefined, availableAgents());
            schema = verifyOutputSchema(ledger, item);
            planBinding = `\nVerifier binding for a fresh ${item.verification?.dispatchAgent} child (copy literally): atlas_assignment: ${JSON.stringify({ planSha256: ledger.planSha256, verify: { [item.id]: item.verification?.attempt } })}`;
          } else if (params.action === "done") {
            const childAgentId = params.childAgentId?.trim();
            if (!evidence || !childAgentId) throw new Error(`Marking ${item.id} done requires inspected evidence and childAgentId`);
            const verifying = item.tier === "heavy" && item.receipt !== undefined;
            if (verifying && (item.verification?.attempt === undefined || item.verification.verdict !== undefined)) {
              throw new Error(`${item.id} implementation is already recorded; bind its verifier with atlas_ledger verify first`);
            }
            const parent = AgentRegistry.global()
              .list()
              .find((candidate) => candidate.kind === "main" && candidate.session?.sessionManager === ctx.sessionManager);
            if (!parent) throw new Error("Registered parent identity is unavailable");
            observeFinalJobs(ctx);
            const nativeOutput = path.join(ctx.sessionManager.getArtifactsDir() as string, `${childAgentId}.md`);
            const { receipt, output } = await childEvidence.capture({
              registry: AgentRegistry.global(),
              parentAgentId: parent.id,
              sessionId: ctx.sessionManager.getSessionId(),
              artifactsDir: ctx.sessionManager.getArtifactsDir() as string,
              ledger,
              row: item,
              childAgentId,
              priorReceipts: ledgerRows(ledger).flatMap((row) => [
                ...(row.receipt ? [row.receipt] : []),
                ...(row.verification?.receipt ? [row.verification.receipt] : []),
              ]),
              verify: verifying,
            });
            if (record.ownership !== ownership || ownership?.detached) throw new Error("Atlas exited during child evidence capture");
            const archived = `${path.join(plan.directory, "evidence", `${receipt.receiptId}.md`)}: ${evidence}`;
            const verdict = verifying ? parseVerifyOutput(output, ledger, item) : undefined;
            if (verdict?.verdict === "INCONCLUSIVE") {
              throw new Error(
                `${item.id} verification was inconclusive: ${verdict.summary}. Bind a fresh verifier with atlas_ledger verify, or reopen or block the row`,
              );
            }
            if (verdict?.verdict === "FAIL") {
              recordVerification(ledger, item, { verdict: "fail", childAgentId, summary: verdict.summary });
              note = `\n${item.id} verification failed, so the row is open again. Start a new implementation attempt and give its child this failure: ${verdict.summary}`;
            } else {
              // Only authenticated final native results can publish shared immutable proof.
              await store.saveReceipt(plan, receipt, nativeOutput);
              if (record.ownership !== ownership || ownership?.detached) throw new Error("Atlas exited while child evidence was copied");
              if (verdict) recordVerification(ledger, item, { verdict: "pass", receipt, summary: verdict.summary, evidence: archived });
              else recordReceipt(item, receipt, archived);
              if (item.status === "in_progress") {
                note = `\n${item.id} is HEAVY: its implementation is recorded. Bind a distinct fresh verifier with atlas_ledger verify id=${item.id}.`;
              }
            }
            const completedNow = !wasComplete && isComplete(ledger);
            if (completedNow) completedPlan = plan;
            // A plan proposed before its stage was started has no approved stage; the executing session's live binding stands in.
            const liveStage = completedNow && !plan.roadmapStage ? roadmap.requestBinding(ctx.sessionManager.getSessionId()) : undefined;
            const approvedStage = plan.roadmapStage;
            const roadmapStage = approvedStage
              ? { repoRoot: approvedStage.repoRoot, id: approvedStage.id }
              : liveStage?.stage
                ? { repoRoot: liveStage.repoRoot, id: liveStage.stage.id }
                : undefined;
            if (completedNow && roadmapStage) {
              const delivery = deliveryResult(ledger, plan.directory);
              completion = {
                sessionId: ctx.sessionManager.getSessionId(),
                planId: plan.id,
                roadmapStage,
                gates: gateResults(ledger, plan.directory),
                ...(delivery ? { delivery } : {}),
              };
            }
          } else {
            if (params.action === "block" && !evidence) throw new Error("Blocking a row requires an explanation");
            if ((params.action === "reopen" && item.status === "open") || (params.action === "block" && item.status === "blocked")) {
              throw new Error(`${item.id} is already ${item.status}`);
            }
            reopenRow(ledger, item.id, evidence);
            if (params.action === "block") item.status = "blocked";
          }
          changedRow = item;
          const schemaLabel = params.action === "verify" ? "Verifier task outputSchema" : "Gate task outputSchema";
          return {
            content: [
              {
                type: "text" as const,
                text: `${item.id} is now ${item.status}.${note}\n\n${ledgerSummary(ledger, item.id)}${schema ? `\n${schemaLabel} (use schemaMode strict): ${JSON.stringify(schema)}` : ""}${planBinding}`,
              },
            ],
            details: { id: item.id, status: item.status, outputSchema: schema },
          };
        });
        if (completion) roadmap.emitCompleted(completion);
        const drift = completedPlan && stageDriftNotice(ctx, completedPlan);
        if (drift) notify(ctx, drift, "warning");
        const gitEvidence = compliance && (await collectComplianceEvidence(compliance));
        if (changedRow) {
          const refresh = atlasTodoRefreshCall(changedRow);
          if (pi.getActiveTools().includes("todo")) pendingTodoRefreshes.set(ctx.sessionManager.getSessionId(), refresh);
          return {
            ...result,
            content: [
              { type: "text" as const, text: refresh },
              ...result.content,
              ...(drift ? [{ type: "text" as const, text: `${drift} Name this in the final report.` }] : []),
              ...(gitEvidence ? [{ type: "text" as const, text: gitEvidence.text }] : []),
            ],
            details: gitEvidence ? { ...result.details, complianceEvidence: gitEvidence } : result.details,
          };
        }
        return result;
      } catch (error) {
        return fail(
          `Ledger operation refused: ${errorMessage(error)}. Execution requires a valid shared approved ledger; /atlas exit remains the user exit.`,
        );
      }
    },
  });

  const gitParameters = z.object({
    action: z
      .enum(["status", "diff", "log", "show", "commit"])
      .describe("status, diff, log and show inspect the repository; commit commits exactly the named files"),
    revision: z.string().optional().describe("diff: revision or A..B range; log: revision range; show: the revision"),
    paths: z.array(z.string()).optional().describe("diff/log: limit to these paths; commit: every file to commit, by name"),
    staged: z.boolean().optional().describe("diff: staged changes instead of unstaged ones"),
    stat: z.boolean().optional().describe("diff/show: a diffstat instead of the patch"),
    count: z.number().int().optional().describe("log: number of commits, 1-200, default 20"),
    message: z.string().optional().describe("commit: the commit message, following the project's and user's commit rules"),
  });

  pi.registerTool({
    name: GIT_TOOL,
    sourcePath: RUNTIME_SOURCE_PATH,
    label: "Atlas Git",
    description:
      "Git for the Atlas main session only; there is no shell. status, diff, log and show inspect the repository. commit stages and commits exactly the files named in paths (no directories, no globs) with your message; it is refused while any bound child task is still running. Commit roadmap documents you changed, and finished child work a child left uncommitted. Hooks run; a failed hook leaves the files staged.",
    parameters: gitParameters,
    defaultInactive: true,
    loadMode: "essential",
    approval: (args: unknown) =>
      args && typeof args === "object" && "action" in args && args.action === "commit"
        ? { tier: "write", reason: "commits files" }
        : "read",
    execute: async (_toolCallId, params: typeof gitParameters.infer, signal, _onUpdate, ctx) => {
      const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true, details: {} });
      const record = records.get(ctx.sessionManager.getSessionId()) ?? rehydrate(ctx);
      const live = mainSession(ctx);
      if (ctx.agent.kind !== "main" || !live || record?.phase !== "executing") {
        return fail(`${GIT_TOOL} belongs to the Atlas main session while it executes a plan.`);
      }
      const ownership = record.ownership;
      if (!ownership || !(await readLedger(ctx, record))) return fail(pauseMessage(record));
      if (!(await isGitWorkTree(ctx.cwd))) {
        return fail(
          "This workspace is not a Git repository, and Atlas never uses or creates one here. Nothing to inspect or commit; skip Git steps.",
        );
      }
      if (params.action === "commit") {
        observeNativeJobs(ownership.sessionId, ownership.live, ownership.parentAgentId);
        if (childEvidence.hasPending(ownership.sessionId, ownership.ledgerId)) {
          return fail("Commit refused: a bound child task is still running and may be writing these files. Commit after it finishes.");
        }
      }
      const result = await runAtlasGit(ctx.cwd, params, signal);
      return { content: [{ type: "text" as const, text: result.text }], isError: !result.ok, details: {} };
    },
  });

  const recoverCompactHandoff = async (ctx: ExtensionContext, record: SessionRecord, prompt: string): Promise<void> => {
    const live = mainSession(ctx);
    const owned = record.phase === "executing" ? record.ownership : undefined;
    if (
      !record.compactHandoffPending ||
      !live ||
      !owned ||
      owned.detached ||
      live.getPlanModeState()?.enabled === true ||
      !isApprovedPlanHandoff(prompt, owned.plan.sourcePlanPath, live.getPlanReferencePath())
    )
      return;
    try {
      const approvedContent = await fs.readFile(owned.plan.planFilePath, "utf8");
      if (planDigest(approvedContent) !== owned.plan.planSha256 || !inlinesApprovedPlan(prompt, owned.plan.sourcePlanPath, approvedContent))
        throw new Error("the compact approval handoff differs from the exact approved plan");
      const approved = await owned.store.find(owned.plan.id);
      if (
        approved.planSha256 !== owned.plan.planSha256 ||
        approved.sourcePlanPath !== owned.plan.sourcePlanPath ||
        approved.sourceSessionId !== owned.plan.sourceSessionId ||
        approved.proposedByToolCallId !== owned.plan.proposedByToolCallId ||
        record.ownership !== owned
      )
        throw new Error("the compact approval handoff no longer matches the owned shared approval");
      // Approve+compact may reset the shared binding before a normal prompt or a queued
      // synthetic developer turn. Both paths revalidate this same single-use native transition.
      await bindPlan(ctx, record, owned.store, approved, false, owned.plan.sourcePlanPath);
      record.compactHandoffPending = false;
    } catch (error) {
      record.ledgerError = errorMessage(error);
      notify(ctx, pauseMessage(record), "error");
    }
  };

  pi.on("before_agent_start", async (event, ctx) => {
    const live = mainSession(ctx);
    if (!live) return undefined;
    restoreApprovalTiers(live);
    const sessionId = ctx.sessionManager.getSessionId();
    let record = records.get(sessionId) ?? rehydrate(ctx);
    const reference = live.getPlanReferencePath();
    if (record) await recoverCompactHandoff(ctx, record, event.prompt);
    if ((!record || record.phase === "idle") && reference && isApprovedPlanHandoff(event.prompt, reference, reference)) {
      try {
        const marker = JSON.parse(
          await fs.readFile(resolveLocalUrlToPath(prometheusArtifactUrl(reference), localOptions(ctx)), "utf8"),
        ) as {
          version?: unknown;
          planFilePath?: unknown;
          planSha256?: unknown;
          proposedByToolCallId?: unknown;
          sourceSessionId?: unknown;
          roadmapStage?: unknown;
        };
        // A present but invalid plugin marker must pause this handoff, not silently become ordinary execution.
        if (
          // Version 4 adds the stage's declared criteria and revision; version 3 markers still resume without them.
          (marker.version !== 3 && marker.version !== 4) ||
          typeof marker.planFilePath !== "string" ||
          !planReferencesMatch(marker.planFilePath, reference) ||
          typeof marker.proposedByToolCallId !== "string" ||
          !marker.proposedByToolCallId ||
          typeof marker.sourceSessionId !== "string" ||
          !marker.sourceSessionId
        )
          throw new Error("Invalid Prometheus proposal marker");
        record = {
          phase: "planning",
          planFilePath: reference,
          planSha256: typeof marker.planSha256 === "string" && /^[a-f0-9]{64}$/.test(marker.planSha256) ? marker.planSha256 : undefined,
          proposedByToolCallId: marker.proposedByToolCallId,
          sourceSessionId: marker.sourceSessionId,
          roadmapStage: isRoadmapStage(marker.roadmapStage) ? marker.roadmapStage : undefined,
          lastBlockedAt: 0,
          stallCount: 0,
        };
        records.set(sessionId, record);
      } catch (error) {
        // No marker means an ordinary native plan approval, which stays untouched.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          pi.logger.warn("prometheus could not read the proposal marker", { error: errorMessage(error) });
          record = { phase: "planning", planFilePath: reference, lastBlockedAt: 0, stallCount: 0 };
          records.set(sessionId, record);
        }
      }
    }

    const planModeActive = live.getPlanModeState()?.enabled === true;
    if (record?.phase === "planning" && planModeActive) {
      const episodeId = planModeEpisodeId(ctx);
      if (record.planningModeEntryId && episodeId && record.planningModeEntryId !== episodeId) {
        record.phase = "idle";
        record.planFilePath = undefined;
        record.roadmapStage = undefined;
        record.proposedByToolCallId = undefined;
        record.planningModeEntryId = undefined;
        record.pendingConsent = undefined;
        record.proposalAwaitingApproval = false;
        record.approvalCompactionPending = false;
        record.offerPendingForModeEntryId = undefined;
        persist(ctx, record);
      } else if (!record.planningModeEntryId && episodeId) {
        record.planningModeEntryId = episodeId;
        persist(ctx, record);
      }
    }
    if (
      record?.phase === "planning" &&
      !planModeActive &&
      record.approvalCompactionPending === true &&
      planReferencesMatch(live.getPlanReferencePath(), record.planFilePath)
    ) {
      record.compactHandoffPending = true;
      await enterExecution(ctx, record);
    }
    let injected: string | undefined;
    let wantActivate = false;
    let executing = record?.phase === "executing";

    if (record?.phase === "planning") {
      if (planModeActive) {
        injected = await planningBlock(ctx);
      } else if (isApprovedPlanHandoff(event.prompt, record.planFilePath, live.getPlanReferencePath())) {
        await enterExecution(ctx, record, event.prompt);
        executing = true;
      } else {
        await clearProposalMarker(ctx, record.planFilePath);
        record.phase = "idle";
        record.planFilePath = undefined;
        record.roadmapStage = undefined;
        record.proposedByToolCallId = undefined;
        record.planningModeEntryId = undefined;
        record.pendingConsent = undefined;
        record.proposalAwaitingApproval = false;
        record.approvalCompactionPending = false;
        record.offerPendingForModeEntryId = undefined;
        persist(ctx, record);
      }
    } else if (!executing && planModeActive) {
      const episodeId = planModeEpisodeId(ctx);
      const tracked = record ?? recordFor(sessionId);
      if (episodeId && tracked.suppressedForModeEntryId !== episodeId) {
        wantActivate = true;
        if (tracked.offeredForModeEntryId !== episodeId) {
          tracked.offerPendingForModeEntryId = episodeId;
          injected = OPT_IN_ADDENDUM;
        }
      }
    }

    if (executing && record) {
      injected = await atlasBlock(ctx, record);
    }

    await syncTools(wantActivate, executing, executing);
    if (!injected) return undefined;
    return { systemPrompt: [...event.systemPrompt, injected] };
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!mainSession(ctx)) return;
    const record = records.get(ctx.sessionManager.getSessionId());
    if (!record?.offerPendingForModeEntryId) return;
    record.offeredForModeEntryId = record.offerPendingForModeEntryId;
    record.offerPendingForModeEntryId = undefined;
    persist(ctx, record);
  });

  pi.on("context", async (event, ctx) => {
    const live = mainSession(ctx);
    if (!live) return undefined;
    observeFinalJobs(ctx);
    const record = records.get(ctx.sessionManager.getSessionId()) ?? rehydrate(ctx);
    if (!record || (record.phase !== "planning" && record.phase !== "executing")) return undefined;
    if (record.phase === "planning" && live.getPlanModeState()?.enabled !== true) return undefined;
    if (record.phase === "executing" && record.compactHandoffPending) {
      for (const message of event.messages) {
        if (message.role !== "developer" || message.attribution !== "agent" || message.synthetic !== true) continue;
        const prompt =
          typeof message.content === "string"
            ? message.content
            : message.content.length === 1 && message.content[0]?.type === "text"
              ? message.content[0].text
              : undefined;
        if (prompt) await recoverCompactHandoff(ctx, record, prompt);
        if (!record.compactHandoffPending) break;
      }
    }

    const planning = record.phase === "planning";
    const policyHeading = planning ? "# Prometheus planning workflow (active)" : "# Atlas execution (active)";
    const policyAlreadyInSystem = ctx.getSystemPrompt().some((part) => part.includes(policyHeading));
    const content = policyAlreadyInSystem
      ? `${policyHeading}\n\nThe complete workflow policy is active in the system prompt; this message replaces conflicting native plan context.`
      : planning
        ? await planningBlock(ctx)
        : await atlasBlock(ctx, record);
    const customType = record.phase === "planning" ? PLANNING_CONTEXT_TYPE : EXECUTION_CONTEXT_TYPE;
    const policyMessage = {
      role: "custom" as const,
      customType,
      content,
      display: false,
      attribution: "agent" as const,
      timestamp: Date.now(),
    };
    const messages = [] as typeof event.messages;
    let inserted = false;
    for (const message of event.messages) {
      const replace =
        message.role === "custom" &&
        (message.customType === NATIVE_PLAN_CONTEXT_TYPE ||
          message.customType === PLANNING_CONTEXT_TYPE ||
          message.customType === EXECUTION_CONTEXT_TYPE);
      if (!replace) {
        messages.push(message);
        continue;
      }
      if (!inserted) {
        messages.push(policyMessage);
        inserted = true;
      }
    }
    if (!inserted) messages.push(policyMessage);
    return { messages };
  });

  pi.on("tool_call", async (event, ctx) => {
    const live = mainSession(ctx);
    observeFinalJobs(ctx);
    if (event.toolName === ACTIVATE_TOOL) {
      if (!live || !ctx.hasUI) return { block: true, reason: "Prometheus activation requires an interactive main session." };
      const provenance = toolProvenance(ACTIVATE_TOOL);
      if (provenance?.source !== "extension" || provenance.path !== RUNTIME_SOURCE_PATH) {
        return { block: true, reason: "Prometheus activation tool provenance is not trusted." };
      }
      const record = records.get(ctx.sessionManager.getSessionId()) ?? rehydrate(ctx);
      const params = event.input as { questionId?: unknown; selectedOptionIndex?: unknown };
      const episodeId = planModeEpisodeId(ctx);
      const consent = record?.pendingConsent;
      const authorized =
        record?.phase === "idle" &&
        live.getPlanModeState()?.enabled === true &&
        typeof episodeId === "string" &&
        consent?.modeEntryId === episodeId &&
        params.questionId === PROMETHEUS_OPT_IN_QUESTION_ID &&
        params.selectedOptionIndex === PROMETHEUS_DEEP_OPTION_INDEX;
      if (!authorized || !record || !consent) {
        return {
          block: true,
          reason: "Prometheus activation was denied: no matching non-timeout native ask selection for this plan-mode episode.",
        };
      }
      record.pendingConsent = undefined;
      authorizedActivationCalls.set(event.toolCallId, consent.askToolCallId);
      return undefined;
    }
    if (!live) return undefined;
    const record = records.get(ctx.sessionManager.getSessionId()) ?? rehydrate(ctx);
    if (event.toolName === "ask" && record) record.pendingConsent = undefined;
    if (event.toolName === "write" && record?.phase === "planning" && live.getPlanModeState()?.enabled === true) {
      const proposalDetail = await proposalGrammarBlockReason(ctx, event.input);
      if (proposalDetail) return { block: true, reason: proposalDetail };
    }
    if (event.toolName === "task") {
      const taskSpawnDetail = taskSpawnBlockReason(record?.phase, event.input);
      if (taskSpawnDetail) return { block: true, reason: taskSpawnDetail };
      if (record?.phase === "planning" && isPlanReviewDispatch(event.input)) {
        const roundDetail = await reviewRoundBlockReason(ctx, record);
        if (roundDetail) return { block: true, reason: roundDetail };
      }
    }
    if (record?.phase !== "executing") return undefined;

    const nested = event.toolName === "write" ? nestedXdevToolCall(event.input) : undefined;
    // Only the families actually called ask their plugin for a handshake; each family is trusted only through its own binding.
    const trusted: TrustedToolSources = {};
    for (const family of [trustedToolFamily(event.toolName), nested && trustedToolFamily(nested.toolName)]) {
      if (family === "roadmap") trusted.roadmap = roadmap.binding(ctx.sessionManager.getSessionId())?.toolSourcePath;
      else if (family === "adr") trusted.adr = adr.binding(ctx.sessionManager.getSessionId())?.toolSourcePath;
    }
    let detail = executionBlockReason(event.toolName, event.input, trusted);
    if (!detail) detail = provenanceBlockReason(event.toolName, trusted);
    if (!detail && nested) detail = provenanceBlockReason(nested.toolName, trusted);
    // Progress guard: the HUD only redraws on a model-made todo call, and a finished child must be recorded before Atlas moves on.
    if (!detail && (event.toolName === "task" || event.toolName === "wait" || event.toolName === RELEASE_TOOL)) {
      const sessionId = ctx.sessionManager.getSessionId();
      const refresh = pendingTodoRefreshes.get(sessionId);
      if (refresh && pi.getActiveTools().includes("todo")) {
        return {
          block: true,
          reason: `Atlas progress guard: the todo HUD still shows the rows from before the last ledger change. ${refresh}`,
        };
      }
      const ledger = event.toolName === RELEASE_TOOL ? undefined : await readLedger(ctx, record);
      const unrecorded = ledger ? childEvidence.unrecordedOutcomes(sessionId, ledger) : [];
      const replacing = event.toolName === "task" && assignedRowIds(event.input).some((id) => unrecorded.includes(id));
      if (unrecorded.length && !replacing) {
        return {
          block: true,
          reason: `Atlas progress guard: the child of ${unrecorded.join(", ")} has a final result, but the ledger still shows ${unrecorded.length === 1 ? "that row" : "those rows"} in progress. Record each first: atlas_ledger done with the inspected evidence (a verifier's verdict for a HEAVY row under verification), block with the reason, or reopen; or dispatch a replacement child carrying that row's current atlas_assignment binding.`,
        };
      }
    }
    // ask holds the whole session until the user answers, so no child is recorded and nothing is dispatched meanwhile.
    if (!detail && event.toolName === "ask") {
      const ledger = await readLedger(ctx, record);
      const movable = ledger ? movableRows(ledger) : [];
      if (movable.length) {
        const rows = movable.map((item) => `${item.id} (${item.status === "in_progress" ? "in progress" : "dispatchable"})`).join(", ");
        return {
          block: true,
          reason: `Atlas ask guard: ask is held back, not denied. It blocks this session until the user answers, and the user may be away for hours, so while it is open no finished child would be recorded and no row dispatched. These rows can still move without the user: ${rows}. If any plausible answer could change what a row delivers, how its acceptance is met, the approved scope, or an irreversible step, the question is blocking: record atlas_ledger block on that row (stopping its child first if one is running) with the question in evidence, keep the other rows moving, and ask once every unfinished row is blocked or waits on a blocked row; the continuation will then tell you to ask. Never work around a blocker or treat it as optional to get past this guard. Only a question whose every answer leaves the approved work valid goes in your reply, with the assumption you proceed under.`,
        };
      }
    }
    // Native xdev task dispatch is intercepted again at its inner task boundary.
    if (!detail && event.toolName === "task" && !carriesAtlasAssignment(event.input)) {
      // Unbound read-only research needs no ledger row, yet still requires a valid ledger: a paused plan dispatches nothing.
      try {
        if (!(await readLedger(ctx, record))) throw new Error(pauseMessage(record));
        const { agents } = await discoverAgents(ctx.cwd, undefined, live.effectiveExtensionRoots);
        const research = researchSpawnBlockReason(event.input, availableAgents(), [...agents, ...live.getSessionAgents()]);
        if (research) throw new Error(research);
      } catch (error) {
        return { block: true, reason: `Task dispatch refused: ${errorMessage(error)}. /atlas exit is the user exit.` };
      }
    } else if (!detail && event.toolName === "task") {
      const originSessionId = ctx.sessionManager.getSessionId();
      // Host isolation copies and merges through Git, so outside a work tree an isolated spawn always fails.
      const isolationRequired = cfgTaskIsolationEnabled.get(live.settings) && (await isGitWorkTree(ctx.cwd));
      let remembered = false;
      try {
        await withExecutionLedger(ctx, record, (ledger) => {
          const artifactsDir = ctx.sessionManager.getArtifactsDir();
          if (!artifactsDir) throw new Error("native task artifacts are unavailable");
          childEvidence.rememberDispatch(event.toolCallId, originSessionId, ledger, event.input, artifactsDir, { isolationRequired });
          remembered = true;
        });
      } catch (error) {
        if (remembered) childEvidence.discardUnstartedDispatch(originSessionId, event.toolCallId);
        return {
          block: true,
          reason: `Task dispatch refused: ${errorMessage(error)}. Use a valid shared ledger and its current start binding; /atlas exit is the user exit.`,
        };
      }
      if (isolationRequired && forceBranchMerge(live)) {
        notify(
          ctx,
          "Atlas switched task.isolation.merge from patch to branch while it executes, so each isolated child's commits land in this checkout instead of an uncommitted patch. Your setting returns when Atlas exits.",
        );
      }
    }
    if (!detail) return undefined;

    const now = Date.now();
    if (now - record.lastBlockedAt > BLOCK_NOTICE_BURST_MS) notify(ctx, BLOCKED_TOOL_NOTICE, "warning");
    record.lastBlockedAt = now;
    return { block: true, reason: blockedToolMessage(event.toolName, detail) };
  });

  pi.on("tool_result", async (event, ctx) => {
    const live = mainSession(ctx);
    const sessionId = ctx.sessionManager.getSessionId();
    if (event.toolName === "task" && provenanceBlockReason("task") === undefined) {
      childEvidence.observeTaskResult(sessionId, event.toolCallId, event.details, event.isError);
      observeFinalJobs(ctx);
      await settleDetached();
    }
    if (!live) return undefined;
    const record = records.get(sessionId) ?? rehydrate(ctx) ?? recordFor(sessionId);
    if (event.toolName === "todo" && !event.isError && record.phase === "executing") {
      const details = event.details;
      if (
        details &&
        typeof details === "object" &&
        "op" in details &&
        details.op !== "view" &&
        "phases" in details &&
        Array.isArray(details.phases) &&
        details.phases.every(isTodoPhase)
      ) {
        pendingTodoRefreshes.delete(sessionId);
        const ledger = await readLedger(ctx, record);
        if (!ledger) return undefined;
        // The host todo tool normalizes to one running item; restore parallel Atlas rows before
        // its tracker and HUD consume this result, while leaving non-Atlas edits intact.
        const corrected = mergeAtlasTodos(details.phases, ledger);
        if (corrected) {
          if (JSON.stringify(live.getTodoPhases()) !== JSON.stringify(corrected)) {
            live.setTodoPhases(corrected);
            live.sessionManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: corrected });
          }
          return { details: { ...details, phases: corrected } };
        }
      }
      return undefined;
    }
    observeFinalJobs(ctx);

    if (event.toolName === "ask") {
      record.pendingConsent = undefined;
      const episodeId = planModeEpisodeId(ctx);
      const fixedQuestion = provenanceBlockReason("ask") === undefined && isPrometheusOptInQuestion(event.input);
      if (record.phase === "idle" && live.getPlanModeState()?.enabled === true && episodeId && fixedQuestion) {
        if (isPrometheusOptInConsent(event.input, event.details, event.isError, ctx.hasUI)) {
          record.pendingConsent = { askToolCallId: event.toolCallId, modeEntryId: episodeId };
        } else {
          record.suppressedForModeEntryId = episodeId;
          persist(ctx, record);
          await syncTools(false, false, false);
        }
      }
      return undefined;
    }

    const proposedPath = proposedPlanPathFromToolResult(event.toolName, event.isError, event.details);
    if (!proposedPath || provenanceBlockReason("write") !== undefined || record.phase !== "planning") return undefined;
    record.planFilePath = proposedPath;
    record.proposedByToolCallId = event.toolCallId;
    record.sourceSessionId = sessionId;
    record.proposalAwaitingApproval = true;
    record.approvalCompactionPending = false;
    record.ledgerPath = undefined;
    record.planSha256 = undefined;
    const binding = roadmap.requestBinding(sessionId);
    const bound = binding?.stage;
    record.roadmapStage =
      binding && bound ? { repoRoot: binding.repoRoot, id: bound.id, ...(bound.revision ? { revision: bound.revision } : {}) } : undefined;
    try {
      const content = await fs.readFile(resolveLocalUrlToPath(proposedPath, localOptions(ctx)), "utf8");
      record.planSha256 = planDigest(content);
      // The tool_call guard already refused a missing or invalid line; an older roadmap without criteria leaves coverage undeclared.
      if (record.roadmapStage && bound?.criteria) {
        const coverage = checkRoadmapCriteria(parsePlanChecklist(content).roadmapCriteria, { id: bound.id, criteria: bound.criteria });
        if ("criteria" in coverage) record.roadmapStage.criteria = coverage.criteria;
        else pi.logger.warn("prometheus stored the proposal without declared roadmap criteria", { error: coverage.error });
      }
      const markerFile = resolveLocalUrlToPath(prometheusArtifactUrl(proposedPath), localOptions(ctx));
      await writeLedgerAtomic(markerFile, {
        version: 4,
        planFilePath: proposedPath,
        planSha256: record.planSha256,
        proposedByToolCallId: event.toolCallId,
        sourceSessionId: sessionId,
        roadmapStage: record.roadmapStage,
        createdAt: Date.now(),
      });
    } catch (error) {
      pi.logger.warn("prometheus could not write the proposal marker", { error: errorMessage(error) });
    }
    persist(ctx, record);
    // The native approval overlay opens after this hook and offers cycleOrder roles as execution tiers.
    exposeAtlasApprovalTier(live);

    const approvedInResult = event.content.some((part) => part.type === "text" && part.text.trimStart().startsWith("Plan approved at "));
    if (approvedInResult && live.getPlanModeState()?.enabled !== true && planReferencesMatch(live.getPlanReferencePath(), proposedPath)) {
      await enterExecution(ctx, record);
      await syncTools(false, true, true);
    }
    return undefined;
  });

  pi.on("session_before_compact", (_event, ctx) => {
    const live = mainSession(ctx);
    const record = records.get(ctx.sessionManager.getSessionId()) ?? rehydrate(ctx);
    if (
      live &&
      record?.phase === "planning" &&
      record.proposalAwaitingApproval === true &&
      live.getPlanModeState()?.enabled !== true &&
      planReferencesMatch(live.getPlanReferencePath(), record.planFilePath)
    ) {
      record.approvalCompactionPending = true;
    }
    return undefined;
  });

  pi.on("session_compact", async (_event, ctx) => {
    const record = records.get(ctx.sessionManager.getSessionId()) ?? rehydrate(ctx);
    if (record?.phase === "planning" && record.approvalCompactionPending === true) {
      record.compactHandoffPending = true;
      await enterExecution(ctx, record);
      await syncTools(false, true, true);
    }
  });

  pi.on("message_end", (_event, ctx) => observeFinalJobs(ctx));

  pi.on("session_stop", async (_event, ctx) => {
    if (!mainSession(ctx)) return undefined;
    const record = records.get(ctx.sessionManager.getSessionId()) ?? rehydrate(ctx);
    if (record?.phase !== "executing") return undefined;
    const ledger = await readLedger(ctx, record);
    if (!ledger) {
      notify(ctx, pauseMessage(record), "error");
      return undefined;
    }
    if (isComplete(ledger)) return undefined;
    const stamp = Math.max(...ledgerRows(ledger).map((item) => item.updatedAt));
    record.stallCount = stamp === record.lastContinuationLedgerStamp ? record.stallCount + 1 : 0;
    if (record.stallCount >= 2) {
      notify(ctx, "Atlas execution stalled; run /atlas exit or send new instructions", "warning");
      return undefined;
    }
    record.lastContinuationLedgerStamp = stamp;
    const blocked = movableRows(ledger).length ? [] : ledgerRows(ledger).filter((item) => item.status === "blocked");
    const next = blocked.length
      ? `Nothing can move without the user: every unfinished row is blocked or waits on a blocked row (${blocked.map((item) => `${item.id}: ${item.evidence ?? "no reason recorded"}`).join("; ")}). Call ask now with one question per blocker, so the session waits for the user instead of ending with a chat-only question. Then reopen and dispatch the rows the answers unblock.`
      : "Dispatch the next unblocked items with task; record progress with atlas_ledger; call atlas_release only when every row is done.";
    return {
      continue: true,
      additionalContext: `<atlas-continuation>\n${ledgerSummary(ledger)}\n${next}\n</atlas-continuation>`,
    };
  });

  const recoverSession = async (ctx: ExtensionContext, fresh = false, switched = false): Promise<void> => {
    for (const sessionId of liveModels.keys()) {
      if (switched && sessionId !== ctx.sessionManager.getSessionId()) {
        herdrDag.release(sessionId, "session-switch");
        herdrDag.forget(sessionId);
      }
      clearObservation(ctx, sessionId);
    }
    authorizedActivationCalls.clear();
    const sessionId = ctx.sessionManager.getSessionId();
    const live = mainSession(ctx);
    const knownBinding = live ? hostBindings.get(live) : undefined;
    const previousReference =
      switched && knownBinding?.sessionId !== sessionId && planReferencesMatch(live?.getPlanReferencePath(), knownBinding?.planUrl)
        ? knownBinding?.planUrl
        : undefined;
    const previous = records.get(sessionId);
    if (previous) {
      previous.ownership = undefined;
      previous.activation = undefined;
    }
    const restored = fresh ? undefined : rehydrate(ctx, true);
    if (fresh) records.delete(sessionId);
    for (const ownership of ownerships) {
      if (ownership.sessionId !== sessionId || restored?.phase !== "executing" || restored.atlasPlanId !== ownership.plan.id) {
        detach(ownership);
      }
    }
    if (live && restored?.phase !== "executing") restoreIsolationMerge(live);
    await settleDetached();
    await resumeLedger(ctx, restored, previousReference);
    if (!restored?.ownership) herdrDag.release(sessionId, "exit");
    if (live && knownBinding && !restored?.ownership && planReferencesMatch(live.getPlanReferencePath(), knownBinding.planUrl)) {
      live.setPlanReferencePath(DEFAULT_PLAN_REFERENCE);
    }
    const executing = restored?.phase === "executing";
    await syncTools(false, executing, executing);
    publishState(ctx);
  };

  /** Registers the atlas model role and lets this main session answer roadmap plan queries. */
  const attachSession = (ctx: ExtensionContext): void => {
    const live = mainSession(ctx);
    if (!live) return;
    registerAtlasModelRole(live.settings);
    plansSessions.set(ctx.sessionManager, ctx);
  };

  pi.on("session_start", async (_event, ctx) => {
    attachSession(ctx);
    await loadPlanningSettings(ctx);
    await recoverSession(ctx);
    herdrDag.announce(ctx.sessionManager.getSessionId());
    await refreshAtlasCompletions(ctx);
  });

  pi.on("session_switch", async (event, ctx) => {
    attachSession(ctx);
    await loadPlanningSettings(ctx);
    await recoverSession(ctx, event.reason === "new", true);
    herdrDag.announce(ctx.sessionManager.getSessionId());
    await refreshAtlasCompletions(ctx);
  });

  pi.on("session_branch", async (_event, ctx) => {
    await recoverSession(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    await recoverSession(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const live = mainSession(ctx);
    if (live) {
      restoreApprovalTiers(live);
      restoreIsolationMerge(live);
    }
    const sessionId = ctx.sessionManager.getSessionId();
    plansSessions.delete(ctx.sessionManager);
    herdrDag.release(sessionId, "shutdown");
    clearObservation(ctx, sessionId);
    const record = records.get(sessionId);
    if (record) {
      record.phase = "idle";
      record.ownership = undefined;
      record.activation = undefined;
    }
    for (const ownership of ownerships) if (ownership.sessionId === sessionId) detach(ownership);
    // Keep observations and locks for still-live native work; process death is recovered by AtlasStore.
    await settleDetached();
    if (live) {
      const binding = hostBindings.get(live);
      if (binding?.sessionId === sessionId && planReferencesMatch(live.getPlanReferencePath(), binding.planUrl)) {
        live.setPlanReferencePath(DEFAULT_PLAN_REFERENCE);
      }
    }
    records.delete(sessionId);
    await statePublisher.flush();
    publishedStates.delete(sessionId);
    reviewLevels.delete(sessionId);
    deliverySettings.delete(sessionId);
    atlasWidgets.delete(sessionId);
    herdrDag.forget(sessionId);
    roadmap.forget(sessionId);
    adr.forget(sessionId);
    authorizedActivationCalls.clear();
  });
}

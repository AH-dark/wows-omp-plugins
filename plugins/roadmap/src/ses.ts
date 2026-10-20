import { createHash } from "node:crypto";

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import type { Model, Repo } from "#src/documents.ts";
import type { Actor, PreparedOperation } from "#src/operations.ts";
import type { OverlapAnswer, RoadmapUi } from "#src/ui.ts";

export type UiFactory = (ctx: ExtensionContext) => RoadmapUi;
export const ENTRY_PREFIX = "wows-omp-roadmap.";

export interface Binding {
  v: 1;
  repoRoot: string;
  stage: string;
  at: string;
}

export interface PendingClose extends Binding {
  planId: string;
  gates: Array<{ gateId: string; verdict: string; summary: string }>;
  delivery?: { mode: "pr" | "ship"; summary: string };
}

export type ArmedKind = "init" | "round" | "plan" | "upgrade" | "drop-round" | "retarget";

/** A prepared command preview awaiting `/roadmap confirm <token>` because no dialog could confirm it. */
export interface PendingPreview {
  token: string;
  kind: ArmedKind;
  repo: Repo;
  prepared: PreparedOperation;
  generation: number;
}

interface RepoState {
  binding?: Binding;
  armed?: ArmedKind;
  overlaps: Map<string, OverlapAnswer>;
  pending: Map<string, PendingClose>;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function actor(ctx: ExtensionContext): Actor {
  return { sessionId: ctx.sessionManager.getSessionId(), kind: ctx.agent.kind };
}

/**
 * Native plan mode, read from the session branch: the host exposes no plan-mode accessor to extensions, and records
 * every entry and exit as a `mode_change` entry (`plan` on entry, another mode or `none` on exit).
 */
export function planModeActive(ctx: ExtensionContext): boolean {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type === "mode_change") return entry.mode === "plan";
  }
  return false;
}

/** A session may stay bound to an unclosed stage of the active round: active, or planned when bound in plan mode. */
export function bindable(model: Model, stageId: string): boolean {
  return model.stages.some(
    (stage) =>
      stage.id === stageId &&
      (stage.status === "active" || stage.status === "planned") &&
      model.rounds.some((round) => round.id === stage.round && round.status === "active"),
  );
}

/** One instance per extension factory; the current branch is the durable source of truth. */
export class RoadmapSession {
  private sessionId?: string;
  private generation = 0;
  private repos = new Map<string, RepoState>();
  // In memory only: a restart or branch change requires a fresh preview, like an unanswered dialog.
  private previews = new Map<string, PendingPreview>();

  constructor(private readonly pi: Pick<ExtensionAPI, "appendEntry">) {}

  private state(repoRoot: string): RepoState {
    let state = this.repos.get(repoRoot);
    if (!state) {
      state = { overlaps: new Map(), pending: new Map() };
      this.repos.set(repoRoot, state);
    }
    return state;
  }

  ensure(ctx: ExtensionContext): void {
    if (this.sessionId !== ctx.sessionManager.getSessionId()) this.rebuild(ctx);
  }

  rebuild(ctx: ExtensionContext): void {
    this.sessionId = ctx.sessionManager.getSessionId();
    this.generation++;
    this.repos.clear();
    this.previews.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || !entry.customType.startsWith(ENTRY_PREFIX)) continue;
      this.restore(entry.customType.slice(ENTRY_PREFIX.length), entry.data);
    }
  }

  currentGeneration(ctx: ExtensionContext): number {
    this.ensure(ctx);
    return this.generation;
  }

  isCurrent(ctx: ExtensionContext, generation: number): boolean {
    return this.generation === generation && this.sessionId === ctx.sessionManager.getSessionId();
  }

  private restore(type: string, data: unknown): void {
    if (!object(data) || data.v !== 1 || typeof data.repoRoot !== "string" || !data.repoRoot || typeof data.at !== "string") return;
    const state = this.state(data.repoRoot);
    if (
      type === "armed" &&
      typeof data.kind === "string" &&
      ["init", "round", "plan", "upgrade", "drop-round", "retarget"].includes(data.kind)
    )
      state.armed = data.kind as ArmedKind;
    if (type === "disarmed") delete state.armed;
    if (typeof data.stage !== "string" || !/^S\d+$/.test(data.stage)) return;
    const binding: Binding = { v: 1, repoRoot: data.repoRoot, stage: data.stage, at: data.at };
    if (type === "binding") state.binding = binding;
    if (type === "unbound" && state.binding?.stage === data.stage) delete state.binding;
    if (type === "overlap" && (data.answer === "roadmap" || data.answer === "free" || data.answer === "unrelated")) {
      state.overlaps.set(data.stage, data.answer);
    }
    if (type === "pending-close" && typeof data.planId === "string" && data.planId && Array.isArray(data.gates)) {
      const gates: PendingClose["gates"] = [];
      for (const gate of data.gates) {
        if (!object(gate) || typeof gate.gateId !== "string" || typeof gate.verdict !== "string" || typeof gate.summary !== "string")
          return;
        gates.push({ gateId: gate.gateId, verdict: gate.verdict, summary: gate.summary });
      }
      let delivery: PendingClose["delivery"];
      if (data.delivery !== undefined) {
        if (
          !object(data.delivery) ||
          (data.delivery.mode !== "pr" && data.delivery.mode !== "ship") ||
          typeof data.delivery.summary !== "string"
        )
          return;
        delivery = { mode: data.delivery.mode, summary: data.delivery.summary.replace(/\s+/g, " ").slice(0, 180) };
      }
      state.pending.set(data.planId, { ...binding, planId: data.planId, gates, ...(delivery ? { delivery } : {}) });
    }
    if (type === "pending-close-cleared") {
      for (const [id, pending] of state.pending) if (pending.stage === data.stage) state.pending.delete(id);
    }
  }

  private append(ctx: ExtensionContext, type: string, data: { repoRoot: string; [key: string]: unknown }): void {
    this.ensure(ctx);
    const payload = { ...data, v: 1, at: new Date().toISOString() };
    this.pi.appendEntry(`${ENTRY_PREFIX}${type}`, payload);
    this.restore(type, payload);
  }

  isArmed(ctx: ExtensionContext, repoRoot: string, kind: ArmedKind): boolean {
    this.ensure(ctx);
    return ctx.agent.kind === "main" && this.state(repoRoot).armed === kind;
  }

  arm(ctx: ExtensionContext, repoRoot: string, kind: ArmedKind): void {
    this.append(ctx, "armed", { repoRoot, kind });
  }

  disarm(ctx: ExtensionContext, repoRoot: string): void {
    this.append(ctx, "disarmed", { repoRoot });
    for (const [token, preview] of this.previews) if (preview.repo.repoRoot === repoRoot) this.previews.delete(token);
  }

  /** Holds the latest preview per repository and kind; the token names its exact files. */
  holdPreview(ctx: ExtensionContext, generation: number, kind: ArmedKind, repo: Repo, prepared: PreparedOperation): string {
    this.ensure(ctx);
    const token = createHash("sha256")
      .update(JSON.stringify([kind, repo.repoRoot, prepared.files]))
      .digest("hex")
      .slice(0, 12);
    for (const [held, preview] of this.previews) {
      if (preview.kind === kind && preview.repo.repoRoot === repo.repoRoot) this.previews.delete(held);
    }
    this.previews.set(token, { token, kind, repo, prepared, generation });
    return token;
  }

  takePreview(ctx: ExtensionContext, token: string): PendingPreview | undefined {
    this.ensure(ctx);
    const preview = this.previews.get(token);
    this.previews.delete(token);
    return preview?.generation === this.generation ? preview : undefined;
  }

  bind(ctx: ExtensionContext, repoRoot: string, stage: string): void {
    this.append(ctx, "binding", { repoRoot, stage });
  }

  /** Synchronous lookup for the optional Prometheus binding listener. */
  getBinding(repoRoot: string): Binding | undefined {
    return this.repos.get(repoRoot)?.binding;
  }

  dropBinding(ctx: ExtensionContext, repoRoot: string, stage: string): void {
    this.append(ctx, "unbound", { repoRoot, stage });
    this.append(ctx, "pending-close-cleared", { repoRoot, stage });
  }

  validateBinding(ctx: ExtensionContext, repoRoot: string, model: Model): string | undefined {
    this.ensure(ctx);
    const binding = this.getBinding(repoRoot);
    if (!binding || bindable(model, binding.stage)) return;
    this.dropBinding(ctx, repoRoot, binding.stage);
    return `Previous binding ${binding.stage} is no longer an unclosed stage of the active round on disk; dropped this session's binding.`;
  }

  overlapAnswer(ctx: ExtensionContext, repoRoot: string, stage: string): OverlapAnswer | undefined {
    this.ensure(ctx);
    return this.state(repoRoot).overlaps.get(stage);
  }

  answerOverlap(ctx: ExtensionContext, repoRoot: string, stage: string, answer: OverlapAnswer): void {
    this.append(ctx, "overlap", { repoRoot, stage, answer });
  }

  recordPendingClose(ctx: ExtensionContext, pending: Omit<PendingClose, "v" | "at">): void {
    this.ensure(ctx);
    if (this.state(pending.repoRoot).pending.has(pending.planId)) return;
    this.append(ctx, "pending-close", pending);
  }

  pendingClose(ctx: ExtensionContext, repoRoot: string): PendingClose[] {
    this.ensure(ctx);
    return [...this.state(repoRoot).pending.values()];
  }

  clearStage(ctx: ExtensionContext, repoRoot: string, stage: string): void {
    this.ensure(ctx);
    if (this.getBinding(repoRoot)?.stage === stage) this.dropBinding(ctx, repoRoot, stage);
    else this.append(ctx, "pending-close-cleared", { repoRoot, stage });
  }
}

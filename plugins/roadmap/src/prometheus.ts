import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import { requestAdr } from "#src/adr.ts";
import { parseDoneCriteria, parseRoadmapIndex, parseStage, planningRevision, type StageDoc } from "#src/documents.ts";
import { committedFile, discoverRepo, uncommittedFiles } from "#src/git.ts";
import type { RoadmapSession } from "#src/ses.ts";
import { TOOL_SOURCE_PATH } from "#src/tools.ts";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A stage as roadmap:binding and roadmap:stage carry it: current criteria in document order and the planning-basis revision. */
interface ContractStage {
  id: string;
  title: string;
  round: string;
  criteria: string[];
  revision: string;
}

function stageFields(stage: StageDoc): ContractStage {
  return {
    id: stage.id,
    title: stage.title,
    round: stage.round,
    criteria: parseDoneCriteria(stage.done_criteria).map((criterion) => criterion.id),
    revision: planningRevision(stage),
  };
}

/**
 * What an executing session still owes a stage before implementation: start a stage plan mode bound without starting
 * it, or commit the files that started it, so other work trees and clones see it active. Undefined when nothing is owed.
 */
type Activation = { action: "start" } | { action: "commit"; files: string[] };

function activation(repoRoot: string, stage: StageDoc): Activation | undefined {
  if (stage.status === "planned") return { action: "start" };
  if (stage.status !== "active") return undefined;
  const path = relative(repoRoot, stage.path);
  const committed = committedFile(repoRoot, path);
  let committedStatus: StageDoc["status"] | undefined;
  try {
    committedStatus = committed === undefined ? undefined : parseStage(committed, stage.path).status;
  } catch {
    // A committed copy that no longer parses cannot show the start; the dirty-file check below decides.
  }
  if (committedStatus !== undefined && committedStatus !== "planned") return undefined;
  // Start rewrites the stage, its round's stage table and the index; a stage added in the same session is untracked.
  const files = uncommittedFiles(repoRoot, [
    path,
    relative(repoRoot, join(dirname(dirname(stage.path)), "README.md")),
    "docs/roadmap/README.md",
  ]);
  return files.length ? { action: "commit", files } : undefined;
}

/** Read one stage synchronously: pi.events cannot await an answer. Throws when the roadmap documents are unreadable. */
function readStage(repoRoot: string, id: string): StageDoc | undefined {
  const roadmapDir = join(repoRoot, "docs/roadmap");
  const indexPath = join(roadmapDir, "README.md");
  parseRoadmapIndex(readFileSync(indexPath, "utf8"), indexPath);
  for (const round of readdirSync(roadmapDir, { withFileTypes: true })) {
    if (!round.isDirectory() || !/^\d{2,}-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(round.name)) continue;
    const stagesDir = join(roadmapDir, round.name, "stages");
    let files: string[];
    try {
      files = readdirSync(stagesDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const file of files) {
      if (!file.endsWith(".md") || Number(file.split("-")[0]) !== Number(id.slice(1))) continue;
      const path = join(stagesDir, file);
      const stage = parseStage(readFileSync(path, "utf8"), path);
      if (stage.id === id) return stage;
    }
  }
  return undefined;
}

/** requireRepo's initialization test, synchronously: docs/roadmap/README.md exists and parses as a roadmap index. */
function roadmapInitialized(repoRoot: string): boolean {
  const indexPath = join(repoRoot, "docs/roadmap/README.md");
  try {
    parseRoadmapIndex(readFileSync(indexPath, "utf8"), indexPath);
    return true;
  } catch {
    return false;
  }
}

export function registerPrometheusContract(pi: ExtensionAPI, ses: RoadmapSession): void {
  let context: ExtensionContext | undefined;
  const capture = (_event: unknown, ctx: ExtensionContext): void => {
    context = ctx;
    ses.ensure(ctx);
  };
  pi.on("session_start", capture);
  pi.on("session_switch", capture);
  pi.on("session_branch", capture);
  pi.on("session_tree", capture);
  pi.on("before_agent_start", capture);
  pi.on("input", capture);
  pi.on("tool_call", capture);
  pi.on("tool_result", capture);

  const bindingSubscription = pi.events.on("roadmap:binding-request", (payload) => {
    const ctx = context;
    if (
      !ctx ||
      !object(payload) ||
      payload.v !== 1 ||
      payload.sessionId !== ctx.sessionManager.getSessionId() ||
      typeof payload.requestId !== "string" ||
      !payload.requestId
    )
      return;
    let repoRoot: string;
    let usable: boolean;
    let stage: ContractStage | undefined;
    try {
      ses.ensure(ctx);
      const git = discoverRepo(ctx.cwd);
      repoRoot = git?.repoRoot ?? resolve(ctx.cwd);
      // Every roadmap tool, roadmap_todo included, needs a Git work tree, an initialized roadmap and the adr service.
      usable = git !== null && roadmapInitialized(repoRoot) && "api" in requestAdr(pi.events, payload.sessionId);
    } catch (error) {
      pi.logger.warn("roadmap could not answer the Prometheus binding request", { error: String(error) });
      return;
    }
    try {
      const binding = ses.getBinding(repoRoot);
      const bound = binding ? readStage(repoRoot, binding.stage) : undefined;
      // A planned stage is bound only in plan mode, which defers its start to execution.
      stage = bound?.status === "active" || bound?.status === "planned" ? stageFields(bound) : undefined;
    } catch (error) {
      // Tool provenance must not depend on readable stage documents; answer without a stage.
      pi.logger.warn("roadmap could not read the bound stage for Prometheus", { error: String(error) });
    }
    pi.events.emit("roadmap:binding", {
      v: 1,
      sessionId: payload.sessionId,
      requestId: payload.requestId,
      repoRoot,
      toolSourcePath: TOOL_SOURCE_PATH,
      usable,
      ...(stage ? { stage } : {}),
    });
  });

  // Prometheus asks for a stage's current planning basis on /atlas resume and completion to notice drift.
  const stageSubscription = pi.events.on("roadmap:stage-request", (payload) => {
    const ctx = context;
    if (
      !ctx ||
      !object(payload) ||
      payload.v !== 1 ||
      payload.sessionId !== ctx.sessionManager.getSessionId() ||
      typeof payload.requestId !== "string" ||
      !payload.requestId ||
      typeof payload.repoRoot !== "string" ||
      typeof payload.stage !== "string" ||
      !/^S\d+$/.test(payload.stage)
    )
      return;
    let stage: (ContractStage & { status: StageDoc["status"]; activation?: Activation }) | undefined;
    try {
      if (discoverRepo(ctx.cwd)?.repoRoot !== payload.repoRoot) return;
      const current = readStage(payload.repoRoot, payload.stage);
      if (current) {
        const owed = activation(payload.repoRoot, current);
        stage = { ...stageFields(current), status: current.status, ...(owed ? { activation: owed } : {}) };
      }
    } catch (error) {
      // A repository without a roadmap or with unreadable documents answers without a stage.
      pi.logger.warn("roadmap could not read the requested stage for Prometheus", { error: String(error) });
    }
    pi.events.emit("roadmap:stage", {
      v: 1,
      sessionId: payload.sessionId,
      requestId: payload.requestId,
      repoRoot: payload.repoRoot,
      ...(stage ? { stage } : {}),
    });
  });

  const completionSubscription = pi.events.on("atlas:completed", (payload) => {
    const ctx = context;
    if (
      !ctx ||
      !object(payload) ||
      payload.v !== 1 ||
      payload.sessionId !== ctx.sessionManager.getSessionId() ||
      typeof payload.planId !== "string" ||
      !payload.planId ||
      typeof payload.at !== "string" ||
      !object(payload.roadmapStage) ||
      typeof payload.roadmapStage.repoRoot !== "string" ||
      typeof payload.roadmapStage.id !== "string" ||
      !/^S\d+$/.test(payload.roadmapStage.id) ||
      !Array.isArray(payload.gates)
    )
      return;
    if (
      payload.gates.some(
        (gate) => !object(gate) || typeof gate.gateId !== "string" || typeof gate.verdict !== "string" || typeof gate.summary !== "string",
      )
    )
      return;
    let delivery: { mode: "pr" | "ship"; summary: string } | undefined;
    if (payload.delivery !== undefined) {
      if (
        !object(payload.delivery) ||
        (payload.delivery.mode !== "pr" && payload.delivery.mode !== "ship") ||
        typeof payload.delivery.summary !== "string"
      )
        return;
      delivery = { mode: payload.delivery.mode, summary: payload.delivery.summary.replace(/\s+/g, " ").slice(0, 180) };
    }
    try {
      const repoRoot = discoverRepo(ctx.cwd)?.repoRoot;
      if (repoRoot !== payload.roadmapStage.repoRoot) return;
      ses.recordPendingClose(ctx, {
        repoRoot,
        stage: payload.roadmapStage.id,
        planId: payload.planId,
        gates: payload.gates as Array<{ gateId: string; verdict: string; summary: string }>,
        ...(delivery ? { delivery } : {}),
      });
    } catch (error) {
      pi.logger.warn("roadmap could not record Atlas completion", { error: String(error) });
    }
  });

  pi.on("session_shutdown", () => {
    context = undefined;
    bindingSubscription();
    stageSubscription();
    completionSubscription();
  });
}

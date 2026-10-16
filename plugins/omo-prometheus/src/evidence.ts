import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

import { type ChildReceipt, type ExecutionLedger, type LedgerItem, ledgerRows, planDigest, verificationStatus } from "./ledger.ts";

export type ChildVerdict = "PASS" | "FAIL" | "INCONCLUSIVE";

interface Assignment {
  ledgerId: string;
  sessionId: string;
  planSha256: string;
  rows: Record<string, string>;
  /** The rows map binds a HEAVY row's verification attempt, never its implementation. */
  verify: boolean;
  dispatchedAt: number;
  artifactsDir: string;
  finalStatus?: "completed" | "failed";
  returnedAt?: number;
  nativeChildId?: string;
  nativeJobId?: string;
  nativeJobStart?: number;
  observingSettlement?: boolean;
  settled?: boolean;
  failedInFinalProgress?: boolean;
}

/** The parent's native async jobs, read from its job manager; `onSettled` re-runs detached-ownership settlement. */
interface NativeJobs {
  ownerId: string;
  jobs: readonly unknown[];
  onSettled: () => void;
}

interface ObservedChild {
  childAgentId: string;
  assignment: Assignment;
  status: string;
  sessionFile: string;
  finalStatus?: "completed" | "failed";
  reactivation?: {
    startedAt: number;
    finishedAt?: number;
    supersededAt?: number;
    nativeJobId?: string;
    nativeJobStart?: number;
    observingSettlement?: boolean;
    settled?: boolean;
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The host takes a task `outputSchema` as an object or as its JSON text, which it parses. Providers with strict tool
 * schemas (OpenAI Responses) narrow the object branch to `{}`, so their models can only send the text form.
 */
function suppliesObjectSchema(value: unknown): boolean {
  if (typeof value !== "string") return object(value);
  try {
    return object(JSON.parse(value));
  } catch {
    return false;
  }
}

/** The exact outputSchema given to a native gate child; it overrides any agent-native prose format. */
export function gateOutputSchema(ledger: ExecutionLedger, row: LedgerItem): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["gateId", "planSha256", "attempt", "verdict", "summary", "evidence"],
    properties: {
      gateId: { const: row.id },
      planSha256: { const: ledger.planSha256 },
      attempt: { const: row.attempt },
      verdict: { enum: ["PASS", "FAIL", "INCONCLUSIVE"] },
      summary: { type: "string", minLength: 1 },
      evidence: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
    },
  };
}

/** Gate verdicts come from the child's complete JSON artifact, never a word in caller prose. */
export function validateGateOutput(content: string, ledger: ExecutionLedger, row: LedgerItem): void {
  let result: unknown;
  try {
    result = JSON.parse(content);
  } catch {
    throw new Error(`${row.id} child output must be a JSON object matching the gate outputSchema`);
  }
  // Outputs from earlier plugin versions may carry a reviewedGates field; it no longer affects the verdict.
  if (
    !object(result) ||
    result.gateId !== row.id ||
    result.planSha256 !== ledger.planSha256 ||
    result.attempt !== row.attempt ||
    typeof result.summary !== "string" ||
    !result.summary.trim() ||
    !Array.isArray(result.evidence) ||
    !result.evidence.length ||
    result.evidence.some((entry) => typeof entry !== "string" || !entry.trim())
  ) {
    throw new Error(`${row.id} child output does not match the current plan and attempt`);
  }
  if (result.verdict !== "PASS")
    throw new Error(
      `${row.id} did not pass: ${String(result.verdict)}. Record each correction with atlas_ledger fix, or report the blocker.`,
    );
}

/** The exact outputSchema given to a HEAVY row's verifier child, bound like a gate to the row and verify attempt. */
export function verifyOutputSchema(ledger: ExecutionLedger, row: LedgerItem): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["rowId", "planSha256", "attempt", "verdict", "summary", "evidence"],
    properties: {
      rowId: { const: row.id },
      planSha256: { const: ledger.planSha256 },
      attempt: { const: row.verification?.attempt },
      verdict: { enum: ["PASS", "FAIL", "INCONCLUSIVE"] },
      summary: { type: "string", minLength: 1 },
      evidence: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
    },
  };
}

/** Read a verifier's verdict from its complete JSON artifact; a FAIL is a valid result, a mismatched binding is not. */
export function parseVerifyOutput(content: string, ledger: ExecutionLedger, row: LedgerItem): { verdict: ChildVerdict; summary: string } {
  let result: unknown;
  try {
    result = JSON.parse(content);
  } catch {
    throw new Error(`${row.id} verifier output must be a JSON object matching the verification outputSchema`);
  }
  if (
    !object(result) ||
    result.rowId !== row.id ||
    result.planSha256 !== ledger.planSha256 ||
    row.verification?.attempt === undefined ||
    result.attempt !== row.verification.attempt ||
    (result.verdict !== "PASS" && result.verdict !== "FAIL" && result.verdict !== "INCONCLUSIVE") ||
    typeof result.summary !== "string" ||
    !result.summary.trim() ||
    !Array.isArray(result.evidence) ||
    !result.evidence.length ||
    result.evidence.some((entry) => typeof entry !== "string" || !entry.trim())
  ) {
    throw new Error(`${row.id} verifier output does not match the current plan and verification attempt`);
  }
  return { verdict: result.verdict, summary: result.summary.trim() };
}

/** Correlates native dispatch and terminal lifecycle events; it never launches or schedules children. */
export class ChildEvidence {
  readonly #dispatches = new Map<string, Assignment[]>();
  readonly #children = new Map<string, ObservedChild>();
  readonly #reactivations = new Set<ObservedChild>();

  /**
   * Bind every task in one native call to started ledger attempts. `rows` binds implementation, gate, and delivery
   * attempts; `verify` binds exactly one HEAVY row's verification attempt. Under host isolation, implementation rows
   * (T, D, X, P) must request `isolated: true`; gates and verifiers are not forced either way.
   */
  rememberDispatch(
    toolCallId: string,
    sessionId: string,
    ledger: ExecutionLedger,
    input: unknown,
    artifactsDir: string,
    options: { isolationRequired?: boolean } = {},
  ): void {
    if (this.#dispatches.has(`${sessionId}:${toolCallId}`))
      throw new Error("Native task dispatch identity was already used in this session");
    if (!object(input)) throw new Error("Task input must identify its ledger assignment");
    const tasks = Array.isArray(input.tasks) ? input.tasks : [input];
    if (!tasks.length) throw new Error("Task batch is empty");
    const bound = new Set<string>();
    const dispatchedAt = Date.now();
    const assignments = tasks.map((task): Assignment => {
      if (!object(task) || typeof task.task !== "string") throw new Error("Every task needs an assignment body");
      const text = `${typeof input.context === "string" ? input.context : ""}\n${task.task}`;
      const markers = [...text.matchAll(/^\s*atlas_assignment:\s*(\{[^\n]+\})\s*$/gm)];
      if (markers.length !== 1) {
        throw new Error(
          "Each task must include exactly one atlas_assignment JSON line from ledger start; dispatch read-only research children in their own task call",
        );
      }
      const binding: unknown = JSON.parse(markers[0]?.[1] ?? "null");
      const verify = object(binding) && binding.verify !== undefined;
      const entries = object(binding) ? (verify ? binding.verify : binding.rows) : undefined;
      if (
        !object(binding) ||
        binding.planSha256 !== ledger.planSha256 ||
        (verify && binding.rows !== undefined) ||
        !object(entries) ||
        !Object.keys(entries).length
      ) {
        throw new Error("Task assignment does not match the approved plan");
      }
      const rows: Record<string, string> = {};
      for (const [id, attempt] of Object.entries(entries)) {
        const row = ledgerRows(ledger).find((candidate) => candidate.id === id);
        if (bound.has(id)) throw new Error(`${id} is assigned more than once in this batch`);
        if (verify) {
          const verification = row?.verification;
          if (
            row?.status !== "in_progress" ||
            !verification?.attempt ||
            verification.verdict !== undefined ||
            typeof attempt !== "string" ||
            attempt !== verification.attempt
          ) {
            throw new Error(`${id} has no current verification attempt; use atlas_ledger verify before dispatch`);
          }
          if ((task.agent ?? "task") !== verification.dispatchAgent) {
            throw new Error(`${id} verification requires dispatch agent ${verification.dispatchAgent}`);
          }
          if (Object.keys(entries).length !== 1 || !suppliesObjectSchema(task.outputSchema) || task.schemaMode !== "strict") {
            throw new Error("Each verification needs its own fresh child with the supplied outputSchema and schemaMode strict");
          }
        } else {
          if (row?.status !== "in_progress" || typeof attempt !== "string" || attempt !== row.attempt) {
            throw new Error(`${id} has no current started attempt; use atlas_ledger start before dispatch`);
          }
          if (row.receipt) throw new Error(`${id} implementation is already recorded; dispatch its verifier with atlas_ledger verify`);
          if ((task.agent ?? "task") !== row.dispatchAgent) throw new Error(`${id} requires dispatch agent ${row.dispatchAgent}`);
          if (
            id.startsWith("F") &&
            (Object.keys(entries).length !== 1 || !suppliesObjectSchema(task.outputSchema) || task.schemaMode !== "strict")
          ) {
            throw new Error("Each final gate needs its own fresh child with the supplied outputSchema and schemaMode strict");
          }
          if (options.isolationRequired && !id.startsWith("F") && task.isolated !== true) {
            throw new Error(`Host task isolation is on: ${id} is implementation work and must dispatch with isolated: true`);
          }
        }
        bound.add(id);
        rows[id] = attempt;
      }
      return { ledgerId: ledger.ledgerId, sessionId, planSha256: ledger.planSha256, rows, verify, dispatchedAt, artifactsDir };
    });
    this.#dispatches.set(`${sessionId}:${toolCallId}`, assignments);
  }

  discardUnstartedDispatch(sessionId: string, toolCallId: string): void {
    const key = `${sessionId}:${toolCallId}`;
    const assignments = this.#dispatches.get(key);
    if (assignments && ![...this.#children.values()].some((child) => assignments.includes(child.assignment))) this.#dispatches.delete(key);
  }

  #matchingDispatches(parentToolCallId: string, index: number, childAgentId: string, sessionFile: string): Assignment[] {
    const matches: Assignment[] = [];
    // Global events need both the owning session's dispatch and its exact native artifact.
    for (const [key, assignments] of this.#dispatches) {
      const assignment = assignments[index];
      if (!assignment || key !== `${assignment.sessionId}:${parentToolCallId}`) continue;
      if (path.resolve(sessionFile) !== path.resolve(assignment.artifactsDir, `${childAgentId}.jsonl`)) continue;
      matches.push(assignment);
    }
    return matches;
  }

  /** Observation-only dispatch binding, shared by lifecycle and progress; never authenticates completion. */
  matchDispatch(payload: unknown): {
    sessionId: string;
    planSha256: string;
    rows: Readonly<Record<string, string>>;
    childAgentId: string;
    status?: string;
  }[] {
    if (
      !object(payload) ||
      typeof payload.parentToolCallId !== "string" ||
      typeof payload.index !== "number" ||
      typeof payload.sessionFile !== "string"
    )
      return [];
    const childAgentId =
      typeof payload.id === "string"
        ? payload.id
        : object(payload.progress) && typeof payload.progress.id === "string"
          ? payload.progress.id
          : undefined;
    if (!childAgentId) return [];
    return this.#matchingDispatches(payload.parentToolCallId, payload.index, childAgentId, payload.sessionFile).map((assignment) => ({
      sessionId: assignment.sessionId,
      planSha256: assignment.planSha256,
      rows: assignment.rows,
      childAgentId,
      status: this.#children.get(`${assignment.sessionId}:${childAgentId}`)?.status,
    }));
  }

  observe(payload: unknown): void {
    if (
      !object(payload) ||
      typeof payload.parentToolCallId !== "string" ||
      typeof payload.index !== "number" ||
      typeof payload.id !== "string" ||
      typeof payload.sessionFile !== "string" ||
      typeof payload.status !== "string"
    )
      return;
    for (const assignment of this.#matchingDispatches(payload.parentToolCallId, payload.index, payload.id, payload.sessionFile)) {
      const childKey = `${assignment.sessionId}:${payload.id}`;
      const previous = this.#children.get(childKey);
      if (previous?.assignment === assignment && previous.sessionFile === payload.sessionFile) {
        if (payload.status === "started" && (previous.status !== "started" || previous.finalStatus !== undefined)) {
          const startedAt = Date.now();
          if (previous.reactivation) previous.reactivation.supersededAt = startedAt;
          const child: ObservedChild = {
            childAgentId: payload.id,
            assignment,
            status: payload.status,
            sessionFile: payload.sessionFile,
            reactivation: { startedAt },
          };
          this.#children.set(childKey, child);
          this.#reactivations.add(child);
        } else {
          previous.status = payload.status;
          if (previous.reactivation && ["completed", "failed", "aborted"].includes(payload.status))
            previous.reactivation.finishedAt ??= Date.now();
        }
      } else {
        this.#children.set(childKey, { childAgentId: payload.id, assignment, status: payload.status, sessionFile: payload.sessionFile });
      }
    }
  }

  observeTaskResult(sessionId: string, toolCallId: string, details: unknown, isError = false): void {
    const assignments = this.#dispatches.get(`${sessionId}:${toolCallId}`);
    if (!assignments) return;
    for (const assignment of assignments) assignment.returnedAt ??= Date.now();
    // The tool-level flag ORs every member's payload, so it can decide only a call without result details.
    if (!object(details)) {
      if (isError) for (const assignment of assignments) assignment.finalStatus = "failed";
      return;
    }
    if (object(details.async) && Array.isArray(details.progress)) {
      for (const progress of details.progress) {
        if (!object(progress) || typeof progress.id !== "string" || !Number.isInteger(progress.index)) continue;
        const assignment = assignments[progress.index as number];
        if (assignment) {
          assignment.nativeChildId = progress.id;
          if (progress.status === "failed" || progress.status === "aborted") assignment.failedInFinalProgress = true;
        }
      }
    }
    if (Array.isArray(details.results)) {
      for (const result of details.results) {
        if (!object(result) || typeof result.id !== "string" || !Number.isInteger(result.index)) continue;
        const assignment = assignments[result.index as number];
        if (!assignment) continue;
        const child = this.#children.get(`${sessionId}:${result.id}`);
        const finalStatus = result.exitCode === 0 && result.aborted !== true && result.error === undefined ? "completed" : "failed";
        assignment.finalStatus = finalStatus;
        if (child?.assignment === assignment && !child.reactivation)
          child.finalStatus = child.finalStatus === "failed" ? "failed" : finalStatus;
      }
    }
    // A returned synchronous call is terminal even if spawn failed before a child existed.
    // Async task results can contain only the synchronous subset; their remaining jobs stay owned.
    if (!object(details.async)) {
      for (const assignment of assignments) assignment.finalStatus ??= "failed";
    }
  }

  /**
   * Bind returned assignments to the parent's native task jobs. Only the exact job promise's settlement records a final
   * outcome; the retained promise survives the manager evicting its row.
   */
  observeAsyncJobs(sessionId: string, native: NativeJobs): void {
    for (const job of native.jobs) {
      if (
        !object(job) ||
        job.ownerId !== native.ownerId ||
        job.type !== "task" ||
        typeof job.id !== "string" ||
        typeof job.agentId !== "string" ||
        typeof job.startTime !== "number" ||
        !(job.promise instanceof Promise)
      )
        continue;
      for (const assignments of this.#dispatches.values()) {
        for (const assignment of assignments) {
          if (
            assignment.sessionId !== sessionId ||
            assignment.nativeChildId !== job.agentId ||
            assignment.returnedAt === undefined ||
            job.startTime < assignment.dispatchedAt ||
            job.startTime > assignment.returnedAt ||
            assignment.observingSettlement
          )
            continue;
          if (assignment.nativeJobId && (assignment.nativeJobId !== job.id || assignment.nativeJobStart !== job.startTime)) continue;
          assignment.nativeJobId = job.id;
          assignment.nativeJobStart = job.startTime;
          assignment.observingSettlement = true;
          void job.promise.then(
            () => {
              assignment.settled = true;
              assignment.finalStatus = job.status === "completed" && assignment.finalStatus !== "failed" ? "completed" : "failed";
              const child = this.#children.get(`${sessionId}:${job.agentId}`);
              if (child?.assignment === assignment && !child.reactivation) child.finalStatus = assignment.finalStatus;
              native.onSettled();
            },
            () => {
              assignment.settled = true;
              assignment.finalStatus = "failed";
              const child = this.#children.get(`${sessionId}:${job.agentId}`);
              if (child?.assignment === assignment && !child.reactivation) child.finalStatus = "failed";
              native.onSettled();
            },
          );
        }
      }
    }
    for (const assignments of this.#dispatches.values()) {
      for (const assignment of assignments) {
        // Native final mixed-call progress can be the only failure result for a member
        // whose scheduling/inline execution failed. A live job still requires its own outcome.
        if (assignment.sessionId !== sessionId || !assignment.failedInFinalProgress || assignment.nativeJobId) continue;
        assignment.finalStatus = "failed";
        const child = assignment.nativeChildId ? this.#children.get(`${sessionId}:${assignment.nativeChildId}`) : undefined;
        if (child?.assignment === assignment && !child.reactivation) child.finalStatus = "failed";
      }
    }
    this.#observeReactivations(sessionId, native);
  }

  #observeReactivations(sessionId: string, native: NativeJobs): void {
    for (const child of this.#reactivations) {
      const turn = child.reactivation;
      if (!turn || child.assignment.sessionId !== sessionId) continue;
      const candidates = native.jobs.filter((job): job is Record<string, unknown> => {
        if (
          !object(job) ||
          job.ownerId !== native.ownerId ||
          job.type !== "task" ||
          typeof job.id !== "string" ||
          job.agentId !== child.childAgentId ||
          typeof job.startTime !== "number"
        )
          return false;
        if (turn.nativeJobId) return job.id === turn.nativeJobId && job.startTime === turn.nativeJobStart;
        if (
          job.startTime < turn.startedAt ||
          (turn.finishedAt !== undefined && job.startTime > turn.finishedAt) ||
          (turn.supersededAt !== undefined && job.startTime >= turn.supersededAt)
        )
          return false;
        if (child.assignment.nativeJobId === job.id && child.assignment.nativeJobStart === job.startTime) return false;
        return ![...this.#reactivations].some(
          (other) => other !== child && other.reactivation?.nativeJobId === job.id && other.reactivation?.nativeJobStart === job.startTime,
        );
      });
      // Ambiguous generations never authorize a receipt or release writer ownership.
      if (candidates.length !== 1) {
        // The host registers a wake job only for a turn that yields or that the parent woke, always before the turn's
        // terminal lifecycle frame. A finished turn without one, such as a peer's wake answered without yield, never gets
        // one: it stops holding writer ownership, but with no native outcome it never authorizes a receipt.
        if (!candidates.length && !turn.nativeJobId && turn.finishedAt !== undefined) turn.settled = true;
        continue;
      }
      const job = candidates[0];
      if (!job) continue;
      turn.nativeJobId = job.id as string;
      turn.nativeJobStart = job.startTime as number;
      const abortSignal = object(job.abortController) && object(job.abortController.signal) ? job.abortController.signal : undefined;
      // IRC wake jobs wrap untilAborted(signal, outcome.promise). Cancelling the wrapper
      // settles job.promise before the underlying wake/finalizer, so it cannot release ownership.
      if (job.status === "cancelled" || job.status === "aborted" || abortSignal?.aborted === true) continue;
      // Without its own settlement promise a wake job row cannot authenticate a final outcome.
      if (turn.observingSettlement || !(job.promise instanceof Promise)) continue;
      turn.observingSettlement = true;
      void job.promise.then(
        () => {
          if ((job.status !== "completed" && job.status !== "failed") || abortSignal?.aborted === true) return;
          turn.settled = true;
          child.finalStatus = job.status;
          native.onSettled();
        },
        () => {
          // Native manager promises normally absorb run rejection. A rejected wrapper
          // cannot authenticate the underlying wake's final outcome.
          child.finalStatus = "failed";
        },
      );
    }
  }

  /**
   * Lifecycle completion is not final task success, and releases writer ownership only for a finished wake turn the
   * host gave no native job.
   */
  hasPending(sessionId: string, ledgerId: string): boolean {
    return (
      [...this.#dispatches.values()].some((assignments) =>
        assignments.some(
          (assignment) =>
            assignment.sessionId === sessionId &&
            assignment.ledgerId === ledgerId &&
            (assignment.finalStatus === undefined || (assignment.observingSettlement === true && assignment.settled !== true)),
        ),
      ) ||
      [...this.#reactivations].some(
        (child) =>
          child.assignment.sessionId === sessionId && child.assignment.ledgerId === ledgerId && child.reactivation?.settled !== true,
      )
    );
  }

  /**
   * In-progress rows whose current attempt has a final native outcome Atlas has not recorded with atlas_ledger. A row
   * with another child of that attempt still running (a replacement or a woken child) is still being worked, and a
   * HEAVY row waiting for `verify` has no child to report. Observation only: it never authenticates completion.
   */
  unrecordedOutcomes(sessionId: string, ledger: ExecutionLedger): string[] {
    const assignments = [...this.#dispatches.values()]
      .flat()
      .filter((assignment) => assignment.sessionId === sessionId && assignment.ledgerId === ledger.ledgerId);
    const running = (assignment: Assignment) =>
      assignment.finalStatus === undefined ||
      (assignment.observingSettlement === true && assignment.settled !== true) ||
      [...this.#reactivations].some((child) => child.assignment === assignment && child.reactivation?.settled !== true);
    return ledgerRows(ledger).flatMap((row) => {
      const verifying = verificationStatus(row) === "running";
      if (row.status !== "in_progress" || (row.receipt && !verifying)) return [];
      const attempt = verifying ? row.verification?.attempt : row.attempt;
      const own = assignments.filter((assignment) => assignment.verify === verifying && assignment.rows[row.id] === attempt);
      return own.length && !own.some(running) ? [row.id] : [];
    });
  }

  /**
   * Authenticate the row's current child. `verify` captures a HEAVY row's verifier, bound to the verification attempt;
   * the parsed output is returned so the caller can read a verifier's verdict without rereading the file.
   */
  async capture(options: {
    registry: AgentRegistry;
    parentAgentId: string;
    sessionId: string;
    artifactsDir: string;
    ledger: ExecutionLedger;
    row: LedgerItem;
    childAgentId: string;
    priorReceipts: readonly ChildReceipt[];
    verify?: boolean;
  }): Promise<{ receipt: ChildReceipt; output: string }> {
    const { registry, parentAgentId, sessionId, artifactsDir, ledger, row, childAgentId, priorReceipts } = options;
    const verify = options.verify === true;
    if (row.status !== "in_progress" || !row.attempt || row.startedAt === undefined)
      throw new Error(`${row.id} must be started before completion`);
    const attempt = verify ? row.verification?.attempt : row.attempt;
    const startedAt = verify ? row.verification?.startedAt : row.startedAt;
    if (!attempt || startedAt === undefined || (verify && row.verification?.verdict !== undefined))
      throw new Error(`${row.id} has no running verification; use atlas_ledger verify first`);
    if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(childAgentId)) throw new Error("Invalid child agent id");
    const child = registry.get(childAgentId);
    const observed = this.#children.get(`${sessionId}:${childAgentId}`);
    if (child?.kind !== "sub" || child.parentId !== parentAgentId)
      throw new Error("Evidence must belong to a real direct child of this session");
    if (child.status !== "idle" && child.status !== "parked")
      throw new Error(`Evidence child ${childAgentId} is not completed (${child.status})`);
    if (
      observed?.status !== "completed" ||
      observed.assignment.sessionId !== sessionId ||
      observed.assignment.ledgerId !== ledger.ledgerId ||
      observed.assignment.planSha256 !== ledger.planSha256 ||
      observed.assignment.verify !== verify ||
      observed.assignment.rows[row.id] !== attempt ||
      observed.sessionFile !== child.sessionFile ||
      child.createdAt < startedAt
    ) {
      throw new Error(
        "No native successful completion for this current assignment; use a fresh child to revalidate historical or stale work",
      );
    }
    if (observed.reactivation?.settled && observed.finalStatus === undefined) {
      throw new Error(
        "Another agent woke this child after its task, and that turn ended without a native final result, so its output cannot be authenticated; dispatch a fresh child with the row's current atlas_assignment, or reopen the row",
      );
    }
    if (observed.finalStatus !== "completed") {
      throw new Error(
        "The native task has not reported final success, including isolated-work capture; wait for its final result or repair the failure",
      );
    }
    const outputPath = path.join(artifactsDir, `${childAgentId}.md`);
    if (
      !child.history?.outputPath ||
      path.resolve(child.history.outputPath) !== path.resolve(outputPath) ||
      child.sessionFile === null ||
      path.resolve(child.sessionFile) !== path.resolve(artifactsDir, `${childAgentId}.jsonl`)
    ) {
      throw new Error("Child output is not an owned native artifact of this session");
    }
    if (
      (verify || row.id.startsWith("F")) &&
      priorReceipts.some((receipt) => receipt.sessionId === sessionId && receipt.childAgentId === childAgentId)
    ) {
      throw new Error(
        "Final gates and verifications require distinct fresh verification children, never an implementation or previously used verifier child",
      );
    }
    const stat = await fs.lstat(outputPath);
    if (!stat.isFile()) throw new Error("Child evidence must be a native output file, not a link");
    const content = await fs.readFile(outputPath, "utf8");
    if (!content.trim()) throw new Error("Child output is empty");
    if (verify) parseVerifyOutput(content, ledger, row);
    else if (row.id.startsWith("F")) validateGateOutput(content, ledger, row);
    // A lifecycle change during the file read cannot authorize a now-running or replaced generation.
    if (
      registry.get(childAgentId) !== child ||
      (child.status !== "idle" && child.status !== "parked") ||
      this.#children.get(`${sessionId}:${childAgentId}`) !== observed ||
      observed.finalStatus !== "completed"
    )
      throw new Error("Child changed while evidence was being captured; retry after completion");
    return {
      receipt: {
        receiptId: randomUUID(),
        ledgerId: ledger.ledgerId,
        planSha256: ledger.planSha256,
        rowId: row.id,
        attempt,
        childAgentId,
        parentAgentId,
        sessionId,
        childCreatedAt: child.createdAt,
        outputSha256: planDigest(content),
        capturedAt: Date.now(),
        nativeFinal: true,
      },
      output: content,
    };
  }
}

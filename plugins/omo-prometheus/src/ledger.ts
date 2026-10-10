import { createHash, randomUUID } from "node:crypto";

import { isKnownAgent, resolveAgent } from "./agents.ts";

export type ItemStatus = "open" | "in_progress" | "done" | "blocked";
/** Evidence depth. A HEAVY row is done only after a fresh child independently verifies its recorded implementation. */
export type Tier = "light" | "heavy";
/** How finished work leaves the workspace: `pr` and `ship` add the P1 delivery row after every gate. */
export type Delivery = "direct" | "pr" | "ship";
/** Observer view of a HEAVY row's verification; derived, never persisted. */
export type VerificationStatus = "pending" | "running" | "passed" | "failed";

/** Independent check of a HEAVY row's recorded implementation by a fresh verifier child. */
export interface Verification {
  /** Binds one verifier child; absent until `atlas_ledger verify` starts one. */
  attempt?: string;
  startedAt?: number;
  dispatchAgent?: string;
  childAgentId?: string;
  /** The verifier's receipt; present only after a PASS. */
  receipt?: ChildReceipt;
  verdict?: "pass" | "fail";
  /** The verifier's own summary. A FAIL summary stays on the reopened row for the next implementation attempt. */
  summary?: string;
}

export interface LedgerItem {
  id: string;
  title: string;
  agent: string;
  acceptance: string;
  /** Resolved against the live spawnable roster. */
  dispatchAgent?: string;
  dependsOn: string[];
  status: ItemStatus;
  /** T, D and X rows; gates and the delivery row have none. */
  tier?: Tier;
  evidence?: string;
  childAgentId?: string;
  attempt?: string;
  startedAt?: number;
  /** Receipt of the row's own child. A HEAVY row holds its implementation receipt while `in_progress` until verified. */
  receipt?: ChildReceipt;
  /** HEAVY rows only. */
  verification?: Verification;
  /** X rows: the final gate whose rejection created them. D rows: the T or D row whose work surfaced them. */
  origin?: string;
  /** D rows: why the defect belongs to this plan. */
  reason?: string;
  updatedAt: number;
}

/** Where a deferred finding went. `todo` and `report` depend on whether the roadmap is usable in the repository. */
export type TriageDisposition = "todo" | "duplicate" | "wontfix" | "report";

export interface FindingTriage {
  disposition: TriageDisposition;
  /** todo: the Roadmap TODO id; duplicate: what it duplicates; wontfix: the reason; report: an optional note. */
  reference: string;
  at: number;
}

/** Out-of-scope finding recorded during execution; it gets no row, needs a triage before release, and is listed in the final report. */
export interface DeferredFinding {
  /** Stable `O1`, `O2`, … in recording order. */
  id: string;
  title: string;
  reason: string;
  /** Row whose work surfaced it, when one did. */
  origin?: string;
  at: number;
  triage?: FindingTriage;
}

export interface ExecutionLedger {
  version: 6;
  ledgerId: string;
  planFilePath: string;
  planSha256: string;
  items: LedgerItem[];
  /** D rows: in-scope defects found during execution, appended before any gate starts. Every gate waits for them. */
  discoveries: LedgerItem[];
  /** X rows appended after a final gate rejected the work; they are not part of the approved plan text. */
  fixes: LedgerItem[];
  gates: LedgerItem[];
  /** Empty for `direct`; otherwise the single P1 row, which waits for every gate and fix row. */
  deliveries: LedgerItem[];
  deferred: DeferredFinding[];
  delivery: Delivery;
  createdAt: number;
  /** `HEAD` commit of the plan workspace when the bundle was created; absent outside Git or for upgraded ledgers. */
  gitBaseline?: string;
}

export function ledgerRows(ledger: ExecutionLedger): LedgerItem[] {
  return [...ledger.items, ...ledger.discoveries, ...ledger.fixes, ...ledger.gates, ...ledger.deliveries];
}

/** Authenticated native final success, archived with its original session identity in shared evidence. */
export interface ChildReceipt {
  receiptId: string;
  ledgerId: string;
  planSha256: string;
  rowId: string;
  /** The row attempt, or the verification attempt for a verifier receipt. */
  attempt: string;
  childAgentId: string;
  parentAgentId: string;
  sessionId: string;
  childCreatedAt: number;
  outputSha256: string;
  capturedAt: number;
  nativeFinal: true;
}

export function planDigest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

const ROW = /^- \[([ xX~])\] (T\d+|F[1-4])\. (.+)$/;
const DELIVERY_LINE = /^Delivery:(.*)$/;
const ROADMAP_CRITERIA_LINE = /^Roadmap criteria:(.*)$/;
const AGENT_NAME = /^[A-Za-z0-9_-]+$/;
const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** A Roadmap TODO id as `roadmap_todo add` assigns it. */
const TODO_ID = /^T\d{3,}$/;
const DISPOSITIONS: Record<TriageDisposition, true> = { todo: true, duplicate: true, wontfix: true, report: true };
const GATES = [
  { id: "F1", title: "Plan compliance review", agent: "momus" },
  { id: "F2", title: "Code quality review", agent: "deep-high" },
  { id: "F3", title: "Real-surface QA", agent: "deep-low" },
  { id: "F4", title: "Success-criteria fidelity", agent: "deep-high" },
] as const;
const DELIVERY_ROWS = {
  pr: {
    title: "Deliver: push the branch and open a pull request",
    acceptance: "The branch is pushed and an open pull request targets the default branch; the child reports its URL",
  },
  ship: {
    title: "Ship: open a pull request, wait for CI, and merge it",
    acceptance: "The pull request's required checks passed and it is merged; the child reports its URL and the merge commit",
  },
} as const;
/** Requested agent of a verifier child when Atlas names none. */
const VERIFY_AGENT = "deep-high";
const PLAN_GATED: Record<string, true> = { metis: true, momus: true };

type ParsedItem = Omit<LedgerItem, "updatedAt">;

export interface ParsedPlan {
  items: ParsedItem[];
  gates: ParsedItem[];
  delivery: Delivery;
  /**
   * Every `Roadmap criteria:` line at column 0 outside code fences. Only a bound stage with criteria validates them, so
   * they never add grammar errors; a line inside a plan section stays task text, as before the line existed.
   */
  roadmapCriteria: Array<{ line: number; value: string; planLevel: boolean }>;
  errors: string[];
}

/**
 * Parse the approved plan grammar. `legacy` re-derives a pre-v5 ledger's plan exactly as it was approved:
 * it ignores `Tier:` fields (every row stays LIGHT) and takes delivery from one valid `Delivery:` line, else `direct`.
 */
export function parsePlanChecklist(
  planContent: string,
  availableAgents?: readonly string[],
  options: { legacy?: boolean } = {},
): ParsedPlan {
  const legacy = options.legacy === true;
  const items: ParsedItem[] = [];
  const gates: ParsedItem[] = [];
  const errors: string[] = [];
  const deliveryLines: { line: number; value: string }[] = [];
  const deliveryErrors: string[] = [];
  const roadmapCriteria: ParsedPlan["roadmapCriteria"] = [];
  const field = legacy
    ? /^\s+(?:-\s*)?(Agent|Depends on|Acceptance):\s*(.*?)\s*$/i
    : /^\s+(?:-\s*)?(Agent|Depends on|Acceptance|Tier):\s*(.*?)\s*$/i;
  let section: "tasks" | "gates" | undefined;
  let hasTasks = false;
  let hasGates = false;
  let body: string[] = [];
  let current: ParsedItem | undefined;
  let fence: { marker: string; length: number } | undefined;

  const finishTask = () => {
    if (!current || section !== "tasks") return;
    const fields = new Map<string, string>();
    for (const line of body) {
      const match = field.exec(line);
      if (match?.[1] !== undefined && match[2] !== undefined) {
        const key = match[1].toLowerCase();
        if (fields.has(key)) errors.push(`${current.id}: duplicate ${match[1]} field`);
        fields.set(key, match[2]);
      }
    }
    const agent = fields.get("agent");
    if (!agent || !AGENT_NAME.test(agent) || (!isKnownAgent(agent) && !availableAgents?.includes(agent))) {
      errors.push(`${current.id}: Agent must name an available or known fallback agent`);
    } else current.agent = agent;
    const depends = fields.get("depends on");
    if (!depends || !/^(?:none|T[1-9]\d*(?:\s*,\s*T[1-9]\d*)*)$/i.test(depends)) {
      errors.push(`${current.id}: Depends on must list T-ids or none`);
    } else {
      current.dependsOn = depends.toLowerCase() === "none" ? [] : depends.toUpperCase().split(/\s*,\s*/);
    }
    const tier = fields.get("tier");
    if (tier === undefined || /^light$/i.test(tier)) current.tier = "light";
    else if (/^heavy$/i.test(tier)) current.tier = "heavy";
    else {
      current.tier = "light";
      errors.push(`${current.id}: Tier must be LIGHT or HEAVY`);
    }
    current.acceptance = fields.get("acceptance") ?? "";
    if (!current.acceptance) errors.push(`${current.id}: Acceptance must describe an observable check`);
    body = [];
    current = undefined;
  };

  for (const [index, line] of planContent.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    const fenceMarker = fenceMatch?.[1];
    if (fence) {
      if (fenceMarker?.[0] === fence.marker && fenceMarker.length >= fence.length) fence = undefined;
      continue;
    }
    if (fenceMarker) {
      fence = { marker: fenceMarker[0] ?? "", length: fenceMarker.length };
      continue;
    }
    if (/^#{1,2}\s/.test(line)) {
      finishTask();
      if (trimmed === "## Tasks") {
        if (hasTasks) errors.push("Duplicate ## Tasks section");
        hasTasks = true;
        section = "tasks";
      } else if (trimmed === "## Final gates") {
        if (hasGates) errors.push("Duplicate ## Final gates section");
        hasGates = true;
        section = "gates";
      } else section = undefined;
      continue;
    }
    const deliveryLine = DELIVERY_LINE.exec(line);
    if (deliveryLine) {
      if (section) deliveryErrors.push(`Line ${index + 1}: Delivery is a plan-level line outside ## Tasks and ## Final gates`);
      else deliveryLines.push({ line: index + 1, value: (deliveryLine[1] ?? "").trim() });
      continue;
    }
    const criteriaLine = ROADMAP_CRITERIA_LINE.exec(line);
    if (criteriaLine) roadmapCriteria.push({ line: index + 1, value: (criteriaLine[1] ?? "").trim(), planLevel: !section });
    if (!section) continue;
    if (/^- \[/.test(line)) {
      finishTask();
      const match = ROW.exec(line);
      const mark = match?.[1];
      const id = match?.[2];
      const title = match?.[3];
      if (!mark || !id || !title || (section === "tasks" ? !id.startsWith("T") : !id.startsWith("F"))) {
        errors.push(`Line ${index + 1}: malformed ${section} checklist row`);
        continue;
      }
      const entry: ParsedItem = {
        id,
        title: title.trim(),
        agent: "task",
        acceptance: title.trim(),
        dependsOn: [],
        status: /[xX]/.test(mark) ? "done" : mark === "~" ? "in_progress" : "open",
      };
      if (!entry.title) errors.push(`Line ${index + 1}: checklist title is empty`);
      if (section === "tasks") {
        if (id !== `T${items.length + 1}`) errors.push(`Line ${index + 1}: task ids must be unique and sequential from T1`);
        items.push(entry);
        current = entry;
      } else {
        const expected = GATES[gates.length];
        if (!expected || id !== expected.id || entry.title !== expected.title) {
          errors.push(`Line ${index + 1}: final gates must be F1–F4 with their required titles in order`);
        }
        entry.agent = expected?.agent ?? "task";
        gates.push(entry);
      }
    } else if (current && section === "tasks") {
      body.push(line);
    }
  }
  finishTask();
  if (!hasTasks || items.length === 0) errors.push("Missing ## Tasks or T rows");
  if (!hasGates || gates.length !== 4) errors.push("## Final gates must contain exactly four F rows");
  const ids = new Set(items.map((item) => item.id));
  for (const item of items) {
    for (const dependency of item.dependsOn) {
      if (!ids.has(dependency) || dependency === item.id) errors.push(`${item.id}: invalid dependency ${dependency}`);
    }
  }
  const pending = new Map(items.map((item) => [item.id, new Set(item.dependsOn)]));
  for (;;) {
    const ready = [...pending].filter(([, dependencies]) => dependencies.size === 0).map(([id]) => id);
    if (!ready.length) break;
    for (const id of ready) pending.delete(id);
    for (const dependencies of pending.values()) for (const id of ready) dependencies.delete(id);
  }
  if (pending.size && !errors.length) errors.push(`Dependency cycle: ${[...pending.keys()].join(", ")}`);
  for (const gate of gates) gate.dependsOn = [...ids];

  let delivery: Delivery = "direct";
  for (const [index, entry] of deliveryLines.entries()) {
    const value = entry.value.toLowerCase();
    if (index > 0) deliveryErrors.push(`Line ${entry.line}: duplicate Delivery line`);
    else if (value === "direct" || value === "pr" || value === "ship") delivery = value;
    else deliveryErrors.push(`Line ${entry.line}: Delivery must be direct, pr, or ship`);
  }
  if (legacy) {
    // A pre-v5 plan was approved without this grammar; anything but one valid line keeps `direct`.
    if (deliveryErrors.length) delivery = "direct";
    for (const item of items) item.tier = "light";
  } else errors.push(...deliveryErrors);
  return { items, gates, delivery, roadmapCriteria, errors };
}

function buildLedger(
  planFilePath: string,
  planContent: string,
  availableAgents: readonly string[] | undefined,
  gitBaseline: string | undefined,
  legacy: boolean,
): ExecutionLedger {
  if (gitBaseline !== undefined && !GIT_SHA.test(gitBaseline)) throw new Error("Invalid Git baseline commit");
  const parsed = parsePlanChecklist(planContent, availableAgents, { legacy });
  if (parsed.errors.length) throw new Error(parsed.errors.join("; "));
  const now = Date.now();
  const withDispatch = (item: ParsedItem): LedgerItem => ({
    ...item,
    dispatchAgent: resolveAgent(item.agent, availableAgents).dispatchAgent,
    // Plan checkboxes are not receipts. Even checked rows require execution evidence.
    status: "open",
    updatedAt: now,
  });
  const delivery = parsed.delivery === "direct" ? undefined : DELIVERY_ROWS[parsed.delivery];
  return {
    version: 6,
    ledgerId: randomUUID(),
    planFilePath,
    planSha256: planDigest(planContent),
    items: parsed.items.map(withDispatch),
    discoveries: [],
    fixes: [],
    gates: parsed.gates.map(withDispatch),
    deliveries: delivery
      ? [
          withDispatch({
            id: "P1",
            title: delivery.title,
            agent: "task",
            acceptance: delivery.acceptance,
            dependsOn: parsed.gates.map((gate) => gate.id),
            status: "open",
          }),
        ]
      : [],
    deferred: [],
    delivery: parsed.delivery,
    createdAt: now,
    ...(gitBaseline === undefined ? {} : { gitBaseline }),
  };
}

export function createLedger(
  planFilePath: string,
  planContent: string,
  availableAgents?: readonly string[],
  gitBaseline?: string,
): ExecutionLedger {
  return buildLedger(planFilePath, planContent, availableAgents, gitBaseline, false);
}

/**
 * Rebind unfinished rows after the installed roster or spawn policy changes.
 * When neither the requested agent nor its fallbacks are spawnable, a listed agent Atlas chose at start stays bound.
 */
export function refreshDispatchAgents(ledger: ExecutionLedger, availableAgents?: readonly string[]): boolean {
  let changed = false;
  for (const item of ledgerRows(ledger)) {
    if (item.status === "done") continue;
    const resolved = resolveAgent(item.agent, availableAgents).dispatchAgent;
    const chosen = resolved === undefined && item.dispatchAgent !== undefined && availableAgents?.includes(item.dispatchAgent);
    const dispatchAgent = chosen ? item.dispatchAgent : resolved;
    if (item.dispatchAgent === dispatchAgent) continue;
    item.dispatchAgent = dispatchAgent;
    changed = true;
  }
  return changed;
}

export function nextDispatchable(ledger: ExecutionLedger): LedgerItem[] {
  const rows = ledgerRows(ledger);
  const done = new Set(rows.filter((item) => item.status === "done").map((item) => item.id));
  return rows.filter((item) => item.status === "open" && item.dependsOn.every((id) => done.has(id)));
}

/** Rows that can still progress without the user: in progress, or open with every prerequisite done. */
export function movableRows(ledger: ExecutionLedger): LedgerItem[] {
  const next = new Set(nextDispatchable(ledger).map((item) => item.id));
  return ledgerRows(ledger).filter((item) => item.status === "in_progress" || next.has(item.id));
}

export function verificationStatus(row: LedgerItem): VerificationStatus | undefined {
  if (row.tier !== "heavy") return undefined;
  const verification = row.verification;
  if (verification?.verdict === "pass") return "passed";
  if (verification?.attempt !== undefined && verification.verdict === undefined) return "running";
  return verification?.verdict === "fail" ? "failed" : "pending";
}

/** The attempt bound to the child currently working the row: a running verifier, else the row's own attempt. */
export function currentAttempt(row: LedgerItem): string | undefined {
  return verificationStatus(row) === "running" ? row.verification?.attempt : row.attempt;
}

export function isComplete(ledger: ExecutionLedger): boolean {
  return ledgerRows(ledger).every(
    (item) =>
      item.status === "done" &&
      item.receipt !== undefined &&
      (item.tier !== "heavy" || (item.verification?.verdict === "pass" && item.verification.receipt !== undefined)),
  );
}

/**
 * `changedId` renders the compact form returned after a row changes: acceptance and evidence only for that row, so the
 * result stays short on large plans. `status` renders the full table.
 */
export function renderLedgerSummary(ledger: ExecutionLedger, availableAgents?: readonly string[], changedId?: string): string {
  const cell = (text: string) => text.replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|");
  const compact = changedId !== undefined;
  const lines = [
    `Plan ledger: ${ledger.planFilePath} (sha256 ${ledger.planSha256})`,
    compact ? "| ID | Status | Tier | Agent | Depends on |" : "| ID | Status | Tier | Agent | Depends on | Acceptance | Evidence |",
    compact ? "| --- | --- | --- | --- | --- |" : "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  const notes: string[] = [];
  for (const item of ledgerRows(ledger)) {
    const dependsOn = item.dependsOn.join(", ") || "none";
    const dispatch = item.dispatchAgent ?? resolveAgent(item.agent, availableAgents).dispatchAgent;
    const missing = item.status === "done" ? "unavailable" : "unavailable (choose with agent on start)";
    const owner = dispatch === item.agent ? item.agent : `${item.agent} -> ${dispatch ?? missing}`;
    const verification = verificationStatus(item);
    const status = item.status === "in_progress" && item.receipt ? `${item.status} (verify ${verification})` : item.status;
    const row = `| ${item.id}. ${cell(item.title)} | ${status} | ${item.tier?.toUpperCase() ?? "—"} | ${owner} | ${dependsOn} |`;
    lines.push(compact ? row : `${row} ${cell(item.acceptance)} | ${cell(item.evidence ?? "—")} |`);
    if (item.id === changedId) {
      notes.push(`${item.id} acceptance: ${cell(item.acceptance)}`, `${item.id} evidence: ${cell(item.evidence ?? "—")}`);
    }
    if (item.status === "in_progress" && !item.receipt) {
      notes.push(
        `Assignment for ${item.id}: atlas_assignment: ${JSON.stringify({ planSha256: ledger.planSha256, rows: { [item.id]: item.attempt } })}`,
      );
    } else if (item.status === "in_progress" && verification === "running") {
      notes.push(
        `Verify assignment for ${item.id} (agent ${item.verification?.dispatchAgent}): atlas_assignment: ${JSON.stringify({ planSha256: ledger.planSha256, verify: { [item.id]: item.verification?.attempt } })}`,
      );
    } else if (item.status === "in_progress") {
      notes.push(`${item.id} implementation is recorded; start its independent verification with atlas_ledger verify.`);
    }
    if (verification === "failed" && item.status !== "done") {
      notes.push(`Last verification of ${item.id} failed; give the next implementation child: ${cell(item.verification?.summary ?? "")}`);
    }
  }
  lines.push(...notes);
  lines.push(`Delivery: ${ledger.delivery}${ledger.deliveries.length ? ` (${ledger.deliveries.map((row) => row.id).join(", ")})` : ""}`);
  if (ledger.deferred.length) {
    const untriaged = untriagedFindings(ledger).map((finding) => finding.id);
    lines.push(
      `Deferred out-of-scope findings (${ledger.deferred.length}; triage each with atlas_ledger triage and list every one with its disposition in the final report; untriaged: ${untriaged.join(", ") || "none"}):`,
    );
    for (const finding of ledger.deferred) {
      const triage = finding.triage
        ? `${finding.triage.disposition}${finding.triage.reference ? ` ${cell(finding.triage.reference)}` : ""}`
        : "untriaged";
      lines.push(
        `- ${finding.id}. ${cell(finding.title)}: ${cell(finding.reason)}${finding.origin ? ` (from ${finding.origin})` : ""}; triage: ${triage}`,
      );
    }
  }
  const next = nextDispatchable(ledger).map((item) => item.id);
  lines.push(`Next dispatchable: ${next.join(", ") || "none"}`);
  if (compact) lines.push("atlas_ledger status lists every row's acceptance and evidence.");
  return lines.join("\n");
}

function validAgent(agent: unknown): agent is string {
  return typeof agent === "string" && AGENT_NAME.test(agent);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validTriage(value: unknown): boolean {
  if (value === undefined) return true;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const triage = value as Partial<FindingTriage>;
  return (
    typeof triage.disposition === "string" &&
    Object.hasOwn(DISPOSITIONS, triage.disposition) &&
    typeof triage.reference === "string" &&
    (triage.disposition === "report" || nonEmpty(triage.reference)) &&
    (triage.disposition !== "todo" || TODO_ID.test(triage.reference)) &&
    Number.isFinite(triage.at)
  );
}

function validVerification(value: unknown): boolean {
  if (value === undefined) return true;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const verification = value as Partial<Verification>;
  return (
    (verification.attempt === undefined || nonEmpty(verification.attempt)) &&
    (verification.startedAt === undefined || Number.isFinite(verification.startedAt)) &&
    (verification.dispatchAgent === undefined || typeof verification.dispatchAgent === "string") &&
    (verification.childAgentId === undefined || typeof verification.childAgentId === "string") &&
    (verification.receipt === undefined ||
      (verification.receipt !== null && typeof verification.receipt === "object" && !Array.isArray(verification.receipt))) &&
    (verification.verdict === undefined || verification.verdict === "pass" || verification.verdict === "fail") &&
    (verification.summary === undefined || typeof verification.summary === "string")
  );
}

/** Restore structural state only; callers must independently authenticate each completed receipt. */
export function restoreLedger(data: unknown, planFilePath: string, planContent: string, approvedSha256: string): ExecutionLedger {
  if (!data || typeof data !== "object" || !("version" in data)) throw new Error("Execution ledger is not a versioned object");
  const version = data.version;
  if (version !== 1 && version !== 2 && version !== 3 && version !== 4 && version !== 5 && version !== 6) {
    throw new Error("Unsupported execution ledger version");
  }
  // Validate the complete persisted shape and its approved definition below before returning it.
  const saved = data as ExecutionLedger;
  if (saved.planFilePath !== planFilePath || saved.planSha256 !== approvedSha256 || planDigest(planContent) !== approvedSha256) {
    throw new Error("Execution ledger or current plan no longer matches the exact approved plan");
  }
  // Before version 5 there were no tiers, discoveries, deferred findings or delivery rows.
  const legacy = version !== 5 && version !== 6;
  if (
    !Array.isArray(saved.items) ||
    !Array.isArray(saved.gates) ||
    (version >= 3 && !Array.isArray(saved.fixes)) ||
    (!legacy &&
      (!Array.isArray(saved.discoveries) ||
        !Array.isArray(saved.deliveries) ||
        !Array.isArray(saved.deferred) ||
        !["direct", "pr", "ship"].includes(saved.delivery))) ||
    !Number.isFinite(saved.createdAt) ||
    (version !== 1 && saved.gitBaseline !== undefined && (typeof saved.gitBaseline !== "string" || !GIT_SHA.test(saved.gitBaseline)))
  ) {
    throw new Error("Malformed execution ledger rows, creation time, or Git baseline");
  }
  const expected = buildLedger(
    planFilePath,
    planContent,
    saved.items.map((item) => item?.agent),
    undefined,
    legacy,
  );
  if (
    saved.items.length !== expected.items.length ||
    saved.gates.length !== expected.gates.length ||
    (!legacy && (saved.delivery !== expected.delivery || saved.deliveries.length !== expected.deliveries.length))
  ) {
    throw new Error("Execution ledger rows differ from the approved plan");
  }
  const fixes: LedgerItem[] = version >= 3 ? saved.fixes : [];
  const discoveries: LedgerItem[] = legacy ? [] : saved.discoveries;
  const taskIds = expected.items.map((item) => item.id);
  const gateIds = expected.gates.map((gate) => gate.id);
  for (const [index, row] of discoveries.entries()) {
    if (
      !row ||
      row.id !== `D${index + 1}` ||
      !nonEmpty(row.title) ||
      !nonEmpty(row.acceptance) ||
      !nonEmpty(row.reason) ||
      !validAgent(row.agent) ||
      typeof row.origin !== "string" ||
      !(taskIds.includes(row.origin) || discoveries.slice(0, index).some((earlier) => earlier?.id === row.origin)) ||
      (row.tier !== "light" && row.tier !== "heavy")
    ) {
      throw new Error(`Malformed execution ledger discovered row ${row?.id ?? index}`);
    }
  }
  for (const [index, fix] of fixes.entries()) {
    if (
      !fix ||
      fix.id !== `X${index + 1}` ||
      !nonEmpty(fix.title) ||
      !nonEmpty(fix.acceptance) ||
      !validAgent(fix.agent) ||
      typeof fix.origin !== "string" ||
      !gateIds.includes(fix.origin) ||
      (!legacy && fix.tier !== "light" && fix.tier !== "heavy")
    ) {
      throw new Error(`Malformed execution ledger fix row ${fix?.id ?? index}`);
    }
  }
  const discoveryIds = discoveries.map((row) => row.id);
  const fixIds = fixes.map((fix) => fix.id);
  const gateDependencies = (id: string) => [...taskIds, ...discoveryIds, ...fixes.filter((fix) => fix.origin === id).map((fix) => fix.id)];
  const deliveryDefinitions = expected.deliveries.map((row) => ({ ...row, dependsOn: [...gateIds, ...fixIds] }));
  // Pre-v5 ledgers gain the delivery row their approved plan text names.
  const deliveries = legacy ? deliveryDefinitions : saved.deliveries;
  const rows = [...saved.items, ...discoveries, ...fixes, ...saved.gates, ...deliveries];
  const definitions = [
    ...expected.items,
    ...discoveries.map((row) => ({ ...row, dependsOn: [] })),
    ...fixes.map((fix) => ({ ...fix, dependsOn: [] })),
    ...expected.gates.map((gate) => ({ ...gate, dependsOn: gateDependencies(gate.id) })),
    ...deliveryDefinitions,
  ];
  for (const [index, row] of rows.entries()) {
    const definition = definitions[index];
    const dependsOn = JSON.stringify(row?.dependsOn);
    const legacyDependsOn =
      (version === 1 && definition?.id.startsWith("F") && dependsOn === "[]") ||
      // Version two made F4 wait for F1–F3; all gates now run together.
      (version === 2 && definition?.id === "F4" && dependsOn === JSON.stringify([...taskIds, "F1", "F2", "F3"]));
    const planned =
      definition !== undefined && (definition.id.startsWith("T") || definition.id.startsWith("F") || definition.id.startsWith("P"));
    if (
      !row ||
      !definition ||
      row.id !== definition.id ||
      row.title !== definition.title ||
      row.agent !== definition.agent ||
      !Array.isArray(row.dependsOn) ||
      (dependsOn !== JSON.stringify(definition.dependsOn) && !legacyDependsOn) ||
      !["open", "in_progress", "done", "blocked"].includes(row.status) ||
      !Number.isFinite(row.updatedAt) ||
      (row.evidence !== undefined && typeof row.evidence !== "string") ||
      (row.childAgentId !== undefined && typeof row.childAgentId !== "string") ||
      (row.dispatchAgent !== undefined && typeof row.dispatchAgent !== "string") ||
      (version !== 1 && row.acceptance !== definition.acceptance) ||
      // Approved rows keep the plan's tier; appended rows chose theirs when added. Gates and delivery have none.
      (!legacy && planned && row.tier !== definition.tier) ||
      (!legacy && !validVerification(row.verification)) ||
      (!legacy && row.verification !== undefined && row.tier !== "heavy")
    ) {
      throw new Error(`Malformed execution ledger row ${definition?.id ?? index}`);
    }
    if (
      version !== 1 &&
      (row.status === "in_progress" || row.status === "done") &&
      (typeof row.attempt !== "string" || !row.attempt || !Number.isFinite(row.startedAt))
    ) {
      // Missing historical proof reopens below rather than grandfathering completion.
      if (row.status !== "done") throw new Error(`Missing attempt binding for ${row.id}`);
    }
  }
  if (!legacy) {
    for (const [index, finding] of saved.deferred.entries()) {
      if (
        !finding ||
        typeof finding !== "object" ||
        !nonEmpty(finding.title) ||
        !nonEmpty(finding.reason) ||
        (finding.origin !== undefined && typeof finding.origin !== "string") ||
        !Number.isFinite(finding.at) ||
        (version === 6 && (finding.id !== `O${index + 1}` || !validTriage(finding.triage)))
      ) {
        throw new Error(`Malformed execution ledger deferred finding ${version === 6 ? `O${index + 1}` : index + 1}`);
      }
    }
  }
  if (version === 1) return expected;
  if (typeof saved.ledgerId !== "string" || !saved.ledgerId) throw new Error("Missing execution ledger identity");
  if (version === 2) {
    // Migrate in place: callers rely on receiving the same object they persisted.
    saved.fixes = [];
    for (const gate of saved.gates) gate.dependsOn = gateDependencies(gate.id);
  }
  if (legacy) {
    // Version four only added the optional Git baseline; upgraded ledgers stay without one.
    // Version five rows default to LIGHT, so pre-v5 plans keep their per-row evidence rule.
    for (const row of [...saved.items, ...saved.fixes]) row.tier = "light";
    saved.discoveries = [];
    saved.deferred = [];
    saved.delivery = expected.delivery;
    saved.deliveries = deliveries;
  }
  // Version six numbers deferred findings in recording order and adds their triage; earlier findings start untriaged.
  if (version === 5) for (const [index, finding] of saved.deferred.entries()) finding.id = `O${index + 1}`;
  saved.version = 6;
  return saved;
}

/** Reopen one row and discard its attempt. Completed dependents and other gates keep their proof. */
export function reopenRow(ledger: ExecutionLedger, id: string, reason?: string): LedgerItem {
  const row = ledgerRows(ledger).find((item) => item.id === id);
  if (!row) throw new Error(`Unknown ledger row ${id}`);
  row.status = "open";
  row.evidence = reason;
  row.childAgentId = undefined;
  row.attempt = undefined;
  row.startedAt = undefined;
  row.receipt = undefined;
  // Only a verifier's failure summary outlives the attempt; the next implementation child needs it.
  if (row.verification !== undefined) {
    row.verification =
      row.verification.verdict === "fail"
        ? { verdict: "fail", summary: row.verification.summary, childAgentId: row.verification.childAgentId }
        : undefined;
  }
  row.updatedAt = Math.max(Date.now(), row.updatedAt + 1);
  return row;
}

function checkedAgent(agent: string, availableAgents: readonly string[] | undefined, role: string): string {
  if (!AGENT_NAME.test(agent) || (!isKnownAgent(agent) && !availableAgents?.includes(agent))) {
    throw new Error(`${role} agent ${agent} is neither available nor a known fallback agent`);
  }
  return agent;
}

function checkedTier(tier: string | undefined): Tier {
  const value = (tier ?? "light").toLowerCase();
  if (value !== "light" && value !== "heavy") throw new Error("Tier must be LIGHT or HEAVY");
  return value;
}

/**
 * Record the correction a rejecting final gate asked for as a new X row, and make only that gate (and delivery) wait for it.
 * Completed plan rows and the other gates keep their proof.
 */
export function addFixRow(
  ledger: ExecutionLedger,
  gateId: string,
  fix: { title: string; acceptance: string; agent: string; reason: string; tier?: string },
  availableAgents?: readonly string[],
): LedgerItem {
  const gate = ledger.gates.find((item) => item.id === gateId);
  if (!gate) throw new Error(`Fix rows belong to the rejecting final gate (F1–F4), not ${gateId}`);
  if (gate.status === "done") throw new Error(`${gateId} already passed; reopen it before recording a fix`);
  const title = fix.title.trim();
  const acceptance = fix.acceptance.trim();
  const reason = fix.reason.trim();
  if (!title || !acceptance || !reason)
    throw new Error("A fix row requires a title, an observable acceptance check, and the gate's rejection");
  const agent = checkedAgent(fix.agent, availableAgents, "Fix");
  const tier = checkedTier(fix.tier);
  const row: LedgerItem = {
    id: `X${ledger.fixes.length + 1}`,
    title,
    agent,
    acceptance,
    dispatchAgent: resolveAgent(agent, availableAgents).dispatchAgent,
    dependsOn: [],
    status: "open",
    tier,
    evidence: `${gateId} rejected: ${reason}`,
    origin: gateId,
    updatedAt: Date.now(),
  };
  ledger.fixes.push(row);
  gate.dependsOn.push(row.id);
  for (const delivery of ledger.deliveries) delivery.dependsOn.push(row.id);
  reopenRow(ledger, gateId, `Rerun after ${gate.dependsOn.filter((id) => id.startsWith("X")).join(", ")}: ${reason}`);
  return row;
}

/** A gate has run (or been corrected) once any gate holds an attempt or any fix row exists. */
export function gatesStarted(ledger: ExecutionLedger): boolean {
  return ledger.fixes.length > 0 || ledger.gates.some((gate) => gate.status !== "open" || gate.attempt !== undefined);
}

/**
 * Append an in-scope defect found mid-execution as a D row that can dispatch at once; every gate waits for it.
 * Refused once a gate has started: from then on a gate's rejection (fix rows) carries further corrections.
 */
export function addDiscoveredRow(
  ledger: ExecutionLedger,
  origin: string,
  found: { title: string; acceptance: string; agent: string; reason: string; tier?: string },
  availableAgents?: readonly string[],
): LedgerItem {
  if (gatesStarted(ledger)) {
    throw new Error("A final gate has already started; record further in-scope corrections through that gate's rejection with fix");
  }
  if (![...ledger.items, ...ledger.discoveries].some((row) => row.id === origin)) {
    throw new Error(`Discovered work names the T or D row whose work surfaced it, not ${origin || "(missing id)"}`);
  }
  const title = found.title.trim();
  const acceptance = found.acceptance.trim();
  const reason = found.reason.trim();
  if (!title || !acceptance || !reason) {
    throw new Error("Discovered work requires a title, an observable acceptance check, and why it belongs to this plan");
  }
  const agent = checkedAgent(found.agent, availableAgents, "Discovered row");
  const row: LedgerItem = {
    id: `D${ledger.discoveries.length + 1}`,
    title,
    agent,
    acceptance,
    dispatchAgent: resolveAgent(agent, availableAgents).dispatchAgent,
    dependsOn: [],
    status: "open",
    tier: checkedTier(found.tier),
    evidence: `Discovered during ${origin}: ${reason}`,
    origin,
    reason,
    updatedAt: Date.now(),
  };
  ledger.discoveries.push(row);
  for (const gate of ledger.gates) gate.dependsOn.push(row.id);
  return row;
}

/** Record an out-of-scope finding as the next `O` id; it adds no row and nothing waits for it, but release waits for its triage. */
export function addDeferredFinding(ledger: ExecutionLedger, finding: { title: string; reason: string; origin?: string }): DeferredFinding {
  const title = finding.title.trim();
  const reason = finding.reason.trim();
  if (!title || !reason) throw new Error("A deferred finding requires a title and why it is out of scope");
  const origin = finding.origin?.trim() || undefined;
  if (origin !== undefined && !ledgerRows(ledger).some((row) => row.id === origin)) throw new Error(`Unknown ledger row ${origin}`);
  const entry: DeferredFinding = { id: `O${ledger.deferred.length + 1}`, title, reason, ...(origin ? { origin } : {}), at: Date.now() };
  ledger.deferred.push(entry);
  return entry;
}

/** Deferred findings that still lack a disposition; `atlas_release` refuses while any remain. */
export function untriagedFindings(ledger: ExecutionLedger): DeferredFinding[] {
  return ledger.deferred.filter((finding) => finding.triage === undefined);
}

/**
 * Record (or replace) where a deferred finding went. `todo` names the Roadmap TODO created for it and needs a roadmap
 * usable in this repository; `report` is only for repositories without one. `roadmapUsable` is what this session's
 * roadmap handshake reports: false also when no roadmap answered, undefined when an older roadmap answered without
 * saying, which leaves both open.
 */
export function triageFinding(
  ledger: ExecutionLedger,
  id: string,
  disposition: string | undefined,
  reference: string | undefined,
  roadmapUsable: boolean | undefined,
): DeferredFinding {
  const finding = ledger.deferred.find((entry) => entry.id === id);
  if (!finding) {
    throw new Error(
      ledger.deferred.length
        ? `Unknown deferred finding ${id || "(missing id)"}; recorded findings: ${ledger.deferred.map((entry) => entry.id).join(", ")}`
        : "No deferred findings are recorded",
    );
  }
  const text = reference?.trim() ?? "";
  if (disposition === "todo") {
    if (roadmapUsable === false) {
      throw new Error(
        "todo needs a roadmap usable in this repository (the roadmap and adr plugins, a Git work tree and an initialized roadmap), and this session's roadmap handshake reports none; triage as report, duplicate or wontfix",
      );
    }
    if (!TODO_ID.test(text)) {
      throw new Error("todo requires, in evidence, the id of the Roadmap TODO you created with roadmap_todo add (for example T012)");
    }
  } else if (disposition === "report") {
    if (roadmapUsable === true) {
      throw new Error(
        "report is only for repositories without a usable roadmap, and the roadmap is usable in this repository; create a Roadmap TODO with roadmap_todo add and triage as todo, or record duplicate or wontfix",
      );
    }
  } else if (disposition === "duplicate") {
    if (!text) throw new Error("duplicate requires, in evidence, what the finding duplicates: a TODO id, a row id, or a description");
  } else if (disposition === "wontfix") {
    if (!text) throw new Error("wontfix requires the reason in evidence");
  } else {
    throw new Error("triage requires disposition todo, duplicate, wontfix, or report");
  }
  finding.triage = { disposition, reference: text, at: Date.now() };
  return finding;
}

/**
 * Start a fresh attempt. `chosenAgent` is Atlas's pick for a row whose requested agent and fallbacks are all unspawnable;
 * a row that still resolves keeps the approved plan's agent.
 */
export function startRow(ledger: ExecutionLedger, id: string, chosenAgent?: string, availableAgents?: readonly string[]): LedgerItem {
  const rows = ledgerRows(ledger);
  const row = rows.find((item) => item.id === id);
  if (!row) throw new Error(`Unknown ledger row ${id}`);
  if (row.status !== "open") throw new Error(`${id} is ${row.status}; reopen it before starting a fresh attempt`);
  const unfinished = row.dependsOn.filter((dependency) => rows.find((item) => item.id === dependency)?.status !== "done");
  if (unfinished.length) throw new Error(`${id} depends on unfinished rows: ${unfinished.join(", ")}`);
  const resolved = resolveAgent(row.agent, availableAgents).dispatchAgent;
  if (chosenAgent !== undefined && chosenAgent !== row.dispatchAgent) {
    if (resolved !== undefined) {
      throw new Error(`${id} dispatches to ${resolved}; choose an agent only for a row whose requested agent is unavailable`);
    }
    if (!availableAgents?.includes(chosenAgent)) {
      throw new Error(`${chosenAgent} is not a spawnable agent; choose one of: ${availableAgents?.join(", ") || "(none)"}`);
    }
    row.dispatchAgent = chosenAgent;
  }
  if (!row.dispatchAgent) {
    throw new Error(
      availableAgents?.length
        ? `${id} requests ${row.agent}, which cannot be spawned; start it again with agent set to the best fit among: ${availableAgents.join(", ")}`
        : `${id} has no available dispatch agent`,
    );
  }
  row.status = "in_progress";
  row.attempt = randomUUID();
  row.startedAt = Date.now();
  row.updatedAt = Math.max(row.startedAt, row.updatedAt + 1);
  row.evidence = undefined;
  return row;
}

/** Record an authenticated receipt of the row's own child. A HEAVY row then waits for its verification. */
export function recordReceipt(row: LedgerItem, receipt: ChildReceipt, evidence: string): void {
  row.receipt = receipt;
  row.childAgentId = receipt.childAgentId;
  row.evidence = evidence;
  if (row.tier === "heavy") row.verification = {};
  else row.status = "done";
  row.updatedAt = Math.max(Date.now(), row.updatedAt + 1);
}

/** Bind a fresh verifier to a HEAVY row whose implementation is recorded; a restart replaces an unfinished verifier. */
export function startVerification(
  ledger: ExecutionLedger,
  id: string,
  chosenAgent?: string,
  availableAgents?: readonly string[],
): LedgerItem {
  const row = ledgerRows(ledger).find((item) => item.id === id);
  if (!row) throw new Error(`Unknown ledger row ${id}`);
  if (row.tier !== "heavy") throw new Error(`${id} is not HEAVY; only HEAVY rows get an independent verification child`);
  if (row.status !== "in_progress" || !row.receipt) {
    throw new Error(`${id} has no recorded implementation to verify; mark its implementation child done first`);
  }
  if (chosenAgent !== undefined) {
    if (PLAN_GATED[chosenAgent]) throw new Error(`${chosenAgent} stays plan-gated and cannot verify execution rows`);
    if (availableAgents !== undefined && !availableAgents.includes(chosenAgent)) {
      throw new Error(`${chosenAgent} is not a spawnable agent; choose one of: ${availableAgents.join(", ") || "(none)"}`);
    }
    checkedAgent(chosenAgent, availableAgents, "Verification");
  }
  const dispatchAgent = chosenAgent ?? resolveAgent(VERIFY_AGENT, availableAgents).dispatchAgent;
  if (!dispatchAgent) {
    throw new Error(
      `No verification agent can be spawned; start verify again with agent set to one of: ${availableAgents?.join(", ") || "(none)"}`,
    );
  }
  const startedAt = Date.now();
  row.verification = { attempt: randomUUID(), startedAt, dispatchAgent };
  row.updatedAt = Math.max(startedAt, row.updatedAt + 1);
  return row;
}

/**
 * Record the verifier's authenticated verdict. PASS completes the row; FAIL reopens it for a new implementation
 * attempt and keeps the verifier's summary for that attempt's assignment.
 */
export function recordVerification(
  ledger: ExecutionLedger,
  row: LedgerItem,
  result:
    | { verdict: "pass"; receipt: ChildReceipt; summary: string; evidence: string }
    | { verdict: "fail"; childAgentId: string; summary: string },
): void {
  const verification = row.verification;
  if (row.tier !== "heavy" || row.status !== "in_progress" || !verification?.attempt || verification.verdict !== undefined) {
    throw new Error(`${row.id} has no running verification`);
  }
  if (result.verdict === "pass") {
    row.verification = {
      ...verification,
      childAgentId: result.receipt.childAgentId,
      receipt: result.receipt,
      verdict: "pass",
      summary: result.summary,
    };
    row.evidence = `${row.evidence ?? ""}\nVerified: ${result.evidence}`.trim();
    row.status = "done";
    row.updatedAt = Math.max(Date.now(), row.updatedAt + 1);
    return;
  }
  row.verification = { verdict: "fail", summary: result.summary, childAgentId: result.childAgentId };
  reopenRow(ledger, row.id, `Verification failed: ${result.summary}`);
}

/** Discard a verifier binding that can no longer report (interrupted or resumed elsewhere); the implementation stays. */
export function resetVerification(row: LedgerItem): void {
  if (row.tier !== "heavy" || !row.receipt) return;
  row.verification = {};
  row.updatedAt = Math.max(Date.now(), row.updatedAt + 1);
}

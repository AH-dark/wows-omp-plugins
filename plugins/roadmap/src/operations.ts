import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";

import {
  ADR_INSTALL_HINT,
  type AdrApi,
  type AdrCreateInput,
  type AdrRecord,
  type AdrView,
  type AdrWriteResult,
  errorMessage,
  withPendingStages,
} from "./adr.ts";
import type { AtlasStagePlan } from "./atlas.ts";
import { check, checkClosureIntegrity, type Diagnostics } from "./check.ts";
import {
  DocumentError,
  type DoneCriterion,
  generatedBlock,
  isCalendarDate,
  lf,
  loadAll,
  type Model,
  parseDoneCriteria,
  parseRoadmapIndex,
  parseRound,
  parseStage,
  parseTodo,
  type Repo,
  ROUND_ASSESSMENTS,
  type RoundAssessment,
  type RoundDoc,
  renderRoadmapIndex,
  renderRound,
  renderStage,
  renderStageTable,
  renderTodo,
  requiredFormat,
  roundFiles,
  roundSha256,
  type StageDoc,
  sha256,
  stageSha256,
  type TodoDoc,
  type TodoItem,
  today,
  upgradeRoadmapIndex,
  validateBody,
} from "./documents.ts";
import { renderHandoff } from "./handoff.ts";
import { guardCancellation, guardMutation } from "./mutation-guard.ts";
import { allocate, type IdKind, withRepoLock } from "./numbering.ts";

export interface Actor {
  sessionId: string;
  kind: "main" | "sub";
}

export type Receipt =
  | { ok: true; summary: string; changedFiles: string[]; warnings: string[]; handoff?: string }
  | { ok: false; reason: string; hints: string[] };

export interface CriterionInput {
  id?: string;
  statement: string;
  verify: string;
}

export interface StageInput {
  id?: string;
  title: string;
  objective: string;
  scope_in: string[];
  scope_out: string[];
  done_criteria: CriterionInput[];
  depends_on?: string[];
  follows?: string;
  design_constraints?: string;
  risks?: string;
}

export interface StageOperationInput extends Partial<StageInput> {
  action: "add" | "edit" | "amend" | "start" | "close" | "drop" | "renumber";
  /** add only: the active round (default) or a planned round. */
  round?: string;
  /** YYYY-MM-DD, or none to clear on edit and amend. */
  target?: string;
  reason?: string;
  amendments?: {
    add?: CriterionInput[];
    modify?: DoneCriterion[];
    remove?: string[];
    scope?: Array<{ op: "add" | "remove"; side: "in" | "out"; item: string }>;
  };
  delivered?: string;
  deviations?: string;
  evidence?: Array<{ criterion: string; result: "pass" | "fail"; method: string; summary: string; commit?: string }>;
  todos?: Array<{ id: string; disposition: "resolved" | "moved"; target?: string; reference?: string }>;
  new_id?: string;
}

export interface TodoOperationInput {
  action: "add" | "update" | "resolve" | "move";
  id?: string;
  title?: string;
  severity?: "high" | "normal" | "low";
  source?: string;
  target?: string;
  trigger?: string;
  body?: string;
  reference?: string;
}

/** An initial ADR of /init-project: `id` is an alias that principles and stage text may cite, `stage` names an initial stage alias. */
export interface InitAdrInput extends AdrCreateInput {
  id?: string;
}

export interface RoundInput {
  title: string;
  goal: string;
  constraints: string[];
  non_goals: string[];
  principles: Array<{ text: string; adrs: string[] }>;
}

export interface InitInput {
  project: { name: string; description: string };
  round: RoundInput;
  adrs: InitAdrInput[];
  stages: StageInput[];
}

export interface RoundOpenInput {
  /** Required for a new round; replaces the charter of the planned round being activated, or omitted to keep it. */
  round?: RoundInput;
  import_todos: string[];
  /** The planned round to activate; only the lowest-numbered one qualifies, which is also the default. */
  activate?: string;
}

export interface RoundPlanInput {
  /** A planned round whose charter this revises; omitted drafts a new planned round. */
  id?: string;
  round: RoundInput;
  /** YYYY-MM-DD, or none to clear on revision. */
  target?: string;
}

export interface RoundCloseInput {
  expected: { id: string; sha256: string };
  dispositions: Array<{ id: string; disposition: "resolved" | "wontfix" | "carried"; reference?: string }>;
  /** How the round goal turned out; required in format-2 repositories, refused in format 1. */
  outcome?: { assessment: RoundAssessment; summary: string };
  /** The user's Yes to the format-2 upgrade; a format-1 repository is upgraded in the same write, so a refused close changes nothing. */
  upgrade?: boolean;
}

export interface OperationOptions {
  writeFile?: (path: string, content: string, options?: OperationOptions) => Promise<void>;
  signal?: AbortSignal;
}

interface MutationOptions extends OperationOptions {
  guard?: (model: Model) => Receipt | undefined;
  onSuccess?: () => void;
}

export interface StageOptions extends MutationOptions {
  /**
   * The Atlas plans bound to the stage, as the tool layer asked omo-prometheus; undefined when nothing answered. Start
   * shows them in the handoff; close records the unfinished ones as a deviation.
   */
  plans?: readonly AtlasStagePlan[];
  /**
   * Start runs inside native plan mode, which cannot commit: validate and bind without writing, leaving a planned stage
   * planned until execution starts it.
   */
  planning?: boolean;
}

export interface PreparedOperation {
  repoRoot: string;
  snapshot: string;
  summary: string;
  /** Every file the preview shows: roadmap files first, then the ADR files the adr plugin writes. */
  files: Array<{ path: string; content: string }>;
  warnings: string[];
  /** /init-project only: the confirmed ADR batch, created through the adr plugin before any roadmap file is written. */
  adr?: PreparedAdrs;
}

interface PreparedAdrs {
  inputs: AdrCreateInput[];
  /** Absolute paths and contents from the preview's dry run. */
  files: Array<{ path: string; content: string }>;
  ids: string[];
  /** Stage ids the batch links before docs/roadmap exists; the stage resolver accepts them during the write. */
  stages: string[];
}

export type PreparationReceipt =
  | { ok: true; summary: string; files: PreparedOperation["files"]; warnings: string[]; prepared: PreparedOperation }
  | Extract<Receipt, { ok: false }>;

class Refusal extends Error {
  constructor(
    message: string,
    readonly hints: string[] = [],
  ) {
    super(message);
  }
}

const preparedModels = new WeakMap<PreparedOperation, Model>();
const BODY_REPAIR_HINT =
  "Use plain paragraphs or flat lists with plain-text items. Keep inline code on one line; put literal Markdown or HTML inside a fully closed top-level fenced code block. Use spaces, not tabs, outside fences; single-line fields accept only plain text and same-line code spans.";
const UPGRADE_HINT = "Ask the user to run /roadmap upgrade; agents never change the repository format.";
export const FORMAT_WARNING = "This upgrades the repository to roadmap format 2: roadmap plugin 0.2.3 and earlier can no longer read it.";

function adrService(repo: Repo): AdrApi {
  if (!repo.adr) throw new Refusal("Roadmap needs the adr plugin, which is not loaded in this session.", [ADR_INSTALL_HINT]);
  return repo.adr;
}

/** Calls the adr plugin; its errors carry user-facing guidance and become refusals. */
async function adrCall<T>(context: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof Refusal) throw error;
    throw new Refusal(`${context}: ${errorMessage(error)}`);
  }
}

/** The ADRs a write depends on, as loadAll read them through the adr plugin. */
function adrView(model: Model): AdrView {
  const view = model.adrs;
  if (!view) throw new Refusal("Roadmap needs the adr plugin to read ADRs, and it is not loaded in this session.", [ADR_INSTALL_HINT]);
  if (view.error) throw new Refusal(`ADRs could not be read: ${view.error}`, ["Run adr_check and repair docs/adr/, then retry."]);
  return view;
}

/** An ADR that a charter cites must exist and be readable. */
function citedAdr(model: Model, id: string | undefined): AdrRecord {
  const view = adrView(model);
  const wanted = required(id, "ADR id");
  const matches = view.records.filter((record) => record.id === wanted);
  if (matches.length === 1) return matches[0] as AdrRecord;
  const broken = view.parseErrors.find((issue) => Number(basename(issue.path).split("-")[0]) === numberOf(wanted));
  if (!matches.length && broken)
    throw new Refusal(`ADR ${wanted} could not be read: ${broken.message}`, [
      `Repair ${broken.path} or restore it with git, then run adr_check.`,
    ]);
  throw new Refusal(`ADR ${wanted} is missing or ambiguous.`, [
    view.managed
      ? "Call adr_status for ADR ids; record a new decision with adr_manage first."
      : "ADR management is not initialized in this repository; the user initializes it with /adr init, then decisions are recorded with adr_manage.",
  ]);
}

function required(value: string | undefined, field: string, multiline = false): string {
  if (typeof value !== "string" || !value.trim() || (!multiline && /[\r\n]/.test(value))) {
    throw new Refusal(
      `${field} must be non-empty${multiline ? "" : " and single-line"}.`,
      !multiline && typeof value === "string" && /[\r\n]/.test(value) ? [`Use single-line text for this field. ${BODY_REPAIR_HINT}`] : [],
    );
  }
  return value.replace(/\r\n/g, "\n");
}

function lines(values: string[] | undefined, field: string): string {
  if (!Array.isArray(values)) throw new Refusal(`${field} must be a list.`);
  return values.map((value) => `- ${requiredBody(value, field)}`).join("\n");
}

function normalizedFields(doc: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(doc)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, typeof value === "string" ? lf(value) : value]),
  );
}

function sameFields(actual: object, intended: object): boolean {
  const fields = normalizedFields(intended);
  const entries = Object.entries(normalizedFields(actual));
  return (
    entries.length === Object.keys(fields).length &&
    entries.every(([key, value]) => {
      const intendedValue = fields[key];
      return Array.isArray(value)
        ? Array.isArray(intendedValue) &&
            value.length === intendedValue.length &&
            value.every((entry, index) => entry === intendedValue[index])
        : value === intendedValue;
    })
  );
}

function requiredBody(value: string | undefined, field: string): string {
  const body = required(value, field);
  assertBody(body, { inlineOnly: true });
  return body;
}

function assertBody(body: string, options: Parameters<typeof validateBody>[1] = {}): void {
  try {
    validateBody(body, options);
  } catch (error) {
    if (error instanceof DocumentError) throw new Refusal(`Body changes the document structure: ${error.message}`, [BODY_REPAIR_HINT]);
    throw error;
  }
}

function slug(title: string): string {
  const result = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return result || "untitled";
}

function numberOf(id: string): number {
  return Number(id.replace(/\D/g, ""));
}

function highest(model: Model, kind: IdKind): number {
  const ids = kind === "round" ? model.rounds : kind === "stage" ? model.stages : model.todos.flatMap((doc) => doc.items);
  return Math.max(0, ...ids.map((doc) => numberOf(doc.id)));
}

function failure(error: unknown): Extract<Receipt, { ok: false }> {
  if (error instanceof Refusal) return { ok: false, reason: error.message, hints: error.hints };
  if (error instanceof DocumentError)
    return { ok: false, reason: error.message, hints: ["Run roadmap_check and repair the document structure.", BODY_REPAIR_HINT] };
  return {
    ok: false,
    reason: error instanceof Error ? error.message : String(error),
    hints: [
      "A partial write may have left stale indexes. Run roadmap_check; use check --fix for generated blocks, or restore other damage with git.",
    ],
  };
}

function actorValid(actor: Actor, mainOnly = false): void {
  required(actor.sessionId, "sessionId");
  if (actor.kind !== "main" && actor.kind !== "sub") throw new Refusal("Unknown actor kind.");
  if (mainOnly && actor.kind !== "main") throw new Refusal("This operation requires the main session acting on a user command.");
}

function activeRound(model: Model): RoundDoc {
  const rounds = model.rounds.filter((round) => round.status === "active");
  if (rounds.length !== 1) throw new Refusal("Exactly one active round is required.", ["Use /roadmap new-round when no round is active."]);
  return rounds[0] as RoundDoc;
}

function findStage(model: Model, id: string | undefined): StageDoc {
  const matches = model.stages.filter((stage) => stage.id === required(id, "stage id"));
  if (matches.length !== 1) throw new Refusal(`Stage ${id} is missing or ambiguous.`);
  return matches[0] as StageDoc;
}

function findRound(model: Model, id: string | undefined): RoundDoc {
  const round = model.rounds.find((candidate) => candidate.id === required(id, "round id"));
  if (!round) throw new Refusal(`Round ${id} is missing.`);
  return round;
}

/** Planned stages of planned rounds stay editable; only the active round's stages start. */
function editableStage(model: Model, id: string | undefined): StageDoc {
  const stage = findStage(model, id);
  const status = model.rounds.find((round) => round.id === stage.round)?.status;
  if (status !== "active" && status !== "planned") throw new Refusal(`${stage.id} belongs to a frozen or inactive round.`);
  return stage;
}

function targetDate(value: string): string | null {
  if (value === "none") return null;
  if (!isCalendarDate(value)) throw new Refusal(`Target ${value} must be a calendar date YYYY-MM-DD, or none.`);
  return value;
}

/** A format-1 file becomes format 2 only when a write gives it a format-2 field, and only in a format-2 repository. */
function promote(model: Model, doc: StageDoc | RoundDoc): void {
  const needed = requiredFormat(doc);
  if (needed <= doc.format) return;
  if (model.index.format < needed)
    throw new Refusal(`${doc.id} needs roadmap format 2 for a target date or a planned or dropped round; this repository is format 1.`, [
      UPGRADE_HINT,
    ]);
  doc.format = needed;
}

function roundTodo(model: Model, round: RoundDoc): TodoDoc {
  const doc = model.todos.find((todo) => todo.round === round.id);
  if (!doc) throw new Refusal(`The TODO document for ${round.id} is missing.`);
  return doc;
}

function target(model: Model, input: { target?: string; trigger?: string }): { target?: string; trigger?: string } {
  let stageId = input.target;
  let trigger = input.trigger;
  if (stageId?.startsWith("trigger:")) {
    if (trigger !== undefined) throw new Refusal("Provide exactly one target stage or trigger.");
    trigger = stageId.slice("trigger:".length).trim();
    stageId = undefined;
  }
  if ((stageId !== undefined) === (trigger !== undefined)) throw new Refusal("Provide exactly one target stage or trigger.");
  if (trigger !== undefined) return { trigger: required(trigger, "trigger") };
  const stage = editableStage(model, stageId);
  if (stage.status !== "planned" && stage.status !== "active") throw new Refusal(`TODO target ${stage.id} is ${stage.status}.`);
  return { target: stage.id };
}

async function checked(model: Model, issues?: Diagnostics[]): Promise<string[]> {
  const diagnostics = issues ?? (await check(model));
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length) {
    throw new Refusal(
      "Document check has errors; the operation was refused.",
      errors.map((error) => `${error.rule}: ${error.path}: ${error.message}`),
    );
  }
  return diagnostics.map((diagnostic) => diagnostic.message);
}

function assertNotCancelled(options: OperationOptions): void {
  const cancelled = guardCancellation(options);
  if (cancelled) throw new Refusal(cancelled.reason, cancelled.hints);
}

export async function atomicWrite(path: string, content: string, options: OperationOptions = {}): Promise<void> {
  assertNotCancelled(options);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    assertNotCancelled(options);
    await writeFile(temporary, content, { flag: "wx" });
    assertNotCancelled(options);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

class Mutation {
  readonly changes = new Map<string, string>();
  readonly removals = new Set<string>();
  readonly warnings: string[] = [];
  handoff?: string;
  readOnly = false;
  /** A renumbered stage's ADR links, moved through the adr plugin after the roadmap files are written. */
  relink?: { from: string; to: string; ids: string[] };
  /** /init-project's ADR batch, shown in the preview and written through the adr plugin. */
  adr?: PreparedAdrs;

  constructor(readonly model: Model) {}

  put(path: string, content: string): void {
    const todo = this.model.todos.find((doc) => doc.path === path);
    if (todo) {
      let candidate: TodoDoc;
      try {
        candidate = parseTodo(content, path);
      } catch (error) {
        if (error instanceof DocumentError)
          throw new Refusal(`TODO body changes the document structure: ${error.message}`, [BODY_REPAIR_HINT]);
        throw error;
      }
      const expected = [...todo.items.filter((item) => item.status === "open"), ...todo.items.filter((item) => item.status !== "open")];
      if (
        candidate.items.length !== expected.length ||
        candidate.items.some((item, index) => !sameFields(item, expected[index] as TodoItem))
      )
        throw new Refusal("TODO body changes intended item ids, order, metadata or bodies in the document structure.", [BODY_REPAIR_HINT]);
      Object.assign(todo, candidate);
    }
    const stage = this.model.stages.find((doc) => doc.path === path);
    if (stage) {
      const candidate = parseStage(content, path);
      if (!sameFields(candidate, stage))
        throw new Refusal("Stage body changes intended metadata or sections in the document structure.", [BODY_REPAIR_HINT]);
    }
    const round = this.model.rounds.find((doc) => doc.path === path);
    if (round) {
      if (!sameFields(parseRound(content, path), round))
        throw new Refusal("Round body changes intended metadata or sections in the document structure.", [BODY_REPAIR_HINT]);
    }
    const previous = this.model.files?.[path];
    if (previous !== undefined && Buffer.from(previous).toString("utf8") === content) return;
    this.changes.set(path, content);
    this.model.files ??= {};
    this.model.files[path] = content;
  }

  remove(path: string): void {
    this.removals.add(path);
    if (this.model.files) delete this.model.files[path];
  }

  indexes(): void {
    for (const round of this.model.rounds.filter((round) => round.status === "active" || round.status === "planned")) {
      round.stages = generatedBlock(
        "stages",
        renderStageTable(
          this.model.stages.filter((stage) => stage.round === round.id),
          round.format,
        ),
      );
      this.put(round.path, renderRound(round));
    }
    this.put(this.model.index.path, renderRoadmapIndex(this.model.index, this.model.rounds, this.model.stages));
  }

  /** `written` lists files an earlier step of this operation already committed, for cancellation guidance. */
  async write(repo: Repo, summary: string, options: OperationOptions, written: readonly string[] = []): Promise<Receipt> {
    const changedFiles: string[] = [...written];
    try {
      for (const [path, content] of this.changes) {
        assertNotCancelled(options);
        await (options.writeFile ?? atomicWrite)(path, content, options);
        changedFiles.push(relative(repo.repoRoot, path));
      }
      for (const path of this.removals) {
        assertNotCancelled(options);
        await rm(path);
        changedFiles.push(relative(repo.repoRoot, path));
      }
    } catch (error) {
      const cancelled = guardCancellation(options, changedFiles);
      if (cancelled) return cancelled;
      throw error;
    }
    const cancelled = guardCancellation(options, changedFiles);
    if (cancelled) return cancelled;
    return {
      ok: true,
      summary,
      changedFiles,
      warnings: [...new Set(this.warnings)],
      ...(this.handoff ? { handoff: this.handoff } : {}),
    };
  }
}

async function mutate(
  repo: Repo,
  actor: Actor,
  change: (mutation: Mutation) => Promise<string>,
  options: MutationOptions,
): Promise<Receipt> {
  try {
    actorValid(actor);
    return await withRepoLock(repo, async () => {
      const model = await loadAll(repo);
      if (model.parseErrors?.length)
        throw new Refusal(
          "Managed documents could not be loaded.",
          model.parseErrors.map((issue) => issue.message),
        );
      const guarded = guardMutation(model, options);
      if (guarded) return guarded;
      await checked(model, checkClosureIntegrity(model));
      const mutation = new Mutation(model);
      const summary = await change(mutation);
      if (!mutation.readOnly) mutation.indexes();
      mutation.warnings.push(...(await checked(model)));
      const beforeWrite = guardMutation(model, options);
      if (beforeWrite) return beforeWrite;
      let receipt = await mutation.write(repo, summary, options);
      if (receipt.ok && mutation.relink) receipt = await relinkAdrs(repo, actor, mutation.relink, receipt, options);
      if (receipt.ok) {
        const cancelled = guardCancellation(options, receipt.changedFiles);
        if (cancelled) return cancelled;
        options.onSuccess?.();
      }
      return receipt;
    });
  } catch (error) {
    return failure(error);
  }
}

/** Moves ADR stage links after a renumbering wrote docs/roadmap; the two writes are not one transaction. */
async function relinkAdrs(
  repo: Repo,
  actor: Actor,
  relink: NonNullable<Mutation["relink"]>,
  receipt: Extract<Receipt, { ok: true }>,
  options: OperationOptions,
): Promise<Receipt> {
  try {
    const result = await adrService(repo).relinkStage(repo.repoRoot, actor.kind, relink.from, relink.to, { signal: options.signal });
    return {
      ...receipt,
      changedFiles: [...receipt.changedFiles, ...result.files.map((file) => file.path)],
      warnings: [...new Set([...receipt.warnings, ...result.warnings])],
    };
  } catch (error) {
    return {
      ok: false,
      reason: `Renumbered ${relink.from} to ${relink.to} in docs/roadmap/, but ${relink.ids.join(", ")} still link to ${relink.from}: ${errorMessage(error)}`,
      hints: [
        `Files committed by the renumbering: ${receipt.changedFiles.join(", ")}.`,
        "A multi-file operation is not a transaction. Restore docs/roadmap/ and docs/adr/ with git, then renumber again; until then roadmap_check reports the dangling ADR stage links.",
      ],
    };
  }
}

function criteria(inputs: CriterionInput[] | undefined, reserved: string[] = []): DoneCriterion[] {
  if (!Array.isArray(inputs) || !inputs.length) throw new Refusal("At least one done criterion is required.");
  const used = new Set(reserved);
  for (const input of inputs) {
    if (input.id !== undefined) {
      if (!/^DC[1-9]\d*$/.test(input.id) || used.has(input.id)) throw new Refusal(`Invalid or reused done criterion ${input.id}.`);
      used.add(input.id);
    }
  }
  let next = Math.max(0, ...[...used].map((id) => Number(id.slice(2))));
  return inputs.map((input) => ({
    id: input.id ?? `DC${++next}`,
    statement: requiredBody(input.statement, "criterion statement"),
    verify: requiredBody(input.verify, "criterion verify method"),
  }));
}

function renderCriteria(items: DoneCriterion[]): string {
  return items.map((item) => `- ${item.id} — ${item.statement}\n  - Verify: ${item.verify}`).join("\n");
}

async function newStage(repo: Repo, model: Model, input: Partial<StageInput> & { round?: string; target?: string }): Promise<StageDoc> {
  const round = input.round === undefined ? activeRound(model) : findRound(model, input.round);
  if (round.status !== "active" && round.status !== "planned")
    throw new Refusal(`Stages can be added only to the active round or a planned round; ${round.id} is ${round.status}.`);
  const target = input.target === undefined ? null : targetDate(input.target);
  if (target !== null && model.index.format === 1)
    throw new Refusal("Stage target dates need roadmap format 2; this repository is format 1.", [UPGRADE_HINT]);
  const title = required(input.title, "stage title");
  const objective = required(input.objective, "objective", true);
  assertBody(objective);
  if (input.design_constraints !== undefined) assertBody(input.design_constraints);
  if (input.risks !== undefined) assertBody(input.risks);
  const scopeIn = lines(input.scope_in, "scope_in");
  const scopeOut = lines(input.scope_out, "scope_out");
  const doneCriteria = renderCriteria(criteria(input.done_criteria));
  const n = await allocate(repo, "stage", highest(model, "stage"));
  const stage: StageDoc = {
    format: model.index.format,
    path: join(dirname(round.path), "stages", `${String(n).padStart(2, "0")}-${slug(title)}.md`),
    id: `S${String(n).padStart(2, "0")}`,
    title,
    round: round.id,
    status: "planned",
    target,
    depends_on: input.depends_on ?? [],
    follows: input.follows ?? null,
    created: today(),
    started: null,
    closed: null,
    closed_sha256: null,
    objective,
    scope_in: scopeIn,
    scope_out: scopeOut,
    done_criteria: doneCriteria,
    amendments: "",
    free_work_log: "",
    ...(input.design_constraints !== undefined ? { design_constraints: input.design_constraints } : {}),
    ...(input.risks !== undefined ? { risks: input.risks } : {}),
  };
  model.stages.push(stage);
  return stage;
}

function amend(stage: StageDoc, input: StageOperationInput): void {
  const reason = requiredBody(input.reason, "amendment reason");
  const changes = input.amendments ?? {};
  const retarget = input.target === undefined ? undefined : targetDate(input.target);
  if (![changes.add, changes.modify, changes.remove, changes.scope].some((entries) => entries?.length) && retarget === undefined) {
    throw new Refusal("An amendment needs at least one criterion, scope or target change.");
  }
  if (retarget === stage.target) throw new Refusal(`${stage.id} already has ${retarget === null ? "no target" : `target ${retarget}`}.`);
  let current = parseDoneCriteria(stage.done_criteria);
  const log: string[] = [];
  const touched = new Set<string>();
  for (const modification of changes.modify ?? []) {
    const criterion = current.find((item) => item.id === modification.id);
    if (!criterion || touched.has(modification.id)) throw new Refusal(`Unknown or repeated criterion ${modification.id}.`);
    touched.add(modification.id);
    const old = criterion.statement;
    criterion.statement = requiredBody(modification.statement, "criterion statement");
    criterion.verify = requiredBody(modification.verify, "criterion verify method");
    log.push(`- MODIFIED ${criterion.id} — ${criterion.statement} (was: ${old}) · Verify: ${criterion.verify}`);
  }
  for (const id of changes.remove ?? []) {
    const criterion = current.find((item) => item.id === id);
    if (!criterion || touched.has(id)) throw new Refusal(`Unknown or repeated criterion ${id}.`);
    touched.add(id);
    current = current.filter((item) => item.id !== id);
    log.push(`- REMOVED ${id} — ${criterion.statement}`);
  }
  if (changes.add?.length) {
    const reserved = [...new Set([stage.done_criteria, stage.amendments].join("\n").match(/\bDC[1-9]\d*\b/g) ?? [])];
    const added = criteria(changes.add, reserved);
    current.push(...added);
    log.push(...added.map((item) => `- ADDED ${item.id} — ${item.statement} · Verify: ${item.verify}`));
  }
  if (!current.length) throw new Refusal("An active stage must retain at least one done criterion.");
  for (const scope of changes.scope ?? []) {
    const field = scope.side === "in" ? "scope_in" : scope.side === "out" ? "scope_out" : undefined;
    if (!field || (scope.op !== "add" && scope.op !== "remove")) throw new Refusal("Invalid scope amendment.");
    const item = requiredBody(scope.item, "scope item");
    const bullet = `- ${item}`;
    const entries = stage[field] ? stage[field].split("\n") : [];
    if (scope.op === "add") {
      if (entries.includes(bullet)) throw new Refusal(`Scope item already exists: ${item}.`);
      entries.push(bullet);
    } else {
      const index = entries.indexOf(bullet);
      if (index < 0) throw new Refusal(`Scope item does not exist: ${item}.`);
      entries.splice(index, 1);
    }
    stage[field] = entries.join("\n");
    log.push(`- ${scope.op === "add" ? "ADDED" : "REMOVED"} Scope/${scope.side === "in" ? "In" : "Out"}: ${item}`);
  }
  if (retarget !== undefined) {
    log.push(`- TARGET ${retarget ?? "none"} (was: ${stage.target ?? "none"})`);
    stage.target = retarget;
  }
  stage.done_criteria = renderCriteria(current);
  const entry = `### ${new Date().toISOString().slice(0, 10)} — ${reason}\n\n${log.join("\n")}\n- Reason: ${reason}`;
  stage.amendments = [stage.amendments, entry].filter(Boolean).join("\n\n");
}

function closeStage(mutation: Mutation, actor: Actor, stage: StageDoc, input: StageOperationInput, plans: readonly AtlasStagePlan[]): void {
  const model = mutation.model;
  const evidence = input.evidence ?? [];
  const current = parseDoneCriteria(stage.done_criteria);
  const seen = new Set<string>();
  for (const item of evidence) {
    if (!current.some((criterion) => criterion.id === item.criterion) || seen.has(item.criterion)) {
      throw new Refusal(`Unknown or repeated evidence criterion ${item.criterion}.`);
    }
    seen.add(item.criterion);
    requiredBody(item.method, "evidence method");
    requiredBody(item.summary, "evidence summary");
    if (item.commit !== undefined) requiredBody(item.commit, "evidence commit");
  }
  for (const criterion of current) {
    if (!evidence.some((item) => item.criterion === criterion.id && item.result === "pass")) {
      throw new Refusal(`${criterion.id} requires passing evidence before the stage can close.`);
    }
  }
  const delivered = required(input.delivered, "delivered", true);
  assertBody(delivered);
  let deviations = input.deviations;
  const unfinished = plans.filter((plan) => plan.status === "unfinished");
  if (unfinished.length) {
    // Plan names come from another plugin; keep only text a plain body line accepts.
    const plain = (value: string) =>
      value
        .replace(/[\p{Cc}<>[\]\\|`]/gu, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120);
    const named = unfinished
      .map(
        (plan) =>
          `${plain(plan.name)} (${plain(plan.planId)}; ${plan.criteria ? `criteria ${plan.criteria.join(", ")}` : "criteria undeclared"})`,
      )
      .join("; ");
    deviations = [deviations, `Closed while linked Atlas plans were unfinished: ${named}.`].filter(Boolean).join("\n\n");
    mutation.warnings.push(
      `${stage.id} closed while linked Atlas plans are unfinished: ${named}. The Outcome records this under Deviations.`,
    );
  }
  if (deviations !== undefined) assertBody(deviations);
  const todoDoc = roundTodo(model, activeRound(model));
  const pendingTodos = todoDoc.items.filter((item) => item.status === "open" && item.target === stage.id);
  const todoDispositions = input.todos ?? [];
  const view = adrView(model);
  if (view.parseErrors.length)
    throw new Refusal(`ADR files could not be read, so ${stage.id}'s proposed ADRs cannot be verified.`, [
      ...view.parseErrors.map((issue) => `${issue.path}: ${issue.message}`),
      "Repair them in an editor or restore them with git, run adr_check, then close the stage again.",
    ]);
  const linkedAdrs = view.records.filter((adr) => adr.stage === stage.id);
  const proposedAdrs = linkedAdrs.filter((adr) => adr.status === "proposed");
  if (proposedAdrs.length)
    throw new Refusal(
      `${stage.id} cannot close while linked ADRs are proposed: ${proposedAdrs.map((adr) => `${adr.id} ${adr.title}`).join("; ")}.`,
      [
        actor.kind === "main"
          ? "Accept or reject each one with adr_manage action set_status in the main session, then close the stage again."
          : "Only the main agent can accept or reject ADRs. Return to the main agent, which settles them with adr_manage before the stage closes.",
      ],
    );
  const todoLog: string[] = [];
  const disposed = new Set<string>();
  for (const disposition of todoDispositions) {
    const item = pendingTodos.find((todo) => todo.id === disposition.id);
    if (!item || disposed.has(item.id)) throw new Refusal(`Unknown or repeated pending TODO ${disposition.id}.`);
    disposed.add(item.id);
    if (disposition.disposition === "resolved") {
      item.reference = requiredBody(disposition.reference, "TODO resolution reference");
      item.status = "resolved";
      todoLog.push(`- ${item.id} resolved · ${item.reference}`);
    } else if (disposition.disposition === "moved") {
      const next = target(model, { target: disposition.target });
      if (next.target === stage.id) throw new Refusal(`${item.id} still targets the stage being closed.`);
      delete item.target;
      delete item.trigger;
      Object.assign(item, next);
      todoLog.push(`- ${item.id} moved → ${item.target ?? `trigger: ${item.trigger}`}`);
    } else throw new Refusal("Unknown TODO disposition.");
  }
  if (pendingTodos.some((item) => !disposed.has(item.id))) {
    throw new Refusal("Every open TODO targeting this stage needs a resolved or moved disposition.");
  }
  const removed: string[] = [];
  let amendmentDate = "";
  for (const line of stage.amendments.split("\n")) {
    const date = /^### (\d{4}-\d{2}-\d{2})/.exec(line)?.[1];
    if (date) amendmentDate = date;
    const id = /^- REMOVED (DC[1-9]\d*) — /.exec(line)?.[1];
    if (id) removed.push(`- ${id} — removed by amendment ${amendmentDate}`);
  }
  stage.outcome = [
    `### Delivered\n\n${delivered}`,
    `### Deviations\n\n${deviations ?? "None."}`,
    `### Evidence\n\n${[
      ...evidence.map(
        (item) => `- ${item.criterion} — pass — Verify: ${item.method} → ${item.summary}${item.commit ? ` — commit ${item.commit}` : ""}`,
      ),
      ...removed,
    ].join("\n")}`,
    `### TODO\n\n${todoLog.join("\n") || "None."}`,
    `### ADRs\n\n${linkedAdrs.map((adr) => `- ${adr.id} ${adr.status}${adr.superseded_by ? ` by ${adr.superseded_by}` : ""}`).join("\n") || "None."}`,
  ].join("\n\n");
  stage.status = "closed";
  stage.closed = new Date().toISOString().slice(0, 10);
  stage.closed_sha256 = stageSha256(stage);
  mutation.put(stage.path, renderStage(stage));
  if (pendingTodos.length) mutation.put(todoDoc.path, renderTodo(todoDoc));
}

async function renumberStage(repo: Repo, actor: Actor, mutation: Mutation, stage: StageDoc, newId: string | undefined): Promise<void> {
  const model = mutation.model;
  const oldId = stage.id;
  const pattern = new RegExp(`\\b${oldId}\\b`, "g");
  const contains = (body: string): boolean => new RegExp(`\\b${oldId}\\b`).test(body);
  for (const round of model.rounds.filter((round) => round.status === "closed" || round.status === "dropped")) {
    if (Object.values(roundFiles(model, round)).some((content) => contains(Buffer.from(content).toString("utf8")))) {
      throw new Refusal(`${oldId} is referenced in frozen round ${round.id}; renumbering is refused.`);
    }
  }
  for (const other of model.stages.filter((candidate) => candidate.status === "closed" || candidate.status === "dropped")) {
    if (contains(renderStage(other))) throw new Refusal(`${oldId} is referenced by terminal stage ${other.id}; renumbering is refused.`);
  }
  if (newId !== undefined && (!/^S\d{2,}$/.test(newId) || numberOf(newId) <= highest(model, "stage"))) {
    throw new Refusal("new_id must be a fresh stage id greater than every on-disk stage id.");
  }
  const n = await allocate(repo, "stage", Math.max(highest(model, "stage"), newId ? numberOf(newId) - 1 : 0));
  const allocated = `S${String(n).padStart(2, "0")}`;
  if (newId !== undefined && allocated !== newId) {
    throw new Refusal(`The shared counter has already passed ${newId}; use ${allocated} or a higher id.`);
  }
  const oldPath = stage.path;
  stage.id = allocated;
  stage.path = join(dirname(oldPath), basename(oldPath).replace(/^\d+-/, `${String(n).padStart(2, "0")}-`));
  for (const other of model.stages.filter((candidate) => candidate.status === "planned" || candidate.status === "active")) {
    for (const field of [
      "title",
      "objective",
      "scope_in",
      "scope_out",
      "done_criteria",
      "design_constraints",
      "risks",
      "amendments",
      "free_work_log",
    ] as const) {
      if (other[field] !== undefined) other[field] = other[field]?.replace(pattern, allocated);
    }
    other.depends_on = other.depends_on.map((id) => (id === oldId ? allocated : id));
    if (other.follows === oldId) other.follows = allocated;
    mutation.put(other.path, renderStage(other));
  }
  const mutable = model.rounds.filter((round) => round.status === "active" || round.status === "planned");
  for (const doc of model.todos.filter((todo) => mutable.some((round) => round.id === todo.round))) {
    for (const item of doc.items) {
      for (const field of ["title", "source", "target", "trigger", "reference", "carried_from", "body"] as const) {
        if (item[field] !== undefined) item[field] = item[field]?.replace(pattern, allocated);
      }
    }
    mutation.put(doc.path, renderTodo(doc));
  }
  for (const round of mutable) {
    for (const field of ["goal", "constraints", "non_goals", "principles", "known_limitations"] as const) {
      round[field] = round[field].replace(pattern, allocated);
    }
  }
  const view = adrView(model);
  if (view.parseErrors.length)
    throw new Refusal(`ADR files could not be read, so ADR links to ${oldId} cannot be moved.`, [
      ...view.parseErrors.map((issue) => `${issue.path}: ${issue.message}`),
      "Repair them in an editor or restore them with git, then run adr_check.",
    ]);
  const linked = view.records.filter((adr) => adr.stage === oldId);
  if (linked.length) {
    await adrCall("ADR stage links cannot be moved", () =>
      adrService(repo).relinkStage(repo.repoRoot, actor.kind, oldId, allocated, { dryRun: true }),
    );
    mutation.relink = { from: oldId, to: allocated, ids: linked.map((adr) => adr.id) };
    // The check before writing sees the links as they will be once the relink lands.
    for (const adr of linked) adr.stage = allocated;
  }
  mutation.remove(oldPath);
}

export async function stage(repo: Repo, actor: Actor, input: StageOperationInput, options: StageOptions = {}): Promise<Receipt> {
  return mutate(
    repo,
    actor,
    async (mutation) => {
      const model = mutation.model;
      if (input.round !== undefined && input.action !== "add") throw new Refusal("round applies only when adding a stage.");
      if (input.action === "add") {
        const created = await newStage(repo, model, input);
        mutation.put(created.path, renderStage(created));
        return `Added ${created.id} — ${created.title}${model.rounds.find((round) => round.id === created.round)?.status === "planned" ? ` to planned round ${created.round}` : ""}.`;
      }
      const current = editableStage(model, input.id);
      if (input.target !== undefined && input.action !== "edit" && input.action !== "amend")
        throw new Refusal("target applies only to add, edit and amend; use /roadmap retarget otherwise.");
      if (input.action === "start") {
        const active = activeRound(model);
        if (current.round !== active.id)
          throw new Refusal(`${current.id} belongs to planned round ${current.round}; only stages of the active round ${active.id} start.`);
        await checked(model);
        if (current.status !== "planned" && current.status !== "active")
          throw new Refusal(`${current.id} cannot start from ${current.status}.`);
        for (const id of current.depends_on) {
          if (findStage(model, id).status !== "closed") throw new Refusal(`Dependency ${id} must be closed before ${current.id} starts.`);
        }
        if (current.status === "active") {
          mutation.warnings.push("another session may be working on this stage");
          mutation.readOnly = true;
        } else if (options.planning) {
          mutation.readOnly = true;
        } else {
          current.status = "active";
          current.started = new Date().toISOString().slice(0, 10);
          mutation.put(current.path, renderStage(current));
        }
        mutation.handoff = renderHandoff(model, current, today(), options.plans);
        if (options.planning && current.status === "planned")
          return `Bound ${current.id} — ${current.title} for planning without starting it: it stays planned and nothing was written. Before implementation begins outside plan mode, start it with roadmap_stage start and commit the files it lists.`;
        return `Planning handoff for ${current.id} — ${current.title}.`;
      }
      if (input.action === "edit") {
        if (current.status !== "planned") throw new Refusal("Only planned stages can be edited; use amend for an active stage.");
        if (input.target !== undefined) {
          current.target = targetDate(input.target);
          promote(model, current);
        }
        if (input.title !== undefined) current.title = required(input.title, "stage title");
        if (input.objective !== undefined) {
          assertBody(input.objective);
          current.objective = required(input.objective, "objective", true);
        }
        if (input.scope_in !== undefined) current.scope_in = lines(input.scope_in, "scope_in");
        if (input.scope_out !== undefined) current.scope_out = lines(input.scope_out, "scope_out");
        if (input.done_criteria !== undefined) current.done_criteria = renderCriteria(criteria(input.done_criteria));
        if (input.depends_on !== undefined) current.depends_on = input.depends_on;
        if (input.follows !== undefined) current.follows = input.follows;
        if (input.design_constraints !== undefined) {
          assertBody(input.design_constraints);
          current.design_constraints = input.design_constraints;
        }
        if (input.risks !== undefined) {
          assertBody(input.risks);
          current.risks = input.risks;
        }
      } else if (input.action === "amend") {
        if (current.status !== "active") throw new Refusal("Only an active stage can be amended.");
        amend(current, input);
        promote(model, current);
      } else if (input.action === "close") {
        if (current.status !== "active") throw new Refusal("Only an active stage can close.");
        await checked(model);
        closeStage(mutation, actor, current, input, options.plans ?? []);
        return `Closed ${current.id} — ${current.title}; evidence and dispositions recorded.`;
      } else if (input.action === "drop") {
        if (current.status !== "planned" && current.status !== "active")
          throw new Refusal("Only a planned or active stage can be dropped.");
        if (model.todos.some((doc) => doc.items.some((item) => item.status === "open" && item.target === current.id))) {
          throw new Refusal("Move or resolve every open TODO targeting this stage before dropping it.");
        }
        const reason = required(input.reason, "drop reason", true);
        assertBody(reason);
        current.status = "dropped";
        current.closed = new Date().toISOString().slice(0, 10);
        current.outcome = `### Delivered\n\nNot delivered; stage dropped.\n\n### Deviations\n\n${reason}`;
      } else if (input.action === "renumber") {
        if (current.status !== "planned") throw new Refusal("Only a planned stage can be renumbered.");
        await renumberStage(repo, actor, mutation, current, input.new_id);
        return `Renumbered ${input.id} to ${current.id}; mutable references updated.`;
      } else throw new Refusal("Unknown stage action.");
      mutation.put(current.path, renderStage(current));
      return `${input.action === "edit" ? "Edited" : input.action === "amend" ? "Amended" : "Dropped"} ${current.id} — ${current.title}.`;
    },
    options,
  );
}

export async function todo(repo: Repo, actor: Actor, input: TodoOperationInput, options: OperationOptions = {}): Promise<Receipt> {
  return mutate(
    repo,
    actor,
    async (mutation) => {
      const model = mutation.model;
      const active = model.rounds.find((round) => round.status === "active");
      if (input.body !== undefined) assertBody(input.body, { afterList: true });
      let item: TodoItem;
      let doc: TodoDoc;
      if (input.action === "add") {
        const title = required(input.title, "TODO title");
        const source = required(input.source, "TODO source");
        if (!input.severity || !["high", "normal", "low"].includes(input.severity)) throw new Refusal("A TODO needs severity.");
        const nextTarget = target(model, input);
        const owner = active ?? (nextTarget.target ? findRound(model, findStage(model, nextTarget.target).round) : activeRound(model));
        doc = roundTodo(model, owner);
        const n = await allocate(repo, "todo", highest(model, "todo"));
        item = {
          id: `T${String(n).padStart(3, "0")}`,
          title,
          status: "open",
          severity: input.severity,
          source,
          body: input.body ?? "",
          ...nextTarget,
        };
        doc.items.push(item);
      } else {
        const id = required(input.id, "TODO id");
        const matches = model.todos.flatMap((candidate) => {
          const round = findRound(model, candidate.round);
          if (round.status !== "active" && round.status !== "planned") return [];
          return candidate.items
            .filter((entry) => entry.id === id && entry.status === "open")
            .map((entry) => ({ doc: candidate, item: entry }));
        });
        const existing = matches[0];
        if (matches.length !== 1 || !existing) throw new Refusal(`TODO ${input.id} is not open in the active or a planned round.`);
        ({ doc, item } = existing);
        if (input.action === "resolve") {
          item.reference = requiredBody(input.reference, "TODO resolution reference");
          item.status = "resolved";
        } else if (input.action === "update" || input.action === "move") {
          if (input.action === "move" || input.target !== undefined || input.trigger !== undefined) {
            const nextTarget = target(model, input);
            const destination = nextTarget.target ? findRound(model, findStage(model, nextTarget.target).round) : undefined;
            if (findRound(model, doc.round).status === "planned" && destination && destination.id !== doc.round) {
              const previous = doc;
              const source = item;
              const n = await allocate(repo, "todo", highest(model, "todo"));
              item = { ...source, id: `T${String(n).padStart(3, "0")}`, status: "open", carried_from: `${source.id} (${previous.round})` };
              delete item.reference;
              source.status = "moved";
              source.reference = `${item.id} (${destination.id})`;
              doc = roundTodo(model, destination);
              doc.items.push(item);
              mutation.put(previous.path, renderTodo(previous));
            }
            delete item.target;
            delete item.trigger;
            Object.assign(item, nextTarget);
          }
          if (input.action === "update") {
            if (input.title !== undefined) item.title = required(input.title, "TODO title");
            if (input.source !== undefined) item.source = required(input.source, "TODO source");
            if (input.severity !== undefined) item.severity = input.severity;
            if (input.body !== undefined) item.body = input.body;
          }
        } else throw new Refusal("Unknown TODO action.");
      }
      mutation.put(doc.path, renderTodo(doc));
      return `TODO ${item.id}: ${input.action} recorded.`;
    },
    options,
  );
}

function charter(model: Model, input: RoundInput): Pick<RoundDoc, "title" | "goal" | "constraints" | "non_goals" | "principles"> {
  const title = required(input.title, "round title");
  const goal = required(input.goal, "round goal", true);
  assertBody(goal);
  const constraints = lines(input.constraints, "constraints");
  const nonGoals = lines(input.non_goals, "non_goals");
  if (!Array.isArray(input.principles)) throw new Refusal("Round principles must be a list.");
  const principles = input.principles
    .map((principle) => {
      if (!principle.adrs?.length) throw new Refusal("Every round principle must cite at least one ADR.");
      for (const id of principle.adrs) citedAdr(model, id);
      return `- ${requiredBody(principle.text, "principle")} (${principle.adrs.join(", ")}).`;
    })
    .join("\n");
  return { title, goal, constraints, non_goals: nonGoals, principles };
}

async function newRound(
  repo: Repo,
  model: Model,
  input: RoundInput,
  status: "active" | "planned" = "active",
  target: string | null = null,
): Promise<RoundDoc> {
  const fields = charter(model, input);
  const n = await allocate(repo, "round", highest(model, "round"));
  const round: RoundDoc = {
    format: model.index.format,
    path: join(repo.roadmapDir, `${String(n).padStart(2, "0")}-${slug(fields.title)}`, "README.md"),
    id: `R${n}`,
    ...fields,
    status,
    target,
    opened: status === "planned" ? null : today(),
    closed: null,
    frozen_sha256: null,
    stages: generatedBlock("stages", renderStageTable([], model.index.format)),
    known_limitations: "",
  };
  model.rounds.push(round);
  model.todos.push({ format: model.index.format, path: join(dirname(round.path), "TODO.md"), round: round.id, items: [] });
  return round;
}

async function snapshot(repo: Repo): Promise<string> {
  const entries: string[] = [];
  const walk = async (path: string): Promise<void> => {
    let info: Stats;
    try {
      info = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      entries.push(`${relative(repo.repoRoot, path)}\nmissing\n`);
      return;
    }
    const name = relative(repo.repoRoot, path);
    if (info.isDirectory()) {
      entries.push(`${name}\ndirectory\n`);
      for (const child of (await readdir(path)).sort()) await walk(join(path, child));
    } else if (info.isFile()) entries.push(`${name}\n${sha256(await readFile(path))}\n`);
    else throw new Refusal(`Unsupported filesystem entry at ${name}.`);
  };
  await walk(repo.roadmapDir);
  await walk(repo.adrDir);
  return sha256(entries.join(""));
}

async function initPreflight(repo: Repo): Promise<void> {
  try {
    await lstat(repo.roadmapDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const state = await adrCall("docs/adr/ could not be inspected", () => adrService(repo).dirState(repo.repoRoot));
    if (state === "unmanaged")
      throw new Refusal("docs/adr/ is not empty and is not managed by the adr plugin; this plugin does not adopt existing directories.", [
        "Move the existing files out of docs/adr/ or ask the user how to proceed.",
      ]);
    return;
  }
  throw new Refusal("docs/roadmap/ already exists; this plugin does not adopt existing projects.");
}

async function prepare(
  repo: Repo,
  actor: Actor,
  initialize: boolean,
  build: (mutation: Mutation) => Promise<string>,
): Promise<PreparationReceipt> {
  try {
    actorValid(actor, true);
    return await withRepoLock(repo, async () => {
      if (initialize) await initPreflight(repo);
      const expected = await snapshot(repo);
      const model: Model = initialize
        ? {
            repo,
            index: { format: 2, path: join(repo.roadmapDir, "README.md"), title: "", body: "" },
            rounds: [],
            stages: [],
            todos: [],
            files: {},
          }
        : await loadAll(repo);
      if (!initialize) await checked(model);
      const mutation = new Mutation(model);
      const summary = await build(mutation);
      mutation.indexes();
      mutation.warnings.push(...(await checked(model)));
      const prepared: PreparedOperation = {
        repoRoot: repo.repoRoot,
        snapshot: expected,
        summary,
        files: [...[...mutation.changes].map(([path, content]) => ({ path, content })), ...(mutation.adr?.files ?? [])],
        warnings: [...new Set(mutation.warnings)],
        ...(mutation.adr ? { adr: mutation.adr } : {}),
      };
      preparedModels.set(prepared, model);
      return { ok: true, summary, files: prepared.files, warnings: prepared.warnings, prepared };
    });
  } catch (error) {
    return failure(error);
  }
}

export async function prepareInit(repo: Repo, actor: Actor, input: InitInput): Promise<PreparationReceipt> {
  return prepare(repo, actor, true, async (mutation) => {
    const model = mutation.model;
    const api = adrService(repo);
    model.index.title = required(input.project.name, "project name");
    assertBody(required(input.project.description, "project description", true));
    if (!Array.isArray(input.adrs)) throw new Refusal("Initial ADRs must be a list.");
    const existing = await adrCall("docs/adr/ could not be read", () => api.load(repo.repoRoot));
    if (existing?.parseErrors.length)
      throw new Refusal("Managed ADR documents could not be loaded.", [
        ...existing.parseErrors.map((issue) => `${issue.path}: ${issue.message}`),
        "Repair them in an editor or restore them with git, then run adr_check.",
      ]);
    const records = existing?.records ?? [];
    const adrAliases = new Map<string, string>();
    const initial = input.adrs.map((original, index) => {
      const alias = original.id ?? `ADR-${String(index + 1).padStart(4, "0")}`;
      if (adrAliases.has(alias)) throw new Refusal(`Repeated initial ADR alias ${alias}.`);
      if (records.some((record) => record.id === alias))
        throw new Refusal(`Initial ADR alias ${alias} is also an existing ADR in docs/adr/.`, [
          "Give each initial ADR an id alias no existing ADR uses, such as ADR-9001, and cite existing ADRs by their own ids.",
        ]);
      adrAliases.set(alias, alias);
      const { id: _alias, stage: _stage, ...create } = original;
      return { alias, stage: original.stage, create: { ...create, status: original.status ?? "accepted" } };
    });
    // Ids do not depend on stage links, so a first dry run numbers the batch before stages exist to link.
    const numbered = await adrCall("The initial ADRs were refused", () =>
      api.createMany(
        repo.repoRoot,
        actor.kind,
        initial.map((entry) => entry.create),
        { dryRun: true, initialize: true },
      ),
    );
    const provisional = initial.map((entry, index): AdrRecord => {
      const id = numbered.ids[index];
      if (!id) throw new Refusal("The adr plugin did not number every initial ADR.");
      adrAliases.set(entry.alias, id);
      return {
        id,
        title: entry.create.title,
        status: entry.create.status,
        date: today(),
        supersedes: [],
        decision_makers: entry.create.decision_makers ?? [],
        consulted: entry.create.consulted ?? [],
        informed: entry.create.informed ?? [],
        path: numbered.files[index]?.path ?? "",
        body: "",
        legacy: false,
      };
    });
    model.adrs = { managed: true, records: [...records, ...provisional], parseErrors: [] };
    const round = await newRound(repo, model, {
      ...input.round,
      principles: input.round.principles.map((principle) => ({ ...principle, adrs: principle.adrs.map((id) => adrAliases.get(id) ?? id) })),
    });
    if (!input.stages.length) throw new Refusal("Initialization needs at least one stage.");
    const stageAliases = new Map<string, string>();
    const rewriteAdrs = (text: string): string => text.replace(/\bADR-\d{4,}\b/g, (id) => adrAliases.get(id) ?? id);
    for (const [index, original] of input.stages.entries()) {
      const created = await newStage(repo, model, {
        ...original,
        objective: rewriteAdrs(original.objective),
        scope_in: original.scope_in.map(rewriteAdrs),
        scope_out: original.scope_out.map(rewriteAdrs),
        done_criteria: original.done_criteria.map((criterion) => ({
          ...criterion,
          statement: rewriteAdrs(criterion.statement),
          verify: rewriteAdrs(criterion.verify),
        })),
        design_constraints: original.design_constraints === undefined ? undefined : rewriteAdrs(original.design_constraints),
        risks: original.risks === undefined ? undefined : rewriteAdrs(original.risks),
      });
      const alias = original.id ?? `S${String(index + 1).padStart(2, "0")}`;
      if (stageAliases.has(alias)) throw new Refusal(`Repeated initial stage alias ${alias}.`);
      stageAliases.set(alias, created.id);
    }
    for (const created of model.stages) {
      created.depends_on = created.depends_on.map((id) => stageAliases.get(id) ?? id);
      if (created.follows) created.follows = stageAliases.get(created.follows) ?? created.follows;
      mutation.put(created.path, renderStage(created));
    }
    const stages = model.stages.map((stage) => stage.id);
    const linked = initial.map((entry, index): AdrCreateInput => {
      if (entry.stage === undefined) return entry.create;
      const stage = stageAliases.get(entry.stage) ?? entry.stage;
      if (!stages.includes(stage))
        throw new Refusal(`Initial ADR ${entry.alias} links unknown stage ${entry.stage}; use an initial stage alias such as S01.`);
      (provisional[index] as AdrRecord).stage = stage;
      return { ...entry.create, stage };
    });
    let batch = numbered;
    if (linked.some((create) => create.stage !== undefined)) {
      batch = await withPendingStages(repo.repoRoot, stages, () =>
        adrCall("The initial ADR stage links were refused", () =>
          api.createMany(repo.repoRoot, actor.kind, linked, { dryRun: true, initialize: true }),
        ),
      );
      if (batch.ids.join() !== numbered.ids.join())
        throw new Refusal("ADR ids changed while the preview was prepared.", ["Call roadmap_init again for a fresh preview."]);
    }
    mutation.adr = {
      inputs: linked,
      ids: batch.ids,
      stages,
      files: batch.files.map((file) => ({ path: join(repo.repoRoot, file.path), content: file.content })),
    };
    mutation.warnings.push(...batch.warnings);
    mutation.put(roundTodo(model, round).path, renderTodo(roundTodo(model, round)));
    mutation.indexes();
    const root = renderRoadmapIndex(model.index, model.rounds, model.stages);
    model.index.body = parseRoadmapIndex(root).body.replace(/^# [^\n]+\n\n/, (heading) => `${heading}${input.project.description}\n\n`);
    return `Initialized ${model.index.title} with ${round.id}, ${model.stages.length} stages and ${batch.ids.length} ADRs${existing ? " added to the existing docs/adr/" : ""}.`;
  });
}

export async function prepareUpgrade(repo: Repo, actor: Actor): Promise<PreparationReceipt> {
  return prepare(repo, actor, false, async (mutation) => {
    if (mutation.model.index.format === 2) throw new Refusal("This repository already uses roadmap format 2.");
    upgradeRoadmapIndex(mutation.model.index);
    return `${FORMAT_WARNING}\nOnly the roadmap README changes now; existing files keep their own format until they need a format-2 field.`;
  });
}

export async function prepareRoundPlan(repo: Repo, actor: Actor, input: RoundPlanInput): Promise<PreparationReceipt> {
  return prepare(repo, actor, false, async (mutation) => {
    const model = mutation.model;
    const upgrading = model.index.format === 1;
    if (upgrading) upgradeRoadmapIndex(model.index);
    let round: RoundDoc;
    if (input.id) {
      round = findRound(model, input.id);
      if (round.status !== "planned") throw new Refusal(`Only a planned round's charter can be revised; ${round.id} is ${round.status}.`);
      Object.assign(round, charter(model, input.round));
      if (input.target !== undefined) round.target = targetDate(input.target);
    } else {
      round = await newRound(repo, model, input.round, "planned", input.target === undefined ? null : targetDate(input.target));
      const doc = roundTodo(model, round);
      mutation.put(doc.path, renderTodo(doc));
    }
    return `${upgrading ? `${FORMAT_WARNING}\n` : ""}${input.id ? "Revised planned" : "Planned"} ${round.id} — ${round.title}${round.target ? `; target ${round.target}` : ""}.`;
  });
}

export async function prepareRoundDrop(repo: Repo, actor: Actor, input: { id: string; reason: string }): Promise<PreparationReceipt> {
  return prepare(repo, actor, false, async (mutation) => {
    const model = mutation.model;
    const round = findRound(model, input.id);
    if (round.status !== "planned") throw new Refusal(`Only planned rounds can be dropped; ${round.id} is ${round.status}.`);
    const reason = required(input.reason, "round drop reason", true);
    assertBody(reason);
    const stages = model.stages.filter((stage) => stage.round === round.id);
    const ids = new Set(stages.map((stage) => stage.id));
    const todos = model.todos.flatMap((doc) =>
      doc.items.filter((item) => item.status === "open" && ((item.target && ids.has(item.target)) || doc.round === round.id)),
    );
    if (todos.length)
      throw new Refusal(`Move or resolve every open TODO for ${round.id} before dropping it: ${todos.map((item) => item.id).join(", ")}.`, [
        "Use roadmap_todo to move the target to another unclosed round's stage or resolve the item.",
      ]);
    const dependents = model.stages.filter(
      (stage) => stage.round !== round.id && stage.status !== "dropped" && stage.depends_on.some((id) => ids.has(id)),
    );
    if (dependents.length)
      throw new Refusal(`Stages in other rounds depend on ${round.id}: ${dependents.map((stage) => stage.id).join(", ")}.`, [
        "Edit or drop those dependent stages first; do not leave dependencies pointing at dropped work.",
      ]);
    for (const stage of stages.filter((stage) => stage.status === "planned")) {
      stage.status = "dropped";
      stage.closed = today();
      stage.outcome = `### Delivered\n\nNot delivered; round ${round.id} dropped.\n\n### Deviations\n\n${reason}`;
      mutation.put(stage.path, renderStage(stage));
    }
    round.stages = generatedBlock("stages", renderStageTable(stages, round.format));
    round.status = "dropped";
    round.closed = today();
    round.outcome = `### Delivered\n\nNot delivered; round dropped.\n\n### Deviations\n\n${reason}`;
    const content = renderRound(round);
    round.frozen_sha256 = roundSha256({ ...roundFiles(model, round), "README.md": content });
    mutation.put(round.path, content.replace(/^frozen_sha256:.*$/m, `frozen_sha256: "${round.frozen_sha256}"`));
    return `Dropped and froze ${round.id} — ${round.title}; IDs and files are retained.`;
  });
}

export async function prepareRetarget(repo: Repo, actor: Actor, input: { id: string; target: string }): Promise<PreparationReceipt> {
  return prepare(repo, actor, false, async (mutation) => {
    const model = mutation.model;
    if (model.index.format === 1) throw new Refusal("Target dates need roadmap format 2; this repository is format 1.", [UPGRADE_HINT]);
    const doc = input.id.startsWith("R") ? findRound(model, input.id) : editableStage(model, input.id);
    if (doc.status !== "planned" && doc.status !== "active")
      throw new Refusal(`Only unclosed rounds and stages can be retargeted; ${doc.id} is ${doc.status}.`);
    const next = targetDate(input.target);
    if (doc.target === next) throw new Refusal(`${doc.id} already has ${next === null ? "no target" : `target ${next}`}.`);
    const previous = doc.target;
    doc.target = next;
    promote(model, doc);
    if ("round" in doc) mutation.put(doc.path, renderStage(doc));
    return `Retargeted ${doc.id}: ${previous ?? "none"} → ${next ?? "none"}.`;
  });
}

export async function prepareRoundOpen(repo: Repo, actor: Actor, input: RoundOpenInput): Promise<PreparationReceipt> {
  return prepare(repo, actor, false, async (mutation) => {
    const model = mutation.model;
    if (model.rounds.some((round) => round.status === "active")) throw new Refusal("Close the active round before opening another.");
    const planned = model.rounds.filter((round) => round.status === "planned").sort((a, b) => numberOf(a.id) - numberOf(b.id));
    const first = planned[0];
    if (input.activate !== undefined && input.activate !== first?.id)
      throw new Refusal(
        first
          ? `Only the lowest-numbered planned round ${first.id} can be activated; activate or drop it first.`
          : `There is no planned round ${input.activate} to activate.`,
      );
    if (!first && !input.round) throw new Refusal("A charter is required to open a new round.");
    if (new Set(input.import_todos).size !== input.import_todos.length) throw new Refusal("Repeated import_todos id.");
    const sources = input.import_todos.map((id) => {
      const occurrences = model.todos.flatMap((doc) =>
        doc.items.filter((item) => item.id === id).map((item) => ({ item, round: doc.round })),
      );
      if (occurrences.length > 1) throw new Refusal(`${id} was automatically carried with the same ID and cannot be imported again.`);
      const source = occurrences.find(({ item, round }) => item.status === "carried" && findRound(model, round).status === "closed");
      if (!source) throw new Refusal(`${id} is not a carried TODO from a frozen round.`);
      return source;
    });
    let round: RoundDoc;
    if (first) {
      round = first;
      if (input.round) Object.assign(round, charter(model, input.round));
      round.status = "active";
      round.opened = today();
    } else {
      round = await newRound(repo, model, input.round as RoundInput);
    }
    const doc = roundTodo(model, round);
    for (const source of sources) {
      const n = await allocate(repo, "todo", highest(model, "todo"));
      const item: TodoItem = {
        ...source.item,
        id: `T${String(n).padStart(3, "0")}`,
        status: "open",
        carried_from: `${source.item.id} (${source.round})`,
        trigger: source.item.trigger ?? `When planning follow-up work for ${source.item.target ?? source.item.id}`,
      };
      delete item.target;
      delete item.reference;
      doc.items.push(item);
    }
    mutation.put(doc.path, renderTodo(doc));
    return `${first ? "Activated" : "Opened"} ${round.id} — ${round.title}; imported ${sources.length} carried TODOs.`;
  });
}

/** Writes the confirmed initial ADRs before any roadmap file, so a refusal leaves docs/roadmap untouched. */
async function writeAdrs(
  repo: Repo,
  actor: Actor,
  adr: PreparedAdrs,
  options: OperationOptions,
): Promise<string[] | Extract<Receipt, { ok: false }>> {
  const api = adrService(repo);
  const shown = JSON.stringify(adr.files.map((file) => [file.path, file.content]));
  const matches = (result: AdrWriteResult): boolean =>
    JSON.stringify(result.files.map((file) => [join(repo.repoRoot, file.path), file.content])) === shown;
  const create = (dryRun: boolean): Promise<AdrWriteResult> =>
    withPendingStages(repo.repoRoot, adr.stages, () =>
      api.createMany(repo.repoRoot, actor.kind, adr.inputs, { dryRun, initialize: true, signal: options.signal }),
    );
  if (!matches(await adrCall("The preview's ADRs were refused", () => create(true))))
    throw new Refusal("The preview is stale: the ADR files it shows changed after it was prepared.");
  let result: AdrWriteResult;
  try {
    result = await create(false);
  } catch (error) {
    return {
      ok: false,
      reason: `The initial ADRs could not be written: ${errorMessage(error)}`,
      hints: ["Nothing under docs/roadmap/ was written. Restore any ADR files listed above with git before running /init-project again."],
    };
  }
  const files = result.files.map((file) => file.path);
  if (!matches(result))
    return {
      ok: false,
      reason: "The adr plugin wrote different ADR files than the confirmed preview, so docs/roadmap/ was not written.",
      hints: [`ADR files written: ${files.join(", ")}.`, "Restore docs/adr/ with git, then run /init-project again for a fresh preview."],
    };
  return files;
}

export async function applyPrepared(
  repo: Repo,
  actor: Actor,
  prepared: PreparedOperation,
  options: MutationOptions = {},
): Promise<Receipt> {
  try {
    actorValid(actor, true);
    return await withRepoLock(repo, async () => {
      const model = preparedModels.get(prepared);
      if (!model || prepared.repoRoot !== repo.repoRoot) throw new Refusal("Unknown preview; prepare it again in this session.");
      const guarded = guardMutation(model, options);
      if (guarded) return guarded;
      if ((await snapshot(repo)) !== prepared.snapshot)
        throw new Refusal("The preview is stale: managed files changed after it was prepared.");
      await checked(model);
      const mutation = new Mutation(model);
      const adrFiles = new Set(prepared.adr?.files.map((file) => file.path));
      for (const file of prepared.files) if (!adrFiles.has(file.path)) mutation.changes.set(file.path, file.content);
      mutation.warnings.push(...prepared.warnings);
      const beforeWrite = guardMutation(model, options);
      if (beforeWrite) return beforeWrite;
      const written = prepared.adr ? await writeAdrs(repo, actor, prepared.adr, options) : [];
      if (!Array.isArray(written)) return written;
      const result = await mutation.write(repo, prepared.summary, options, written);
      if (result.ok) {
        const cancelled = guardCancellation(options, result.changedFiles);
        if (cancelled) return cancelled;
        options.onSuccess?.();
      }
      preparedModels.delete(prepared);
      return result;
    });
  } catch (error) {
    return failure(error);
  }
}

export async function initProject(repo: Repo, actor: Actor, input: InitInput, options: OperationOptions = {}): Promise<Receipt> {
  const preview = await prepareInit(repo, actor, input);
  return preview.ok ? applyPrepared(repo, actor, preview.prepared, options) : preview;
}

export async function openRound(repo: Repo, actor: Actor, input: RoundOpenInput, options: OperationOptions = {}): Promise<Receipt> {
  const preview = await prepareRoundOpen(repo, actor, input);
  return preview.ok ? applyPrepared(repo, actor, preview.prepared, options) : preview;
}

/** The `/roadmap upgrade` operation without a file preview, for a user's Yes in the one-step upgrade dialog. */
export async function upgrade(repo: Repo, actor: Actor, options: MutationOptions = {}): Promise<Receipt> {
  const preview = await prepareUpgrade(repo, actor);
  return preview.ok ? applyPrepared(repo, actor, preview.prepared, options) : preview;
}

/** These are excluded from the user disposition dialog: they continue in the target's planned round. */
export function autoCarryTodos(model: Model, round: RoundDoc): TodoItem[] {
  return roundTodo(model, round).items.filter((item) => {
    const stage = item.target ? model.stages.find((stage) => stage.id === item.target) : undefined;
    return (
      item.status === "open" && stage !== undefined && model.rounds.some((round) => round.id === stage.round && round.status === "planned")
    );
  });
}

export async function closeRound(repo: Repo, actor: Actor, input: RoundCloseInput, options: MutationOptions = {}): Promise<Receipt> {
  return mutate(
    repo,
    actor,
    async (mutation) => {
      actorValid(actor, true);
      const model = mutation.model;
      const round = model.rounds.find((candidate) => candidate.status === "active");
      if (!round || round.id !== input.expected?.id || roundSha256(roundFiles(model, round)) !== input.expected.sha256) {
        throw new Refusal("Round-close authorization is stale.", ["Run /roadmap close-round again to review the current round and TODOs."]);
      }
      await checked(model);
      if (model.stages.some((stage) => stage.round === round.id && stage.status !== "closed" && stage.status !== "dropped")) {
        throw new Refusal("Every stage must be closed or dropped before the round can close.");
      }
      const upgraded = input.upgrade === true && model.index.format === 1;
      if (upgraded) upgradeRoadmapIndex(model.index);
      const outcome = input.outcome;
      if (model.index.format === 1 && outcome)
        throw new Refusal("A round outcome needs roadmap format 2; this repository is format 1.", [
          "Run /roadmap upgrade first, or close the round without an outcome.",
        ]);
      if (model.index.format === 2 && !outcome)
        throw new Refusal(`Closing ${round.id} records how its goal turned out: an outcome assessment and summary.`, [
          `Assessment is one of ${ROUND_ASSESSMENTS.join(", ")}; /roadmap close-round asks for both, or takes outcome=<assessment>:"<summary>".`,
        ]);
      if (outcome) {
        if (!(ROUND_ASSESSMENTS as readonly string[]).includes(outcome.assessment))
          throw new Refusal(`Unknown round outcome assessment ${outcome.assessment}; use ${ROUND_ASSESSMENTS.join(", ")}.`);
        const summary = required(outcome.summary, "round outcome summary", true).trim();
        assertBody(summary);
        round.outcome = `### Assessment\n\n${outcome.assessment}\n\n### Summary\n\n${summary}`;
        promote(model, round);
      }
      const doc = roundTodo(model, round);
      const automatic = autoCarryTodos(model, round);
      const open = doc.items.filter((item) => item.status === "open" && !automatic.includes(item));
      const seen = new Set<string>();
      for (const disposition of input.dispositions) {
        const item = open.find((item) => item.id === disposition.id);
        if (!item || seen.has(item.id)) throw new Refusal(`Unknown or repeated open TODO ${disposition.id}.`);
        seen.add(item.id);
        if (!["resolved", "wontfix", "carried"].includes(disposition.disposition)) throw new Refusal("Unknown round TODO disposition.");
        if (disposition.reference !== undefined) assertBody(disposition.reference);
        item.status = disposition.disposition;
        item.reference =
          disposition.disposition === "resolved"
            ? required(disposition.reference, "TODO resolution reference")
            : (disposition.reference ?? (disposition.disposition === "wontfix" ? "Known limitations" : "Next round"));
        if (disposition.disposition === "wontfix") {
          const limitation = `### ${item.id} — ${item.title}\n\nSource: ${item.source}\n${
            disposition.reference ? `\n${disposition.reference}\n` : ""
          }${item.body ? `\n${item.body}` : ""}`;
          round.known_limitations = [round.known_limitations, limitation].filter(Boolean).join("\n\n");
        }
      }
      if (open.some((item) => !seen.has(item.id))) throw new Refusal("Every open TODO needs a round-close disposition.");
      for (const item of automatic) {
        const destination = findRound(model, findStage(model, item.target).round);
        const next = roundTodo(model, destination);
        const copy: TodoItem = { ...item, status: "open", carried_from: `${item.id} (${round.id})` };
        delete copy.reference;
        next.items.push(copy);
        item.status = "carried";
        item.reference = destination.id;
        mutation.put(next.path, renderTodo(next));
      }
      mutation.put(doc.path, renderTodo(doc));
      round.stages = generatedBlock(
        "stages",
        renderStageTable(
          model.stages.filter((stage) => stage.round === round.id),
          round.format,
        ),
      );
      round.status = "closed";
      round.closed = today();
      const content = renderRound(round);
      round.frozen_sha256 = roundSha256({ ...roundFiles(model, round), "README.md": content });
      mutation.put(round.path, content.replace(/^frozen_sha256:.*$/m, `frozen_sha256: "${round.frozen_sha256}"`));
      return `${upgraded ? "Upgraded the repository to roadmap format 2. " : ""}Closed and froze ${round.id} — ${round.title}${outcome ? ` (goal ${outcome.assessment})` : ""}.${automatic.length ? ` Automatically carried ${automatic.map((item) => item.id).join(", ")} to their planned rounds, keeping IDs.` : ""} ADR management remains available.`;
    },
    options,
  );
}

export async function recordFreeWork(
  repo: Repo,
  actor: Actor,
  input: { stage: string; intent: string },
  options: MutationOptions = {},
): Promise<Receipt> {
  return mutate(
    repo,
    actor,
    async (mutation) => {
      const current = editableStage(mutation.model, input.stage);
      if (current.round !== activeRound(mutation.model).id) throw new Refusal("Free work is recorded only in the active round.");
      if (current.status !== "planned" && current.status !== "active")
        throw new Refusal("Free work can only be recorded on an unclosed stage.");
      const intent = required(input.intent, "free-work intent", true).replace(/\s+/g, " ").trim();
      assertBody(intent, { inlineOnly: true });
      const entry = `- ${new Date().toISOString().slice(0, 10)} · session ${actor.sessionId} · ${JSON.stringify(intent)}`;
      current.free_work_log = [current.free_work_log, entry].filter(Boolean).join("\n");
      mutation.put(current.path, renderStage(current));
      return `Recorded free work for ${current.id}.`;
    },
    options,
  );
}

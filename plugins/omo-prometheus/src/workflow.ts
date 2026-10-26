/**
 * Pure workflow logic for the Prometheus plugin: command parsing, the trusted
 * approval predicate, the execution-phase tool allowlist, and the system-prompt
 * blocks the runtime appends after the host prompt.
 *
 * Nothing here touches the filesystem, the host, or session state, so each
 * decision can be exercised in isolation.
 */

import { prompt } from "@oh-my-pi/pi-utils";

import type { AftBinding, AftCapability, AftProjection, AftProjectionKind, AftTool } from "./aft-contract.ts";

/** Slash command that toggles Prometheus planning, like the host's `/plan`. */
export const PROMETHEUS_COMMANDS: Record<string, true> = { prometheus: true };

/** A `/prometheus` invocation; `prompt` is the optional first planning turn when toggling on. */
export interface PrometheusCommand {
  prompt: string;
}

/** Parse `/prometheus [prompt]`. Matching is case-sensitive, like the host's own builtins. */
export function parsePrometheusCommand(text: string): PrometheusCommand | undefined {
  const match = /^\/([a-z]+)(?:[ \t]+([\s\S]*))?$/.exec(text.trim());
  const name = match?.[1];
  if (!name || PROMETHEUS_COMMANDS[name] !== true) return undefined;
  return { prompt: (match[2] ?? "").trim() };
}

/** Atlas has no implicit selector: a bare inactive command only lists plans. */
export function parseAtlasCommand(text: string): { selector: string } | undefined {
  const match = /^\/atlas(?:[ \t]+([\s\S]*))?$/.exec(text.trim());
  return match ? { selector: (match[1] ?? "").trim() } : undefined;
}

/**
 * `/atlas` argument forms. A leading keyword always wins over a plan name, so a plan literally named
 * `list`, `show`, … stays reachable by id or through `start <name>`; anything else is a plan selector.
 */
export type AtlasSubcommand =
  | { kind: "menu" }
  | { kind: "exit" }
  | { kind: "list" }
  | { kind: "enter"; selector: string }
  | { kind: "show"; selector: string }
  | { kind: "start"; selector: string }
  | { kind: "resume"; selector: string }
  | { kind: "rename"; planId: string; name: string }
  | { kind: "delete"; planId: string; confirmed: boolean }
  | { kind: "usage"; message: string };

export const ATLAS_USAGE =
  "Usage: /atlas [list | show <name-or-id> | start <name-or-id> | resume <name-or-id> | rename <id> <new name> | delete <id> --yes | exit | <name-or-id>]";

export function parseAtlasSubcommand(selector: string): AtlasSubcommand {
  const text = selector.trim();
  if (!text) return { kind: "menu" };
  const [, keyword = "", rest = ""] = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text) ?? [];
  const argument = rest.trim();
  switch (keyword) {
    case "exit":
    case "list":
      return argument ? { kind: "usage", message: `/atlas ${keyword} takes no arguments. ${ATLAS_USAGE}` } : { kind: keyword };
    case "show":
    case "start":
    case "resume":
      return argument
        ? { kind: keyword, selector: argument }
        : { kind: "usage", message: `/atlas ${keyword} needs a plan name or id. ${ATLAS_USAGE}` };
    case "rename": {
      const [, planId = "", name = ""] = /^(\S+)(?:\s+([\s\S]*))?$/.exec(argument) ?? [];
      return planId && name.trim()
        ? { kind: "rename", planId, name: name.trim() }
        : { kind: "usage", message: `/atlas rename needs a plan id and a new name. ${ATLAS_USAGE}` };
    }
    case "delete": {
      const words = argument.split(/\s+/).filter(Boolean);
      const confirmed = words.includes("--yes");
      const ids = words.filter((word) => word !== "--yes");
      return ids.length === 1 && ids[0]
        ? { kind: "delete", planId: ids[0], confirmed }
        : { kind: "usage", message: `/atlas delete needs exactly one plan id. ${ATLAS_USAGE}` };
    }
    default:
      return { kind: "enter", selector: text };
  }
}

export interface AtlasCompletionPlan {
  id: string;
  name: string;
  unfinished: boolean;
}

interface AtlasCompletion {
  value: string;
  label: string;
  description: string;
}

const ATLAS_KEYWORDS: readonly AtlasCompletion[] = [
  { value: "list", label: "list", description: "List this project's Atlas plans" },
  { value: "show ", label: "show <name-or-id>", description: "Show a plan's progress without entering it" },
  { value: "start ", label: "start <name-or-id>", description: "Enter a plan in this session and start executing it" },
  { value: "resume ", label: "resume <name-or-id>", description: "Resume an unfinished plan from its saved progress" },
  { value: "rename ", label: "rename <id> <new name>", description: "Rename a plan by id" },
  { value: "delete ", label: "delete <id> [--yes]", description: "Delete a plan and its evidence by id; --yes skips confirmation" },
  { value: "exit", label: "exit", description: "Leave Atlas execution; shared progress is kept" },
];

/**
 * `/atlas` argument completions: keywords, then plans by name for name-or-id forms or by id for id-only forms.
 * A bare prefix also offers unfinished plans by name, matching either their name or id. A plan whose name the
 * command cannot resolve — shared with another plan, or starting with a keyword in bare position — completes to its
 * id and shows the id in its label, so no two rows look alike and every row runs the plan it shows.
 */
export function atlasArgumentCompletions(prefix: string, plans: readonly AtlasCompletionPlan[]): AtlasCompletion[] | null {
  const keyword = /^(\S+)\s/.exec(prefix)?.[1];
  const needle = prefix.toLowerCase();
  const nameCounts = new Map<string, number>();
  for (const { name } of plans) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  const byName = (head: string, unfinishedOnly: boolean) =>
    plans
      .filter((plan) => !unfinishedOnly || plan.unfinished)
      .map(({ id, name }) => {
        const firstWord = /^\S+/.exec(name)?.[0] ?? "";
        const byId = nameCounts.get(name) !== 1 || (!head && ATLAS_KEYWORDS.some((item) => item.value.trim() === firstWord));
        return byId
          ? { value: `${head}${id}`, label: `${name} (${id})`, description: id }
          : { value: `${head}${name}`, label: name, description: id };
      });
  let options: AtlasCompletion[];
  if (keyword === "show") options = byName("show ", false);
  else if (keyword === "start" || keyword === "resume") options = byName(`${keyword} `, true);
  else if (keyword === "rename" || keyword === "delete") {
    const tail = keyword === "rename" ? " " : "";
    options = plans.map(({ id, name }) => ({ value: `${keyword} ${id}${tail}`, label: id, description: name }));
  } else {
    // Bare plans also match by name or id, which they carry as their description.
    const matches = [
      ...ATLAS_KEYWORDS.filter((item) => item.value.startsWith(needle)),
      ...byName("", true).filter(
        (item) =>
          item.value.toLowerCase().startsWith(needle) || item.label.toLowerCase().startsWith(needle) || item.description.startsWith(needle),
      ),
    ];
    return matches.length ? matches : null;
  }
  // After a keyword, a plan completed to its id is still found by typing its name.
  const typed = needle.slice((keyword?.length ?? 0) + 1).trimStart();
  const matches = options.filter((item) => item.value.toLowerCase().startsWith(needle) || item.label.toLowerCase().startsWith(typed));
  return matches.length ? matches : null;
}

export const PROMETHEUS_OPT_IN_QUESTION_ID = "prometheus-workflow-opt-in";
export const PROMETHEUS_STANDARD_OPTION_INDEX = 0;
export const PROMETHEUS_DEEP_OPTION_INDEX = 1;

/** Narrows an arbitrary tool-call input to a plain JSON object, as every AFT argument payload is. */
export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export type PrometheusPhase = "idle" | "planning" | "executing";

interface ParsedTaskSpawn {
  assignment: string;
  requestedAgent?: string;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

/** Parse the ordinary single and batch task-tool shapes without importing another plugin. */
function parseTaskSpawns(input: unknown): ParsedTaskSpawn[] | undefined {
  const args = record(input);
  if (!args) return undefined;
  if (Object.hasOwn(args, "tasks")) {
    if (!Array.isArray(args.tasks) || args.tasks.length === 0 || Object.hasOwn(args, "task") || !nonEmptyString(args.context)) {
      return undefined;
    }
    const routes: ParsedTaskSpawn[] = [];
    for (const rawItem of args.tasks) {
      const item = record(rawItem);
      const assignment = nonEmptyString(item?.task);
      if (!item || !assignment || (Object.hasOwn(item, "agent") && typeof item.agent !== "string")) return undefined;
      routes.push({ assignment, requestedAgent: nonEmptyString(item.agent) });
    }
    return routes;
  }
  const assignment = nonEmptyString(args.task);
  if (!assignment || (Object.hasOwn(args, "agent") && typeof args.agent !== "string")) return undefined;
  return [{ assignment, requestedAgent: nonEmptyString(args.agent) }];
}

const PLAN_GATED_AGENTS: Record<string, true> = { metis: true, momus: true };
const PLAN_GATED_SPAWN_REASON =
  "`metis` and `momus` are spawnable only during Prometheus planning; during Atlas execution only `momus` with `review_kind: compliance` is allowed for F1. Use `reviewer` outside planning.";

/** Return a block reason for plan-gated reviewer spawns, or undefined for an allowed/ordinary task call. */
export function taskSpawnBlockReason(phase: PrometheusPhase | undefined, input: unknown): string | undefined {
  const routes = parseTaskSpawns(input);
  if (!routes) return undefined;
  const gated = routes.filter((route) => route.requestedAgent && PLAN_GATED_AGENTS[route.requestedAgent] === true);
  if (gated.length === 0 || phase === "planning") return undefined;
  if (
    phase === "executing" &&
    gated.every((route) => route.requestedAgent === "momus" && /\breview_kind\s*:\s*compliance\b/.test(route.assignment))
  ) {
    return undefined;
  }
  return PLAN_GATED_SPAWN_REASON;
}

const PLAN_REVIEW_KIND = /\breview_kind\s*:\s*(?:routine|high_accuracy)\b/;

/**
 * Whether a native task call dispatches a pre-proposal plan review round: any task, or the shared context, carrying a
 * `routine` or `high_accuracy` review binding. Keying on the binding rather than the agent also counts reviewer fallbacks.
 */
export function isPlanReviewDispatch(input: unknown): boolean {
  const routes = parseTaskSpawns(input);
  if (!routes?.length) return false;
  const context = record(input)?.context;
  return (typeof context === "string" && PLAN_REVIEW_KIND.test(context)) || routes.some((route) => PLAN_REVIEW_KIND.test(route.assignment));
}

export const DEFAULT_REVIEW_ROUND_LIMIT = 5;

/** The `reviewRoundLimit` setting: absent means the default, 0 means unlimited. */
export function parseReviewRoundLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_REVIEW_ROUND_LIMIT;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  throw new Error(`invalid reviewRoundLimit ${JSON.stringify(value)}`);
}

/** Whether any task in a native call carries an `atlas_assignment` binding line (in its body or the batch context). */
export function carriesAtlasAssignment(input: unknown): boolean {
  const args = record(input);
  if (!args) return false;
  const texts = [args.context, args.task, ...(Array.isArray(args.tasks) ? args.tasks.map((item) => record(item)?.task) : [])];
  return texts.some((text) => typeof text === "string" && /^\s*atlas_assignment:/m.test(text));
}

/** Row ids named by the parseable `atlas_assignment` bindings of a native task call, verifier bindings included. */
export function assignedRowIds(input: unknown): string[] {
  const args = record(input);
  if (!args) return [];
  const texts = [args.context, args.task, ...(Array.isArray(args.tasks) ? args.tasks.map((item) => record(item)?.task) : [])];
  return texts.flatMap((text) =>
    typeof text !== "string"
      ? []
      : [...text.matchAll(/^\s*atlas_assignment:\s*(\{[^\n]+\})\s*$/gm)].flatMap(([, json]) => {
          try {
            const binding = record(JSON.parse(json ?? ""));
            return Object.keys(record(binding?.verify) ?? record(binding?.rows) ?? {});
          } catch {
            return [];
          }
        }),
  );
}

/**
 * Tools that only read the workspace or the web, plus `yield`, which the host adds to every explicit tool list to
 * return the result. `lsp` is absent: it applies code actions and renames.
 */
const READ_ONLY_TOOLS: Record<string, true> = {
  read: true,
  find: true,
  grep: true,
  glob: true,
  ast_grep: true,
  web_search: true,
  yield: true,
};

/**
 * During execution, a task call without any `atlas_assignment` is read-only research: it needs no ledger row and its
 * output is never row evidence. Every child must use a live-roster agent whose definition restricts it to read-only
 * tools (no `tools` field means every tool), never extra eval-defined tools; metis and momus stay plan-gated.
 */
export function researchSpawnBlockReason(
  input: unknown,
  roster: readonly string[] | undefined,
  definitions: readonly { name: string; tools?: string[] }[],
): string | undefined {
  const args = record(input);
  if (!args) return "Task input must be an object";
  for (const raw of Array.isArray(args.tasks) ? args.tasks : [args]) {
    const item = record(raw);
    const agent = nonEmptyString(item?.agent) ?? "task";
    if (PLAN_GATED_AGENTS[agent] === true) return `${agent} stays plan-gated; it cannot run as an unbound research child`;
    if (item?.tools !== undefined) return "Read-only research children cannot carry extra tools";
    if (roster && !roster.includes(agent)) return `${agent} is not in the live spawnable roster`;
    const tools = definitions.find((definition) => definition.name === agent)?.tools;
    if (!tools || tools.some((tool) => READ_ONLY_TOOLS[tool] !== true)) {
      return `a task call without atlas_assignment is read-only research, and ${agent} can write (${tools ? `its tools include ${tools.filter((tool) => READ_ONLY_TOOLS[tool] !== true).join(", ")}` : "its definition grants every tool"}). Start a ledger row for implementation work, or research with an agent restricted to ${Object.keys(READ_ONLY_TOOLS).join(", ")}`;
    }
  }
  return undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function canonicalPlanPath(path: string): string {
  return path.replace(/^local:\/(?!\/)/, "local://");
}

/** Compare host plan references while tolerating legacy local:/ spelling. */
export function planReferencesMatch(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right && canonicalPlanPath(left) === canonicalPlanPath(right));
}

function prometheusOptInLabels(input: unknown): string[] | undefined {
  const args = record(input);
  const questions = Array.isArray(args?.questions) ? args.questions : [];
  if (questions.length !== 1) return undefined;
  const question = record(questions[0]);
  if (question?.id !== PROMETHEUS_OPT_IN_QUESTION_ID || question.header !== "Prometheus" || question.multi === true) return undefined;
  const rawOptions = Array.isArray(question.options) ? question.options : [];
  if (rawOptions.length !== 2) return undefined;
  const offered = rawOptions.map((option) => record(option)?.label);
  return offered.every((label): label is string => typeof label === "string") && /prometheus/i.test(offered[1] ?? "") ? offered : undefined;
}

export function isPrometheusOptInQuestion(input: unknown): boolean {
  return prometheusOptInLabels(input) !== undefined;
}

/**
 * Validate the completed native ask result. Labels may be localized; consent
 * is the non-timeout selection at the fixed Prometheus option index.
 */
export function isPrometheusOptInConsent(input: unknown, details: unknown, isError: boolean, hasUI: boolean): boolean {
  if (isError || !hasUI) return false;
  const offered = prometheusOptInLabels(input);
  if (!offered) return false;
  const result = record(details);
  if (!result || result.chatRedirect === true || result.timedOut === true) return false;
  const resultOptions = stringArray(result.options);
  const selected = stringArray(result.selectedOptions);
  return (
    resultOptions?.length === offered.length &&
    resultOptions.every((label, index) => label === offered[index]) &&
    selected?.length === 1 &&
    selected[0] === offered[PROMETHEUS_DEEP_OPTION_INDEX] &&
    result.customInput === undefined
  );
}

export function proposedPlanPathFromToolResult(toolName: string, isError: boolean, details: unknown): string | undefined {
  if (toolName !== "write" || isError) return undefined;
  const xdev = record(record(details)?.xdev);
  if (xdev?.tool !== "propose" || xdev.mode !== "execute") return undefined;
  const inner = record(xdev.inner);
  const path = typeof inner?.planFilePath === "string" ? inner.planFilePath.trim() : "";
  if (!path || inner?.planExists !== true) return undefined;
  return canonicalPlanPath(path);
}

/**
 * Trusted detection of the host's post-approval handoff turn. A proposal
 * result, the host-owned reference, and the complete native synthetic envelope
 * must all agree; ordinary user text such as `Plan approved.` is insufficient.
 */
export function isApprovedPlanHandoff(
  prompt: string,
  proposedPlanFilePath: string | undefined,
  planReferencePath: string | undefined,
): boolean {
  if (!proposedPlanFilePath || !planReferencePath) return false;
  const proposed = canonicalPlanPath(proposedPlanFilePath);
  if (!planReferencesMatch(planReferencePath, proposed)) return false;
  const text = prompt.trimStart();
  if (!text.startsWith("Plan approved.\n")) return false;
  if (!text.includes(`<plan path="${proposed}">`) || !text.includes("</plan>")) return false;
  return text.includes(`Full plan inlined below; durable copy at \`${proposed}\``);
}

/** Session-local planning approval-handoff marker. Execution belongs to AtlasStore. */
export function prometheusArtifactUrl(planFilePath: string): string {
  const slug = canonicalPlanPath(planFilePath)
    .replace(/^local:\/\//, "")
    .replace(/-plan\.md$/, "");
  return `local://prometheus/${slug}.proposal.json`;
}

/**
 * Whether the host's approved-plan handoff inlines `content`. The host renders the plan
 * through its prompt formatter, which trims line ends, collapses blank runs, and drops the
 * blank line before `</plan>`, so the exact plan bytes are compared in that rendered form.
 */
export function inlinesApprovedPlan(handoff: string, planFilePath: string, content: string): boolean {
  return handoff.includes(prompt.format(`<plan path="${canonicalPlanPath(planFilePath)}">\n${content}\n</plan>`));
}

/** Plugin-owned tools that are trusted only when registered by this runtime file. */
export const PLUGIN_OWNED_TOOLS: Record<string, true> = { atlas_release: true, atlas_ledger: true, atlas_git: true };

/**
 * Parent-session orchestration and observation surfaces retained by Atlas. The memory, skill, goal,
 * and context tools only touch host-owned state (memory backends, managed skills, the session
 * journal), never the workspace. `new_context` rolls over through ordinary compaction, which Atlas
 * already survives. `checkpoint`/`rewind` stay out: rewind branches the session tree away from the
 * task receipts that prove completed ledger rows. `atlas_git` is the only workspace writer here: it commits named
 * files and refuses while bound children run.
 */
const ALLOWED_TOOLS: Record<string, true> = {
  ask: true,
  ast_grep: true,
  find: true,
  glob: true,
  grep: true,
  atlas_release: true,
  atlas_ledger: true,
  atlas_git: true,
  task: true,
  think: true,
  todo: true,
  wait: true,
  web_search: true,
  context_notes: true,
  new_context: true,
  goal: true,
  recall: true,
  reflect: true,
  retain: true,
  memory_edit: true,
  learn: true,
  manage_skill: true,
};

/**
 * Magic Context's context-housekeeping and memory tools. They are extension-registered, so they
 * cannot pass the builtin provenance check, and they never touch the workspace. Context-mode's
 * `ctx_execute*` tools are deliberately absent: they run code.
 */
const MAGIC_CONTEXT_TOOLS: Record<string, true> = {
  ctx_expand: true,
  ctx_memory: true,
  ctx_note: true,
  ctx_reduce: true,
  ctx_search: true,
};

/**
 * Built-ins whose extension shadows are trusted. Wrappers such as omp-herdr-dag's edge-aware `todo`
 * delegate to the native tool through `ctx.invokeTool`, which never reaches the `tool_call` guard.
 */
const EXTENSION_WRAPPED_TOOLS: Record<string, true> = { todo: true };

const READ_ONLY_LSP_ACTIONS: Record<string, true> = {
  capabilities: true,
  definition: true,
  diagnostics: true,
  hover: true,
  implementation: true,
  references: true,
  status: true,
  symbols: true,
  type_definition: true,
};

/** Mirrors the host's `GITHUB_READONLY_OPS`; `pr_checkout`, `pr_push`, and `pr_create` change repositories. */
const READ_ONLY_GITHUB_OPS: Record<string, true> = {
  file_read: true,
  repo_view: true,
  run_watch: true,
  search_code: true,
  search_commits: true,
  search_issues: true,
  search_prs: true,
  search_repos: true,
};

/** Mirrors the host's `DEBUG_READONLY_ACTIONS`: inspect program state without launching or resuming it. */
const READ_ONLY_DEBUG_ACTIONS: Record<string, true> = {
  disassemble: true,
  loaded_sources: true,
  modules: true,
  output: true,
  read_memory: true,
  scopes: true,
  sessions: true,
  stack_trace: true,
  threads: true,
  variables: true,
};

const SAFE_XDEV_TOOLS: Record<string, true> = {
  ...ALLOWED_TOOLS,
  ...MAGIC_CONTEXT_TOOLS,
  debug: true,
  github: true,
  ida: true,
  lsp: true,
  read: true,
};

/** `proc://<id>/kill` cancels a job or child; stdin and service-mode writes drive a process instead. */
const PROC_CANCEL_PATH = /^proc:\/\/[^/?#]+\/kill\/?$/i;

/**
 * Host tool names AFT may shadow with its own same-name implementation, each admitted under a specific capability.
 * `read`/`grep` also have a legitimate builtin form, so a bound-AFT match here only ever adds permission for the
 * verified extension instance; a non-matching source falls through to the native builtin path below, unaffected.
 * `write` has no per-call-ambiguity-free capability: AFT's own `write` forwards every internal URL (`agent://`,
 * `proc://`, `xd://`, `local://`) to the native tool (`native-url`), so Atlas's existing `writeBlockReason` stays the
 * sole authority over which internal URLs are coordination; a real file mutation must still fail there as before.
 * Trusting the binding's static `native-url` capability for `write` is not enough on its own (a capability is
 * declared once for the whole tool, not per call), so an extension-sourced `write` additionally requires
 * `aftProjectionBlockReason` to confirm, for this exact call, that AFT itself projects `kind: "native"`.
 */
const AFT_FALLTHROUGH_TOOLS: Record<string, AftCapability> = { read: "observation", grep: "observation", write: "native-url" };

/**
 * AFT's own tools that are genuinely non-mutating inspection surfaces with no per-call ambiguity: outline, zoom,
 * search, inspect, callgraph, conflicts, and ast-grep's dry-run search. None of these has a mutating variant, so the
 * binding's static `observation` capability plus exact source is already the authoritative admission.
 */
const AFT_STATIC_OBSERVATION_TOOLS: Record<string, true> = {
  aft_outline: true,
  aft_zoom: true,
  aft_search: true,
  aft_inspect: true,
  aft_callgraph: true,
  aft_conflicts: true,
  ast_grep_search: true,
};

/**
 * AFT tools whose kind genuinely depends on this call's arguments: `aft_safety`'s `op` ranges from `list`/`history`
 * (observation) to `checkpoint`/`restore`/`undo`/`purge` (mutation), and `ast_grep_replace` only previews without
 * `dryRun: true`. Each function is the cheap synchronous prefilter; admission still requires exact source, the
 * binding's static `observation` capability, and (like `write`) a live `aftProjectionBlockReason` confirmation that
 * AFT itself projects `kind: "observation"` for this exact call — the static capability and this prefilter alone
 * never broaden a mutating call.
 */
const AFT_OPERATION_GATED_TOOLS: Record<string, (input: Record<string, unknown>) => string | undefined> = {
  aft_safety: (input) => {
    const op = stringField(input, "op");
    return op === "list" || op === "history"
      ? undefined
      : `\`aft_safety\` op \`${op || "(missing)"}\` can create, restore, undo, or purge a checkpoint`;
  },
  ast_grep_replace: (input) => (input.dryRun === true ? undefined : "`ast_grep_replace` without `dryRun: true` rewrites files"),
};

/** The enumerated AFT tool names requiring only the synchronous capability+exact-source layer (no per-call projection). */
const AFT_OBSERVATION_TOOLS: Record<string, true> = {
  ...AFT_STATIC_OBSERVATION_TOOLS,
  aft_safety: true,
  ast_grep_replace: true,
};

/**
 * `write`'s admitted kind (`native`, an internal-URL delegation) and the op-gated tools' admitted kind (`observation`)
 * once AFT's real wire grammar classifies this exact call; checked only after exact source and static capability
 * already passed. Static capability declarations and the synchronous prefilters above are never sufficient alone.
 */
const AFT_PROJECTED_KIND: Record<string, AftProjectionKind> = {
  write: "native",
  aft_safety: "observation",
  ast_grep_replace: "observation",
};

/** Whether `toolName` is a name AFT may register, so a binding handshake is worth requesting before classifying it. */
export function isAftToolName(toolName: string): boolean {
  return AFT_FALLTHROUGH_TOOLS[toolName] !== undefined || AFT_OBSERVATION_TOOLS[toolName] === true;
}

/** Whether `toolName` additionally needs the async `aftProjectionBlockReason` check after the synchronous guards pass. */
export function needsAftProjection(toolName: string): boolean {
  return AFT_PROJECTED_KIND[toolName] !== undefined;
}

/**
 * The explicit, per-call-safe admission for an AFT observation-family tool call: a static-observation tool passes
 * unconditionally (no mutating variant exists); an operation-gated tool first runs its own cheap prefilter. Neither
 * branch is the final word — the caller still verifies exact source/capability and, for operation-gated tools and
 * `write`, the live projection.
 */
function aftObservationBlockReason(toolName: string, input: Record<string, unknown>): string | undefined {
  const gate = AFT_OPERATION_GATED_TOOLS[toolName];
  if (gate) return gate(input);
  if (AFT_STATIC_OBSERVATION_TOOLS[toolName] === true) return undefined;
  return `\`${toolName}\` is not an enumerated AFT observation tool`;
}

/** The bound AFT tool for `toolName` in this session, if the binding registers it with `capability`. */
function aftBoundTool(trusted: TrustedToolSources, toolName: string, capability: AftCapability): AftTool | undefined {
  const tool = trusted.aft?.tools.get(toolName);
  return tool?.capabilities.has(capability) ? tool : undefined;
}

/** Shared by both guard layers so a missing or wrongly-capable AFT handshake reads the same wherever it is caught. */
function unauthenticatedAftTool(toolName: string): string {
  return `\`${toolName}\` is not authenticated: no AFT binding in this session registers \`${toolName}\` with the required capability (check that AFT is installed, enabled, and registers this tool)`;
}

/**
 * Confirms, for this exact call, that AFT's own live projection agrees with the kind Atlas is about to admit for
 * `toolName`. Called only after `executionToolSourceBlockReason` already verified exact source and static capability;
 * a missing binding, a thrown projector, or a mismatched kind all refuse. Never broadens what the synchronous guards
 * already decided: `write`'s admitted internal-URL subset (`agent://`, `proc://<id>/kill`, guarded `xd://` devices)
 * is still `writeBlockReason` alone, and an operation-gated tool's admitted ops are still its own prefilter alone —
 * this only adds a requirement, never a bypass.
 */
export async function aftProjectionBlockReason(
  trusted: TrustedToolSources,
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): Promise<string | undefined> {
  const expectedKind = AFT_PROJECTED_KIND[toolName];
  if (!expectedKind) return undefined;
  const binding = trusted.aft;
  if (!binding) return unauthenticatedAftTool(toolName);
  let projection: AftProjection;
  try {
    projection = await binding.project(toolName, input, cwd);
  } catch (error) {
    return `\`${toolName}\` could not be classified: the AFT binding's projection threw (${error instanceof Error ? error.message : String(error)})`;
  }
  const value = record(projection);
  if (
    !value ||
    typeof value.kind !== "string" ||
    !Array.isArray(value.paths) ||
    value.paths.some((path) => typeof path !== "string") ||
    typeof value.broad !== "boolean"
  ) {
    return `\`${toolName}\` could not be classified: the AFT binding returned a malformed projection`;
  }
  if (value.kind !== expectedKind) {
    return `\`${toolName}\` is not admitted: AFT projects this call as \`${value.kind}\`, not the required \`${expectedKind}\``;
  }
  return undefined;
}

function stringField(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === "string" ? value.trim() : "";
}

export interface NestedXdevToolCall {
  toolName: string;
  input?: Record<string, unknown>;
  documentation: boolean;
}

export function nestedXdevToolCall(input: unknown): NestedXdevToolCall | undefined {
  const args = record(input);
  const path = stringField(args ?? {}, "path");
  const match = /^xd:\/\/([^/?#]+)\/?$/.exec(path);
  if (!match?.[1]) return undefined;
  let toolName: string;
  try {
    toolName = decodeURIComponent(match[1]);
  } catch {
    toolName = match[1];
  }
  const content = typeof args?.content === "string" ? args.content.trim() : "";
  if (content === "?") return { toolName, documentation: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { toolName, documentation: false };
  }
  return { toolName, input: record(parsed), documentation: false };
}

/**
 * The `local://<slug>-plan.md` a `write xd://propose` names, which the host tries first. The slug arrives as plain
 * text or as `{ "title": … }`; anything that is not a plain slug yields undefined so the host's own resolution applies.
 */
export function proposedPlanUrl(input: unknown): string | undefined {
  if (nestedXdevToolCall(input)?.toolName !== "propose") return undefined;
  const content = stringField(record(input) ?? {}, "content");
  let title = content;
  try {
    const parsed = record(JSON.parse(content));
    title = typeof parsed?.title === "string" ? parsed.title.trim() : "";
  } catch {}
  const slug = title.replace(/-plan$/i, "");
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug) ? `local://${slug}-plan.md` : undefined;
}

function readBlockReason(input: Record<string, unknown>): string | undefined {
  const path = stringField(input, "path").toLowerCase();
  if (path.startsWith("ssh://")) return "`ssh://` resolution starts a remote shell rather than a local read backend";
  // Native SQLite reads run through a query-only connection. `?q=` on images,
  // agent URLs, and web URLs is also an observation surface, not SQL.
  return undefined;
}

function lspBlockReason(input: Record<string, unknown>): string | undefined {
  const action = stringField(input, "action");
  if (!action) return "an `lsp` call without an explicit observation action";
  if (READ_ONLY_LSP_ACTIONS[action] === true) return undefined;
  if (action === "code_actions" && input.apply !== true) return undefined;
  if (action === "request") return "raw `lsp` requests can invoke arbitrary server commands";
  return `\`lsp\` action \`${action}\` can mutate files or server state`;
}

function githubBlockReason(input: Record<string, unknown>): string | undefined {
  const op = stringField(input, "op");
  if (READ_ONLY_GITHUB_OPS[op] === true) return undefined;
  return `\`github\` op \`${op || "(missing)"}\` changes a repository, branch, or worktree`;
}

function debugBlockReason(input: Record<string, unknown>): string | undefined {
  const action = stringField(input, "action").toLowerCase();
  if (READ_ONLY_DEBUG_ACTIONS[action] === true) return undefined;
  return `\`debug\` action \`${action || "(missing)"}\` launches, resumes, or mutates the debuggee`;
}

function idaBlockReason(input: Record<string, unknown>): string | undefined {
  const action = stringField(input, "action");
  if (action === "list") return undefined;
  return `\`ida\` action \`${action || "(missing)"}\` opens, edits, or scripts a database`;
}

function writeBlockReason(input: Record<string, unknown>, trusted: TrustedToolSources): string | undefined {
  const path = stringField(input, "path");
  const lowerPath = path.toLowerCase();
  // Peer messaging; the host rejects JSON-path targets.
  if (lowerPath.startsWith("agent://")) return undefined;
  if (PROC_CANCEL_PATH.test(path)) return undefined;
  if (lowerPath.startsWith("proc://"))
    return "`proc://` stdin and service-mode writes drive a process; only `proc://<id>/kill` is coordination";
  const nested = nestedXdevToolCall(input);
  if (!nested) {
    return lowerPath.startsWith("xd://")
      ? "the `xd://` target or its JSON payload is not a valid guarded device call"
      : "normal file/database/archive writes are direct implementation";
  }
  // The host re-emits `tool_call` for the inner roadmap/ADR/AFT dispatch, where provenance (and, for AFT, projection) is checked again.
  const family = trustedToolFamily(nested.toolName);
  if (family) return trusted[family] ? undefined : unauthenticatedTool(family, nested.toolName);
  if (AFT_OBSERVATION_TOOLS[nested.toolName] === true) {
    if (nested.documentation) return undefined;
    if (!nested.input) return `\`xd://${nested.toolName}\` requires a JSON object before it can be safety-classified`;
    return executionBlockReason(nested.toolName, nested.input, trusted);
  }
  if (SAFE_XDEV_TOOLS[nested.toolName] !== true) {
    return `\`xd://${nested.toolName}\` is not an approved orchestration or observation device`;
  }
  if (nested.documentation) return undefined;
  if (!nested.input) return `\`xd://${nested.toolName}\` requires a JSON object before it can be safety-classified`;
  return executionBlockReason(nested.toolName, nested.input);
}

/**
 * Tool source paths authenticated by the plugin handshakes of this session: `roadmap` for
 * `roadmap_*` tools, `adr` for `adr_*` tools. Each family is admitted only through its own path.
 */
export interface TrustedToolSources {
  roadmap?: string;
  adr?: string;
  /** The confirmed AFT binding for this call, if any AFT-relevant tool name was involved; `undefined` means no answered handshake. */
  aft?: AftBinding;
}

/** The handshake-authenticated plugin family a tool name belongs to, if any. */
export function trustedToolFamily(toolName: string): keyof TrustedToolSources | undefined {
  if (toolName.startsWith("roadmap_")) return "roadmap";
  if (toolName.startsWith("adr_")) return "adr";
  return undefined;
}

/** Shared by every guard layer so a missing handshake reads the same wherever it is caught. */
function unauthenticatedTool(family: keyof TrustedToolSources, toolName: string): string {
  return `\`${toolName}\` is not authenticated: the ${family} plugin did not answer the binding handshake in this session, so no trusted ${family} runtime is known (check that the ${family} plugin is installed and enabled)`;
}

/**
 * Why a tool call must not run in the Atlas parent, or `undefined` when it is
 * orchestration/observation. Nested xdev calls are classified recursively and
 * their real inner dispatch is intercepted again by the host's `tool_call` event.
 */
export function executionBlockReason(toolName: string, input: unknown, trusted: TrustedToolSources = {}): string | undefined {
  const family = trustedToolFamily(toolName);
  if (family) return trusted[family] ? undefined : unauthenticatedTool(family, toolName);
  if (ALLOWED_TOOLS[toolName] === true || MAGIC_CONTEXT_TOOLS[toolName] === true) return undefined;
  const args = record(input) ?? {};
  if (AFT_OBSERVATION_TOOLS[toolName] === true) {
    const opDetail = aftObservationBlockReason(toolName, args);
    if (opDetail) return opDetail;
    return aftBoundTool(trusted, toolName, "observation") ? undefined : unauthenticatedAftTool(toolName);
  }
  switch (toolName) {
    case "read":
      return readBlockReason(args);
    case "lsp":
      return lspBlockReason(args);
    case "github":
      return githubBlockReason(args);
    case "debug":
      return debugBlockReason(args);
    case "ida":
      return idaBlockReason(args);
    case "write":
      return writeBlockReason(args, trusted);
    default:
      return `\`${toolName}\` is neither an orchestration tool nor a read-only inspection surface`;
  }
}

/** Reject extension/MCP shadows of host tools and untrusted plugin-owned tool shadows. */
export function executionToolSourceBlockReason(
  toolName: string,
  source: string | undefined,
  trustedPrometheusTool = false,
  trusted: TrustedToolSources = {},
  toolSourcePath?: string,
): string | undefined {
  const family = trustedToolFamily(toolName);
  if (family) {
    const verified = trusted[family];
    if (!verified) return unauthenticatedTool(family, toolName);
    if (source === "extension" && toolSourcePath === verified) return undefined;
    return `\`${toolName}\` is not from the verified ${family} runtime: it resolves to ${source ? `a ${source} tool` : "an unregistered tool"}${toolSourcePath ? ` at ${toolSourcePath}` : ""}, but the ${family} handshake names ${verified}`;
  }
  const fallthroughCapability = AFT_FALLTHROUGH_TOOLS[toolName];
  if (fallthroughCapability !== undefined || AFT_OBSERVATION_TOOLS[toolName] === true) {
    const capability = fallthroughCapability ?? "observation";
    const tool = aftBoundTool(trusted, toolName, capability);
    if (tool && source === "extension" && toolSourcePath === tool.sourcePath) return undefined;
    // An unmatched extension source is decided here, never falling through to a generic allowance below.
    if (source === "extension") {
      return `\`${toolName}\` is not from the verified AFT runtime: it resolves to an extension tool${toolSourcePath ? ` at ${toolSourcePath}` : ""}, but no AFT binding in this session registers \`${toolName}\` with the \`${capability}\` capability there`;
    }
    // `AFT_OBSERVATION_TOOLS`-only names (no `fallthroughCapability`) have no legitimate builtin/MCP form, so a
    // non-extension source is decided here too; `AFT_FALLTHROUGH_TOOLS` names (`read`, `grep`, `write`) fall through
    // to their native builtin check below, unaffected by AFT.
    if (fallthroughCapability === undefined) {
      return `\`${toolName}\` resolves to ${source ? `a ${source} tool` : "an unregistered tool"}, not a trusted native/plugin tool`;
    }
  }
  if (PLUGIN_OWNED_TOOLS[toolName] === true) {
    return trustedPrometheusTool ? undefined : `\`${toolName}\` is not the plugin-owned ${toolName} tool`;
  }
  if (source === "builtin") return undefined;
  if ((MAGIC_CONTEXT_TOOLS[toolName] === true || EXTENSION_WRAPPED_TOOLS[toolName] === true) && source === "extension") return undefined;
  return `\`${toolName}\` resolves to ${source ? `a ${source} tool` : "an unverified tool"}, not a trusted native/plugin tool`;
}

/** Model-facing explanation returned with a blocked tool call. */
export function blockedToolMessage(toolName: string, detail: string): string {
  return [
    `Atlas execution guard: this main session is Atlas, so \`${toolName}\` is blocked here — ${detail}.`,
    "Delegate implementation, tests, QA, documentation, cleanup, and final verification to child agents with `task`; the parent only orchestrates, tracks `todo`, collects results, and observes.",
    "This overrides implementation preferences such as `task.eager`. A disabled `task` tool or denied spawn is a capability blocker: report it and do not implement in the parent.",
    "This is an extension interception policy, not an operating-system sandbox. The user can exit with `/atlas`.",
  ].join("\n");
}

export const BLOCKED_TOOL_NOTICE =
  "Atlas cannot implement directly. Delegate every plan task to children; if spawning is disabled, report the capability block. Exit with /atlas or a confirmed atlas_release request.";

export const EXECUTION_START_NOTICE =
  "Native plan approval verified — Atlas execution is active. Implementation and verification is delegated; /atlas exits the mode while preserving shared progress.";

export const PLANNING_PREAMBLE = [
  "# Prometheus planning workflow (active)",
  "",
  "The Prometheus workflow owns this native plan-mode session. Follow the complete workflow below until native approval or an explicit user exit.",
  "Do not repeat opt-in, do not mix in the host's generic planning workflow, and do not announce this instruction block. Keep native read-only boundaries and submit the final local://<slug>-plan.md only through write xd://propose.",
  "Before every proposal, including a re-proposal and a draft written before this workflow took over, make the plan follow the plan grammar in this workflow: `## Tasks` with sequential T rows and `## Final gates` with F1–F4. Rewrite a non-conforming draft first; the plugin refuses a proposal whose plan does not parse.",
].join("\n");

export const EXECUTION_PREAMBLE = [
  "# Atlas execution (active)",
  "",
  "A Prometheus plan was approved through the host's native approval flow. This main session is Atlas, the orchestrator of that exact approved plan.",
  "Every plan task — implementation, tests, QA, documentation, cleanup, and final verification — MUST be executed by child agents spawned with `task`. Atlas delegates, tracks `todo`, collects and inspects child evidence, and otherwise uses observation/coordination tools only.",
  "This overrides `task.eager` and every preference that would permit parent implementation. It does not override capability policy: if `task` is disabled or spawning is denied, report the blocker and never downgrade to parent implementation.",
  "Atlas itself writes to the workspace only through provenance-verified plugin tools: `roadmap_*` tools from the runtime authenticated by the roadmap handshake and `adr_*` tools from the runtime authenticated by the ADR handshake, called directly or as `write xd://roadmap_*` / `write xd://adr_*` devices. Use them for the plan's root-session roadmap and ADR steps: starting or joining the stage, amending it, TODO changes, ADR changes (acceptance, rejection and supersession go through `adr_manage`), and `roadmap_stage` action=close with verified evidence and the required TODO dispositions. A stage with proposed ADRs cannot close, so dispose of them with `adr_manage` first. These tools change only roadmap- and ADR-managed documents. Everything else that touches the workspace or a remote — implementation, commits, pushes, pull requests, CI waits, merges — is a child's ledger row; Atlas never runs git or gh. Read-only research children may run without a ledger row, but their output is never row evidence.",
  "The runtime guard is policy interception, not an OS sandbox. It stays active after completion until the user explicitly exits. Once every plan item has child-produced proof, call `atlas_release` exactly once with a concise evidence summary; human confirmation exits the mode. Bare `/atlas` is the user's immediate exit and preserves shared progress. Exit does not cancel native children; their plan ownership remains until final outcomes. `/prometheus` controls planning only.",
].join("\n");

export const OPT_IN_ADDENDUM = [
  "# Native plan-mode depth choice (Prometheus plugin)",
  "",
  "Classify the request before planning. `SIMPLE` means outcome, scope, constraints, and material decisions are already settled and ordinary native planning is sufficient. `COMPLEX` means cross-cutting work, architecture/migration choices, unresolved tradeoffs, or substantial delegated execution.",
  "For `SIMPLE`: continue ordinary native plan mode immediately. Do NOT show an opt-in popup and do NOT call `prometheus_activate`.",
  `For \`COMPLEX\`: call \`ask\` once with exactly one single-select question whose id is \`${PROMETHEUS_OPT_IN_QUESTION_ID}\` and header is exactly \`Prometheus\`. Offer exactly two choices: index ${PROMETHEUS_STANDARD_OPTION_INDEX} is standard native planning and index ${PROMETHEUS_DEEP_OPTION_INDEX} is Prometheus deep planning; the second label must contain \`Prometheus\`. Labels may otherwise be localized; those indices, the id, and header are fixed. Recommend index ${PROMETHEUS_DEEP_OPTION_INDEX}.`,
  `Only a non-timeout user selection of index ${PROMETHEUS_DEEP_OPTION_INDEX} authorizes \`prometheus_activate\`. Call it with \`{ "questionId": "${PROMETHEUS_OPT_IN_QUESTION_ID}", "selectedOptionIndex": ${PROMETHEUS_DEEP_OPTION_INDEX} }\`. Cancellation, empty selection, custom input, timeout, chat redirect, or index ${PROMETHEUS_STANDARD_OPTION_INDEX} means continue native planning and never activate.`,
  "Do not mention this instruction block and do not ask the depth choice again in the same native plan-mode episode.",
].join("\n");
